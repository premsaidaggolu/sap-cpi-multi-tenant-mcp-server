# SAP CPI MCP Server — End-to-End Guide

Use Claude (Desktop, Code, or Enterprise chat) to **monitor and manage SAP Cloud Integration
(CPI / Integration Suite)** in plain English — "show me failed messages", "deploy this iFlow",
"what config does this flow have". This guide takes you from **downloading the code** to
**asking questions like an agent**.

---

## 0. What you're setting up

An **MCP server** (Model Context Protocol) that wraps the SAP CPI OData v1 API as **48 tools**
(monitoring, design content, flow authoring/deploy, security material, + generic escape-hatch
tools that reach the *entire* API). You run it two ways:

- **Local (stdio)** — runs on your PC, used by **Claude Desktop** or **Claude Code**. Easiest.
- **Remote (HTTP + OAuth)** — deployed to **SAP BTP Cloud Foundry**, used by **Claude Enterprise
  chat** via a custom connector (admin-enabled).

```
You ── ask in plain English ──► Claude ── calls tools ──► MCP server ── OData ──► SAP CPI tenant
```

---

## 1. Prerequisites

- **Node.js 18+** (uses built-in `fetch`). Check: `node --version`.
- A **Claude client**: Claude Desktop, or Claude Code CLI. (Enterprise chat needs the remote option.)
- An **SAP CPI / Integration Suite** tenant where you can create an API service key.
- (Remote option only) **Cloud Foundry CLI** (`cf`) and access to your BTP subaccount.

---

## 2. Download the code

**Option A — git clone:**
```bash
git clone https://github.com/<your-org-or-user>/sap-cpi-mcp-server.git
cd sap-cpi-mcp-server
```

**Option B — download ZIP:** GitHub → **Code ▸ Download ZIP** → extract.

Then install dependencies:
```bash
npm install
```

---

## 3. Get your SAP CPI API credentials (one-time)

The OData API is served by the **Process Integration Runtime** service.

1. BTP cockpit → your subaccount → **Instances and Subscriptions** → **Create** →
   **Process Integration Runtime**, plan **`api`**.
2. Grant roles (under the instance → Roles). At minimum for read:
   - `MessageProcessingLogRead`, `IntegrationContentRead`, `MonitoringDataRead`
   - For write/deploy tools also add e.g. `WorkspacePackagesEdit`, `WorkspaceArtifactsDeploy`,
     and relevant security-material roles.
3. Create a **Service Key**. You'll get:
   | Service key field | Use as |
   |---|---|
   | `url` | `CPI_BASE_URL` = `<url>` **+ `/api/v1`** |
   | `tokenurl` | `CPI_TOKEN_URL` |
   | `clientid` | `CPI_CLIENT_ID` |
   | `clientsecret` | `CPI_CLIENT_SECRET` |

> ⚠️ **Common gotcha — the API host.** The `url` from the key sometimes points at the **runtime**
> host (contains `-rt`). The OData API lives on the **tenant-management** host (the one you use to
> open CPI in the browser, usually **without** `-rt`). If calls return `404 route does not exist`,
> drop the `-rt` from the host. Always append **`/api/v1`**.

---

## 4. Configure `.env`

```bash
cp .env.example .env      # Windows: copy .env.example .env
```
Edit `.env`:
```
CPI_BASE_URL=https://<tenant>.it-cpiXXX.cfapps.<region>.hana.ondemand.com/api/v1
CPI_TOKEN_URL=https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token
CPI_CLIENT_ID=<clientid>
CPI_CLIENT_SECRET=<clientsecret>
MCP_TRANSPORT=stdio
ALLOW_WRITE=false          # set true to enable deploy/create/update/delete tools
```

**Write safety:** with `ALLOW_WRITE=true`, every write action still asks *"Are you sure…?"* and only
runs when called again with `confirm=true`. Leave `false` for read-only.

---

## 5. Connect to Claude

### 5a. Claude Desktop (local, easiest)
Edit the Claude Desktop MCP config and add the server:

