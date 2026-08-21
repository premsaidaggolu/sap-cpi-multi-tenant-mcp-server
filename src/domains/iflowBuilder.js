// One-shot integration-flow authoring: takes a structured step-by-step spec (an AI
// client turns the user's free-text request into this spec — there's no NL parser
// inside this server) and does everything the "integration-flow-creation" skill
// used to require doing by hand: generates the confirmed-schema BPMN2/ifl XML,
// splices it into a real tenant-generated shell, pushes it, deploys it, polls the
// build/deploy status, and — on any challenge (build failure, timeout, runtime
// start error) — says so plainly instead of leaving the caller stuck with an
// opaque error. This tool NEVER writes to this server's local disk, in any mode,
// on either transport (stdio or the Cloud Foundry HTTP deployment): once content
// is pushed, the tenant itself is the source of truth for it —
// download_integration_flow fetches it back any time it's needed for inspection.
// offline:true never touches a tenant at all, so its preview zip is instead
// returned inline as zipBase64 in the tool result — the caller decodes it
// locally (or on their own machine) if they want a file, this server doesn't
// keep one.
//
// This is the encoded version of that skill: every XML shape, gotcha, and
// auto-fix (== -> =, quoting comparison RHS, the whitespace-in-participant-name
// rule, cron field layout, ...) lives in ./ , not in a markdown file the caller
// has to have loaded. See src/iflow/xml.js's header for the "confirmed, not
// guessed" ground rule everything here follows.
import { z } from "zod";
import JSZip from "jszip";
import { cpiGet, cpiRequest, cpiInvoke, odataString, assertWriteAllowed, resolveTenant } from "../cpiClient.js";
import { jsonResult, errorResult, permissionDenied, registerScopedTool } from "./helpers.js";
import { hasScope } from "../requestScope.js";
import { runWithTenant } from "../tenantScope.js";
import { assembleIflow, SUPPORTED_KINDS, START_KINDS } from "../iflow/steps.js";
import { sanitizeTechnicalId, findPlaceholders, validateAssembledIflow } from "../iflow/xml.js";
import { buildParametersFiles, injectFlowContent, buildOfflineShellIflw, offlineProjectXml, offlineManifest } from "../iflow/packageFiles.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- zod step schema ----------------------------------------------------------
// Kept in lockstep with src/iflow/steps.js's SUPPORTED_KINDS / render logic —
// adding a new confirmed step type means updating both places.

const PropertyRow = z.object({
  name: z.string(),
  type: z
    .enum(["constant", "expression", "header", "xpath", "numberRange", "persisted variables", "global persisted variables"])
    .default("constant"),
  value: z.string().default(""),
  datatype: z.string().optional(),
});

