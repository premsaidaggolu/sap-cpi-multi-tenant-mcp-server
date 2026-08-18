// SAP BTP Credential Store client.
//
// Purpose: let cpiClient.js resolve a tenant's CPI OAuth client_secret from a bound
// Credential Store service instance instead of a plaintext CPI_CLIENT_SECRET<N> env
// var. Confirmed against an actual trial-plan VCAP_SERVICES binding (SAP Community
// "Accessing SAP Credential Store using Basic Authentication"), which looks like:
//
//   "credstore": [{ "credentials": {
//     "username": "...", "password": "...",              <- Basic auth, not mTLS
//     "url": "https://credstore.cfapps.<region>.hana.ondemand.com/api/v1/credentials",
//     "encryption": { "client_private_key": "...", "server_public_key": "..." },
//     "parameters": { "encryption": { "payload": "enabled", "key": { "size": 3072 } },
//                      "authentication": { "type": "basic" } }
//   }}]
//
// Two things this got wrong in an earlier version, now fixed:
//   1. `url` already ends in `/api/v1/credentials` — do NOT append that path again.
//   2. This plan authenticates with Basic auth (username/password), not a client
//      certificate. A `certificate`/`key` pair (mTLS) is a DIFFERENT binding mode SAP
//      also supports (e.g. non-trial plans configured for it) — both are handled below,
//      picked by whichever fields are actually present in the binding.
//
// Because `parameters.encryption.payload` is "enabled" on this instance, every
// response body is a JWE (confirmed live: RSA-OAEP-256 key-wrap + A256GCM content),
// decrypted here with the binding's own `encryption.client_private_key` — `jose`
// (already a dependency) reads the actual algorithm straight out of the JWE's own
// protected header via decodeProtectedHeader, so the exact alg/enc values SAP picked
// don't need to be hardcoded here.
//
// Two more things confirmed only by an actual live call (not documentation), both
// fixed below:
//   1. Node's global `fetch` rejects a `dispatcher` built from a separately
//      npm-installed `undici` — Node bundles its own internal undici for global fetch,
//      and passing an externally-constructed Agent as `dispatcher` throws
//      "invalid onError method" (an internal shape mismatch between the two undici
//      copies). Fix: use undici's own `fetch` export, not the global one, whenever a
//      dispatcher is involved — guaranteed to be the same undici internally.
//   2. `encryption.client_private_key` (and presumably `server_public_key`) is raw
//      base64-encoded DER, not a PEM string — `importPKCS8` needs actual PEM armor
//      (`-----BEGIN PRIVATE KEY-----` etc.), so it's wrapped here before importing.
import { Agent, fetch as undiciFetch } from "undici";
import { compactDecrypt, decodeProtectedHeader, importPKCS8 } from "jose";

const DEFAULT_NAMESPACE = process.env.CPI_CREDSTORE_NAMESPACE || "cpi-mcp";

/** Read the credstore service binding out of VCAP_SERVICES, or an explicit local/dev fallback. */
function binding() {
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
    const arr = vcap["credstore"] || vcap["credential-store"];
    const creds = arr?.[0]?.credentials;
    if (creds?.url && ((creds.username && creds.password) || (creds.certificate && creds.key))) {
      return creds;
    }
  } catch {
    /* ignore — fall through to the explicit env-var fallback below */
  }
  // Local/dev fallback with no CF binding at all — same pattern as auth.js's
  // XSUAA_URL/XSUAA_CLIENTID fallback. Pull these from `cf create-service-key
  // <credstore-instance> local-dev` and its service key (same shape as the binding
  // above — CREDSTORE_URL should already include the trailing /api/v1/credentials).
  if (process.env.CREDSTORE_URL && process.env.CREDSTORE_USERNAME && process.env.CREDSTORE_PASSWORD) {
    return {
      url: process.env.CREDSTORE_URL,
      username: process.env.CREDSTORE_USERNAME,
      password: process.env.CREDSTORE_PASSWORD,
      encryption: process.env.CREDSTORE_CLIENT_PRIVATE_KEY
        ? { client_private_key: process.env.CREDSTORE_CLIENT_PRIVATE_KEY }
        : undefined,
    };
  }
  if (process.env.CREDSTORE_URL && process.env.CREDSTORE_CERT && process.env.CREDSTORE_KEY) {
    return { url: process.env.CREDSTORE_URL, certificate: process.env.CREDSTORE_CERT, key: process.env.CREDSTORE_KEY };
  }
  return null;
}

