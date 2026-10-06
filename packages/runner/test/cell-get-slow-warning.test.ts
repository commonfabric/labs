// Deterministic coverage for the slow-get warning branch in Cell.get(). After
// timing the read, get() warns when the elapsed time exceeds 50ms. The elapsed
// time is real wall-clock, so this branch only fires when a get happens to be
// slow, which is pure timing jitter. Here the "cell" logger's timeEnd is stubbed
// to report an elapsed time above the threshold for one get, so the warning
// branch always runs.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/utils/logger";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cell-get-slow-warning");
const space = signer.did();

describe("Cell.get slow-path warning", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("warns when a get exceeds the 50ms threshold", () => {
    const c = runtime.getCell<number>(
      space,
      "warns when a get exceeds the 50ms threshold",
      undefined,
      tx,
    );
    c.set(10);

    // The "cell" logger is a process-wide singleton; get() reuses this same
    // instance. Report an elapsed time above the threshold for the next
    // cell/get span and silence the warning so it doesn't print.
    const cellLogger = getLogger("cell");
    const loggerWithTimeEnd = cellLogger as unknown as {
      timeEnd?: (...keys: string[]) => number | undefined;
    };
    const realTimeEnd = cellLogger.timeEnd.bind(cellLogger);
    const originalLevel = cellLogger.level;
    const warnsBefore = cellLogger.counts.warn;

    cellLogger.level = "silent";
    loggerWithTimeEnd.timeEnd = (...keys: string[]) => {
      const elapsed = realTimeEnd(...keys);
      return keys.join("/") === "cell/get" ? 100 : elapsed;
    };

    try {
      expect(c.get()).toBe(10);
    } finally {
      delete loggerWithTimeEnd.timeEnd;
      cellLogger.level = originalLevel;
    }

    // The warning branch ran exactly once for this get.
    expect(cellLogger.counts.warn).toBe(warnsBefore + 1);
  });
});