const StepSchema = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("timer"),
      name: z.string(),
      cron: z
        .string()
        .optional()
        .describe(
          '7-field CPI cron "second minute hour day_of_month month dayOfWeek year", e.g. "0 0 0/6 ? * * *" ' +
            'for every 6 hours. Defaults to every 6 hours if omitted.'
        ),
      scheduleParam: z.string().optional().describe("Externalize the whole schedule as {{ParamName}} instead of a fixed cron."),
      timezone: z.string().default("Etc/GMT").describe('Only "Etc/GMT"/"UTC" have a confirmed display label; others still work but flag a warning.'),
      throwExceptionOnExpiry: z.boolean().default(true).describe("Whether a missed/expired trigger raises an exception. true is CPI's own confirmed default; set false to have a missed run be silently skipped instead."),
    }),
    z.object({
      kind: z.literal("httpsStart"),
      name: z.string(),
      adapter: z.object({
        urlPath: z.string().describe("Inbound path, e.g. /http/my-endpoint."),
        senderAuthType: z.enum(["RoleBased", "ClientCertificate", "None"]).default("RoleBased"),
        userRole: z.string().default("ESBMessaging.send").describe("Required when senderAuthType is RoleBased."),
      }),
    }).describe("Alternative to 'timer' as the first step — webhook/inbound-HTTPS-triggered flow instead of a schedule."),
    z.object({
      kind: z.literal("sftpStart"),
      name: z.string(),
      adapter: z.object({
        host: z.string().describe("host:port in one field, e.g. sftp.partner.com:22."),
        path: z.string().describe("Directory to poll."),
        fileName: z.string().default("*"),
        authentication: z.enum(["public_key", "user_password"]).default("user_password"),
        credentialName: z.string().optional().describe("Required when authentication is user_password."),
        privateKeyAlias: z.string().optional().describe("Required when authentication is public_key."),
        username: z.string().optional(),
        postProcessing: z.enum(["move", "delete", "test"]).default("move").describe('What happens to a file after pickup: "move" to archivePath, "delete" it, or "test" (leave it untouched).'),
        archivePath: z.string().default(".archive").describe('Used when postProcessing is "move".'),
        doneFileName: z.string().default("${file:name}.done"),
        cron: z
          .string()
          .optional()
          .describe('7-field CPI cron for the poll interval, same format as the timer step\'s "cron". Defaults to every 10 minutes.'),
        timezone: z.string().default("Etc/GMT"),
      }),
    }).describe(
      "Alternative to 'timer'/'httpsStart' as the first step — flow triggered by files landing in an SFTP " +
        "directory (the polling side; CPI still calls it \"Sender\"). Confirmed real property names from " +
        "AI_Agent_Reference_IFlow (2026-08-16) — reuses the timer step's confirmed cron scheduleKey shape for the " +
        "poll interval, which is a reasonable but NOT independently confirmed extrapolation across adapter types " +
        "(the underlying schedule1 cron string is identical either way; only the cosmetic Configure-tab display " +
        "fields might render differently). Verify the Schedule tab looks sensible in the web editor before relying " +
        "on this. To poll SFTP MID-flow instead of triggering the flow, use kind:\"pollEnrich\"/type:\"sftpPoll\"."
    ),
    z.object({
      kind: z.literal("soapStart"),
      name: z.string(),
      adapter: z.object({
        address: z.string().describe("Inbound path, e.g. /EDI/OrderRequest_In."),
        senderAuthType: z.enum(["RoleBased", "ClientCertificate", "None"]).default("RoleBased"),
        userRole: z.string().default("ESBMessaging.send").describe("Required when senderAuthType is RoleBased."),
        wsSecurityType: z.string().default("VerifyMessage"),
        wsSecurity: z.string().default("None"),
        x509TokenAssertion: z.string().default("WssX509V3Token10"),
        algorithmSuiteAssertion: z.string().default("Basic128Rsa15"),
        recipientTokenIncludeStrategy: z.string().default("Never"),
        initiatorTokenIncludeStrategy: z.string().default("AlwaysToRecipient"),
        soapOptions: z.string().default("cxfRobust"),
        maximumBodySizeMb: z.number().int().default(40),
        maximumAttachmentSizeMb: z.number().int().default(100),
      }),
    }).describe(
      "Alternative first step: a WS-Security-secured inbound SOAP endpoint. Property shape transcribed verbatim " +
        "2026-08-17 from a Discover-downloaded reference package (a B2B buyer/supplier purchase-order flow). NOT " +
        "independently confirmed against this tenant's own validator yet — verify in the web editor's Problems " +
        "tab before relying on it."
    ),
    z.object({
      kind: z.literal("contentModifier"),
      name: z.string(),
      properties: z.array(PropertyRow).default([]).describe("Exchange properties to set."),
      headers: z.array(PropertyRow).default([]).describe("Headers to set."),
      bodyExpression: z.string().default("${in.body}").describe("Camel Simple body expression; default is pass-through."),
    }),
    z.object({
      kind: z.literal("router"),
      name: z.string(),
      branches: z
        .array(
          z.object({
            name: z.string(),
            condition: z
              .string()
              .nullable()
              .describe(
                "Camel Simple condition, e.g. \"${property.Alert} = 'true'\". null marks the default/fallback " +
                  "branch (exactly one branch should be null; the last one is used as default if none is)."
              ),
            steps: z.array(StepSchema).min(1),
          })
        )
        .min(2)
        .describe("Branches do NOT reconverge — each must end in its own endEvent. router must be the last step in its list."),
    }),
    z.object({
      kind: z.literal("groovyScript"),
      name: z.string(),
      script: z.string().describe("Full Groovy source implementing `Message processData(Message message)` (package script; import Message)."),
    }),
    z.object({
      kind: z.literal("xsltMapping"),
      name: z.string(),
      xslt: z.string().describe("Full XSLT source. Written into the package as its own file (src/main/resources/mapping/<name>.xsl)."),
    }).describe(
      "XSLT Mapping step. Property shape transcribed verbatim 2026-08-17 from a Discover-downloaded reference " +
        "package (used there for order-item filtering ahead of a downstream Message Mapping step). NOT " +
        "independently confirmed against this tenant's own validator yet."
    ),
    z.object({
      kind: z.literal("messageMapping"),
      name: z.string(),
      mmapContent: z.string().describe(
        "Full, already-authored graphical Message Mapping (.mmap) XML content — this tool does NOT synthesize a " +
          "valid mapping from scratch (SAP's proprietary XI-Trafo brick-tree export format isn't worth hand-" +
          "authoring here). Supply content exported from another package, or hand-built in the web editor's " +
          "Message Mapping tool. Written into the package as its own file (src/main/resources/mapping/<name>.mmap)."
      ),
    }).describe(
      "Message Mapping step — PASS-THROUGH ONLY (see mmapContent). Property shape transcribed verbatim 2026-08-17 " +
        "from THREE independent Discover-downloaded reference packages (the cmdVariantUri version suffix varies " +
        "across them — none/1.1.0/1.2.1 all seen live — this uses the newest observed). NOT independently " +
        "confirmed against this tenant's own validator yet."
    ),
    z.object({
      kind: z.enum(["requestReply", "send"]),
      name: z.string(),
      adapter: z.discriminatedUnion("type", [
        z.object({
          type: z.literal("http"),
          address: z.string().describe("Full URL, e.g. https://api.example.com/v1/thing?x={{Param}} — query string is split out automatically."),
          method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"]).default("GET"),
          authenticationMethod: z.enum(["None", "Basic", "ClientCertificate", "OAuth2ClientCredentials"]).default("None"),
          credentialName: z.string().optional(),
          timeoutMs: z.number().int().default(60000),
          retryOnException: z.boolean().default(true).describe("Retry the call if it throws an exception."),
          retryOnConnectionFailure: z.boolean().default(true).describe("Retry the call on a connection-level failure (distinct from an HTTP error-status response)."),
          retryIteration: z.number().int().default(3).describe("Max number of retry attempts."),
          retryInterval: z.number().int().default(5).describe("Seconds to wait between retry attempts."),
          httpErrorResponseCodes: z.string().default("500,502,501").describe("Comma-separated HTTP status codes that trigger a retry, e.g. \"500,502,501\"."),
          throwExceptionOnFailure: z.boolean().default(true).describe("Raise an exception if the call ultimately fails after retries are exhausted."),
        }).describe(
          "Plain HTTP receiver. authenticationMethod:\"OAuth2ClientCredentials\" is CONFIRMED working as of " +
            "2026-08-17 (previously thought broken from a 2026-08-14 test — that test used the raw, unspaced enum " +
            "value; CPI actually wants the spaced display value \"OAuth2 Client Credentials\", which this builder " +
            "now sends, confirmed against a real hand-built reference channel — " +
            "reference_iflow_for_HTTP_Oauth_and_OData_V4_adapter). Basic/ClientCertificate remain unconfirmed. " +
            "Retry parameters (retryOnException/retryIteration/retryInterval/retryOnConnectionFailure/" +
            "httpErrorResponseCodes/throwExceptionOnFailure) are also confirmed real from the same reference " +
            "channel. For an OData service, use type:\"odata\" (V2) or type:\"odatav4\" instead."
        ),
        z.object({
          type: z.literal("mail"),
          server: z.string().describe("host:port in one field, e.g. smtp.example.com:587."),
          from: z.string(),
          to: z.string(),
          cc: z.string().optional(),
          bcc: z.string().optional(),
          subject: z.string(),
          body: z.string().describe('Camel Simple expression (e.g. "${property.AlertBody}") or a literal string.'),
          credentialName: z.string().optional().describe("Name of a deployed User Credential — the adapter authenticates as this, not a literal username."),
          auth: z.enum(["loginPlain", "none"]).default("loginPlain"),
          ssl: z.string().default("starttls_mandatory"),
          contentType: z.string().default("text/plain"),
        }),
        z.object({
          type: z.literal("odata"),
          address: z.string().describe("Base OData service URL only, e.g. https://erp.example.com/odata/v2 — the entity set goes in resourcePath, not here."),
          operation: z.enum(["Query(GET)", "Read(GET)", "Create(POST)", "Patch(PATCH)"]).default("Query(GET)"),
          resourcePath: z.string().describe("Entity set for Query/Create (e.g. \"SalesOrderCollection\"), or entity set + key for Read/Patch (e.g. \"A_SalesOrder(SalesOrder='${property.id}')\")."),
          queryOptions: z.string().optional().describe("Static $select/$expand/$filter/$top, e.g. \"$select=A,B\"."),
          authenticationMethod: z.enum(["None", "Basic", "ClientCertificate", "OAuth2ClientCredentials"]).default("None"),
          credentialName: z.string().optional().describe("Security Material credential alias — required unless authenticationMethod is None."),
          contentType: z.enum(["application/atom+xml", "application/json"]).default("application/atom+xml"),
          isCSRFEnabled: z.boolean().default(false).describe("Set true for Create/Patch unless a separate token-fetch call precedes this one in the flow."),
          pagination: z.boolean().default(false),
          timeoutSec: z.number().int().default(60),
        }).describe(
          "OData V2 receiver (ComponentType HCIOData) — use this, not type:\"http\", for any OData call needing " +
            "real authentication. Adapted from a community reference (github.com/achgithub/mcp-cpi-tools). " +
            "authenticationMethod:\"OAuth2ClientCredentials\" was previously thought BROKEN (2026-08-16 test): CPI " +
            "rejected the spaced display value \"OAuth2 Client Credentials\" this builder was sending. Root cause " +
            "found 2026-08-17 from a real reference channel (reference_iflow_for_HTTP_Oauth_and_OData_V4_adapter): " +
            "unlike the HTTP adapter, OData wants the RAW unspaced enum value (\"OAuth2ClientCredentials\") — this " +
            "builder now sends that. Directly confirmed for the sibling type:\"odatav4\" adapter against that same " +
            "reference channel; not yet independently re-confirmed against a live V2-specific deploy, so verify in " +
            "the web editor's Problems tab first if it matters for your case."
        ),
        z.object({
          type: z.literal("odatav4"),
          address: z.string().describe("Base OData V4 service URL, e.g. https://api.example.com/v1 — the entity path goes in resourcePath, not here."),
          resourcePath: z.string().describe("Entity path for the OData V4 call, e.g. \"Products\" or \"Products('123')\"."),
          operation: z.string().default("get").describe("Only \"get\" is confirmed working (from a real reference channel) — other values follow the same shape but are unconfirmed guesses."),
          queryOptions: z.string().optional().describe("Static OData V4 query options, e.g. \"$select=A,B\"."),
          pagination: z.boolean().default(false),
          csrfEnabled: z.boolean().default(true).describe("Note the property key is \"csrfEnabled\" here, not \"isCSRFEnabled\" like the V2 odata adapter."),
          connectionReuse: z.boolean().default(true),
          allowChunking: z.boolean().default(false),
          authenticationMethod: z.enum(["None", "Basic", "ClientCertificate", "OAuth2ClientCredentials"]).default("None"),
          credentialName: z.string().optional().describe("Security Material credential alias — required unless authenticationMethod is None. Maps to the channel's \"alias\" property, same as the V2 odata adapter."),
          timeoutSec: z.number().int().default(60),
        }).describe(
          "OData V4 receiver (ComponentType HCIOData, MessageProtocol \"OData V4\") — a distinct adapter from " +
            "type:\"odata\" (V2), with its own property set (e.g. \"csrfEnabled\" not \"isCSRFEnabled\", " +
            "\"connectionReuse\"/\"allowChunking\" instead of batch-processing flags). Confirmed real 2026-08-17 " +
            "from a hand-built reference channel (reference_iflow_for_HTTP_Oauth_and_OData_V4_adapter) using " +
            "operation:\"get\" with authenticationMethod:\"OAuth2ClientCredentials\" — that specific combination is " +
            "directly confirmed; other operations/auth combinations follow the same shape but aren't yet " +
            "individually verified."
        ),
        z.object({
          type: z.literal("sftpWrite"),
          host: z.string().describe("host:port in one field, e.g. sftp.partner.com:22."),
          path: z.string().describe("Target directory on the SFTP server."),
          fileName: z.string().default("${header.CamelFileName}").describe("Camel Simple expression for the written filename."),
          authentication: z.enum(["public_key", "user_password"]).default("public_key"),
          credentialName: z.string().optional().describe("Required when authentication is user_password; leave unset for public_key."),
          privateKeyAlias: z.string().optional().describe("Required when authentication is public_key."),
          username: z.string().optional(),
          fileExist: z.enum(["Override", "Append", "Fail", "Ignore"]).default("Override"),
        }).describe(
          "SFTP receiver (write/move a file) — only usable as kind:\"send\", not \"requestReply\". Adapted from a " +
            "community reference, not yet independently confirmed against a live deploy here. To POLL an SFTP " +
            "server mid-flow, use kind:\"pollEnrich\" / type:\"sftpPoll\" instead — SFTP is not offered as an " +
            "adapter choice on a requestReply step in the web editor at all."
        ),
        z.object({
          type: z.literal("jms"),
          queueName: z.string(),
          expirationPeriodSec: z.number().int().default(30).describe("How long a message may sit on the queue before expiring, in seconds. Required by CPI — confirmed live 2026-08-14 that omitting it fails validation with 'Specify an expiration period'."),
        }).describe("JMS receiver — write to a queue. Confirmed live 2026-08-15 (fixed a missing 'direction' property plus several others this tool omitted)."),
        z.object({
          type: z.literal("soap"),
          address: z.string().describe("SOAP endpoint URL."),
          soapWsdlURL: z.string().optional().describe("Required if soapServiceName/soapWsdlPortName/operationName are set — CPI rejects those without a WSDL URL."),
          soapServiceName: z.string().optional(),
          soapWsdlPortName: z.string().optional(),
          operationName: z.string().optional(),
          credentialName: z.string().optional(),
        }).describe(
          "Plain SOAP 1.x receiver. ONLY valid as kind:\"send\", NOT kind:\"requestReply\" — confirmed live " +
            "2026-08-16 (iterated against a real tenant's validator); this tool now refuses the requestReply " +
            "combination outright. Setting soapServiceName/soapWsdlPortName/operationName without soapWsdlURL is " +
            "also confirmed rejected by CPI (\"Port Name or Service Name cannot be defined without a WSDL\")."
        ),
        z.object({
          type: z.literal("processDirect"),
          address: z.string().describe("Internal path, e.g. /my-sub-flow — calls another iFlow directly without exposing HTTP externally."),
        }).describe(
          "ProcessDirect — internal iFlow-to-iFlow call. Confirmed real (non-placeholder) values from " +
            "AI_Agent_Reference_IFlow (2026-08-16); the simplest adapter to configure of the set. ONLY valid as " +
            "kind:\"requestReply\", NOT kind:\"send\" — confirmed live (2026-08-16): CPI's validator rejects it " +
            "under Send with \"<name> is not supported for the adapter\"; this tool now refuses that combination " +
            "outright before ever pushing to the tenant."
        ),
        z.object({
          type: z.literal("successfactors"),
          address: z.string().describe("SuccessFactors OData V2 host, e.g. https://api12.successfactors.com — resourcePath carries the entity name, not this field."),
          resourcePath: z.string().describe("SuccessFactors OData V2 entity name, e.g. \"User\", \"EmpJob\", \"TemporaryTimeInformation\"."),
          operation: z.enum(["Query(GET)", "Upsert(UPSERT)"]).default("Query(GET)").describe("Only these two values are confirmed present in reference packages; other SuccessFactors-specific operations may exist but aren't verified here."),
          queryOptions: z.string().optional().describe("Static $select/$filter/$expand, e.g. a delta filter like \"$filter=lastModifiedDateTime ge datetimeoffset'${property.QueryDate}'\"."),
          fields: z.string().optional().describe("Comma-separated field list for response pruning (maps to the adapter's 'fields' property)."),
          authenticationMethod: z.enum(["Basic", "OAuth2SAMLBearer", "OAuth2ClientCredentials"]).default("Basic"),
          credentialName: z.string().optional().describe("Security Material credential alias — maps to the channel's 'alias' property."),
          edmxFilePath: z.string().optional().describe("Path to an uploaded OData metadata (.edmx) file inside the package, e.g. \"edmx/api10_successfactors_com_odata_v2.edmx\" — this tool does NOT generate or upload the edmx file itself; it must already exist in the target package for the adapter's metadata browser to work."),
          urlSuffixSfOData: z.string().default("/odata/v2"),
          sfsfODataReceiverDataCenterUrl: z.string().default("Other"),
          contentType: z.enum(["application/atom+xml", "application/json"]).default("application/atom+xml"),
          enableBatchProcessing: z.boolean().default(false),
          timeoutSec: z.number().int().default(60),
        }).describe(
          "Dedicated SuccessFactors adapter (ComponentType SuccessFactors) — distinct from the generic 'odata'/" +
            "'odatav4' types above. Property shape transcribed verbatim 2026-08-17 from THREE independent " +
            "Discover-downloaded reference packages. NOT independently confirmed against this tenant's own " +
            "validator yet."
        ),
        z.object({
          type: z.literal("servicenow"),
          address: z.string().describe("ServiceNow instance host, e.g. https://yourinstance.service-now.com."),
          tableName: z.string().default("sys_user").describe("ServiceNow table name."),
          operation: z.enum(["CREATE", "UPDATE", "QUERY"]).default("QUERY").describe("Maps to the adapter's OperationName property."),
          itemID: z.string().optional().describe("Record sys_id (e.g. \"${property.sys_id}\") — required for UPDATE, unused otherwise."),
          query: z
            .object({
              paramName: z.string().describe("Field to query by, e.g. \"email\"."),
              paramValue: z.string().describe("Value/expression to match, e.g. \"${property.SF_Empl_Email}\"."),
              condition: z.string().default("^OR"),
              operation: z.string().default("="),
            })
            .optional()
            .describe("Builds the confirmed sysparmquery row-XML — only meaningful when operation is QUERY."),
          payloadFormat: z.enum(["xml", "json"]).default("xml"),
          authentication: z.enum(["basic", "oauth2"]).default("basic"),
          credentialName: z.string().optional().describe("Maps to the adapter's 'credentials' property."),
          clientIdAlias: z.string().optional(),
          clientSecretAlias: z.string().optional(),
        }).describe(
          "Dedicated third-party ServiceNow adapter (ComponentType ServiceNow, vendor rojoconsultancy.com). " +
            "Property shape transcribed verbatim 2026-08-17 from a Discover-downloaded reference package. NOT " +
            "independently confirmed against this tenant's own validator yet."
        ),
        z.object({
          type: z.literal("idoc"),
          address: z.string().describe("Target IDoc-over-HTTP endpoint, e.g. http://<host>:<port>/sap/bc/srt/idoc?sap-client=<client>."),
          authentication: z.enum(["Basic", "ClientCertificate"]).default("Basic"),
          credentialName: z.string().optional(),
          proxyType: z.string().default("sapcc").describe("\"sapcc\" = via SAP Cloud Connector, confirmed real from the reference package."),
          locationID: z.string().optional().describe("Cloud Connector virtual-to-internal-host mapping location id, if applicable."),
          allowChunking: z.boolean().default(true),
          cleanupHeaders: z.boolean().default(true),
          compressMessage: z.boolean().default(false),
          requestTimeoutMs: z.number().int().default(60000),
        }).describe(
          "IDoc-over-HTTP receiver (ComponentType IDOC, MessageProtocol \"IDoc SOAP\"). Property shape transcribed " +
            "verbatim 2026-08-17 from a Discover-downloaded reference package. ONLY valid as kind:\"requestReply\", " +
            "NOT kind:\"send\" — confirmed live 2026-08-17 against this tenant's own validator (\"<name> is not " +
            "supported for the adapter\" under Send); this tool refuses that combination outright before ever " +
            "pushing to the tenant."
        ),
      ]),
    }),
    z.object({
      kind: z.literal("pollEnrich"),
      name: z.string(),
      stopOnNoMsgFound: z
        .boolean()
        .default(false)
        .describe("false (recommended) = treat \"nothing to poll\" as normal and continue the flow; true = raise an error instead."),
      adapter: z.discriminatedUnion("type", [
        z.object({
          type: z.literal("sftpPoll"),
          host: z.string().describe("host:port in one field, e.g. sftp.partner.com:22."),
          path: z.string().describe("Directory on the SFTP server to poll."),
          fileName: z.string().default("*"),
          authentication: z.enum(["public_key", "user_password"]).default("public_key"),
          credentialName: z.string().optional().describe("Required when authentication is user_password; leave unset for public_key."),
          privateKeyAlias: z.string().optional().describe("Required when authentication is public_key."),
          username: z.string().describe("Confirmed live (2026-08-14) to be REQUIRED even under public_key authentication — a blank value fails validation."),
        }),
      ]),
    }).describe(
      "Confirmed live (2026-08-14): the ONLY way to poll SFTP mid-flow. The polled file is left untouched " +
        "(noop:\"test\") — follow up with a kind:\"send\"/type:\"sftpWrite\" step if the flow needs to move it."
    ),
    z.object({
      kind: z.literal("filter"),
      name: z.string(),
      xpath: z.string().describe("XPath/expression selecting the nodes to keep, e.g. \"/node/function[field='123']\"."),
      xpathType: z.enum(["Nodelist", "Value"]).default("Nodelist"),
    }).describe("Message Filter. Confirmed real property shape from AI_Agent_Reference_IFlow (2026-08-16)."),
    z.object({
      kind: z.literal("xmlModifier"),
      name: z.string(),
      removeExternalDTDs: z.boolean().default(true),
      removeXmlDeclaration: z.boolean().default(true),
      xmlCharacterHandling: z.string().default("substitute").describe('Only "substitute" is a confirmed real value.'),
    }).describe("XML Modifier. Confirmed real property shape from AI_Agent_Reference_IFlow (2026-08-16)."),
    z.object({
      kind: z.literal("writeVariables"),
      name: z.string(),
      visibility: z.enum(["global", "local"]).default("local"),
      encrypt: z.boolean().default(true),
      expireMinutes: z.number().int().default(90),
      variables: z
        .array(
          z.object({
            name: z.string(),
            type: z.enum(["constant", "expression"]).default("constant"),
            value: z.string().describe('Literal value (type: constant) or Camel Simple expression (type: expression), e.g. "${date:now:yyyy-MM-dd HH:mm:ss}".'),
            scope: z.enum(["global", "local"]).default("local"),
          })
        )
        .min(1),
    }).describe("Write Variables step. Confirmed real row-XML shape from AI_Agent_Reference_IFlow (2026-08-16)."),
    z.object({
      kind: z.literal("splitter"),
      name: z.string(),
      splitExpression: z.string().describe('XPath selecting the elements to split on, e.g. "/root/row". Only XPath-mode General Splitter is confirmed — other split modes (line, fixed-length, ...) are not.'),
      parallelProcessing: z.boolean().default(true),
      threads: z.number().int().default(10),
      stopOnException: z.boolean().default(true),
      streaming: z.boolean().default(true),
      timeoutSec: z.number().int().default(300),
    }).describe("General Splitter (XPath mode). Confirmed real property shape from AI_Agent_Reference_IFlow (2026-08-16). Pair with a downstream 'gather' step to re-aggregate."),
    z.object({
      kind: z.literal("gather"),
      name: z.string(),
      messageType: z.string().default("DiffXMLFormat"),
      aggregationAlgorithm: z.string().default("sap-pi-multi-mapping"),
      targetXPath: z.string().optional(),
      sourceXPath: z.string().optional(),
    }).describe("Aggregator — collects the parallel results of a preceding 'splitter' step back into one message. Confirmed real property shape from AI_Agent_Reference_IFlow (2026-08-16)."),
    z.object({
      kind: z.literal("dataStoreGet"),
      name: z.string(),
      storageName: z.string().describe("Data Store name — create it first via create_data_store or the web UI."),
      visibility: z.enum(["global", "local"]).default("global"),
      deleteAfterRead: z.boolean().default(false),
      stopOnMissingEntry: z.boolean().default(true),
    }).describe("Data Store Get. Confirmed real property shape from AI_Agent_Reference_IFlow (2026-08-16)."),
    z.object({
      kind: z.literal("dataStorePut"),
      name: z.string(),
      storageName: z.string().describe("Data Store name — create it first via create_data_store or the web UI."),
      visibility: z.enum(["global", "local"]).default("global"),
      encrypt: z.boolean().default(true),
      expireDays: z.number().int().default(30),
      overrideExisting: z.boolean().default(true),
      includeMessageHeaders: z.boolean().default(false),
      alertThreshold: z.number().int().default(2),
    }).describe("Data Store Write/Put. Confirmed real property shape from AI_Agent_Reference_IFlow (2026-08-16)."),
    z.object({
      kind: z.literal("dataStoreSelect"),
      name: z.string(),
      storageName: z.string().describe("Data Store name — create it first via create_data_store or the web UI."),
      visibility: z.enum(["global", "local"]).default("global"),
      maxResults: z.number().int().default(9999),
      deleteAfterRead: z.boolean().default(false),
    }).describe("Data Store Select (query multiple entries). Confirmed real property shape from AI_Agent_Reference_IFlow (2026-08-16)."),
    z.object({
      kind: z.literal("dataStoreDelete"),
      name: z.string(),
      storageName: z.string().describe("Data Store name — create it first via create_data_store or the web UI."),
      visibility: z.enum(["global", "local"]).default("global"),
      messageId: z.string().optional().describe("Delete one specific entry by message id; omit to leave deletion to the retention/expiry policy instead."),
    }).describe("Data Store Delete. Confirmed real property shape from AI_Agent_Reference_IFlow (2026-08-16)."),
    z.object({
      kind: z.literal("processCall"),
      name: z.string(),
      processId: z.string().describe('The "id" of a Local Integration Process declared in the top-level "localProcesses" array (NOT the final generated element id — this tool resolves that mapping for you).'),
    }).describe("Synchronously calls a reusable Local Integration Process. Confirmed real property shape from AI_Agent_Reference_IFlow (2026-08-16)."),
    z.object({ kind: z.literal("endEvent"), name: z.string().default("End") }),
  ])
);

