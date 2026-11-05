import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("resume-by-identity");
const space = signer.did();

describe("resume a result cell by {identity, symbol}", () => {
  // End-to-end step 3: a result cell records the content-addressed {identity,
  // symbol} pattern reference at setup; a fresh runtime resuming that result
  // cell from storage loads the pattern straight from the compiled cache BY
  // IDENTITY (no TS source pulled, no meta-cell roundtrip), and re-runs it.

  let storageManager: ReturnType<typeof StorageManager.emulate>;

  const RESULT_CAUSE = "resume-by-identity result cell";

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

  it("resumes from the compiled cache by identity, source-free", async () => {
    const rt1 = newRuntime();
    const rt2 = newRuntime();
    try {
      // Session 1: set up + run the pattern. applySetupState records both the
      // patternId link and the {identity, symbol} reference on the result cell.
      const tx1 = rt1.edit();
      const pm1 = rt1.patternManager;
      const compiled = await pm1.compilePattern(PROGRAM, { space, tx: tx1 });
      // The cold ESM compile learned the entry identity.
      expect(pm1.getArtifactEntryRef(compiled)?.identity).toBeTruthy();

      const resultCell1 = rt1.getCell<{ result: number }>(
        space,
        RESULT_CAUSE,
        undefined,
        tx1,
      );
      const r1 = rt1.run(tx1, compiled, { value: 3 }, resultCell1);
      await tx1.commit().settled;
      await r1.pull();
      expect(r1.getAsQueryResult()).toEqual({ result: 6 });

      await pm1.flushCompileCacheWrites();
      await rt1.storageManager.synced();

      // Session 2: a fresh runtime resumes the SAME result cell from storage.
      // No pattern in memory → the reload reads the {identity, symbol}
      // reference and loads straight from the compiled cache by identity.
      const pm2 = rt2.patternManager;
      const tx2 = rt2.edit();
      const resultCell2 = rt2.getCell<{ result: number }>(
        space,
        RESULT_CAUSE,
        undefined,
        tx2,
      );
      await tx2.commit().settled;

      const started = await rt2.start(resultCell2);
      expect(started).toBe(true);
      // Loaded BY IDENTITY — the resolve-free, source-free fast path.
      expect(pm2.getCompileCacheStats().byIdentityHits).toBe(1);

      const tx3 = rt2.edit();
      const readCell = rt2.getCell<{ result: number }>(
        space,
        RESULT_CAUSE,
        undefined,
        tx3,
      );
      await readCell.sync();
      expect(readCell.getAsQueryResult()).toEqual({ result: 6 });
      tx3.abort?.("read complete");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
