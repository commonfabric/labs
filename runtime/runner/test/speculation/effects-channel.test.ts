import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type EffectIntentEntry,
  SERVER_EXECUTION_EFFECTS_DOC_ID,
  type SessionEffectsDocValue,
} from "@commonfabric/memory/v2";
import { EffectsChannel } from "../../src/speculation/effects-channel.ts";
import type {
  IStorageNotification,
  MemorySpace,
} from "../../src/storage/interface.ts";
import { captureLogs } from "../support/captured-logs.ts";
import { flushMicrotasks } from "../speculation-intent-test-utils.ts";

const SPACE: MemorySpace = "did:key:z6MkEffectsChannelSpace";

const navigateEntry = (nonce: string, targetId = "of:target") => ({
  nonce,
  kind: "navigate" as const,
  args: { target: { id: targetId, path: [] } },
  issuedIn: null,
});

/**
 * An `EffectsChannel` over a stand-in runtime: one effects doc per space
 * the test sets, a notification relay `deliver()` drives, a navigation
 * callback that records each target it is handed, and an ack path that
 * records each nonce it stages before committing it as the test says.
 */
const channelHarness = (
  options: {
    navigate?: boolean;
    sealDestination?: object;
  } = {},
) => {
  const subscribers = new Set<IStorageNotification>();
  let value: SessionEffectsDocValue | undefined;
  let openError: Error | undefined;
  let readError: Error | undefined;
  let editError: Error | undefined;
  let sync: () => Promise<unknown> = () => Promise.resolve({ ok: {} });
  let commit: () => Promise<{ error?: Error }> = () => Promise.resolve({});
  const syncs: string[] = [];
  const navigations: string[] = [];
  const stagedAcks: string[] = [];
  const runtime = {
    installedSealDestination: options.sealDestination,
    storageManager: {
      subscribe: (subscription: IStorageNotification) => {
        subscribers.add(subscription);
      },
      unsubscribe: (subscription: IStorageNotification) => {
        subscribers.delete(subscription);
      },
      open: (space: MemorySpace) => {
        if (openError !== undefined) throw openError;
        return {
          sync: (id: string, _selector: unknown, scope: string) => {
            syncs.push(`${space} ${id} ${scope}`);
            return sync();
          },
          replica: {
            getDocument: () => {
              if (readError !== undefined) throw readError;
              return value === undefined ? undefined : { value };
            },
          },
        };
      },
    },
    trackAsyncWork: () => {},
    navigateCallback: options.navigate === false
      ? undefined
      : (cell: { id: string }) => {
        navigations.push(cell.id);
      },
    getCellFromLink: (link: { id: string; path: string[] }) => ({
      id: link.id,
      withTx: () => ({
        set: () => {
          stagedAcks.push(link.path[1]);
        },
      }),
    }),
    edit: () => {
      if (editError !== undefined) throw editError;
      return { commit: () => ({ settled: commit() }) };
    },
  };
  const channel = new EffectsChannel(runtime as never);

  /** Replace the effects doc and notify the channel of the change. */
  const deliver = (next: SessionEffectsDocValue) => {
    value = next;
    for (const subscriber of [...subscribers]) {
      subscriber.next({
        type: "integrate",
        space: SPACE,
        changes: [{
          address: {
            id: SERVER_EXECUTION_EFFECTS_DOC_ID,
            scope: "session",
            path: ["value", "entries"],
          },
          before: null,
          after: null,
        }],
      });
    }
  };
  return {
    channel,
    deliver,
    syncs,
    navigations,
    stagedAcks,
    setValue: (next: SessionEffectsDocValue) => {
      value = next;
    },
    failOpen: (error: Error | undefined) => {
      openError = error;
    },
    failRead: (error: Error | undefined) => {
      readError = error;
    },
    failEdit: (error: Error | undefined) => {
      editError = error;
    },
    setSync: (next: () => Promise<unknown>) => {
      sync = next;
    },
    setCommit: (next: () => Promise<{ error?: Error }>) => {
      commit = next;
    },
  };
};

