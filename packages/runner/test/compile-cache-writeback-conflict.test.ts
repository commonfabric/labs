import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import {
  setCompileCacheRuntimeVersionForTesting,
} from "../src/compilation-cache/cell-cache.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("writeback conflict test");
const space = signer.did();

describe("compile-cache write-back after a runtime-version bump", () => {
  it("recovery write-back persists despite pre-existing docs on a cold replica", async () => {
    // A runtime-version bump sends loads through the cold-load recovery path
    // (recompile + write-back). The write-back re-writes version-independent
    // source docs that already exist from the original compile — documents a
    // cold replica may not have read at their true version. A commit carrying
    // such a stale read is refused; the conflict's `readyToRetry` catch-up
    // gate is the designed remedy, and `editWithRetry()` awaits it, as the
    // scheduler does (`scheduler/run.ts`). A retry that ran against the same
    // stale replica would exhaust the budget, and the cache would never heal.

    const server = newSharedServer();
    const program = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "import { pattern, lift } from 'commonfabric';",
          "const inc = lift((x:number)=>x+1);",
          "export default pattern<{ value: number }>(({ value }) => {",
          "  return { result: inc(value) };",
          "});",
        ].join("\n"),
      }],
    };

    // Version A: compile + persist (source docs, and compiled docs keyed
    // under vA).
    const restoreVersion = setCompileCacheRuntimeVersionForTesting(
      "test-version-A",
    );
    const smA = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtimeA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smA,
    });
    let smB: EmulatedStorageManager | undefined;
    let runtimeB: Runtime | undefined;
    let smC: EmulatedStorageManager | undefined;
    let runtimeC: Runtime | undefined;
    try {
      const txA = runtimeA.edit();
      const compiled = await runtimeA.patternManager.compilePattern(program, {
        space,
        tx: txA,
      });
      const ref = runtimeA.patternManager.getArtifactEntryRef(compiled)!;
      const entryIdentity = ref.identity;
      const symbol = ref.symbol;
      await runtimeA.patternManager.flushCompileCacheWrites();
      await txA.commit();
      await smA.synced();

      // Version B ("the compiler shipped"): a COLD replica finds no compiled
      // docs under vB and takes the recovery path — recompile, then write
      // back source docs (which already exist server-side) plus compiled
      // docs under vB.
      setCompileCacheRuntimeVersionForTesting("test-version-B");
      smB = EmulatedStorageManager.connectTo(server, { as: signer });
      runtimeB = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: smB,
      });
      const recovered = await runtimeB.patternManager.loadPatternByIdentity(
        entryIdentity,
        symbol,
        space,
      );
      expect(recovered).toBeDefined();
      // Proof B took the recovery path (a warm by-identity closure hit would
      // have incremented byIdentityHits; recovery does not).
      expect(runtimeB.patternManager.getCompileCacheStats().byIdentityHits)
        .toBe(0);
      // The write-back is fire-and-forget from the load's perspective; force
      // it to settle so its outcome is observable.
      await runtimeB.patternManager.flushCompileCacheWrites();
      await smB.synced();

      // Healing proof: a THIRD cold replica at vB warm-hits the compiled
      // closure B wrote back — no recovery, no recompile.
      smC = EmulatedStorageManager.connectTo(server, { as: signer });
      runtimeC = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: smC,
      });
      const warm = await runtimeC.patternManager.loadPatternByIdentity(
        entryIdentity,
        symbol,
        space,
      );
      expect(warm).toBeDefined();
      expect(runtimeC.patternManager.getCompileCacheStats().byIdentityHits)
        .toBeGreaterThan(0);
    } finally {
      restoreVersion();
      await runtimeC?.dispose();
      await runtimeB?.dispose();
      await runtimeA.dispose();
      await smC?.close();
      await smB?.close();
      await smA.close();
      await server.close();
    }
  });
});
