/**
 * ESM verifier body-vs-graph split benchmark.
 *
 * Isolates the per-module body scan (`verifyCompiledModuleBody` summed over all
 * authored bodies) from the whole-graph structural check (`verifyModuleGraph`),
 * for a small synthetic program and the real parking-coordinator pattern.
 *
 * Pre-compile everything OUTSIDE the timed regions so the bench measures only
 * the security-verify step, not the TypeScript compile.
 *
 * Run:
 *   deno bench --allow-read --allow-write --allow-net --allow-ffi --allow-env \
 *     --no-check packages/runner/test/esm-verifier.bench.ts
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import {
  verifyCompiledModuleBody,
  verifyModuleGraph,
} from "../src/sandbox/module-record-verifier.ts";
import {
  type BindingInfo,
  classifyModuleItems,
} from "../src/sandbox/compiled-bundle-verifier.ts";
import { parseFunctionText } from "../src/sandbox/compiled-js-parser.ts";
import {
  isAllowedAuthoredImportSpecifier,
  isRuntimeModuleIdentifier,
} from "../src/sandbox/runtime-module-policy.ts";
import {
  isAllowedTsLibHelperDeclaration,
  normalizeExact,
} from "../src/sandbox/tslib-helpers.ts";

// Single-pass baseline: a body verifier that omits the shadow-detection pass,
// which in `verifyCompiledModuleBody()` is a full scan over the statements
// ahead of classification. This is used ONLY in the `shadow-delta` bench groups
// to quantify the cost of the shadow-detection pass. Product code is untouched.

const EMPTY_BINDING_SET: ReadonlySet<string> = new Set<string>();

const REQUIRE_IMPORT_LEGACY = new RegExp(
  "^const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*" +
    "(?:__importDefault|__importStar)?\\s*\\(?\\s*" +
    "require\\(\\s*[\"']([^\"']+)[\"']\\s*\\)\\s*\\)?\\s*;?$",
);

/**
 * Single-pass body verifier. Omits the shadow-name scan over all statements;
 * used only to measure the overhead that the shadow-detection pass adds.
 */
function verifyCompiledModuleBodyLegacy(
  compiled: string,
  filename = "<module>",
): void {
  const wrapped = `function () {\n${compiled}\n}`;
  const parsed = parseFunctionText(wrapped, 0, wrapped.length);

  const env = new Map<string, BindingInfo>();
  const classifiable: typeof parsed.body.statements = [];
  for (const statement of parsed.body.statements) {
    const text = wrapped.slice(statement.start, statement.end).trim();
    // Inline tslib helper declarations: skip, as `verifyCompiledModuleBody()`
    // does.
    if (isAllowedTsLibHelperDeclaration(normalizeExact(text))) continue;
    const match = REQUIRE_IMPORT_LEGACY.exec(text);
    if (match && isAllowedAuthoredImportSpecifier(match[2])) {
      const [, binding, specifier] = match;
      env.set(binding, {
        kind: "import",
        dependencySpecifier: specifier,
        namespaceImport: true,
        trustedRuntimeName: isRuntimeModuleIdentifier(specifier)
          ? specifier
          : undefined,
      });
      continue;
    }
    classifiable.push(statement);
  }

  classifyModuleItems(wrapped, filename, classifiable, env, {
    requiredGuards: EMPTY_BINDING_SET,
    reservedBindings: EMPTY_BINDING_SET,
    missingGuardsErrorAt: 0,
  });
}

//
// Setup helpers
//

const signer = await Identity.fromPassphrase("bench esm verifier");

function createBenchEngine() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const engine = runtime.harness as Engine;
  return { engine, runtime, storageManager };
}

