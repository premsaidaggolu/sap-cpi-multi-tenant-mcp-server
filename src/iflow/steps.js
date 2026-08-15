// Per-step-kind BPMN2/ifl: XML generators, and the graph walker that turns a
// `steps` spec (see domains/iflowBuilder.js's zod schema) into everything needed
// for a real .iflw: process elements, sequence flows, collaboration participants +
// messageFlows (adapter config), diagram shapes/edges, and Groovy script files.
//
// Confirmed live against a real tenant: timer, httpsStart, contentModifier, router,
// groovyScript, endEvent, http(None), mail, pollEnrich/sftpPoll, and the rule that an
// adapter's `system` property must equal its participant's `name` exactly (mkParticipant
// enforces this — never make it caller-suppliable again).
// Adapted from a community reference (github.com/achgithub/mcp-cpi-tools), not yet
// independently confirmed here: odata, sftpWrite, jms.
//
// Diagram layout (2026-08-15): positions/routing are computed by the real ELK layout
// engine (see ./layout.js) — the same one SAP's own web editor uses for its "Align"
// button — not a hand-rolled heuristic. Graph construction below only builds
// STRUCTURE (which nodes exist, how they connect); no x/y is assigned until
// renderFlowGraph runs the layout pass at the end.

import { xmlEscape, attrEscape, rowKeyed, ifl, IdGen, sanitizeElementName, normalizeCondition, buildTimerScheduleKey } from "./xml.js";
import { layoutWithElk } from "./layout.js";

export const SUPPORTED_KINDS = ["timer", "httpsStart", "contentModifier", "router", "groovyScript", "requestReply", "send", "pollEnrich", "endEvent"];
export const START_KINDS = ["timer", "httpsStart"];

// Confirmed live (2026-08-15) against a pristine untouched default shell AND a real
// UI-built flow: the "Integration Process" pool always starts at x=250,y=60. The
// pool's own size is now computed by ELK (see renderFlowGraph) to fit whatever's
// actually inside it, rather than a hand-picked default.
const POOL_X = 250;
const POOL_Y = 60;
const PARTICIPANT_WIDTH = 100;
const PARTICIPANT_HEIGHT = 140; // confirmed SAP default (see mkParticipant)
const PARTICIPANT_MARGIN = 40; // gap between the pool's edge and a Sender/Receiver box

class FlowGraph {
  constructor() {
    this.ids = new IdGen();
    this.nodes = new Map(); // id -> { x, y, w, h, render(incoming, outgoing, gatewayDefault) }
    this.flows = []; // { id, sourceRef, targetRef, condition, name, gatewayRoute }
    this.gatewayDefault = new Map(); // gatewayId -> flowId
    this.participants = new Map(); // id -> { name, style: "sender"|"receiver", x, y, w, h, anchorNodeId, side: "left"|"below"|"above" }
    this.messageFlows = []; // { id, sourceRef, targetRef, xml }
    this.scripts = {}; // filename -> groovy source
    this.warnings = [];
  }
}

function shape(id, x, y, w, h) {
  return `<bpmndi:BPMNShape bpmnElement="${id}" id="${id}_di"><dc:Bounds height="${h}" width="${w}" x="${x}" y="${y}"/></bpmndi:BPMNShape>`;
}

/** Straight two-point edge — used for messageFlows (participants aren't part of the ELK graph). */
function edgeBetween(flowId, a, b) {
  const ax = a.x + a.w, ay = a.y + a.h / 2;
  const bx = b.x, by = b.y + b.h / 2;
  return (
    `<bpmndi:BPMNEdge bpmnElement="${flowId}" id="${flowId}_di">` +
    `<di:waypoint x="${ax}" y="${ay}"/><di:waypoint x="${bx}" y="${by}"/>` +
    `</bpmndi:BPMNEdge>`
  );
}

/** Edge routed through ELK's own computed waypoints (start/bend/end points), offset onto the canvas. */
function edgeFromElk(flowId, elkEdge, offsetX, offsetY) {
  const section = elkEdge && elkEdge.sections && elkEdge.sections[0];
  if (!section) return "";
  const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
  const waypoints = points.map((p) => `<di:waypoint x="${offsetX + p.x}" y="${offsetY + p.y}"/>`).join("");
  return `<bpmndi:BPMNEdge bpmnElement="${flowId}" id="${flowId}_di">${waypoints}</bpmndi:BPMNEdge>`;
}

function connect(g, sourceRef, targetRef, opts = {}) {
  const id = opts.presetId || g.ids.next("SequenceFlow");
  g.flows.push({ id, sourceRef, targetRef, condition: opts.condition || null, name: opts.name || null, gatewayRoute: !!opts.gatewayRoute });
  return id;
}

// `system` always equals the participant's own name — a mismatch produces an opaque
// "Enter adapter details for channel" error with no other symptom (confirmed live).
// Position is resolved later (see renderFlowGraph) once the anchor node's real,
// ELK-computed x/y is known — anchorNodeId/side describe WHERE relative to that
// node, not an absolute coordinate.
function mkParticipant(g, baseName, style, anchorNodeId, side) {
  const participantId = g.ids.next("Participant");
  const name = sanitizeElementName(baseName, style === "receiver" ? "Receiver" : "Sender");
  // 100x140 — SAP's own confirmed default Sender/Receiver pool size (from a pristine,
  // untouched shell's own default participants), not a guess.
  g.participants.set(participantId, { name, style, x: 0, y: 0, w: PARTICIPANT_WIDTH, h: PARTICIPANT_HEIGHT, anchorNodeId, side });
  return { participantId, system: name };
}

