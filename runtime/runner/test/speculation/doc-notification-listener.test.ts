import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CoalescedDocListener } from "../../src/speculation/doc-notification-listener.ts";
import type {
  IStorageNotification,
  MemorySpace,
  StorageNotification,
} from "../../src/storage/interface.ts";

const SPACE: MemorySpace = "did:key:z6MkDocListenerSpace";
const WANTED = "of:wanted";
const UNWANTED = "of:unwanted";

/** A notification relay that records its subscribers, and a consumer that
 * wants `WANTED` and records each call it receives. */
const harness = (
  options: { unsubscribe?: (subscription: IStorageNotification) => void } = {},
) => {
  const subscribers = new Set<IStorageNotification>();
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  const calls: Array<{
    space: MemorySpace;
    id: string | undefined;
    paths: ReadonlyArray<ReadonlyArray<string>>;
  }> = [];
  const listener = new CoalescedDocListener({
    subscribe: (subscription) => {
      subscribeCalls += 1;
      subscribers.add(subscription);
    },
    unsubscribe: (subscription) => {
      unsubscribeCalls += 1;
      if (options.unsubscribe !== undefined) options.unsubscribe(subscription);
      else subscribers.delete(subscription);
    },
  }, {
    wants: (_space, id) => id === WANTED,
    onNotify: (space, id, paths) => calls.push({ space, id, paths }),
  });

  /** Dispatches one notification to every subscriber, returning what each
   * `next` returned. */
  const dispatch = (notification: StorageNotification) =>
    [...subscribers].map((subscriber) => subscriber.next(notification));
  const changeOf = (id: "of:wanted" | "of:unwanted", path: string[]) => ({
    address: { id, scope: "space" as const, path },
    before: 0,
    after: 1,
  });
  const integrate = (
    changes: Array<ReturnType<typeof changeOf>>,
  ): StorageNotification => ({ type: "integrate", space: SPACE, changes });
  return {
    listener,
    calls,
    dispatch,
    changeOf,
    integrate,
    subscribers,
    subscribeCalls: () => subscribeCalls,
    unsubscribeCalls: () => unsubscribeCalls,
  };
};

describe("CoalescedDocListener", () => {
  describe("instance members", () => {
    describe("ensure()", () => {
      it("subscribes once however often it is called", () => {
        const h = harness();
        expect(h.listener.installed).toBe(false);
        h.listener.ensure();
        h.listener.ensure();
        expect(h.subscribeCalls()).toBe(1);
        expect(h.listener.installed).toBe(true);
      });

      it("does not subscribe again after a release", () => {
        const h = harness();
        h.listener.ensure();
        h.listener.release();
        h.listener.ensure();
        expect(h.subscribeCalls()).toBe(1);
        expect(h.listener.installed).toBe(false);
      });
    });

    describe("release()", () => {
      it("unsubscribes once however often it is called", () => {
        const h = harness();
        h.listener.ensure();
        h.listener.release();
        h.listener.release();
        expect(h.unsubscribeCalls()).toBe(1);
        expect(h.subscribers.size).toBe(0);
      });

      it("drops a dispatch that was pending when it ran", async () => {
        const h = harness();
        h.listener.ensure();
        h.dispatch(h.integrate([h.changeOf(WANTED, ["value"])]));
        h.listener.release();
        await Promise.resolve();
        expect(h.calls).toEqual([]);
      });

      it("returns normally when the relay's unsubscribe throws, and the subscription then ends itself on the next notification", async () => {
        const h = harness({
          unsubscribe: () => {
            throw new Error("relay refused the unsubscribe");
          },
        });
        h.listener.ensure();
        h.listener.release();
        expect(h.listener.installed).toBe(false);
        expect(h.subscribers.size).toBe(1);
        expect(h.dispatch(h.integrate([h.changeOf(WANTED, ["value"])])))
          .toEqual([{ done: true }]);
        await Promise.resolve();
        expect(h.calls).toEqual([]);
      });
    });

    describe("notification dispatch", () => {
      it("calls the consumer once per doc in a microtask, with every path recorded since the last call, and skips docs it does not want", async () => {
        const h = harness();
        h.listener.ensure();
        expect(h.dispatch(h.integrate([
          h.changeOf(WANTED, ["value", "entries"]),
          h.changeOf(UNWANTED, ["value"]),
        ]))).toEqual([undefined]);
        h.dispatch(h.integrate([h.changeOf(WANTED, ["value", "acks"])]));
        expect(h.calls).toEqual([]);
        await Promise.resolve();
        expect(h.calls).toEqual([{
          space: SPACE,
          id: WANTED,
          paths: [["value", "entries"], ["value", "acks"]],
        }]);

        h.dispatch(h.integrate([h.changeOf(WANTED, ["value", "x"])]));
        await Promise.resolve();
        expect(h.calls.map((call) => call.paths)).toEqual([
          [["value", "entries"], ["value", "acks"]],
          [["value", "x"]],
        ]);
      });

      it("relays a reset as one call naming no doc and no paths", async () => {
        const h = harness();
        h.listener.ensure();
        h.dispatch({ type: "reset", space: SPACE });
        await Promise.resolve();
        expect(h.calls).toEqual([{ space: SPACE, id: undefined, paths: [] }]);
      });
    });
  });
});
