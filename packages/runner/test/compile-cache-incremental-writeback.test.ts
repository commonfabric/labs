import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import {
  computeModuleHashes,
  resolveModuleImports,
} from "../src/harness/module-identity.ts";
import type { CacheableModule, RuntimeProgram } from "../src/harness/types.ts";
import {
  loadCompiledClosure,
  loadSourceClosure,
  loadVerifiedSourceClosure,
  planCompileCacheWriteChunks,
  setCompileCacheRuntimeVersionForTesting,
  verifySourceDocs,
  writeCompiledDocs,
  writeSourceAndCompiledDocs,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

// These tests drive the sync parse internals directly (below the async flow
// boundaries that normally load the deferred compiler stack), so load it here.
await ensureCompilerStack();

const signer = await Identity.fromPassphrase("incremental writeback test");

// A small multi-module program (same synthesis idiom as cell-cache.test.ts):
// /main.tsx -> /util.ts -> (none), /main.tsx -> /types.ts.
const PROGRAM = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        `import { helper } from "./util.ts";`,
        `import type { Thing } from "./types.ts";`,
        `export const run = (t: Thing) => helper(t.n);`,
      ].join("\n"),
    },
    {
      name: "/util.ts",
      contents: `export const helper = (n: number) => n + 1;`,
    },
    { name: "/types.ts", contents: `export interface Thing { n: number; }` },
  ],
};

/** Synthesize the engine's `CacheableModule[]` from an authored program. */
function toModules(
  program: RuntimeProgram,
): { modules: CacheableModule[]; entryIdentity: string } {
  const ids = computeModuleHashes(program);
  const edges = resolveModuleImports(program);
  const modules = program.files.map((f) => ({
    identity: ids.get(f.name)!,
    filename: f.name,
    source: f.contents,
    js: `/* compiled */ ${f.name}`,
    imports: (edges.get(f.name)?.internalDeps ?? []).map((d) => ({
      specifier: d.specifier,
      targetIdentity: ids.get(d.target)!,
    })),
  }));
  return { modules, entryIdentity: ids.get(program.main)! };
}

/** A module no import edge reaches (the injected-helper shape). */
function isolatedModule(): CacheableModule {
  return {
    identity: computeModuleHashes({
      main: "/iso.ts",
      files: [{ name: "/iso.ts", contents: "export const iso = 1;" }],
    }).get("/iso.ts")!,
    filename: "/iso.ts",
    source: "export const iso = 1;",
    js: "/* compiled */ /iso.ts",
    imports: [],
  };
}

describe("planCompileCacheWriteChunks", () => {
  it("covers every module exactly once, bounded chunks, entry last", () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const { chunks, extraRoots } = planCompileCacheWriteChunks(
      modules,
      entryIdentity,
      1,
    );
    expect(extraRoots).toEqual([]);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) expect(chunk.length).toBe(1);
    const flat = chunks.flat();
    expect(new Set(flat.map((m) => m.identity)).size).toBe(modules.length);
    // Dependencies first, the entry module in the final chunk.
    const last = chunks[chunks.length - 1]!;
    expect(last[last.length - 1]!.identity).toBe(entryIdentity);
  });

  it("keeps a small closure in a single chunk (pre-chunking behavior)", () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const { chunks } = planCompileCacheWriteChunks(modules, entryIdentity, 8);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.length).toBe(modules.length);
  });

  it("computes extraRoots over the full set and orders them before the entry", () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const iso = isolatedModule();
    const { chunks, extraRoots } = planCompileCacheWriteChunks(
      [...modules, iso],
      entryIdentity,
      1,
    );
    expect(extraRoots).toEqual([iso.identity]);
    const order = chunks.flat().map((m) => m.identity);
    expect(order.length).toBe(modules.length + 1);
    // The unreachable root is durable before the entry doc that links it.
    expect(order.indexOf(iso.identity)).toBeLessThan(
      order.indexOf(entryIdentity),
    );
    expect(order[order.length - 1]).toBe(entryIdentity);
  });

  it("rejects a non-positive chunk size", () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    expect(() => planCompileCacheWriteChunks(modules, entryIdentity, 0))
      .toThrow();
  });
});

