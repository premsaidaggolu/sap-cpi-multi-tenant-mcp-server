// One-shot integration-flow authoring: takes a structured step-by-step spec (an AI
// client turns the user's free-text request into this spec — there's no NL parser
// inside this server) and does everything the "integration-flow-creation" skill
// used to require doing by hand: generates the confirmed-schema BPMN2/ifl XML,
// splices it into a real tenant-generated shell, pushes it, deploys it, polls the
// build/deploy status, and — on any challenge (build failure, timeout, runtime
// start error) — says so plainly instead of leaving the caller stuck with an
// opaque error. Once content is pushed, the tenant itself is the source of truth
// for it — nothing is written to local disk on that path; download_integration_flow
// fetches it back any time it's needed for inspection. The one exception is
// offline:true, which never touches a tenant at all, so its preview zip is the
// only copy that will ever exist and is saved to generated-iflows/ for that reason.
//
// This is the encoded version of that skill: every XML shape, gotcha, and
// auto-fix (== -> =, quoting comparison RHS, the whitespace-in-participant-name
// rule, cron field layout, ...) lives in ./ , not in a markdown file the caller
// has to have loaded. See src/iflow/xml.js's header for the "confirmed, not
// guessed" ground rule everything here follows.
import { z } from "zod";
import JSZip from "jszip";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cpiGet, cpiRequest, cpiInvoke, odataString, assertWriteAllowed, resolveTenant } from "../cpiClient.js";
import { jsonResult, errorResult, permissionDenied, registerScopedTool } from "./helpers.js";
import { hasScope } from "../requestScope.js";
import { runWithTenant } from "../tenantScope.js";
import { buildFlowGraph, renderFlowGraph, SUPPORTED_KINDS, START_KINDS } from "../iflow/steps.js";
import { sanitizeTechnicalId, findPlaceholders } from "../iflow/xml.js";
import { buildParametersFiles, injectFlowContent, buildOfflineShellIflw, offlineProjectXml, offlineManifest } from "../iflow/packageFiles.js";

const OUTPUT_DIR = fileURLToPath(new URL("../../generated-iflows/", import.meta.url));
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
        }).describe(
          "Plain HTTP receiver. Only authenticationMethod:\"None\" is confirmed working — a live deploy on " +
            "2026-08-14 confirmed this adapter rejects \"OAuth2ClientCredentials\" outright. For an OData service " +
            "needing Basic/OAuth2/ClientCertificate auth, use type:\"odata\" instead."
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
            "real authentication. Adapted from a community reference (github.com/achgithub/mcp-cpi-tools), not yet " +
            "independently confirmed against a live deploy here — verify in the web editor's Problems tab first."
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

// --- small local helpers -------------------------------------------------------

async function saveZip(buf, baseName) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(OUTPUT_DIR, `${baseName}-${stamp}.zip`);
  await writeFile(file, buf);
  return file;
}

async function assembleOfflineZip({ id, name, iflw, prop, propdef, scripts }) {
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
      title: "Build & Deploy Integration Flow From Spec",
      description:
        "Author and deploy a REAL SAP CPI integration flow (not just an empty shell) from a structured step " +
        "spec: creates/reuses the flow, generates confirmed-schema BPMN2/ifl XML for each step, pushes it, and " +
        "triggers a deploy. Supported step kinds ONLY: " +
        `${SUPPORTED_KINDS.join(", ")} — the first step must be one of: ${START_KINDS.join(", ")}; ` +
        "a step type outside this list needs the manual integration-flow-creation skill workflow instead. " +
        "Known auto-fixes applied for you: Camel Simple '==' is rewritten to '=', an unquoted comparison RHS " +
        "gets quoted, participant/element names have whitespace replaced with '_', and every adapter's 'system' " +
        "property is always set to match its own participant name (a mismatch there — confirmed live 2026-08-14 — " +
        "produces an opaque 'Enter adapter details for channel' error with no other symptom, so this isn't caller-" +
        "configurable). requestReply/send adapters: http (auth 'None' only — use 'odata' for real auth), mail, " +
        "odata (OData V2 / HCIOData, supports Basic/OAuth2ClientCredentials/ClientCertificate), sftpWrite (write/" +
        "move a file), jms (confirmed live 2026-08-15 — needs expirationPeriodSec, defaults to 30). pollEnrich " +
        "adapters: sftpPoll (the only way to poll SFTP mid-flow). " +
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
        "IMPORTANT — beyond that validation step, this call returns FAST by default (maxWaitMs:0): it does NOT " +
        "sit and wait for the deploy itself to finish. It pushes content, validates it, kicks off the deploy, and " +
        "hands back deployTaskId immediately — follow up yourself with get_build_and_deploy_status(taskId) / " +
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
        steps: z.array(StepSchema).min(1).describe(`Ordered flow steps; steps[0] must be kind: ${START_KINDS.join(" or ")}.`),
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
        deploy: z.boolean().default(true).describe("Deploy after pushing content. false = push the design-time draft only."),
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
          .describe("Skip the tenant entirely — generate the zip locally from a best-effort built-in template. Lower fidelity; verify in the web editor before trusting it. Useful when ALLOW_WRITE is off or for a quick local preview."),
        confirm: z.boolean().optional().describe("Must be true to proceed (skipped automatically when offline:true, since nothing is written to the tenant)."),
      },
    },
    buildFlowHandler(
      async (args) => {
        const warnings = [];
        const id = sanitizeTechnicalId(args.id);
        if (id !== args.id) warnings.push(`Artifact Id "${args.id}" contained characters CPI rejects — using "${id}" instead. The display Name keeps your original text.`);
        const name = args.name || args.id;

        // Build + render the graph before touching the tenant at all — fail fast and
        // cheaply on an unsupported/inconsistent spec.
        const graph = buildFlowGraph(args);
        const rendered = await renderFlowGraph(graph);
        warnings.push(...rendered.warnings);
        const usedPlaceholders = findPlaceholders(rendered.processInner + rendered.collaborationExtra + Object.values(rendered.scripts).join("\n"));
        const { prop, propdef, warnings: paramWarnings, params } = buildParametersFiles(args.parameters, usedPlaceholders);
        warnings.push(...paramWarnings);

        if (args.offline) {
          const iflw = injectFlowContent(buildOfflineShellIflw("Process_1", name.replace(/\s+/g, "_"), "Collaboration_1"), rendered);
          const zipBuf = await assembleOfflineZip({ id, name, iflw, prop, propdef, scripts: rendered.scripts });
          const zipFilePath = await saveZip(zipBuf, `${id}-offline`);
          return {
            mode: "offline",
            artifactId: id,
            zipFilePath,
            zipSizeBytes: zipBuf.length,
            parameters: params.map((p) => p.name),
            warnings: [...warnings, "Offline mode: nothing was pushed to any tenant. This zip's manifest/collaboration boilerplate is a best-effort template, not a confirmed one — import it into the Integration Suite web editor to verify before relying on it."],
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
          result.note = "Content pushed as the design-time draft only (deploy:false). Call deploy_artifact separately when ready.";
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