async function compileToGraph(program: RuntimeProgram) {
  const { engine, runtime, storageManager } = createBenchEngine();
  try {
    // compileToRecordGraph runs the full pipeline (TS → records → verify).
    // We keep the result for the pre-parsed bodies + record map. The verify
    // step running here does NOT affect the bench timings below — those each
    // call the verifier functions afresh on the pre-built inputs.
    return await engine.compileToRecordGraph(program);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

//
// Programs
//

/** Small: 2 authored modules, minimal bodies. */
const smallProgram: RuntimeProgram = {
  main: "/main.ts",
  files: [
    {
      name: "/labels.ts",
      contents: [
        "const defaultLabel = 'Open';",
        "export default defaultLabel;",
      ].join("\n"),
    },
    {
      name: "/main.ts",
      contents: [
        'import { pattern } from "commonfabric";',
        "import defaultLabel from './labels.ts';",
        "export default pattern(() => ({",
        "  label: defaultLabel,",
        "}));",
      ].join("\n"),
    },
  ],
};

async function loadParkingCoordinatorProgram(): Promise<RuntimeProgram> {
  const [contents, adminContents, vehiclesContents] = await Promise.all([
    Deno.readTextFile(
      new URL(
        "../../patterns/factory-outputs/parking-coordinator/main.tsx",
        import.meta.url,
      ),
    ),
    Deno.readTextFile(
      new URL("../../patterns/cfc/admin/mod.ts", import.meta.url),
    ),
    Deno.readTextFile(new URL("../../patterns/vehicles.ts", import.meta.url)),
  ]);
  return {
    main: "/factory-outputs/parking-coordinator/main.tsx",
    files: [
      { name: "/factory-outputs/parking-coordinator/main.tsx", contents },
      { name: "/cfc/admin/mod.ts", contents: adminContents },
      { name: "/vehicles.ts", contents: vehiclesContents },
    ],
  };
}

//
// Pre-compilation (outside bench timing)
//

const parkingCoordinatorProgram = await loadParkingCoordinatorProgram();

const [
  smallGraph,
  parkingGraph,
] = await Promise.all([
  compileToGraph(smallProgram),
  compileToGraph(parkingCoordinatorProgram),
]);

// Snapshot compiled bodies as plain arrays so the bench loop is allocation-free
const smallBodies = [...smallGraph.graph.compiledBodies.entries()];
const parkingBodies = [...parkingGraph.graph.compiledBodies.entries()];

// Snapshot record maps + main specifiers for graph verify
const smallRecords = smallGraph.graph.records;
const smallMainSpec = smallGraph.mainSpecifier;
const parkingRecords = parkingGraph.graph.records;
const parkingMainSpec = parkingGraph.mainSpecifier;

// Log program sizes for reference
console.error(
  `small: ${smallBodies.length} authored bodies, ` +
    `total body bytes: ${smallBodies.reduce((s, [, b]) => s + b.length, 0)}`,
);
console.error(
  `parking-coordinator: ${parkingBodies.length} authored bodies, ` +
    `total body bytes: ${parkingBodies.reduce((s, [, b]) => s + b.length, 0)}`,
);

//
// Bench naming, and the module labels it needs
//
// Performance tracking keys each benchmark's timeline by the origin file,
// group, and verbatim name, so groups and names must stay stable across
// commits — no content hashes, byte counts, or module counts. Volatile
// sizes go to stderr.
//

/** Basenames too vague to identify a module on their own. */
const GENERIC_BASENAMES = new Set([
  "mod.ts",
  "mod.tsx",
  "index.ts",
  "index.tsx",
]);

/** Strips the whole-program `/<id>` prefix from a resolved module path. */
function stripProgramPrefix(path: string, programId: string): string {
  return path.startsWith(`/${programId}/`)
    ? path.slice(programId.length + 2)
    : path;
}

/**
 * Short label for a module's source path: the basename, with the parent
 * directory prepended when the basename is generic.
 */
function moduleLabel(path: string, programId: string): string {
  const segments = stripProgramPrefix(path, programId).split("/");
  const basename = segments[segments.length - 1];
  return GENERIC_BASENAMES.has(basename) && segments.length > 1
    ? segments.slice(-2).join("/")
    : basename;
}

const parkingLabelBySpecifier = new Map<string, string>();
{
  const usedLabels = new Set<string>();
  for (const [path, specifier] of parkingGraph.graph.specifierByPath) {
    let label = moduleLabel(path, parkingGraph.id);
    // On a label collision, use the prefix-stripped path so names stay
    // unique and free of the whole-program hash.
    if (usedLabels.has(label)) {
      label = stripProgramPrefix(path, parkingGraph.id);
    }
    usedLabels.add(label);
    parkingLabelBySpecifier.set(specifier, label);
  }
}

function labelFor(specifier: string): string {
  const label = parkingLabelBySpecifier.get(specifier);
  if (label === undefined) {
    throw new Error(`no label for module specifier ${specifier}`);
  }
  return label;
}

//
// Benchmarks: small program
//

Deno.bench(
  "body verify: small",
  { group: "small", baseline: true },
  () => {
    for (const [specifier, body] of smallBodies) {
      verifyCompiledModuleBody(body, specifier);
    }
  },
);

Deno.bench(
  "graph verify: small",
  { group: "small" },
  () => {
    verifyModuleGraph(smallRecords, smallMainSpec);
  },
);

//
// Benchmarks: parking-coordinator (large)
//

Deno.bench(
  "body verify: parking",
  { group: "parking", baseline: true },
  () => {
    for (const [specifier, body] of parkingBodies) {
      verifyCompiledModuleBody(body, specifier);
    }
  },
);

Deno.bench(
  "graph verify: parking",
  { group: "parking" },
  () => {
    verifyModuleGraph(parkingRecords, parkingMainSpec);
  },
);

// Per-module body verify: one bench per authored module (parking only, to
// show per-module cost distribution — body size varies widely in a real
// pattern, the per-module numbers help pinpoint which module dominates).

console.error(
  "parking-coordinator modules: " +
    parkingBodies
      .map(([specifier, body]) =>
        `${labelFor(specifier)} (${body.length} bytes)`
      )
      .join(", "),
);

for (const [specifier, body] of parkingBodies) {
  Deno.bench(
    `body: ${labelFor(specifier)}`,
    { group: "per-module" },
    () => {
      verifyCompiledModuleBody(body, specifier);
    },
  );
}

//
// Shadow-detection pass overhead, dominant module
//
// Compare `verifyCompiledModuleBody()` (two passes: shadow-scan + classify)
// against the single-pass verifier above, to gauge what the shadow-detection
// pass costs.
//

// Use only the dominant large module (first parking body by size) for the
// per-module delta, so the signal is not diluted by tiny modules.
const [dominantSpec, dominantBody] = parkingBodies.reduce((max, cur) =>
  cur[1].length > max[1].length ? cur : max
);

console.error(
  `dominant module: ${labelFor(dominantSpec)} (${dominantBody.length} bytes)`,
);

Deno.bench(
  "two-pass: dominant",
  { group: "shadow-delta", baseline: true },
  () => {
    verifyCompiledModuleBody(dominantBody, dominantSpec);
  },
);

Deno.bench(
  "single-pass: dominant",
  { group: "shadow-delta" },
  () => {
    verifyCompiledModuleBodyLegacy(dominantBody, dominantSpec);
  },
);

//
// Shadow-detection pass overhead, all parking bodies summed
//

Deno.bench(
  "two-pass: parking",
  { group: "shadow-delta-all", baseline: true },
  () => {
    for (const [specifier, body] of parkingBodies) {
      verifyCompiledModuleBody(body, specifier);
    }
  },
);

Deno.bench(
  "single-pass: parking",
  { group: "shadow-delta-all" },
  () => {
    for (const [specifier, body] of parkingBodies) {
      verifyCompiledModuleBodyLegacy(body, specifier);
    }
  },
);
