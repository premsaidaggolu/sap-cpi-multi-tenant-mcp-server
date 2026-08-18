// SAP Cloud Integration (CPI) OData client.
// Handles OAuth2 client-credentials token retrieval (with caching) and
// authenticated requests against the CPI OData v1 API (/api/v1).
import { currentTenant } from "./tenantScope.js";
import { getSecret as getCredStoreSecret } from "./credStore.js";

// Every outbound fetch() in this file passes this as its `signal`. Node's fetch has no
// default timeout — a stalled network hop (VPN drop, tenant unreachable, proxy hang)
// would otherwise hang the awaiting call indefinitely, which from the MCP client's side
// looks exactly like a crashed/unresponsive server (confirmed: this is what surfaced a
// real hang report against build_integration_flow). CPI_REQUEST_TIMEOUT_MS overrides it.
const REQUEST_TIMEOUT_MS = Number(process.env.CPI_REQUEST_TIMEOUT_MS) || 45_000;
function requestTimeoutSignal() {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

// --- Tenant registry ---------------------------------------------------------
// Multi-tenant config: CPI_BASE_URL<N> / CPI_TOKEN_URL<N> / CPI_CLIENT_ID<N> /
// CPI_CLIENT_SECRET<N> (+ optional TENANT_NAME<N>, ALLOW_WRITE<N>, STATUS<N>) for as
// many numeric suffixes as are present in the environment — add a 3rd/4th/Nth tenant
// by adding a new numbered group of vars, no code change. Falls back to the legacy
// unsuffixed vars (a single implicit tenant, no `tenant` tool argument needed at all)
// when no numbered tenant is found, so existing single-tenant deployments/.env files
// keep working unchanged.
//
// Built once and cached: like the rest of this server, picking up a new tenant added
// to the environment needs a restart (same as any other env var change).
let tenantRegistry = null;

/** STATUS<N> is opt-in: unset/anything-but-"disable(d)" means enabled. */
function isDisabledStatus(raw) {
  return /^disabled?$/i.test(String(raw || "").trim());
}

function buildTenantRegistry() {
  const suffixes = new Set();
  const re = /^CPI_BASE_URL(\d+)$/;
  for (const key of Object.keys(process.env)) {
    const m = key.match(re);
    if (m) suffixes.add(m[1]);
  }

  const list = [];
  const incomplete = [];
  const disabled = [];
  for (const n of [...suffixes].sort((a, b) => Number(a) - Number(b))) {
    const name = process.env[`TENANT_NAME${n}`] || `tenant${n}`;

    // STATUS<N>=disable(d) keeps the credentials in the file but takes the tenant
    // out of rotation entirely — not selectable, not counted towards multi-tenant
    // mode, and never resolved even if a caller somehow names it.
    if (isDisabledStatus(process.env[`STATUS${n}`])) {
      disabled.push(`tenant #${n} (${name})`);
      continue;
    }

    const baseUrl = process.env[`CPI_BASE_URL${n}`];
    const tokenUrl = process.env[`CPI_TOKEN_URL${n}`];
    const clientId = process.env[`CPI_CLIENT_ID${n}`];
    const clientSecret = process.env[`CPI_CLIENT_SECRET${n}`];
    // CPI_CREDSTORE_KEY<N> is an alternative to CPI_CLIENT_SECRET<N>, not an addition —
    // when set, the secret is resolved from Credential Store (see credStore.js) at
    // token-request time instead of read from this plaintext env var. Per-tenant, so a
    // deployment can migrate one tenant at a time rather than all-or-nothing.
    const credStoreKey = process.env[`CPI_CREDSTORE_KEY${n}`];
    const credStoreNamespace = process.env[`CPI_CREDSTORE_NAMESPACE${n}`];
    const need = { CPI_BASE_URL: baseUrl, CPI_TOKEN_URL: tokenUrl, CPI_CLIENT_ID: clientId };
    const gaps = Object.entries(need).filter(([, v]) => !v).map(([k]) => `${k}${n}`);
    if (!clientSecret && !credStoreKey) {
      gaps.push(`CPI_CLIENT_SECRET${n} (or CPI_CREDSTORE_KEY${n})`);
    }
    if (gaps.length) {
      incomplete.push(`tenant #${n} (${name}) is missing ${gaps.join(", ")}`);
      continue;
    }
    const allowWriteRaw = process.env[`ALLOW_WRITE${n}`];
    list.push({
      id: n,
      name,
      baseUrl,
      tokenUrl,
      clientId,
      clientSecret,
      credStoreKey,
      credStoreNamespace,
      // Per-tenant override of the global ALLOW_WRITE flag — leave unset to inherit it
      // (e.g. a Dev tenant can allow writes while Prod stays read-only under one flag).
      allowWrite: allowWriteRaw !== undefined ? String(allowWriteRaw).toLowerCase() === "true" : undefined,
    });
  }

  if (incomplete.length) {
    console.warn(`[cpiClient] Skipping incomplete tenant config — ${incomplete.join("; ")}`);
  }
  if (disabled.length) {
    // console.error, not console.log: on the stdio transport, stdout is reserved for
    // JSON-RPC frames — anything else written there breaks the client's parser.
    console.error(`[cpiClient] Skipping disabled tenant(s) — ${disabled.join(", ")}`);
  }

  // No numbered tenant found at all — legacy single-tenant mode off the plain vars.
  let legacy = null;
  if (list.length === 0 && process.env.CPI_BASE_URL) {
    legacy = {
      id: null,
      name: process.env.TENANT_NAME || "default",
      baseUrl: process.env.CPI_BASE_URL,
      tokenUrl: process.env.CPI_TOKEN_URL,
      clientId: process.env.CPI_CLIENT_ID,
      clientSecret: process.env.CPI_CLIENT_SECRET,
      credStoreKey: process.env.CPI_CREDSTORE_KEY,
      credStoreNamespace: process.env.CPI_CREDSTORE_NAMESPACE,
      allowWrite: undefined,
    };
  }

  const byName = new Map();
  for (const t of list) byName.set(t.name.toLowerCase(), t);

  return { list, byName, legacy };
}

function getTenantRegistry() {
  if (!tenantRegistry) tenantRegistry = buildTenantRegistry();
  return tenantRegistry;
}

/** Tenant names available for the `tenant` tool argument (empty in single/legacy mode). */
export function listTenantNames() {
  return getTenantRegistry().list.map((t) => t.name);
}

/** True once 2+ numbered tenants are configured — the point at which callers must pick one. */
export function isMultiTenant() {
  return getTenantRegistry().list.length > 1;
}

/**
 * Resolve a tenant by name (case-insensitive) to a registry entry for use with
 * tenantScope.runWithTenant. In legacy/single-tenant setups `name` is ignored/optional.
 * Throws (listing the valid names) on an unknown name so the caller — typically the AI
 * client relaying a tool error — gets something actionable back.
 */
export function resolveTenant(name) {
  const reg = getTenantRegistry();
  if (reg.list.length === 0) return reg.legacy; // legacy single-tenant mode (or unconfigured)
  if (reg.list.length === 1 && !name) return reg.list[0]; // one tenant configured -> default to it
  const key = String(name || "").toLowerCase();
  const found = reg.byName.get(key);
  if (!found) {
    const known = reg.list.map((t) => t.name).join(", ");
    throw new Error(
      `Unknown or missing tenant "${name || ""}". Configured tenants: ${known || "(none)"}. ` +
        `Call list_cpi_tenants to see the current list.`
    );
  }
  return found;
}

/** Cache key for the per-tenant token/CSRF caches below. */
function tenantCacheKey() {
  const t = currentTenant();
  return t ? t.name : "__default__";
}

// Read configuration from the active tenant (see tenantScope.js), which
// domains/helpers.js populates from the caller's `tenant` argument before any
// cpiGet/cpiRequest/cpiInvoke call runs. Falls back to the plain env vars when no
// tenant context is active at all (shouldn't happen via the tool layer, but keeps the
// original "missing environment variables" error intact for a totally unconfigured server).
function config() {
  const t = currentTenant();
  if (t) {
    return {
      CPI_BASE_URL: t.baseUrl,
      CPI_TOKEN_URL: t.tokenUrl,
      CPI_CLIENT_ID: t.clientId,
      CPI_CLIENT_SECRET: t.clientSecret,
      CPI_CREDSTORE_KEY: t.credStoreKey,
      CPI_CREDSTORE_NAMESPACE: t.credStoreNamespace,
    };
  }
  return {
    CPI_BASE_URL: process.env.CPI_BASE_URL,
    CPI_TOKEN_URL: process.env.CPI_TOKEN_URL,
    CPI_CLIENT_ID: process.env.CPI_CLIENT_ID,
    CPI_CLIENT_SECRET: process.env.CPI_CLIENT_SECRET,
    CPI_CREDSTORE_KEY: process.env.CPI_CREDSTORE_KEY,
    CPI_CREDSTORE_NAMESPACE: process.env.CPI_CREDSTORE_NAMESPACE,
  };
}

function assertConfig() {
  const cfg = config();
  // CPI_CLIENT_SECRET and CPI_CREDSTORE_KEY are alternatives — either one satisfies the
  // "how do we authenticate to CPI" requirement, so they're checked as a pair, not
  // individually, unlike the other three which are always required outright.
  const missing = ["CPI_BASE_URL", "CPI_TOKEN_URL", "CPI_CLIENT_ID"].filter((k) => !cfg[k]);
  if (!cfg.CPI_CLIENT_SECRET && !cfg.CPI_CREDSTORE_KEY) {
    missing.push("CPI_CLIENT_SECRET (or CPI_CREDSTORE_KEY)");
  }
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        `Copy .env.example and fill in your CPI service-key values (CPI_BASE_URL1/2/... for ` +
        `multiple tenants, or the plain CPI_BASE_URL for a single one).`
    );
  }
}

