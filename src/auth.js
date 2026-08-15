// HTTP authentication for the /mcp endpoint.
//
// Priority:
//   1. If an XSUAA service is bound (VCAP_SERVICES.xsuaa) OR AUTH_MODE=oauth -> require a valid
//      OAuth 2.0 JWT issued by XSUAA (signature verified against XSUAA's JWKS, audience checked).
//   2. Else if MCP_AUTH_TOKEN is set -> require that static bearer token (dev/fallback).
//   3. Else -> open (no auth).
//
// Role-based access control: once a caller is authenticated, their granted scopes are
// resolved to req.authScopes (see resolveScopes below) and carried into the tool layer
// via requestScope.js. Three scopes exist (see xs-security.json): mcp.read, mcp.write,
// mcp.delete — each a superset of the one before it (Support < Developer < Architect).
import { createRemoteJWKSet, jwtVerify } from "jose";

// Bare scope names this server understands. XSUAA returns them prefixed, e.g.
// "sap-cpi-mcp!t1234.mcp.read" (tenant-mode: dedicated) — matched by suffix so this
// is unaffected by tenant id or xsappname.
const KNOWN_SCOPES = ["mcp.read", "mcp.write", "mcp.delete"];

/** Reduce a raw XSUAA `scope` claim to the bare scope names this server checks. */
function resolveOauthScopes(rawScope) {
  const raw = Array.isArray(rawScope) ? rawScope : [];
  // No default/fallback scope: a token carrying none of the three real scopes (e.g. a
  // caller with no Role Collection assigned at all) gets an empty scope set, which
  // denies every tool outright (see hasScope in requestScope.js) rather than silently
  // granting read access. Only Support/Developer/Architect exist — there is no
  // implicit "everyone gets at least read" tier.
  return KNOWN_SCOPES.filter((known) => raw.some((s) => s === known || s.endsWith(`.${known}`)));
}

export function getXsuaaCredentials() {
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
    const arr = vcap.xsuaa || vcap.XSUAA;
    if (Array.isArray(arr) && arr[0] && arr[0].credentials) return arr[0].credentials;
  } catch {
    /* ignore */
  }
  // Allow explicit configuration without a CF binding.
  if (process.env.XSUAA_URL && process.env.XSUAA_CLIENTID) {
    return { url: process.env.XSUAA_URL, clientid: process.env.XSUAA_CLIENTID };
  }
  return null;
}

let jwksSet = null;
let jwksForUrl = null;
function getJwks(uaaUrl) {
  if (!jwksSet || jwksForUrl !== uaaUrl) {
    jwksSet = createRemoteJWKSet(new URL(`${uaaUrl.replace(/\/$/, "")}/token_keys`));
    jwksForUrl = uaaUrl;
  }
  return jwksSet;
}

function audienceMatches(payload, clientid) {
  if (!clientid) return true;
  if (payload.azp === clientid || payload.client_id === clientid) return true;
  const aud = payload.aud;
  if (Array.isArray(aud)) return aud.includes(clientid);
  return aud === clientid;
}

/**
 * Express middleware enforcing the configured auth mode.
 */
export function authMiddleware() {
  const xsuaa = getXsuaaCredentials();
  const staticToken = process.env.MCP_AUTH_TOKEN;
  const oauthMode = xsuaa && String(process.env.AUTH_MODE || "oauth").toLowerCase() !== "off";

  if (oauthMode) {
    console.log("[auth] OAuth 2.0 (XSUAA) mode enabled — JWT required.");
  } else if (staticToken) {
    console.log("[auth] Static bearer-token mode enabled.");
  } else {
    console.warn("[auth] WARNING: no authentication configured — endpoint is OPEN.");
  }

  return async (req, res, next) => {
    const authz = req.headers["authorization"] || "";
    const bearer = authz.startsWith("Bearer ") ? authz.slice(7).trim() : null;

    if (oauthMode) {
      if (!bearer) return res.status(401).json({ error: "Missing bearer token" });
      try {
        const { payload } = await jwtVerify(bearer, getJwks(xsuaa.url));
        if (!audienceMatches(payload, xsuaa.clientid)) {
          return res.status(401).json({ error: "Token audience mismatch" });
        }
        req.authScopes = resolveOauthScopes(payload.scope);
        return next();
      } catch (err) {
        return res.status(401).json({ error: "Invalid token", detail: err.message });
      }
    }

    if (staticToken) {
      if (bearer === staticToken) {
        // A single shared static token has no per-user identity to hang a role off —
        // grant full access, matching this mode's existing all-or-nothing behavior.
        req.authScopes = ["mcp.read", "mcp.write", "mcp.delete"];
        return next();
      }
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Open mode (no auth configured at all) — same all-access behavior as before RBAC.
    req.authScopes = ["mcp.read", "mcp.write", "mcp.delete"];
    return next();
  };
}
