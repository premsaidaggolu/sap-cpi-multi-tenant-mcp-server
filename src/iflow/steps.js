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

import { xmlEscape, attrEscape, rowKeyed, rowPlain, ifl, IdGen, sanitizeElementName, normalizeCondition, buildTimerScheduleKey, authMethodValue } from "./xml.js";
import { layoutWithElk } from "./layout.js";

export const SUPPORTED_KINDS = [
  "timer", "httpsStart", "sftpStart", "contentModifier", "router", "groovyScript", "requestReply", "send",
  "pollEnrich", "filter", "xmlModifier", "writeVariables", "splitter", "gather",
  "dataStoreGet", "dataStorePut", "dataStoreSelect", "dataStoreDelete", "processCall", "endEvent",
];
export const START_KINDS = ["timer", "httpsStart", "sftpStart"];
// "processCall" (above) targets a Local Integration Process declared separately in the
// top-level spec's "localProcesses" array — see buildLocalProcessGraph/assembleIflow
// below — and "exceptionSubprocess" (global error handling, on by default for both the
// main flow and every local process) is handled by renderExceptionSubprocess, also
// below. Both confirmed real patterns, 2026-08-16, from AI_Agent_Reference_IFlow.

// Confirmed live (2026-08-15) against a pristine untouched default shell AND a real
// UI-built flow: the "Integration Process" pool always starts at x=250,y=60. The
// pool's own size is now computed by ELK (see renderFlowGraph) to fit whatever's
// actually inside it, rather than a hand-picked default. Each Local Integration
// Process (see assembleIflow) gets its own independent ELK pass, stacked vertically
// below the main pool with LOCAL_PROCESS_GAP between each.
const POOL_X = 250;
const POOL_Y = 60;
const PARTICIPANT_WIDTH = 100;
const PARTICIPANT_HEIGHT = 140; // confirmed SAP default (see mkParticipant)
const PARTICIPANT_MARGIN = 40; // gap between the pool's edge and a Sender/Receiver box
const LOCAL_PROCESS_GAP = 120;

class FlowGraph {
  // sharedIds/processIdMap are shared across the MAIN graph, every Local Integration
  // Process's own graph, and every Exception Subprocess in the same build — element
  // ids must be unique across the whole .iflw document (not just within one process),
  // and processCall steps anywhere need to resolve ANY declared local process's id.
  constructor(sharedIds, processIdMap) {
    this.ids = sharedIds || new IdGen();
    this.nodes = new Map(); // id -> { x, y, w, h, render(incoming, outgoing, gatewayDefault) }
    this.flows = []; // { id, sourceRef, targetRef, condition, name, gatewayRoute }
    this.gatewayDefault = new Map(); // gatewayId -> flowId
    this.participants = new Map(); // id -> { name, style: "sender"|"receiver", x, y, w, h, anchorNodeId, side: "left"|"below"|"above" }
    this.messageFlows = []; // { id, sourceRef, targetRef, xml }
    this.scripts = {}; // filename -> groovy source
    this.warnings = [];
    this.processIdMap = processIdMap || new Map(); // caller-facing localProcesses[].id -> real generated Process_N id
    this.endEventKind = "message"; // "message" (default, main flow) | "none" (Local Integration Process — see createEndEventNode)
  }
}