/**
 * Resolve the active tenant's CPI OAuth client secret — either the plaintext
 * CPI_CLIENT_SECRET env var, or (if configured) a Credential Store lookup keyed by
 * CPI_CREDSTORE_KEY. Only called from getAccessToken, right before it's needed, so a
 * Credential Store round trip happens at most once per tenant per CACHE_TTL_MS
 * (see credStore.js), not on every cpiGet/cpiRequest call.
 */
async function resolveClientSecret() {
  const cfg = config();
  if (cfg.CPI_CLIENT_SECRET) return cfg.CPI_CLIENT_SECRET;
  if (cfg.CPI_CREDSTORE_KEY) return getCredStoreSecret(cfg.CPI_CREDSTORE_KEY, cfg.CPI_CREDSTORE_NAMESPACE);
  // assertConfig() (called before this in getAccessToken) should make this unreachable.
  throw new Error("No CPI client secret available (checked CPI_CLIENT_SECRET and CPI_CREDSTORE_KEY).");
}

// --- Host masking ------------------------------------------------------------
// Tool results (and error messages) must never expose a real CPI tenant hostname to
// callers. Masks EVERY configured tenant's hosts, not just the one active for the
// current call — belt-and-suspenders so a result assembled from mixed context (or a
// bug) still can't leak a hostname for a *different* tenant than the one it names.
function maskTargets() {
  const targets = [];
  const add = (raw, placeholder) => {
    if (!raw) return;
    try {
      const { host } = new URL(raw);
      if (host) targets.push({ host, placeholder });
    } catch {
      // Not a valid URL — nothing to mask.
    }
  };
  const reg = getTenantRegistry();
  const tenants = reg.list.length ? reg.list : reg.legacy ? [reg.legacy] : [];
  for (const t of tenants) {
    add(t.baseUrl, "<cpi-tenant-host>");
    add(t.tokenUrl, "<cpi-auth-host>");
  }
  // Longest host first so overlapping hostnames don't get partially replaced.
  return targets.sort((a, b) => b.host.length - a.host.length);
}

