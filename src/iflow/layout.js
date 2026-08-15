// Wraps the vendored ELK (Eclipse Layout Kernel) bundle for automatic diagram layout.
//
// Vendored under src/vendor/ rather than an npm dependency (`npm install elkjs`)
// because this dev environment has no outbound network access to reach the npm
// registry — confirmed directly (even a plain request to a public, unrelated host
// failed identically). The vendored file is the exact same public, open-source
// elkjs browser bundle (Apache-2.0), just loaded from disk instead of node_modules.
// A deployment environment WITH registry access could swap this for a real
// `elkjs` npm dependency with no code change beyond this file's require path.
//
// Confirmed (2026-08-15): this is the SAME layout engine SAP's own Integration
// Suite web editor uses for its "Align" button (found via the browser's own
// Sources/Network panel while the user used it) — so the automatic layout
// produced here is the real thing, not an approximation of it.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ELK = require("../vendor/elk.bundled.cjs");
const elk = new ELK();

/**
 * Run ELK's layout algorithm on a graph of `{ id, width, height }` children and
 * `{ id, sources, targets }` edges. Returns the same graph shape back with `x`/`y`
 * added to every child (relative to the graph's own origin) and `sections`
 * (waypoints) added to every edge.
 */
export async function layoutWithElk(graph) {
  return elk.layout(graph);
}