function createTimerNode(step, g) {
  const id = g.ids.next("StartEvent");
  const name = sanitizeElementName(step.name, "Timer_Start");
  g.nodes.set(id, {
    x: 0, y: 0, w: 32, h: 32,
    render: (incoming, outgoing) => {
      let scheduleValueXml;
      if (step.scheduleParam) {
        scheduleValueXml = ifl("scheduleKey", `{{${step.scheduleParam}}}`);
      } else {
        const cron = (step.cron || "0 0 0/6 ? * * *").trim().split(/\s+/);
        const { value, warnings } = buildTimerScheduleKey(cron, step.timezone || "Etc/GMT");
        g.warnings.push(...warnings);
        scheduleValueXml = ifl("scheduleKey", value);
      }
      return (
        `<bpmn2:startEvent id="${id}" name="${attrEscape(name)}">` +
        outgoing.map((o) => `<bpmn2:outgoing>${o}</bpmn2:outgoing>`).join("") +
        `<bpmn2:timerEventDefinition id="${g.ids.next("TimerEventDefinition")}">` +
        `<bpmn2:extensionElements>${scheduleValueXml}` +
        ifl("componentVersion", "1.4") +
        ifl("cmdVariantUri", "ctype::FlowstepVariant/cname::intermediatetimer/version::1.4.0") +
        ifl("activityType", "StartTimerEvent") +
        `</bpmn2:extensionElements></bpmn2:timerEventDefinition></bpmn2:startEvent>`
      );
    },
  });
  return id;
}

// HTTPS Sender-triggered start (webhook-style).
function createHttpsStartNode(step, g) {
  const id = g.ids.next("StartEvent");
  const name = sanitizeElementName(step.name, "Start");
  // Confirmed against a real UI-built flow (2026-08-15): this participant DOES carry
  // ifl:type="EndpointSender" (a prior version of this code assumed otherwise, and the
  // sender rendered without a proper labeled pool in the web editor as a result).
  // Positioned to the left of the whole pool, vertically centered on this start event.
  const { participantId, system } = mkParticipant(g, `${name}_Sender`, "sender", id, "left");

  const mfId = g.ids.next("MessageFlow");
  const a = step.adapter;
  const props =
    ifl("ComponentType", "HTTPS") +
    ifl("ComponentNS", "sap") +
    ifl("componentVersion", "1.4") +
    ifl("Name", "HTTPS") +
    ifl("system", system) +
    ifl("Description", "") +
    ifl("urlPath", a.urlPath) +
    ifl("senderAuthType", a.senderAuthType || "RoleBased") +
    ifl("userRole", a.userRole || "ESBMessaging.send") +
    ifl("xsrfProtection", "1") +
    ifl("maximumBodySize", "40") +
    ifl("TransportProtocol", "HTTPS") +
    ifl("MessageProtocol", "None") +
    ifl("TransportProtocolVersion", "1.5.0") +
    ifl("MessageProtocolVersion", "1.5.0") +
    ifl("ComponentSWCVName", "external") +
    ifl("ComponentSWCVId", "1.5.0") +
    ifl("cmdVariantUri", "ctype::AdapterVariant/cname::sap:HTTPS/tp::HTTPS/mp::None/direction::Sender/version::1.5.0");
  const mfXml = `<bpmn2:messageFlow id="${mfId}" name="HTTPS" sourceRef="${participantId}" targetRef="${id}"><bpmn2:extensionElements>${props}</bpmn2:extensionElements></bpmn2:messageFlow>`;
  g.messageFlows.push({ id: mfId, sourceRef: participantId, targetRef: id, xml: mfXml });

  g.nodes.set(id, {
    x: 0, y: 0, w: 32, h: 32,
    render: (incoming, outgoing) => (
      `<bpmn2:startEvent id="${id}" name="${attrEscape(name)}">` +
      `<bpmn2:extensionElements>` +
      ifl("componentVersion", "1.0") +
      ifl("cmdVariantUri", "ctype::FlowstepVariant/cname::MessageStartEvent/version::1.0") +
      ifl("activityType", "StartEvent") +
      `</bpmn2:extensionElements>` +
      outgoing.map((o) => `<bpmn2:outgoing>${o}</bpmn2:outgoing>`).join("") +
      `<bpmn2:messageEventDefinition/></bpmn2:startEvent>`
    ),
  });
  return id;
}

function createContentModifierNode(step, g) {
  const id = g.ids.next("CallActivity");
  const name = sanitizeElementName(step.name, "Content_Modifier");
  g.nodes.set(id, {
    x: 0, y: 0, w: 100, h: 80,
    render: (incoming, outgoing) => {
      const propertyRows = (step.properties || [])
        .map((p) => rowKeyed([["Action", "Create"], ["Type", p.type || "constant"], ["Value", p.value ?? ""], ["Default", ""], ["Name", p.name], ["Datatype", p.datatype || ""]]))
        .join("");
      const headerRows = (step.headers || [])
        .map((p) => rowKeyed([["Action", "Create"], ["Type", p.type || "constant"], ["Value", p.value ?? ""], ["Default", ""], ["Name", p.name], ["Datatype", p.datatype || ""]]))
        .join("");
      return (
        `<bpmn2:callActivity id="${id}" name="${attrEscape(name)}">` +
        `<bpmn2:extensionElements>` +
        ifl("bodyType", "expression") +
        ifl("propertyTable", propertyRows) +
        ifl("headerTable", headerRows) +
        ifl("wrapContent", step.bodyExpression || "${in.body}") +
        ifl("componentVersion", "1.6") +
        ifl("activityType", "Enricher") +
        ifl("cmdVariantUri", "ctype::FlowstepVariant/cname::Enricher/version::1.6.3") +
        `</bpmn2:extensionElements>` +
        incoming.map((i) => `<bpmn2:incoming>${i}</bpmn2:incoming>`).join("") +
        outgoing.map((o) => `<bpmn2:outgoing>${o}</bpmn2:outgoing>`).join("") +
        `</bpmn2:callActivity>`
      );
    },
  });
  return id;
}