describe("chunked compile-cache write-back (interruption survivability)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  const space = signer.did();
  const RTVER = "rt-incremental-test-1";
  const opts = () => ({ runtimeVersion: RTVER });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      trustSnapshotProvider: () => ({
        id: "incremental-writeback-test",
        actingPrincipal: signer.did(),
      }),
    });
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Commit one chunk in its own transaction (the write-back's unit). */
  async function commitChunk(
    chunk: CacheableModule[],
    entryIdentity: string,
    extraRoots: readonly string[],
  ): Promise<void> {
    const tx = runtime.edit();
    writeSourceAndCompiledDocs(
      runtime,
      space,
      chunk,
      entryIdentity,
      { ...opts(), extraRoots },
      tx,
    );
    tx.prepareCfc();
    const { error } = await tx.commit().settled;
    expect(error).toBeUndefined();
  }

  it("a committed chunk prefix is a cache miss, never a corrupt closure; a rerun converges", async () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const { chunks, extraRoots } = planCompileCacheWriteChunks(
      modules,
      entryIdentity,
      1,
    );
    expect(chunks.length).toBeGreaterThan(1);

    // Session 1 dies after its first chunk committed: dependencies only,
    // no entry doc.
    await commitChunk(chunks[0]!, entryIdentity, extraRoots);

    // Fail-closed on the partial prefix: both closure loaders treat it as a
    // plain cache miss (no entry doc), not as a readable-but-wrong closure.
    const missTx = runtime.edit();
    const compiledMiss = await loadCompiledClosure(
      runtime,
      space,
      entryIdentity,
      opts(),
      missTx,
    );
    expect(compiledMiss.size).toBe(0);
    const sourceMiss = await loadVerifiedSourceClosure(
      runtime,
      space,
      entryIdentity,
      missTx,
    );
    expect(sourceMiss).toBeUndefined();
    missTx.abort?.();

    // Session 2 re-runs the full chunked write-back over the durable prefix
    // (the already-written docs re-diff to their existing values).
    for (const chunk of chunks) {
      await commitChunk(chunk, entryIdentity, extraRoots);
    }

    // The closure is now complete, link-reachable, and self-verifying.
    const tx = runtime.edit();
    const compiled = await loadCompiledClosure(
      runtime,
      space,
      entryIdentity,
      opts(),
      tx,
    );
    expect(compiled.size).toBe(modules.length);
    for (const module of modules) {
      expect(compiled.get(module.identity)?.code).toBe(module.js);
    }
    const source = (await loadSourceClosure(
      runtime,
      space,
      entryIdentity,
      tx,
    ))!;
    expect(source.size).toBe(modules.length);
    expect(verifySourceDocs(entryIdentity, source).ok).toBe(true);
    tx.abort?.();
  });

  it("entry-present/descendant-missing (not producible by interruption) is a partial compiled read and a source-closure miss", async () => {
    // Chunk interruption cannot create this state (the entry doc lands
    // last), but out-of-band loss can. Pin the ACTUAL loader behavior the
    // safety argument rests on: the compiled loader is NOT fail-closed on a
    // missing descendant — it returns the entry plus the valid subset — while
    // the verified source loader rejects the partial graph, so the system
    // recovers via recompile-from-source (see the degradation test below).
    const { modules, entryIdentity } = toModules(PROGRAM);
    const { chunks, extraRoots } = planCompileCacheWriteChunks(
      modules,
      entryIdentity,
      1,
    );
    const utilIdentity = modules.find((m) => m.filename === "/util.ts")!
      .identity;
    // Commit every chunk EXCEPT the /util.ts dependency — including the
    // entry chunk.
    for (const chunk of chunks) {
      if (chunk.some((m) => m.identity === utilIdentity)) continue;
      await commitChunk(chunk, entryIdentity, extraRoots);
    }

    const tx = runtime.edit();
    // Compiled loader: entry present, missing child skipped along with its
    // edge (same behavior "skips compiled import links without integrity"
    // pins) — the result is a PARTIAL closure, not a miss.
    const compiled = await loadCompiledClosure(
      runtime,
      space,
      entryIdentity,
      opts(),
      tx,
    );
    expect(compiled.has(entryIdentity)).toBe(true);
    expect(compiled.has(utilIdentity)).toBe(false);
    expect(compiled.size).toBe(modules.length - 1);
    // Verified source loader: fail-closed — the missing import target fails
    // graph verification, so the caller degrades to a recompile.
    const source = await loadVerifiedSourceClosure(
      runtime,
      space,
      entryIdentity,
      tx,
    );
    expect(source).toBeUndefined();
    tx.abort?.();
  });

  it("chunked writes preserve the entry's synthetic root links to unreachable modules", async () => {
    const { modules, entryIdentity } = toModules(PROGRAM);
    const iso = isolatedModule();
    const all = [...modules, iso];
    const { chunks, extraRoots } = planCompileCacheWriteChunks(
      all,
      entryIdentity,
      1,
    );
    for (const chunk of chunks) {
      await commitChunk(chunk, entryIdentity, extraRoots);
    }

    // The link-following loaders reach the isolated module through the entry
    // doc's root link even though it was written in a different transaction
    // than the entry.
    const tx = runtime.edit();
    const compiled = await loadCompiledClosure(
      runtime,
      space,
      entryIdentity,
      opts(),
      tx,
    );
    expect(compiled.size).toBe(all.length);
    expect(compiled.get(iso.identity)?.code).toBe(iso.js);
    const source = (await loadSourceClosure(
      runtime,
      space,
      entryIdentity,
      tx,
    ))!;
    expect(source.has(iso.identity)).toBe(true);
    tx.abort?.();
  });
});

