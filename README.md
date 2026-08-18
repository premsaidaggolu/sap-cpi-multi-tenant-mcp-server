# SAP CPI MCP Server

**Version 1.4.0**

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an MCP client
(Claude Desktop, Claude Code, Claude Enterprise chat, etc.) **monitor and manage SAP Cloud
Integration (CPI / Integration Suite)** through its **OData v1 APIs** — the same surface
documented as the "Cloud Integration" package on the SAP Business Accelerator Hub.

```
You ── ask in plain English ──► Claude ── calls tools ──► MCP server ── OData ──► SAP CPI tenant
```

It runs two ways:
- **Local (stdio)** — runs on your PC, used by **Claude Desktop** or **Claude Code**. Easiest.
- **Remote (HTTP + OAuth)** — deployed to **SAP BTP Cloud Foundry**, used by **Claude Enterprise
  chat** (or any client) via a custom connector.

One server instance can talk to a **single CPI tenant or many** — see
[Multi-tenant support](#multi-tenant-support).

**48 tools**: curated tools for the common workflows, plus generic escape-hatch tools
(`cpi_query`, `cpi_get_entity`, `cpi_invoke_function`, `cpi_write`) that reach **any** of the
~130 entity sets and 35 operations the API exposes.

### Contents
- [What it can do (tools)](#what-it-can-do-tools)
- [Write safety](#write-safety)
- [Get your SAP CPI API credentials](#get-your-sap-cpi-api-credentials-one-time)
- [Quick start — run locally with Claude Desktop / Claude Code](#quick-start--run-locally-with-claude-desktop--claude-code)
- [Multi-tenant support](#multi-tenant-support)
- [Credential Store](#credential-store-keeping-cpi_client_secret-out-of-manifestyml--cf-env)
- [Role-based access control (RBAC)](#role-based-access-control-rbac)
- [Securing the HTTP endpoint with OAuth 2.0 (XSUAA)](#securing-the-http-endpoint-with-oauth-20-xsuaa)
- [Deploying to SAP BTP Cloud Foundry](#deploying-to-sap-btp-cloud-foundry)
- [Example prompts](#example-prompts)
- [Troubleshooting](#troubleshooting)
- [Notes on the CPI OData API](#notes-on-the-cpi-odata-api)
- [Appendix — Environment Variables Reference](#appendix--environment-variables-reference)
- [Changelog](#changelog)

---

## What it can do (tools)

### Tenant discovery
| Tool | Purpose |
|------|---------|
| `list_cpi_tenants` | List the CPI tenants this server is configured to reach — call this first when it isn't already clear which one to use |

### Monitoring — Message Processing Logs (MPL)
| Tool | Purpose |
|------|---------|
| `search_message_processing_logs` | Search/filter MPLs by status, flow, time window |
| `get_mpl_details` | Full MPL entry for a MessageGuid |
| `get_mpl_error_information` | Detailed error/exception text for a failed message |
| `get_mpl_custom_header_properties` | Custom header properties (business keys) |
| `get_mpl_run_steps` | Per-step run trace within a message |
| `get_message_store_entries` | Persisted payloads for a message |
| `get_failure_summary` | Failures grouped by integration flow (health dashboard) |
| `cancel_message_processing_log` ⚠️ | Cancel a processing/retrying message |

### Design-time content
| Tool | Purpose |
|------|---------|
| `list_integration_packages` / `get_integration_package` | Packages |
| `create_integration_package` ⚠️ / `delete_integration_package` ⚠️ | Package CRUD |
| `copy_integration_package` ⚠️ | Copy a standard/Discover package into the workspace |
| `list_integration_flows` / `get_integration_flow` | Integration flows |
| `create_integration_flow` ⚠️ | Create a new (empty) iFlow in a package |
| `save_integration_flow_as_version` ⚠️ | Save the flow draft as a new version (+ optional comment) |
| `download_integration_flow` | Download flow as base64 zip |
| `get_flow_configurations` / `update_flow_configuration` ⚠️ | Externalized parameters |
| `get_flow_resources` | Scripts/XSDs/WSDLs inside a flow |
| `where_used` | Search a word/string (e.g. a credential name, endpoint, or value) across flow content — process XML, adapter properties, scripts, mappings, parameter files — one package, one flow, or the whole tenant |

### Flow authoring — build real content from a spec
| Tool | Purpose |
|------|---------|
| `build_integration_flow` ⚠️ | Author **real iFlow content** (not just an empty shell) from a structured step spec, push it, and validate it — deploy is opt-in |

`create_integration_flow` above only makes an empty shell — there's no SAP API to add a
step at a time. `build_integration_flow` is the encoded version of that whole manual
process: give it an ordered `steps` array and it generates the confirmed-schema
BPMN2/`ifl:` XML, splices it into a real tenant-generated shell, pushes it, and runs
CPI's own `ValidateIntegrationDesigntimeArtifact` check. All of the hard-won gotchas
below are applied automatically — you don't need a separate skill/instructions file
loaded to get them right.

**Standard practice (as of 2026-08-17): `deploy` defaults to `false`.** This tool
pushes + validates and stops there by default, whether or not validation found errors
— it does NOT deploy unless you explicitly ask for it. The expected flow: build
(`deploy` omitted or `false`), read the `validation` field on the result, share that
analysis (clean pass, or which errors were found and what they likely mean), and let
the outcome of that conversation decide the next step — fix the spec and rebuild, or
deploy (`deploy: true`, or `deploy_artifact` on the pushed artifact directly). Set
`deploy: true` only once that's actually been asked for.

Supported step kinds (first step must be `timer`, `httpsStart`, or `sftpStart`):
`contentModifier`, `router`, `groovyScript`, `requestReply` / `send`, `pollEnrich`,
`filter`, `xmlModifier`, `writeVariables`, `splitter`, `gather`, `dataStoreGet` /
`dataStorePut` / `dataStoreSelect` / `dataStoreDelete`, `processCall` (+ top-level
`localProcesses` for Local Integration Processes), `endEvent`. A step type outside this
list is rejected with a clear error rather than a guessed XML shape.

`requestReply` / `send` adapters: `http` (auth `None` and `OAuth2ClientCredentials`
confirmed working, plus retry parameters — `retryOnException`, `retryIteration`,
`retryInterval`, `retryOnConnectionFailure`, `httpErrorResponseCodes`,
`throwExceptionOnFailure`), `mail`, `odata` (OData V2 / HCIOData), `odatav4` (OData V4 /
HCIOData — a distinct property set from plain `odata`), `sftpWrite`, `jms`, `soap`
(send-only), `processDirect` (requestReply-only). `pollEnrich` adapter: `sftpPoll`.

Auto-fixes applied for you:
- Camel Simple `==` is rewritten to `=` (CPI's condition parser only accepts `=`).
- An unquoted router-condition comparison value gets quoted (CPI's Problems tab flags
  a bare number/placeholder even though it's still numerically compared at runtime).
- Element/participant names have whitespace replaced with `_` (CPI rejects whitespace
  in a participant name outright).
- A `{{Placeholder}}` used in a step but not declared in `parameters` is auto-added as
  an optional externalized parameter, with a warning.

On any challenge — a build failure, a deploy that times out, or a runtime start error —
the tool doesn't just report failure: the `challenge` field explains what happened and
points you at `download_integration_flow(artifactId)` to fetch the already-pushed
content back for inspection (SAP's OData API famously returns no detail for a build
failure; the zip, imported into the web editor's Problems tab, is the reliable way to
see the real error). This tool never writes to this server's local disk, in any mode,
on either transport (local stdio or the Cloud Foundry HTTP deployment) — once content
is pushed, the tenant itself is the copy of record. Pass `offline: true` to skip the
tenant entirely and get a preview zip back inline as base64 (`zipBase64` in the
result) instead of a real push — decode it yourself locally if you want a file.

### Runtime & deployment
| Tool | Purpose |
|------|---------|
| `list_deployed_artifacts` / `get_deployed_artifact_status` | Deployed artifacts + status |
| `deploy_artifact` ⚠️ | Deploy iFlow / mapping / script / value-mapping / adapter |
| `undeploy_artifact` ⚠️ | Undeploy a running artifact |
| `get_build_and_deploy_status` | Async deploy task status |
| `list_service_endpoints` | Runtime endpoint URLs of deployed flows |

### Admin (security material, config, queues, B2B, logs)
| Tool | Purpose |
|------|---------|
| `list_user_credentials` / `deploy_user_credential` ⚠️ | User Credential security material |
| `list_oauth2_client_credentials` | OAuth2 client credentials |
| `list_keystore_entries` | Keystore certificates / key pairs |
| `list_number_ranges` / `create_number_range` ⚠️ | Number ranges |
| `list_data_stores` / `get_data_store_entries` | Data stores + entries |
| `list_variables` | Global/local variables |
| `list_jms_queues` | JMS queues (Enterprise plan; 501 on trial) |
| `list_partners` | Partner Directory partners |
| `list_log_files` | System log files |

### Generic — full API coverage
| Tool | Purpose |
|------|---------|
| `cpi_api_catalog` | Discover every entity set & function import |
| `cpi_query` | Read any entity set with `$filter/$orderby/$expand/...` |
| `cpi_get_entity` | Read one record by (single or composite) key |
| `cpi_invoke_function` ⚠️ | Invoke any function import |
| `cpi_write` ⚠️ | Create/update/delete any entity (DELETE needs `confirm=true`) |

⚠️ = write/destructive tool — requires `ALLOW_WRITE=true` (see below).

**Tool count by category:** Tenant discovery (1) · Monitoring (8) · Content (10) · Flow
authoring (1) · `where_used` (1) · Runtime (5) · Admin (9) · Generic (5) · **Total: 48.**

---

## Write safety

Read tools always work. **Write / deploy / delete tools only run when `ALLOW_WRITE=true`** is set
in your `.env`. In addition, **every write action requires an explicit `confirm=true`**: calling a
write tool without it returns an "Are you sure you want to …?" prompt and makes **no changes**.
Re-run the same tool with `confirm=true` to proceed. This gives a two-step confirmation for all
create/update/delete/deploy operations.

```
ALLOW_WRITE=false   # default — read-only
ALLOW_WRITE=true    # enable the ⚠️ tools
```

---

## Get your SAP CPI API credentials (one-time)

The OData API is served by the **Process Integration Runtime** service.

1. BTP Cockpit → your subaccount → **Instances and Subscriptions** → **Create** →
   **Process Integration Runtime**, plan **`api`**.
2. Under **Roles**, grant what you need:
   - Read: `MessageProcessingLogRead`, `IntegrationContentRead`, `MonitoringDataRead`
   - For the ⚠️ write tools (deploy/undeploy/create/delete): also add e.g.
     `WorkspacePackagesEdit`, `WorkspaceArtifactsDeploy`, `MessageProcessingLogCustomHeaderRead`,
     and the relevant security-material roles.
3. Create a **Service Key**. From the key you get:

   | Service key field | Use as |
   |---|---|
   | `url` | `CPI_BASE_URL` = `<url>` **+ `/api/v1`** |
   | `tokenurl` | `CPI_TOKEN_URL` (already ends in `/oauth/token`) |
   | `clientid` | `CPI_CLIENT_ID` |
   | `clientsecret` | `CPI_CLIENT_SECRET` |

> ⚠️ **Common gotcha — the API host.** The `url` from the key sometimes points at the **runtime**
> host (contains `-rt`). The OData API lives on the **tenant-management** host (the one you use to
> open CPI in the browser, usually **without** `-rt`). If calls return `404 route does not exist`,
> drop the `-rt` from the host. Always append **`/api/v1`**.

---

## Quick start — run locally with Claude Desktop / Claude Code

### 1. Get the code and install dependencies

```bash
git clone https://github.com/<your-org-or-user>/sap-cpi-mcp-server.git
cd sap-cpi-mcp-server
npm install
```
(Or download a ZIP from GitHub → **Code ▸ Download ZIP** → extract, then `npm install`.)

### 2. Configure `.env`

```bash
cp .env.example .env      # Windows: copy .env.example .env
```
Edit `.env` with the values from [above](#get-your-sap-cpi-api-credentials-one-time):
```
CPI_BASE_URL=https://<tenant>.it-cpiXXX.cfapps.<region>.hana.ondemand.com/api/v1
CPI_TOKEN_URL=https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token
CPI_CLIENT_ID=<clientid>
CPI_CLIENT_SECRET=<clientsecret>
MCP_TRANSPORT=stdio
ALLOW_WRITE=false          # set true to enable deploy/create/update/delete tools
```
For more than one tenant, use the numbered vars (`CPI_BASE_URL1`, `CPI_BASE_URL2`, ...) instead
— see [Multi-tenant support](#multi-tenant-support). `.env.example` documents both forms.

### 3. Connect to Claude

**Claude Desktop** — edit the MCP config and add the server:
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

**Then FULLY restart Claude Desktop** — quit it from the system tray (or end all `Claude`
processes in Task Manager) and reopen. Closing the window is not enough. Confirm under
**Settings ▸ Developer ▸ Local MCP servers** that `sap-cpi` shows **running**.

**Claude Code (CLI):**
```bash
claude mcp add sap-cpi -- node /full/path/to/sap-cpi-mcp-server/src/index.js
```

**Claude Enterprise / cloud chat** can only reach **remote** servers, not a local process — you
need the [Cloud Foundry deployment](#deploying-to-sap-btp-cloud-foundry) added as a **custom
connector** instead. On Enterprise this is admin-controlled; hand your admin the connector URL +
OAuth details once deployed.

Once connected, jump to [Example prompts](#example-prompts) to try it.

---

## Multi-tenant support

One running server can reach **one CPI tenant (the default) or several**, decided purely by
what's in `.env` — no code change either way.

### Single tenant (default)

The plain vars — `CPI_BASE_URL` / `CPI_TOKEN_URL` / `CPI_CLIENT_ID` / `CPI_CLIENT_SECRET` — work
exactly as before. No tool gains an extra argument; nothing else in this section applies.

### Multiple tenants

Add a numbered group of the same four vars per tenant — `CPI_BASE_URL1`, `CPI_BASE_URL2`,
`CPI_BASE_URL3`, ... — and the server discovers however many it finds at startup:

```bash
CPI_BASE_URL1=https://dev-tenant.it-cpiXXX.cfapps.eu10.hana.ondemand.com/api/v1
CPI_TOKEN_URL1=https://dev-subdomain.authentication.eu10.hana.ondemand.com/oauth/token
CPI_CLIENT_ID1=dev-client-id
CPI_CLIENT_SECRET1=dev-client-secret
TENANT_NAME1=Dev

CPI_BASE_URL2=https://qa-tenant.it-cpiXXX.cfapps.eu10.hana.ondemand.com/api/v1
CPI_TOKEN_URL2=https://qa-subdomain.authentication.eu10.hana.ondemand.com/oauth/token
CPI_CLIENT_ID2=qa-client-id
CPI_CLIENT_SECRET2=qa-client-secret
TENANT_NAME2=QA
```

Once **2 or more** tenants are configured:

- Every tool gains a required `tenant` argument — a fixed enum of the exact `TENANT_NAME<N>`
  values found (case-insensitive match, but the MCP client sees these exact names). The client
  (Claude) has to ask which tenant to use rather than guessing.
- Call `list_cpi_tenants` any time to see the current list — it's the one tool that never needs
  a `tenant` itself.
- `TENANT_NAME<N>` defaults to `tenant<N>` if omitted, but naming it is strongly recommended —
  that name is what shows up in every tool's schema and in Claude's prompts.

Adding a 3rd, 4th, ... Nth tenant later is **just adding another numbered block** — no code
change, no redeploy of anything but the env file itself. Restart the MCP server connection
after editing `.env` (or `cf set-env` + `cf restage` for the HTTP deployment) so it re-reads it.

### Per-tenant overrides

Two flags can be scoped to one tenant instead of the whole server:

```bash
# Allow writes on Dev only, even if the global ALLOW_WRITE below is false:
ALLOW_WRITE1=true

# Take a tenant out of rotation without deleting its credentials — it disappears from
# list_cpi_tenants, the `tenant` enum, and multi-tenant mode entirely (falls back to
# single-tenant behavior if only one enabled tenant remains):
STATUS2=disable   # "disable"/"disabled" to turn off; unset or "enable" = on (default)
```

### Isolation guarantees

- Each tenant gets its **own OAuth access-token cache and CSRF/session-cookie cache** — a busy
  Dev tenant's token can never be reused for a Prod call, even under load.
- Error messages and results are host-masked **per tenant**, so one tenant's real hostname never
  leaks through a call made against another.
- `ALLOW_WRITE<N>` and `STATUS<N>` are independent per tenant; nothing else (RBAC scopes,
  auth mode) is tenant-aware — those still apply server-wide.

---

## Credential Store (keeping `CPI_CLIENT_SECRET` out of manifest.yml / `cf env`)

By default a tenant's OAuth client secret is a plain env var — fine for local dev, but it means
the real CPI secret sits in `manifest.yml`, `cf set-env` history, and `cf env`'s output. As an
alternative, [src/credStore.js](src/credStore.js) can resolve a tenant's secret from a bound
**SAP Credential Store** service instance at runtime instead, so the actual secret never has to
appear in this app's own configuration at all.

This is opt-in and **per tenant** — set `CPI_CREDSTORE_KEY<N>` instead of `CPI_CLIENT_SECRET<N>`
for whichever tenant should use it; tenants without it keep working exactly as before, so you can
migrate one at a time (or not at all):

```bash
CPI_CREDSTORE_KEY2=cpi-oauth-secret-qa       # name of the credential in Credential Store
CPI_CREDSTORE_NAMESPACE2=cpi-mcp             # optional — defaults to "cpi-mcp"
```

**Setup:**
1. Create a Credential Store service instance in BTP Cockpit (Entitlements → add **Credential
   Store**, then Instances and Subscriptions → Create), and bind it to this app as `cpi-credstore`
   — see the commented-out `services:` block in [manifest.yml](manifest.yml).
2. In the instance's Cockpit UI, create a namespace (e.g. `cpi-mcp`) and, inside it, a **Password**
   credential — paste your real CPI `client_secret` as the value (don't use "Generate Value", it
   has to match the secret already registered with CPI's XSUAA).
3. Set `CPI_CREDSTORE_KEY<N>` to that credential's name for the tenant migrating to it, and remove
   `CPI_CLIENT_SECRET<N>` for that same tenant (the code prefers the plain var if both are set,
   which would silently defeat the point).

**How it actually authenticates** — confirmed against a real binding, not just documentation:
Credential Store instances can bind with either **Basic auth** (`username`/`password` in the
binding — the common case, e.g. on trial-plan instances) or **mTLS** (`certificate`/`key`)
depending on how the instance was created; `credStore.js` detects which one you have from the
binding's own fields and handles it. If the instance has `parameters.encryption.payload:
"enabled"`, every response is a JWE (RSA key-wrap + AES-GCM content) decrypted client-side with
the binding's `encryption.client_private_key` — handled transparently, no extra config needed.

**Local testing without a real CF binding:** set `CREDSTORE_URL`/`CREDSTORE_USERNAME`/
`CREDSTORE_PASSWORD` (or `CREDSTORE_CERT`/`CREDSTORE_KEY` for an mTLS instance), pulled verbatim
from `cf create-service-key <credstore-instance> local-dev` — see `.env.example` for the full
list including the encryption key variant.

---

## Role-based access control (RBAC)

Three roles, layered on top of `ALLOW_WRITE`/`confirm=true` rather than replacing them:

| Role | Scope(s) granted | Can use | Typical user |
|------|-------------------|---------|--------------|
| **Support** | `mcp.read` | Every read/list/search/download tool | Support/operations staff who only need read and monitoring access |
| **Developer** | `mcp.read`, `mcp.write` | The above, plus create/update/deploy tools | Developers who create, update and deploy integration content |
| **Architect** | `mcp.read`, `mcp.write`, `mcp.delete` | Everything, including delete/undeploy and the generic `cpi_write` / `cpi_invoke_function` escape hatches | Integration architects who may need to delete/undeploy content |

The generic escape-hatch tools (`cpi_write`, `cpi_invoke_function`) are pinned to `mcp.delete`
regardless of the HTTP method or function called — they can reach operations (arbitrary
DELETE, or destructive function imports like `DeleteValMaps`) that the curated tools don't
expose, so they're Architect-only rather than Developer-only.

This only applies to the **HTTP transport with an XSUAA binding**. The static-token and open
modes grant full access to everyone (no per-user identity to hang a role off), and the
**stdio transport is unaffected** — it's a local subprocess with no role boundary, same as before.

### Setting it up — CLI

1. `xs-security.json` defines exactly three scopes and role templates — `Support`, `Developer`,
   `Architect`. There is no legacy/default role: a caller not assigned one of these three gets
   an empty scope set and no tools at all (see `resolveOauthScopes` in `src/auth.js`), not
   silent read-only access. Push the updated descriptor:
   ```bash
   cf update-service sap-cpi-mcp-xsuaa -c xs-security.json
   cf restage sap-cpi-mcp-server
   ```
2. In BTP Cockpit → your subaccount → **Security → Role Collections**, create three
   collections — `Architect`, `Developer`, `Support` — each pulling in the matching role
   template from the `sap-cpi-mcp` app.
3. Assign your team: either manually per user (Role Collection → Edit → add by email), or —
   if you already trust an IdP like Entra ID — map IdP groups to these Role Collections under
   **Security → Trust Configuration → your IdP → Role Collection Mappings**, so membership in
   an Entra group like `MCP-Architect` grants the collection automatically at login.
4. A user's token then carries whichever scopes their Role Collection grants; `src/auth.js`
   reads them off the verified JWT and `src/domains/helpers.js` enforces them per tool call.

### Setting it up — Cockpit UI (step by step, with screenshots)

Under **Security → Role Collections**, create one collection per access level defined in
`xs-security.json`'s role templates.

![Create Role Collection: SapCpiMcp.Architect, mapped to the Architect role template.](docs/cloud-foundry-deployment/image18.png)

*Figure 18 — Create Role Collection: SapCpiMcp.Architect, mapped to the Architect role template.*

![Three role collections created: SapCpiMcp.Architect, .Developer and .Support.](docs/cloud-foundry-deployment/image19.png)

*Figure 19 — Three role collections created: SapCpiMcp.Architect, .Developer and .Support.*

| Role Collection | Role Template | Grants |
|---|---|---|
| `SapCpiMcp.Architect` | Architect | Full access, including delete/undeploy and the generic escape-hatch tools. |
| `SapCpiMcp.Developer` | Developer | Read + create/update/deploy — no deletes. |
| `SapCpiMcp.Support` | Support | Read-only: monitoring, MPL search, package/flow inspection. |

Open the relevant Role Collection and add each user under its **Users** tab — this determines
what that person (or the account they sign in with when connecting Claude) is allowed to do
through the MCP server.

> 🔒 **Redacted in this copy** — the original screenshot here showed a real user's email address
> and full name assigned to a role collection. See the screenshot security note at the very end
> of this document.

*Figure 20 — SapCpiMcp.Support role collection, with the Support role template and an assigned
user.*

### Testing a role change — watch for token caching

After moving a user between Role Collections, the change **will not show up** until they get a
genuinely new access token — MCP clients (including Claude.ai) cache the tool list and will
silently reuse a still-valid token via refresh rather than re-authenticating. `token-validity`
in `xs-security.json` is 3600s (1 hour), so a client can hold a stale scope set for up to an
hour after a role change.

To force a real re-check: fully **remove/delete the connector** in the client (not just
"Disconnect" — that alone may not clear the cached token) and re-add it from scratch, so it
goes through a brand-new OAuth login. Look for a "tools list refreshed"-style confirmation
after reconnecting, and check the tool count actually changed, before concluding a role
assignment didn't take effect.

---

## Securing the HTTP endpoint with OAuth 2.0 (XSUAA)

For the hosted (Cloud Foundry) endpoint, authentication is handled by `src/auth.js`:

1. **OAuth 2.0 (recommended)** — bind an **XSUAA** instance and the server requires a valid JWT:
   ```bash
   cf create-service xsuaa application sap-cpi-mcp-xsuaa -c xs-security.json
   cf bind-service sap-cpi-mcp-server sap-cpi-mcp-xsuaa
   cf restage sap-cpi-mcp-server
   cf create-service-key sap-cpi-mcp-xsuaa claude-connector   # -> clientid/secret/url for the client
   ```
   The server verifies the JWT signature against XSUAA's JWKS (`<uaa>/token_keys`) and checks the
   audience. A client obtains a token via `client_credentials` (or `authorization_code`) from
   `<uaa>/oauth/token` and calls `/mcp` with `Authorization: Bearer <jwt>`.
2. **Static token (dev/fallback)** — if no XSUAA is bound but `MCP_AUTH_TOKEN` is set, that static
   bearer token is required instead.
3. **Open** — if neither is configured, the endpoint is unauthenticated (local/PoC only).

Auth mode is auto-detected: XSUAA binding → OAuth; else `MCP_AUTH_TOKEN` → static; else open.
The **local stdio** transport is unaffected by all of this.

### OAuth discovery / authorize / token proxy (remote MCP clients)

Remote MCP OAuth clients (e.g. a Claude custom connector) resolve the authorization server
either via [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414) discovery at this origin, or —
if that's absent — by assuming `/authorize` and `/token` live on the MCP server's own host.
XSUAA's real endpoints live on a different host (the UAA tenant), so without help the client
gets a 404 hitting `<this-origin>/authorize` directly.

When an XSUAA binding is present, the server exposes:

| Route | Purpose |
|-------|---------|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata pointing at the real XSUAA `authorization_endpoint` / `token_endpoint` |
| `GET /authorize` | Redirects to the real XSUAA `/oauth/authorize`, forwarding all query params (`client_id`, `redirect_uri`, `code_challenge`, `state`, ...) as-is |
| `POST /token` | Proxies the code/token exchange to the real XSUAA `/oauth/token` and relays its response verbatim |

If no XSUAA binding is found, these routes are not mounted and a warning is logged at startup.
This is purely a discovery/proxy convenience for OAuth clients — it does not replace the JWT
verification in `authMiddleware()`, which still gates every request to `/mcp`.

---

## Deploying to SAP BTP Cloud Foundry

For team use or Claude Enterprise chat — the cloud chat can only reach a **remote** server, not a
local process. Everything below can be done entirely through the **BTP Cockpit web UI** (no local
`cf` CLI needed); an [Appendix](#cf-cli-quick-reference) at the end gives the equivalent CLI
commands for scripting the same deployment.

### What you'll end up with

- A running Cloud Foundry application (`sap-cpi-mcp-server`) that exposes the MCP server over
  HTTPS at a `/mcp` endpoint.
- The application securely calling your SAP CPI tenant's OData APIs using OAuth client
  credentials.
- An XSUAA-protected front door, so only users assigned to an approved role collection can reach
  the MCP endpoint.
- Claude connected to that endpoint as a custom connector, able to call all 48 CPI tools directly
  from a chat.

### Architecture at a glance

| Component | Role |
|---|---|
| GitHub repository (`sap-cpi-mcp-server`) | Node.js MCP server source code — 48 tools for CPI monitoring and management. |
| Cloud Foundry application (`sap-cpi-mcp-server`) | Runs the MCP server as an HTTP service; exposes `/health` and `/mcp` endpoints. |
| Process Integration Runtime service key | OAuth client the app uses to call your CPI tenant's OData / monitoring APIs. |
| XSUAA service instance (`sap-cpi-mcp-server-xsuaa`) | Issues OAuth tokens that protect the `/mcp` endpoint from unauthenticated access. |
| Role Collections | Map SAP BTP users to Architect / Developer / Support levels of access on the MCP server. |
| Claude custom connector | Calls the deployed `/mcp` endpoint over HTTPS, authenticating via the XSUAA OAuth credentials. |

### Prerequisites

- An SAP BTP account (trial or licensed) with entitlement for Cloud Foundry Runtime and
  Authorization and Trust Management Service.
- Space Developer authorization on the target Cloud Foundry space.
- Rights to create a Process Integration Runtime service key on the CPI subaccount (for OAuth
  credentials — see [Get your SAP CPI API credentials](#get-your-sap-cpi-api-credentials-one-time)).
- A Claude plan that supports custom connectors (Settings → Connectors).

### Part A — Package the MCP server for deployment

**Step 1 — Download the source code.** Go to the GitHub repository → **Code → Download ZIP**.

![The sap-cpi-mcp-server GitHub repository, Code → Download ZIP.](docs/cloud-foundry-deployment/image1.png)

*Figure 1 — The sap-cpi-mcp-server GitHub repository, Code → Download ZIP.*

**Step 2 — Prepare the deployment ZIP.** Cloud Foundry's buildpack looks for `package.json` at
the root of the uploaded archive. GitHub's downloaded ZIP wraps everything inside a folder (e.g.,
`sap-cpi-mcp-server-main/`), so it needs to be re-zipped:

1. Extract the downloaded ZIP and open the extracted folder.
2. Select `package.json`, `package-lock.json` and the `src` folder (do not select the enclosing
   folder itself).
3. Right-click → **Send to → Compressed (zipped) folder**, and name it `sap-cpi-mcp-server.zip`.

![Selecting package.json, package-lock.json and src, then Send to → Compressed (zipped) folder.](docs/cloud-foundry-deployment/image2.png)

*Figure 2 — Selecting package.json, package-lock.json and src, then Send to → Compressed (zipped)
folder.*

> ⚠️ **Watch out:** If you instead zip the whole extracted folder, `package.json` ends up one
> level too deep and staging will fail with a "module not found" style error. Verify the new zip
> opens straight into `package.json`, `src/`, etc. — not into another folder.

### Part B — Set up Cloud Foundry on SAP BTP

**Step 3 — Enable the Cloud Foundry environment.** In the BTP Cockpit, open your subaccount's
Overview page. If Cloud Foundry hasn't been enabled yet, do so from here.

![Subaccount Overview, with the Cloud Foundry Environment panel and Enable Cloud Foundry.](docs/cloud-foundry-deployment/image3.png)

*Figure 3 — Subaccount Overview, with the Cloud Foundry Environment panel and Enable Cloud
Foundry.*

![Cloud Foundry Environment details: API endpoint, org name/ID, and the Spaces list.](docs/cloud-foundry-deployment/image4.png)

*Figure 4 — Cloud Foundry Environment details: API endpoint, org name/ID, and the Spaces list.*

**Step 4 — Create a space.** Click **Create Space** (top-right of the Spaces panel shown above)
and name it — for example, `dev`. This is the space you will deploy the application into.

### Part C — Deploy the application

**Step 5 — Deploy via BTP Cockpit.** Open the `dev` space → **Applications** and click
**Deploy Application**.

![The Deploy Application dialog: File location, Deploy with (Manifest/Custom Settings), Manifest location.](docs/cloud-foundry-deployment/image5.png)

*Figure 5 — The Deploy Application dialog: File location, Deploy with (Manifest/Custom
Settings), Manifest location.*

1. Upload the re-zipped file (`sap-cpi-mcp-server.zip`) at **File location**.
2. Keep **Deploy with** set to **Manifest**.
3. Browse to `manifest.yml` from the extracted folder for **Manifest location**.
4. Keep **Start application after deploy** checked, then click **Deploy**.

![Dialog filled in with sap-cpi-mcp-server.zip and manifest.yml, ready to deploy.](docs/cloud-foundry-deployment/image6.png)

*Figure 6 — Dialog filled in with sap-cpi-mcp-server.zip and manifest.yml, ready to deploy.*

**Step 6 — Confirm the application is running.** Once deployment finishes, the application
appears in the Applications list with a **Started** state.

![Applications (1): sap-cpi-mcp-server, Requested State: Started.](docs/cloud-foundry-deployment/image7.png)

*Figure 7 — Applications (1): sap-cpi-mcp-server, Requested State: Started.*

Open it to see the Application Overview — buildpack, stack, and the Mapped Routes section with
the public HTTPS URL Cloud Foundry assigned to the app.

![Application Overview showing the nodejs_buildpack, cflinuxfs4 stack, and the Mapped Route.](docs/cloud-foundry-deployment/image8.png)

*Figure 8 — Application Overview showing the nodejs_buildpack, cflinuxfs4 stack, and the Mapped
Route.*

**Step 7 — Verify with a health check.** Open the Mapped Route link from Step 6 and append
`/health` to it. A healthy deployment returns a small JSON payload confirming the server name,
version, and an "ok" status.

![GET /health returning status ok, server name and version.](docs/cloud-foundry-deployment/image9.png)

*Figure 9 — GET /health returning `{ "status": "ok", "server": { "name": "sap-cpi-mcp-server",
"version": "1.0.0" } }`.*

### Part D — Connect the app to your SAP CPI tenant

**Step 8 — Create a Process Integration Runtime service key.** The app needs its own OAuth
client to call your CPI tenant's OData APIs — same steps as
[Get your SAP CPI API credentials](#get-your-sap-cpi-api-credentials-one-time) above, done on the
CPI subaccount.

**Step 9 — Configure environment variables.** In the application, go to
**User-Provided Variables** and click **Create Variable** for each of the following.

![User-Provided Variables: ALLOW_WRITE, CPI_BASE_URL, CPI_CLIENT_ID, CPI_CLIENT_SECRET, CPI_TOKEN_URL, MCP_TRANSPORT.](docs/cloud-foundry-deployment/image10.png)

*Figure 10 — User-Provided Variables: ALLOW_WRITE, CPI_BASE_URL, CPI_CLIENT_ID,
CPI_CLIENT_SECRET, CPI_TOKEN_URL, MCP_TRANSPORT.*

| Variable | Source / value | Notes |
|---|---|---|
| `CPI_BASE_URL` | Service key `url` + `/api/v1` | Tenant-management host, no `-rt` suffix. |
| `CPI_TOKEN_URL` | Service key `tokenurl` | OAuth token endpoint. |
| `CPI_CLIENT_ID` | Service key `clientid` | OAuth client identifier. |
| `CPI_CLIENT_SECRET` | Service key `clientsecret` | OAuth client credential — keep private. Or use [Credential Store](#credential-store-keeping-cpi_client_secret-out-of-manifestyml--cf-env) instead. |
| `MCP_TRANSPORT` | `http` | Required for the remote/Claude scenario (stdio is for local use only). |
| `ALLOW_WRITE` | `false` | Keep false unless the connector should be allowed to deploy/create/update/delete content. |

**Step 10 — Restage the application.** Environment variable changes only take effect after a
restage.

![Restage Application: "Restaging will cause application downtime."](docs/cloud-foundry-deployment/image11.png)

*Figure 11 — Restage Application: "Restaging will cause application downtime."*

![Application Overview after restage, confirming the app is Started and the route is live.](docs/cloud-foundry-deployment/image12.png)

*Figure 12 — Application Overview after restage, confirming the app is Started and the route is
live.*

### Part E — Secure the endpoint with XSUAA

**Step 11 — Create the XSUAA service instance.** In **Service Marketplace**, search for
**Authorization and Trust Management Service** and click **Create**.

1. Plan: **application**, Runtime Environment: **Cloud Foundry**, Space: **dev**.
2. Instance Name: `sap-cpi-mcp-server-xsuaa`.

![New Instance or Subscription: Authorization and Trust Management Service, plan application.](docs/cloud-foundry-deployment/image13.png)

*Figure 13 — New Instance or Subscription: Authorization and Trust Management Service, plan
application.*

3. On the **Parameters** step, paste the contents of `xs-security.json` from the extracted
   folder — this defines the app's `xsappname` and its OAuth scopes (`mcp.read`, `mcp.write`,
   `mcp.delete`, etc.).
4. Click **Create**.

![Parameters step with the xs-security.json scopes and descriptions pasted in.](docs/cloud-foundry-deployment/image14.png)

*Figure 14 — Parameters step with the xs-security.json scopes and descriptions pasted in.*

**Step 12 — Generate a service key for the Claude connector.** Open the new
`sap-cpi-mcp-server-xsuaa` instance → **Service Keys → Create**. These credentials are what
Claude will use to authenticate to the MCP endpoint.

![New Service Key dialog for the XSUAA instance.](docs/cloud-foundry-deployment/image15.png)

*Figure 15 — New Service Key dialog for the XSUAA instance.*

Open the key's Credentials (JSON view) to retrieve `clientid`, `clientsecret` and `url` — keep
this panel handy for Part F.

> 🔒 **Redacted in this copy** — see the screenshot security note at the very end of this
> document.

*Figure 16 — Service key credentials: clientid, clientsecret, url, identityzone, tenantid, etc.*

**Step 13 — Bind XSUAA to the application.** In the application, go to
**Service Bindings → Bind Service Instance**, choose `sap-cpi-mcp-server-xsuaa`, and confirm
the binding.

![Bind Service Instance: selecting sap-cpi-mcp-server-xsuaa (service: xsuaa, plan: application).](docs/cloud-foundry-deployment/image17.png)

*Figure 17 — Bind Service Instance: selecting sap-cpi-mcp-server-xsuaa (service: xsuaa, plan:
application).*

> **Note:** Restart or restage the app again after binding so it picks up the new
> `VCAP_SERVICES` credentials.

**Step 14 — Create Role Collections, Step 15 — Assign Users:** see
[Role-based access control](#setting-it-up--cockpit-ui-step-by-step-with-screenshots) above.

### Part F — Connect to Claude

**Step 16 — Add a custom connector in Claude.** Go to **Settings → Connectors → Add → Add
custom connector**.

![Add custom connector: Name, Remote MCP Server URL, and Advanced settings for OAuth Client ID/Secret.](docs/cloud-foundry-deployment/image21.png)

*Figure 21 — Add custom connector: Name, Remote MCP Server URL, and Advanced settings for OAuth
Client ID/Secret.*

**Step 17 — Get the remote MCP server URL.** Back in the Cockpit, open the application's
Application Overview and copy the Mapped Routes URL, then append `/mcp` to it.

![Application Overview with the Mapped Route to copy (append /mcp when pasting into Claude).](docs/cloud-foundry-deployment/image22.png)

*Figure 22 — Application Overview with the Mapped Route to copy (append /mcp when pasting into
Claude).*

> **Note:** Example: `https://sap-cpi-mcp-server.cfapps.us10-001.hana.ondemand.com/mcp`

**Step 18 — Get the OAuth Client ID & Secret.** Open the service key you created in Step 12 and
copy its `clientid` and `clientsecret` into the connector's **OAuth Client ID / OAuth Client
Secret** fields.

> 🔒 **Redacted in this copy** — same service-key credentials panel as Figure 16.

*Figure 23 — Service key credentials view used to fill in the connector's OAuth Client ID /
Secret.*

**Step 19 — Connect and authenticate.** Click **Add**, then **Connect**.

![Connector added, showing the /mcp URL and a Connect button before authentication.](docs/cloud-foundry-deployment/image24.png)

*Figure 24 — Connector added, showing the /mcp URL and a Connect button before authentication.*

1. Claude redirects to your SAP identity provider's login page.
2. Sign in with an account that has been assigned one of the `SapCpiMcp` role collections from
   Step 15.
3. Once authenticated, the connector shows as connected and all 48 MCP tools become available to
   Claude.

### Verification

Confirm the end-to-end connection with two quick prompts in a new Claude chat:

**"List out the tools available in the SAP CPI MCP server."**

![Claude listing the full MCP tool catalog: discovery/catalog, packages & flows, deployment & runtime status, and more.](docs/cloud-foundry-deployment/image25.png)

*Figure 25 — Claude listing the full MCP tool catalog: discovery/catalog, packages & flows,
deployment & runtime status, and more.*

**"List out the deployed interfaces."**

![Claude calling list_deployed_artifacts and returning the tenant's actual deployed integration flow(s).](docs/cloud-foundry-deployment/image26.png)

*Figure 26 — Claude calling list_deployed_artifacts and returning the tenant's actual deployed
integration flow(s).*

Both responses coming back with live tenant data confirm that the full chain is working:
**Claude → XSUAA-authenticated /mcp endpoint → Cloud Foundry app → SAP CPI OData API.**

### CF CLI quick reference

For readers who prefer the command line (or want to script this), the Cockpit steps above map
to:

```bash
cf login -a https://api.cf.<region>.hana.ondemand.com
cf target -o <org> -s <space>

cf push --no-start

cf set-env sap-cpi-mcp-server CPI_BASE_URL "https://<tenant>/api/v1"
cf set-env sap-cpi-mcp-server CPI_TOKEN_URL "https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token"
cf set-env sap-cpi-mcp-server CPI_CLIENT_ID "<clientid>"
cf set-env sap-cpi-mcp-server CPI_CLIENT_SECRET "<clientsecret>"
cf set-env sap-cpi-mcp-server MCP_TRANSPORT "http"
cf set-env sap-cpi-mcp-server ALLOW_WRITE "false"

cf create-service xsuaa application sap-cpi-mcp-xsuaa -c xs-security.json
cf bind-service sap-cpi-mcp-server sap-cpi-mcp-xsuaa

cf start sap-cpi-mcp-server

cf create-service-key sap-cpi-mcp-xsuaa sap-cpi-mcp-xsuaa-key
```

> **Note:** The service key created by the last command supplies the `clientid`, `clientsecret`
> and `tokenurl` to paste into Claude's custom connector — the same values Steps 12 and 18
> retrieve through the Cockpit UI.

> **Keeping `CPI_CLIENT_SECRET` out of this altogether:** see
> [Credential Store](#credential-store-keeping-cpi_client_secret-out-of-manifestyml--cf-env)
> above — bind a Credential Store instance and set `CPI_CREDSTORE_KEY` instead of
> `CPI_CLIENT_SECRET` above.

> **Security note:** `MCP_AUTH_TOKEN` (used instead of XSUAA in the static-token fallback mode)
> is a simple shared-secret gate for getting started only. For production, front the app with
> XSUAA as shown above rather than relying on a static token.

---

## Example prompts

- "List my SAP CPI integration packages."
- "Show me all failed messages in the last 4 hours."
- "Give me a failure summary for the last 24 hours grouped by integration flow."
- "Get the error details for MessageGuid `AGh...`."
- "List integration flows in package `MyIntegrationPackage` and tell me which are deployed."
- "Is the `OrderReplication` flow deployed and started? If not, why?"
- "What externalized configuration does `MyFlow` have?"
- "Deploy `MyFlow`." → Claude asks you to confirm → say yes → it deploys.
- "Run cpi_api_catalog" → discover every entity/operation the server can reach.
- "Which CPI tenants are configured?" *(multi-tenant setups — calls `list_cpi_tenants`)*
- "Show failed messages in the last 24 hours on the QA tenant." *(multi-tenant — Claude fills in `tenant=QA`)*

Claude decides which tool to call, runs it, and explains the result. For write actions it will
ask you to confirm before anything changes.

---

## Troubleshooting

### General usage

| Symptom | Fix |
|---|---|
| `404 route does not exist` | Wrong API host — drop `-rt`, use the tenant-management host + `/api/v1` |
| Tools don't appear in Claude Desktop | You didn't **fully** restart (quit from tray / Task Manager) |
| Cloud chat "times out / server unresponsive" | Cloud chat can't reach a **local** server — use the [remote (CF) deployment](#deploying-to-sap-btp-cloud-foundry) |
| `401` from the API | Wrong client id/secret, or missing roles on the service key |
| `403` on deploy/undeploy | Service key lacks deploy/edit roles |
| "Write operations are disabled" | Set `ALLOW_WRITE=true` (and restart) |
| Write tool won't run | Re-run it with `confirm=true` |
| `501 Not Implemented` (e.g. JMS on trial) | That feature isn't provisioned on your tenant/plan |
| Postman shows "Connected / Connection closed" | The server streams SSE; this build returns JSON in HTTP mode — resend |

### Cloud Foundry deployment

| Symptom | Likely cause | Fix |
|---|---|---|
| Staging fails / buildpack can't find `package.json` | The re-zipped archive still has a wrapping folder (e.g., `sap-cpi-mcp-server-main/package.json`). | Re-zip so `package.json`, `src/`, etc. sit at the root of the archive — see [Part A, Step 2](#part-a--package-the-mcp-server-for-deployment). |
| App deploys but `/health` doesn't return status ok, or the app shows CRASHED | `MCP_TRANSPORT` isn't set to `http`, or the app wasn't restaged after the variable was added. | Check the app's Logs tab; confirm `MCP_TRANSPORT=http` is set, then restage. |
| Claude connector returns 401/403 after login | The signed-in user isn't in any `SapCpiMcp` role collection, or the XSUAA instance isn't bound to the app. | Confirm Service Bindings shows `sap-cpi-mcp-server-xsuaa` bound, and assign the user to a role collection. |
| App is Running but CPI calls fail with 401 | `CPI_BASE_URL` / `CPI_CLIENT_ID` / `CPI_CLIENT_SECRET` are wrong, expired, or the service key lacks the required roles. | Recreate the Process Integration Runtime service key with the roles listed [above](#get-your-sap-cpi-api-credentials-one-time), update the variables, and restage. |

---

## Notes on the CPI OData API

- Collection base: `.../api/v1`
- MPLs: `/MessageProcessingLogs` — filter with `$filter`, sort with `$orderby=LogEnd desc`.
- Error text: `/MessageProcessingLogs('<guid>')/ErrorInformation/$value` (plain text).
- Packages: `/IntegrationPackages`, flows: `/IntegrationDesigntimeArtifacts`.
- Deployed: `/IntegrationRuntimeArtifacts`.
- Time filters use OData datetime literals: `LogEnd gt datetime'2024-01-01T00:00:00'`.

Requires **Node.js 18+** (uses the built-in `fetch`).

---

## Appendix — Environment Variables Reference

| Variable | Source | Purpose |
|---|---|---|
| `CPI_BASE_URL` | Process Integration Runtime service key, `url` field (+ `/api/v1`) | Base URL the app calls for CPI OData/monitoring APIs. |
| `CPI_TOKEN_URL` | Service key, `tokenurl` field | OAuth token endpoint for the CPI client credentials grant. |
| `CPI_CLIENT_ID` | Service key, `clientid` field | OAuth client identifier for calling CPI. |
| `CPI_CLIENT_SECRET` | Service key, `clientsecret` field | OAuth client secret for calling CPI. Alternative: `CPI_CREDSTORE_KEY` (see [Credential Store](#credential-store-keeping-cpi_client_secret-out-of-manifestyml--cf-env)). |
| `CPI_CREDSTORE_KEY` / `CPI_CREDSTORE_NAMESPACE` | Credential Store instance | Resolve the client secret from Credential Store instead of `CPI_CLIENT_SECRET`. Per-tenant via `<N>` suffix. |
| `TENANT_NAME<N>` | Set manually | Display name for tenant `<N>` in multi-tenant mode. |
| `ALLOW_WRITE` / `ALLOW_WRITE<N>` | Set manually | Boolean gate for deploy/create/update/delete tools; keep false unless intentionally enabling write access. |
| `STATUS<N>` | Set manually | `disable`/`disabled` takes a tenant out of rotation without deleting its credentials. |
| `MCP_TRANSPORT` | Set manually | `http` for the remote/Claude scenario; `stdio` for local-only use. |
| `MCP_AUTH_TOKEN` | Set manually | Static bearer-token fallback auth for the HTTP transport when no XSUAA is bound. |
| `PORT` | Set manually / CF-injected | Local HTTP port (CF injects its own). |

---

## Changelog

### 1.4.0
- **Standard practice**: `build_integration_flow`'s `deploy` argument now defaults to
  `false` (was `true`). This tool pushes content and validates it, then stops — it no
  longer deploys automatically. The expected workflow: build, read the `validation`
  field, share that analysis with the user, and let them decide whether to deploy
  (`deploy: true`) or fix something first, rather than assuming deploy should happen.
- Updated the tool's title/description and the `note` field on every non-deploying
  result to spell out this workflow explicitly, so any MCP client calling the tool
  follows it by default rather than relying on being told each time.

### 1.3.0
- HTTP adapter: `authenticationMethod:"OAuth2ClientCredentials"` confirmed working
  (2026-08-17, against a real hand-built reference channel,
  `reference_iflow_for_HTTP_Oauth_and_OData_V4_adapter`) — previously thought broken
  from a 2026-08-14 test that used the raw, unspaced enum value; CPI actually wants the
  spaced display value ("OAuth2 Client Credentials"), which the adapter already mapped
  to via `authMethodValue` but hadn't been re-tested since.
- HTTP adapter: new retry parameters — `retryOnException`, `retryIteration`,
  `retryInterval`, `retryOnConnectionFailure`, `httpErrorResponseCodes`,
  `throwExceptionOnFailure` — confirmed real property shape from the same reference
  channel.
- New `odatav4` adapter (OData V4 / HCIOData) — a distinct property set from the
  existing `odata` (V2) adapter (`csrfEnabled` not `isCSRFEnabled`,
  `connectionReuse`/`allowChunking`, `resourcePathForOdatav4`). Confirmed real from the
  same reference channel using `operation:"get"` + `OAuth2ClientCredentials`.
- **Root-cause fix**: the existing `odata` (V2) adapter's `authenticationMethod` was
  being sent through the HTTP-only spaced-display-value mapping, which is exactly
  backwards for OData — OData wants the RAW unspaced enum value. This is very likely
  why `OAuth2ClientCredentials` was previously "confirmed BROKEN" for `odata`; it's now
  sent raw, matching the confirmed-real `odatav4` reference. Not yet independently
  re-confirmed against a live V2-specific deploy.

### 1.2.0
- `build_integration_flow` no longer writes anything to this server's local disk in
  ANY mode, on either transport (local stdio or the Cloud Foundry HTTP deployment).
  `offline: true` now returns its preview zip inline as `zipBase64` instead of saving
  it to a `generated-iflows/` folder — that folder and the save-to-disk logic behind
  it are gone entirely. Decode `zipBase64` yourself locally if you want an actual file.
- `push_integration_flow_content`'s `zipFilePath` argument still exists (for a zip you
  place on the server's filesystem some other way), but no longer assumes
  `build_integration_flow` is what put it there.

### 1.1.0
- `build_integration_flow` no longer writes a copy of pushed (online) content to
  `generated-iflows/` on this server's local disk. Once content is pushed to a tenant,
  the tenant is the copy of record — `download_integration_flow(artifactId)` fetches it
  back any time it's needed (e.g. to inspect a build failure in the web editor's
  Problems tab).
- Corrected the tool count (48, not 46/45/42 as previously stated in various docs).
- Merged `GETTING-STARTED.md` and `CLOUD-FOUNDRY-DEPLOYMENT.md` into this file — one
  doc instead of three, with duplicated credential-setup/deployment/troubleshooting
  content consolidated rather than repeated.

### 1.0.0
- Initial release: monitoring, design-time content, runtime/deployment, admin, generic
  escape-hatch tools, `where_used`, multi-tenant support, RBAC, and `build_integration_flow`.

---

> #### 🔒 Before publishing any of the Cockpit screenshots above
> Figures 16 and 23 (the XSUAA service-key credentials panels) and Figure 20 (a
> role-collection user assignment) have been withheld from this document — the source
> screenshots showed a partially-visible real `clientid`/`clientsecret`/tenant identity
> zone and a real user's email/name. If image files named `image16.png`, `image20.png`,
> `image23.png` (or similar) exist in `docs/cloud-foundry-deployment/`, replace them with
> redacted/cropped versions (or a placeholder graphic) before this document goes anywhere
> public. (As of this merge, that `docs/cloud-foundry-deployment/` folder is not present
> in this checkout — the other 23 figures referenced above are placeholders pending
> whoever adds the real screenshots.)
