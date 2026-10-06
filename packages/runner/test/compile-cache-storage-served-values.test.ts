import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { ModuleByteCache } from "../src/runtime.ts";
import type {
  CompiledModuleArtifact,
  RuntimeProgram,
} from "../src/harness/types.ts";
import {
  compiledDocKey,
  getCompileCacheRuntimeVersion,
  loadCompiledClosure,
} from "../src/compilation-cache/cell-cache.ts";
import type { MemorySpace } from "../src/index.ts";

const signer = await Identity.fromPassphrase("storage-served values test");
const resolvedRuntimeVersion = await getCompileCacheRuntimeVersion();
if (resolvedRuntimeVersion === undefined) {
  throw new Error("compile-cache runtime version unavailable in Deno test");
}
const runtimeVersion = resolvedRuntimeVersion;

// Minimal injection-interface byte cache (same shape as
// module-byte-cache.test.ts): stores artifact references as handed over, the
// way the shared integration singleton does.
class FakeByteCache implements ModuleByteCache {
  readonly #m = new Map<string, CompiledModuleArtifact>();
  getCompleteSet(
    rt: string,
    ids: readonly string[],
  ): Map<string, CompiledModuleArtifact> | undefined {
    const out = new Map<string, CompiledModuleArtifact>();
    for (const id of ids) {
      const a = this.#m.get(`${rt}\0${id}`);
      if (a === undefined) return undefined;
      out.set(id, a);
    }
    return out;
  }
  putAll(
    rt: string,
    mods: readonly ({ identity: string } & CompiledModuleArtifact)[],
  ): void {
    for (const x of mods) {
      this.#m.set(`${rt}\0${x.identity}`, {
        js: x.js,
        ...(x.sourceMap === undefined ? {} : { sourceMap: x.sourceMap }),
        ...(x.patternCoverageSpans === undefined
          ? {}
          : { patternCoverageSpans: x.patternCoverageSpans }),
        ...(x.builderSourceSites === undefined
          ? {}
          : { builderSourceSites: x.builderSourceSites }),
        ...(x.policyManifests === undefined
          ? {}
          : { policyManifests: x.policyManifests }),
      });
    }
  }
}

// Two DIFFERENT programs. Both closures contain the same content-addressed
// injected-helper module(s) (e.g. the cfc helper), which is what makes the
// compiled doc shared between unrelated patterns' closures — the shape the
// sx2-scale ensure-ON red fails on (every pattern's closure holds the shim).
const PROGRAM_A: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "export default pattern(() => ({ label: 'first' }));",
      ].join("\n"),
    },
  ],
};
const PROGRAM_B: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "export default pattern(() => ({ label: 'second' }));",
      ].join("\n"),
    },
  ],
};

/** Deep-plain JSON view (strips any proxy identity for comparison). */
const plain = (value: unknown): unknown =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

/**
 * Compile `program` into `space` on `rt`, await the write-back, commit, and
 * return the entry identity.
 */
const compileInto = async (
  rt: Runtime,
  program: RuntimeProgram,
  space: MemorySpace,
): Promise<string> => {
  const tx = rt.edit();
  const pattern = await rt.patternManager.compilePattern(program, {
    space,
    tx,
  });
  await rt.patternManager.flushCompileCacheWrites();
  const entry = rt.patternManager.getArtifactEntryRef(pattern)!.identity;
  await tx.commit().settled;
  // Make the write-back durable before another runtime reads this space.
  await rt.storageManager.synced();
  return entry;
};

/** The identities of the closure stored under `entryIdentity` in `space`. */
const closureIdentities = async (
  rt: Runtime,
  space: MemorySpace,
  entryIdentity: string,
): Promise<string[]> => {
  const readTx = rt.edit();
  try {
    const closure = await loadCompiledClosure(
      rt,
      space,
      entryIdentity,
      { runtimeVersion },
      readTx,
    );
    return [...closure.keys()];
  } finally {
    readTx.abort?.();
  }
};

/**
 * The RAW stored `/sourceMap` of one compiled doc, as deep-plain JSON.
 * `getRaw()` preserves stored link representations, so a (quoted) link at
 * `/sourceMap` shows up as its sigil structure instead of resolving through
 * to the map it points at — which is exactly what the assertions below must
 * be able to see.
 */
const rawStoredSourceMap = async (
  rt: Runtime,
  space: MemorySpace,
  identity: string,
): Promise<unknown> => {
  const readTx = rt.edit();
  try {
    const cell = rt.getCell(
      space,
      compiledDocKey(runtimeVersion, identity),
      undefined,
      readTx,
    );
    await cell.sync();
    const raw = cell.getRaw() as { sourceMap?: unknown } | undefined;
    return plain(raw?.sourceMap);
  } finally {
    readTx.abort?.();
  }
};