describe("descendant-missing compiled closure degrades to a clean recompile", () => {
  it("loadPatternByIdentity recompiles from source and heals the compiled set", async () => {
    // System-level degradation pin: the by-identity load's hit test is ENTRY
    // presence (`closure.has(entryIdentity)`), not closure completeness.
    // Chunked interruption cannot create an entry-present/descendant-missing
    // compiled namespace (the entry doc lands last), but the safety argument in
    // planCompileCacheWriteChunks leans on what happens if that state exists
    // anyway: cached-module evaluation fails on the missing module and the load
    // falls back to a clean recompile from the verified source closure — a
    // working pattern, never a corrupt load — and the recovery write-back heals
    // the compiled namespace.

    const RTVER = "test-degrade-1";
    const restoreVersion = setCompileCacheRuntimeVersionForTesting(RTVER);
    const server = newSharedServer();
    const space = signer.did();
    const program = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            `import { bump } from "./util.ts";`,
            `import { lift, pattern } from "commonfabric";`,
            `const inc = lift((x: number) => bump(x));`,
            `export default pattern<{ value: number }>(({ value }) => {`,
            `  return { result: inc(value) };`,
            `});`,
          ].join("\n"),
        },
        {
          name: "/util.ts",
          contents: `export const bump = (n: number) => n + 1;`,
        },
      ],
    };

    const smA = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtimeA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smA,
    });
    let smB: EmulatedStorageManager | undefined;
    let runtimeB: Runtime | undefined;
    try {
      // Real compile for real module bodies, but persist BY HAND: the full
      // source closure plus a compiled set that is missing /util.ts — the
      // entry-present/descendant-missing state no chunk interruption can
      // produce.
      const { modules, entryIdentity } = await runtimeA.harness
        .compileToRecordGraph(program, { fabricImports: { space } });
      const utilModule = modules.find((m) => m.filename === "/util.ts");
      expect(utilModule).toBeDefined();
      const compiledSubset = modules.filter((m) => m !== utilModule);
      const tx = runtimeA.edit();
      writeSourceDocs(runtimeA, space, modules, entryIdentity, tx);
      writeCompiledDocs(
        runtimeA,
        space,
        compiledSubset,
        entryIdentity,
        { runtimeVersion: RTVER },
        tx,
      );
      tx.prepareCfc();
      expect((await tx.commit().settled).error).toBeUndefined();
      await smA.synced();

      // Cold replica: confirm the pre-state actually exercises the intended
      // path — the compiled ENTRY is present (hit test passes) while the
      // descendant is absent. Without this guard a mis-stamped write would
      // silently turn the test into the ordinary absent-entry miss.
      smB = EmulatedStorageManager.connectTo(server, { as: signer });
      runtimeB = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: smB,
      });
      const preTx = runtimeB.edit();
      const partial = await loadCompiledClosure(
        runtimeB,
        space,
        entryIdentity,
        { runtimeVersion: RTVER },
        preTx,
      );
      preTx.abort?.();
      expect(partial.has(entryIdentity)).toBe(true);
      expect(partial.has(utilModule!.identity)).toBe(false);

      // The by-identity load must degrade to a clean recompile: a WORKING
      // pattern from the verified source closure, not a corrupt cached load.
      const loaded = await runtimeB.patternManager.loadPatternByIdentity(
        entryIdentity,
        "default",
        space,
      );
      expect(loaded).toBeDefined();
      await runtimeB.patternManager.flushCompileCacheWrites();
      await smB.synced();

      // The recovery write-back healed the compiled namespace: the closure
      // is complete again (recompile is identity-stable over the same
      // source).
      const healTx = runtimeB.edit();
      const healed = await loadCompiledClosure(
        runtimeB,
        space,
        entryIdentity,
        { runtimeVersion: RTVER },
        healTx,
      );
      healTx.abort?.();
      expect(healed.has(entryIdentity)).toBe(true);
      expect(healed.has(utilModule!.identity)).toBe(true);
      expect(healed.size).toBe(modules.length);
    } finally {
      restoreVersion();
      await runtimeB?.dispose();
      await smB?.close();
      await runtimeA.dispose();
      await smA.close();
      await server.close();
    }
  });
});