function createGroovyNode(step, g) {
  const id = g.ids.next("CallActivity");
  const name = sanitizeElementName(step.name, "Script");
  const filename = `${name}.groovy`;
  g.scripts[filename] = step.script;
  g.nodes.set(id, {
    x: 0, y: 0, w: 100, h: 80,
    render: (incoming, outgoing) => (
      `<bpmn2:callActivity id="${id}" name="${attrEscape(name)}">` +
      `<bpmn2:extensionElements>` +
      ifl("scriptFunction", "") +
      ifl("scriptBundleId", "") +
      ifl("componentVersion", "1.1") +
      ifl("activityType", "Script") +
      ifl("cmdVariantUri", "ctype::FlowstepVariant/cname::GroovyScript/version::1.1.2") +
      ifl("subActivityType", "GroovyScript") +
      ifl("script", filename) +
      `</bpmn2:extensionElements>` +
      incoming.map((i) => `<bpmn2:incoming>${i}</bpmn2:incoming>`).join("") +
      outgoing.map((o) => `<bpmn2:outgoing>${o}</bpmn2:outgoing>`).join("") +
      `</bpmn2:callActivity>`
    ),
  });
  return id;
}

function createEndEventNode(step, g) {
  const id = g.ids.next("EndEvent");
  const name = sanitizeElementName(step && step.name, "End");
  g.nodes.set(id, {
    x: 0, y: 0, w: 32, h: 32,
    render: (incoming) => (
      `<bpmn2:endEvent id="${id}" name="${attrEscape(name)}">` +
      `<bpmn2:extensionElements>` +
      ifl("cmdVariantUri", "ctype::FlowstepVariant/cname::MessageEndEvent/version::1.1.0") +
      ifl("componentVersion", "1.1") +
      `</bpmn2:extensionElements>` +
      incoming.map((i) => `<bpmn2:incoming>${i}</bpmn2:incoming>`).join("") +
      `<bpmn2:messageEventDefinition/></bpmn2:endEvent>`
    ),
  });
  return id;
}

// --- Request-Reply / Send adapters (step -> receiver participant) ------------

const HTTP_AUTH_CONFIRMED = new Set(["None"]);

// Deliberately NOT using `new URL(...)` here: WHATWG URL parsing lowercases the host
// component and can reject or mis-handle a host that's entirely a {{Placeholder}}
// token (confirmed live — a {{SlackWebhookUrl}}-shaped host got silently lower-cased
// to {{slackwebhookurl}} while the *declared* parameter kept its real casing, and the
// same address form was inconsistently accepted/rejected across calls). A plain
// string split on the first "?" preserves placeholder casing exactly and never
// depends on the address being valid URL syntax once {{ }} tokens are in it.
//
// TransportProtocolVersion/MessageProtocolVersion/ComponentSWCVName/ComponentSWCVId
// (2026-08-15): this builder was missing all four even though odata/jms already had
// their equivalents — a real, HTTP-specific gap, not a documented-but-optional field.
function httpMessageFlowXml(mfId, sourceRef, targetRef, adapter, system, g) {
  const address = adapter.address;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(address)) {
    throw new Error(`HTTP adapter address "${address}" must start with a scheme, e.g. "https://" (including when the host is a {{Placeholder}}).`);
  }
  const qIdx = address.indexOf("?");
  const withoutQuery = qIdx === -1 ? address : address.slice(0, qIdx);
  const query = qIdx === -1 ? "" : address.slice(qIdx + 1);
  if (!HTTP_AUTH_CONFIRMED.has(adapter.authenticationMethod)) {
    g.warnings.push(
      `HTTP adapter targeting "${system}": authenticationMethod "${adapter.authenticationMethod}" is not confirmed ` +
        `working (only "None" is) — this adapter rejected "OAuth2ClientCredentials" outright in a live test. Use ` +
        `adapter type "odata" for real auth against an OData service.`
    );
  }
  const props =
    ifl("httpAddressWithoutQuery", withoutQuery) +
    ifl("httpAddressQuery", query) +
    ifl("httpMethod", adapter.method || "GET") +
    ifl("authenticationMethod", adapter.authenticationMethod || "None") +
    ifl("credentialName", adapter.credentialName || "") +
    ifl("proxyType", "default") +
    ifl("system", system) +
    ifl("ComponentNS", "sap") +
    ifl("ComponentType", "HTTP") +
    ifl("TransportProtocol", "HTTP") +
    ifl("MessageProtocol", "None") +
    ifl("direction", "Receiver") +
    ifl("httpRequestTimeout", String(adapter.timeoutMs ?? 60000)) +
    ifl("httpShouldSendBody", "false") +
    ifl("enableMPLAttachments", "true") +
    ifl("Name", "HTTP") +
    ifl("componentVersion", "1.20") +
    ifl("TransportProtocolVersion", "1.20.1") +
    ifl("MessageProtocolVersion", "1.20.1") +
    ifl("ComponentSWCVName", "external") +
    ifl("ComponentSWCVId", "1.20.1") +
    ifl("cmdVariantUri", "ctype::AdapterVariant/cname::sap:HTTP/tp::HTTP/mp::None/direction::Receiver/version::1.20.1");
  return `<bpmn2:messageFlow id="${mfId}" name="HTTP" sourceRef="${sourceRef}" targetRef="${targetRef}"><bpmn2:extensionElements>${props}</bpmn2:extensionElements></bpmn2:messageFlow>`;
}

