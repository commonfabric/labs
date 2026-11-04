import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  buildRecordsFromCompiled,
  type CachedCompiledModule,
  extractCompiledExports,
} from "../src/sandbox/module-record-compiler.ts";

import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";

// These tests drive the sync parse internals directly (below the async flow
// boundaries that normally load the deferred compiler stack), so load it here.
await ensureCompilerStack();

const signer = await Identity.fromPassphrase("build-from-compiled");

//
// The warm load path builds records directly from cached compiled bodies — no
// TS source, no resolve, no recompile. The export NAMES are recovered from the
// compiled JS (export * unioned transitively). These tests prove that the
// resolve-free build produces records equivalent to the source-derived ones.
//

describe("extractCompiledExports", () => {
  it("recovers exports.X assignments and Object.defineProperty re-exports", () => {
    const compiled = [
      `Object.defineProperty(exports, "__esModule", { value: true });`,
      `exports.b = exports.a = void 0;`,
      `exports.a = 1;`,
      `exports.b = 2;`,
      `Object.defineProperty(exports, "c", { enumerable: true, get: function () { return x.c; } });`,
    ].join("\n");
    const { names, starTargetSpecs } = extractCompiledExports(compiled);
    expect(new Set(names)).toEqual(new Set(["a", "b", "c"]));
    expect(names).not.toContain("__esModule");
    expect(starTargetSpecs).toEqual([]);
  });

  it("recovers export-star require specifiers", () => {
    const compiled = [
      `var tslib_1 = require("tslib");`,
      `__exportStar(require("./util.ts"), exports);`,
      `exports.z = 9;`,
    ].join("\n");
    const { names, starTargetSpecs } = extractCompiledExports(compiled);
    expect(new Set(names)).toEqual(new Set(["z"]));
    expect(starTargetSpecs).toEqual(["./util.ts"]);
  });
});

describe("buildRecordsFromCompiled (resolve-free, source-free)", () => {
  let runtime: Runtime;
  let engine: Engine;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    engine = runtime.harness as Engine;
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const PROGRAM: RuntimeProgram = {
    main: "/main.tsx",
    files: [
      {
        name: "/util.ts",
        contents: "export const a = 1;\nexport const b = 2;",
      },
      {
        name: "/reexport.ts",
        contents: `export * from "./util.ts";\nexport const c = 3;`,
      },
      {
        name: "/main.tsx",
        contents: [
          `import { pattern } from 'commonfabric';`,
          `export * from "./reexport.ts";`,
          `export const z = 9;`,
          `export default pattern<{ v: number }>(({ v }) => ({ out: v }));`,
        ].join("\n"),
      },
    ],
  };

  it("builds records whose exports + resolutions match the source-compiled graph", async () => {
    const { graph, modules } = await engine.compileToRecordGraph(PROGRAM);

    const cached: CachedCompiledModule[] = modules.map((m) => ({
      identity: m.identity,
      filename: m.filename,
      code: m.js,
      imports: m.imports,
      ...(m.sourceMap !== undefined ? { sourceMap: m.sourceMap as never } : {}),
    }));
    const built = buildRecordsFromCompiled(cached, {
      // Runtime export names so an `export *` from a runtime module (none here)
      // would resolve; harmless to pass for parity with the engine.
      runtimeModules: { commonfabric: [] },
    });

    // Map specifier → engine's normalized filename so we can identify authored
    // modules (path starts with "/") vs the injected `cfc.ts` ambient helper.
    const filenameBySpec = new Map(
      modules.map((m) => [`cf:module/${m.identity}`, m.filename]),
    );

    // Every cf:module record is reproduced from cached bodies alone.
    for (const [specifier, srcRecord] of graph.records) {
      if (!specifier.startsWith("cf:module/")) continue; // skip cf:runtime/*
      const builtRecord = built.records.get(specifier);
      expect(builtRecord, `missing built record for ${specifier}`)
        .toBeDefined();

      const filename = filenameBySpec.get(specifier);
      // Authored modules: JS-derived export names match source-derived exactly.
      // The injected `cfc.ts` helper is the one exception — its source declares
      // ambient exports (`export declare const …`) that the compiler ERASES, so
      // source-analysis over-declares names with no runtime value while the
      // compiled body assigns none. That module's namespace is unused (real
      // values come from cf:runtime/commonfabric), so the difference is benign.
      if (filename?.startsWith("/")) {
        expect(new Set(builtRecord!.exports)).toEqual(
          new Set(srcRecord.exports),
        );
      }

      // Internal (cf:module/*) resolutions must match exactly for every module.
      const internalRes = (r: Record<string, string> | undefined) =>
        Object.fromEntries(
          Object.entries(r ?? {}).filter(([, v]) => v.startsWith("cf:module/")),
        );
      expect(internalRes(builtRecord!.resolutions)).toEqual(
        internalRes(srcRecord.resolutions),
      );
    }

    // The entry's derived exports include the transitive export-* names.
    const entrySpec = built.specifierByPath.get("/main.tsx")!;
    expect(new Set(built.records.get(entrySpec)!.exports)).toEqual(
      new Set(["z", "default", "a", "b", "c", "__esModule"]),
    );
  });
});