describe("EffectsChannel", () => {
  describe("instance members", () => {
    describe("enactOnce()", () => {
      it("returns `true` without running its work while an enactment of the same nonce is in flight and then succeeds", async () => {
        const { channel } = channelHarness();
        const first = Promise.withResolvers<void>();
        let secondRan = false;
        const firstResult = channel.enactOnce("n1", () => first.promise);
        const secondResult = channel.enactOnce("n1", () => {
          secondRan = true;
          return Promise.resolve();
        });
        first.resolve();
        expect(await firstResult).toBe(true);
        expect(await secondResult).toBe(true);
        expect(secondRan).toBe(false);
        expect(channel.hasEnacted("n1")).toBe(true);
      });

      it("runs its own work when the enactment in flight for the nonce fails", async () => {
        const { channel } = channelHarness();
        const first = Promise.withResolvers<void>();
        let secondRan = false;
        const firstResult = channel.enactOnce("n1", () => first.promise);
        const secondResult = channel.enactOnce("n1", () => {
          secondRan = true;
          return Promise.resolve();
        });
        {
          using _logs = captureLogs("effects-channel");
          first.reject(new Error("navigation failed"));
          expect(await firstResult).toBe(false);
        }
        expect(await secondResult).toBe(true);
        expect(secondRan).toBe(true);
        expect(channel.enactedNonceCount).toBe(1);
      });
    });

    describe("ensureSubscribed()", () => {
      it("watches each space once, and reconciles the stored doc the watch brings", async () => {
        const h = channelHarness();
        h.setValue({ entries: [navigateEntry("n1")] });
        h.channel.ensureSubscribed(SPACE);
        h.channel.ensureSubscribed(SPACE);
        await flushMicrotasks();
        expect(h.syncs).toEqual([
          `${SPACE} ${SERVER_EXECUTION_EFFECTS_DOC_ID} session`,
        ]);
        expect(h.channel.listenerInstalled).toBe(true);
        expect(h.navigations).toEqual(["of:target"]);
        expect(h.stagedAcks).toEqual(["n1"]);
      });

      it("does not watch a space once the channel is closed", () => {
        const h = channelHarness();
        h.channel.close();
        h.channel.ensureSubscribed(SPACE);
        expect(h.syncs).toEqual([]);
        expect(h.channel.listenerInstalled).toBe(false);
      });

      it("does not watch a space on a runtime with a seal destination installed", () => {
        const h = channelHarness({ sealDestination: {} });
        h.channel.ensureSubscribed(SPACE);
        expect(h.syncs).toEqual([]);
        expect(h.channel.listenerInstalled).toBe(false);
      });

      it("logs `effects-resubscribe-read-failed` and enacts nothing when the watch's read rejects", async () => {
        const h = channelHarness();
        h.setValue({ entries: [navigateEntry("n1")] });
        h.setSync(() => Promise.reject(new Error("pull rejected")));
        using logs = captureLogs("effects-channel");
        h.channel.ensureSubscribed(SPACE);
        await flushMicrotasks();
        expect(logs.textsOf("effects-resubscribe-read-failed")).toEqual([
          `effects-doc re-read for ${SPACE} failed; unacked intents enact ` +
          "only on the next push pull rejected",
        ]);
        expect(h.navigations).toEqual([]);
      });

      it("logs `effects-subscribe-failed` when the space cannot be opened, and watches the space on a later call", async () => {
        const h = channelHarness();
        h.failOpen(new Error("space unavailable"));
        {
          using logs = captureLogs("effects-channel");
          h.channel.ensureSubscribed(SPACE);
          expect(logs.textsOf("effects-subscribe-failed")).toEqual([
            `effects-doc subscription for ${SPACE} failed; intents for ` +
            "this space will not enact in this runtime space unavailable",
          ]);
        }
        expect(h.syncs).toEqual([]);

        h.failOpen(undefined);
        h.channel.ensureSubscribed(SPACE);
        await flushMicrotasks();
        expect(h.syncs).toEqual([
          `${SPACE} ${SERVER_EXECUTION_EFFECTS_DOC_ID} session`,
        ]);
      });
    });

    describe("reconciling a delivery", () => {
      it("logs each reconcile at `debug`, naming the space", async () => {
        const h = channelHarness();
        h.channel.ensureSubscribed(SPACE);
        await flushMicrotasks();
        using logs = captureLogs("effects-channel");
        h.deliver({ entries: [] });
        await flushMicrotasks();
        expect(logs.textsOf("effects-reconcile")).toEqual([
          `effects reconcile for ${SPACE}`,
        ]);
      });

      it("logs `effects-read-failed` and enacts nothing when the doc cannot be read", async () => {
        const h = channelHarness();
        h.channel.ensureSubscribed(SPACE);
        await flushMicrotasks();
        h.failRead(new Error("replica closed"));
        using logs = captureLogs("effects-channel");
        h.deliver({ entries: [navigateEntry("n1")] });
        await flushMicrotasks();
        expect(logs.textsOf("effects-read-failed")).toEqual([
          `effects-doc read for ${SPACE} failed; reconcile skipped ` +
          "replica closed",
        ]);
        expect(h.navigations).toEqual([]);
      });

      it("skips an entry without a string nonce and an acked entry, and enacts the rest", async () => {
        const h = channelHarness();
        h.channel.ensureSubscribed(SPACE);
        await flushMicrotasks();
        const malformed = { ...navigateEntry("unused"), nonce: 7 };
        h.deliver({
          entries: [
            malformed as unknown as EffectIntentEntry,
            navigateEntry("acked", "of:acked"),
            navigateEntry("fresh", "of:fresh"),
          ],
          acks: { acked: true },
        });
        await flushMicrotasks();
        expect(h.navigations).toEqual(["of:fresh"]);
        expect(h.stagedAcks).toEqual(["fresh"]);
      });

      it("logs `unknown-intent-kind` for an entry of a kind it does not enact, and leaves it unacked", async () => {
        const h = channelHarness();
        h.channel.ensureSubscribed(SPACE);
        await flushMicrotasks();
        using logs = captureLogs("effects-channel");
        const unknown = { ...navigateEntry("n1"), kind: "teleport" };
        h.deliver({ entries: [unknown as unknown as EffectIntentEntry] });
        await flushMicrotasks();
        expect(logs.textsOf("unknown-intent-kind")).toEqual([
          "effects intent n1 carries unknown kind teleport; left unacked",
        ]);
        expect(h.navigations).toEqual([]);
        expect(h.stagedAcks).toEqual([]);
      });

      it("logs `enact-failed` for a navigation without a target, and leaves it unacked", async () => {
        const h = channelHarness();
        h.channel.ensureSubscribed(SPACE);
        await flushMicrotasks();
        using logs = captureLogs("effects-channel");
        const targetless = { ...navigateEntry("n1"), args: {} };
        h.deliver({ entries: [targetless as unknown as EffectIntentEntry] });
        await flushMicrotasks();
        expect(logs.textsOf("enact-failed")).toEqual([
          "navigate enactment for n1 could not be staged; left unacked " +
          "intent carries no target",
        ]);
        expect(h.channel.hasEnacted("n1")).toBe(false);
        expect(h.stagedAcks).toEqual([]);
      });

      it("acks an intent that arrives while its optimistic enactment is in flight only once that enactment succeeds", async () => {
        const h = channelHarness();
        h.channel.ensureSubscribed(SPACE);
        await flushMicrotasks();
        const flush = Promise.withResolvers<void>();
        const enacted = h.channel.enactOnce("n1", () => flush.promise);
        h.deliver({ entries: [navigateEntry("n1")] });
        await flushMicrotasks();
        expect(h.stagedAcks).toEqual([]);
        flush.resolve();
        expect(await enacted).toBe(true);
        await flushMicrotasks();
        expect(h.stagedAcks).toEqual(["n1"]);
        expect(h.navigations).toEqual([]);
      });

      it("does not ack an intent whose in-flight optimistic enactment fails", async () => {
        const h = channelHarness();
        h.channel.ensureSubscribed(SPACE);
        await flushMicrotasks();
        const flush = Promise.withResolvers<void>();
        const enacted = h.channel.enactOnce("n1", () => flush.promise);
        h.deliver({ entries: [navigateEntry("n1")] });
        await flushMicrotasks();
        using _logs = captureLogs("effects-channel");
        flush.reject(new Error("navigation failed"));
        expect(await enacted).toBe(false);
        await flushMicrotasks();
        expect(h.stagedAcks).toEqual([]);
        expect(h.channel.hasEnacted("n1")).toBe(false);
      });
    });

    describe("acking an enacted intent", () => {
      // Each case enacts `n1` on its first delivery, so the second delivery
      // of the same unacked doc acks without navigating again.

      const enactedHarness = async () => {
        const h = channelHarness();
        h.channel.ensureSubscribed(SPACE);
        await flushMicrotasks();
        h.deliver({ entries: [navigateEntry("n1")] });
        await flushMicrotasks();
        expect(h.navigations).toEqual(["of:target"]);
        expect(h.stagedAcks).toEqual(["n1"]);
        return h;
      };

      it("logs `ack-failed` when the ack commit fails, and acks again on the next delivery", async () => {
        const h = await enactedHarness();
        h.setCommit(() => Promise.resolve({ error: new Error("conflict") }));
        using logs = captureLogs("effects-channel");
        h.deliver({ entries: [navigateEntry("n1")] });
        await flushMicrotasks();
        expect(logs.textsOf("ack-failed")).toEqual([
          "effects ack for n1 failed; retrying on the next delivery conflict",
        ]);
        h.deliver({ entries: [navigateEntry("n1")] });
        await flushMicrotasks();
        expect(h.stagedAcks).toEqual(["n1", "n1", "n1"]);
        expect(h.navigations).toEqual(["of:target"]);
      });

      it("logs `ack-failed` when the ack commit rejects", async () => {
        const h = await enactedHarness();
        h.setCommit(() => Promise.reject(new Error("transport gone")));
        using logs = captureLogs("effects-channel");
        h.deliver({ entries: [navigateEntry("n1")] });
        await flushMicrotasks();
        expect(logs.textsOf("ack-failed")).toEqual([
          "effects ack for n1 rejected; retrying on the next delivery " +
          "transport gone",
        ]);
      });

      it("logs `ack-failed` when the ack cannot be staged, and stages it on the next delivery", async () => {
        const h = await enactedHarness();
        h.failEdit(new Error("runtime disposing"));
        {
          using logs = captureLogs("effects-channel");
          h.deliver({ entries: [navigateEntry("n1")] });
          await flushMicrotasks();
          expect(logs.textsOf("ack-failed")).toEqual([
            "effects ack for n1 could not be staged runtime disposing",
          ]);
        }
        expect(h.stagedAcks).toEqual(["n1"]);
        h.failEdit(undefined);
        h.deliver({ entries: [navigateEntry("n1")] });
        await flushMicrotasks();
        expect(h.stagedAcks).toEqual(["n1", "n1"]);
      });
    });

    describe("close()", () => {
      it("releases the listener, and no later delivery enacts", async () => {
        const h = channelHarness();
        h.channel.ensureSubscribed(SPACE);
        await flushMicrotasks();
        h.channel.close();
        h.channel.close();
        expect(h.channel.listenerInstalled).toBe(false);
        h.deliver({ entries: [navigateEntry("n1")] });
        await flushMicrotasks();
        expect(h.navigations).toEqual([]);
      });
    });
  });
});
