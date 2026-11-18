import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { wish } from "../../src/builtins/wish.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import { StateInconsistency } from "../../src/storage/transaction/attestation.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("wish now interval teardown");
const space = signer.did();

describe("wish-now-interval-teardown", () => {
  let storage: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    // The grid ticks on wall-clock boundaries; the frozen clock starts each
    // case from logical zero.
    clock.reset();
    storage = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.invalid"),
      storageManager: storage,
      experimental: { serverExecution: false },
    });
  });

  afterEach(async () => {
    await runtime.dispose({ closeStorage: false });
    await storage.close();
  });

  it("writes nothing when the beat stops while a tick's write waits to be tried again", async () => {
    // A tick's write that meets a conflict is tried again in a fresh
    // transaction. The only wish holding the interval is cancelled while the
    // first attempt's commit is on its way, so the beat has stopped by the
    // time the write is tried again, and the second attempt writes nothing.
    const owner = runtime.getCell(space, "teardown owner");
    const input = runtime.getCell(space, "teardown input");
    const seed = runtime.edit();
    owner.withTx(seed).set({});
    input.withTx(seed).set({ query: "#now/1" });
    runtime.prepareTxForCommit(seed);
    expect((await seed.commit().settled).error).toBeUndefined();

    const cancels: (() => void)[] = [];
    const builtin = wish(
      input as Cell<[unknown, unknown]>,
      () => {},
      (cancel) => cancels.push(cancel),
      [owner],
      owner,
      runtime,
    );
    const run = async () => {
      const tx = runtime.edit();
      builtin.action(tx);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await storage.synced();
      await runtime.idle();
    };
    // The first run loads the interval's cell; the second acquires it.
    await run();
    await run();
    const beat = runtime.getCell<number>(space, {
      wish: { now: true, interval: 1000 },
    });
    const started = beat.get();
    expect(typeof started).toBe("number");

    const replica = storage.open(space).replica;
    const commitNative = replica.commitNative!;
    const stampServerRun = runtime.stampServerRun;
    const ticks = new WeakSet<object>();
    let tickCommits = 0;
    runtime.stampServerRun = (tx, info) => {
      stampServerRun.call(runtime, tx, info);
      if (info.actionId.startsWith("wish/interval-now-tick/")) ticks.add(tx.tx);
    };
    replica.commitNative = (native, source, options) => {
      if (source && ticks.has(source)) {
        tickCommits++;
        cancels.splice(0).forEach((cancel) => cancel());
        return Promise.resolve({
          error: StateInconsistency({
            address: { id: "of:tick", type: "application/json", path: [] },
          }),
        });
      }
      return commitNative.call(replica, native, source, options);
    };
    try {
      await clock.tick(1000);
      await runtime.idle();
      await storage.synced();
    } finally {
      replica.commitNative = commitNative;
      runtime.stampServerRun = stampServerRun;
    }

    expect(tickCommits).toBe(1);
    expect(beat.get()).toBe(started);
  });
});