// Same gap as HTTP above (TransportProtocolVersion/MessageProtocolVersion/
// ComponentSWCVName/ComponentSWCVId), plus a separate one: `user` alone isn't enough
// for Basic/loginPlain auth to actually authenticate — `credential_name` (distinct
// key from `user`) needs the same credential name too (2026-08-15). Also confirmed
// live (2026-08-15, v1.1.0 regression test): this was the only adapter builder in the
// whole file missing `ComponentNS: sap` — every other one (http/odata/sftpWrite/jms/
// sftpPoll) sets it. Without it, ValidateIntegrationDesigntimeArtifact fails the Mail
// channel with the generic "Enter adapter details for channel" error and no other
// symptom — the same opaque failure mode the `system`/participant-name mismatch
// produces, just from a different missing property.
function mailMessageFlowXml(mfId, sourceRef, targetRef, adapter, system) {
  const props =
    ifl("server", adapter.server) +
    ifl("from", adapter.from) +
    ifl("to", adapter.to) +
    ifl("cc", adapter.cc || "") +
    ifl("bcc", adapter.bcc || "") +
    ifl("subject", adapter.subject) +
    ifl("body", adapter.body) +
    ifl("auth", adapter.auth || "loginPlain") +
    ifl("ssl", adapter.ssl || "starttls_mandatory") +
    ifl("user", adapter.credentialName || "") +
    ifl("credential_name", adapter.credentialName || "") +
    ifl("content_type", adapter.contentType || "text/plain") +
    ifl("content_encoding", "UTF-8") +
    ifl("proxyType", "none") +
    ifl("keep_attachments", "0") +
    ifl("attachments", "") +
    ifl("Name", "Mail") +
    ifl("system", system) +
    ifl("ComponentNS", "sap") +
    ifl("ComponentType", "Mail") +
    ifl("TransportProtocol", "SMTP") +
    ifl("MessageProtocol", "None") +
    ifl("direction", "Receiver") +
    ifl("timeout", "30000") +
    ifl("componentVersion", "1.12") +
    ifl("TransportProtocolVersion", "1.12.0") +
    ifl("MessageProtocolVersion", "1.12.0") +
    ifl("ComponentSWCVName", "external") +
    ifl("ComponentSWCVId", "1.12.0") +
    ifl("cmdVariantUri", "ctype::AdapterVariant/cname::sap:Mail/tp::SMTP/mp::None/direction::Receiver/version::1.12.0");
  return `<bpmn2:messageFlow id="${mfId}" name="Mail" sourceRef="${sourceRef}" targetRef="${targetRef}"><bpmn2:extensionElements>${props}</bpmn2:extensionElements></bpmn2:messageFlow>`;
}

function odataMessageFlowXml(mfId, sourceRef, targetRef, adapter, system, g) {
  if (adapter.authenticationMethod !== "None" && !adapter.credentialName) {
    g.warnings.push(`OData adapter targeting "${system}": authenticationMethod is "${adapter.authenticationMethod}" but no credentialName was given.`);
  }
  const props =
    ifl("address", adapter.address) +
    ifl("operation", adapter.operation || "Query(GET)") +
    ifl("resourcePath", adapter.resourcePath) +
    ifl("queryOptions", adapter.queryOptions || "") +
    ifl("customQueryOptions", "") +
    ifl("fields", "") +
    ifl("pagination", adapter.pagination ? "1" : "0") +
    ifl("odatapagesize", "1000") +
    ifl("authenticationMethod", adapter.authenticationMethod || "None") +
    ifl("alias", adapter.credentialName || "") +
    ifl("isCSRFEnabled", adapter.isCSRFEnabled ? "true" : "false") +
    ifl("contentType", adapter.contentType || "application/atom+xml") +
    ifl("enableBatchProcessing", "0") +
    ifl("characterEncoding", "none") +
    ifl("enableMPLAttachments", "true") +
    ifl("receiveTimeOut", String(adapter.timeoutSec ?? 60)) +
    ifl("proxyHost", "") +
    ifl("proxyPort", "") +
    ifl("scc_location_id", "") +
    ifl("metadataAllowedHeaders", "") +
    ifl("metadataAllowedURIParams", "") +
    ifl("whitelistRequestHeaders", "") +
    ifl("whitelistResponseHeaders", "") +
    ifl("odataCertAuthPrivateKeyAlias", "") +
    ifl("enableTLSSessionReuse", "false") +
    ifl("edmxFilePath", "") +
    ifl("Name", "OData") +
    ifl("system", system) +
    ifl("ComponentType", "HCIOData") +
    ifl("ComponentNS", "sap") +
    ifl("TransportProtocol", "HTTP") +
    ifl("MessageProtocol", "OData V2") +
    ifl("TransportProtocolVersion", "1.24.0") +
    ifl("MessageProtocolVersion", "1.24.0") +
    ifl("ComponentSWCVName", "external") +
    ifl("ComponentSWCVId", "1.24.0") +
    ifl("componentVersion", "1.24") +
    ifl("cmdVariantUri", "ctype::AdapterVariant/cname::sap:HCIOData/tp::HTTP/mp::OData V2/direction::Receiver/version::1.24.0");
  return `<bpmn2:messageFlow id="${mfId}" name="OData" sourceRef="${sourceRef}" targetRef="${targetRef}"><bpmn2:extensionElements>${props}</bpmn2:extensionElements></bpmn2:messageFlow>`;
}

