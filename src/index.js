// Entry point for the SAP CPI monitoring MCP server.
// Supports two transports selected via MCP_TRANSPORT:
//   - "stdio" (default) : for local use with Claude Desktop / Claude Code
//   - "http"            : Streamable HTTP, for deployment to Cloud Foundry / any host
//
// On Cloud Foundry, PORT is injected by the platform and MCP_TRANSPORT should be "http".

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerTools } from "./tools.js";
import { authMiddleware, getXsuaaCredentials } from "./auth.js";
import { scopeStorage } from "./requestScope.js";

// Best-effort: load a local .env (project root) so stdio runs pick up credentials
// without needing them duplicated into the MCP client config. Existing env vars win.
try {
  const envPath = fileURLToPath(new URL("../.env", import.meta.url));
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2];
    }
  }
} catch {
  // No .env file — rely on real environment variables (e.g. on Cloud Foundry).
}

const SERVER_INFO = { name: "sap-cpi-mcp-server", version: "1.2.0" };

function buildServer() {
  const server = new McpServer(SERVER_INFO);
  registerTools(server);
  return server;
}

async function runStdio() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio servers must not write to stdout; log to stderr.
  console.error("[sap-cpi-mcp-server] running on stdio transport");
}

async function runHttp() {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  // Simple health endpoint for Cloud Foundry.
  app.get("/health", (_req, res) => res.json({ status: "ok", server: SERVER_INFO }));

  // OAuth discovery + authorize/token façade.
  //
  // Remote MCP OAuth clients (e.g. Claude custom connectors) resolve the authorization
  // server either via RFC 8414 discovery at this origin, or — if that's absent — by
  // assuming /authorize and /token live on the MCP server's own host. XSUAA's real
  // endpoints live on a different host (the UAA tenant), so without this, clients 404
  // hitting <this-origin>/authorize directly. This exposes both: proper discovery
  // metadata pointing at the real XSUAA endpoints, plus same-origin /authorize (redirect)
  // and /token (proxy) routes as a fallback for clients that skip discovery.
  const xsuaa = getXsuaaCredentials();
  if (xsuaa && xsuaa.url) {
    const uaaUrl = xsuaa.url.replace(/\/$/, "");
    const authServerMetadata = {
      issuer: uaaUrl,
      authorization_endpoint: `${uaaUrl}/oauth/authorize`,
      token_endpoint: `${uaaUrl}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    };

    app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(authServerMetadata));

    // Browser-facing: just redirect to the real XSUAA authorize endpoint, forwarding
    // every query param (client_id, redirect_uri, code_challenge, state, ...) as-is.
    // XSUAA handles login/consent and redirects straight back to the caller's redirect_uri.
    app.get("/authorize", (req, res) => {
      const qs = new URLSearchParams(req.query).toString();
      res.redirect(`${uaaUrl}/oauth/authorize?${qs}`);
    });

    // Server-to-server: proxy the code/token exchange through to the real XSUAA token
    // endpoint and relay its response verbatim.
    app.post("/token", express.urlencoded({ extended: true }), async (req, res) => {
      try {
        const upstream = await fetch(`${uaaUrl}/oauth/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
          },
          body: new URLSearchParams(req.body).toString(),
        });
        const text = await upstream.text();
        res.status(upstream.status);
        res.set("Content-Type", upstream.headers.get("content-type") || "application/json");
        res.send(text);
      } catch (err) {
        console.error("[sap-cpi-mcp-server] /token proxy error:", err);
        res.status(502).json({ error: "token_proxy_failed", detail: err.message });
      }
    });
  } else {
    console.warn("[oauth-proxy] No XSUAA binding found — /authorize and /token routes not mounted.");
  }

  // Authentication: OAuth 2.0 (XSUAA JWT) when bound, else static token, else open.
  app.use("/mcp", authMiddleware());

  // Stateless Streamable HTTP: a fresh transport + server per request.
  app.post("/mcp", async (req, res) => {
    // Every tool call this request makes runs inside this scope, so readHandler/
    // writeHandler (domains/helpers.js) can see the caller's role via
    // requestScope.currentScopes() without req ever being threaded through the
    // MCP SDK's own dispatch. req.authScopes was set by authMiddleware above.
    await scopeStorage.run({ scopes: req.authScopes ?? null }, async () => {
      try {
        const server = buildServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          // Return a single application/json response instead of an SSE stream.
          // Friendlier for Postman/curl; MCP SDK clients still handle it fine.
          enableJsonResponse: true,
        });
        res.on("close", () => {
          transport.close();
          server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.error("[sap-cpi-mcp-server] request error:", err);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    });
  });

  // GET/DELETE on /mcp are not used in stateless mode.
  const methodNotAllowed = (_req, res) =>
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`[sap-cpi-mcp-server] HTTP transport listening on port ${port} at /mcp`);
  });
}

const transport = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
if (transport === "http") {
  runHttp().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
} else {
  runStdio().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
