import { expect } from "@std/expect";

import { subscribeWhileHeld } from "../src/immutable-cell.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("subscribeWhileHeld()", () => {
  // A hand-rolled notifier stands in for the schema registry, so each case
  // sees exactly which listeners are subscribed and when each notification
  // is sent.
  const notifier = () => {
    const listeners = new Set<() => void>();
    return {
      listeners,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      notify: () => [...listeners].forEach((listener) => listener()),
    };
  };

  it("passes the held target to `refresh` on each notification", () => {
    const { listeners, subscribe, notify } = notifier();
    const target = { name: "store" };
    const refreshed: object[] = [];

    subscribeWhileHeld({ deref: () => target }, subscribe, (held) => {
      refreshed.push(held);
    });
    notify();
    notify();

    expect(refreshed).toEqual([target, target]);
    expect(listeners.size).toBe(1);
  });

  it("unsubscribes, without refreshing, at the first notification after the target is gone", () => {
    const { listeners, subscribe, notify } = notifier();
    const target = { name: "store" };
    let held: typeof target | undefined = target;
    const refreshed: object[] = [];

    subscribeWhileHeld({ deref: () => held }, subscribe, (store) => {
      refreshed.push(store);
    });
    held = undefined;
    notify();
    // The target coming back does not resubscribe: nothing is listening.
    held = target;
    notify();

    expect(refreshed).toEqual([]);
    expect(listeners.size).toBe(0);
  });

  it("returns a function that unsubscribes", () => {
    const { listeners, subscribe, notify } = notifier();
    const refreshed: object[] = [];

    const unsubscribe = subscribeWhileHeld(
      { deref: () => ({}) },
      subscribe,
      (store) => refreshed.push(store),
    );
    unsubscribe();
    notify();

    expect(refreshed).toEqual([]);
    expect(listeners.size).toBe(0);
  });
});
