// Writes `nodejs/package.json` from the `npm:` and `jsr:` specifiers declared
// in the workspace's `deno.jsonc` files, pinned to what `deno.lock` resolved
// them to, so that Node runs the same package versions Deno does. Each
// direct dependency gets one version (resolution is flat here): the one the
// lock gives the highest range any config asks for. Transitive packages are
// pinned through `overrides`, for each package the lock holds one version of.
//
// Usage: node nodejs/tools/gen-package-json.mjs

import * as fs from "node:fs";
import * as path from "node:path";
import {
  jsrNameToNpm,
  loadWorkspace,
  NODEJS_DIR,
  ROOT,
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
  "fake-indexeddb": "^6.2.5",
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

const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "deno.lock"), "utf8"));

/**
 * The version `deno.lock` resolved a specifier to, without peer suffixes.
 * The lock writes some ranges in a normalized form (`@0.220` for
 * `@^0.220.0`), so a specifier with no exact entry takes the highest version
 * the lock resolved any range of the same package to.
 */
function lockedVersion(kind, name, range) {
  const strip = (v) => v.replace(/_.*$/, "");
  const exact = lock.specifiers?.[`${kind}:${name}${range ? "@" + range : ""}`];
  if (exact !== undefined) return strip(exact);
  const prefix = `${kind}:${name}@`;
  const versions = Object.entries(lock.specifiers ?? {})
    .filter(([k]) => k.startsWith(prefix))
    .map(([, v]) => strip(v))
    .sort(compareVersions);
  return versions.at(-1);
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
  const range = lockedVersion(kind, name, version) ?? version ?? "*";
  const prior = deps[npmName];
  if (prior === undefined) {
    deps[npmName] = range;
  } else if (prior !== range) {
    const winner = compareVersions(range, prior) > 0 ? range : prior;
    conflicts.push(`${npmName}: ${prior} vs ${range} -> ${winner}`);
    deps[npmName] = winner;
  }
}
for (const [name, range] of Object.entries(NODE_PORT_DEPS)) {
  deps[name] ??= range;
}

const sorted = Object.fromEntries(
  Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)),
);

// Transitive pins: every package the lock holds exactly one version of,
// other than the direct dependencies, which are pinned above.
const lockedVersions = new Map();
const addLocked = (npmName, version) => {
  if (!lockedVersions.has(npmName)) lockedVersions.set(npmName, new Set());
  lockedVersions.get(npmName).add(version);
};
for (const key of Object.keys(lock.npm ?? {})) {
  const { name, version } = splitNameVersionSubpath(key);
  addLocked(name, version.replace(/_.*$/, ""));
}
for (const key of Object.keys(lock.jsr ?? {})) {
  const { name, version } = splitNameVersionSubpath(key);
  addLocked(jsrNameToNpm(name), version);
}
const overrides = {};
for (
  const [npmName, versions] of [...lockedVersions].sort(([a], [b]) =>
    a.localeCompare(b)
  )
) {
  if (versions.size !== 1 || npmName in deps || DENO_ONLY.has(npmName)) {
    continue;
  }
  overrides[npmName] = [...versions][0];
}

const pkg = {
  name: "@commonfabric/nodejs",
  private: true,
  type: "module",
  description: "Node.js runtime support for the Common Fabric workspace.",
  dependencies: sorted,
  overrides,
};

fs.writeFileSync(
  path.join(NODEJS_DIR, "package.json"),
  JSON.stringify(pkg, null, 2) + "\n",
);

console.log(
  `Wrote ${Object.keys(sorted).length} dependencies, ` +
    `${Object.keys(overrides).length} overrides.`,
);
for (const c of conflicts) console.log(`  version conflict: ${c}`);
