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

export function buildTimerScheduleKey(cronFields, timezone = "Etc/GMT") {
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
    ["throwExceptionOnExpiry", "true"],
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
