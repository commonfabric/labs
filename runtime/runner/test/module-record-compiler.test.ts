import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { Source } from "@commonfabric/js-compiler";
import { compileSourcesToRecords } from "../src/sandbox/module-record-compiler.ts";
import {
  importModuleGraphNow,
  runtimeModuleRecords,
} from "../src/sandbox/esm-module-loader.ts";

import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";

// These tests drive the sync parse internals directly (below the async flow
// boundaries that normally load the deferred compiler stack), so load it here.
await ensureCompilerStack();

function files(map: Record<string, string>): Source[] {
  return Object.entries(map).map(([name, contents]) => ({ name, contents }));
}

const FABRIC_HASH = "Avcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c";

describe("compileSourcesToRecords + importModuleGraphNow (end to end)", () => {
  it("loads a multi-module compiled program through the SES module graph", () => {
    const sources = files({
      "/util.ts": `export const double = (n: number): number => n * 2;`,
      "/main.ts":
        `import { double } from "./util.ts";\nexport const run = (): number => double(21);\nexport default run;`,
    });

    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const entry = specifierByPath.get("/main.ts")!;
    const ns = importModuleGraphNow(entry, { records }) as {
      run(): number;
      default(): number;
    };

    expect(ns.run()).toBe(42);
    expect(ns.default()).toBe(42);
  });

  it("never executes exported accessors during the defining-module stamp", () => {
    // The stamp walks every export after the factory returns and keys on the
    // artifact's `.implementation`. It must read the OWN DATA descriptor —
    // a plain get would run this module-authored accessor during a
    // host-initiated pass: the throw below would fail the module load AFTER
    // its factory completed (and a getter's return value could receive the
    // module's defining stamp).
    const sources = files({
      "/hostile.ts": `export const probe = {
  get implementation(): number {
    throw new Error("boom: accessor executed during a host pass");
  },
};
export const ok = (): number => 7;`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const entry = specifierByPath.get("/hostile.ts")!;
    const ns = importModuleGraphNow(entry, { records }) as { ok(): number };
    expect(ns.ok()).toBe(7);
  });

  it("does not let a newline in a source name inject code via sourceURL", () => {
    // A file name with a newline must not break out of the `//# sourceURL=`
    // line comment and execute as code.
    (globalThis as Record<string, unknown>).__esm_injection_canary = false;
    const sources = files({
      "/evil.ts\nglobalThis.__esm_injection_canary = true;//":
        `export const x = 1;`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const spec = specifierByPath.get(
      "/evil.ts\nglobalThis.__esm_injection_canary = true;//",
    )!;
    importModuleGraphNow(spec, { records });
    expect((globalThis as Record<string, unknown>).__esm_injection_canary).toBe(
      false,
    );
    delete (globalThis as Record<string, unknown>).__esm_injection_canary;
  });

  it("resolves runtime-module imports via runtimeModuleRecords", () => {
    const sources = files({
      "/main.ts":
        `import { dbl } from "commonfabric";\nexport const run = (): number => dbl(21);`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources, {
      runtimeModules: { commonfabric: ["dbl"] },
    });
    // Merge the runtime-module record built from the host's runtime exports.
    for (
      const [spec, rec] of runtimeModuleRecords({
        commonfabric: { dbl: (x: number) => x * 2 },
      })
    ) {
      records.set(spec, rec);
    }
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { run(): number };
    expect(ns.run()).toBe(42);
  });

  it("resolves specifier aliases to content-addressed module records", () => {
    const fabricSpecifier = `cf:pattern:${FABRIC_HASH}`;
    const mountedPath = `/~cf/${FABRIC_HASH}/main.tsx`;
    const sources = files({
      "/a.tsx": `import { x } from "${fabricSpecifier}";\nexport const y = x;`,
      [mountedPath]: `export const x = 1;`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources, {
      specifierAliases: new Map([[fabricSpecifier, mountedPath]]),
      identityByPath: new Map([
        ["/a.tsx", "importer-identity"],
        [mountedPath, "mounted-identity"],
      ]),
    });

    const record = records.get(specifierByPath.get("/a.tsx")!)!;
    expect(record.resolutions?.[fabricSpecifier]).toBe(
      "cf:module/mounted-identity",
    );
  });

  it("resolves export-star specifier aliases when collecting exports", () => {
    const fabricSpecifier = `cf:pattern:${FABRIC_HASH}`;
    const mountedPath = `/~cf/${FABRIC_HASH}/main.tsx`;
    const sources = files({
      "/a.tsx": `export * from "${fabricSpecifier}";\nexport const own = 2;`,
      [mountedPath]: `export const imported = 1;`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources, {
      specifierAliases: new Map([[fabricSpecifier, mountedPath]]),
      identityByPath: new Map([
        ["/a.tsx", "importer-identity"],
        [mountedPath, "mounted-identity"],
      ]),
    });

    const record = records.get(specifierByPath.get("/a.tsx")!)!;
    expect(new Set(record.exports)).toEqual(
      new Set(["imported", "own", "__esModule"]),
    );
    expect(record.resolutions?.[fabricSpecifier]).toBe(
      "cf:module/mounted-identity",
    );
  });

  it("resolves a default import across modules (esModuleInterop)", () => {
    const sources = files({
      "/dep.ts": `const value = 7;\nexport default value;`,
      "/main.ts":
        `import dep from "./dep.ts";\nexport const run = (): number => dep + 1;`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { run(): number };
    expect(ns.run()).toBe(8);
  });

  it("supports a runtime-module record injected into the graph", () => {
    const sources = files({
      "/main.ts":
        `import { greet } from "host";\nexport const value = greet("world");`,
    });

    const { records, specifierByPath } = compileSourcesToRecords(sources, {
      runtimeModules: { host: ["greet"] },
    });
    // Provide the runtime module's implementation as a record.
    records.set("cf:runtime/host", {
      imports: [],
      exports: ["greet"],
      execute: (exports) => {
        exports.greet = (n: string) => `hi ${n}`;
      },
    });

    const entry = specifierByPath.get("/main.ts")!;
    const ns = importModuleGraphNow(entry, { records }) as { value: string };
    expect(ns.value).toBe("hi world");
  });

  it("uses a precompiled body instead of the bare transpile", () => {
    const sources = files({
      "/main.ts": `export const run = (): number => 1;`,
    });
    // A body distinguishable from what transpiling the source would produce.
    const precompiledBodies = new Map([[
      "/main.ts",
      `Object.defineProperty(exports, "__esModule", { value: true });\nexports.run = () => 99;`,
    ]]);

    const { records, specifierByPath } = compileSourcesToRecords(sources, {
      precompiledBodies,
    });
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { run(): number };
    expect(ns.run()).toBe(99);
  });

  it("wires a named re-export from another module (export { x } from)", () => {
    const sources = files({
      "/inner.ts": `export const x = (): number => 5;`,
      "/main.ts": `export { x } from "./inner.ts";`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { x(): number };
    expect(ns.x()).toBe(5);
  });

  it("collects destructured variable exports", () => {
    const sources = files({
      "/main.ts": `const o = { a: 1, b: 2 };\nexport const { a, b } = o;`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { a: number; b: number };
    expect(ns.a).toBe(1);
    expect(ns.b).toBe(2);
  });

  it("does not turn a type-only import into a runtime record edge", () => {
    // `import type` from a module that is NOT in the graph must not create a
    // dangling resolution / runtime import.
    const sources = files({
      "/main.ts":
        `import type { Foo } from "external-types";\nexport const run = (x: Foo): number => 1;`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const record = records.get(specifierByPath.get("/main.ts")!)!;
    expect(record.imports).not.toContain("external-types");
    // Loads cleanly (verifier sees no dangling edge).
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { run(x: unknown): number };
    expect(ns.run(undefined)).toBe(1);
  });

  it("does not create edges for require(...) text in strings or comments", () => {
    // `./ghost.ts` is a real sibling — a regex over the compiled text would
    // wrongly pull it in as an eagerly-executed dependency.
    const sources = files({
      "/ghost.ts": `export const boom = 1;`,
      "/main.ts": [
        `// require("./ghost.ts") in a comment must be ignored`,
        `export const s = 'see require("./ghost.ts") for details';`,
        `export const run = (): number => 1;`,
      ].join("\n"),
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const record = records.get(specifierByPath.get("/main.ts")!)!;
    expect(record.imports).not.toContain("./ghost.ts");
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { run(): number };
    expect(ns.run()).toBe(1);
  });

  it("collects enum exports", () => {
    const sources = files({
      "/main.ts": `export enum Color { Red = 1, Blue = 2 }`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { Color: Record<string, unknown> };
    expect(ns.Color.Red).toBe(1);
  });

  it("ignores type-only re-exports instead of throwing", () => {
    const sources = files({
      "/types.ts": `export interface Foo { n: number }`,
      "/main.ts":
        `export type * from "./types.ts";\nexport const run = (): number => 1;`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { run(): number };
    expect(ns.run()).toBe(1);
  });

  it("expands `export * from` re-exports (including transitively)", () => {
    const sources = files({
      "/leaf.ts": `export const a = (): number => 1;`,
      "/inner.ts":
        `export * from "./leaf.ts";\nexport const b = (): number => 2;`,
      "/main.ts":
        `export * from "./inner.ts";\nexport const c = (): number => 3;`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources);
    const ns = importModuleGraphNow(specifierByPath.get("/main.ts")!, {
      records,
    }) as { a(): number; b(): number; c(): number };
    expect(ns.a()).toBe(1); // transitively re-exported from leaf via inner
    expect(ns.b()).toBe(2); // re-exported from inner
    expect(ns.c()).toBe(3); // own export
    // `export *` does not re-export the default binding.
    const record = records.get(specifierByPath.get("/main.ts")!)!;
    expect(record.exports).not.toContain("default");
  });

  it("computes complete declared exports for an `export *` cycle (>= 3)", () => {
    // a -> b -> c -> a re-export ring; every module's declared namespace must
    // include all three names (regression for memo-poisoning on >=3 cycles).
    const sources = files({
      "/a.ts": `export * from "./b.ts";\nexport const a = 1;`,
      "/b.ts": `export * from "./c.ts";\nexport const b = 2;`,
      "/c.ts": `export * from "./a.ts";\nexport const c = 3;`,
    });
    const { records, specifierByPath } = compileSourcesToRecords(sources);
    for (const name of ["/a.ts", "/b.ts", "/c.ts"]) {
      const record = records.get(specifierByPath.get(name)!)!;
      expect(new Set(record.exports)).toEqual(
        new Set(["a", "b", "c", "__esModule"]),
      );
    }
  });

  it("assigns content-addressed specifiers (cf:module/<hash>)", () => {
    const { specifierByPath } = compileSourcesToRecords(
      files({ "/main.ts": `export const x = 1;` }),
    );
    expect(specifierByPath.get("/main.ts")!.startsWith("cf:module/")).toBe(
      true,
    );
  });
});
