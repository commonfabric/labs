import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { PatternCoverageSpan } from "@commonfabric/ts-transformers";

import { buildCfcPolicyArtifactManifest } from "../src/cfc/policy.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { PatternCoverageCollector } from "../src/pattern-coverage.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("test operator");

describe("Engine.compileToRecordGraph", () => {
  // Phase D3.2: the Engine ESM compile path (compileToRecordGraph) runs the
  // real CF transformer pipeline, emits per-module CommonJS, assembles content-
  // addressed records + runtime records, and security-verifies every body.

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

  it("compiles a simple program into a verified record graph", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: "export default 42;" }],
    };
    const { graph, mainSpecifier } = await engine.compileToRecordGraph(program);

    expect(mainSpecifier.startsWith("cf:module/")).toBe(true);
    expect(graph.records.has(mainSpecifier)).toBe(true);
    // Every authored module has a compiled body and a record.
    expect(graph.compiledBodies.size).toBeGreaterThan(0);
    // Runtime-module records are registered for cf:runtime/commonfabric.
    expect(graph.records.has("cf:runtime/commonfabric")).toBe(true);
    // (compileToRecordGraph throws if any body fails verification — reaching
    // here means all authored bodies passed the ESM security verifier.)
  });

  it("compiles + evaluates a program through the ESM path", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents:
          "export const answer = 42;\nexport const make = () => answer;\nexport default make;",
      }],
    };
    const { main } = await engine.compileAndEvaluateModules(program);
    expect(main).toBeDefined();
    expect((main as { answer: number }).answer).toBe(42);
    expect((main as { make(): number }).make()).toBe(42);
    // default export resolves to the same function.
    expect((main as { default(): number }).default()).toBe(42);
  });

  it("evaluates a multi-module program across an internal import", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        { name: "/dep.ts", contents: "export const base = (): number => 20;" },
        {
          name: "/main.tsx",
          contents:
            `import { base } from "./dep.ts";\nexport const total = () => base() + 22;\nexport default total;`,
        },
      ],
    };
    const { main } = await engine.compileAndEvaluateModules(program);
    expect((main as { total(): number }).total()).toBe(42);
  });

  it("evaluates a program with an authored .js module", async () => {
    // Authored `.js` sources flow through the same pipeline: the pretransform
    // injects a JS-syntax helper statement (the TS-annotated variant is a parse
    // error in .js files) and the compiler emits the module under its own name
    // (suppressed input-overwrite veto; the virtual FS separates reads/writes).
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        { name: "/math.js", contents: "export const add = (x, y) => x + y;" },
        {
          name: "/main.tsx",
          contents:
            `import { add } from "./math.js";\nexport const total = () => add(20, 22);\nexport default total;`,
        },
      ],
    };
    const { main } = await engine.compileAndEvaluateModules(program);
    expect((main as { total(): number }).total()).toBe(42);
  });

  it("rejects a program whose module contains disallowed top-level code", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        // Unwrapped top-level mutable export — the verifier must reject it.
        contents: "export const leaked = globalThis;\nexport default leaked;",
      }],
    };
    await expect(engine.compileToRecordGraph(program)).rejects.toThrow();
  });

  describe("entry-point-independent module identities", () => {
    // Step 5 (option C): per-module identities (`cf:module/<hash>`) are
    // entry-point independent — the whole-program `/<id>` prefix is stripped
    // for identity computation, so a byte-identical module shared by two
    // different programs gets the SAME identity (content-addressed
    // cross-program dedup).

    const depContents = "export const base = (): number => 20;";

    const specifierFor = async (
      program: RuntimeProgram,
      path: string,
    ): Promise<string> => {
      const { graph } = await engine.compileToRecordGraph(program);
      // specifierByPath is keyed by the resolved/prefixed path; find the entry
      // whose path ends with the authored path.
      for (const [p, spec] of graph.specifierByPath) {
        if (p.endsWith(path)) return spec;
      }
      throw new Error(`no specifier for ${path}`);
    };

    it("gives a shared module the same identity across different programs", async () => {
      const progA: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          { name: "/dep.ts", contents: depContents },
          {
            name: "/main.tsx",
            contents:
              `import { base } from "./dep.ts";\nexport default () => base() + 1;`,
          },
        ],
      };
      const progB: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          { name: "/dep.ts", contents: depContents },
          {
            name: "/main.tsx",
            // Different entry → different whole-program id, same dep.ts bytes.
            contents:
              `import { base } from "./dep.ts";\nexport default () => base() * 99;`,
          },
        ],
      };
      const depA = await specifierFor(progA, "/dep.ts");
      const depB = await specifierFor(progB, "/dep.ts");
      expect(depA).toBe(depB);
      // The prefix is gone from the identity: no whole-program hash leaks in.
      expect(depA.startsWith("cf:module/")).toBe(true);

      // The entry modules differ (different content), so their identities differ.
      const mainA = await specifierFor(progA, "/main.tsx");
      const mainB = await specifierFor(progB, "/main.tsx");
      expect(mainA).not.toBe(mainB);
    });
  });

  describe("precompiled-module seam", () => {
    // Step 4.3.4: compileToRecordGraph returns serializable per-module
    // artifacts and accepts a full set of cached bodies to skip the TypeScript
    // compile.

    const MULTI: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        { name: "/dep.ts", contents: "export const base = (): number => 20;" },
        {
          name: "/main.tsx",
          contents:
            `import { base } from "./dep.ts";\nexport const total = () => base() + 22;\nexport default total;`,
        },
      ],
    };

    // Build an identity-keyed precompiled set from a prior compile's module
    // descriptors, tagging each body so we can prove it was reused verbatim.
    const taggedFrom = (modules: { identity: string; js: string }[]) =>
      new Map(
        modules.map((
          m,
        ) => [m.identity, { js: `${m.js}\n//cached:${m.identity}` }]),
      );

    const taggedCoverageFrom = (
      modules: {
        identity: string;
        js: string;
        sourceMap?: unknown;
        patternCoverageSpans?: PatternCoverageSpan[];
      }[],
    ) =>
      new Map(
        modules.map((m) => [
          m.identity,
          {
            js: `${m.js}\n//cached:${m.identity}`,
            ...(m.sourceMap === undefined ? {} : { sourceMap: m.sourceMap }),
            ...(m.patternCoverageSpans === undefined
              ? {}
              : { patternCoverageSpans: m.patternCoverageSpans }),
          },
        ]),
      );

    it("returns a descriptor per emitted module in identity space", async () => {
      const { modules, entryIdentity, graph } = await engine
        .compileToRecordGraph(MULTI);
      // One descriptor per compiled body in the graph.
      expect(modules.length).toBe(graph.compiledBodies.size);
      // Filenames are normalized (no `/<id>` prefix leaks out).
      const filenames = modules.map((m) => m.filename);
      expect(filenames).toContain("/main.tsx");
      expect(filenames).toContain("/dep.ts");
      for (const f of filenames) {
        expect(f).not.toMatch(/^\/[A-Za-z0-9_-]{20,}\//);
      }
      // The entry's identity is among the module identities.
      expect(modules.some((m) => m.identity === entryIdentity)).toBe(true);
      // Each descriptor carries non-empty source + js; main links to dep.
      for (const m of modules) {
        expect(m.source.length).toBeGreaterThan(0);
        expect(m.js.length).toBeGreaterThan(0);
      }
      const main = modules.find((m) => m.filename === "/main.tsx")!;
      const dep = modules.find((m) => m.filename === "/dep.ts")!;
      expect(main.imports.some((i) => i.targetIdentity === dep.identity)).toBe(
        true,
      );
    });

    it("reuses a full set of precompiled bodies (cache hit) and still evaluates", async () => {
      const first = await engine.compileToRecordGraph(MULTI);
      const tagged = taggedFrom(first.modules);

      const hit = await engine.compileToRecordGraph(MULTI, {
        precompiledModules: tagged,
      });
      // Every returned body is exactly the cached body (no recompile).
      for (const m of hit.modules) {
        expect(m.js).toContain(`//cached:${m.identity}`);
      }

      // And a cache-hit graph still evaluates correctly.
      const { main } = await engine.compileAndEvaluateModules(MULTI, {
        precompiledModules: tagged,
      });
      expect((main as { total(): number }).total()).toBe(42);
    });

    it("rejects a precompiled policy manifest bound to another module", async () => {
      const policyProgram: RuntimeProgram = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
            import {
              cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
            } from "commonfabric/cfc";
            export const release = exchangeRule({
              appliesTo: THIS_POLICY,
              pre: {
                integrity: [cfcPattern.hasRole(
                  v("reviewer"), THIS_POLICY.subject, "reader",
                )],
              },
              post: { dropClause: true },
            });
            export const rules = exchangeRules([release]);
          `,
        }],
      };
      const first = await engine.compileToRecordGraph(policyProgram);
      const cached = new Map(first.modules.map((module) => {
        const inputs = module.policyManifests ?? [];
        const policyManifests = inputs.map((input) => {
          const artifact = input as ReturnType<
            typeof buildCfcPolicyArtifactManifest
          >;
          return buildCfcPolicyArtifactManifest({
            ...artifact.manifest,
            moduleIdentity: "sha256:substituted-module",
          });
        });
        return [module.identity, { js: module.js, policyManifests }];
      }));

      await expect(
        engine.compileToRecordGraph(policyProgram, {
          precompiledModules: cached,
        }),
      ).rejects.toThrow("policy manifest module identity mismatch");
    });

    it("ignores precompiled bodies without coverage spans when pattern coverage is enabled", async () => {
      const first = await engine.compileToRecordGraph(MULTI);
      const tagged = taggedFrom(first.modules);
      const coverage = new PatternCoverageCollector();

      const compiled = await engine.compileToRecordGraph(MULTI, {
        patternCoverage: coverage,
        precompiledModules: tagged,
      });
      for (const m of compiled.modules) {
        expect(m.js).not.toContain("//cached");
      }

      const { main } = engine.evaluateRecordGraph(
        compiled.id,
        compiled.graph,
        compiled.mainSpecifier,
        MULTI,
      );
      expect((main as { total(): number }).total()).toBe(42);
      expect(coverage.report().totals.coveredRuntimeLines).toBeGreaterThan(0);
    });

    it("reuses coverage precompiled bodies and restores their spans", async () => {
      const firstCoverage = new PatternCoverageCollector();
      const first = await engine.compileToRecordGraph(MULTI, {
        patternCoverage: firstCoverage,
      });
      const tagged = taggedCoverageFrom(first.modules);
      const coverage = new PatternCoverageCollector();

      const compiled = await engine.compileToRecordGraph(MULTI, {
        patternCoverage: coverage,
        precompiledModules: tagged,
      });
      for (const m of compiled.modules) {
        expect(m.js).toContain(`//cached:${m.identity}`);
      }

      const { main } = engine.evaluateRecordGraph(
        compiled.id,
        compiled.graph,
        compiled.mainSpecifier,
        MULTI,
      );
      expect((main as { total(): number }).total()).toBe(42);
      const report = coverage.report();
      expect(report.totals.runtimeLines).toBeGreaterThan(0);
      expect(report.totals.coveredRuntimeLines).toBeGreaterThan(0);
    });

    it("security-verifies UNtrusted direct precompiled injection (no blind trust)", async () => {
      // Direct `precompiledModules` injection is NOT integrity-gated, so it is
      // always SES-verified (unlike a `trustedBodies` integrity-gated full hit —
      // see the test below). Without `trustedBodies` the engine re-runs the ESM
      // body verifier on every emitted body. Feed a full (so fullHit) set where
      // one body has disallowed top-level code.
      const first = await engine.compileToRecordGraph(MULTI);
      const tampered = new Map(
        first.modules.map((m) => [m.identity, { js: m.js }]),
      );
      tampered.set(first.entryIdentity, {
        js: `"use strict";\nfetch("https://evil.example");\n`,
      });
      await expect(
        engine.compileToRecordGraph(MULTI, { precompiledModules: tampered }),
      ).rejects.toThrow();
    });

    it("trusts an integrity-gated full hit and skips body re-verification", async () => {
      // Spec (module-loading.md, threat model "the persistent compilation
      // cache"): on a warm hit the CFC integrity label — not the SES verifier —
      // is the security boundary, so re-verifying integrity-gated bodies is
      // redundant per-load work. A FULL hit delivered through the integrity-gated
      // `precompiledModulesFor` channel and flagged `trustedBodies` must NOT
      // re-run `verifyCompiledModuleBody`. The body has disallowed top-level code:
      // untrusted it is rejected; trusted it assembles the graph without
      // re-verification. `compileToRecordGraph` only verifies + builds (no eval),
      // so the disallowed body never executes — success proves verify was skipped.
      const first = await engine.compileToRecordGraph(MULTI);
      const tampered = new Map(
        first.modules.map((m) => [m.identity, { js: m.js }]),
      );
      tampered.set(first.entryIdentity, {
        js: `"use strict";\nfetch("https://evil.example");\n`,
      });
      // Trusted full hit via the integrity-gated lazy channel: the SES body
      // verifier is skipped, so the graph assembles despite the disallowed body.
      const trusted = await engine.compileToRecordGraph(MULTI, {
        trustedBodies: true,
        precompiledModulesFor: () => Promise.resolve(tampered),
      });
      expect(trusted.graph.compiledBodies.size).toBeGreaterThan(0);
    });

    it("never trusts direct precompiledModules injection, even with trustedBodies", async () => {
      // Provenance guard: `trustedBodies` skips verification ONLY for bodies that
      // arrived via the integrity-gated `precompiledModulesFor` channel. A direct,
      // caller-supplied `precompiledModules` map is untrusted injection and MUST
      // still be SES-verified — the opt-in flag alone cannot unlock the skip.
      const first = await engine.compileToRecordGraph(MULTI);
      const tampered = new Map(
        first.modules.map((m) => [m.identity, { js: m.js }]),
      );
      tampered.set(first.entryIdentity, {
        js: `"use strict";\nfetch("https://evil.example");\n`,
      });
      await expect(
        engine.compileToRecordGraph(MULTI, {
          precompiledModules: tampered,
          trustedBodies: true,
        }),
      ).rejects.toThrow();
    });

    it("ignores a partial precompiled set and recompiles the whole program", async () => {
      const first = await engine.compileToRecordGraph(MULTI);
      // Supply all but one module → not a full hit; the engine recompiles.
      const partial = taggedFrom(first.modules.slice(1));
      const result = await engine.compileToRecordGraph(MULTI, {
        precompiledModules: partial,
      });
      // Recompiled from source: no body carries the cache tag.
      for (const m of result.modules) {
        expect(m.js).not.toContain("//cached");
      }
    });
  });
});
