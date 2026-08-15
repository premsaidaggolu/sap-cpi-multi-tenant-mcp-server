// parameters.prop/propdef generation, splicing generated flow content into a real
// tenant-downloaded shell .iflw, and a best-effort offline fallback shell for when
// no tenant is reachable. See xml.js's header for the "confirmed, not guessed"
// ground rule this whole package follows.
import { xmlEscape } from "./xml.js";

// --- parameters.prop / parameters.propdef -----------------------------------

function escapePropKey(key) {
  return String(key)
    .replace(/\\/g, "\\\\")
    .replace(/[:=]/g, "\\$&")
    .replace(/ /g, "\\ ");
}
function escapePropValue(value) {
  return String(value).replace(/\\/g, "\\\\");
}

/**
 * Merge the caller's declared parameters with any {{Placeholder}} names actually
 * used in the generated content but never declared — auto-adding the latter (as an
 * optional string, empty default) rather than failing keeps the tool usable when a
 * step's free-typed placeholder was forgotten in `parameters`, at the cost of a
 * warning telling the caller to fill in a real default before production use.
 */
export function buildParametersFiles(declaredParams, usedPlaceholders) {
  const warnings = [];
  const byName = new Map();
  for (const p of declaredParams || []) byName.set(p.name, p);
  for (const name of usedPlaceholders) {
    if (!byName.has(name)) {
      byName.set(name, {
        name,
        type: "xsd:string",
        defaultValue: "",
        required: false,
        description: `Auto-added: referenced via {{${name}}} but not declared in "parameters".`,
      });
      warnings.push(
        `Parameter "${name}" is used as {{${name}}} but wasn't declared — auto-added as an optional ` +
          `string with an empty default. Set a real default (or declare it explicitly) before relying on this flow.`
      );
    }
  }
  const params = [...byName.values()];

  const prop = params.map((p) => `${escapePropKey(p.name)}=${escapePropValue(p.defaultValue ?? "")}`).join("\n") + (params.length ? "\n" : "");

  const parameterXmls = params
    .map(
      (p) =>
        `<parameter><key/><name>${xmlEscape(p.name)}</name><type>${xmlEscape(p.type || "xsd:string")}</type>` +
        `<isRequired>${p.required ? "true" : "false"}</isRequired><constraint/>` +
        `<description>${xmlEscape(p.description || "")}</description><additionalMetadata/></parameter>`
    )
    .join("");
  const propdef = `<?xml version="1.0" encoding="UTF-8" standalone="no"?><parameters>${parameterXmls}<param_references/></parameters>`;

  return { prop, propdef, warnings, params };
}

// --- Splicing generated content into a real shell's .iflw -------------------

/**
 * Replace only the parts of a real (tenant-downloaded) shell .iflw that our
 * confirmed step templates cover, keeping everything else — root namespaces, the
 * collaboration's own extensionElements, the process's own extensionElements, the
 * "Integration Process" participant + its pool shape (resized to fit whatever got
 * generated), the process/collaboration ids — exactly as the tenant generated
 * them. This is deliberately surgical rather than a full rewrite: those kept parts
 * aren't part of the confirmed schema (their exact property list isn't documented
 * anywhere), so inheriting a real working copy beats guessing them.
 *
 * Confirmed live (2026-08-14) by diffing a pristine untouched default shell against
 * our own generated output: dropping the process's own <bpmn2:extensionElements>
 * (its cmdVariantUri/componentVersion/transactionTimeout/transactionalHandling) is
 * enough on its own to make an otherwise well-formed, buildable, deployable,
 * RUNNING flow fail to open in the web editor ("Error while loading the details of
 * the integration flow") — the runtime engine tolerates its absence; the
 * design-time editor's parser apparently doesn't. Keep it from here on.
 *
 * The shell's default Sender/Receiver participants are DELIBERATELY NOT kept —
 * confirmed (per direct SAP CPI usage) they're only ever needed when something is
 * actually connected to them via a messageFlow (which none of our supported step
 * kinds wire up to the generic defaults — httpsStart/requestReply/send/pollEnrich
 * each generate and keep their OWN dedicated participant instead). Keeping unused
 * ones was tried and DID open correctly, but they're pure clutter with no
 * connection to anything, so they're dropped again now that the actual fix
 * (the process extensionElements) is isolated.
 */
export function injectFlowContent(shellIflwText, rendered) {
  let text = shellIflwText;

  const processMatch = text.match(/<bpmn2:process\b([^>]*)>([\s\S]*?)<\/bpmn2:process>/);
  if (!processMatch) throw new Error("Shell .iflw has no <bpmn2:process>...</bpmn2:process> — unexpected shape; can't inject content.");
  const processExtMatch = processMatch[2].match(/<bpmn2:extensionElements>[\s\S]*?<\/bpmn2:extensionElements>/);
  const processExt = processExtMatch ? processExtMatch[0] : "";
  text = text.replace(processMatch[0], `<bpmn2:process${processMatch[1]}>${processExt}${rendered.processInner}</bpmn2:process>`);

  const collabMatch = text.match(/<bpmn2:collaboration\b([^>]*)>([\s\S]*?)<\/bpmn2:collaboration>/);
  if (!collabMatch) throw new Error("Shell .iflw has no <bpmn2:collaboration>...</bpmn2:collaboration> — unexpected shape; can't inject content.");
  const { collabInner: newCollabInner, processParticipantId } = spliceCollaboration(collabMatch[2], rendered.collaborationExtra);
  text = text.replace(collabMatch[0], `<bpmn2:collaboration${collabMatch[1]}>${newCollabInner}</bpmn2:collaboration>`);

  const planeMatch = text.match(/<bpmndi:BPMNPlane\b([^>]*)>([\s\S]*?)<\/bpmndi:BPMNPlane>/);
  if (!planeMatch) throw new Error("Shell .iflw has no <bpmndi:BPMNPlane>...</bpmndi:BPMNPlane> — unexpected shape; can't inject a diagram.");
  const poolShapes = extractShapesFor(planeMatch[2], [processParticipantId]).map((s) =>
    rendered.pool ? resizeShape(s, rendered.pool.width, rendered.pool.height) : s
  );
  text = text.replace(planeMatch[0], `<bpmndi:BPMNPlane${planeMatch[1]}>${poolShapes.join("")}${rendered.diagramInner}</bpmndi:BPMNPlane>`);

  return text;
}

