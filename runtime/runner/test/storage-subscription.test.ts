import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type {
  IStorageNotification,
  StorageNotification,
} from "../src/storage/interface.ts";
import {
  create,
  StorageNotificationRelay,
} from "../src/storage/subscription.ts";

const SPACE = "did:key:zTestStorageSubscription" as MemorySpace;

const reset = (): StorageNotification => ({ type: "reset", space: SPACE });

/** Subscriber that records what it received and reports continued interest. */
function recorder(): IStorageNotification & { seen: StorageNotification[] } {
  const seen: StorageNotification[] = [];
  return {
    seen,
    next(notification) {
      seen.push(notification);
      return { done: false };
    },
  };
}

describe("StorageNotificationRelay", () => {
  it("broadcasts to every subscriber", () => {
    const relay = new StorageNotificationRelay();
    const a = recorder();
    const b = recorder();
    relay.subscribe(a);
    relay.subscribe(b);

    const notification = reset();
    assertEquals(relay.next(notification), { done: false });

    assertEquals(a.seen, [notification]);
    assertEquals(b.seen, [notification]);
  });

  it("reports whether it has subscribers", () => {
    const relay = new StorageNotificationRelay();
    assertEquals(relay.hasSubscribers(), false);

    const one = recorder();
    relay.subscribe(one);
    assertEquals(relay.hasSubscribers(), true);

    relay.unsubscribe(one);
    assertEquals(relay.hasSubscribers(), false);
  });

  it("drops a subscriber that reports done, and keeps the rest", () => {
    const relay = new StorageNotificationRelay();
    const once: IStorageNotification & { calls: number } = {
      calls: 0,
      next() {
        this.calls++;
        return { done: true };
      },
    };
    const staying = recorder();
    relay.subscribe(once);
    relay.subscribe(staying);

    relay.next(reset());
    relay.next(reset());

    // The done-reporting subscriber is not called a second time, and its
    // departure does not disturb the one that remains.
    assertEquals(once.calls, 1);
    assertEquals(staying.seen.length, 2);
    assertEquals(relay.hasSubscribers(), true);
  });

  it("keeps a subscriber that returns undefined", () => {
    const relay = new StorageNotificationRelay();
    const quiet: IStorageNotification & { calls: number } = {
      calls: 0,
      next() {
        this.calls++;
        return undefined;
      },
    };
    relay.subscribe(quiet);

    relay.next(reset());
    relay.next(reset());

    assertEquals(quiet.calls, 2);
  });

  it("isolates a throwing subscriber from the others", () => {
    const relay = new StorageNotificationRelay();
    const throwing: IStorageNotification = {
      next() {
        throw new Error("subscriber blew up");
      },
    };
    const after = recorder();
    relay.subscribe(throwing);
    relay.subscribe(after);

    // The throw is swallowed, so the broadcast completes and later
    // subscribers still receive the notification.
    const notification = reset();
    assertEquals(relay.next(notification), { done: false });
    assertEquals(after.seen, [notification]);

    // A throwing subscriber is left subscribed, so it is tried again.
    assertEquals(relay.next(reset()), { done: false });
    assertEquals(after.seen.length, 2);
  });

  it("adopts a caller-supplied subscriber set", () => {
    const seeded = recorder();
    const relay = new StorageNotificationRelay(new Set([seeded]));
    assertEquals(relay.hasSubscribers(), true);

    relay.next(reset());
    assertEquals(seeded.seen.length, 1);
  });

  it("create() builds an empty relay", () => {
    const relay = create();
    assertEquals(relay instanceof StorageNotificationRelay, true);
    assertEquals(relay.hasSubscribers(), false);
  });
});