const ParameterSchema = z.object({
  name: z.string(),
  type: z.string().default("xsd:string"),
  defaultValue: z.string().default(""),
  required: z.boolean().default(false),
  description: z.string().optional(),
});

// Global error handling — confirmed real structure (StartErrorEvent -> ... ->
// EndErrorEvent/MessageEndEvent) from AI_Agent_Reference_IFlow (2026-08-16). ON BY
// DEFAULT (the default `{}` still generates a minimal pass-through subprocess) since a
// real CPI flow should always have one — pass `false` to omit it entirely.
// ALWAYS defaults to endKind:"message" (Error Start Event -> ... -> Message End
// Event) for BOTH the main flow and every Local Integration Process — a deliberate,
// always-on convention (per user guidance), not conditional on process type.
// endKind:"error" (Error End Event) is still supported and confirmed real too, but
// opt-in only.
function exceptionSubprocessSchema() {
  return z
    .union([
      z.literal(false),
      z.object({
        name: z.string().optional(),
        steps: z
          .array(StepSchema)
          .optional()
          .describe(
            "Error-handling logic (e.g. contentModifier/groovyScript/dataStore*/mail-via-'send' is NOT supported " +
              "here — see the restriction note below). Runs between the Error Start Event and the terminal end " +
              "event; omit for a minimal pass-through subprocess."
          ),
        endKind: z.enum(["message", "error"]).default("message").describe('"message" (default, always-on convention) = normal Message End Event; "error" = dedicated Error End Event, opt-in only.'),
      }),
    ])
    .default({})
    .describe(
      "Exception Subprocess. Step kinds needing their own collaboration participant/adapter — timer, httpsStart, " +
        "sftpStart, requestReply, send, pollEnrich — are refused inside it (diagram-shape handling for a " +
        "subprocess-nested adapter isn't confirmed); use contentModifier/groovyScript/filter/writeVariables/" +
        "dataStore*/processCall/router instead."
    );
}