/**
 * Keep the collaboration's own extensionElements and ONLY the "Integration
 * Process" participant from the shell (see the header note above on why the
 * default Sender/Receiver are dropped). Returns that participant's id too, so the
 * diagram splice above knows which original shape is the pool to keep (resized).
 */
function spliceCollaboration(oldInner, extraXml) {
  const extMatch = oldInner.match(/<bpmn2:extensionElements>[\s\S]*?<\/bpmn2:extensionElements>/);
  const ext = extMatch ? extMatch[0] : "";
  const participantMatches = oldInner.match(/<bpmn2:participant\b[^>]*\/>|<bpmn2:participant\b[^>]*>[\s\S]*?<\/bpmn2:participant>/g) || [];
  const processParticipant = participantMatches.find((p) => /processRef="/.test(p));
  if (!processParticipant) {
    throw new Error(
      "Could not find the 'Integration Process' participant (a <bpmn2:participant processRef=\"...\"/>) in the " +
        "shell's collaboration — the shell may not be a standard empty flow created by create_integration_flow."
    );
  }
  const processParticipantId = (processParticipant.match(/\bid="([^"]+)"/) || [])[1];
  return { collabInner: ext + processParticipant + extraXml, processParticipantId };
}

/** Pull the shell's original diagram shapes for exactly the given participant ids. */
function extractShapesFor(oldPlaneInner, participantIds) {
  const idSet = new Set(participantIds.filter(Boolean));
  const shapeMatches = oldPlaneInner.match(/<bpmndi:BPMNShape\b[^>]*\/>|<bpmndi:BPMNShape\b[^>]*>[\s\S]*?<\/bpmndi:BPMNShape>/g) || [];
  return shapeMatches.filter((s) => idSet.has((s.match(/bpmnElement="([^"]+)"/) || [])[1]));
}

/** Overwrite a <dc:Bounds>'s width/height attributes in place, wherever they fall in the tag. */
function resizeShape(shapeXml, width, height) {
  return shapeXml.replace(/<dc:Bounds\b[^>]*\/>/, (tag) =>
    tag.replace(/\bheight="[^"]*"/, `height="${height}"`).replace(/\bwidth="[^"]*"/, `width="${width}"`)
  );
}

// --- Offline fallback (no tenant reachable) ----------------------------------
// Best-effort only: the collaboration/manifest boilerplate below is a reasonable,
// standard BPMN2/ifl skeleton but — unlike the online path, which inherits a real
// tenant-generated shell — it has NOT been confirmed against a live deploy. Treat
// its output as a starting point to import/verify in the web editor, not as
// deploy-ready as-is.

export function buildOfflineShellIflw(processId, processName, collaborationId) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<bpmn2:definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ifl="http:///com.sap.ifl.model/Ifl.xsd" ` +
    `xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" ` +
    `xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" ` +
    `id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">` +
    `<bpmn2:collaboration id="${collaborationId}" name="Default_Collaboration">` +
    `<bpmn2:participant id="Participant_Process_1" ifl:type="EndpointRecevier" name="${processName}" processRef="${processId}"/>` +
    `</bpmn2:collaboration>` +
    `<bpmn2:process id="${processId}" name="${processName}"></bpmn2:process>` +
    `<bpmndi:BPMNDiagram id="BPMNDiagram_1"><bpmndi:BPMNPlane bpmnElement="${collaborationId}" id="BPMNPlane_1"></bpmndi:BPMNPlane></bpmndi:BPMNDiagram>` +
    `</bpmn2:definitions>`
  );
}

export function offlineProjectXml(id) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<projectDescription><name>${id}</name><comment></comment>` +
    `<projects></projects><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments></arguments></buildCommand></buildSpec>` +
    `<natures><nature>org.eclipse.jdt.core.javanature</nature><nature>com.sap.ide.ifl.project.support.project.nature</nature>` +
    `<nature>com.sap.ide.ifl.bsn</nature></natures></projectDescription>`
  );
}

export function offlineManifest(id) {
  // SAP-RuntimeProfile: 'iflmap', not 'integrationcell' — deliberately, even though
  // this value is otherwise unconfirmed either way for an offline-authored zip (SAP
  // doesn't document whether the web editor's Import even honors this line, or just
  // reassigns the profile based on where you import). The reasoning: every offline
  // zip this tool produces exists specifically to be hand-imported into a shell the
  // caller created themselves in the web UI — which is only ever 'iflmap' — precisely
  // BECAUSE build_integration_flow's hard block (see iflowBuilder.js) refuses to push
  // timer/groovyScript/http content onto a fresh 'integrationcell' shell. Shipping
  // 'integrationcell' here would contradict the exact workflow this file exists for.
  return (
    `Manifest-Version: 1.0\r\nBundle-ManifestVersion: 2\r\nBundle-Name: ${id}\r\n` +
    `Bundle-SymbolicName: ${id}; singleton:=true\r\nBundle-Version: 1.0.0\r\n` +
    `SAP-BundleType: IntegrationFlow\r\nSAP-NodeType: IFLMAP\r\nSAP-RuntimeProfile: iflmap\r\n`
  );
}