function sftpWriteMessageFlowXml(mfId, sourceRef, targetRef, adapter, system, g) {
  const usingKey = (adapter.authentication || "public_key") === "public_key";
  if (usingKey && !adapter.privateKeyAlias) g.warnings.push(`SFTP write adapter targeting "${system}": authentication is "public_key" but no privateKeyAlias was given.`);
  if (!usingKey && !adapter.credentialName) g.warnings.push(`SFTP write adapter targeting "${system}": authentication is "user_password" but no credentialName was given.`);
  const props =
    ifl("host", adapter.host) +
    ifl("authentication", adapter.authentication || "public_key") +
    ifl("privateKeyAlias", usingKey ? adapter.privateKeyAlias || "" : "") +
    ifl("username", adapter.username || "") +
    ifl("credential_name", usingKey ? "" : adapter.credentialName || "") +
    ifl("connectTimeout", "10000") +
    ifl("maximumReconnectAttempts", "3") +
    ifl("reconnectDelay", "1000") +
    ifl("path", adapter.path) +
    ifl("fileName", adapter.fileName || "${header.CamelFileName}") +
    ifl("fileExist", adapter.fileExist || "Override") +
    ifl("autoCreate", "1") +
    ifl("stepwise", "1") +
    ifl("flatten", "") +
    ifl("useTempFile", "0") +
    ifl("tempFileName", "${file:name}.tmp") +
    ifl("fileAppendTimeStamp", "0") +
    ifl("sftpSecEnabled", "1") +
    ifl("disconnect", "1") +
    ifl("maximumFileSize", "40") +
    ifl("fastExistsCheck", "1") +
    ifl("allowDeprecatedAlgorithms", "0") +
    ifl("location_id", "") +
    ifl("Name", "SFTP") +
    ifl("system", system) +
    ifl("ComponentType", "SFTP") +
    ifl("ComponentNS", "sap") +
    ifl("direction", "Receiver") +
    ifl("Description", "") +
    ifl("TransportProtocol", "SFTP") +
    ifl("MessageProtocol", "File") +
    ifl("TransportProtocolVersion", "1.13.3") +
    ifl("MessageProtocolVersion", "1.13.3") +
    ifl("ComponentSWCVName", "external") +
    ifl("ComponentSWCVId", "1.13.3") +
    ifl("componentVersion", "1.13") +
    ifl("cmdVariantUri", "ctype::AdapterVariant/cname::sap:SFTP/tp::SFTP/mp::File/direction::Receiver/version::1.13.3");
  return `<bpmn2:messageFlow id="${mfId}" name="SFTP" sourceRef="${sourceRef}" targetRef="${targetRef}"><bpmn2:extensionElements>${props}</bpmn2:extensionElements></bpmn2:messageFlow>`;
}

// Confirmed live (2026-08-15) against a JMS channel hand-fixed in the web editor:
// this was missing `direction` entirely (every OTHER adapter builder here has it —
// a real, JMS-specific oversight from the un-confirmed community-reference origin),
// plus `Description`, `ComponentSWCVName`, `ExpirationPeriod`, `TransferExchangeProperties`,
// and `AccessType`. `ExpirationPeriod`'s value is a plain string, e.g. "30" — no
// special datatype wrapper, same as every other numeric property in these adapters.
function jmsMessageFlowXml(mfId, sourceRef, targetRef, adapter, system) {
  const props =
    ifl("ComponentType", "JMS") +
    ifl("Description", "") +
    ifl("ComponentNS", "sap") +
    ifl("componentVersion", "1.6") +
    ifl("UseMessageCompression", "false") +
    ifl("Name", "JMS") +
    ifl("TransportProtocolVersion", "1.6.3") +
    ifl("ComponentSWCVName", "external") +
    ifl("QueueName_outbound", adapter.queueName) +
    ifl("system", system) +
    ifl("EncryptMessage", "false") +
    ifl("RetentionThresholdAlerting", "2") +
    ifl("ExpirationPeriod", String(adapter.expirationPeriodSec ?? 30)) +
    ifl("TransportProtocol", "Not Applicable") +
    ifl("cmdVariantUri", "ctype::AdapterVariant/cname::sap:JMS/tp::Not Applicable/mp::Not Applicable/direction::Receiver/version::1.6.3") +
    ifl("TransferExchangeProperties", "0") +
    ifl("MessageProtocol", "Not Applicable") +
    ifl("MessageProtocolVersion", "1.6.3") +
    ifl("ComponentSWCVId", "1.6.3") +
    ifl("AccessType", "Non-Exclusive") +
    ifl("direction", "Receiver");
  return `<bpmn2:messageFlow id="${mfId}" name="JMS" sourceRef="${sourceRef}" targetRef="${targetRef}"><bpmn2:extensionElements>${props}</bpmn2:extensionElements></bpmn2:messageFlow>`;
}

const SEND_ADAPTER_BUILDERS = {
  http: httpMessageFlowXml,
  mail: mailMessageFlowXml,
  odata: odataMessageFlowXml,
  sftpWrite: sftpWriteMessageFlowXml,
  jms: jmsMessageFlowXml,
};

