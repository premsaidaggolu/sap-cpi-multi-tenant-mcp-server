// Low-level XML/text helpers for hand-authoring SAP CPI .iflw (BPMN2 + ifl:) content.
//
// Every rule encoded here was learned by trial and error against a live tenant
// (see the "integration-flow-creation" skill / the cpi-iflow-authoring-from-scratch
// memory this module supersedes) — not guessed from SAP documentation, which doesn't
// publish this schema. Keep it that way: don't "clean up" an escaping quirk below
// without re-confirming against a real deploy, several of these look like bugs but
// are exactly what a working exported iFlow contains.

/**
 * Standard XML **text-content** escaping — only &, <, > need it. Quotes are
 * deliberately left alone: real CPI-generated row-XML blobs (propertyTable,
 * scheduleKey, etc.) embed things like `<cell id='Action'>` with literal,
 * unescaped single quotes even once the whole blob is itself escaped into a
 * <value> element. Escaping quotes here would silently produce content that
 * no longer matches a confirmed-working export.
 */
export function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escaping for use inside a double-quoted XML **attribute** value. */
export function attrEscape(value) {
  return xmlEscape(value).replace(/"/g, "&quot;");
}

/**
 * Map this codebase's camelCase authenticationMethod enum values (used across the
 * zod schema for http/odata adapters) toward CPI's actual `authenticationMethod`
 * ifl:property value. STATUS 2026-08-16: NOT a confirmed fix, still an open problem.
 * The raw enum identifier "OAuth2ClientCredentials" fails ValidateIntegrationDesign
 * timeArtifact with "Invalid value 'OAuth2 Client Credentials' entered in
 * 'Authentication' field" — this was first misread as the error message revealing
 * the correct value, so this mapping was added to space it out; re-tested live and
 * the SAME error persists verbatim with the spaced value too. So neither
 * "OAuth2ClientCredentials" nor "OAuth2 Client Credentials" is the value CPI's
 * odata/HCIOData adapter actually wants for OAuth2 Client Credentials auth — the
 * error text apparently just echoes back whatever was submitted rather than naming
 * the expected one. Left in place since it's harmless (both single-word values pass
 * through unchanged, and "ClientCertificate" is still untested either way), but do
 * NOT treat OAuth2ClientCredentials as working for odata — use authenticationMethod:
 * "None" (or "Basic", untested) until the real expected value is confirmed some
 * other way (e.g. inspecting a hand-built OAuth2-configured channel in the web editor).
 */
const AUTH_METHOD_DISPLAY_VALUES = {
  ClientCertificate: "Client Certificate",
  OAuth2ClientCredentials: "OAuth2 Client Credentials",
};
export function authMethodValue(method) {
  return AUTH_METHOD_DISPLAY_VALUES[method] || method;
}

/**
 * CPI's "row-XML" mini-format, used for scheduleKey / propertyTable / headerTable /
 * attachments. Builds the *raw* inner text (real `<row>`/`<cell>` characters) — the
 * caller wraps it in an ifl:property <value> element, which runs it through
 * xmlEscape exactly once. That single pass is what turns `<row>` into `&lt;row&gt;`
 * in the confirmed examples.
 */
export function rowPlain(cells) {
  return `<row>${cells.map((c) => `<cell>${xmlEscape(c)}</cell>`).join("")}</row>`;
}

/** Keyed-cell row variant (propertyTable/headerTable): cells is [[id, value], ...]. */
export function rowKeyed(cells) {
  return `<row>${cells.map(([id, v]) => `<cell id='${id}'>${xmlEscape(v)}</cell>`).join("")}</row>`;
}

/**
 * Build a flat <ifl:property><key>K</key><value>V</value></ifl:property>, escaping V
 * exactly once. Used both for plain scalar values AND for a rowPlain/rowKeyed row-XML
 * blob — a row-XML blob has already had its *cell contents* escaped once by
 * rowPlain/rowKeyed, so this single additional pass is what turns its literal
 * `<row>`/`<cell>` characters into the confirmed `&lt;row&gt;&lt;cell&gt;...` form.
 */
export function ifl(key, value) {
  return `<ifl:property><key>${xmlEscape(key)}</key><value>${xmlEscape(value ?? "")}</value></ifl:property>`;
}

/**
 * Package/artifact technical Id rule (confirmed): no underscores or other special
 * characters — `Automation_krisiyer` is rejected with "Property 'Id' value cannot
 * have a special character". Keep the human-readable original as the display Name
 * instead; only the Id needs this treatment.
 */
export function sanitizeTechnicalId(raw) {
  const cleaned = String(raw || "").replace(/[^A-Za-z0-9]/g, "");
  if (!cleaned) throw new Error(`Id "${raw}" has no alphanumeric characters left after sanitizing.`);
  return cleaned;
}

/**
 * BPMN element / participant name rule: real exports use underscores in place of
 * spaces (`Every_6_Hours`, `Set_Threshold`), and participant names in particular
 * are confirmed to reject whitespace outright ("Whitespace not allowed in Receiver
 * name"). Apply the same normalization everywhere for consistency — it's never
 * wrong even where it isn't strictly required.
 */
export function sanitizeElementName(raw, fallback) {
  const s = String(raw ?? "").trim();
  const base = s || fallback || "Step";
  return base.replace(/\s+/g, "_").replace(/[^\w-]/g, "");
}

/**
 * Camel Simple condition auto-fixes (both are confirmed real deploy-time bugs):
 *  1. Equality is a single `=`, not `==` — `==` fails with a real, specific
 *     "Token '==' not supported" validation error.
 *  2. The right-hand side of a comparison must be quoted even when it's a number
 *     or a {{placeholder}} — an unquoted numeric/placeholder RHS fails the web
 *     editor's Problems-tab validation ("Invalid format of condition expression
 *     value"), even though Camel still does numeric coercion on the quoted value
 *     at runtime for >/< comparisons.
 */
export function normalizeCondition(expr) {
  if (!expr) return expr;
  let out = String(expr).replace(/([^=!<>])==([^=])/g, "$1=$2");
  // Quote an unquoted RHS after a comparison operator: ${...} OP <bare token>
  out = out.replace(
    /(=|!=|>=|<=|>|<|contains|not|in|regex)(\s*)([^\s'"][^\s]*)\s*$/,
    (m, op, sp, rhs) => (rhs.startsWith("'") || rhs.startsWith('"') ? m : `${op}${sp}'${rhs}'`)
  );
  return out;
}

/**
 * Sequential, per-element-type id generator matching the naming convention seen in
 * real exports (StartEvent_1, CallActivity_2, SequenceFlow_3, ...). Uniqueness
 * within a flow is all that matters to CPI — the numbering doesn't need to match
 * any particular scheme — but per-type counters keep generated XML readable.
 */
export class IdGen {
  constructor() {
    this.counters = new Map();
  }
  next(prefix) {
    const n = (this.counters.get(prefix) || 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${n}`;
  }
}

/** Find every {{ParamName}} placeholder used across a blob of generated XML/text. */
export function findPlaceholders(text) {
  const found = new Set();
  const re = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(text))) found.add(m[1]);
  return found;
}

// --- Lightweight, dependency-free XML well-formedness check -----------------
// Added 2026-08-16 after hitting real generated-content bugs this catches for free:
// a base64-relay corruption that merged two properties into one malformed tag (a
// dropped "key>" leaving a stray "<" in a <value> text node), and a duplicate element
// `id` across two <bpmn2:process> siblings (well-formed XML, but breaks CPI — a
// Process Call step can't tell its target apart from its own parent process). No npm
// XML parser is available here (no network to install one — see this file's own
// header and steps.js's layout.js comment on the same constraint), so this is a
// hand-rolled, best-effort scanner: a stack-based tag matcher plus an `id`-attribute
// tracker, NOT a spec-compliant parser (no DTD/general-entity resolution, no
// namespace validation). It's enough to catch the failure classes actually observed,
// which is the bar that matters here — run this on every generated fragment BEFORE
// it's ever spliced into a shell or pushed to a tenant.

const XML_TOKEN_RE =
  /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>/g;

/**
 * Validate one self-contained XML fragment (must itself be well-nested — e.g. one
 * <bpmn2:process>...</bpmn2:process>, or a flat sequence of complete sibling
 * elements like this generator's `processInner`/`diagramInner`). `seenIds` is an
 * optional shared Map (id -> "label:tagName" of first sighting) so duplicate-id
 * detection can span multiple fragments that will end up in the same document —
 * pass the same Map across calls for processInner/collaborationExtra/diagramInner/
 * each extraProcessesXml entry to catch cross-fragment collisions.
 */
export function validateXmlFragment(xml, label = "fragment", seenIds = new Map()) {
  const errors = [];
  const stack = [];
  let lastIndex = 0;
  let match;
  XML_TOKEN_RE.lastIndex = 0;
  while ((match = XML_TOKEN_RE.exec(xml))) {
    const between = xml.slice(lastIndex, match.index);
    const strayLt = between.indexOf("<");
    if (strayLt !== -1) {
      errors.push(
        `${label}: unescaped "<" in text content at offset ${lastIndex + strayLt} — not part of any recognized ` +
          `tag/comment/CDATA (the classic signature of a dropped "key>"/"value>" merging two properties into one).`
      );
    }
    lastIndex = XML_TOKEN_RE.lastIndex;

    const full = match[0];
    if (full.startsWith("<!--") || full.startsWith("<?") || full.startsWith("<![CDATA[")) continue;
    const [, closingSlash, tagName, attrs, selfClosingSlash] = match;

    if (closingSlash) {
      const top = stack.pop();
      if (!top || top.name !== tagName) {
        errors.push(`${label}: mismatched closing tag </${tagName}> at offset ${match.index} — expected </${top ? top.name : "(nothing open)"}>.`);
        if (top) stack.push(top); // keep scanning for further errors instead of bailing out
      }
    } else {
      const idMatch = attrs.match(/\bid\s*=\s*"([^"]*)"|\bid\s*=\s*'([^']*)'/);
      const id = idMatch ? idMatch[1] ?? idMatch[2] : null;
      if (id) {
        const sighting = `${label}:${tagName}`;
        if (seenIds.has(id)) {
          errors.push(
            `Duplicate element id "${id}" — first seen as ${seenIds.get(id)}, again as ${sighting} at offset ${match.index}. ` +
              `Two elements sharing an id is well-formed XML but breaks CPI (e.g. a Process Call can't tell its ` +
              `target apart from its own parent process).`
          );
        } else {
          seenIds.set(id, sighting);
        }
      }
      if (!selfClosingSlash) stack.push({ name: tagName, at: match.index });
    }
  }
  const trailing = xml.slice(lastIndex);
  if (trailing.indexOf("<") !== -1) {
    errors.push(`${label}: unescaped "<" in trailing text content after the last recognized tag.`);
  }
  for (const unclosed of stack) {
    errors.push(`${label}: unclosed tag <${unclosed.name}> opened at offset ${unclosed.at}.`);
  }
  return errors;
}

/**
 * Validate everything assembleIflow (steps.js) produces, sharing one `seenIds` map
 * across all fragments so a duplicate id between (say) the main process and a Local
 * Integration Process is caught even though each fragment is well-formed on its own.
 */
export function validateAssembledIflow(rendered) {
  const seenIds = new Map();
  const errors = [
    ...validateXmlFragment(rendered.processInner, "processInner", seenIds),
    ...validateXmlFragment(rendered.collaborationExtra, "collaborationExtra", seenIds),
    ...validateXmlFragment(rendered.diagramInner, "diagramInner", seenIds),
    ...(rendered.extraProcessesXml || []).flatMap((xml, i) => validateXmlFragment(xml, `extraProcessesXml[${i}]`, seenIds)),
  ];
  return { valid: errors.length === 0, errors };
}

/**
 * Confirmed exact shape of the Timer Start Event's `scheduleKey` blob (cron mode
 * only — the only trigger mode confirmed here). `cronFields` is the 7 CPI cron
 * fields in order: [second, minute, hour, day_of_month, month, dayOfWeek, year].
 * Only the "Etc/GMT" timezone display label is confirmed; anything else falls back
 * to a best-effort label and a warning, since actual scheduling is driven by the
 * `trigger.timeZone=` suffix on schedule1, not this display string.
 */
const KNOWN_TZ_LABELS = {
  "Etc/GMT": "( UTC 0:00 ) Greenwich Mean Time(Etc/GMT)",
  UTC: "( UTC 0:00 ) Greenwich Mean Time(Etc/GMT)",
};

export function buildTimerScheduleKey(cronFields, timezone = "Etc/GMT", throwExceptionOnExpiry = true) {
  if (!Array.isArray(cronFields) || cronFields.length !== 7) {
    throw new Error(
      "Timer cron needs exactly 7 fields: second minute hour day_of_month month dayOfWeek year " +
        '(e.g. "0 0 0/6 ? * * *" for every 6 hours).'
    );
  }
  const warnings = [];
  const tzLabel = KNOWN_TZ_LABELS[timezone];
  if (!tzLabel) {
    warnings.push(
      `Timer timezone "${timezone}" has no confirmed display label (only "Etc/GMT"/"UTC" are confirmed) — ` +
        `the schedule will still run against "trigger.timeZone=${timezone}", but verify the Configure UI's ` +
        `timezone dropdown shows the right zone in the web editor.`
    );
  }
  const [second, minute, hour, dayOfMonth, month, dayOfWeek, year] = cronFields;
  // Plain "&" here, not a pre-escaped "&amp;": rowPlain (cell-level escape) and the
  // outer ifl:property <value> wrap (steps.js) both run xmlEscape once each, so a
  // single literal "&" naturally becomes the confirmed "&amp;amp;" after both passes.
  const schedule1 = `${cronFields.join("+")}&trigger.timeZone=${timezone}`;
  const rows = [
    ["dateType", "ADVANCED"],
    ["hourValue", "0"],
    ["minutesValue", "0"],
    ["timeType", "ON_TIME"],
    ["timeZone", tzLabel || `(${timezone})`],
    ["throwExceptionOnExpiry", throwExceptionOnExpiry ? "true" : "false"],
    ["second", second],
    ["minute", minute],
    ["hour", hour],
    ["day_of_month", dayOfMonth],
    ["month", month],
    ["dayOfWeek", dayOfWeek],
    ["year", year],
    ["startAt", ""],
    ["endAt", ""],
    [
      "attributeBehaviour",
      "isThrowExceptionOnExpiryVisible,isScheduleAdvancedVisible,isScheduleAdvancedStartEndVisible,isScheduleSimpleVisible",
    ],
    ["triggerType", "cron"],
    ["noOfSchedules", "1"],
    ["schedule1", schedule1],
  ];
  const value = rows.map(([k, v]) => rowPlain([k, v])).join("");
  return { value, warnings };
}
