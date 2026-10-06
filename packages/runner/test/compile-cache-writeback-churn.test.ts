import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import {
  compiledDocKey,
  setCompileCacheRuntimeVersionForTesting,
  sourceDocKey,
  writeSourceAndCompiledDocs,
} from "../src/compilation-cache/cell-cache.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";
import {
  computeModuleHashes,
  resolveModuleImports,
} from "../src/harness/module-identity.ts";
import type { CacheableModule, RuntimeProgram } from "../src/harness/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

// The second test drives the writers directly, below the async flow
// boundaries that normally load the deferred compiler stack.
await ensureCompilerStack();

const signer = await Identity.fromPassphrase("writeback churn test");
const space = signer.did();

const program = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "import { double } from './dep.ts';",
        "import { label } from './dep2.ts';",
        "export default pattern<{ value: number }>(({ value }) => {",
        "  return { result: double(value), label: label(value) };",
        "});",
      ].join("\n"),
    },
    {
      name: "/dep.ts",
      contents: [
        "import { lift } from 'commonfabric';",
        "import { unit } from './dep2.ts';",
        "export const double = lift((x: number) => x * 2 * unit);",
      ].join("\n"),
    },
    {
      name: "/dep2.ts",
      contents: [
        "import { lift } from 'commonfabric';",
        "export const unit = 1;",
        "export const label = lift((x: number) => `n=${x}`);",
      ].join("\n"),
    },
  ],
};

/** The `imports` array as the store holds it for the record `id`. */
function storedImports(sm: EmulatedStorageManager, id: string): unknown[] {
  const raw = (sm.open(space) as unknown as {
    get(id: string): { value?: { imports?: unknown[] } } | undefined;
  }).get(id);
  return raw?.value?.imports ?? [];
}

/**
 * Each import edge is stored inline in the record: an object naming the
 * specifier and linking the imported module, not a link to a document of
 * its own.
 */
function expectInlineEdges(edges: unknown[], count: number): void {
  expect(edges.length).toBe(count);
  for (const edge of edges) {
    const el = edge as { "/"?: unknown; specifier?: unknown; link?: unknown };
    expect(el["/"]).toBeUndefined();
    expect(typeof el.specifier).toBe("string");
    expect(typeof el.link).toBe("object");
  }
}

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

