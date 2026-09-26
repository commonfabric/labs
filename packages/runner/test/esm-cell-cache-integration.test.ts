import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { PatternCoverageCollector } from "../src/pattern-coverage.ts";
import type { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
} from "../src/storage/interface.ts";
import {
  compiledDocKey,
  compiledDocWriteSchema,
  getCompileCacheRuntimeVersion,
  loadCompiledClosure,
  loadVerifiedSourceClosure,
  setCompileCacheRuntimeVersionForTesting,
  sourceDocKey,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();
const resolvedRuntimeVersion = await getCompileCacheRuntimeVersion();
if (resolvedRuntimeVersion === undefined) {
  throw new Error("compile-cache runtime version unavailable in Deno test");
}
const runtimeVersion = resolvedRuntimeVersion;
const coverageRuntimeVersion = `${runtimeVersion}/pattern-coverage`;

describe("ESM compile via content-addressed cell cache", () => {
  // Step 5: PatternManager drives the content-addressed cell cache on the ESM
  // path — cold compiles write the module set back (CFC-stamped), warm compiles
  // reuse it, and the cache is gated on CFC enforcement.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

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

  const newRuntime = (patternCoverage?: PatternCoverageCollector) =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      ...(patternCoverage === undefined ? {} : { patternCoverage }),
    });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = newRuntime();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await runtime?.patternManager.flushCompileCacheWrites();
    await tx.commit();
    await runtime?.dispose({ closeStorage: false });
    await storageManager?.close();
  });

  const run = async (compiled: unknown, value: number): Promise<unknown> => {
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      `cell-cache run ${value}`,
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const result = runtime.run(tx, compiled as any, { value }, resultCell);
    await tx.commit();
    tx = runtime.edit();
    await result.pull();
    return result.getAsQueryResult();
  };

  for (const preview of ["compile", "load"]) {
    for (const filename of ["/main.tsx", "/child.tsx"]) {
      it(`repairs ${filename} after a ${preview} preview indexes its artifact`, async () => {
        const program: RuntimeProgram = {
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents:
              'import { pattern } from "commonfabric"; import Child from "./child.tsx"; export const child = Child; export default pattern<{value: number}>(({value}) => ({value}));',
          }, {
            name: "/child.tsx",
            contents:
              'import { pattern } from "commonfabric"; export default pattern<{value: number}>(({value}) => ({value}));',
          }],
        };
        const pattern = await runtime.patternManager.compilePattern(program, {
          space,
        });
        const entry = runtime.patternManager.getArtifactEntryRef(pattern)!;
        const closure = await loadVerifiedSourceClosure(
          runtime,
          space,
          entry.identity,
          tx,
        );
        const identity = [...closure!].find(([, doc]) =>
          doc.filename === filename
        )![0];
        const version = "preview-recovery-next-runtime";
        const restoreVersion = setCompileCacheRuntimeVersionForTesting(version);
        const reader = newRuntime();
        try {
          if (preview === "compile") {
            await reader.patternManager.compilePattern(program, {
              space,
              persist: false,
            });
          } else {
            await reader.patternManager.loadPatternByIdentity(
              entry.identity,
              "default",
              space,
              { repairCache: false },
            );
          }
          const readCache = async () => {
            const readTx = reader.edit();
            try {
              return await loadCompiledClosure(reader, space, identity, {
                runtimeVersion: version,
              }, readTx);
            } finally {
              readTx.abort();
            }
          };
          await reader.patternManager.flushCompileCacheWrites();
          expect((await readCache()).has(identity)).toBe(false);
          expect(
            await reader.patternManager.loadPatternByIdentity(
              identity,
              "default",
              space,
            ),
          ).toBeDefined();
          await reader.patternManager.flushCompileCacheWrites();
          expect((await readCache()).has(identity)).toBe(true);
        } finally {
          restoreVersion();
          await reader.dispose({ closeStorage: false });
        }
      });
    }
  }

  it("returns undefined for a missing preview export without scheduling cache repair", async () => {
    const pattern = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const entry = runtime.patternManager.getArtifactEntryRef(pattern)!;
    const reader = newRuntime();
    let writes = 0;
    reader.patternManager.accessForTestingOnly.compileCacheWriter = () => {
      writes++;
      return Promise.resolve();
    };
    try {
      expect(
        await reader.patternManager.loadPatternByIdentity(
          entry.identity,
          "missing",
          space,
          { repairCache: false },
        ),
      ).toBeUndefined();
      await reader.patternManager.flushCompileCacheWrites();
      expect(writes).toBe(0);
      expect(
        await reader.patternManager.loadPatternByIdentity(
          entry.identity,
          "default",
          space,
          { repairCache: false },
        ),
      ).toBeDefined();
    } finally {
      await reader.dispose({ closeStorage: false });
    }
  });

  it("cold compile writes back, warm compile is a hit, both run correctly", async () => {
    const pm = runtime.patternManager;

    // Cold compile (miss): evaluates correctly and durably writes back before
    // returning.
    const cold = await pm.compilePattern(PROGRAM, { space, tx });
    expect(await run(cold, 3)).toEqual({ result: 6 });
    expect(pm.getCompileCacheStats()).toEqual({
      hits: 0,
      misses: 1,
      byIdentityHits: 0,
    });

    // The write-back is awaited by compilePattern; flushing remains harmless and
    // keeps the test aligned with other cache paths.
    await pm.flushCompileCacheWrites();

    // Warm compile (hit): served from the cache, still evaluates correctly.
    const warm = await pm.compilePattern(PROGRAM, { space, tx });
    expect(pm.getCompileCacheStats()).toEqual({
      hits: 1,
      misses: 1,
      byIdentityHits: 0,
    });
    expect(await run(warm, 5)).toEqual({ result: 10 });
  });

  it("restores compiler-verified policy manifests on a warm hit", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
          import { pattern } from "commonfabric";
          import {
            cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
          } from "commonfabric/cfc";
          export const release = exchangeRule({
            appliesTo: THIS_POLICY,
            pre: {
              integrity: [cfcPattern.hasRole(
                v("user"), THIS_POLICY.subject, "reader"
              )],
            },
            post: { addAlternatives: [cfcPattern.user(v("user"))] },
          });
          export const rules = exchangeRules([release]);
          export default pattern(() => ({ ok: true }));
        `,
      }],
    };
    const pm = runtime.patternManager;
    await pm.compilePattern(program, { space, tx });
    await pm.flushCompileCacheWrites();
    await pm.compilePattern(program, { space, tx });
    expect(pm.getCompileCacheStats()).toEqual({
      hits: 1,
      misses: 1,
      byIdentityHits: 0,
    });
  });

  it("warm load BY IDENTITY skips resolve+compile entirely", async () => {
    const pm = runtime.patternManager;
    // Cold compile to populate the cache + learn the entry identity.
    await pm.compilePattern(PROGRAM, { space, tx });
    await pm.flushCompileCacheWrites();
    const { entryIdentity } = await (runtime.harness as Engine)
      .compileToRecordGraph(PROGRAM);

    // Load again WITH the known entry identity → resolve-free fast path.
    const warm = await pm.compilePattern(PROGRAM, {
      space,
      tx,
      knownEntryIdentity: entryIdentity,
    });
    const stats = pm.getCompileCacheStats();
    expect(stats.byIdentityHits).toBe(1);
    expect(stats.misses).toBe(1); // only the initial cold compile
    expect(await run(warm, 6)).toEqual({ result: 12 });
  });

  it("recompiles coverage documents without JSON spans before loading by identity", async () => {
    const firstCoverage = new PatternCoverageCollector();
    const firstRuntime = newRuntime(firstCoverage);
    const firstTx = firstRuntime.edit();
    try {
      const compiled = await firstRuntime.patternManager.compilePattern(
        PROGRAM,
        { space, tx: firstTx },
      );
      const entryIdentity = firstRuntime.patternManager.getArtifactEntryRef(
        compiled,
      )!.identity;

      const readTx = firstRuntime.edit();
      const closure = await loadCompiledClosure(
        firstRuntime,
        space,
        entryIdentity,
        { runtimeVersion: coverageRuntimeVersion },
        readTx,
      );
      readTx.abort?.("coverage closure read complete");
      expect(closure.size).toBeGreaterThan(0);
      for (const doc of closure.values()) {
        expect(Array.isArray(doc.patternCoverageSpans)).toBe(true);
      }

      const legacyTx = firstRuntime.edit();
      const previousIdentity = legacyTx.getCfcState().implementationIdentity;
      setCfcImplementationIdentity(legacyTx, {
        kind: "builtin",
        builtinId: "compile-cache",
      });
      try {
        for (const identity of closure.keys()) {
          const cell = firstRuntime.getCell(
            space,
            compiledDocKey(coverageRuntimeVersion, identity),
            compiledDocWriteSchema(),
            legacyTx,
          );
          const stored = { ...(cell.get() as Record<string, unknown>) };
          delete stored.patternCoverageSpansJson;
          cell.set(stored);
        }
      } finally {
        setCfcImplementationIdentity(legacyTx, previousIdentity);
      }
      legacyTx.prepareCfc();
      expect((await legacyTx.commit()).error).toBeUndefined();

      const restoredCoverage = new PatternCoverageCollector();
      const restoredRuntime = newRuntime(restoredCoverage);
      try {
        const restored = await restoredRuntime.patternManager
          .loadPatternByIdentity(entryIdentity, "default", space);
        expect(typeof restored).toBe("function");
        await restoredRuntime.patternManager.flushCompileCacheWrites();
        expect(restoredCoverage.report().files.length).toBeGreaterThan(0);

        const inspectTx = restoredRuntime.edit();
        for (const identity of closure.keys()) {
          const stored = restoredRuntime.getCell(
            space,
            compiledDocKey(coverageRuntimeVersion, identity),
            compiledDocWriteSchema(),
            inspectTx,
          ).get() as Record<string, unknown>;
          expect(typeof stored.patternCoverageSpansJson).toBe("string");
        }
        inspectTx.abort?.("repaired coverage closure inspection complete");
      } finally {
        await restoredRuntime.dispose({ closeStorage: false });
      }
    } finally {
      firstTx.abort?.("coverage format recovery test complete");
      await firstRuntime.dispose({ closeStorage: false });
    }
  });

  it("repairs missing source data before a known-identity warm load", async () => {
    const pm = runtime.patternManager;
    const cold = await pm.compilePattern(PROGRAM, { space, tx });
    const entryIdentity = pm.getArtifactEntryRef(cold)!.identity;

    const damageTx = runtime.edit();
    runtime.getCell(
      space,
      sourceDocKey(entryIdentity),
      undefined,
      damageTx,
    ).set({ damaged: true });
    expect((await damageTx.commit()).error).toBeUndefined();

    const repaired = await pm.compilePattern(PROGRAM, {
      space,
      tx,
      knownEntryIdentity: entryIdentity,
    });
    expect(pm.getCompileCacheStats()).toEqual({
      hits: 1,
      misses: 1,
      byIdentityHits: 0,
    });
    expect(await run(repaired, 4)).toEqual({ result: 8 });

    const readTx = runtime.edit();
    const source = await loadVerifiedSourceClosure(
      runtime,
      space,
      entryIdentity,
      readTx,
    );
    readTx.abort?.("known-identity source repair probe complete");
    expect(source?.has(entryIdentity)).toBe(true);
  });

  it("persists the derived record surface and reads it back (Fix B round-trip)", async () => {
    // Guards the Fix B perf win against a SILENT regression: because the parse
    // fallback yields byte-identical records, a pattern still loads + runs
    // correctly even if the surface never persisted — so "it runs" is not enough.
    // Assert the fields actually survive writeCompiledDocs -> storage ->
    // loadCompiledClosure, i.e. buildRecordsFromCompiled reads them instead of
    // re-parsing the body at boot.
    const pm = runtime.patternManager;
    await pm.compilePattern(PROGRAM, { space, tx });
    await pm.flushCompileCacheWrites();
    await tx.commit();
    tx = runtime.edit();

    const { entryIdentity } = await (runtime.harness as Engine)
      .compileToRecordGraph(PROGRAM);

    const readTx = runtime.edit();
    const closure = await loadCompiledClosure(
      runtime,
      space,
      entryIdentity,
      { runtimeVersion },
      readTx,
    );
    readTx.abort?.("round-trip probe read complete");

    expect(closure.size).toBeGreaterThan(0);
    // Every loaded compiled doc must carry the persisted surface (never
    // undefined), else the boot build would silently fall back to parsing.
    for (const [identity, doc] of closure) {
      expect(doc.exportNames, `exportNames missing for ${identity}`)
        .toBeDefined();
      expect(doc.starTargetSpecs, `starTargetSpecs missing for ${identity}`)
        .toBeDefined();
      expect(doc.importSpecs, `importSpecs missing for ${identity}`)
        .toBeDefined();
    }
    // Spot-check the entry doc's surface matches the program: main.tsx exports
    // `default` and requires ./util.ts.
    const entry = closure.get(entryIdentity)!;
    expect(new Set(entry.exportNames)).toEqual(new Set(["default"]));
    expect(entry.importSpecs).toContain("./util.ts");
  });

  it("surfaces cold writeback failure instead of returning an unloadable pattern", async () => {
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const failure = {
      name: "StorageTransactionAborted" as const,
      message: "forced compile cache writeback failure",
      reason: "synthetic writeback failure",
    } satisfies CommitError;

    runtime.editWithRetry =
      (() =>
        Promise.resolve({ error: failure })) as typeof runtime.editWithRetry;

    try {
      let thrown: unknown;
      try {
        await runtime.patternManager.compilePattern(PROGRAM, { space, tx });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(
        "forced compile cache writeback failure",
      );
      expect((thrown as Error & { cause?: unknown }).cause).toBe(failure);
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
    }
  });

  it("retries a best-effort identity recovery writeback on the next load", async () => {
    const compiled = await (runtime.harness as Engine).compileToRecordGraph(
      PROGRAM,
    );
    const sourceTx = runtime.edit();
    writeSourceDocs(
      runtime,
      space,
      compiled.modules,
      compiled.entryIdentity,
      sourceTx,
    );
    runtime.prepareTxForCommit(sourceTx);
    expect((await sourceTx.commit()).error).toBeUndefined();

    const runtime2 = newRuntime();
    const originalEditWithRetry = runtime2.editWithRetry.bind(runtime2);
    const failure = {
      name: "StorageTransactionAborted" as const,
      message: "forced identity recovery writeback failure",
      reason: "synthetic background writeback failure",
    } satisfies CommitError;
    runtime2.editWithRetry =
      (() =>
        Promise.resolve({ error: failure })) as typeof runtime2.editWithRetry;

    try {
      const loaded = await runtime2.patternManager.loadPatternByIdentity(
        compiled.entryIdentity,
        "default",
        space,
      );
      expect(typeof loaded).toBe("function");
      await runtime2.patternManager.flushCompileCacheWrites();

      runtime2.editWithRetry = originalEditWithRetry;
      const retried = await runtime2.patternManager.loadPatternByIdentity(
        compiled.entryIdentity,
        "default",
        space,
      );
      expect(typeof retried).toBe("function");
      await runtime2.patternManager.flushCompileCacheWrites();

      const readTx = runtime2.edit();
      const recovered = await loadCompiledClosure(
        runtime2,
        space,
        compiled.entryIdentity,
        { runtimeVersion },
        readTx,
      );
      readTx.abort?.();
      expect(recovered.has(compiled.entryIdentity)).toBe(true);
    } finally {
      runtime2.editWithRetry = originalEditWithRetry;
      await runtime2.dispose({ closeStorage: false });
    }
  });

  it("source-only runtimes write source docs and cold-reload by identity", async () => {
    const restoreRuntimeVersion = setCompileCacheRuntimeVersionForTesting(
      undefined,
    );
    try {
      const pm = runtime.patternManager;
      const cold = await pm.compilePattern(PROGRAM, { space, tx });
      const entryRef = pm.getArtifactEntryRef(cold);
      expect(entryRef).toBeDefined();
      expect(await run(cold, 4)).toEqual({ result: 8 });
      await pm.flushCompileCacheWrites();

      const replicatedSpace =
        (await Identity.fromPassphrase("source-only replicated space")).did();
      pm.replicatePatternToSpace(cold, replicatedSpace, space);
      await pm.flushCompileCacheWrites();

      const readTx = runtime.edit();
      try {
        const source = await loadVerifiedSourceClosure(
          runtime,
          space,
          entryRef!.identity,
          readTx,
        );
        expect(source?.has(entryRef!.identity)).toBe(true);

        const compiled = await loadCompiledClosure(
          runtime,
          space,
          entryRef!.identity,
          { runtimeVersion },
          readTx,
        );
        expect(compiled.size).toBe(0);

        const replicatedSource = await loadVerifiedSourceClosure(
          runtime,
          replicatedSpace,
          entryRef!.identity,
          readTx,
        );
        expect(replicatedSource?.has(entryRef!.identity)).toBe(true);
        const replicatedCompiled = await loadCompiledClosure(
          runtime,
          replicatedSpace,
          entryRef!.identity,
          { runtimeVersion },
          readTx,
        );
        expect(replicatedCompiled.size).toBe(0);
      } finally {
        readTx.abort?.("source-only cache assertion complete");
      }

      const runtime2 = newRuntime();
      const tx2 = runtime2.edit();
      try {
        const loaded = await runtime2.patternManager.loadPatternByIdentity(
          entryRef!.identity,
          entryRef!.symbol,
          space,
        );
        expect(typeof loaded).toBe("function");
        const resultCell = runtime2.getCell<{ result: number }>(
          space,
          "source-only by-identity run",
          undefined,
          tx2,
        );
        const result = runtime2.run(tx2, loaded!, { value: 7 }, resultCell);
        await tx2.commit();
        await result.pull();
        expect(result.getAsQueryResult()).toEqual({ result: 14 });
        await runtime2.patternManager.flushCompileCacheWrites();

        const readTx2 = runtime2.edit();
        try {
          const compiled = await loadCompiledClosure(
            runtime2,
            space,
            entryRef!.identity,
            { runtimeVersion },
            readTx2,
          );
          expect(compiled.size).toBe(0);
        } finally {
          readTx2.abort?.("source-only reload assertion complete");
        }
      } finally {
        await runtime2.dispose({ closeStorage: false });
      }
    } finally {
      restoreRuntimeVersion();
    }
  });

  it("source-only compile surfaces source writeback failure", async () => {
    const restoreRuntimeVersion = setCompileCacheRuntimeVersionForTesting(
      undefined,
    );
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const failure = {
      name: "StorageTransactionAborted" as const,
      message: "forced source cache writeback failure",
      reason: "synthetic source writeback failure",
    } satisfies CommitError;
    runtime.editWithRetry =
      (() =>
        Promise.resolve({ error: failure })) as typeof runtime.editWithRetry;

    try {
      let thrown: unknown;
      try {
        await runtime.patternManager.compilePattern(PROGRAM, { space, tx });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(
        "forced source cache writeback failure",
      );
      expect((thrown as Error & { cause?: unknown }).cause).toBe(failure);
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
      restoreRuntimeVersion();
    }
  });

  it("does not replicate an incomplete compiled closure", async () => {
    const compiled = await (runtime.harness as Engine).compileToRecordGraph(
      PROGRAM,
    );
    const sourceTx = runtime.edit();
    writeSourceDocs(
      runtime,
      space,
      compiled.modules,
      compiled.entryIdentity,
      sourceTx,
    );
    runtime.prepareTxForCommit(sourceTx);
    expect((await sourceTx.commit()).error).toBeUndefined();

    const pattern = await runtime.patternManager.compilePattern(PROGRAM);
    runtime.patternManager.associatePatternIdentity(pattern, {
      identity: compiled.entryIdentity,
      symbol: "default",
    });

    const replicatedSpace =
      (await Identity.fromPassphrase("incomplete compiled replication")).did();
    runtime.patternManager.replicatePatternToSpace(
      pattern,
      replicatedSpace,
      space,
    );
    await runtime.patternManager.flushCompileCacheWrites();

    const readTx = runtime.edit();
    try {
      const replicatedSource = await loadVerifiedSourceClosure(
        runtime,
        replicatedSpace,
        compiled.entryIdentity,
        readTx,
      );
      expect(replicatedSource).toBeUndefined();
    } finally {
      readTx.abort?.("incomplete replication assertion complete");
    }
  });

  it("warm hit reuses the cached body across a fresh runtime (cross-session)", async () => {
    // Session 1: cold compile + write-back.
    const pm1 = runtime.patternManager;
    await pm1.compilePattern(PROGRAM, { space, tx });
    await pm1.flushCompileCacheWrites();
    expect(pm1.getCompileCacheStats().misses).toBe(1);
    await tx.commit();

    // Session 2: a brand-new runtime on the same storage warms from the cache.
    const runtime2 = newRuntime();
    const tx2 = runtime2.edit();
    try {
      const pm2 = runtime2.patternManager;
      const warm = await pm2.compilePattern(PROGRAM, { space, tx: tx2 });
      expect(pm2.getCompileCacheStats()).toEqual({
        hits: 1,
        misses: 0,
        byIdentityHits: 0,
      });
      // The cache-served pattern is a real, frozen pattern.
      expect(typeof warm).toBe("function");
    } finally {
      await tx2.commit();
      await runtime2.dispose({ closeStorage: false });
    }
  });

  it("does not use the cache when CFC enforcement is disabled", async () => {
    const disabled = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      // The disabled rung is what this test is about. The compile cache stats
      // assertion below reads back all zeroes only at this rung.
      cfcEnforcementMode: "disabled",
    });
    const dtx = disabled.edit();
    try {
      const pm = disabled.patternManager;
      const compiled = await pm.compilePattern(PROGRAM, { space, tx: dtx });
      await pm.flushCompileCacheWrites();
      // Cache path is skipped entirely → no hit/miss bookkeeping.
      expect(pm.getCompileCacheStats()).toEqual({
        hits: 0,
        misses: 0,
        byIdentityHits: 0,
      });
      expect(typeof compiled).toBe("function");
    } finally {
      await dtx.commit();
      await disabled.dispose({ closeStorage: false });
    }
  });
});

describe("ESM compile cache — Pattern.inSpace A → B routing", () => {
  // Step 4.4 (required): a pattern compiled bound to space B writes its source
  // + compiled docs into B (not the ambient space A), the link closure resolves
  // in B, and the compiled docs carry the required integrity. This is exactly
  // the per-space routing `PatternFactory.inSpace(B)` relies on: instantiating
  // a child in space B loads it via `loadPattern(id, rootCell.space === B)`,
  // whose core is `compilePattern(source, { space: B })`.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  const spaceA = signer.did();

  const PROGRAM: RuntimeProgram = {
    main: "/main.tsx",
    files: [
      { name: "/util.ts", contents: "export const triple = (x:number)=>x*3;" },
      {
        name: "/main.tsx",
        contents: [
          "import { pattern, lift } from 'commonfabric';",
          "import { triple } from './util.ts';",
          "const t = lift((x:number)=>triple(x));",
          "export default pattern<{ value: number }>(({ value }) => {",
          "  return { result: t(value) };",
          "});",
        ].join("\n"),
      },
    ],
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  it("writes source + compiled docs into the target space B, not A", async () => {
    const spaceB = (await Identity.fromPassphrase("inSpace target B")).did();
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const cacheOpts = {
      runtimeVersion,
    };
    try {
      // The entry identity is loader-internal; recover it via a no-cache compile.
      const { entryIdentity } = await (runtime.harness as Engine)
        .compileToRecordGraph(PROGRAM);

      const pm = runtime.patternManager;
      await pm.compilePattern(PROGRAM, { space: spaceB, tx });
      await pm.flushCompileCacheWrites();

      const readTx = runtime.edit();
      // Compiled docs landed in B: full, integrity-valid closure.
      const inB = await loadCompiledClosure(
        runtime,
        spaceB,
        entryIdentity,
        cacheOpts,
        readTx,
      );
      expect(inB.size).toBeGreaterThanOrEqual(2);
      expect(inB.has(entryIdentity)).toBe(true);

      // Source closure resolves + graph-wiring-verifies in B.
      const srcB = await loadVerifiedSourceClosure(
        runtime,
        spaceB,
        entryIdentity,
        readTx,
      );
      expect(srcB?.has(entryIdentity)).toBe(true);

      // Nothing leaked into the ambient space A.
      const inA = await loadCompiledClosure(
        runtime,
        spaceA,
        entryIdentity,
        cacheOpts,
        readTx,
      );
      expect(inA.size).toBe(0);
      readTx.abort?.();
    } finally {
      await tx.commit();
      await runtime.dispose({ closeStorage: false });
    }
  });

  it("a fresh runtime warm-hits from space B (cross-session, per space)", async () => {
    const spaceB = (await Identity.fromPassphrase("inSpace target B2")).did();
    // Session 1: compile bound to B, write back, flush to storage.
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx1 = rt1.edit();
    let rt2: Runtime | undefined;
    try {
      await rt1.patternManager.compilePattern(PROGRAM, {
        space: spaceB,
        tx: tx1,
      });
      await rt1.patternManager.flushCompileCacheWrites();
      await tx1.commit();
      await rt1.storageManager.synced();

      // Session 2: fresh runtime, same storage → warm hit when loading into B.
      rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const tx2 = rt2.edit();
      await rt2.patternManager.compilePattern(PROGRAM, {
        space: spaceB,
        tx: tx2,
      });
      expect(rt2.patternManager.getCompileCacheStats()).toEqual({
        hits: 1,
        misses: 0,
        byIdentityHits: 0,
      });
      await tx2.commit();
    } finally {
      await rt2?.dispose({ closeStorage: false });
      await rt1.dispose({ closeStorage: false });
    }
  });
});
