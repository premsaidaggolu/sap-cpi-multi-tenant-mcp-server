// Per-tool-call tenant context.
//
// The MCP SDK only ever calls a tool handler with (args) — same gap requestScope.js
// bridges for auth scopes. Here it's bridged for "which CPI tenant is this call for":
// domains/helpers.js resolves the caller's `tenant` argument to a registry entry
// (see cpiClient.js) and opens a scope around the handler body with runWithTenant.
// cpiClient.js then reads currentTenant() instead of process.env directly, so no
// domain file needs to know a tenant even exists.
import { AsyncLocalStorage } from "node:async_hooks";

const tenantStorage = new AsyncLocalStorage();

/** Run `fn` with `tenant` (a registry entry from cpiClient.js, or null) as the active tenant. */
export function runWithTenant(tenant, fn) {
  return tenantStorage.run({ tenant }, fn);
}

/** The tenant resolved for the in-flight tool call, or null outside one (or if unresolved). */
export function currentTenant() {
  const store = tenantStorage.getStore();
  return store ? store.tenant : null;
}
