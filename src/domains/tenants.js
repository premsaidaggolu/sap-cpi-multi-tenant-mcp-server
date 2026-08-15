// Tenant discovery. Once 2+ CPI tenants are configured (see cpiClient.js's tenant
// registry), every other tool in this server requires a `tenant` argument — this is
// the one tool that doesn't, so a caller (human or AI client) can always find out
// what the valid names are before picking one.
import { listTenantNames, isMultiTenant } from "../cpiClient.js";
import { readHandler, registerScopedTool } from "./helpers.js";

export function registerTenantTools(server) {
  registerScopedTool(
    server,
    "list_cpi_tenants",
    {
      title: "List Configured CPI Tenants",
      description:
        "List the SAP CPI tenants this MCP server is configured to reach. Call this first if it " +
        "isn't already clear which tenant to use — every other tool takes a `tenant` argument " +
        "once 2 or more tenants are configured, and this is how to find the valid names.",
      inputSchema: {},
    },
    readHandler(
      () => {
        const names = listTenantNames();
        const multi = isMultiTenant();
        return {
          multiTenant: multi,
          tenants: names,
          note: multi
            ? "Pass one of these names as the `tenant` argument on every other tool call."
            : names.length === 1
              ? `Only one tenant ("${names[0]}") is configured — no \`tenant\` argument is needed elsewhere.`
              : "No multi-tenant config found — this server is running against the single tenant in its plain CPI_BASE_URL/etc. env vars.",
        };
      },
      { noTenant: true }
    ),
    { noTenantArg: true }
  );
}