describe("buildRecordsFromCompiled parse memo (content-addressed)", () => {
  // Two modules with unique content-hash identities and hand-written CJS bodies,
  // so the process-global parse memo is cold for them at first sight. At piece
  // boot the SAME system-app closure is rebuilt once per system pattern loaded
  // by identity, so without the memo every module is re-parsed N times; these
  // fixtures stand in for that shared closure.
  const modA: CachedCompiledModule = {
    identity: "memo-test-A-0000000000000000000000000000",
    filename: "/memo-a.ts",
    code: [
      `Object.defineProperty(exports, "__esModule", { value: true });`,
      `exports.a = void 0;`,
      `exports.a = 1;`,
    ].join("\n"),
    imports: [],
  };
  const modB: CachedCompiledModule = {
    identity: "memo-test-B-0000000000000000000000000000",
    filename: "/memo-b.ts",
    code: [
      `Object.defineProperty(exports, "__esModule", { value: true });`,
      `exports.b = void 0;`,
      `exports.b = 2;`,
    ].join("\n"),
    imports: [],
  };

  // Records projected to a comparable, order-stable shape.
  const exportsBySpecifier = (
    g: ReturnType<typeof buildRecordsFromCompiled>,
  ): [string, string[]][] =>
    [...g.records]
      .map(([specifier, r]): [string, string[]] => [
        specifier,
        [...r.exports].sort(),
      ])
      .sort(([a], [b]) => a.localeCompare(b));

  it("is transparent: repeated builds of the same closure produce identical records", () => {
    const first = buildRecordsFromCompiled([modA, modB]);
    const second = buildRecordsFromCompiled([modA, modB]);
    // Reusing a cached parse across calls must not corrupt output via shared
    // mutable state — each record gets a fresh export Set and import array.
    expect(exportsBySpecifier(second)).toEqual(exportsBySpecifier(first));
  });

  it("keys the parse memo on the compiled body, not the source identity (no cross-contamination)", () => {
    // The memo must key on the compiled body: the same source `identity` can map
    // to different compiled bytes (different compilation modes / runtime
    // versions), so serving one body's export surface for another would be a
    // correctness bug. Feed two DIFFERENT bodies under the SAME identity and
    // assert each record reflects ITS OWN body — proving the first body's parse
    // is not reused for the second.
    const id = "memo-key-identity-000000000000000000000000";
    const spec = `cf:module/${id}`;
    const exportsFor = (code: string): Set<string> => {
      const g = buildRecordsFromCompiled([{
        identity: id,
        filename: "/k.ts",
        code,
        imports: [],
      }]);
      return new Set(g.records.get(spec)!.exports);
    };
    const first = exportsFor(
      `Object.defineProperty(exports, "__esModule", { value: true });\n` +
        `exports.first = void 0;\nexports.first = 1;`,
    );
    expect(first).toEqual(new Set(["first", "__esModule"]));
    // Same identity, DIFFERENT body → must reflect the second body's exports.
    const second = exportsFor(
      `Object.defineProperty(exports, "__esModule", { value: true });\n` +
        `exports.second = void 0;\nexports.second = 2;`,
    );
    expect(second).toEqual(new Set(["second", "__esModule"]));
  });

  it("keys the import memo on the compiled body too (no cross-contamination)", () => {
    // Symmetric guard for parseCompiledImports: the runtime `require()`
    // specifiers are also derived from — and memoized by — the compiled body.
    // Feed two bodies that require() DIFFERENT specifiers under the SAME
    // identity and assert each record's imports reflect ITS OWN body, proving
    // the import memo is body-keyed (not identity-keyed) just like the exports.
    const id = "memo-imports-identity-00000000000000000000";
    const spec = `cf:module/${id}`;
    const importsFor = (code: string): string[] => {
      const g = buildRecordsFromCompiled([{
        identity: id,
        filename: "/imp.ts",
        code,
        imports: [],
      }]);
      return [...g.records.get(spec)!.imports];
    };
    const first = importsFor(
      `Object.defineProperty(exports, "__esModule", { value: true });\n` +
        `const alpha = require("./alpha.ts");`,
    );
    expect(first).toEqual(["./alpha.ts"]);
    // Same identity, DIFFERENT body → must reflect the second body's imports.
    const second = importsFor(
      `Object.defineProperty(exports, "__esModule", { value: true });\n` +
        `const beta = require("./beta.ts");`,
    );
    expect(second).toEqual(["./beta.ts"]);
  });
});

describe("buildRecordsFromCompiled precomputed record surface (Fix B)", () => {
  it("reads the persisted export/import surface and skips the body parse", () => {
    // With the precomputed fields present, buildRecordsFromCompiled must use
    // them and NOT parse the body. Persist a surface that deliberately DISAGREES
    // with the body (body exports `fromBody` and requires nothing; the doc
    // claims export `fromDoc` and import `ghost:spec`). If the record reflects
    // the persisted values, the parse was skipped.
    const id = "fixb-persisted-000000000000000000000000";
    const spec = `cf:module/${id}`;
    const built = buildRecordsFromCompiled([{
      identity: id,
      filename: "/persisted.ts",
      code: `Object.defineProperty(exports, "__esModule", { value: true });\n` +
        `exports.fromBody = void 0;\nexports.fromBody = 1;`,
      imports: [],
      exportNames: ["fromDoc"],
      starTargetSpecs: [],
      importSpecs: ["ghost:spec"],
    }]);
    const record = built.records.get(spec)!;
    expect(new Set(record.exports)).toEqual(new Set(["fromDoc", "__esModule"]));
    expect(record.exports).not.toContain("fromBody");
    expect(record.imports).toEqual(["ghost:spec"]);
  });
});