function createServiceTaskNode(step, g) {
  const id = g.ids.next("ServiceTask");
  const name = sanitizeElementName(step.name, step.kind === "send" ? "Send" : "Request_Reply");
  const activityType = step.kind === "send" ? "Send" : "ExternalCall";
  const cmdVariantUri =
    step.kind === "send"
      ? "ctype::FlowstepVariant/cname::Send/version::1.0.4"
      : "ctype::FlowstepVariant/cname::ExternalCall/version::1.0.4";

  const suffix = { http: "Endpoint", mail: "Mail_Server", odata: "OData_Service", sftpWrite: "Sftp_Server", jms: "Queue" }[step.adapter.type] || "Endpoint";
  const { participantId, system } = mkParticipant(g, `${name}_${suffix}`, "receiver", id, "below");

  const builder = SEND_ADAPTER_BUILDERS[step.adapter.type];
  if (!builder) throw new Error(`Unknown adapter type "${step.adapter.type}" for a '${step.kind}' step.`);
  const mfId = g.ids.next("MessageFlow");
  const mfXml = builder(mfId, id, participantId, step.adapter, system, g);
  g.messageFlows.push({ id: mfId, sourceRef: id, targetRef: participantId, xml: mfXml });

  g.nodes.set(id, {
    x: 0, y: 0, w: 100, h: 80,
    render: (incoming, outgoing) => (
      `<bpmn2:serviceTask id="${id}" name="${attrEscape(name)}">` +
      `<bpmn2:extensionElements>` +
      ifl("componentVersion", "1.0") +
      ifl("activityType", activityType) +
      ifl("cmdVariantUri", cmdVariantUri) +
      `</bpmn2:extensionElements>` +
      incoming.map((i) => `<bpmn2:incoming>${i}</bpmn2:incoming>`).join("") +
      outgoing.map((o) => `<bpmn2:outgoing>${o}</bpmn2:outgoing>`).join("") +
      `</bpmn2:serviceTask>`
    ),
  });
  return id;
}

// --- Poll Enrich (participant -> step, e.g. mid-flow SFTP poll) --------------

function sftpPollMessageFlowXml(mfId, sourceRef, targetRef, adapter, system, g) {
  const usingKey = (adapter.authentication || "public_key") === "public_key";
  if (usingKey && !adapter.privateKeyAlias) g.warnings.push(`SFTP poll adapter targeting "${system}": authentication is "public_key" but no privateKeyAlias was given.`);
  if (!usingKey && !adapter.credentialName) g.warnings.push(`SFTP poll adapter targeting "${system}": authentication is "user_password" but no credentialName was given.`);
  if (!adapter.username) g.warnings.push(`SFTP poll adapter targeting "${system}": no username given — confirmed live to be required even under public_key authentication.`);
  const props =
    ifl("disconnect", "1") +
    ifl("fileName", adapter.fileName || "*") +
    ifl("Description", "") +
    ifl("maximumReconnectAttempts", "3") +
    ifl("stepwise", "0") +
    ifl("ComponentNS", "sap") +
    ifl("privateKeyAlias", usingKey ? adapter.privateKeyAlias || "" : "") +
    ifl("location_id", "") +
    ifl("recursive", "0") +
    ifl("Name", "SFTP") +
    ifl("TransportProtocolVersion", "1.9.0") +
    ifl("ComponentSWCVName", "external") +
    ifl("path", adapter.path) +
    ifl("noop", "test") +
    ifl("doneFileName", "") +
    ifl("regex_filter", "0") +
    ifl("host", adapter.host) +
    ifl("connectTimeout", "30000") +
    ifl("fastExistsCheck", "1") +
    ifl("MessageProtocol", "File") +
    ifl("ComponentSWCVId", "1.9.0") +
    ifl("direction", "Sender") +
    ifl("authentication", adapter.authentication || "public_key") +
    ifl("ComponentType", "PollingSFTP") +
    ifl("credential_name", usingKey ? "" : adapter.credentialName || "") +
    ifl("readLock", "none") +
    ifl("proxyType", "none") +
    ifl("proxyAlias", "") +
    ifl("componentVersion", "1.9") +
    ifl("reconnectDelay", "1000") +
    ifl("proxyHost", "") +
    ifl("system", system) +
    ifl("allowDeprecatedAlgorithms", "0") +
    ifl("TransportProtocol", "SFTP") +
    ifl("cmdVariantUri", "ctype::AdapterVariant/cname::sap:PollingSFTP/tp::SFTP/mp::File/direction::Sender/version::1.9.0") +
    ifl("processingMode", "none") +
    ifl("MessageProtocolVersion", "1.9.0") +
    ifl("username", adapter.username || "");
  return `<bpmn2:messageFlow id="${mfId}" name="SFTP" sourceRef="${sourceRef}" targetRef="${targetRef}"><bpmn2:extensionElements>${props}</bpmn2:extensionElements></bpmn2:messageFlow>`;
}

const POLL_ADAPTER_BUILDERS = {
  sftpPoll: sftpPollMessageFlowXml,
};

function createPollEnrichNode(step, g) {
  const id = g.ids.next("ServiceTask");
  const name = sanitizeElementName(step.name, "Poll_Enrich");

  const suffix = { sftpPoll: "Sftp_Server" }[step.adapter.type] || "Sender";
  const { participantId, system } = mkParticipant(g, `${name}_${suffix}`, "sender", id, "above");

  const builder = POLL_ADAPTER_BUILDERS[step.adapter.type];
  if (!builder) throw new Error(`Unknown poll adapter type "${step.adapter.type}" for a 'pollEnrich' step.`);
  const mfId = g.ids.next("MessageFlow");
  const mfXml = builder(mfId, participantId, id, step.adapter, system, g);
  g.messageFlows.push({ id: mfId, sourceRef: participantId, targetRef: id, xml: mfXml });

  g.nodes.set(id, {
    x: 0, y: 0, w: 100, h: 80,
    render: (incoming, outgoing) => (
      `<bpmn2:serviceTask id="${id}" name="${attrEscape(name)}">` +
      `<bpmn2:extensionElements>` +
      ifl("aggregationAlgorithm", "UseLatest") +
      ifl("componentVersion", "1.1") +
      ifl("activityType", "PollEnrich") +
      ifl("cmdVariantUri", "ctype::FlowstepVariant/cname::PollEnrich/version::1.1.0") +
      ifl("stopOnNoMsgFound", step.stopOnNoMsgFound === true ? "true" : "false") +
      `</bpmn2:extensionElements>` +
      incoming.map((i) => `<bpmn2:incoming>${i}</bpmn2:incoming>`).join("") +
      outgoing.map((o) => `<bpmn2:outgoing>${o}</bpmn2:outgoing>`).join("") +
      `</bpmn2:serviceTask>`
    ),
  });
  return id;
}