// --- small local helpers -------------------------------------------------------

async function assembleOfflineZip({ id, name, iflw, prop, propdef, scripts, mappingFiles, xsdFiles }) {
  const zip = new JSZip();
  // Explicit directory entries + a real file directly in src/main/resources — both
  // confirmed necessary when a zip is authored from scratch rather than modifying a
  // real export (see packageFiles.js's header note on offline-mode fidelity).
  for (const d of [
    "META-INF/",
    "src/",
    "src/main/",
    "src/main/resources/",
    "src/main/resources/scenarioflows/",
    "src/main/resources/scenarioflows/integrationflow/",
    "src/main/resources/script/",
    "src/main/resources/mapping/",
    "src/main/resources/xsd/",
  ]) {
    zip.folder(d);
  }
  zip.file(".project", offlineProjectXml(id));
  zip.file("META-INF/MANIFEST.MF", offlineManifest(id));
  zip.file("metainfo.prop", "description=\n");
  zip.file("src/main/resources/parameters.prop", prop);
  zip.file("src/main/resources/parameters.propdef", propdef);
  zip.file(`src/main/resources/scenarioflows/integrationflow/${id}.iflw`, iflw);
  for (const [filename, content] of Object.entries(scripts)) {
    zip.file(`src/main/resources/script/${filename}`, content);
  }
  for (const [filename, content] of Object.entries(mappingFiles || {})) {
    zip.file(`src/main/resources/mapping/${filename}`, content);
  }
  for (const { filename, content } of xsdFiles || []) {
    zip.file(`src/main/resources/xsd/${filename}`, content);
  }
  return zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE" });
}