// One mTLS dispatcher per bound certificate — only used for the certificate/key
// binding mode. Rebuilt only if the cert value changes (e.g. after CF rotates the
// binding and the app restarts with a new one).
let dispatcher = null;
let dispatcherForCert = null;
function mtlsDispatcher(creds) {
  if (!dispatcher || dispatcherForCert !== creds.certificate) {
    dispatcher = new Agent({ connect: { cert: creds.certificate, key: creds.key } });
    dispatcherForCert = creds.certificate;
  }
  return dispatcher;
}

/** Build the fetch options (headers + dispatcher) for whichever auth mode this binding uses. */
function authOptions(creds, namespace) {
  const headers = { "sapcp-credstore-namespace": namespace, Accept: "application/json" };
  if (creds.username && creds.password) {
    headers.Authorization = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`;
    return { headers };
  }
  return { headers, dispatcher: mtlsDispatcher(creds) };
}

/** True if `text` looks like a compact JWE (5 dot-separated base64url segments). */
function looksLikeJwe(text) {
  return /^[\w-]+\.[\w-]+\.[\w-]+\.[\w-]+\.[\w-]+$/.test(text.trim());
}

/** Wrap raw base64 DER into PEM armor if it isn't already PEM (confirmed: the binding
 *  hands back client_private_key as bare base64, not PEM). Idempotent — a value that's
 *  already PEM is returned unchanged. */
function toPem(base64OrPem, label) {
  const trimmed = base64OrPem.trim();
  if (trimmed.startsWith("-----BEGIN")) return trimmed;
  const lines = trimmed.match(/.{1,64}/g) || [trimmed];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** Decrypt a compact JWE response using the binding's client_private_key. */
async function decryptJwe(jwe, clientPrivateKey) {
  const compact = jwe.trim();
  const { alg } = decodeProtectedHeader(compact);
  const privateKey = await importPKCS8(toPem(clientPrivateKey, "PRIVATE KEY"), alg);
  const { plaintext } = await compactDecrypt(compact, privateKey);
  return new TextDecoder().decode(plaintext);
}

// Cache resolved secrets in memory so every CPI token request doesn't round-trip to
// Credential Store — mirrors the token cache in cpiClient.js. Re-fetched after TTL so
// a secret rotated in Credential Store is picked up without restarting the app.
const CACHE_TTL_MS = Number(process.env.CREDSTORE_CACHE_TTL_MS) || 10 * 60 * 1000;
const cache = new Map(); // `${namespace}/${name}` -> { value, at }

/**
 * Fetch a password-type credential's value from Credential Store.
 * @param {string} name  Credential name as created in the target namespace.
 * @param {string} [namespace]  Defaults to CPI_CREDSTORE_NAMESPACE (or "cpi-mcp").
 */
export async function getSecret(name, namespace = DEFAULT_NAMESPACE) {
  const cacheKey = `${namespace}/${name}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const creds = binding();
  if (!creds) {
    throw new Error(
      "No Credential Store binding found — VCAP_SERVICES has no 'credstore' service, and " +
        "the CREDSTORE_* local-dev fallback vars aren't set. Bind a Credential Store " +
        "service instance (see manifest.yml) or set the fallback vars (see .env.example)."
    );
  }

  // creds.url already includes the /api/v1/credentials base path (confirmed from a
  // real binding) — do not append it again here.
  const url = `${creds.url.replace(/\/$/, "")}/password?name=${encodeURIComponent(name)}`;
  let res;
  try {
    // undiciFetch, not global fetch — see the module-level note on why a dispatcher
    // from the npm `undici` package breaks Node's global fetch.
    res = await undiciFetch(url, { method: "GET", ...authOptions(creds, namespace) });
  } catch (err) {
    throw new Error(`Credential Store request for "${name}" failed: ${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Credential Store GET ${name} failed (${res.status}): ${text.slice(0, 500)}`);
  }

  let text = await res.text();

  if (looksLikeJwe(text)) {
    if (!creds.encryption?.client_private_key) {
      throw new Error(
        `Credential Store returned an encrypted (JWE) payload for "${name}", but the binding has ` +
          "no encryption.client_private_key to decrypt it with — check the service instance's " +
          "encryption parameters."
      );
    }
    try {
      text = await decryptJwe(text, creds.encryption.client_private_key);
    } catch (err) {
      throw new Error(`Failed to decrypt Credential Store response for "${name}": ${err.message}`);
    }
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Credential Store returned a non-JSON body for "${name}" after decryption: ${text.slice(0, 200)}`);
  }

  const value = data.value ?? data.password ?? data.secret;
  if (!value) {
    throw new Error(`Credential Store response for "${name}" had no recognizable value field.`);
  }

  cache.set(cacheKey, { value, at: Date.now() });
  return value;
}
