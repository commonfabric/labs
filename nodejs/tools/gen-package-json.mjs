// Writes `nodejs/package.json` from the `npm:` and `jsr:` specifiers declared
// in the workspace's `deno.jsonc` files. Each package gets one version (node
// resolution is flat here): the highest one any config asks for.
//
// Usage: node nodejs/tools/gen-package-json.mjs

import * as fs from "node:fs";
import * as path from "node:path";
import {
  jsrNameToNpm,
  loadWorkspace,
  NODEJS_DIR,
  splitNameVersionSubpath,
} from "../lib/workspace.mjs";

/**
 * Packages that bind to Deno-only machinery (FFI, Deno's bundler) and so have
 * no use under Node. The loader maps their specifiers to Node replacements
 * where one exists.
 */
const DENO_ONLY = new Set([
  "@jsr/db__sqlite",
  "@jsr/denosaurs__plug",
  "@jsr/deno__esbuild-plugin",
]);

/** Dependencies only the Node port itself needs. */
const NODE_PORT_DEPS = {
  "@deno/shim-deno": "^0.19.2",
  "core-js": "3.46.0",
  "esbuild": "^0.25.12",
};

function versionKey(range) {
  const m = /(\d+)\.(\d+)\.(\d+)(.*)/.exec(range ?? "");
  if (!m) return [0, 0, 0, ""];
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4]];
}

function compareVersions(a, b) {
  const ka = versionKey(a);
  const kb = versionKey(b);
  for (let i = 0; i < 3; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  // A prerelease sorts before its release.
  if (ka[3] !== kb[3]) return ka[3] === "" ? 1 : kb[3] === "" ? -1 : 0;
  return 0;
}

function collectSpecifiers(value, out) {
  if (typeof value === "string") {
    if (value.startsWith("npm:") || value.startsWith("jsr:")) out.push(value);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectSpecifiers(v, out);
  }
}

const { root, members } = loadWorkspace();
const specs = [];
for (const { config } of [root, ...members]) {
  collectSpecifiers(config.imports ?? {}, specs);
}

const deps = {};
const conflicts = [];
for (const spec of specs) {
  const kind = spec.slice(0, 3);
  const body = spec.slice(4).replace(/^\//, "");
  const { name, version } = splitNameVersionSubpath(body);
  const npmName = kind === "jsr" ? jsrNameToNpm(name) : name;
  if (DENO_ONLY.has(npmName)) continue;
  const range = version ?? "*";
  const prior = deps[npmName];
  if (prior === undefined) {
    deps[npmName] = range;
  } else if (prior !== range) {
    const winner = compareVersions(range, prior) > 0 ? range : prior;
    conflicts.push(`${npmName}: ${prior} vs ${range} -> ${winner}`);
    deps[npmName] = winner;
  }
}
Object.assign(deps, NODE_PORT_DEPS);

const sorted = Object.fromEntries(
  Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)),
);

const pkg = {
  name: "@commonfabric/nodejs",
  private: true,
  type: "module",
  description: "Node.js runtime support for the Common Fabric workspace.",
  dependencies: sorted,
};

fs.writeFileSync(
  path.join(NODEJS_DIR, "package.json"),
  JSON.stringify(pkg, null, 2) + "\n",
);

console.log(`Wrote ${Object.keys(sorted).length} dependencies.`);
for (const c of conflicts) console.log(`  version conflict: ${c}`);