/**
 * Pull anything that looks like an Error-severity finding out of
 * ValidateIntegrationDesigntimeArtifact's response, whatever shape it turns out to be
 * (its exact schema isn't documented anywhere we've confirmed — see validateFlow
 * below). Deliberately permissive rather than pattern-matched to one exact shape: a
 * missed real error is worse than an occasional false positive the caller can eyeball
 * away via `validation.raw`.
 */
function extractValidationErrors(validationResult) {
  const errors = [];
  const visit = (val) => {
    if (val == null) return;
    if (typeof val === "string") {
      // Confirmed live: ValidateIntegrationDesigntimeArtifact's body often isn't pure
      // JSON — it's a text prefix ("Check execution result: Failed") followed by a
      // real embedded JSON array of {severity, message, ...} findings, which cpiClient
      // can't JSON.parse as a whole (hence it arrives here as a raw string at all).
      // Recover that embedded JSON and recurse into it so the object-based
      // severity/message extraction below fires — without this, only a line that
      // happens to literally contain the word "error" gets picked up (e.g. the
      // `"severity": "Error"` line, NOT the actual `"message"` line beside it, since
      // "not supported in integrationcell profile" doesn't itself contain "error").
      const jsonStart = val.search(/[[{]/);
      if (jsonStart !== -1) {
        try {
          visit(JSON.parse(val.slice(jsonStart)));
          return;
        } catch {
          // Not actually JSON past that point — fall through to the line scan below.
        }
      }
      for (const line of val.split(/\r?\n/)) {
        if (/error/i.test(line) && line.trim()) errors.push(line.trim());
      }
      return;
    }
    if (Array.isArray(val)) {
      for (const item of val) visit(item);
      return;
    }
    if (typeof val === "object") {
      const severity = val.Severity ?? val.severity ?? val.Level ?? val.level;
      if (severity !== undefined) {
        if (/error/i.test(String(severity))) {
          const message = val.Description ?? val.description ?? val.Message ?? val.message ?? val.Text ?? val.text;
          errors.push(message ? String(message) : JSON.stringify(val));
        }
        return; // a severity-tagged node's own fields aren't worth recursing into further
      }
      for (const v of Object.values(val)) visit(v);
    }
  };
  visit(validationResult);
  return [...new Set(errors)];
}

/**
 * Run the tenant's own ValidateIntegrationDesigntimeArtifact check right after pushing
 * content. This is the one reliable way to catch a class of problem that a successful
 * push/save does NOT rule out — confirmed live: content can push fine (200 OK, valid
 * XML) and still be un-openable in the web UI ("Error while loading the details of the
 * integration flow") because a hard-coded component version isn't supported under the
 * shell's runtime profile (e.g. Timer Start 1.4 / Groovy Script 1.1 rejected under
 * 'integrationcell' on some tenants) or an adapter channel is missing a required field.
 * Best-effort: if the validate call itself fails (older tenant, transient error), that
 * failure is reported but does NOT block the caller from proceeding — only a genuine
 * Error-severity finding does.
 */
async function validateFlow(id) {
  try {
    const raw = await cpiInvoke("ValidateIntegrationDesigntimeArtifact", { Id: id, Version: "active" });
    return { checked: true, errors: extractValidationErrors(raw), raw };
  } catch (err) {
    return { checked: false, errors: [], raw: null, checkError: err.message };
  }
}

function classifyBuildStatus(status) {
  if (!status) return "PENDING";
  const s = String(status).toUpperCase();
  if (s.includes("FAIL") || s.includes("ERROR")) return "FAIL";
  if (s.includes("SUCCESS") || s.includes("FINISH") || s.includes("COMPLET")) return "SUCCESS";
  return "PENDING";
}

async function startDeploy(id) {
  const res = await cpiInvoke("DeployIntegrationDesigntimeArtifact", { Id: id, Version: "active" }, "POST", { full: true });
  let taskId = res.data && (res.data.TaskId || (res.data.d && res.data.d.TaskId));
  if (!taskId && res.location) {
    const m = res.location.match(/TaskId=(?:'([^']+)'|([^),]+))/);
    if (m) taskId = m[1] || m[2];
  }
  return taskId || null;
}

/** Poll BuildAndDeployStatus (or, lacking a task id, the runtime artifact directly). */
async function pollBuildAndDeploy(taskId, artifactId, maxWaitMs, pollIntervalMs = 5000) {
  const start = Date.now();
  let lastStatus = null;
  while (Date.now() - start < maxWaitMs) {
    try {
      if (taskId) {
        const status = await cpiGet(`/BuildAndDeployStatus(TaskId=${odataString(taskId)})`);
        lastStatus = status && status.Status;
      } else {
        // No task id extracted — fall back to watching the runtime artifact appear.
        const rt = await cpiGet(`/IntegrationRuntimeArtifacts(${odataString(artifactId)})`);
        lastStatus = rt && rt.Status;
      }
    } catch {
      // Not visible yet (e.g. runtime artifact 404s until the build finishes) — keep polling.
    }
    const cls = classifyBuildStatus(lastStatus);
    if (cls !== "PENDING") return { status: lastStatus, classified: cls, timedOut: false };
    await sleep(pollIntervalMs);
  }
  return { status: lastStatus, classified: classifyBuildStatus(lastStatus), timedOut: true };
}

async function checkRuntimeStatus(artifactId) {
  try {
    const status = await cpiGet(`/IntegrationRuntimeArtifacts(${odataString(artifactId)})`);
    let errorDetails = null;
    if (status && status.Status === "ERROR") {
      try {
        errorDetails = await cpiGet(`/IntegrationRuntimeArtifacts(${odataString(artifactId)})/ErrorInformation/$value`, {}, { raw: true });
      } catch {
        /* no error info available */
      }
    }
    return { status: status && status.Status, errorDetails };
  } catch {
    return { status: "NOT_FOUND", errorDetails: null };
  }
}

/**
 * Like writeHandler (helpers.js), but offline:true skips both the ALLOW_WRITE and
 * confirm=true gates entirely — offline mode never touches the tenant, it only
 * writes a preview zip to local disk, so there is nothing for those gates to guard.
 */
function buildFlowHandler(fn, describe) {
  const requiredScope = "mcp.write";
  const wrapped = async (args) => {
    if (!hasScope(requiredScope)) return permissionDenied(requiredScope);
    try {
      if (args.offline) return jsonResult(await fn(args));
      const tenant = resolveTenant(args && args.tenant);
      return await runWithTenant(tenant, async () => {
        assertWriteAllowed();
        if (args.confirm !== true) {
          return {
            content: [
              {
                type: "text",
                text:
                  `⚠️ Are you sure you want to ${describe(args)}${tenant ? ` on tenant "${tenant.name}"` : ""}?\n` +
                  `This will change your SAP CPI tenant. No changes have been made yet.\n` +
                  `To proceed, run this tool again with confirm=true.`,
              },
            ],
          };
        }
        return jsonResult(await fn(args));
      });
    } catch (err) {
      return errorResult(err);
    }
  };
  wrapped.requiredScope = requiredScope;
  return wrapped;
}

// --- the tool -------------------------------------------------------------------

export function registerIflowBuilderTools(server) {
  registerScopedTool(
    server,
    "build_integration_flow",
    {
      title: "Build & Validate Integration Flow From Spec",
      description:
        "Author a REAL SAP CPI integration flow (not just an empty shell) from a structured step spec: creates/" +
        "reuses the flow, generates confirmed-schema BPMN2/ifl XML for each step, pushes it, and validates it. " +
        "Deploy is OPT-IN (deploy:true) — by default this stops after push+validate; see STANDARD PRACTICE below. " +
        "Supported step kinds ONLY: " +
        `${SUPPORTED_KINDS.join(", ")} — the first step must be one of: ${START_KINDS.join(", ")}; ` +
        "a step type outside this list needs the manual integration-flow-creation skill workflow instead. " +
        "Known auto-fixes applied for you: Camel Simple '==' is rewritten to '=', an unquoted comparison RHS " +
        "gets quoted, participant/element names have whitespace replaced with '_', and every adapter's 'system' " +
        "property is always set to match its own participant name (a mismatch there — confirmed live 2026-08-14 — " +
        "produces an opaque 'Enter adapter details for channel' error with no other symptom, so this isn't caller-" +
        "configurable). requestReply/send adapters: http (auth 'None' and 'OAuth2ClientCredentials' confirmed " +
        "working as of 2026-08-17, plus confirmed retry parameters — see the adapter's own description for " +
        "detail), mail, odata (OData V2 / HCIOData — authenticationMethod:\"OAuth2ClientCredentials\" now sends " +
        "the correct raw-unspaced value, root-caused 2026-08-17; previously thought broken from a wrong-value bug, " +
        "see the adapter's own description), odatav4 (OData V4 / HCIOData, distinct property set from plain " +
        "odata — confirmed real 2026-08-17 with operation:\"get\" + OAuth2ClientCredentials), sftpWrite (write/" +
        "move a file), jms (confirmed live 2026-08-15 — needs expirationPeriodSec, defaults to 30), soap (send " +
        "ONLY, confirmed live 2026-08-16 — needs soapWsdlURL if soapServiceName/soapWsdlPortName/operationName " +
        "are set, also confirmed live), processDirect (internal iFlow-to-iFlow call, requestReply ONLY — confirmed " +
        "live 2026-08-16 that kind:\"send\" is rejected; this tool refuses both wrong-kind combinations before pushing). " +
        "pollEnrich adapters: sftpPoll (the only " +
        "way to poll SFTP mid-flow — to poll SFTP AS the flow's trigger instead, use kind:\"sftpStart\"). " +
        "Additional confirmed step kinds (2026-08-16, from a tenant reference flow): filter, xmlModifier, " +
        "writeVariables, splitter + gather (split/aggregate pair), and the four Data Store operations " +
        "(dataStoreGet/Put/Select/Delete). " +
        "2026-08-17 ADDITIONS (transcribed from Discover-downloaded reference packages, NOT independently " +
        "confirmed against this tenant's own validator — verify in the web editor's Problems tab): soapStart " +
        "(alternative first step — WS-Security-secured inbound SOAP endpoint); xsltMapping (XSLT Mapping step, " +
        "writes the XSLT source into the package as its own file); messageMapping (graphical Message Mapping " +
        "step — PASS-THROUGH ONLY, the caller supplies already-authored .mmap XML content, this tool does not " +
        "synthesize one); and three new requestReply/send adapter types — successfactors (dedicated " +
        "SuccessFactors OData V2 adapter, distinct from generic odata/odatav4; confirmed live 2026-08-17 to need " +
        "NO componentVersion property), servicenow (dedicated third-party ServiceNow REST adapter — also " +
        "confirmed live to need NO componentVersion property; separately, this tenant's design workspace does not " +
        "currently have the ServiceNow adapter available at all, so this type will fail validation here until " +
        "that's provisioned — a tenant-provisioning gap, not a schema bug), and idoc (IDoc-over-HTTP receiver, " +
        "typically via SAP Cloud Connector — requestReply ONLY, confirmed live 2026-08-17 that kind:\"send\" is " +
        "rejected; this tool refuses that combination outright). " +
        "REUSABLE SUB-FLOWS: declare 'localProcesses' (each becomes its own sibling Local Integration Process, " +
        "laid out independently and stacked below the main pool) and call one via a 'processCall' step referencing " +
        "its 'id'. " +
        "EXCEPTION SUBPROCESS — ON BY DEFAULT: both the main flow and every 'localProcesses' entry auto-generate a " +
        "global-error-handling Exception Subprocess (Error Start Event -> ... -> Message End Event, endKind:" +
        "\"message\" always the default for BOTH — a deliberate always-on convention, not conditional on process " +
        "type) unless its 'exceptionSubprocess' field is explicitly set to false. endKind:\"error\" (Error End " +
        "Event) is still supported and confirmed real, but opt-in only. Step kinds needing their own " +
        "adapter (timer/httpsStart/sftpStart/requestReply/send/pollEnrich) are refused inside an Exception " +
        "Subprocess: use contentModifier/groovyScript/filter/writeVariables/dataStore*/processCall/router for " +
        "error-handling logic instead. An Exception Subprocess's own internal steps get the same real ELK layout " +
        "pass and individual diagram shapes as everything else (an earlier version of this tool skipped that as a " +
        "simplification — confirmed live 2026-08-16 that doing so breaks the web editor's own loader entirely, " +
        "\"Error while loading the details of the integration flow\", even when ValidateIntegrationDesigntimeArtifact " +
        "itself passes clean — that OData validation endpoint doesn't check for missing diagram shapes at all). " +
        "RUNTIME PROFILE POLICY — 'iflmap' only, never 'integrationcell': whichever shell ends up holding the " +
        "content (freshly created via reuseExistingShell:false, or an existing one via reuseExistingShell:true), " +
        "this tool downloads it, checks its REAL SAP-RuntimeProfile, and refuses to push content if it isn't " +
        "'iflmap'. Which profile a NEW shell gets is NOT fixed by the API — it follows the tenant's own default " +
        "(Integration Suite → Configure → Runtime Profiles → Runtime Profiles tab → Default: 'Cloud Integration' " +
        "= iflmap, 'Integration Cell' = integrationcell), confirmed to actually change live behavior when " +
        "switched. If a build gets refused here, check that setting before assuming a shell must be created by " +
        "hand in the web UI. " +
        "Immediately after pushing content, this tool ALSO calls ValidateIntegrationDesigntimeArtifact itself and " +
        "puts the result on 'validation' — treat 'validation.errors' as the real signal, NOT just a 200 OK on the " +
        "push. Confirmed live: content can push cleanly (valid XML, 200 OK) and still be un-openable in the web UI " +
        "('Error while loading the details of the integration flow') because a hard-coded component version isn't " +
        "supported under the shell's runtime profile — the design-time save API never catches this, only real " +
        "validation does. If validation finds errors, deploy is skipped entirely (it would just fail the same way) " +
        "and 'challenge' is set. " +
        "STANDARD PRACTICE (as of 2026-08-17) — deploy defaults to false: this call pushes content, runs " +
        "ValidateIntegrationDesigntimeArtifact, and STOPS there by default, whether or not validation found " +
        "errors. It does NOT deploy unless the caller explicitly passes deploy:true. The expected workflow for " +
        "an AI client calling this tool: push (deploy:false, the default), read 'validation' on the result, " +
        "share that analysis with the user in plain language (clean pass, or which errors were found and what " +
        "they likely mean), and ask the user how they want to proceed — fix the spec and rebuild, deploy as-is, " +
        "or stop here — rather than assuming deploy should happen next. Only pass deploy:true once the user has " +
        "explicitly asked for a deploy. " +
        "IMPORTANT — when deploy:true IS requested, this call still returns FAST by default (maxWaitMs:0): it " +
        "does NOT sit and wait for the deploy itself to finish. It kicks off the deploy and hands back " +
        "deployTaskId immediately — follow up yourself with get_build_and_deploy_status(taskId) / " +
        "get_deployed_artifact_status(artifactId) in a few short separate calls a few seconds apart until it " +
        "settles. Do not raise maxWaitMs to 'wait it out' in one call: a long-blocking tool call can exceed the " +
        "calling MCP client's own tool-call timeout, which then looks exactly like a hung/crashed server even " +
        "though the tenant-side build is fine. " +
        "On ANY challenge — a validation error, a FAILed build, or a runtime start error — the content has " +
        "already been pushed to the tenant (or, for a runtime-profile refusal, the pre-existing shell is " +
        "untouched) either way, so nothing is saved to local disk: call download_integration_flow(artifactId) " +
        "any time to fetch the zip for local inspection (for a build-time FAIL specifically, the CPI OData API " +
        "exposes no further detail — the zip, opened in the web editor's Problems tab, is the reliable way to " +
        "see the exact rule violated). Requires ALLOW_WRITE. See also push_integration_flow_content for pushing " +
        "an already-known-good zip (e.g. hand-patched locally) without regenerating it from a spec.",
      inputSchema: {
        packageId: z.string().describe("Target integration package Id."),
        createPackage: z
          .object({ name: z.string(), shortText: z.string().optional() })
          .optional()
          .describe("If packageId doesn't exist yet, create it with this display Name (technical Id stays packageId, sanitized)."),
        id: z.string().describe("Technical artifact Id — non-alphanumeric characters are stripped automatically (CPI rejects them)."),
        name: z.string().describe("Display name."),
        description: z.string().optional(),
        parameters: z.array(ParameterSchema).default([]).describe("Externalized parameters. Any {{Name}} used in steps but not listed here is auto-added."),
        xsdFiles: z
          .array(z.object({ filename: z.string().describe('e.g. "SourceDemo.xsd".'), content: z.string().describe("Full XSD source.") }))
          .default([])
          .describe(
            "Raw XSD schema files to bundle into the package at src/main/resources/xsd/<filename> — needed to give " +
              "a 'messageMapping' step real, resolvable source/target elements (its lnks can reference " +
              "'src/main/resources/xsd' by filename + root element name). Without this, a messageMapping step's " +
              "root Dst/Src bricks have no backing schema and CPI's validator flags \"Source/Target element is not " +
              "assigned\" — expected for a placeholder mapping, avoidable by supplying real XSDs here."
          ),
        steps: z.array(StepSchema).min(1).describe(`Ordered flow steps; steps[0] must be kind: ${START_KINDS.join(" or ")}.`),
        exceptionSubprocess: exceptionSubprocessSchema(),
        localProcesses: z
          .array(
            z.object({
              id: z.string().describe("Technical key referenced by 'processCall' steps' processId — anywhere in this build, including from another localProcesses entry — NOT the final generated element id."),
              name: z.string(),
              steps: z
                .array(StepSchema)
                .min(1)
                .describe("Ordinary steps — no start-kind step (timer/httpsStart/sftpStart): a Local Integration Process is entered via a 'processCall' step, not an external trigger."),
              exceptionSubprocess: exceptionSubprocessSchema(),
            })
          )
          .default([])
          .describe(
            "Reusable sub-flows (Local Integration Process), each invoked via a 'processCall' step referencing " +
              "its 'id'. Confirmed real structure from AI_Agent_Reference_IFlow (2026-08-16) — each becomes its " +
              "own sibling <bpmn2:process>, laid out (via the same real ELK engine) stacked below the main pool. " +
              "Each gets its own default-ON Exception Subprocess, same as the main flow."
          ),
        reuseExistingShell: z
          .boolean()
          .default(false)
          .describe(
            "false (default) = create a brand new artifact at packageId/id via the API. true = push content into " +
              "an already-existing artifact instead (e.g. one created by hand in the web UI, or from a prior run). " +
              "Either way, whichever shell results gets downloaded and its real SAP-RuntimeProfile checked before " +
              "any content is pushed — this call is refused if that profile isn't 'iflmap', regardless of which " +
              "path created the shell. Which profile a freshly-created shell gets depends on the tenant's default " +
              "Runtime Profile setting (Integration Suite → Configure → Runtime Profiles), not on this flag. " +
              "Irrelevant when offline:true, which never touches the tenant."
          ),
        deploy: z
          .boolean()
          .default(false)
          .describe(
            "Deploy after pushing content. DEFAULT FALSE as of 2026-08-17 (standard practice): push the " +
              "design-time draft, validate it, and STOP there — do not deploy unless the caller explicitly passes " +
              "deploy:true. Read 'validation' on the result, share the analysis (errors found, or a clean pass) " +
              "with the user, and let THEM decide whether to fix something first or proceed to deploy, rather " +
              "than assuming deploy should happen. Set true only once the user has explicitly asked to deploy."
          ),
        maxWaitMs: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe(
            "Optional IN-CALL wait for build+deploy to finish before returning — no upper limit, set it as high " +
              "as you like (the tenant-side build/deploy itself is never time-boxed by this tool either way; every " +
              "individual HTTP call to CPI still has its own short network-stall timeout under the hood, so this " +
              "just keeps re-checking until Status settles, however long that takes). Default 0 = don't wait in " +
              "this call at all: push + trigger deploy, return deployTaskId immediately, then poll it yourself with " +
              "get_build_and_deploy_status(taskId) / get_deployed_artifact_status(artifactId) across as many " +
              "follow-up calls as it takes. That default exists only because a single very-long-blocking tool call " +
              "can hit the calling MCP client's OWN tool-call timeout (outside this server's control) and then look " +
              "like a hung server — polling externally sidesteps that entirely. Set maxWaitMs > 0 if you'd rather " +
              "this call just sit and wait itself."
          ),
        offline: z
          .boolean()
          .default(false)
          .describe(
            "Skip the tenant entirely — generate the zip from a best-effort built-in template and return it " +
              "inline as zipBase64 (this server never writes it to disk). Lower fidelity; verify in the web " +
              "editor before trusting it. Useful when ALLOW_WRITE is off or for a quick preview."
          ),
        confirm: z.boolean().optional().describe("Must be true to proceed (skipped automatically when offline:true, since nothing is written to the tenant)."),
      },
    },
    buildFlowHandler(
      async (args) => {
        const warnings = [];
        const id = sanitizeTechnicalId(args.id);
        if (id !== args.id) warnings.push(`Artifact Id "${args.id}" contained characters CPI rejects — using "${id}" instead. The display Name keeps your original text.`);
        const name = args.name || args.id;

        // Build + render everything (main flow, its Exception Subprocess, and every
        // Local Integration Process + its own Exception Subprocess) before touching
        // the tenant at all — fail fast and cheaply on an unsupported/inconsistent spec.
        const rendered = await assembleIflow(args);
        warnings.push(...rendered.warnings);

        // Local, dependency-free well-formedness + duplicate-id check — added
        // 2026-08-16 after hitting both failure classes live: a base64-relay
        // transcription bug that merged two properties into one malformed tag, and a
        // Local Integration Process silently colliding id-wise with the main process
        // (surfaced by CPI as the opaque "Parent process cannot be assigned to the
        // Process Call"). Runs before ANY push (online or offline) — no network call,
        // no tenant round-trip needed to catch a bug this cheap to catch locally.
        const localValidation = validateAssembledIflow(rendered);
        if (!localValidation.valid) {
          throw new Error(
            `Generated XML failed local well-formedness/duplicate-id validation before any push was attempted — ` +
              `this is a bug in the generator itself, not your spec:\n${localValidation.errors.join("\n")}`
          );
        }

        const usedPlaceholders = findPlaceholders(
          rendered.processInner + rendered.collaborationExtra + rendered.extraProcessesXml.join("") + Object.values(rendered.scripts).join("\n")
        );
        const { prop, propdef, warnings: paramWarnings, params } = buildParametersFiles(args.parameters, usedPlaceholders);
        warnings.push(...paramWarnings);

        if (args.offline) {
          const iflw = injectFlowContent(buildOfflineShellIflw("Process_1", name.replace(/\s+/g, "_"), "Collaboration_1"), rendered);
          const zipBuf = await assembleOfflineZip({ id, name, iflw, prop, propdef, scripts: rendered.scripts, mappingFiles: rendered.mappingFiles, xsdFiles: args.xsdFiles });
          return {
            mode: "offline",
            artifactId: id,
            encoding: "base64",
            zipBase64: zipBuf.toString("base64"),
            zipSizeBytes: zipBuf.length,
            parameters: params.map((p) => p.name),
            warnings: [
              ...warnings,
              "Offline mode: nothing was pushed to any tenant, and nothing was written to this server's local " +
                "disk — zipBase64 is the only copy, returned inline. This zip's manifest/collaboration " +
                "boilerplate is a best-effort template, not a confirmed one — import it into the Integration " +
                "Suite web editor to verify before relying on it. Decode zipBase64 to a file yourself if you " +
                "want to inspect or push it (e.g. via push_integration_flow_content's zipBase64 argument).",
            ],
          };
        }

        // --- Online path: real tenant, real shell -----------------------------
        // Policy: this tool never PUSHES CONTENT into a shell whose actual
        // SAP-RuntimeProfile isn't 'iflmap' — but which profile a *newly created*
        // shell gets is NOT hardcoded by the API. It's governed by the tenant's own
        // configured default (Integration Suite → Configure → Runtime Profiles →
        // Runtime Profiles tab → "Default" radio button: "Cloud Integration" =
        // iflmap, "Integration Cell" = integrationcell) — confirmed live: a tenant
        // with "Integration Cell" set as default produced 'integrationcell' shells
        // from the plain create API every time, and switching that tenant's default
        // to "Cloud Integration" made the very next API-created shell come back
        // 'iflmap', no code change on either side. So: always create/reuse, always
        // download and check the REAL resulting profile, and only refuse based on
        // that — never assume the outcome ahead of time.
        if (args.createPackage) {
          try {
            await cpiGet(`/IntegrationPackages(${odataString(args.packageId)})`);
          } catch {
            await cpiRequest("POST", "/IntegrationPackages", {
              body: { Id: args.packageId, Name: args.createPackage.name, ShortText: args.createPackage.shortText || args.createPackage.name },
            });
            warnings.push(`Package "${args.packageId}" didn't exist — created it.`);
          }
        }

        if (!args.reuseExistingShell) {
          await cpiRequest("POST", "/IntegrationDesigntimeArtifacts", {
            body: { Name: name, Id: id, PackageId: args.packageId, Description: args.description || "" },
          });
        }

        const shellBuf = await cpiGet(
          `/IntegrationDesigntimeArtifacts(Id=${odataString(id)},Version=${odataString("active")})/$value`,
          {},
          { binary: true }
        );
        const zip = await JSZip.loadAsync(shellBuf);

        const manifestEntry = zip.file("META-INF/MANIFEST.MF");
        const manifestText = manifestEntry ? await manifestEntry.async("string") : "";
        const profileMatch = manifestText.match(/SAP-RuntimeProfile:\s*(\S+)/);
        const runtimeProfile = profileMatch ? profileMatch[1] : "unknown";

        if (runtimeProfile !== "iflmap") {
          return {
            artifactId: id,
            packageId: args.packageId,
            runtimeProfile,
            challenge:
              `Refused: this shell's SAP-RuntimeProfile is "${runtimeProfile}", not "iflmap" — this tool never ` +
              "pushes content into an 'integrationcell' shell. This tenant's default Runtime Profile is currently " +
              "set to produce that — check Integration Suite → Configure → Runtime Profiles → Runtime Profiles " +
              "tab and confirm 'Cloud Integration' (not 'Integration Cell') is marked Default, then either delete " +
              `and recreate '${id}', or reuse a different shell whose profile is already 'iflmap'. No content was ` +
              `pushed — the shell is unchanged, so download_integration_flow(artifactId: "${id}") reflects ` +
              "exactly what's already on the tenant if you want to inspect it.",
            warnings,
          };
        }

        const iflwPath = Object.keys(zip.files).find((p) => !zip.files[p].dir && /scenarioflows\/integrationflow\/.*\.iflw$/.test(p));
        if (!iflwPath) throw new Error("Downloaded shell zip has no .iflw entry under scenarioflows/integrationflow/ — unexpected shell shape.");
        const shellIflw = await zip.file(iflwPath).async("string");
        const newIflw = injectFlowContent(shellIflw, rendered);

        zip.file(iflwPath, newIflw);
        zip.file("src/main/resources/parameters.prop", prop);
        zip.file("src/main/resources/parameters.propdef", propdef);
        for (const [filename, content] of Object.entries(rendered.scripts)) {
          zip.file(`src/main/resources/script/${filename}`, content);
        }
        for (const [filename, content] of Object.entries(rendered.mappingFiles || {})) {
          zip.file(`src/main/resources/mapping/${filename}`, content);
        }
        for (const { filename, content } of args.xsdFiles || []) {
          zip.file(`src/main/resources/xsd/${filename}`, content);
        }

        const zipBuf = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE" });

        await cpiRequest("PUT", `/IntegrationDesigntimeArtifacts(Id=${odataString(id)},Version=${odataString("active")})`, {
          body: { Name: name, ArtifactContent: zipBuf.toString("base64") },
        });

        // Run the tenant's own validation NOW, before deploy is even attempted. A
        // successful push only proves the content is well-formed XML — it does NOT
        // prove the flow will open or deploy (confirmed live: a build can push clean
        // and still be un-openable in the web UI over a component-version/profile
        // mismatch that neither the save nor a build-status poll ever surfaces).
        const validation = await validateFlow(id);

        const result = {
          artifactId: id,
          packageId: args.packageId,
          version: "active",
          runtimeProfile,
          zipSizeBytes: zipBuf.length,
          parameters: params.map((p) => p.name),
          deployed: false,
          validation,
          warnings,
        };

        if (validation.checked && validation.errors.length) {
          result.challenge =
            `ValidateIntegrationDesigntimeArtifact found ${validation.errors.length} error(s) in the pushed content ` +
            "(see validation.errors) — this flow will very likely fail to open or deploy even though the content " +
            "push itself succeeded. A common cause on this tenant: a hard-coded component version (Timer/Groovy/an " +
            "adapter) isn't supported under this shell's runtimeProfile. Deploy was NOT attempted since it would " +
            `almost certainly just fail the same way. The content is already pushed — call ` +
            `download_integration_flow(artifactId: "${id}") any time to fetch the zip for manual inspection/fixing, ` +
            "or fix the spec and call build_integration_flow again.";
          return result;
        }
        if (!validation.checked) {
          warnings.push(`Could not run ValidateIntegrationDesigntimeArtifact (${validation.checkError}) — proceeding without this extra safety check.`);
        }

        if (!args.deploy) {
          result.note =
            (validation.checked
              ? "Content pushed and validated cleanly (validation.errors is empty)."
              : "Content pushed (validation could not be run — see warnings).") +
            " Deploy was NOT attempted — deploy defaults to false as of 2026-08-17 (standard practice): this " +
            "tool pushes + validates and stops there unless the caller explicitly asks for deploy:true. Share " +
            "this result (especially 'validation') with the user and ask how they'd like to proceed — deploy now " +
            "(call this tool again with deploy:true, or use deploy_artifact directly on this artifactId), or " +
            "review/fix something first — rather than assuming deploy should happen.";
          return result;
        }

        const deployStart = Date.now();
        const taskId = await startDeploy(id);
        result.deployTaskId = taskId;
        if (!taskId) warnings.push("Could not extract a deploy task id from the response — poll get_deployed_artifact_status directly instead of get_build_and_deploy_status.");

        // Default (maxWaitMs:0): return right away. Blocking this call for minutes risks
        // exceeding the MCP client's OWN tool-call timeout — which then looks exactly
        // like a hung/crashed server even though the tenant-side build is fine — so the
        // safe default is to hand back the task id and let the caller poll in short,
        // separate calls using the existing status tools.
        if (!args.maxWaitMs) {
          result.buildStatus = "PENDING";
          result.note =
            `Deploy triggered (taskId: ${taskId || "unknown"}). Content is already pushed to the tenant regardless ` +
            `of how the deploy turns out — download_integration_flow(artifactId: "${id}") fetches it any time. Poll ` +
            `${taskId ? `get_build_and_deploy_status(taskId: "${taskId}")` : `get_deployed_artifact_status(artifactId: "${id}")`} ` +
            "every ~10-15s yourself until it settles, rather than calling this tool again.";
          return result;
        }

        const poll = await pollBuildAndDeploy(taskId, id, args.maxWaitMs);
        result.buildStatus = poll.status || "UNKNOWN";
        result.elapsedMs = Date.now() - deployStart;

        if (poll.timedOut || poll.classified === "FAIL") {
          result.challenge = poll.timedOut
            ? `Build/deploy hadn't finished after ${Math.round(args.maxWaitMs / 1000)}s. It's very likely still running — ` +
              `this was only a bounded in-call wait, not a real timeout. Poll ${taskId ? `get_build_and_deploy_status(taskId: "${taskId}")` : `get_deployed_artifact_status(artifactId: "${id}")`} ` +
              "yourself to see it through; the content is already pushed either way."
            : `Build FAILED. The CPI OData API exposes no error detail for a build failure — this is a confirmed ` +
              "platform limitation, not something more polling reveals. Fetch the pushed content with " +
              `download_integration_flow(artifactId: "${id}") and import it into the Integration Suite web editor ` +
              "to read its Problems tab for the exact rule that was violated.";
          return result;
        }

        const runtime = await checkRuntimeStatus(id);
        result.runtimeStatus = runtime.status;
        result.deployed = runtime.status === "STARTED";
        if (runtime.status === "ERROR") {
          result.errorDetails = runtime.errorDetails;
          result.challenge = "Build succeeded but the runtime failed to start — usually a missing credential or unreachable endpoint (a runtime problem, not a content bug). See errorDetails.";
        }
        return result;
      },
      (args) =>
        `build integration flow '${args.id}' in package '${args.packageId}'` + (args.deploy !== false ? " and deploy it" : "")
    )
  );
}
