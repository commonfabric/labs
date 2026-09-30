import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import type { Server } from "@commonfabric/memory/v2/server";

import { toMemorySpaceAddress } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action, EventHandler } from "../src/scheduler/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  assertLocalReadAvailable,
  localReadFailure,
  localReadsReady,
  LocalReadUnavailable,
  releaseLocalReadBasis,
  requireLocalReadCondition,
  restrictToLocalReads,
  usesLocalReads,
  validateLocalReadBasis,
} from "../src/storage/local-read-policy.ts";

const signer = await Identity.fromPassphrase("local read policy");
const space = signer.did();

describe("local-read-policy", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  it("shares one checker within validation and renews it for later state", () => {
    const tx = runtime.edit();
    let allowed = true;
    let generation = 0;
    const checked: number[] = [];
    restrictToLocalReads(tx.tx, () => {
      const current = ++generation;
      const snapshot = allowed;
      return () => {
        checked.push(current);
        return snapshot;
      };
    });
    try {
      for (const id of ["of:first", "of:second"] as const) {
        assertLocalReadAvailable(tx.tx, {
          space,
          id,
          type: "application/json",
          path: ["value"],
        }, () => true);
      }
      expect(checked).toEqual([1, 2]);
      expect(validateLocalReadBasis(tx)).toBeUndefined();
      expect(checked).toEqual([1, 2, 3, 3]);
      allowed = false;
      expect(validateLocalReadBasis(tx)).toBeInstanceOf(LocalReadUnavailable);
      expect(checked.at(-1)).toBe(4);
      allowed = true;
      expect(localReadsReady(tx)).toBe(true);
      expect(checked.slice(-2)).toEqual([5, 5]);
    } finally {
      tx.abort();
    }
  });

  it("discards a caught unavailable read and staged writes without pulling", async () => {
    const output = runtime.getCell<string>(space, "local read output", {
      type: "string",
    });
    await runtime.editWithRetry((tx) => output.withTx(tx).set("confirmed"));
    await output.sync();
    const missing = runtime.getCell<string>(space, "unreplicated input", {
      type: "string",
      default: "default",
    });
    const tx = runtime.edit();
    restrictToLocalReads(tx.tx);
    let rolledBack = false;
    tx.addCommitCallback((_tx, result) => {
      rolledBack = result.error !== undefined;
    });
    const syncCell = stub(storage, "syncCell", () => {
      throw new Error("A local-only attempt must not pull");
    });
    try {
      output.withTx(tx).set("speculative");
      expect(() => missing.withTx(tx).get()).toThrow(LocalReadUnavailable);
      expect(localReadFailure(tx)?.address.id).toBe(
        missing.getAsNormalizedFullLink().id,
      );
      const result = await tx.commit();
      expect(result.error?.name).toBe("StorageTransactionAborted");
      expect(rolledBack).toBe(true);
      expect(syncCell.calls.length).toBe(0);
    } finally {
      syncCell.restore();
    }
    expect(output.get()).toBe("confirmed");
  });

  it("distinguishes confirmed absence from an unknown document", async () => {
    const missing = runtime.getCell<string>(space, "confirmed absent", {
      type: "string",
      default: "default",
    });
    await missing.sync();
    const tx = runtime.edit();
    restrictToLocalReads(tx.tx);
    expect(missing.withTx(tx).get()).toBe("default");
    expect(localReadFailure(tx)).toBeUndefined();
    tx.abort();
  });

  it("allows a complete earlier write without admitting its unknown siblings", () => {
    const cell = runtime.getCell(space, "locally written child", undefined);
    const address = {
      ...cell.getAsNormalizedFullLink(),
      path: ["value", "known"],
    };
    const tx = runtime.edit();
    restrictToLocalReads(tx.tx);
    const write = tx.tx.write(address, "local");
    expect(write.error).toBeUndefined();
    expect(tx.tx.read(address).ok?.value).toBe("local");
    expect(() => tx.tx.read({ ...address, path: ["value", "other"] })).toThrow(
      LocalReadUnavailable,
    );
    tx.abort();
  });

  it("commits an intentional undefined result over a covered value", async () => {
    const output = runtime.getCell<string | undefined>(
      space,
      "intentional undefined",
      undefined,
    );
    await runtime.editWithRetry((tx) => output.withTx(tx).set("confirmed"));
    await output.sync();
    const tx = runtime.edit();
    restrictToLocalReads(tx.tx);
    output.withTx(tx).set(undefined);
    const result = await tx.commit();
    expect(result.error).toBeUndefined();
    expect(output.get()).toBeUndefined();
  });

  it("parks an unavailable computation and wakes when absence becomes known", async () => {
    const input = runtime.getCell<string>(space, "parked input", {
      type: "string",
      default: "default",
    });
    const output = runtime.getCell<string>(space, "parked output", {
      type: "string",
    });
    await runtime.editWithRetry((tx) => output.withTx(tx).set("confirmed"));
    await output.sync();
    let attempts = 0;
    const action: Action = (tx) => {
      attempts++;
      // Bound the failure case so an unwanted retry fails without looping.
      if (attempts > 2) return;
      restrictToLocalReads(tx.tx);
      output.withTx(tx).set(input.withTx(tx).get());
    };
    const cancel = runtime.scheduler.subscribe(action, { isEffect: true });
    try {
      await runtime.idle();
      expect(attempts).toBe(1);
      expect(output.get()).toBe("confirmed");
      await input.sync();
      await runtime.idle();
      expect(attempts).toBe(2);
      expect(output.get()).toBe("default");
    } finally {
      cancel();
    }
  });

  it("wakes when coverage arrives before the unavailable attempt finishes", async () => {
    const input = runtime.getCell<string>(space, "async parked input", {
      type: "string",
      default: "known",
    });
    const reachedMissing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let attempts = 0;
    let observed: string | undefined;
    const action: Action = async (tx) => {
      attempts++;
      restrictToLocalReads(tx.tx);
      try {
        observed = input.withTx(tx).get();
      } catch (error) {
        if (!(error instanceof LocalReadUnavailable)) throw error;
        reachedMissing.resolve();
        await release.promise;
      }
    };
    const cancel = runtime.scheduler.subscribe(action, { isEffect: true });
    try {
      await reachedMissing.promise;
      await input.sync();
      release.resolve();
      await runtime.idle();
      expect(attempts).toBe(2);
      expect(observed).toBe("known");
    } finally {
      release.resolve();
      cancel();
    }
  });

  it("settles a read-only transaction whose unavailable read was caught", async () => {
    const tx = runtime.readTx();
    restrictToLocalReads(tx.tx);
    const missing = runtime.getCell(space, "read-only missing", undefined, tx);
    expect(() => missing.get()).toThrow(LocalReadUnavailable);
    const result = await tx.commit();
    expect(result.error?.name).toBe("StorageTransactionAborted");
    expect(tx.status().status).toBe("error");
  });

  it("keeps an unavailable attempt canceled when its asynchronous body finishes", async () => {
    const input = runtime.getCell(space, "canceled missing", undefined);
    const reachedMissing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let attempts = 0;
    const action: Action = async (tx) => {
      attempts++;
      restrictToLocalReads(tx.tx);
      try {
        input.withTx(tx).get();
      } catch (error) {
        if (!(error instanceof LocalReadUnavailable)) throw error;
        reachedMissing.resolve();
        await release.promise;
      }
    };
    const cancel = runtime.scheduler.subscribe(action, { isEffect: true });
    try {
      await reachedMissing.promise;
      cancel();
      release.resolve();
      await runtime.idle();
      await input.sync();
      await runtime.idle();
      expect(attempts).toBe(1);
      expect(runtime.scheduler.isEffect(action)).toBe(false);
    } finally {
      release.resolve();
      cancel();
    }
  });

  it("discards a successful asynchronous attempt after cancellation", async () => {
    const output = runtime.getCell<number>(space, "canceled output", {
      type: "number",
    });
    await runtime.editWithRetry((tx) => output.withTx(tx).set(6));
    await output.sync();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const action: Action = async (tx) => {
      restrictToLocalReads(tx.tx);
      const value = output.withTx(tx).get();
      entered.resolve();
      await release.promise;
      output.withTx(tx).set(value + 100);
    };
    const cancel = runtime.scheduler.subscribe(action, { isEffect: true });
    try {
      await entered.promise;
      cancel();
      release.resolve();
      await runtime.idle();
      expect(output.get()).toBe(6);
      expect(runtime.scheduler.isEffect(action)).toBe(false);
    } finally {
      release.resolve();
      cancel();
    }
  });

  it("releases a parked action's coverage subscription on disposal", async () => {
    const replica = storage.open(space).replica;
    const subscribe = replica.subscribeLocalCoverage!.bind(replica);
    let observers = 0;
    const subscription = stub(
      replica as typeof replica & { subscribeLocalCoverage: typeof subscribe },
      "subscribeLocalCoverage",
      (observer) => {
        observers++;
        const cancel = subscribe(observer);
        return () => {
          observers--;
          cancel();
        };
      },
    );
    try {
      const missing = runtime.getCell(space, "disposed missing", undefined);
      runtime.scheduler.subscribe((tx) => {
        restrictToLocalReads(tx.tx);
        missing.withTx(tx).get();
      }, { isEffect: true });
      await runtime.idle();
      expect(observers).toBe(1);
      await runtime.dispose();
      expect(observers).toBe(0);
    } finally {
      subscription.restore();
    }
  });

  it("parks when commit preparation discovers an unavailable input", async () => {
    const output = runtime.getCell<string>(space, "prepared output", {
      type: "string",
    });
    await runtime.editWithRetry((tx) => output.withTx(tx).set("confirmed"));
    await output.sync();
    const missing = runtime.getCell(space, "missing policy input", undefined);
    const prepare = runtime.prepareTxForCommit.bind(runtime);
    const preparation = stub(runtime, "prepareTxForCommit", (tx) => {
      missing.withTx(tx).get();
      prepare(tx);
    });
    let attempts = 0;
    const cancel = runtime.scheduler.subscribe((tx) => {
      attempts++;
      if (attempts > 2) return;
      restrictToLocalReads(tx.tx);
      output.withTx(tx).set("preview");
    }, { isEffect: true });
    try {
      await runtime.idle();
      expect(attempts).toBe(1);
      expect(output.get()).toBe("confirmed");
    } finally {
      cancel();
      preparation.restore();
    }
  });

  it("requires restrictions before activity and prevents replacing an installed policy", async () => {
    const input = runtime.getCell(space, "policy ordering", undefined);
    await input.sync();
    const tx = runtime.edit();
    try {
      restrictToLocalReads(tx.tx);
      expect(() => restrictToLocalReads(tx.tx)).toThrow("already installed");
    } finally {
      tx.abort();
    }
    for (const activity of ["read", "write"] as const) {
      const active = runtime.edit();
      try {
        if (activity === "read") input.withTx(active).get();
        else input.withTx(active).set(1);
        expect(() => restrictToLocalReads(active.tx)).toThrow("must precede");
      } finally {
        active.abort();
      }
    }
  });

  it("latches revoked conditions while allowing a fresh attempt after recovery", () => {
    const tx = runtime.edit();
    const address = toMemorySpaceAddress(
      runtime.getCell(space, "condition", undefined).getAsNormalizedFullLink(),
    );
    let current = true;
    try {
      expect(() => requireLocalReadCondition(tx.tx, address, () => true))
        .toThrow("policy is required");
      expect(localReadsReady(tx)).toBe(true);
      expect(usesLocalReads(undefined)).toBe(false);
      releaseLocalReadBasis(tx);
      assertLocalReadAvailable(tx.tx, address, () => false);
      restrictToLocalReads(tx.tx);
      requireLocalReadCondition(tx.tx, address, () => current);
      current = false;
      expect(localReadsReady(tx)).toBe(false);
      const failure = validateLocalReadBasis(tx);
      expect(failure).toBeInstanceOf(LocalReadUnavailable);
      expect(failure?.address).toEqual(address);
      current = true;
      expect(localReadsReady(tx)).toBe(true);
      expect(validateLocalReadBasis(tx)).toBe(failure);
      releaseLocalReadBasis(tx);
      expect(usesLocalReads(tx)).toBe(true);
      expect(localReadFailure(tx)).toBe(failure);
    } finally {
      tx.abort();
    }
  });

  for (const catchSignal of [false, true]) {
    it(`aborts commit preparation when unavailable data is ${catchSignal ? "caught" : "thrown"}`, async () => {
      const output = runtime.getCell(space, "prepare result", undefined);
      const missing = runtime.getCell(space, "prepare missing", undefined);
      await runtime.editWithRetry((tx) => output.withTx(tx).set("confirmed"));
      await output.sync();
      const tx = runtime.edit();
      restrictToLocalReads(tx.tx);
      output.withTx(tx).set("preview");
      using preparation = stub(tx, "prepareForCommit", () => {
        if (catchSignal) {
          expect(() => missing.withTx(tx).get()).toThrow(LocalReadUnavailable);
        } else missing.withTx(tx).get();
      });
      const result = await tx.commit();
      expect(preparation.calls).toHaveLength(1);
      expect(result.error?.name).toBe("StorageTransactionAborted");
      expect(output.get()).toBe("confirmed");
    });
  }

  for (const disposition of ["commit", "seal"] as const) {
    it(`rejects a raw ${disposition} after its local input coverage is revoked`, async () => {
      const output = runtime.getCell(space, "raw result", undefined);
      await runtime.editWithRetry((tx) => output.withTx(tx).set("confirmed"));
      await output.sync();
      const tx = storage.edit();
      const address = toMemorySpaceAddress(output.getAsNormalizedFullLink());
      let covered = true;
      let seals = 0;
      restrictToLocalReads(tx);
      expect(tx.write(address, "preview").error).toBeUndefined();
      assertLocalReadAvailable(tx, address, () => covered);
      covered = false;
      const result = disposition === "commit"
        ? await tx.commit()
        : await tx.sealInto!({
          sealSpaceCommit: () => {
            seals++;
            return Promise.resolve({ ok: {} });
          },
        });
      expect(result.error?.name).toBe("StorageTransactionAborted");
      expect(seals).toBe(0);
      expect(output.get()).toBe("confirmed");
    });
  }

  for (const phase of ["handler", "prepare-throw", "prepare-catch"] as const) {
    it(`finishes an event once when an unavailable input is encountered in ${phase}`, async () => {
      const output = runtime.getCell(space, "event result", undefined);
      const missing = runtime.getCell(space, "event missing", undefined);
      const event = runtime.getCell<unknown>(space, "event stream", {
        asCell: ["stream"],
      });
      await runtime.editWithRetry((tx) => {
        output.withTx(tx).set("confirmed");
      });
      await output.sync();
      await event.sync();
      let caught: unknown;
      let finalFailure: unknown;
      let attempts = 0;
      const outcomes: string[] = [];
      const handler: EventHandler = (tx) => {
        attempts++;
        restrictToLocalReads(tx.tx);
        output.withTx(tx).set("preview");
        if (phase === "handler") {
          try {
            missing.withTx(tx).get();
          } catch (error) {
            caught = error;
          }
        }
      };
      const cancel = runtime.scheduler.addEventHandler(
        handler,
        event.getAsNormalizedFullLink(),
      );
      const prepare = runtime.prepareTxForCommit.bind(runtime);
      using _preparation = stub(runtime, "prepareTxForCommit", (tx) => {
        if (usesLocalReads(tx) && phase !== "handler") {
          if (phase === "prepare-catch") {
            try {
              missing.withTx(tx).get();
            } catch (error) {
              caught = error;
            }
          } else missing.withTx(tx).get();
        }
        prepare(tx);
      });
      using sync = stub(storage, "syncCell", () => {
        throw new Error("Unexpected speculative pull");
      });
      try {
        runtime.scheduler.queueEvent(
          event.getAsNormalizedFullLink(),
          {},
          true,
          (tx) => {
            outcomes.push(tx.status().status);
            finalFailure = localReadFailure(tx);
          },
        );
        await runtime.idle();
        expect(attempts).toBe(1);
        if (phase !== "prepare-throw") {
          expect(caught).toBeInstanceOf(LocalReadUnavailable);
        }
        expect(finalFailure).toBeInstanceOf(LocalReadUnavailable);
        expect(outcomes).toEqual(["error"]);
        expect(output.get()).toBe("confirmed");
        expect(sync.calls).toHaveLength(0);
      } finally {
        cancel();
      }
    });
  }

  it("does not retry a rejected event after its local condition expires", async () => {
    const output = runtime.getCell(space, "rejected event", undefined);
    const event = runtime.getCell<unknown>(space, "rejected event stream", {
      asCell: ["stream"],
    });
    await runtime.editWithRetry((tx) => {
      output.withTx(tx).set("confirmed");
    });
    await output.sync();
    await event.sync();
    const finished = Promise.withResolvers<void>();
    const outcomes: string[] = [];
    let current = true;
    let attempt: IExtendedStorageTransaction | undefined;
    let attempts = 0;
    const server = (storage as unknown as { server(): Server }).server();
    using rejection = stub(server, "transact", (message, publishVerdict) => {
      current = false;
      const result: Awaited<ReturnType<typeof server.transact>> = {
        type: "response",
        requestId: message.requestId,
        error: { name: "ConflictError", message: "Input superseded" },
      };
      publishVerdict?.(result);
      return Promise.resolve(result);
    });
    const cancel = runtime.scheduler.addEventHandler((tx) => {
      attempt = tx;
      attempts++;
      restrictToLocalReads(tx.tx);
      requireLocalReadCondition(
        tx.tx,
        toMemorySpaceAddress(output.getAsNormalizedFullLink()),
        () => current,
      );
      output.withTx(tx).set("preview");
    }, event.getAsNormalizedFullLink());
    try {
      runtime.scheduler.queueEvent(
        event.getAsNormalizedFullLink(),
        {},
        true,
        (tx) => {
          outcomes.push(tx.status().status);
          finished.resolve();
        },
      );
      await finished.promise;
      await runtime.idle();
      expect(attempts).toBe(1);
      expect(attempt).toBeDefined();
      expect(localReadFailure(attempt!)).toBeInstanceOf(LocalReadUnavailable);
      expect(localReadsReady(attempt!)).toBe(true);
      expect(rejection.calls).toHaveLength(1);
      expect(outcomes).toEqual(["error"]);
      expect(output.get()).toBe("confirmed");
    } finally {
      cancel();
    }
  });

  it("propagates a preparation error unrelated to local data availability", async () => {
    const output = runtime.getCell(space, "failed preparation", undefined);
    await runtime.editWithRetry((tx) => output.withTx(tx).set("confirmed"));
    await output.sync();
    const tx = runtime.edit();
    restrictToLocalReads(tx.tx);
    output.withTx(tx).set("preview");
    const failure = new Error("Preparation failed");
    using _preparation = stub(tx, "prepareForCommit", () => {
      throw failure;
    });
    try {
      await expect(tx.commit()).rejects.toBe(failure);
      expect(output.get()).toBe("confirmed");
    } finally {
      tx.abort();
    }
  });
});
