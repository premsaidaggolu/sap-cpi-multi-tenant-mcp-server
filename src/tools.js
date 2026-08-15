// Aggregates all tool domains and registers them on the MCP server.
import { registerMonitoringTools } from "./domains/monitoring.js";
import { registerContentTools } from "./domains/content.js";
import { registerRuntimeTools } from "./domains/runtime.js";
import { registerAdminTools } from "./domains/admin.js";
import { registerGenericTools } from "./domains/generic.js";
import { registerWhereUsedTools } from "./domains/whereUsed.js";
import { registerTenantTools } from "./domains/tenants.js";
import { registerIflowBuilderTools } from "./domains/iflowBuilder.js";

export function registerTools(server) {
  registerTenantTools(server); // list_cpi_tenants — discover configured tenant names
  registerMonitoringTools(server); // MPL logs, message store, cancel
  registerContentTools(server); // packages, flows, mappings, configurations
  registerRuntimeTools(server); // deploy/undeploy, deployed artifacts, endpoints
  registerAdminTools(server); // security material, number ranges, data stores, queues, partners, logs
  registerGenericTools(server); // catalog + cpi_query / cpi_get_entity / cpi_invoke_function / cpi_write
  registerWhereUsedTools(server); // where_used — search a word across flow content
  registerIflowBuilderTools(server); // build_integration_flow — author + deploy real flow content from a spec
}