function createGatewayNode(step, g) {
  const id = g.ids.next("ExclusiveGateway");
  const name = sanitizeElementName(step.name, "Router");
  g.nodes.set(id, {
    x: 0, y: 0, w: 40, h: 40,
    render: (incoming, outgoing, gatewayDefault) => (
      `<bpmn2:exclusiveGateway default="${gatewayDefault}" id="${id}" name="${attrEscape(name)}">` +
      `<bpmn2:extensionElements>` +
      ifl("componentVersion", "1.1") +
      ifl("activityType", "ExclusiveGateway") +
      ifl("cmdVariantUri", "ctype::FlowstepVariant/cname::ExclusiveGateway/version::1.1.2") +
      ifl("throwException", "false") +
      `</bpmn2:extensionElements>` +
      incoming.map((i) => `<bpmn2:incoming>${i}</bpmn2:incoming>`).join("") +
      outgoing.map((o) => `<bpmn2:outgoing>${o}</bpmn2:outgoing>`).join("") +
      `</bpmn2:exclusiveGateway>`
    ),
  });
  return id;
}

function createNode(step, g) {
  switch (step.kind) {
    case "timer": return createTimerNode(step, g);
    case "httpsStart": return createHttpsStartNode(step, g);
    case "contentModifier": return createContentModifierNode(step, g);
    case "groovyScript": return createGroovyNode(step, g);
    case "requestReply":
    case "send": return createServiceTaskNode(step, g);
    case "pollEnrich": return createPollEnrichNode(step, g);
    case "endEvent": return createEndEventNode(step, g);
    case "router": return createGatewayNode(step, g);
    default:
      throw new Error(`Step kind "${step.kind}" is not supported yet. Supported kinds: ${SUPPORTED_KINDS.join(", ")}.`);
  }
}

// --- Graph walking (structure only — no positions) ---------------------------

function emitChain(steps, g, incoming) {
  let current = { sourceId: incoming.sourceId };
  let pendingFirstFlow = incoming.firstFlow || null;

  if (steps.length === 0) {
    const endId = createEndEventNode({ name: "End" }, g);
    if (pendingFirstFlow) {
      connect(g, current.sourceId, endId, { presetId: pendingFirstFlow.id, name: pendingFirstFlow.name, condition: pendingFirstFlow.condition, gatewayRoute: true });
    } else {
      connect(g, current.sourceId, endId, {});
    }
    return { lastId: endId };
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (START_KINDS.includes(step.kind)) throw new Error(`'${step.kind}' may only be the very first step of the whole flow.`);
    const nodeId = createNode(step, g);

    if (pendingFirstFlow) {
      connect(g, current.sourceId, nodeId, { presetId: pendingFirstFlow.id, name: pendingFirstFlow.name, condition: pendingFirstFlow.condition, gatewayRoute: true });
      pendingFirstFlow = null;
    } else {
      connect(g, current.sourceId, nodeId, {});
    }

    if (step.kind === "router") {
      if (i !== steps.length - 1) throw new Error("A 'router' step's branches don't reconverge — it must be the last step in its steps list.");
      handleRouter(step, g, nodeId);
      return { lastId: nodeId };
    }

    current = { sourceId: nodeId };
  }

  const last = steps[steps.length - 1];
  if (last.kind !== "endEvent") {
    const endId = createEndEventNode({ name: "End" }, g);
    connect(g, current.sourceId, endId, {});
    return { lastId: endId };
  }
  return { lastId: current.sourceId };
}

function handleRouter(step, g, gatewayId) {
  let defaultBranch = step.branches.find((b) => b.condition == null);
  if (!defaultBranch) defaultBranch = step.branches[step.branches.length - 1];

  // No lane bookkeeping needed here anymore — ELK's own layered layout naturally
  // keeps a long chain roughly in-line and fans shorter branches out vertically
  // (confirmed against SAP's own web editor "Align" behavior), so branches are just
  // structural fan-out from the gateway; layout is entirely the layout pass's job.
  for (const branch of step.branches) {
    const isDefault = branch === defaultBranch;
    const flowId = g.ids.next("SequenceFlow");
    if (isDefault) g.gatewayDefault.set(gatewayId, flowId);
    const condition = isDefault ? null : normalizeCondition(branch.condition);
    if (!branch.steps.length) throw new Error(`Router branch "${branch.name}" has no steps.`);
    emitChain(branch.steps, g, {
      sourceId: gatewayId,
      firstFlow: { id: flowId, name: sanitizeElementName(branch.name), condition },
    });
  }
}

/** Build a FlowGraph from the validated top-level spec ({ steps, ... }). */
export function buildFlowGraph(spec) {
  const g = new FlowGraph();
  if (!spec.steps.length || !START_KINDS.includes(spec.steps[0].kind)) {
    throw new Error(`The first step must be one of: ${START_KINDS.join(", ")}.`);
  }
  const startId = createNode(spec.steps[0], g);
  emitChain(spec.steps.slice(1), g, { sourceId: startId });
  return g;
}

/**
 * Render the finished graph into the three XML fragments an .iflw needs. Runs the
 * ELK layout pass first (process nodes + sequenceFlows only — participants are
 * deliberately NOT part of the ELK graph, so they can never end up positioned
 * inside the pool; see the per-participant "side" resolution below instead), then
 * generates BPMN2/diagram XML from the resulting coordinates.
 */