describe("compile-cache write-back of a closure the store already holds", () => {
  it("lands on every runtime version bump, so a later cold runtime hits by identity", async () => {
    // The clone's shape: a program whose source records already exist from
    // earlier builds is recompiled by each new runtime version, and each
    // write-back writes the same source records again. Every write-back
    // must land, or every later call recompiles.
    const server = newSharedServer();
    const restoreVersion = setCompileCacheRuntimeVersionForTesting("churn-v0");
    const managers: EmulatedStorageManager[] = [];
    const runtimes: Runtime[] = [];
    const open = () => {
      const sm = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
      });
      managers.push(sm);
      runtimes.push(runtime);
      return { sm, runtime };
    };
    try {
      const first = open();
      const tx = first.runtime.edit();
      const compiled = await first.runtime.patternManager.compilePattern(
        program,
        { space, tx },
      );
      const ref = first.runtime.patternManager.getArtifactEntryRef(compiled)!;
      await first.runtime.patternManager.flushCompileCacheWrites();
      await tx.commit().settled;
      await first.sm.synced();

      const entrySourceId = first.runtime.getCell(
        space,
        sourceDocKey(ref.identity),
      ).getAsNormalizedFullLink().id;
      // Two authored imports and the synthetic root link, stored inline.
      expectInlineEdges(storedImports(first.sm, entrySourceId), 3);

      // The source records are independent of the runtime version, so a
      // later version's write-back leaves them at the revision the first
      // write left them at; only the compiled records are new.
      const engine = await server.engineForSpace(space);
      const sourceRevision = () =>
        (engine.database.prepare(
          "SELECT max(seq) AS seq FROM revision WHERE id = :id",
        ).get({ id: entrySourceId }) as { seq: number }).seq;
      const firstRevision = sourceRevision();

      for (const version of ["churn-v1", "churn-v2", "churn-v3", "churn-v4"]) {
        setCompileCacheRuntimeVersionForTesting(version);
        const cold = open();
        const loaded = await cold.runtime.patternManager.loadPatternByIdentity(
          ref.identity,
          ref.symbol,
          space,
        );
        expect(loaded).toBeDefined();
        await cold.runtime.patternManager.flushCompileCacheWrites();
        await cold.sm.synced();

        const warm = open();
        await warm.runtime.patternManager.loadPatternByIdentity(
          ref.identity,
          ref.symbol,
          space,
        );
        expect(
          warm.runtime.patternManager.getCompileCacheStats().byIdentityHits,
        ).toBeGreaterThan(0);
        expect(sourceRevision()).toBe(firstRevision);
      }
    } finally {
      restoreVersion();
      for (const runtime of runtimes.reverse()) await runtime.dispose();
      for (const sm of managers.reverse()) await sm.close();
      await server.close();
    }
  });

  it("a second session's write of the same source and compiled records commits without writing", async () => {
    // A session that finds the closure incomplete rewrites all of it, the
    // records an earlier session landed included. That write must commit,
    // and must leave every record the store already holds at its revision.
    const server = newSharedServer();
    const runtimeVersion = "churn-same-version";
    const restoreVersion = setCompileCacheRuntimeVersionForTesting(
      runtimeVersion,
    );
    const { modules, entryIdentity } = toModules(program);
    const managers: EmulatedStorageManager[] = [];
    const runtimes: Runtime[] = [];
    const open = () => {
      const sm = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
      });
      managers.push(sm);
      runtimes.push(runtime);
      return { sm, runtime };
    };
    // The write-back's shape: the records are loaded first, so the write
    // reads each with its true version; then the closure is written in one
    // transaction.
    const writeBack = async (
      { sm, runtime }: { sm: EmulatedStorageManager; runtime: Runtime },
    ) => {
      await Promise.all(modules.flatMap((module) => [
        runtime.getCell(space, sourceDocKey(module.identity)).sync(),
        runtime.getCell(
          space,
          compiledDocKey(runtimeVersion, module.identity),
        ).sync(),
      ]));
      const tx = runtime.edit();
      writeSourceAndCompiledDocs(
        runtime,
        space,
        modules,
        entryIdentity,
        { runtimeVersion },
        tx,
      );
      tx.prepareCfc();
      const { error } = await tx.commit().settled;
      await sm.synced();
      return error;
    };
    try {
      const first = open();
      expect(await writeBack(first)).toBeUndefined();
      const entrySourceId = first.runtime.getCell(
        space,
        sourceDocKey(entryIdentity),
      ).getAsNormalizedFullLink().id;
      const entryCompiledId = first.runtime.getCell(
        space,
        compiledDocKey(runtimeVersion, entryIdentity),
      ).getAsNormalizedFullLink().id;
      expectInlineEdges(storedImports(first.sm, entrySourceId), 2);
      expectInlineEdges(storedImports(first.sm, entryCompiledId), 2);

      const engine = await server.engineForSpace(space);
      const revision = (id: string) =>
        (engine.database.prepare(
          "SELECT max(seq) AS seq FROM revision WHERE id = :id",
        ).get({ id }) as { seq: number }).seq;
      const sourceRevision = revision(entrySourceId);
      const compiledRevision = revision(entryCompiledId);

      const second = open();
      expect(await writeBack(second)).toBeUndefined();
      expect(revision(entrySourceId)).toBe(sourceRevision);
      expect(revision(entryCompiledId)).toBe(compiledRevision);
    } finally {
      restoreVersion();
      for (const runtime of runtimes.reverse()) await runtime.dispose();
      for (const sm of managers.reverse()) await sm.close();
      await server.close();
    }
  });
});
