import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { pattern } from "../src/builder/pattern.ts";
import {
  loadCompiledClosure,
  setCompileCacheRuntimeVersionForTesting,
  writeCompiledDocs,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";
import {
  ensureCompilerStack,
  observeCompilerStackDemandsForTestingOnly,
} from "../src/harness/deferred-compiler-stack.ts";
import type { Engine } from "../src/harness/engine.ts";
import { computeModuleHashes } from "../src/harness/module-identity.ts";
import type { CacheableModule, RuntimeProgram } from "../src/harness/types.ts";
import { type MemorySpace, Runtime } from "../src/runtime.ts";
import { captureLogs } from "./support/captured-logs.ts";

const signer = await Identity.fromPassphrase("pattern-manager load paths");
const space = signer.did();

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    { name: "/util.ts", contents: "export const double = (x:number)=>x*2;" },
    {
      name: "/main.tsx",
      contents: [
        "import { pattern, lift } from 'commonfabric';",
        "import { double } from './util.ts';",
        "const dbl = lift((x:number)=>double(x));",
        "export default pattern<{ value: number }>(({ value }) => {",
        "  return { result: dbl(value) };",
        "});",
      ].join("\n"),
    },
  ],
};

describe("pattern-manager", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtimes: Runtime[];
  let otherSpace: MemorySpace;

  /** A runtime over the shared storage, disposed after the case. */
  const newRuntime = (): Runtime => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    runtimes.push(runtime);
    return runtime;
  };

  /** Compiles `PROGRAM` into `space` and returns its entry identity. */
  const compileIntoSpace = async (runtime: Runtime): Promise<string> => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
    });
    await runtime.patternManager.flushCompileCacheWrites();
    await runtime.storageManager.synced();
    return runtime.patternManager.getArtifactEntryRef(compiled)!.identity;
  };

  const runtimeVersionOf = async (runtime: Runtime): Promise<string> => {
    const version = await runtime.patternManager.compileCacheRuntimeVersion({
      patternCoverage: false,
    });
    expect(version).toBeDefined();
    return version!;
  };

  /** Whether `target` holds a compiled closure for `entryIdentity`. */
  const holdsClosure = async (
    runtime: Runtime,
    target: MemorySpace,
    entryIdentity: string,
  ): Promise<boolean> => {
    const runtimeVersion = await runtimeVersionOf(runtime);
    const readTx = runtime.edit();
    try {
      const closure = await loadCompiledClosure(
        runtime,
        target,
        entryIdentity,
        { runtimeVersion },
        readTx,
      );
      return closure.has(entryIdentity);
    } finally {
      readTx.abort?.("closure assertion read complete");
    }
  };

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtimes = [];
    otherSpace = (await Identity.fromPassphrase("pattern-manager other space"))
      .did();
  });

  afterEach(async () => {
    for (const runtime of runtimes) {
      await runtime.patternManager.flushCompileCacheWrites();
      await runtime.dispose({ closeStorage: false });
    }
    await storageManager.close();
  });

  describe("replicatePatternToSpace()", () => {
    it("issues no replication for a pattern that carries no artifact entry", () => {
      const runtime = newRuntime();
      const handBuilt = pattern<{ label: string }>(({ label }) => ({ label }));
      using logs = captureLogs("pattern-manager");

      runtime.patternManager.replicatePatternToSpace(
        handBuilt,
        otherSpace,
        space,
      );

      expect(logs.textsOf("closure-replication-skipped")).toEqual([
        `from=${space} to=${otherSpace} reason=no-artifact-entry`,
      ]);
      expect(logs.textsOf("closure-replication-issued")).toEqual([]);
      expect(
        runtime.patternManager.accessForTestingOnly.compileCacheWrites.size,
      )
        .toBe(0);
    });

    it("issues a replication for a compiled pattern", async () => {
      const runtime = newRuntime();
      const compiled = await runtime.patternManager.compilePattern(PROGRAM, {
        space,
      });
      await runtime.patternManager.flushCompileCacheWrites();
      using logs = captureLogs("pattern-manager");

      runtime.patternManager.replicatePatternToSpace(
        compiled,
        otherSpace,
        space,
      );
      await runtime.patternManager.flushCompileCacheWrites();

      expect(logs.textsOf("closure-replication-skipped")).toEqual([]);
      expect(logs.textsOf("closure-replication-issued")).toHaveLength(1);
    });
  });

  describe("prepareSourceClosureVerification()", () => {
    /** How often `fn` asks for the compiler stack. */
    const compilerDemandsOf = async (
      fn: () => Promise<unknown>,
    ): Promise<number> => {
      let demands = 0;
      const stop = observeCompilerStackDemandsForTestingOnly(() => demands++);
      try {
        await fn();
      } finally {
        stop();
      }
      return demands;
    };

    it("asks for the compiler and reports the failure when reading a closure fails", async () => {
      // A fresh runtime has registered no attested import lists, so it reads
      // the compiled closure for them, and that read starts with the runtime
      // version.
      const entry = await compileIntoSpace(newRuntime());
      const fresh = newRuntime();
      using _version = stub(
        fresh.patternManager,
        "compileCacheRuntimeVersion",
        () => Promise.reject(new Error("version unavailable")),
      );
      using logs = captureLogs("pattern-manager");

      const demands = await compilerDemandsOf(() =>
        fresh.patternManager.prepareSourceClosureVerification(space, [entry])
      );

      expect(demands).toBeGreaterThan(0);
      expect(logs.textsOf("source-closure-preparation-read-failed")).toEqual([
        `entry=${entry} space=${space} version unavailable`,
      ]);
    });

    it("asks for no compiler and reports nothing when the read succeeds", async () => {
      const entry = await compileIntoSpace(newRuntime());
      const fresh = newRuntime();
      using logs = captureLogs("pattern-manager");

      const demands = await compilerDemandsOf(() =>
        fresh.patternManager.prepareSourceClosureVerification(space, [entry])
      );

      expect(demands).toBe(0);
      expect(logs.textsOf("source-closure-preparation-read-failed"))
        .toEqual([]);
    });
  });

  describe("compileAndRegisterModules()", () => {
    it("writes the source closure alone into the persistence space when the runtime reads no compiled closures", async () => {
      const runtime = newRuntime();
      let identity: string;
      const restore = setCompileCacheRuntimeVersionForTesting(undefined);
      try {
        const result = await runtime.patternManager.compileAndRegisterModules(
          PROGRAM,
          undefined,
          { space },
        );
        identity = runtime.patternManager.getArtifactEntryRef(
          result.main!["default"] as object,
        )!.identity;
      } finally {
        restore();
      }

      const stored = await runtime.patternManager
        .getPatternSourceProgramByIdentity(identity, space);
      expect(stored?.files.map((file) => file.name).sort()).toEqual([
        "/main.tsx",
        "/util.ts",
      ]);
      expect(await holdsClosure(runtime, space, identity)).toBe(false);
    });

    it("writes the compiled closure too when the runtime has a compile-cache version", async () => {
      const runtime = newRuntime();
      const result = await runtime.patternManager.compileAndRegisterModules(
        PROGRAM,
        undefined,
        { space },
      );
      const { identity } = runtime.patternManager.getArtifactEntryRef(
        result.main!["default"] as object,
      )!;

      expect(await holdsClosure(runtime, space, identity)).toBe(true);
    });
  });

  describe("compilePattern() given a known entry identity", () => {
    const SINGLE: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: "import { pattern } from 'commonfabric';\n" +
          "export default pattern(() => ({ ok: true }));\n",
      }],
    };

    it("compiles again when the stored compiled body fails to evaluate", async () => {
      // The stored source is genuine and the compiled document carries the
      // compiler's integrity, but its body throws as it evaluates.
      const writer = newRuntime();
      await ensureCompilerStack();
      const identity = computeModuleHashes(SINGLE).get("/main.tsx")!;
      const module: CacheableModule = {
        identity,
        filename: "/main.tsx",
        source: SINGLE.files[0].contents,
        js: "throw new Error('the stored body throws');",
        imports: [],
      };
      const runtimeVersion = await runtimeVersionOf(writer);
      expect(
        (await writer.editWithRetry((tx) => {
          writeSourceDocs(writer, space, [module], identity, tx);
          writeCompiledDocs(writer, space, [module], identity, {
            runtimeVersion,
          }, tx);
        })).error,
      ).toBeUndefined();
      await writer.storageManager.synced();

      const fresh = newRuntime();
      using logs = captureLogs("pattern-manager");
      const compiled = await fresh.patternManager.compilePattern(SINGLE, {
        space,
        knownEntryIdentity: identity,
      });

      expect(fresh.patternManager.getArtifactEntryRef(compiled)?.identity)
        .toBe(identity);
      expect(fresh.patternManager.getCompileCacheStats().byIdentityHits)
        .toBe(0);
      const misses = logs.textsOf("compile-cache-by-identity-miss");
      expect(misses).toHaveLength(1);
      expect(misses[0]).toContain(`entry=${identity}`);
      expect(misses[0]).toContain("the stored body throws");
    });

    it("loads from the stored compiled closure when its body evaluates", async () => {
      await compileIntoSpace(newRuntime());
      const fresh = newRuntime();
      const identity = computeModuleHashes(PROGRAM).get("/main.tsx")!;
      using logs = captureLogs("pattern-manager");

      const compiled = await fresh.patternManager.compilePattern(PROGRAM, {
        space,
        knownEntryIdentity: identity,
      });

      expect(fresh.patternManager.getArtifactEntryRef(compiled)?.identity)
        .toBe(identity);
      expect(fresh.patternManager.getCompileCacheStats().byIdentityHits)
        .toBe(1);
      expect(logs.textsOf("compile-cache-by-identity-miss")).toEqual([]);
    });
  });

  describe("loadPatternByIdentity()", () => {
    describe("for an export whose name a non-exported artifact also registers", () => {
      // `greeting` leaves the module as `shout` and as `default`, and the
      // lift bound locally to `shout` is registered under that same name, so
      // the artifact index holds the lift there. The load still returns the
      // export, from the module's own namespace.

      const ALIASED: RuntimeProgram = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { lift, pattern } from 'commonfabric';",
            "const shout = lift((s: string) => s.toUpperCase());",
            "const greeting = pattern<{ name: string }>(({ name }) => ({",
            "  loud: shout(name),",
            "}));",
            "export { greeting as shout };",
            "export default greeting;",
          ].join("\n"),
        }],
      };

      it("returns the exported pattern from the evaluated module", async () => {
        const runtime = newRuntime();
        const result = await runtime.patternManager.compileAndRegisterModules(
          ALIASED,
        );
        const exported = result.main!["shout"];
        const { identity } = runtime.patternManager.getArtifactEntryRef(
          exported as object,
        )!;

        expect(
          await runtime.patternManager.loadPatternByIdentity(
            identity,
            "shout",
            space,
          ),
        ).toBe(exported);
      });

      it("returns `undefined` for a symbol the module neither exports nor registers", async () => {
        const runtime = newRuntime();
        const result = await runtime.patternManager.compileAndRegisterModules(
          ALIASED,
        );
        const { identity } = runtime.patternManager.getArtifactEntryRef(
          result.main!["shout"] as object,
        )!;

        expect(
          await runtime.patternManager.loadPatternByIdentity(
            identity,
            "absent",
            space,
          ),
        ).toBeUndefined();
      });
    });

    it("retains a cold compile, writing nothing, in a space that refused the write as often as the session tries", async () => {
      // Two write-backs into `otherSpace` are refused and a third is held.
      // With the retained compile gone, the next load there compiles cold;
      // the held write-back is refused while that compile runs, so the
      // compile finishes in a space that refused the write three times.
      const runtime = newRuntime();
      const engine = runtime.harness as Engine;
      const manager = runtime.patternManager.accessForTestingOnly;
      const fixture = await engine.compileToRecordGraph(PROGRAM);
      const { entryIdentity } = fixture;
      const sourceTx = runtime.edit();
      writeSourceDocs(
        runtime,
        otherSpace,
        fixture.modules,
        entryIdentity,
        sourceTx,
      );
      runtime.prepareTxForCommit(sourceTx);
      expect((await sourceTx.commit().settled).error).toBeUndefined();
      await runtime.storageManager.synced();

      const load = () =>
        runtime.patternManager.loadPatternByIdentity(
          entryIdentity,
          "default",
          otherSpace,
        );
      const flushed = async () => {
        await runtime.patternManager.flushCompileCacheWrites();
        await runtime.storageManager.synced();
      };

      const held = Promise.withResolvers<void>();
      let writes = 0;
      manager.compileCacheWriter = () => {
        writes++;
        return writes < 3
          ? Promise.reject(new Error("the space refuses the write"))
          : held.promise;
      };

      let compiles = 0;
      let gate: Promise<void> | undefined;
      const compileStarted = Promise.withResolvers<void>();
      const original = engine.compileResolvedToRecordGraph.bind(engine);
      engine.compileResolvedToRecordGraph = (async (
        ...args: Parameters<typeof original>
      ) => {
        compiles++;
        if (gate !== undefined) {
          compileStarted.resolve();
          await gate;
        }
        return await original(...args);
      }) as typeof engine.compileResolvedToRecordGraph;

      try {
        const loaded = await load();
        await flushed();
        expect(typeof loaded).toBe("function");
        expect(compiles).toBe(1);
        expect(writes).toBe(1);

        expect(await load()).toBe(loaded);
        await flushed();
        expect(writes).toBe(2);

        expect(await load()).toBe(loaded);
        expect(writes).toBe(3);

        manager.retainedCompiles.clear();
        const release = Promise.withResolvers<void>();
        gate = release.promise;
        const cold = load();
        await compileStarted.promise;
        held.reject(new Error("the space refuses the write"));
        await runtime.patternManager.flushCompileCacheWrites();
        release.resolve();

        expect(typeof await cold).toBe("function");
        await flushed();
        expect(compiles).toBe(2);
        expect(writes).toBe(3);
        expect(manager.retainedCompiles.has(entryIdentity)).toBe(true);
        expect(await holdsClosure(runtime, otherSpace, entryIdentity))
          .toBe(false);
      } finally {
        manager.compileCacheWriter = undefined;
      }
    });
  });
});