export async function renderFlowGraph(g) {
  const nodeIds = [...g.nodes.keys()];
  const elkGraph = {
    id: "pool",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "50",
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
      "elk.layered.spacing.edgeNodeBetweenLayers": "30",
      "elk.padding": "[top=40,left=40,bottom=40,right=40]",
    },
    children: nodeIds.map((id) => {
      const n = g.nodes.get(id);
      return { id, width: n.w, height: n.h };
    }),
    edges: g.flows.map((f) => ({ id: f.id, sources: [f.sourceRef], targets: [f.targetRef] })),
  };
  const result = await layoutWithElk(elkGraph);

  const elkNodeById = new Map(result.children.map((c) => [c.id, c]));
  for (const id of nodeIds) {
    const c = elkNodeById.get(id);
    const node = g.nodes.get(id);
    node.x = POOL_X + c.x;
    node.y = POOL_Y + c.y;
  }
  const pool = { width: result.width, height: result.height };
  const elkEdgeById = new Map((result.edges || []).map((e) => [e.id, e]));

  // Now that every process node has a real x/y, resolve each participant's position
  // relative to its anchor node and the (now fully-grown) pool.
  for (const p of g.participants.values()) {
    const anchor = g.nodes.get(p.anchorNodeId);
    if (p.side === "left") {
      p.x = POOL_X - PARTICIPANT_WIDTH - 50;
      p.y = anchor.y + anchor.h / 2 - p.h / 2;
    } else if (p.side === "below") {
      p.x = anchor.x + anchor.w / 2 - p.w / 2;
      p.y = POOL_Y + pool.height + PARTICIPANT_MARGIN;
    } else if (p.side === "above") {
      p.x = anchor.x + anchor.w / 2 - p.w / 2;
      p.y = Math.max(0, POOL_Y - p.h - PARTICIPANT_MARGIN);
    }
  }

  const incomingOf = new Map();
  const outgoingOf = new Map();
  for (const f of g.flows) {
    if (!outgoingOf.has(f.sourceRef)) outgoingOf.set(f.sourceRef, []);
    outgoingOf.get(f.sourceRef).push(f.id);
    if (!incomingOf.has(f.targetRef)) incomingOf.set(f.targetRef, []);
    incomingOf.get(f.targetRef).push(f.id);
  }

  const nodeXmls = [];
  const shapeXmls = [];
  for (const [id, node] of g.nodes) {
    nodeXmls.push(node.render(incomingOf.get(id) || [], outgoingOf.get(id) || [], g.gatewayDefault.get(id)));
    shapeXmls.push(shape(id, node.x, node.y, node.w, node.h));
  }

  const flowXmls = [];
  const edgeXmls = [];
  for (const f of g.flows) {
    const nameAttr = f.name ? ` name="${attrEscape(f.name)}"` : "";
    if (f.gatewayRoute) {
      let inner =
        `<bpmn2:extensionElements>` +
        ifl("expressionType", f.condition ? "NonXML" : "XML") +
        ifl("componentVersion", "1.0") +
        ifl("cmdVariantUri", "ctype::FlowstepVariant/cname::GatewayRoute/version::1.0.0") +
        `</bpmn2:extensionElements>`;
      if (f.condition) {
        inner += `<bpmn2:conditionExpression id="FormalExpression_${f.id}" xsi:type="bpmn2:tFormalExpression">${xmlEscape(f.condition)}</bpmn2:conditionExpression>`;
      }
      flowXmls.push(`<bpmn2:sequenceFlow id="${f.id}"${nameAttr} sourceRef="${f.sourceRef}" targetRef="${f.targetRef}">${inner}</bpmn2:sequenceFlow>`);
    } else {
      flowXmls.push(`<bpmn2:sequenceFlow id="${f.id}"${nameAttr} sourceRef="${f.sourceRef}" targetRef="${f.targetRef}"/>`);
    }
    const elkEdge = elkEdgeById.get(f.id);
    if (elkEdge) {
      edgeXmls.push(edgeFromElk(f.id, elkEdge, POOL_X, POOL_Y));
    } else {
      const a = g.nodes.get(f.sourceRef);
      const b = g.nodes.get(f.targetRef);
      if (a && b) edgeXmls.push(edgeBetween(f.id, a, b));
    }
  }

  const participantXmls = [];
  for (const [id, p] of g.participants) {
    if (p.style === "sender") {
      participantXmls.push(
        `<bpmn2:participant id="${id}" ifl:type="EndpointSender" name="${attrEscape(p.name)}">` +
          `<bpmn2:extensionElements>${ifl("enableBasicAuthentication", "false")}${ifl("ifl:type", "EndpointSender")}</bpmn2:extensionElements>` +
          `</bpmn2:participant>`
      );
    } else {
      participantXmls.push(`<bpmn2:participant id="${id}" ifl:type="EndpointRecevier" name="${attrEscape(p.name)}"/>`);
    }
    shapeXmls.push(shape(id, p.x, p.y, p.w, p.h));
  }
  const messageFlowXmls = g.messageFlows.map((mf) => mf.xml);
  for (const mf of g.messageFlows) {
    const a = g.nodes.get(mf.sourceRef) || g.participants.get(mf.sourceRef);
    const b = g.nodes.get(mf.targetRef) || g.participants.get(mf.targetRef);
    if (a && b) edgeXmls.push(edgeBetween(mf.id, a, b));
  }

  return {
    processInner: nodeXmls.join("") + flowXmls.join(""),
    collaborationExtra: participantXmls.join("") + messageFlowXmls.join(""),
    diagramInner: shapeXmls.join("") + edgeXmls.join(""),
    scripts: g.scripts,
    warnings: g.warnings,
    pool,
  };
}