describe("compile-cache storage-served closures round-trip as values", () => {
  // A compiled closure read back from one space's storage must hand its
  // consumers plain VALUES — not live query-result views over the space it was
  // read from. Before the fix, `loadCompiledClosure` returned `cell.get()`
  // documents whose `sourceMap` was a query-result proxy; a runtime that
  // storage-served a program's modules from space A and then wrote them back
  // into space B persisted B's copy of each shared doc with `/sourceMap` as a
  // QUOTED CROSS-SPACE LINK into A instead of the map:
  //
  //   - when B's copy of the doc already existed WITH its stored CFC envelope
  //     (the server-side space-root ensure writes the default-app closure into
  //     every served space), the link write is CFC-relevant and the write-back
  //     ABORTS: "missing link source metadata for <doc> at /sourceMap" — the
  //     ensure-ON pattern-shard-10 sx2-scale red;
  //   - when B's copy did not exist yet, the corrupt link landed SILENTLY
  //     (observed durably in ensure-OFF stores).

  let storageManager: ReturnType<typeof StorageManager.emulate>;

  const runtimeIn = (byteCache?: ModuleByteCache) =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      moduleByteCache: byteCache,
    });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  it("writes storage-served modules into a space whose shared docs pre-exist (the ensure-ON shape)", async () => {
    const spaceA = (await Identity.fromPassphrase("served space A")).did();
    const spaceB = (await Identity.fromPassphrase("served space B")).did();

    // Seed: PROGRAM_A's closure into B (B now durably holds the shared
    // helper doc(s) with their stored CFC envelopes — the ensure's role in
    // the live topology), and PROGRAM_B's closure into A. The seeding
    // runtime stays alive until the end: the emulated storage manager's
    // per-space providers are shared, and a dispose closes them for every
    // runtime on the manager.
    const rtSeed = runtimeIn();
    const byteCache = new FakeByteCache();
    const rt2 = runtimeIn(byteCache);
    try {
      await compileInto(rtSeed, PROGRAM_A, spaceB);
      const entryB = await compileInto(rtSeed, PROGRAM_B, spaceA);

      // Fresh runtime, shared byte cache: compiling PROGRAM_B into A is a
      // per-space storage hit, so its modules are SERVED FROM A's STORAGE and
      // populate the byte cache. Compiling it into B then byte-cache-hits and
      // writes those same module objects back into B — where the shared helper
      // doc already exists with stored CFC metadata. Before the fix the
      // corrupt cross-space link COMMITTED even here: in this single-client
      // emulate topology the foreign space's stored metadata is readable at
      // prepare time, so the link write derives a label and passes. On the
      // live client against toolshed that read resolves nothing and the same
      // write-back ABORTS fail-closed ("missing link source metadata … at
      // /sourceMap" — the ensure-ON pattern-shard-10 red); that abort arm is
      // evidenced by the live gate, not by this unit test. Either disposition
      // is the same corrupt value, which the raw-store assertions below pin.
      await compileInto(rt2, PROGRAM_B, spaceA);
      await compileInto(rt2, PROGRAM_B, spaceB);

      // The closure is durable in B, and every stored sourceMap is the RAW
      // value A holds — never a link.
      const identities = await closureIdentities(rt2, spaceA, entryB);
      expect((await closureIdentities(rt2, spaceB, entryB)).length)
        .toBe(identities.length);
      let docsWithMap = 0;
      for (const identity of identities) {
        const rawA = await rawStoredSourceMap(rt2, spaceA, identity);
        const rawB = await rawStoredSourceMap(rt2, spaceB, identity);
        if (rawA !== undefined) docsWithMap++;
        expect(rawB).toEqual(rawA);
        // Sigil-signature guard: the raw stored value must not be a link.
        // One token suffices for both corrupt shapes — the bare sigil this
        // topology produces (`{"/":{"link@1":…}}`) and the quoted wrapper
        // observed in live ensure-OFF stores (`{"/quote":{"/":{"link@1":…}}}`)
        // both carry it.
        expect(JSON.stringify(rawB ?? null)).not.toContain('"link@');
      }
      // Vacuity guard: the raw-shape assertions above only mean something if
      // the closure actually stores source maps.
      expect(docsWithMap).toBeGreaterThan(0);
    } finally {
      await rt2.dispose();
      await rtSeed.dispose();
    }
  });

  it("persists plain sourceMap values into a fresh space, never links into the serving space", async () => {
    const spaceA = (await Identity.fromPassphrase("served fresh A")).did();
    const spaceC = (await Identity.fromPassphrase("served fresh C")).did();

    const rtSeed = runtimeIn();
    const byteCache = new FakeByteCache();
    const rt2 = runtimeIn(byteCache);
    try {
      const entry = await compileInto(rtSeed, PROGRAM_B, spaceA);

      // Storage-serve from A (poisons the byte cache before the fix), then
      // write into the EMPTY space C. With no pre-existing target doc the
      // corrupt write is not CFC-relevant, so before the fix it landed
      // silently — this pins the durable shape, not just the abort.
      await compileInto(rt2, PROGRAM_B, spaceA);
      await compileInto(rt2, PROGRAM_B, spaceC);

      const identities = await closureIdentities(rt2, spaceA, entry);
      expect((await closureIdentities(rt2, spaceC, entry)).length)
        .toBe(identities.length);
      let docsWithMap = 0;
      for (const identity of identities) {
        const rawA = await rawStoredSourceMap(rt2, spaceA, identity);
        const rawC = await rawStoredSourceMap(rt2, spaceC, identity);
        if (rawA !== undefined) docsWithMap++;
        // The fresh space's stored sourceMap is the VALUE, not a (quoted)
        // link into the space that served the modules. The one token covers
        // both corrupt shapes (bare and quoted sigil — see arm 1's note).
        expect(JSON.stringify(rawC ?? null)).not.toContain('"link@');
        expect(rawC).toEqual(rawA);
      }
      // Vacuity guard: the raw-shape assertions above only mean something if
      // the closure actually stores source maps.
      expect(docsWithMap).toBeGreaterThan(0);
    } finally {
      await rt2.dispose();
      await rtSeed.dispose();
    }
  });
});
