import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";

import { wish } from "../../src/builtins/wish.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("wish now interval replacement");
const space = signer.did();

describe("wish-now-interval-replacement", () => {
  let storage: EmulatedStorageManager;
  let runtime: Runtime;
  let cancels: Array<() => void>;

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
    cancels = [];
  });

  afterEach(async () => {
    for (const cancel of cancels.splice(0)) cancel();
    await runtime.dispose({ closeStorage: false });
    await storage.close();
  });

  it("stops the previous interval when the replacement clock cell fails to load", async () => {
    // The wish is driven directly: each run is one scheduler run of its
    // action. A query moving from one interval to another acquires the
    // second's cell only once it has loaded; when that load fails, the wish
    // reports the failure and holds no timer, so the first interval's cell,
    // which nothing consumes any more, stops being written.
    const owner = runtime.getCell(space, "replacement owner");
    const input = runtime.getCell(space, "replacement input");
    const seed = runtime.edit();
    owner.withTx(seed).set({});
    input.withTx(seed).set({ query: "#now/1" });
    runtime.prepareTxForCommit(seed);
    expect((await seed.commit().settled).error).toBeUndefined();

    const builtin = wish(
      input as Cell<[unknown, unknown]>,
      () => {},
      (cancel) => cancels.push(cancel),
      [owner],
      owner,
      runtime,
    );
    /** One run of the wish's action, with the loads it kicks settled. */
    const run = async () => {
      const tx = runtime.edit();
      builtin.action(tx);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await storage.synced();
      await runtime.idle();
    };
    // The first run loads the first interval's cell; the second acquires it.
    await run();
    await run();
    const first = runtime.getCell<number>(space, {
      wish: { now: true, interval: 1000 },
    });
    expect(typeof first.get()).toBe("number");

    // The query moves to a second interval whose cell fails to load.
    const secondId = runtime.getCell(space, {
      wish: { now: true, interval: 2000 },
    }).getAsNormalizedFullLink().id;
    const sync = storage.syncCell.bind(storage);
    using _sync = stub(
      storage,
      "syncCell",
      (cell, options) =>
        cell.getAsNormalizedFullLink().id === secondId
          ? Promise.reject(new Error("replacement clock load failed"))
          : sync(cell, options),
    );
    const move = runtime.edit();
    input.withTx(move).set({ query: "#now/2" });
    runtime.prepareTxForCommit(move);
    expect((await move.commit().settled).error).toBeUndefined();
    // The first run asks for the second cell and its load fails; the second
    // run reads that failure and releases the first interval.
    await run();
    await run();

    const settled = first.get();
    await clock.tick(1000);
    await runtime.idle();
    expect(first.get()).toBe(settled);
  });
});
