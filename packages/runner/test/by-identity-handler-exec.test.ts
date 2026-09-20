import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("by-identity-handler-exec");
const space = signer.did();

// A piece RESUMED from storage in a fresh runtime under the ESM loader loads
// its pattern source-free BY IDENTITY and must still resolve + execute its
// callable functions. This uses the REAL fuse-exec fixture (non-default export,
// schema handlers with asCell state, a patternTool) and drives: create + run
// the piece → persist → resume in a fresh runtime → invoke the `recordMessage`
// handler.
const FIXTURE_SRC = Deno.readTextFileSync(
  new URL(
    "../../cli/integration/pattern/fuse-exec.tsx",
    import.meta.url,
  ),
);

const RESULT_CAUSE = "by-identity fuse-exec resume";

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  mainExport: "customPatternExport",
  files: [{ name: "/main.tsx", contents: FIXTURE_SRC }],
};

describe("resume the fuse-exec piece by identity and invoke its handler", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  const newRuntime = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  it("invokes recordMessage after resuming the piece from storage", async () => {
    const rt1 = newRuntime();
    const rt2 = newRuntime();
    try {
      // Session 1: compile + run the piece, invoke once (control), persist.
      const tx1 = rt1.edit();
      const pm1 = rt1.patternManager;
      const cold = await pm1.compilePattern(PROGRAM, { space, tx: tx1 });
      expect(pm1.getArtifactEntryRef(cold)?.symbol).toBe("customPatternExport");
      const resultCell1 = rt1.getCell<Record<string, unknown>>(
        space,
        RESULT_CAUSE,
        undefined,
        tx1,
      );
      const r1 = rt1.run(tx1, cold, {}, resultCell1);
      await tx1.commit();
      await r1.pull();
      // CONTROL: full-source handler executes in the originating runtime.
      r1.key("recordMessage").send({ message: "hello" });
      const ctrl = await r1.pull() as { messageCount: number };
      expect(ctrl.messageCount).toBe(1);

      await pm1.flushCompileCacheWrites();
      await rt1.storageManager.synced();

      // Session 2: fresh runtime resumes the SAME piece from storage (source-free
      // by identity), then invokes the handler — the path `cf exec` takes.
      const pm2 = rt2.patternManager;
      const tx2 = rt2.edit();
      const resultCell2 = rt2.getCell<Record<string, unknown>>(
        space,
        RESULT_CAUSE,
        undefined,
        tx2,
      );
      await tx2.commit();
      // Force the storage-rehydration path (as cf exec hits it): the resumed
      // piece's nodes come from the PERSISTED graph (module.implementation is a
      // ref, not a live function), so resolution relies solely on by-identity
      // lookup (getVerifiedImplementation).
      await resultCell2.sync();
      const started = await rt2.start(resultCell2);
      expect(started).toBe(true);
      expect(pm2.getCompileCacheStats().byIdentityHits).toBe(1);

      await resultCell2.pull();
      const before =
        (resultCell2.getAsQueryResult() as { messageCount: number })
          .messageCount;
      resultCell2.key("recordMessage").send({ message: "world" });
      await resultCell2.pull();
      const after = (resultCell2.getAsQueryResult() as { messageCount: number })
        .messageCount;
      expect(after).toBe(before + 1);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