- **Standard install:** `%APPDATA%\Claude\claude_desktop_config.json` (Windows) /
  `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).
- **Microsoft Store install (Windows):**
  `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json`
  (In the app, **Settings ▸ Developer ▸ Local MCP servers ▸ Edit Config** opens the right file.)

```json
{
  "mcpServers": {
    "sap-cpi": {
      "command": "node",
      "args": ["C:\\full\\path\\to\\sap-cpi-mcp-server\\src\\index.js"]
    }
  }
}
```
Credentials load automatically from the project's `.env`.

**Then FULLY restart Claude Desktop** — quit it from the system tray (or end all `Claude` processes
in Task Manager) and reopen. Closing the window is not enough. Confirm under
**Settings ▸ Developer ▸ Local MCP servers** that `sap-cpi` shows **running**.

### 5b. Claude Code (CLI)
```bash
claude mcp add sap-cpi -- node /full/path/to/sap-cpi-mcp-server/src/index.js
```

### 5c. Claude Enterprise / cloud chat
The cloud chat can only reach **remote** servers, not a local process — so you need the remote
deployment (Section 7) added as a **custom connector**. On Enterprise this is **admin-controlled**;
see Section 7 and hand your admin the connector URL + OAuth details.

---

## 6. Ask questions like an agent

Open a new chat (in the client where the server is connected) and just ask:

- "List my SAP CPI integration packages."
- "Show me any failed messages in the last 24 hours."
- "Give me a failure summary grouped by integration flow."
- "What integration flows are in the `MyPackage` package?"
- "Get the error details for message `<guid>`."
- "Is `OrderReplication` deployed and running? If not, why?"
- "What externalized configuration does `MyFlow` have?"
- "Deploy `MyFlow`." → Claude asks you to confirm → say yes → it deploys.
- "Run cpi_api_catalog" → discover every entity/operation the server can reach.

Claude decides which tool to call, runs it, and explains the result. For write actions it will ask
you to confirm before anything changes.

---

## 7. (Optional) Deploy remotely to SAP BTP Cloud Foundry with OAuth

For team use / Enterprise chat.

```bash
cf login -a https://api.cf.<region>.hana.ondemand.com
cf target -o <org> -s <space>

cf push --no-start
cf set-env sap-cpi-mcp-server CPI_BASE_URL    "https://.../api/v1"
cf set-env sap-cpi-mcp-server CPI_TOKEN_URL   "https://.../oauth/token"
cf set-env sap-cpi-mcp-server CPI_CLIENT_ID   "..."
cf set-env sap-cpi-mcp-server CPI_CLIENT_SECRET "..."
cf set-env sap-cpi-mcp-server MCP_TRANSPORT   "http"
# Optional writes: cf set-env sap-cpi-mcp-server ALLOW_WRITE true
```

**Secure it with OAuth 2.0 (XSUAA):**
```bash
cf create-service xsuaa application sap-cpi-mcp-xsuaa -c xs-security.json
cf bind-service sap-cpi-mcp-server sap-cpi-mcp-xsuaa
cf start sap-cpi-mcp-server
cf create-service-key sap-cpi-mcp-xsuaa claude-connector   # -> clientid/secret/tokenurl for the connector
```
Endpoint: `https://sap-cpi-mcp-server.cfapps.<region>.hana.ondemand.com/mcp`

**Add as a custom connector** in Claude (Settings ▸ Connectors). On Enterprise this is admin-gated —
give your admin the endpoint URL and the OAuth client details from the service key. See
`SAP-CPI-MCP-ADMIN-HANDOFF.md` if provided.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `404 route does not exist` | Wrong API host — drop `-rt`, use the tenant-management host + `/api/v1` |
| Tools don't appear in Claude Desktop | You didn't **fully** restart (quit from tray / Task Manager) |
| Cloud chat "times out / server unresponsive" | Cloud chat can't reach a **local** server — use the remote (CF) deployment |
| `401` from the API | Wrong client id/secret, or missing roles on the service key |
| `403` on deploy/undeploy | Service key lacks deploy/edit roles |
| "Write operations are disabled" | Set `ALLOW_WRITE=true` (and restart) |
| Write tool won't run | Re-run it with `confirm=true` |
| `501 Not Implemented` (e.g. JMS on trial) | That feature isn't provisioned on your tenant/plan |
| Postman shows "Connected / Connection closed" | The server streams SSE; this build returns JSON in HTTP mode — resend |

---

## Tool overview

**Tenant discovery (1):** `list_cpi_tenants`.
**Monitoring (8):** search/get MPLs, error info, headers, run steps, message store, failure summary, cancel.
**Content (14):** package & flow CRUD, create flow, save-as-version, copy, download, push raw content, configurations, resources.
**Flow authoring (1):** `build_integration_flow` — author + deploy real flow content from a step spec.
**Runtime (6):** deployed list/status, deploy, undeploy, build status, endpoints.
**Admin (12):** user/OAuth credentials, keystore, number ranges, data stores, variables, queues, partners, logs.
**Generic (5):** `cpi_api_catalog`, `cpi_query`, `cpi_get_entity`, `cpi_invoke_function`, `cpi_write` — reach the whole API.
**Where used (1):** `where_used` — search a word/value across flow content tenant-wide.

**Total: 48 tools.** Full reference: see `README.md`.
