import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { Logger, type LogMessage } from "@commonfabric/logger";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { settleOnceInputSyncs } from "../../src/builtins/resume-republish.ts";
import { Runtime } from "../../src/runtime.ts";

const signer = await Identity.fromPassphrase("settle once input syncs");
const space = signer.did();

/** A logger that keeps every warning rather than printing it. */
class RecordingLogger extends Logger {
  readonly warnings: Array<{ key: string; messages: LogMessage[] }> = [];

  override warn(key: string, ...messages: LogMessage[]): void {
    this.warnings.push({ key, messages });
  }
}

describe("settleOnceInputSyncs()", () => {
  // The map, filter and flatMap coordinators each settle a resumed input
  // through this chain. Its failure reports run only where a settle fails or
  // an input's sync rejects, so each case here constructs that outcome rather
  // than waiting for a suite to tear a runtime down mid-settle.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let logger: RecordingLogger;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    logger = new RecordingLogger("settleOnceInputSyncs test");
  });

  afterEach(async () => {
    await runtime.dispose({ closeStorage: false });
    await storageManager.close();
  });

  it("commits the settle once the sync resolves, holding the settle barrier until then", async () => {
    const container = runtime.getCell<number[]>(space, "settled container");
    const sync = Promise.withResolvers<void>();
    const settled = settleOnceInputSyncs(
      runtime,
      logger,
      sync.promise,
      () => true,
      (tx) => container.withTx(tx).set([]),
    );
    expect(storageManager.pendingCrossSpacePromiseCount()).toBe(1);
    expect(container.get()).toBeUndefined();

    sync.resolve();
    await settled;

    expect(storageManager.pendingCrossSpacePromiseCount()).toBe(0);
    expect(container.get()).toEqual([]);
    expect(logger.warnings).toEqual([]);
  });

  it("runs no settle for a coordinator torn down before the sync resolves", async () => {
    let settles = 0;
    await settleOnceInputSyncs(
      runtime,
      logger,
      Promise.resolve(),
      () => false,
      () => settles++,
    );
    expect(settles).toBe(0);
    expect(logger.warnings).toEqual([]);
  });

  it("reports a settle that fails, with the failure it carried", async () => {
    const failure = new Error("settle refused");
    await settleOnceInputSyncs(
      runtime,
      logger,
      Promise.resolve(),
      () => true,
      () => {
        throw failure;
      },
    );
    expect(logger.warnings).toHaveLength(1);
    const [{ key, messages }] = logger.warnings;
    expect(key).toBe("resume-input");
    expect(messages[0]).toBe("settling the resumed input failed");
    expect(messages[1]).toMatchObject({ error: { reason: failure } });
  });

  it("reports a rejected sync and runs no settle", async () => {
    const rejection = new Error("sync rejected");
    let settles = 0;
    await settleOnceInputSyncs(
      runtime,
      logger,
      Promise.reject(rejection),
      () => true,
      () => settles++,
    );
    expect(settles).toBe(0);
    expect(logger.warnings).toEqual([{
      key: "resume-input",
      messages: ["the resumed input list sync rejected", { error: rejection }],
    }]);
  });
});