/** Replace any configured CPI hostname found in a string with a generic placeholder. */
export function maskString(value) {
  if (typeof value !== "string" || !value) return value;
  let out = value;
  for (const { host, placeholder } of maskTargets()) {
    if (out.includes(host)) out = out.split(host).join(placeholder);
  }
  return out;
}

/** Recursively apply maskString to every string in an object/array. */
export function maskDeep(value) {
  if (typeof value === "string") return maskString(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v);
    return out;
  }
  return value;
}

// --- Token cache -----------------------------------------------------------
// Keyed by tenant name — a shared single slot would let tenant B's request reuse a
// token minted for tenant A's client credentials, which is a cross-tenant leak, not
// just a cache bug.
const tokenCacheByTenant = new Map(); // name -> { token, expiry }

async function getAccessToken() {
  assertConfig();
  const { CPI_TOKEN_URL, CPI_CLIENT_ID } = config();
  const key = tenantCacheKey();
  const now = Date.now();
  // Reuse token until 60s before expiry.
  const cached = tokenCacheByTenant.get(key);
  if (cached && now < cached.expiry - 60_000) {
    return cached.token;
  }

  const clientSecret = await resolveClientSecret();
  const basic = Buffer.from(`${CPI_CLIENT_ID}:${clientSecret}`).toString("base64");
  const res = await fetch(CPI_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: requestTimeoutSignal(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OAuth token request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const expiresInSec = Number(data.expires_in) || 3600;
  tokenCacheByTenant.set(key, { token: data.access_token, expiry: now + expiresInSec * 1000 });
  return data.access_token;
}

// --- Core request helper ---------------------------------------------------
/**
 * Perform an authenticated GET against a CPI OData path.
 * @param {string} path  Path relative to CPI_BASE_URL, e.g. "/MessageProcessingLogs"
 * @param {Object} [query]  Key/value query params (OData system query options).
 * @param {Object} [opts]
 * @param {boolean} [opts.raw]  If true, return the raw text body (used for textual $value
 *   endpoints like ErrorInformation — NOT safe for binary content, see opts.binary).
 * @param {boolean} [opts.binary]  If true, return the raw response body as a Buffer (used for
 *   binary $value endpoints, e.g. downloading an integration flow's zip). Reading binary content
 *   via res.text() corrupts it: any byte sequence that isn't valid UTF-8 gets irreversibly
 *   replaced (U+FFFD), so it must be read via res.arrayBuffer() instead.
 */
export async function cpiGet(path, query = {}, opts = {}) {
  const token = await getAccessToken();
  const { CPI_BASE_URL } = config();

  // Cosmetic system query options that some CPI entity sets don't support.
  // If the API complains about one, we drop it and retry (filter is NOT dropped,
  // since removing it would silently change the result set).
  const effectiveQuery = { ...query };
  let useFormat = !opts.raw && !opts.binary && query.$format === undefined;

  const doFetch = () => {
    const url = new URL(`${CPI_BASE_URL}${path}`);
    if (useFormat) url.searchParams.set("$format", "json");
    for (const [k, v] of Object.entries(effectiveQuery)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    return fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: opts.binary
          ? "application/octet-stream, */*"
          : opts.raw
            ? "text/plain, */*"
            : "application/json",
      },
      signal: requestTimeoutSignal(),
    });
  };

  const DROPPABLE = ["$top", "$skip", "$select", "$orderby", "$expand", "$inlinecount"];
  let res = await doFetch();
  for (let i = 0; i < 6 && !res.ok && (res.status === 400 || res.status === 501); i++) {
    const peek = await res.clone().text().catch(() => "");
    // $format=json is purely a serialization hint (the Accept: application/json header
    // already asks for the same thing) — dropping it can't change query semantics, so
    // try that first on any 400/501, regardless of the error text. Some CPI entities
    // (media-link entries like IntegrationDesigntimeArtifacts) 501 on $format=json for
    // single-entity GETs with an unrelated-looking error message ("No message reference
    // given...") instead of a clean "format not supported" one, so the text-based check
    // below never catches it.
    if (useFormat) {
      useFormat = false;
      res = await doFetch();
      continue;
    }
    if (!/not supported|not implemented/i.test(peek)) break;
    const offending = DROPPABLE.find(
      (opt) => effectiveQuery[opt] !== undefined && new RegExp(`\\$?${opt.slice(1)}\\b`, "i").test(peek)
    );
    if (!offending) break;
    delete effectiveQuery[offending];
    res = await doFetch();
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CPI API GET ${path} failed (${res.status}): ${text.slice(0, 2000)}`);
  }

  // Binary content (e.g. a zipped integration flow) must be read as bytes, never as text —
  // res.text() assumes/decodes UTF-8 and silently corrupts any byte sequence that isn't valid
  // UTF-8, which most compressed/binary data isn't.
  if (opts.binary) return Buffer.from(await res.arrayBuffer());

  if (opts.raw) return res.text();

  const data = await res.json();
  // OData v2 wraps collections in { d: { results: [...] } } and entities in { d: {...} }.
  if (data && data.d !== undefined) {
    return data.d.results !== undefined ? data.d.results : data.d;
  }
  return data;
}

// --- Write guard -----------------------------------------------------------
/**
 * Throw unless writes are allowed for the active tenant. Called by every
 * create/update/delete/deploy tool. A tenant-specific ALLOW_WRITE<N> (see the tenant
 * registry above) overrides the global ALLOW_WRITE for that one tenant — e.g. a Dev
 * tenant can allow writes while Prod stays read-only under the same server.
 */
export function assertWriteAllowed() {
  const t = currentTenant();
  const allowed =
    t && t.allowWrite !== undefined
      ? t.allowWrite
      : String(process.env.ALLOW_WRITE).toLowerCase() === "true";
  if (!allowed) {
    throw new Error(
      `Write operations are disabled${t ? ` for tenant "${t.name}"` : ""}. Set ALLOW_WRITE=true ` +
        `(or ALLOW_WRITE${t && t.id ? t.id : ""}=true for just this tenant) and restart the server ` +
        `to enable deploy / create / update / delete tools.`
    );
  }
}

// --- CSRF token cache ------------------------------------------------------
// CPI requires an X-CSRF-Token (fetched via a GET) plus its session cookie for
// any modifying request (POST/PUT/DELETE and most function imports). Keyed by tenant
// name for the same reason as the token cache above — tenant A's session cookie must
// never be sent on a request meant for tenant B.
const csrfCacheByTenant = new Map(); // name -> { token, cookies, at }

async function getCsrf(token, force = false) {
  const key = tenantCacheKey();
  const now = Date.now();
  const cached = csrfCacheByTenant.get(key);
  if (!force && cached && now - cached.at < 15 * 60 * 1000) {
    return cached;
  }
  const { CPI_BASE_URL } = config();
  const res = await fetch(`${CPI_BASE_URL}/`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-CSRF-Token": "Fetch",
      Accept: "application/json",
    },
    signal: requestTimeoutSignal(),
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const entry = {
    token: res.headers.get("x-csrf-token"),
    cookies: setCookies.map((c) => c.split(";")[0]).join("; "),
    at: now,
  };
  csrfCacheByTenant.set(key, entry);
  return entry;
}

// --- Modifying request helper (POST/PUT/DELETE) ----------------------------
/**
 * Perform an authenticated modifying request against the CPI OData API.
 * Handles CSRF token + cookie, with a single automatic retry on 403 (stale token).
 * @param {"POST"|"PUT"|"DELETE"|"MERGE"|"GET"} method
 * @param {string} path  Path relative to CPI_BASE_URL, e.g. "/IntegrationPackages"
 * @param {Object} [opts]
 * @param {Object} [opts.query]  Query params (values used verbatim — pre-quote OData literals).
 * @param {Object|string} [opts.body]  Request body (object is JSON-stringified).
 * @param {string} [opts.contentType]
 * @param {boolean} [opts.raw]  Return raw text instead of parsed JSON.
 */
export async function cpiRequest(method, path, opts = {}) {
  const { query = {}, body, contentType = "application/json", raw = false } = opts;
  const token = await getAccessToken();
  const { CPI_BASE_URL } = config();

  const buildUrl = () => {
    const url = new URL(`${CPI_BASE_URL}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    return url.toString();
  };

  const attempt = async (csrf) => {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (method !== "GET" && method !== "DELETE") headers["Content-Type"] = contentType;
    if (csrf) {
      if (csrf.token) headers["X-CSRF-Token"] = csrf.token;
      if (csrf.cookies) headers["Cookie"] = csrf.cookies;
    }
    const payload =
      body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    // A base64 zip upload (build_integration_flow's ArtifactContent PUT) is the one
    // payload here big enough to need more headroom than a typical metadata call.
    const timeoutMs = payload && payload.length > 200_000 ? REQUEST_TIMEOUT_MS * 3 : REQUEST_TIMEOUT_MS;
    return fetch(buildUrl(), { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
  };

  let csrf = await getCsrf(token);
  let res = await attempt(csrf);
  if (res.status === 403) {
    // Token likely stale — refetch once and retry.
    csrf = await getCsrf(token, true);
    res = await attempt(csrf);
  }

  const text = await res.text().catch(() => "");
  if (!res.ok && res.status !== 202) {
    throw new Error(`CPI ${method} ${path} failed (${res.status}): ${text.slice(0, 1500)}`);
  }

  let data;
  if (raw) {
    data = text;
  } else if (!text) {
    data = { status: res.status, ok: true };
  } else {
    try {
      const parsed = JSON.parse(text);
      data = parsed && parsed.d !== undefined ? (parsed.d.results !== undefined ? parsed.d.results : parsed.d) : parsed;
    } catch {
      data = { status: res.status, body: text };
    }
  }

  // opts.full: also surface status + the Location header, needed by callers that must
  // extract an id CPI only hands back in a header (e.g. a deploy task id), not the body.
  if (opts.full) return { data, status: res.status, location: res.headers.get("location") };
  return data;
}

/**
 * Invoke an OData function import (e.g. DeployIntegrationDesigntimeArtifact).
 * String params are wrapped in OData string literals automatically.
 * @param {string} functionName
 * @param {Object} [params]  Function parameters.
 * @param {"POST"|"GET"} [method]
 */
export async function cpiInvoke(functionName, params = {}, method = "POST", opts = {}) {
  const query = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    query[k] = typeof v === "string" ? odataString(v) : v;
  }
  return cpiRequest(method, `/${functionName}`, { query, ...opts });
}

/**
 * Escape a value for use inside an OData string literal.
 */
export function odataString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Build a single-key OData entity path segment, e.g. "('PREM')".
 * For composite keys pass an object: { Id: 'x', Version: 'active' } -> "(Id='x',Version='active')".
 */
export function odataKey(key) {
  if (key && typeof key === "object") {
    const parts = Object.entries(key).map(([k, v]) => `${k}=${odataString(v)}`);
    return `(${parts.join(",")})`;
  }
  return `(${odataString(key)})`;
}

/**
 * Build an OData datetime literal from an ISO string.
 * CPI's MPL API uses the datetime'...' literal form for LogStart/LogEnd.
 */
export function odataDateTime(isoString) {
  // Strip trailing Z / milliseconds; OData datetime literal has no timezone suffix.
  const d = new Date(isoString);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date/time: ${isoString}`);
  }
  const s = d.toISOString().replace(/\.\d{3}Z$/, "").replace(/Z$/, "");
  return `datetime'${s}'`;
}
