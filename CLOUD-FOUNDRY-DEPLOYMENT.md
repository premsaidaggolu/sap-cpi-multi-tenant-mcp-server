# Exposing SAP CPI MCP in a Cloud Foundry Application on SAP BTP

A step-by-step guide to deploying the SAP CPI MCP server on SAP BTP Cloud Foundry, securing it
with XSUAA, and connecting it to Claude as a custom connector.

Source project: [github.com/premsaidaggolu/sap-cpi-mcp-server](https://github.com/premsaidaggolu/sap-cpi-mcp-server)

Version 1.0 | August 2026

---

## 1. Overview

This guide walks through exposing the SAP CPI MCP Server — an open-source Model Context
Protocol (MCP) server that gives an AI assistant 48 tools for monitoring and managing SAP Cloud
Integration (CPI) — as a secured, internet-reachable Cloud Foundry application on SAP BTP, and
then connecting that endpoint to Claude as a custom connector.

Everything below is done entirely through the SAP BTP Cockpit web UI — no local Cloud Foundry
CLI installation is required. An appendix at the end lists the equivalent `cf` CLI commands for
readers who prefer the command line or want to script the deployment.

### What you will end up with

- A running Cloud Foundry application (`sap-cpi-mcp-server`) that exposes the MCP server over
  HTTPS at a `/mcp` endpoint.
- The application securely calling your SAP CPI tenant's OData APIs using OAuth client
  credentials.
- An XSUAA-protected front door, so only users assigned to an approved role collection can reach
  the MCP endpoint.
- Claude connected to that endpoint as a custom connector, able to call all 48 CPI tools directly
  from a chat.

## 2. Architecture at a Glance

The moving parts fit together as follows:

| Component | Role |
|---|---|
| GitHub repository (`sap-cpi-mcp-server`) | Node.js MCP server source code — 48 tools for CPI monitoring and management. |
| Cloud Foundry application (`sap-cpi-mcp-server`) | Runs the MCP server as an HTTP service; exposes `/health` and `/mcp` endpoints. |
| Process Integration Runtime service key | OAuth client the app uses to call your CPI tenant's OData / monitoring APIs. |
| XSUAA service instance (`sap-cpi-mcp-server-xsuaa`) | Issues OAuth tokens that protect the `/mcp` endpoint from unauthenticated access. |
| Role Collections | Map SAP BTP users to Architect / Developer / Support levels of access on the MCP server. |
| Claude custom connector | Calls the deployed `/mcp` endpoint over HTTPS, authenticating via the XSUAA OAuth credentials. |

## 3. Prerequisites

- An SAP BTP account (trial or licensed) with entitlement for Cloud Foundry Runtime and
  Authorization and Trust Management Service.
- Space Developer authorization on the target Cloud Foundry space.
- The MCP server source code, downloaded from
  <https://github.com/premsaidaggolu/sap-cpi-mcp-server>
- Rights to create a Process Integration Runtime service key on the CPI subaccount (for OAuth
  credentials).
- A Claude plan that supports custom connectors (Settings → Connectors).

> **Note:** This guide uses only the BTP Cockpit web UI. No `cf` CLI installation is required —
> see [Appendix A](#appendix-a--equivalent-cloud-foundry-cli-commands) if you prefer the command
> line.

---

## Part A — Package the MCP Server for Deployment

### Step 1 — Download the Source Code

Open the GitHub repository and download the project as a ZIP archive.

- Go to <https://github.com/premsaidaggolu/sap-cpi-mcp-server>.
- Click **Code → Download ZIP**.

![The sap-cpi-mcp-server GitHub repository, Code → Download ZIP.](docs/cloud-foundry-deployment/image1.png)

*Figure 1 — The sap-cpi-mcp-server GitHub repository, Code → Download ZIP.*

### Step 2 — Prepare the Deployment ZIP

Cloud Foundry's build pack looks for `package.json` at the root of the uploaded archive.
GitHub's downloaded ZIP wraps everything inside a folder (e.g., `sap-cpi-mcp-server-main/`), so
it needs to be re-zipped.

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

---

## Part B — Set Up Cloud Foundry on SAP BTP

### Step 3 — Enable the Cloud Foundry Environment

In the BTP Cockpit, open your subaccount's Overview page. If Cloud Foundry hasn't been enabled
yet, do so from here.

![Subaccount Overview, with the Cloud Foundry Environment panel and Enable Cloud Foundry.](docs/cloud-foundry-deployment/image3.png)

*Figure 3 — Subaccount Overview, with the Cloud Foundry Environment panel and Enable Cloud
Foundry.*

![Cloud Foundry Environment details: API endpoint, org name/ID, and the Spaces list.](docs/cloud-foundry-deployment/image4.png)

*Figure 4 — Cloud Foundry Environment details: API endpoint, org name/ID, and the Spaces list.*

### Step 4 — Create Space

Click **Create Space** (top-right of the Spaces panel shown above) and name it — for example,
`dev`. This is the space you will deploy the application into.

---

## Part C — Deploy the Application

### Step 5 — Deploy via BTP Cockpit

Open the `dev` space → **Applications** and click **Deploy Application**.

![The Deploy Application dialog: File location, Deploy with (Manifest/Custom Settings), Manifest location.](docs/cloud-foundry-deployment/image5.png)

*Figure 5 — The Deploy Application dialog: File location, Deploy with (Manifest/Custom
Settings), Manifest location.*

1. Upload the re-zipped file (`sap-cpi-mcp-server.zip`) at **File location**.
2. Keep **Deploy with** set to **Manifest**.
3. Browse to `manifest.yml` from the extracted folder for **Manifest location**.
4. Keep **Start application after deploy** checked, then click **Deploy**.

![Dialog filled in with sap-cpi-mcp-server.zip and manifest.yml, ready to deploy.](docs/cloud-foundry-deployment/image6.png)

*Figure 6 — Dialog filled in with sap-cpi-mcp-server.zip and manifest.yml, ready to deploy.*

### Step 6 — Confirm the Application Is Running

Once deployment finishes, the application appears in the Applications list with a **Started**
state.

![Applications (1): sap-cpi-mcp-server, Requested State: Started.](docs/cloud-foundry-deployment/image7.png)

*Figure 7 — Applications (1): sap-cpi-mcp-server, Requested State: Started.*

Open it to see the Application Overview — buildpack, stack, and the Mapped Routes section with
the public HTTPS URL Cloud Foundry assigned to the app.

![Application Overview showing the nodejs_buildpack, cflinuxfs4 stack, and the Mapped Route.](docs/cloud-foundry-deployment/image8.png)

*Figure 8 — Application Overview showing the nodejs_buildpack, cflinuxfs4 stack, and the Mapped
Route.*

### Step 7 — Verify with a Health Check

Open the Mapped Route link from Step 6 and append `/health` to it. A healthy deployment returns
a small JSON payload confirming the server name, version, and an "ok" status.

![GET /health returning status ok, server name and version.](docs/cloud-foundry-deployment/image9.png)

*Figure 9 — GET /health returning `{ "status": "ok", "server": { "name": "sap-cpi-mcp-server",
"version": "1.0.0" } }`.*

---

## Part D — Connect the App to Your SAP CPI Tenant

### Step 8 — Create a Process Integration Runtime Service Key

The app needs its own OAuth client to call your CPI tenant's OData APIs. Create this from the
CPI subaccount:

1. **Instances and Subscriptions → Create** → Service: **Process Integration Runtime**, Plan:
   **api**.
2. On the **Roles** tab, add required roles.
3. Create the instance, then create a **Service Key** for it.

From the resulting service key JSON, you'll map:

| Service key field | Environment variable |
|---|---|
| `url` (append `/api/v1`, use the tenant-management host — no "-rt") | `CPI_BASE_URL` |
| `tokenurl` | `CPI_TOKEN_URL` |
| `clientid` | `CPI_CLIENT_ID` |
| `clientsecret` | `CPI_CLIENT_SECRET` |

### Step 9 — Configure Environment Variables

In the application, go to **User-Provided Variables** and click **Create Variable** for each of
the following:

![User-Provided Variables: ALLOW_WRITE, CPI_BASE_URL, CPI_CLIENT_ID, CPI_CLIENT_SECRET, CPI_TOKEN_URL, MCP_TRANSPORT.](docs/cloud-foundry-deployment/image10.png)

*Figure 10 — User-Provided Variables: ALLOW_WRITE, CPI_BASE_URL, CPI_CLIENT_ID,
CPI_CLIENT_SECRET, CPI_TOKEN_URL, MCP_TRANSPORT.*

| Variable | Source / value | Notes |
|---|---|---|
| `CPI_BASE_URL` | Service key `url` + `/api/v1` | Tenant-management host, no `-rt` suffix. |
| `CPI_TOKEN_URL` | Service key `tokenurl` | OAuth token endpoint. |
| `CPI_CLIENT_ID` | Service key `clientid` | OAuth client identifier. |
| `CPI_CLIENT_SECRET` | Service key `clientsecret` | OAuth client credential — keep private. |
| `MCP_TRANSPORT` | `http` | Required for the remote/Claude scenario (stdio is for local use only). |
| `ALLOW_WRITE` | `false` | Keep false unless the connector should be allowed to deploy/create/update/delete content. |

### Step 10 — Restage the Application

Environment variable changes only take effect after a restage.

![Restage Application: "Restaging will cause application downtime."](docs/cloud-foundry-deployment/image11.png)

*Figure 11 — Restage Application: "Restaging will cause application downtime."*

![Application Overview after restage, confirming the app is Started and the route is live.](docs/cloud-foundry-deployment/image12.png)

*Figure 12 — Application Overview after restage, confirming the app is Started and the route is
live.*

---

## Part E — Secure the Endpoint with XSUAA

### Step 11 — Create the XSUAA Service Instance

In **Service Marketplace**, search for **Authorization and Trust Management Service** and click
**Create**.

1. Plan: **application**, Runtime Environment: **Cloud Foundry**, Space: **dev**.
2. Instance Name: `sap-cpi-mcp-server-xsuaa`.

![New Instance or Subscription: Authorization and Trust Management Service, plan application.](docs/cloud-foundry-deployment/image13.png)

*Figure 13 — New Instance or Subscription: Authorization and Trust Management Service, plan
application.*

3. On the **Parameters** step, paste the contents of `xs-security.json` from the extracted
   folder from GitHub — this defines the app's `xsappname` and its OAuth scopes (`mcp.read`,
   `mcp.write`, `mcp.delete`, etc.).
4. Click **Create**.

![Parameters step with the xs-security.json scopes and descriptions pasted in.](docs/cloud-foundry-deployment/image14.png)

*Figure 14 — Parameters step with the xs-security.json scopes and descriptions pasted in.*

### Step 12 — Generate a Service Key for the Claude Connector

Open the new `sap-cpi-mcp-server-xsuaa` instance → **Service Keys → Create**. These credentials
are what Claude will use to authenticate to the MCP endpoint.

![New Service Key dialog for the XSUAA instance.](docs/cloud-foundry-deployment/image15.png)

*Figure 15 — New Service Key dialog for the XSUAA instance.*

Open the key's Credentials (JSON view) to retrieve `clientid`, `clientsecret` and `url` — keep
this panel handy for Part F.

> 🔒 **Redacted in this copy** — the original screenshot here showed a live service key's
> credentials panel with a partially-visible real `clientid`/`clientsecret` and tenant identity
> zone. See the note at the end of this document before restoring it.

*Figure 16 — Service key credentials: clientid, clientsecret, url, identityzone, tenantid, etc.*

### Step 13 — Bind XSUAA to the Application

In the application, go to **Service Bindings → Bind Service Instance**, choose
`sap-cpi-mcp-server-xsuaa`, and confirm the binding.

![Bind Service Instance: selecting sap-cpi-mcp-server-xsuaa (service: xsuaa, plan: application).](docs/cloud-foundry-deployment/image17.png)

*Figure 17 — Bind Service Instance: selecting sap-cpi-mcp-server-xsuaa (service: xsuaa, plan:
application).*

> **Note:** Restart or restage the app again after binding so it picks up the new
> `VCAP_SERVICES` credentials.

### Step 14 — Create Role Collections

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

### Step 15 — Assign Users to Role Collections

Open the relevant Role Collection and add each user under its **Users** tab — this determines
what that person (or the account they sign in with when connecting Claude) is allowed to do
through the MCP server.

> 🔒 **Redacted in this copy** — the original screenshot here showed a real user's email address
> and full name assigned to a role collection. See the note at the end of this document.

*Figure 20 — SapCpiMcp.Support role collection, with the Support role template and an assigned
user.*

---

## Part F — Connect to Claude

### Step 16 — Add a Custom Connector in Claude

In Claude, go to **Settings → Connectors → Add → Add custom connector**.

![Add custom connector: Name, Remote MCP Server URL, and Advanced settings for OAuth Client ID/Secret.](docs/cloud-foundry-deployment/image21.png)

*Figure 21 — Add custom connector: Name, Remote MCP Server URL, and Advanced settings for OAuth
Client ID/Secret.*

### Step 17 — Get the Remote MCP Server URL

Back in the Cockpit, open the application's Application Overview and copy the Mapped Routes URL,
then append `/mcp` to it.

![Application Overview with the Mapped Route to copy (append /mcp when pasting into Claude).](docs/cloud-foundry-deployment/image22.png)

*Figure 22 — Application Overview with the Mapped Route to copy (append /mcp when pasting into
Claude).*

> **Note:** Example: `https://sap-cpi-mcp-server.cfapps.us10-001.hana.ondemand.com/mcp`

### Step 18 — Get the OAuth Client ID & Secret

Open the service key you created in Step 12 (under the `sap-cpi-mcp-server-xsuaa` instance) and
copy its `clientid` and `clientsecret` into the connector's **OAuth Client ID / OAuth Client
Secret** fields.

> 🔒 **Redacted in this copy** — same service-key credentials panel as Figure 16. See the note at
> the end of this document.

*Figure 23 — Service key credentials view used to fill in the connector's OAuth Client ID /
Secret.*

### Step 19 — Connect and Authenticate

Click **Add**, then **Connect**.

![Connector added, showing the /mcp URL and a Connect button before authentication.](docs/cloud-foundry-deployment/image24.png)

*Figure 24 — Connector added, showing the /mcp URL and a Connect button before authentication.*

1. Claude redirects to your SAP identity provider's login page.
2. Sign in with an account that has been assigned one of the `SapCpiMcp` role collections from
   Step 15.
3. Once authenticated, the connector shows as connected and all 48 MCP tools become available to
   Claude.

---

## Verification

Confirm the end-to-end connection with two quick prompts in a new Claude chat:

#### "List out the tools available in the SAP CPI MCP server."

![Claude listing the full MCP tool catalog: discovery/catalog, packages & flows, deployment & runtime status, and more.](docs/cloud-foundry-deployment/image25.png)

*Figure 25 — Claude listing the full MCP tool catalog: discovery/catalog, packages & flows,
deployment & runtime status, and more.*

#### "List out the deployed interfaces."

![Claude calling list_deployed_artifacts and returning the tenant's actual deployed integration flow(s).](docs/cloud-foundry-deployment/image26.png)

*Figure 26 — Claude calling list_deployed_artifacts and returning the tenant's actual deployed
integration flow(s).*

Both responses coming back with live tenant data confirm that the full chain is working:
**Claude → XSUAA-authenticated /mcp endpoint → Cloud Foundry app → SAP CPI OData API.**

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Staging fails / buildpack can't find `package.json` | The re-zipped archive still has a wrapping folder (e.g., `sap-cpi-mcp-server-main/package.json`). | Re-zip so `package.json`, `src/`, etc. sit at the root of the archive — see Step 2. |
| App deploys but `/health` doesn't return status ok, or the app shows CRASHED | `MCP_TRANSPORT` isn't set to `http`, or the app wasn't restaged after the variable was added. | Check the app's Logs tab; confirm `MCP_TRANSPORT=http` is set, then restage (Step 10). |
| Claude connector returns 401/403 after login | The signed-in user isn't in any `SapCpiMcp` role collection, or the XSUAA instance isn't bound to the app. | Confirm Service Bindings shows `sap-cpi-mcp-server-xsuaa` bound (Step 13), and assign the user to a role collection (Step 15). |
| App is Running but CPI calls fail with 401 | `CPI_BASE_URL` / `CPI_CLIENT_ID` / `CPI_CLIENT_SECRET` are wrong, expired, or the service key lacks the required roles. | Recreate the Process Integration Runtime service key with the roles listed in Step 8, update the variables, and restage. |

---

## Appendix A — Equivalent Cloud Foundry CLI Commands

For readers who prefer the command line (or want to script this), the Cockpit steps above map to:

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

## Appendix B — Environment Variables Reference

| Variable | Source | Purpose |
|---|---|---|
| `CPI_BASE_URL` | Process Integration Runtime service key, `url` field (+ `/api/v1`) | Base URL the app calls for CPI OData/monitoring APIs. |
| `CPI_TOKEN_URL` | Service key, `tokenurl` field | OAuth token endpoint for the CPI client credentials grant. |
| `CPI_CLIENT_ID` | Service key, `clientid` field | OAuth client identifier for calling CPI. |
| `CPI_CLIENT_SECRET` | Service key, `clientsecret` field | OAuth client secret for calling CPI. |
| `MCP_TRANSPORT` | Set manually | `http` for the remote/Claude scenario; `stdio` for local-only use. |
| `ALLOW_WRITE` | Set manually | Boolean gate for deploy/create/update/delete tools; keep false unless intentionally enabling write access. |

## Appendix C — Security Roles Reference

| Role Collection | Role Template | Typical user |
|---|---|---|
| `SapCpiMcp.Architect` | Architect | Integration architects who may need to delete/undeploy content. |
| `SapCpiMcp.Developer` | Developer | Developers who create, update and deploy integration content. |
| `SapCpiMcp.Support` | Support | Support/operations staff who only need read and monitoring access. |

---

> **⚠️ Before publishing this file or its screenshots anywhere public:** Figures 16 and 23 (the
> XSUAA service-key credentials panels) and Figure 20 (a role-collection user assignment) have
> been withheld from this copy — the source screenshots showed a partially-visible real
> `clientid`/`clientsecret`/tenant identity zone and a real user's email/name. The original image
> files (`image16.png`, `image20.png`, `image23.png`) are still sitting in
> `docs/cloud-foundry-deployment/` alongside this file; replace them with redacted/cropped
> versions (or a placeholder graphic) before this document goes anywhere public.