function shape(id, x, y, w, h) {
  // `isExpanded="true"` was tried here at one point on the theory that a subProcess's
  // shape needs it to render as a nested container rather than a disconnected box —
  // confirmed WRONG 2026-08-16 by inspecting a real hand-built reference flow
  // ("New_Manual_Iflow"): its Exception Subprocess shapes carry no such attribute at
  // all, just plain bounds — `<bpmndi:BPMNShape bpmnElement="SubProcess_7975" id="...">
  // <dc:Bounds height="140.0" width="400.0" x="1412.0" y="175.0"/></bpmndi:BPMNShape>`.
  // The real fix for the disconnected-box symptom was the stale-sibling-accumulation
  // bug in packageFiles.js (see injectFlowContent's header note), not this attribute.
  // Children use plain absolute coordinates that geometrically fall within the
  // parent's own box bounds — confirmed from that same reference — matching what
  // this generator already does via origin-based positioning.
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
        const { value, warnings } = buildTimerScheduleKey(cron, step.timezone || "Etc/GMT", step.throwExceptionOnExpiry !== false);
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

// SFTP-triggered start (file-landing-triggered flow) — confirmed 2026-08-16 from
// AI_Agent_Reference_IFlow's Participant->StartEvent messageFlow (cname::sap:SFTP,
// direction::Sender/version::1.20.1 — distinct from pollEnrich's mid-flow
// cname::sap:PollingSFTP/version::1.9.0 above, though CPI calls both "Sender" since
// both originate messages rather than receive them).
//
// The reference's own scheduleKey used a DAILY/TIME_HOUR_INTERVAL row-shape, not the
// ADVANCED/cron one buildTimerScheduleKey (used by the Timer step) produces. Reusing
// buildTimerScheduleKey here is a deliberate, reasonable-but-NOT-independently-
// confirmed choice: the actual trigger is the derived `schedule1` cron string, which
// is identical either way — only the cosmetic Configure-tab display fields might
// render differently. Verify the Schedule tab looks sensible in the web editor.
function sftpStartMessageFlowXml(mfId, sourceRef, targetRef, adapter, system, g) {
  const usingKey = (adapter.authentication || "user_password") === "public_key";
  if (usingKey && !adapter.privateKeyAlias) g.warnings.push(`SFTP start adapter targeting "${system}": authentication is "public_key" but no privateKeyAlias was given.`);
  if (!usingKey && !adapter.credentialName) g.warnings.push(`SFTP start adapter targeting "${system}": authentication is "user_password" but no credentialName was given.`);
  const cron = (adapter.cron || "0 0/10 * ? * * *").trim().split(/\s+/);
  const { value: scheduleValue, warnings } = buildTimerScheduleKey(cron, adapter.timezone || "Etc/GMT");
  g.warnings.push(...warnings);
  // Confirmed live 2026-08-16: the first version of this builder dropped several
  // properties that WERE present in the original raw reference dump (componentVersion/
  // ComponentSWCVId in particular — the exact same pattern already seen with http/mail/
  // jms in this file's history: a channel missing this cluster of version/id fields
  // fails ValidateIntegrationDesigntimeArtifact with the generic "Enter adapter details
  // for channel" and no other symptom). Restored here from that same reference dump.
  const props =
    ifl("disconnect", "1") +
    ifl("fileName", adapter.fileName || "*") +
    ifl("maximumFileSize", "40") +
    ifl("privateKeyAlias", usingKey ? adapter.privateKeyAlias || "" : "") +
    ifl("emptyFileHandling", "processFile") +
    ifl("location_id", "") +
    ifl("Name", "SFTP") +
    ifl("componentVersion", "1.20") +
    ifl("TransportProtocolVersion", "1.20.1") +
    ifl("proxyType", "none") +
    ifl("proxyPort", "8080") +
    ifl("path", adapter.path) +
    ifl("useClusterLock", "0") +
    ifl("regex_filter", "0") +
    ifl("host", adapter.host) +
    ifl("connectTimeout", "10000") +
    ifl("file_sorting_criteria", "") +
    ifl("system", system) +
    ifl("stopOnException", "1") +
    ifl("scheduleKey", scheduleValue) +
    ifl("allowDeprecatedAlgorithms", "0") +
    ifl("TransportProtocol", "SFTP") +
    ifl("cmdVariantUri", "ctype::AdapterVariant/cname::sap:SFTP/tp::SFTP/mp::File/direction::Sender/version::1.20.1") +
    ifl("MessageProtocolVersion", "1.20.1") +
    ifl("file_lock_timeout", "15") +
    ifl("Description", "") +
    ifl("readLockCheckInterval", "5000") +
    ifl("maximumReconnectAttempts", "3") +
    ifl("stepwise", "0") +
    ifl("ComponentNS", "sap") +
    ifl("recursive", "0") +
    ifl("ComponentSWCVName", "external") +
    ifl("noop", adapter.postProcessing || "move") +
    ifl("doneFileName", adapter.doneFileName || "${file:name}.done") +
    ifl("file.move", adapter.archivePath || ".archive") +
    ifl("MessageProtocol", "File") +
    ifl("direction", "Sender") +
    ifl("authentication", adapter.authentication || "user_password") +
    ifl("file_sorting_direction", "sort_direction_asc") +
    ifl("ComponentType", "SFTP") +
    ifl("proxyProtocol", "socks5") +
    ifl("idempotentRepository", "database") +
    ifl("proxyAlias", "") +
    ifl("reconnectDelay", "1000") +
    ifl("username", adapter.username || "") +
    ifl("ComponentSWCVId", "1.20.1") +
    ifl("credential_name", usingKey ? "" : adapter.credentialName || "");
  return `<bpmn2:messageFlow id="${mfId}" name="SFTP" sourceRef="${sourceRef}" targetRef="${targetRef}"><bpmn2:extensionElements>${props}</bpmn2:extensionElements></bpmn2:messageFlow>`;
}

function createSftpStartNode(step, g) {
  const id = g.ids.next("StartEvent");
  const name = sanitizeElementName(step.name, "Start");
  const { participantId, system } = mkParticipant(g, `${name}_Sftp_Server`, "sender", id, "left");
  const mfId = g.ids.next("MessageFlow");
  const mfXml = sftpStartMessageFlowXml(mfId, participantId, id, step.adapter, system, g);
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

// Bare BPMN "None Start Event" — no ifl: extensionElements at all. Used ONLY as the
// synthetic entry point of a Local Integration Process's own chain (see
// buildLocalProcessGraph below): a process invoked via Process Call isn't triggered
// by any adapter/message, so it needs no messageEventDefinition/timerEventDefinition.
// This exact shape for THIS specific context (a callable Local Integration Process)
// is a low-risk, standard-BPMN default rather than an independently confirmed one —
// verify the web editor accepts it before relying on it in production.
function createNoneStartNode(g) {
  const id = g.ids.next("StartEvent");
  g.nodes.set(id, {
    x: 0, y: 0, w: 32, h: 32,
    render: (incoming, outgoing) => (
      `<bpmn2:startEvent id="${id}" name="Start">` +
      outgoing.map((o) => `<bpmn2:outgoing>${o}</bpmn2:outgoing>`).join("") +
      `</bpmn2:startEvent>`
    ),
  });
  return id;
}

// Error Start/End Event pair — confirmed real shape (2026-08-16, AI_Agent_Reference_
// IFlow) for an Exception Subprocess's boundary events. Matching (step, g) => id
// signature to createEndEventNode so either can be used as emitChain's endFactory.
function createErrorStartEventNode(g) {
  const id = g.ids.next("StartEvent");
  g.nodes.set(id, {
    x: 0, y: 0, w: 32, h: 32,
    render: (incoming, outgoing) => (
      `<bpmn2:startEvent id="${id}" name="Error_Start">` +
      outgoing.map((o) => `<bpmn2:outgoing>${o}</bpmn2:outgoing>`).join("") +
      `<bpmn2:errorEventDefinition><bpmn2:extensionElements>` +
      ifl("cmdVariantUri", "ctype::FlowstepVariant/cname::ErrorStartEvent") +
      ifl("activityType", "StartErrorEvent") +
      `</bpmn2:extensionElements></bpmn2:errorEventDefinition></bpmn2:startEvent>`
    ),
  });
  return id;
}

function createErrorEndEventNode(step, g) {
  const id = g.ids.next("EndEvent");
  g.nodes.set(id, {
    x: 0, y: 0, w: 32, h: 32,
    render: (incoming) => (
      `<bpmn2:endEvent id="${id}" name="Error_End">` +
      incoming.map((i) => `<bpmn2:incoming>${i}</bpmn2:incoming>`).join("") +
      `<bpmn2:errorEventDefinition><bpmn2:extensionElements>` +
      ifl("cmdVariantUri", "ctype::FlowstepVariant/cname::ErrorEndEvent") +
      ifl("activityType", "EndErrorEvent") +
      `</bpmn2:extensionElements></bpmn2:errorEventDefinition></bpmn2:endEvent>`
    ),
  });
  return id;
}

// Process Call — invokes a Local Integration Process declared in the top-level spec's
// "localProcesses" array (see assembleIflow/buildLocalProcessGraph below), which
// pre-registers each one's REAL generated element id into g.processIdMap before any
// chain is walked, so forward/backward references between processes both resolve.
function createProcessCallNode(step, g) {
  const id = g.ids.next("CallActivity");
  const name = sanitizeElementName(step.name, "Process_Call");
  const targetId = g.processIdMap.get(step.processId);
  if (!targetId) {
    throw new Error(`processCall step "${step.name}" references processId "${step.processId}", which isn't declared in the top-level "localProcesses" array.`);
  }
  g.nodes.set(id, {
    x: 0, y: 0, w: 100, h: 80,
    render: (incoming, outgoing) => (
      `<bpmn2:callActivity id="${id}" name="${attrEscape(name)}">` +
      `<bpmn2:extensionElements>` +
      ifl("processId", targetId) +
      ifl("componentVersion", "1.0") +
      ifl("activityType", "ProcessCallElement") +
      ifl("cmdVariantUri", "ctype::FlowstepVariant/cname::NonLoopingProcess/version::1.0.4") +
      ifl("subActivityType", "NonLoopingProcess") +
      `</bpmn2:extensionElements>` +
      incoming.map((i) => `<bpmn2:incoming>${i}</bpmn2:incoming>`).join("") +
      outgoing.map((o) => `<bpmn2:outgoing>${o}</bpmn2:outgoing>`).join("") +
      `</bpmn2:callActivity>`
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

// --- Confirmed 2026-08-16 against AI_Agent_Reference_IFlow (tenant "Prem Trail",
// package "prem") — see cpi-iflow-authoring-from-scratch memory for the extraction
// notes. All of these are bpmn2:callActivity, same incoming/outgoing shape as
// contentModifier/groovyScript above. ---------------------------------------

function createFilterNode(step, g) {
  const id = g.ids.next("CallActivity");
  const name = sanitizeElementName(step.name, "Filter");
  g.nodes.set(id, {
    x: 0, y: 0, w: 100, h: 80,
    render: (incoming, outgoing) => (
      `<bpmn2:callActivity id="${id}" name="${attrEscape(name)}">` +
      `<bpmn2:extensionElements>` +
      ifl("xpathType", step.xpathType || "Nodelist") +
      ifl("wrapContent", step.xpath) +
      ifl("componentVersion", "1.1") +
      ifl("activityType", "Filter") +
      ifl("cmdVariantUri", "ctype::FlowstepVariant/cname::Filter/version::1.1.0") +
      `</bpmn2:extensionElements>` +
      incoming.map((i) => `<bpmn2:incoming>${i}</bpmn2:incoming>`).join("") +
      outgoing.map((o) => `<bpmn2:outgoing>${o}</bpmn2:outgoing>`).join("") +
      `</bpmn2:callActivity>`
    ),
  });
  return id;
}

function createXmlModifierNode(step, g) {
  const id = g.ids.next("CallActivity");
  const name = sanitizeElementName(step.name, "XML_Modifier");
  g.nodes.set(id, {
    x: 0, y: 0, w: 100, h: 80,
    render: (incoming, outgoing) => (
      `<bpmn2:callActivity id="${id}" name="${attrEscape(name)}">` +
      `<bpmn2:extensionElements>` +
      ifl("removeExternalDTDs", step.removeExternalDTDs === false ? "0" : "1") +
      ifl("removeXmlDeclaration", step.removeXmlDeclaration === false ? "0" : "1") +
      ifl("componentVersion", "1.1") +
      ifl("activityType", "XmlModifier") +
      ifl("cmdVariantUri", "ctype::FlowstepVariant/cname::XmlModifier/version::1.1.0") +
      // Only "substitute" is a confirmed real value for this key — the full enum of
      // options CPI's Configure UI offers isn't independently confirmed here.
      ifl("xmlCharacterHandling", step.xmlCharacterHandling || "substitute") +
      `</bpmn2:extensionElements>` +
      incoming.map((i) => `<bpmn2:incoming>${i}</bpmn2:incoming>`).join("") +
      outgoing.map((o) => `<bpmn2:outgoing>${o}</bpmn2:outgoing>`).join("") +
      `</bpmn2:callActivity>`
    ),
  });
  return id;
}

function createWriteVariablesNode(step, g) {
  const id = g.ids.next("CallActivity");
  const name = sanitizeElementName(step.name, "Write_Variables");
  g.nodes.set(id, {
    x: 0, y: 0, w: 100, h: 80,
    render: (incoming, outgoing) => {
      // Confirmed row shape: [name, "", type, value, scope] — 5 positional cells,
      // NOT keyed like Content Modifier's propertyTable/headerTable.
      const rows = step.variables.map((v) => rowPlain([v.name, "", v.type || "constant", v.value, v.scope || "local"])).join("");
      return (
        `<bpmn2:callActivity id="${id}" name="${attrEscape(name)}">` +
        `<bpmn2:extensionElements>` +
        ifl("visibility", step.visibility || "local") +
        ifl("encrypt", step.encrypt === false ? "false" : "true") +
        ifl("expire", String(step.expireMinutes ?? 90)) +
        ifl("variable", rows) +
        ifl("componentVersion", "1.2") +
        ifl("activityType", "Variables") +
        ifl("cmdVariantUri", "ctype::FlowstepVariant/cname::Variables/version::1.2.0") +
        `</bpmn2:extensionElements>` +
        incoming.map((i) => `<bpmn2:incoming>${i}</bpmn2:incoming>`).join("") +
        outgoing.map((o) => `<bpmn2:outgoing>${o}</bpmn2:outgoing>`).join("") +
        `</bpmn2:callActivity>`
      );
    },
  });
  return id;
}

// Pair: General Splitter (XPath mode only — confirmed; other split modes like
// line/fixed-length are NOT confirmed) feeding a Gather (aggregator) downstream.
function createSplitterNode(step, g) {
  const id = g.ids.next("CallActivity");
  const name = sanitizeElementName(step.name, "Splitter");
  g.nodes.set(id, {
    x: 0, y: 0, w: 100, h: 80,
    render: (incoming, outgoing) => (
      `<bpmn2:callActivity id="${id}" name="${attrEscape(name)}">` +
      `<bpmn2:extensionElements>` +
      ifl("exprType", "XPath") +
      ifl("Streaming", step.streaming === false ? "false" : "true") +
      ifl("StopOnExecution", step.stopOnException === false ? "false" : "true") +
      ifl("SplitterThreads", String(step.threads ?? 10)) +
      ifl("splitExprValue", step.splitExpression) +
      ifl("ParallelProcessing", step.parallelProcessing === false ? "false" : "true") +
      ifl("componentVersion", "1.6") +
      ifl("activityType", "Splitter") +
      ifl("cmdVariantUri", "ctype::FlowstepVariant/cname::GeneralSplitter/version::1.6.0") +
      ifl("grouping", "") +
      ifl("splitType", "GeneralSplitter") +
      ifl("timeOut", String(step.timeoutSec ?? 300)) +
      `</bpmn2:extensionElements>` +
      incoming.map((i) => `<bpmn2:incoming>${i}</bpmn2:incoming>`).join("") +
      outgoing.map((o) => `<bpmn2:outgoing>${o}</bpmn2:outgoing>`).join("") +
      `</bpmn2:callActivity>`
    ),
  });
  return id;
}

function createGatherNode(step, g) {
  const id = g.ids.next("CallActivity");
  const name = sanitizeElementName(step.name, "Gather");
  g.nodes.set(id, {
    x: 0, y: 0, w: 100, h: 80,
    render: (incoming, outgoing) => (
      `<bpmn2:callActivity id="${id}" name="${attrEscape(name)}">` +
      `<bpmn2:extensionElements>` +
      ifl("targetXPath", step.targetXPath || "") +
      ifl("sourceXPath", step.sourceXPath || "") +
      ifl("messageType", step.messageType || "DiffXMLFormat") +
      ifl("aggregationAlgorithm", step.aggregationAlgorithm || "sap-pi-multi-mapping") +
      ifl("componentVersion", "1.2") +
      ifl("activityType", "Gather") +
      ifl("cmdVariantUri", "ctype::FlowstepVariant/cname::Gather/version::1.2.0") +
      ifl("gatherFileNames", "") +
      `</bpmn2:extensionElements>` +
      incoming.map((i) => `<bpmn2:incoming>${i}</bpmn2:incoming>`).join("") +
      outgoing.map((o) => `<bpmn2:outgoing>${o}</bpmn2:outgoing>`).join("") +
      `</bpmn2:callActivity>`
    ),
  });
  return id;
}

// Data Store CRUD — all four confirmed activityType=DBstorage, componentVersion 1.7,
// sharing storageName + visibility; each with its own operation-specific properties.
const DATASTORE_OPS = {
  dataStoreGet: { operation: "get", cname: "get" },
  dataStorePut: { operation: "put", cname: "put" },
  dataStoreSelect: { operation: "select", cname: "select" },
  dataStoreDelete: { operation: "delete", cname: "delete" },
};

function createDataStoreNode(step, g) {
  const id = g.ids.next("CallActivity");
  const { operation, cname } = DATASTORE_OPS[step.kind];
  const name = sanitizeElementName(step.name, `DataStore_${operation}`);
  g.nodes.set(id, {
    x: 0, y: 0, w: 100, h: 80,
    render: (incoming, outgoing) => {
      let opProps = "";
      if (operation === "get") {
        opProps =
          ifl("dataStoreId", "") +
          ifl("delete", step.deleteAfterRead ? "true" : "false") +
          ifl("stopOnMissingEntry", step.stopOnMissingEntry === false ? "false" : "true");
      } else if (operation === "put") {
        opProps =
          ifl("alert", String(step.alertThreshold ?? 2)) +
          ifl("encrypt", step.encrypt === false ? "false" : "true") +
          ifl("expire", String(step.expireDays ?? 30)) +
          ifl("messageId", "") +
          ifl("override", step.overrideExisting === false ? "false" : "true");
      } else if (operation === "select") {
        opProps = ifl("maxresults", String(step.maxResults ?? 9999)) + ifl("delete", step.deleteAfterRead ? "true" : "false");
      } else if (operation === "delete") {
        opProps = ifl("messageId", step.messageId || "");
      }
      return (
        `<bpmn2:callActivity id="${id}" name="${attrEscape(name)}">` +
        `<bpmn2:extensionElements>` +
        ifl("visibility", step.visibility || "global") +
        opProps +
        ifl("componentVersion", "1.7") +
        ifl("activityType", "DBstorage") +
        ifl("cmdVariantUri", `ctype::FlowstepVariant/cname::${cname}/version::1.7.1`) +
        ifl("operation", operation) +
        (operation === "put" ? ifl("includeMessageHeaders", step.includeMessageHeaders ? "true" : "false") : "") +
        ifl("storageName", step.storageName) +
        `</bpmn2:extensionElements>` +
        incoming.map((i) => `<bpmn2:incoming>${i}</bpmn2:incoming>`).join("") +
        outgoing.map((o) => `<bpmn2:outgoing>${o}</bpmn2:outgoing>`).join("") +
        `</bpmn2:callActivity>`
      );
    },
  });
  return id;
}

// Confirmed live 2026-08-16: a Local Integration Process's own chain rejects the
// normal Message End Event outright — "Local integration process does not support
// this variant of end event element" — for EVERY plain endEvent inside it (including
// ones nested in a router branch), even though the exact same variant is fine for the
// main flow. Mirrors why createNoneStartNode exists: a Local Integration Process owns
// no external message exchange, so it needs a bare None End Event instead, same as its
// bare None Start Event. `g.endEventKind` (set by buildLocalProcessGraph) makes this
// context-sensitive without threading an extra parameter through every call site —
// nested router branches inside a local process share the same `g`, so they pick this
// up automatically too.
function createEndEventNode(step, g) {
  const id = g.ids.next("EndEvent");
  const name = sanitizeElementName(step && step.name, "End");
  const bare = g.endEventKind === "none";
  g.nodes.set(id, {
    x: 0, y: 0, w: 32, h: 32,
    render: (incoming) =>
      bare
        ? `<bpmn2:endEvent id="${id}" name="${attrEscape(name)}">` +
          incoming.map((i) => `<bpmn2:incoming>${i}</bpmn2:incoming>`).join("") +
          `</bpmn2:endEvent>`
        : `<bpmn2:endEvent id="${id}" name="${attrEscape(name)}">` +
          `<bpmn2:extensionElements>` +
          ifl("cmdVariantUri", "ctype::FlowstepVariant/cname::MessageEndEvent/version::1.1.0") +
          ifl("componentVersion", "1.1") +
          `</bpmn2:extensionElements>` +
          incoming.map((i) => `<bpmn2:incoming>${i}</bpmn2:incoming>`).join("") +
          `<bpmn2:messageEventDefinition/></bpmn2:endEvent>`,
  });
  return id;
}

// --- Request-Reply / Send adapters (step -> receiver participant) ------------

// "OAuth2ClientCredentials" confirmed working 2026-08-17 against a real hand-built
// reference channel (reference_iflow_for_HTTP_Oauth_and_OData_V4_adapter) — the value
// this adapter actually needs is the SPACED display form ("OAuth2 Client Credentials",
// via authMethodValue below), not the raw enum identifier a 2026-08-14 test used
// unmapped. Basic/ClientCertificate remain unconfirmed.
const HTTP_AUTH_CONFIRMED = new Set(["None", "OAuth2ClientCredentials"]);

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
  // A bare, single {{Placeholder}} (nothing else in the string) is exempt from the
  // scheme check — this is the common "the whole URL, scheme included, is one
  // externalized parameter" pattern (e.g. a full Slack Incoming Webhook URL). The
  // scheme genuinely can't be verified at build time in that case since the address
  // string itself never contains one; it only appears once the placeholder resolves
  // at runtime. Every OTHER form (scheme embedded literally, placeholders only for
  // pieces like the host) still requires the literal "scheme://" prefix as before.
  const isBarePlaceholder = /^\{\{\s*[\w.-]+\s*\}\}$/.test(address);
  if (!isBarePlaceholder && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(address)) {
    throw new Error(`HTTP adapter address "${address}" must start with a scheme, e.g. "https://" (including when the host is a {{Placeholder}}), unless the WHOLE address is a single bare {{Placeholder}} token.`);
  }
  const qIdx = address.indexOf("?");
  const withoutQuery = qIdx === -1 ? address : address.slice(0, qIdx);
  const query = qIdx === -1 ? "" : address.slice(qIdx + 1);
  if (!HTTP_AUTH_CONFIRMED.has(adapter.authenticationMethod)) {
    g.warnings.push(
      `HTTP adapter targeting "${system}": authenticationMethod "${adapter.authenticationMethod}" is not confirmed ` +
        `working (only "None" and "OAuth2ClientCredentials" are) — verify in the web editor's Problems tab. Use ` +
        `adapter type "odata"/"odatav4" for confirmed OAuth2 auth against an OData service instead.`
    );
  }
  const props =
    ifl("httpAddressWithoutQuery", withoutQuery) +
    ifl("httpAddressQuery", query) +
    ifl("httpMethod", adapter.method || "GET") +
    ifl("authenticationMethod", authMethodValue(adapter.authenticationMethod || "None")) +
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
    // Retry parameters — confirmed real property shape 2026-08-17 from
    // reference_iflow_for_HTTP_Oauth_and_OData_V4_adapter.
    ifl("retryOnException", (adapter.retryOnException ?? true) ? "true" : "false") +
    ifl("retryOnConnectionFailure", (adapter.retryOnConnectionFailure ?? true) ? "true" : "false") +
    ifl("retryIteration", String(adapter.retryIteration ?? 3)) +
    ifl("retryInterval", String(adapter.retryInterval ?? 5)) +
    ifl("httpErrorResponseCodes", adapter.httpErrorResponseCodes ?? "500,502,501") +
    ifl("throwExceptionOnFailure", (adapter.throwExceptionOnFailure ?? true) ? "true" : "false") +
    ifl("retryOnExceptionsTable", "") +
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

// authenticationMethod is sent RAW here (no authMethodValue display-name mapping) —
// root-caused 2026-08-17: unlike the HTTP adapter, which wants the spaced display
// value ("OAuth2 Client Credentials"), OData wants the raw unspaced enum identifier
// ("OAuth2ClientCredentials") verbatim. Sending the spaced form here (as this builder
// used to) is exactly what made OAuth2ClientCredentials "confirmed BROKEN" in an
// earlier 2026-08-16 test — CPI rejected the spaced value it was actually being sent.
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

// OData V4 — a distinct adapter variant from odataMessageFlowXml (V2) above: different
// ComponentType/MessageProtocol pairing (still ComponentType HCIOData, but
// MessageProtocol "OData V4" instead of "OData V2"), a different property set
// (csrfEnabled/connectionReuse/allowChunking instead of isCSRFEnabled/
// enableBatchProcessing/enableTLSSessionReuse, resourcePathForOdatav4 instead of
// resourcePath), and — like V2 — authenticationMethod sent RAW (unspaced), same
// root-cause reasoning as odataMessageFlowXml above. Confirmed real property shape and
// values 2026-08-17 from reference_iflow_for_HTTP_Oauth_and_OData_V4_adapter
// (operation:"get" + authenticationMethod:"OAuth2ClientCredentials" specifically).
function odatav4MessageFlowXml(mfId, sourceRef, targetRef, adapter, system, g) {
  if (adapter.authenticationMethod !== "None" && !adapter.credentialName) {
    g.warnings.push(`OData V4 adapter targeting "${system}": authenticationMethod is "${adapter.authenticationMethod}" but no credentialName was given.`);
  }
  const props =
    ifl("batchEntities", "") +
    ifl("Description", "") +
    ifl("pagination", adapter.pagination ? "true" : "false") +
    ifl("odataCertAuthPrivateKeyAlias", "") +
    ifl("ComponentNS", "sap") +
    ifl("odatav4OperationExpression", "") +
    ifl("metadataAllowedURIParams", "") +
    ifl("Name", "OData") +
    ifl("TransportProtocolVersion", "1.30.1") +
    ifl("ComponentSWCVName", "external") +
    ifl("proxyPort", "") +
    ifl("enableMPLAttachments", "true") +
    ifl("csrfEnabled", (adapter.csrfEnabled ?? true) ? "true" : "false") +
    ifl("receiveTimeOut", String(adapter.timeoutSec ?? 60)) +
    ifl("connectionReuse", (adapter.connectionReuse ?? true) ? "true" : "false") +
    ifl("alias", adapter.credentialName || "") +
    ifl("MessageProtocol", "OData V4") +
    ifl("ComponentSWCVId", "1.30.1") +
    ifl("direction", "Receiver") +
    ifl("scc_location_id", "") +
    ifl("metadataAllowedHeaders", "") +
    ifl("ComponentType", "HCIOData") +
    ifl("address", adapter.address) +
    ifl("resourcePathForOdatav4", adapter.resourcePath) +
    ifl("isXSDGenerationRequired", "") +
    ifl("allowChunking", adapter.allowChunking ? "true" : "false") +
    ifl("queryOptions", adapter.queryOptions || "") +
    ifl("proxyType", "default") +
    ifl("componentVersion", "1.23") +
    ifl("proxyHost", "") +
    ifl("edmxFilePath", "") +
    ifl("system", system) +
    ifl("authenticationMethod", adapter.authenticationMethod || "None") +
    ifl("whitelistResponseHeaders", "traceparent") +
    ifl("TransportProtocol", "HTTP") +
    ifl("cmdVariantUri", "ctype::AdapterVariant/cname::sap:HCIOData/tp::HTTP/mp::OData V4/direction::Receiver/version::1.23.0") +
    ifl("fields", "") +
    ifl("whitelistRequestHeaders", "traceparent") +
    ifl("operation", adapter.operation || "get") +
    ifl("MessageProtocolVersion", "1.30.1");
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

// Confirmed live 2026-08-16 (iterated against a real tenant's own validator, not
// guessed): only valid as kind:"send" (see ADAPTER_KIND_RESTRICTION); needs
// ComponentType/TransportProtocol/MessageProtocol/proxyType/Description like every
// other adapter here (the reference template's own values for these were blank
// placeholders too, which is how they got missed originally); and CPI hard-rejects
// soapServiceName/soapWsdlPortName/operationName being set WITHOUT a soapWsdlURL
// ("Port Name or Service Name cannot be defined without a WSDL" / "Operation Name
// cannot be defined without a WSDL") — a real, confirmed requirement, not a code bug.
function soapMessageFlowXml(mfId, sourceRef, targetRef, adapter, system, g) {
  if ((adapter.soapServiceName || adapter.soapWsdlPortName || adapter.operationName) && !adapter.soapWsdlURL) {
    g.warnings.push(
      `SOAP adapter targeting "${system}": soapServiceName/soapWsdlPortName/operationName were given without a ` +
        "soapWsdlURL — CPI's validator rejects this combination outright (\"Port Name or Service Name cannot be " +
        "defined without a WSDL\"). Set soapWsdlURL, or drop the other three."
    );
  }
  const props =
    ifl("Name", "SOAP") +
    ifl("system", system) +
    ifl("Description", "") +
    ifl("address", adapter.address) +
    ifl("soapWsdlURL", adapter.soapWsdlURL || "") +
    ifl("soapServiceName", adapter.soapServiceName || "") +
    ifl("soapWsdlPortName", adapter.soapWsdlPortName || "") +
    ifl("operationName", adapter.operationName || "") +
    ifl("credentialName", adapter.credentialName || "") +
    ifl("proxyType", "default") +
    // Confirmed missing 2026-08-16: EVERY other adapter builder in this file sets
    // ComponentType/TransportProtocol/MessageProtocol — this one didn't, because the
    // reference template's own values for them were blank placeholders too, easy to
    // miss. Values here follow the cmdVariantUri's own tp::HTTP/mp::Plain SOAP,
    // matching the pattern every confirmed-working adapter builder already follows.
    ifl("ComponentType", "SOAP") +
    ifl("TransportProtocol", "HTTP") +
    ifl("MessageProtocol", "Plain SOAP") +
    ifl("direction", "Receiver") +
    ifl("ComponentNS", "sap") +
    ifl("componentVersion", "1.10") +
    ifl("TransportProtocolVersion", "1.10.3") +
    ifl("MessageProtocolVersion", "1.10.3") +
    ifl("ComponentSWCVName", "external") +
    ifl("ComponentSWCVId", "1.10.3") +
    ifl("cmdVariantUri", "ctype::AdapterVariant/cname::sap:SOAP/tp::HTTP/mp::Plain SOAP/direction::Receiver/version::1.10.3");
  return `<bpmn2:messageFlow id="${mfId}" name="SOAP" sourceRef="${sourceRef}" targetRef="${targetRef}"><bpmn2:extensionElements>${props}</bpmn2:extensionElements></bpmn2:messageFlow>`;
}

// Confirmed 2026-08-16 from AI_Agent_Reference_IFlow with REAL (non-blank) values —
// the simplest adapter to configure: internal iFlow-to-iFlow call, no HTTP exposure.
function processDirectMessageFlowXml(mfId, sourceRef, targetRef, adapter, system) {
  const props =
    ifl("ComponentType", "ProcessDirect") +
    ifl("Description", "") +
    ifl("address", adapter.address) +
    ifl("ComponentNS", "sap") +
    ifl("Vendor", "SAP") +
    ifl("componentVersion", "1.1") +
    ifl("Name", "ProcessDirect") +
    ifl("TransportProtocolVersion", "1.1.2") +
    ifl("ComponentSWCVName", "external") +
    ifl("system", system) +
    ifl("TransportProtocol", "Not Applicable") +
    ifl("cmdVariantUri", "ctype::AdapterVariant/cname::ProcessDirect/vendor::SAP/tp::Not Applicable/mp::Not Applicable/direction::Receiver/version::1.1.1") +
    ifl("MessageProtocol", "Not Applicable") +
    ifl("MessageProtocolVersion", "1.1.2") +
    ifl("ComponentSWCVId", "1.1.2") +
    ifl("direction", "Receiver");
  return `<bpmn2:messageFlow id="${mfId}" name="ProcessDirect" sourceRef="${sourceRef}" targetRef="${targetRef}"><bpmn2:extensionElements>${props}</bpmn2:extensionElements></bpmn2:messageFlow>`;
}

const SEND_ADAPTER_BUILDERS = {
  http: httpMessageFlowXml,
  mail: mailMessageFlowXml,
  odata: odataMessageFlowXml,
  odatav4: odatav4MessageFlowXml,
  sftpWrite: sftpWriteMessageFlowXml,
  jms: jmsMessageFlowXml,
  soap: soapMessageFlowXml,
  processDirect: processDirectMessageFlowXml,
};

// Each adapter type here is only valid under ONE of "send"/"requestReply" — CPI's own
// web editor only offers each adapter under the activityType it actually supports
// (Send = fire-and-forget/ExternalCall = request-reply), and using the wrong one fails
// ValidateIntegrationDesigntimeArtifact with "<name> is not supported for the adapter"
// (no other detail). sftpWrite and soap are BOTH send-only — confirmed live 2026-08-16
// for soap specifically (a first attempt used requestReply, going purely on a
// misreading of which ServiceTask AI_Agent_Reference_IFlow's SOAP messageFlow was
// actually paired with; the live validator error corrected that). processDirect is
// the mirror case — requestReply-only, confirmed live the same day.
const ADAPTER_KIND_RESTRICTION = { sftpWrite: "send", soap: "send", processDirect: "requestReply" };

function createServiceTaskNode(step, g) {
  const id = g.ids.next("ServiceTask");
  const requiredKind = ADAPTER_KIND_RESTRICTION[step.adapter.type];
  if (requiredKind && requiredKind !== step.kind) {
    throw new Error(
      `Adapter type "${step.adapter.type}" is only valid as kind:"${requiredKind}" (confirmed live) — step "${step.name}" used kind:"${step.kind}".`
    );
  }
  const name = sanitizeElementName(step.name, step.kind === "send" ? "Send" : "Request_Reply");
  const activityType = step.kind === "send" ? "Send" : "ExternalCall";
  const cmdVariantUri =
    step.kind === "send"
      ? "ctype::FlowstepVariant/cname::Send/version::1.0.4"
      : "ctype::FlowstepVariant/cname::ExternalCall/version::1.0.4";

  const suffix = { http: "Endpoint", mail: "Mail_Server", odata: "OData_Service", odatav4: "OData_V4_Service", sftpWrite: "Sftp_Server", jms: "Queue", soap: "Soap_Service", processDirect: "Process" }[step.adapter.type] || "Endpoint";
  // Confirmed live 2026-08-16 from a hand-built reference flow (WeatherForecastMailIFlow,
  // edited directly in the SAP web editor): a requestReply/send step's own receiver
  // participant sits ABOVE the pool (negative y relative to it), never "below" — "below"
  // placed it inside the same y-range the pool box occupies once the pool grows to
  // include the Exception Subprocess, so the participant visibly overlapped the pool
  // rectangle. "above" keeps it structurally outside the pool's y-range no matter how
  // tall the pool grows downward.
  const { participantId, system } = mkParticipant(g, `${name}_${suffix}`, "receiver", id, "above");

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
    case "sftpStart": return createSftpStartNode(step, g);
    case "contentModifier": return createContentModifierNode(step, g);
    case "groovyScript": return createGroovyNode(step, g);
    case "requestReply":
    case "send": return createServiceTaskNode(step, g);
    case "pollEnrich": return createPollEnrichNode(step, g);
    case "filter": return createFilterNode(step, g);
    case "xmlModifier": return createXmlModifierNode(step, g);
    case "writeVariables": return createWriteVariablesNode(step, g);
    case "splitter": return createSplitterNode(step, g);
    case "gather": return createGatherNode(step, g);
    case "dataStoreGet":
    case "dataStorePut":
    case "dataStoreSelect":
    case "dataStoreDelete": return createDataStoreNode(step, g);
    case "processCall": return createProcessCallNode(step, g);
    case "endEvent": return createEndEventNode(step, g);
    case "router": return createGatewayNode(step, g);
    default:
      throw new Error(`Step kind "${step.kind}" is not supported yet. Supported kinds: ${SUPPORTED_KINDS.join(", ")}.`);
  }
}

// --- Graph walking (structure only — no positions) ---------------------------

// `endFactory` is the node creator used for an auto-inserted terminal end (when the
// caller's steps don't already end in `endEvent`) — defaults to the normal Message End
// Event. renderExceptionSubprocess (below) passes createErrorEndEventNode instead when
// an Exception Subprocess should terminate in a plain Error End Event rather than a
// Message End Event.
function emitChain(steps, g, incoming, endFactory = createEndEventNode) {
  let current = { sourceId: incoming.sourceId };
  let pendingFirstFlow = incoming.firstFlow || null;

  if (steps.length === 0) {
    const endId = endFactory({ name: "End" }, g);
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
    const endId = endFactory({ name: "End" }, g);
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

/**
 * Build a FlowGraph from the validated top-level spec ({ steps, ... }). `sharedIds`/
 * `processIdMap` are optional — omit them for a plain single-process build (existing
 * callers/tests keep working unchanged); assembleIflow (below) passes both through so
 * ids stay unique and processCall steps resolve across the whole multi-process build.
 */
export function buildFlowGraph(spec, sharedIds, processIdMap) {
  const g = new FlowGraph(sharedIds, processIdMap);
  if (!spec.steps.length || !START_KINDS.includes(spec.steps[0].kind)) {
    throw new Error(`The first step must be one of: ${START_KINDS.join(", ")}.`);
  }
  const startId = createNode(spec.steps[0], g);
  emitChain(spec.steps.slice(1), g, { sourceId: startId });
  return g;
}

/**
 * Build a FlowGraph for a Local Integration Process's own chain — entered via a bare
 * None Start Event (see createNoneStartNode) rather than one of START_KINDS, since
 * it's invoked by a processCall step, not an external trigger. `steps` should NOT
 * include a start-kind step itself (emitChain's existing guard rejects one anyway).
 */
export function buildLocalProcessGraph(steps, sharedIds, processIdMap) {
  const g = new FlowGraph(sharedIds, processIdMap);
  g.endEventKind = "none"; // see createEndEventNode's header comment
  const startId = createNoneStartNode(g);
  emitChain(steps, g, { sourceId: startId });
  return g;
}

// Step kinds that need their own collaboration participant/adapter — confirmed NOT
// safe to use inside an Exception Subprocess (see renderExceptionSubprocess): only the
// subprocess's own STRUCTURAL content (start/end/steps/sequenceFlows) is confirmed —
// whether/how a subprocess-nested adapter's participant+messageFlow should be
// diagrammed isn't, so this is refused outright rather than silently producing
// orphaned/broken output.
const SUBPROCESS_UNSAFE_KINDS = new Set(["timer", "httpsStart", "sftpStart", "requestReply", "send", "pollEnrich"]);
function assertSubprocessSafeSteps(steps, context) {
  for (const s of steps || []) {
    if (SUBPROCESS_UNSAFE_KINDS.has(s.kind)) {
      throw new Error(
        `${context}: step kind "${s.kind}" needs its own collaboration participant/adapter, which isn't supported ` +
          "inside an Exception Subprocess (diagram-shape handling for a subprocess-nested adapter isn't confirmed " +
          "here). Use contentModifier/groovyScript/filter/writeVariables/dataStore*/processCall/etc. for error-" +
          "handling logic instead."
      );
    }
    if (s.kind === "router") {
      for (const b of s.branches || []) assertSubprocessSafeSteps(b.steps, context);
    }
  }
}

/**
 * Render a standalone Exception Subprocess (global error handling) — confirmed real
 * structure (StartErrorEvent -> ... -> EndErrorEvent or MessageEndEvent) from
 * AI_Agent_Reference_IFlow (2026-08-16), which shows BOTH terminal shapes occurring
 * live in the same tenant. `endKind: "message"` uses the normal Message End Event
 * (matches this generator's plain endEvent step); `endKind: "error"` uses the
 * dedicated Error End Event instead. `origin` positions this subprocess's own diagram
 * shapes on the shared canvas — assembleIflow gives each one a distinct, non-
 * overlapping area, same as it does for each Local Integration Process.
 *
 * Runs the SAME real ELK layout pass as the main process/every Local Integration
 * Process (via renderFlowGraph) and emits a real BPMNShape for the subProcess box
 * itself PLUS one for every child. An earlier version of this function skipped all of
 * that for its internal nodes as an unconfirmed simplification — confirmed live
 * 2026-08-16 to be the actual cause of "Error while loading the details of the
 * integration flow" in the web editor even though ValidateIntegrationDesigntimeArtifact
 * passed clean: a <bpmn2:subProcess> with real children but zero diagram shapes for
 * any of them (not even itself) breaks the design-time editor's diagram loader outright,
 * a failure class the OData validation endpoint apparently never checks for.
 */
export async function renderExceptionSubprocess(name, handlingSteps, endKind, sharedIds, processIdMap, origin) {
  const label = name || "Exception_Subprocess";
  assertSubprocessSafeSteps(handlingSteps, `Exception Subprocess "${label}"`);
  const g = new FlowGraph(sharedIds, processIdMap);
  const startId = createErrorStartEventNode(g);
  const endFactory = endKind === "message" ? createEndEventNode : createErrorEndEventNode;
  emitChain(handlingSteps || [], g, { sourceId: startId }, endFactory);

  const rendered = await renderFlowGraph(g, origin);

  const subProcessId = sharedIds.next("SubProcess");
  const xml =
    `<bpmn2:subProcess id="${subProcessId}" name="${attrEscape(sanitizeElementName(label, "Exception_Subprocess"))}">` +
    `<bpmn2:extensionElements>` +
    ifl("componentVersion", "1.1") +
    ifl("activityType", "ErrorEventSubProcessTemplate") +
    ifl("cmdVariantUri", "ctype::FlowstepVariant/cname::ErrorEventSubProcessTemplate/version::1.1.0") +
    `</bpmn2:extensionElements>` +
    rendered.processInner +
    `</bpmn2:subProcess>`;

  // The subProcess's own box, sized to contain everything ELK just laid out inside it
  // (same "resize to fit content" approach packageFiles.js already uses for the main
  // Integration Process pool).
  const subProcessShape = shape(subProcessId, origin.x, origin.y, rendered.pool.width, rendered.pool.height);

  return {
    xml,
    subProcessId,
    scripts: rendered.scripts,
    warnings: rendered.warnings,
    collaborationExtra: rendered.collaborationExtra, // empty in practice — assertSubprocessSafeSteps refuses any adapter step that would populate this
    diagramInner: subProcessShape + rendered.diagramInner,
    pool: rendered.pool,
    // Confirmed live 2026-08-16 (produced NaN coordinates in a real flow's diagram):
    // this field was missing entirely, so every `sub.stackingHeight` read in
    // assembleIflow silently evaluated to undefined -> NaN once added to offsetY,
    // poisoning the y-coordinate of everything stacked after this subprocess. An
    // Exception Subprocess never contains adapter-needing steps (assertSubprocessSafeSteps
    // guarantees no participants inside it), so this always equals `rendered.pool.height`
    // in practice, but it's forwarded for real rather than assumed.
    stackingHeight: rendered.stackingHeight,
  };
}

/**
 * Render an Exception Subprocess horizontally CENTERED under its owning pool's content
 * — confirmed live 2026-08-16 from a hand-built reference (WeatherForecastMailIFlow):
 * the subprocess's own center-x exactly equals the main pool's center-x, and it sits at
 * the pool's bottom edge. `renderExceptionSubprocess` itself doesn't know the pool's
 * final width up front (Local Integration Processes/the main pool don't know their own
 * final width until the subprocess — which can itself be wider — is rendered), so this
 * does a first throwaway render purely to learn the subprocess's natural width, then
 * (if centering actually shifts it) a second real render at the corrected x. The first
 * pass's ids are simply discarded/skipped in the shared counters — harmless, since
 * uniqueness (not contiguity) is all that's required of them.
 */
async function renderCenteredExceptionSubprocess(excSpec, poolWidthSoFar, sharedIds, processIdMap, y) {
  const endKind = excSpec.endKind || "message";
  const probe = await renderExceptionSubprocess(excSpec.name, excSpec.steps, endKind, sharedIds, processIdMap, { x: POOL_X, y });
  const poolWidth = Math.max(poolWidthSoFar, probe.pool.width);
  const centeredX = POOL_X + (poolWidth - probe.pool.width) / 2;
  if (centeredX === POOL_X) return { sub: probe, poolWidth };
  const sub = await renderExceptionSubprocess(excSpec.name, excSpec.steps, endKind, sharedIds, processIdMap, { x: centeredX, y });
  return { sub, poolWidth };
}

/**
 * Render the finished graph into the three XML fragments an .iflw needs. Runs the
 * ELK layout pass first (process nodes + sequenceFlows only — participants are
 * deliberately NOT part of the ELK graph, so they can never end up positioned
 * inside the pool; see the per-participant "side" resolution below instead), then
 * generates BPMN2/diagram XML from the resulting coordinates.
 *
 * `origin` defaults to the confirmed main-pool position (POOL_X/POOL_Y) — assembleIflow
 * (below) passes a shifted origin for each Local Integration Process instead, stacking
 * them vertically below the main pool so their diagram shapes never overlap.
 */
export async function renderFlowGraph(g, origin = { x: POOL_X, y: POOL_Y }) {
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
    node.x = origin.x + c.x;
    node.y = origin.y + c.y;
  }
  const pool = { width: result.width, height: result.height };
  const elkEdgeById = new Map((result.edges || []).map((e) => [e.id, e]));

  // Now that every process node has a real x/y, resolve each participant's position
  // relative to its anchor node and the (now fully-grown) pool.
  for (const p of g.participants.values()) {
    const anchor = g.nodes.get(p.anchorNodeId);
    if (p.side === "left") {
      p.x = origin.x - PARTICIPANT_WIDTH - 50;
      p.y = anchor.y + anchor.h / 2 - p.h / 2;
    } else if (p.side === "below") {
      p.x = anchor.x + anchor.w / 2 - p.w / 2;
      p.y = origin.y + pool.height + PARTICIPANT_MARGIN;
    } else if (p.side === "above") {
      p.x = anchor.x + anchor.w / 2 - p.w / 2;
      // No Math.max(0, ...) clamp here (removed 2026-08-16): clamping to 0 defeats the
      // whole point of "above" whenever origin.y - p.h - MARGIN goes negative (the
      // common case, since origin.y is usually only ~60) — it pulled the participant
      // back down into the pool's own y-range, overlapping its top edge. Confirmed from
      // a real hand-built reference (WeatherForecastMailIFlow) that negative y is a
      // perfectly valid, correctly-rendering coordinate in this diagram's canvas.
      p.y = origin.y - p.h - PARTICIPANT_MARGIN;
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
      edgeXmls.push(edgeFromElk(f.id, elkEdge, origin.x, origin.y));
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

  // Confirmed live bug (2026-08-16): a "below"-positioned adapter participant (any
  // requestReply/send/pollEnrich step) and the main flow's own Exception Subprocess
  // are BOTH anchored to this graph's own bottom edge independently — via
  // PARTICIPANT_MARGIN and LOCAL_PROCESS_GAP respectively — with neither aware of the
  // other, so they can genuinely overlap in the rendered diagram whenever a flow has
  // both (a very common combination, since Exception Subprocess is on by default).
  // `stackingHeight` is DELIBERATELY separate from `pool.height`: the main/local
  // process's own participant box must stay sized to just its OWN chain's content
  // (confirmed from a real hand-built reference — SAP does not expand that box to
  // reach external adapter participants), but whatever the CALLER stacks next
  // (assembleIflow's Exception Subprocess / next Local Integration Process) needs to
  // clear whichever extends further down: the plain content, or a "below" participant.
  let stackingHeight = pool.height;
  for (const p of g.participants.values()) {
    if (p.side === "below") {
      stackingHeight = Math.max(stackingHeight, p.y - origin.y + p.h);
    }
  }

  return {
    processInner: nodeXmls.join("") + flowXmls.join(""),
    collaborationExtra: participantXmls.join("") + messageFlowXmls.join(""),
    diagramInner: shapeXmls.join("") + edgeXmls.join(""),
    scripts: g.scripts,
    warnings: g.warnings,
    pool,
    stackingHeight,
  };
}

// Normalize a caller-supplied exceptionSubprocess field to either `false` (explicit
// opt-out) or a plain config object — handles both a zod-validated call (where
// `.default({})` already guarantees an object) and a raw call (e.g. tests) where the
// field might be genuinely undefined.
function normalizeExceptionSubprocessSpec(raw) {
  if (raw === false) return false;
  return raw || {};
}

/**
 * Full orchestration: builds + renders the main flow, its (default-ON) Exception
 * Subprocess, and every declared Local Integration Process (each with its OWN
 * default-ON Exception Subprocess) — wiring processCall steps to the real generated
 * process ids regardless of which chain references which. This is the one entry
 * point domains/iflowBuilder.js calls; buildFlowGraph/renderFlowGraph individually are
 * still exported for simpler single-process use (and for this module's own reuse).
 *
 * Exception Subprocess defaults: ALWAYS Error Start Event -> ... -> Message End Event
 * (endKind:"message") for BOTH the main flow and every Local Integration Process — a
 * deliberate, always-on convention (per user guidance 2026-08-16), not conditional on
 * process type. endKind:"error" (Error End Event) is still supported and confirmed
 * real (AI_Agent_Reference_IFlow shows both terminal shapes occurring live), but is
 * opt-in only — callers can still override endKind explicitly if they want it.
 */
export async function assembleIflow(spec) {
  const sharedIds = new IdGen();
  const processIdMap = new Map();
  for (const lp of spec.localProcesses || []) {
    if (processIdMap.has(lp.id)) throw new Error(`Duplicate localProcesses id "${lp.id}".`);
    // Confirmed live bug (2026-08-16): using the generic "Process" id prefix here
    // collides with the shell's OWN main process — a real tenant-created shell's main
    // <bpmn2:process> is itself id="Process_1" (SAP's own default), so the first
    // Local Integration Process built here would ALSO be "Process_1", giving the
    // document two elements with the same id. CPI's validator surfaces this as
    // "Parent process cannot be assigned to the Process Call" on every processCall
    // step targeting it (it can't tell the local process apart from the one calling
    // it). A distinct prefix sidesteps the whole collision class rather than trying
    // to detect/avoid the shell's specific id.
    processIdMap.set(lp.id, sharedIds.next("LocalProcess"));
  }

  const warnings = [];
  const scripts = {};

  // Single running cursor stacking EVERY diagrammed block (main pool, main's own
  // Exception Subprocess, each Local Integration Process, each of ITS Exception
  // Subprocess) vertically down the shared canvas so none ever overlap — same
  // approach already used for participants ("below"/"above") and Local Integration
  // Processes, just generalized to cover Exception Subprocess boxes too now that
  // they're real diagrammed elements instead of shape-less ones.
  let offsetY = POOL_Y;

  // --- Main flow ---------------------------------------------------------------
  const mainGraph = buildFlowGraph(spec, sharedIds, processIdMap);
  const mainRendered = await renderFlowGraph(mainGraph);
  warnings.push(...mainRendered.warnings);
  Object.assign(scripts, mainRendered.scripts);

  let processInner = mainRendered.processInner;
  let collaborationExtra = mainRendered.collaborationExtra;
  let diagramInner = mainRendered.diagramInner;
  let mainPoolWidth = mainRendered.pool.width;
  // Two DELIBERATELY separate measures from here on, confirmed both necessary
  // 2026-08-16 (found by rendering a flow with both a "below" adapter participant
  // AND the default-on Exception Subprocess, then checking every shape pair for
  // overlap — see steps.js's renderFlowGraph `stackingHeight` comment for the root
  // cause): `mainPoolContentHeight` sizes the shell's OWN "Integration Process"
  // participant box (must include the Exception Subprocess, confirmed correct
  // 2026-08-16 — but must NOT include adapter participants, confirmed from a real
  // hand-built reference — they're separate sibling boxes, never absorbed into any
  // process's own pool). `offsetY` is the STACKING cursor for where the NEXT sibling
  // block goes — it must clear whichever is deepest (plain content or a "below"
  // participant), so it advances by `stackingHeight`, not just `pool.height`.
  let mainPoolContentHeight = mainRendered.pool.height;
  offsetY += mainRendered.stackingHeight + LOCAL_PROCESS_GAP;

  const mainExc = normalizeExceptionSubprocessSpec(spec.exceptionSubprocess);
  if (mainExc !== false) {
    const { sub, poolWidth } = await renderCenteredExceptionSubprocess(mainExc, mainPoolWidth, sharedIds, processIdMap, offsetY);
    processInner += sub.xml;
    warnings.push(...sub.warnings);
    Object.assign(scripts, sub.scripts);
    collaborationExtra += sub.collaborationExtra;
    diagramInner += sub.diagramInner;
    mainPoolWidth = poolWidth;
    mainPoolContentHeight += LOCAL_PROCESS_GAP + sub.pool.height;
    offsetY += sub.stackingHeight + LOCAL_PROCESS_GAP;
  }
  const mainPool = { width: mainPoolWidth, height: mainPoolContentHeight };

  // --- Local Integration Processes ---------------------------------------------
  const extraProcessesXml = [];
  const PARTICIPANT_BOX_PAD = 20;

  for (const lp of spec.localProcesses || []) {
    const realId = processIdMap.get(lp.id);
    const blockStartY = offsetY;
    const lpGraph = buildLocalProcessGraph(lp.steps, sharedIds, processIdMap);
    const lpRendered = await renderFlowGraph(lpGraph, { x: POOL_X, y: offsetY });
    warnings.push(...lpRendered.warnings);
    Object.assign(scripts, lpRendered.scripts);
    collaborationExtra += lpRendered.collaborationExtra; // e.g. a requestReply/send step's own adapter participant
    diagramInner += lpRendered.diagramInner;
    // Same split as the main pool above: `blockContentHeight` sizes this local
    // process's OWN participant box (content + its own Exception Subprocess only,
    // never inflated by adapter participants); `offsetY` is the stacking cursor for
    // the NEXT sibling block and must clear a "below" participant if present.
    let blockContentHeight = lpRendered.pool.height;
    offsetY += lpRendered.stackingHeight + LOCAL_PROCESS_GAP;
    let blockWidth = lpRendered.pool.width;

    let lpInner = lpRendered.processInner;
    const lpExc = normalizeExceptionSubprocessSpec(lp.exceptionSubprocess);
    if (lpExc !== false) {
      const { sub, poolWidth } = await renderCenteredExceptionSubprocess(lpExc, blockWidth, sharedIds, processIdMap, offsetY);
      lpInner += sub.xml;
      warnings.push(...sub.warnings);
      Object.assign(scripts, sub.scripts);
      collaborationExtra += sub.collaborationExtra;
      diagramInner += sub.diagramInner;
      blockWidth = poolWidth;
      blockContentHeight += LOCAL_PROCESS_GAP + sub.pool.height;
      offsetY += sub.stackingHeight + LOCAL_PROCESS_GAP;
    }
    const blockEndY = blockStartY + blockContentHeight;

    // Confirmed real (2026-08-16, from a hand-built test flow inspected directly in
    // this tenant): a Local Integration Process needs its OWN participant in the
    // collaboration — ifl:type="IntegrationProcess", processRef pointing to it, empty
    // extensionElements — plus a matching BPMNShape. Without this, the process is
    // structurally valid BPMN2 but has no visual "box" of its own on the shared
    // canvas, which is confirmed to break the web editor's own loader entirely
    // ("Error while loading the details of the integration flow") even though
    // ValidateIntegrationDesigntimeArtifact itself passes clean — that OData
    // validation endpoint doesn't check for a missing participant/shape either.
    const participantId = `Participant_${realId}`;
    collaborationExtra += `<bpmn2:participant id="${participantId}" ifl:type="IntegrationProcess" name="${attrEscape(lp.name || lp.id)}" processRef="${realId}"><bpmn2:extensionElements/></bpmn2:participant>`;
    diagramInner += shape(
      participantId,
      POOL_X - PARTICIPANT_BOX_PAD,
      blockStartY - PARTICIPANT_BOX_PAD,
      blockWidth + PARTICIPANT_BOX_PAD * 2,
      blockEndY - blockStartY + PARTICIPANT_BOX_PAD * 2
    );

    // Confirmed real extensionElements for a Local Integration Process (2026-08-16,
    // AI_Agent_Reference_IFlow): transactionTimeout/processType/cmdVariantUri/
    // transactionalHandling, at their observed default values.
    extraProcessesXml.push(
      `<bpmn2:process id="${realId}" name="${attrEscape(lp.name || lp.id)}">` +
        `<bpmn2:extensionElements>` +
        ifl("transactionTimeout", "30") +
        ifl("processType", "directCall") +
        ifl("componentVersion", "1.1") +
        ifl("cmdVariantUri", "ctype::FlowElementVariant/cname::LocalIntegrationProcess/version::1.1.3") +
        ifl("transactionalHandling", "From Calling Process") +
        `</bpmn2:extensionElements>` +
        lpInner +
        `</bpmn2:process>`
    );
  }

  return {
    processInner,
    collaborationExtra,
    diagramInner,
    extraProcessesXml,
    scripts,
    warnings,
    pool: mainPool,
  };
}
