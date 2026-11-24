/** Exercises React-shaped subscriptions and mutations without bundling React. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { isObjectOrArray } from "@commonfabric/js-values/types";

import type { FabricClient, ResourceSnapshot } from "../src/guest.ts";
import { createFabricReact, type ReactHooks } from "../src/react.ts";

function containsValue(value: unknown, expected: unknown): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) {
    return value.some((item) => containsValue(item, expected));
  }
  if (value instanceof Map) {
    return [...value.entries()].some(([key, item]) =>
      containsValue(key, expected) || containsValue(item, expected)
    );
  }
  return isObjectOrArray(value) &&
    Object.values(value).some((item) => containsValue(item, expected));
}

function withUpdater<
  T,
  Remote extends {
    getSnapshot(): ResourceSnapshot<T>;
    pull(): Promise<T>;
    set(value: T): Promise<void>;
  },
>(
  remote: Remote,
): Remote & { update(updater: (current: T) => T): Promise<void> } {
  let tail: Promise<void> | undefined;
  return Object.assign(remote, {
    update(updater: (current: T) => T): Promise<void> {
      const operation = async () => {
        const snapshot = remote.getSnapshot();
        const current = snapshot.status === "ready"
          ? snapshot.value
          : await remote.pull();
        await remote.set(updater(current));
      };
      const writing = tail ? tail.then(operation) : operation();
      tail = writing.catch(() => {});
      return writing;
    },
  });
}

/**
 * Renders `useSqliteQuery()` against `databases` with hooks that keep their
 * state between renders, by call order, as React's do. `render()` renders
 * again, and `effects` holds what the latest render asked to run.
 */
function queryHarness(databases: Record<string, unknown>) {
  const client = {
    sqlite: (name: string) => databases[name],
  } as unknown as FabricClient;
  const refs: Array<{ current: unknown }> = [];
  const states: unknown[] = [];
  const updated = new Set<() => void>();
  let refIndex = 0;
  let stateIndex = 0;
  let effects: Array<() => void | (() => void)> = [];
  const hooks: ReactHooks = {
    useCallback: (callback) => callback,
    useEffect: (effect) => effects.push(effect),
    useMemo: (factory) => factory(),
    useRef: (initial) => {
      const index = refIndex++;
      refs[index] ??= { current: initial };
      return refs[index] as { current: typeof initial };
    },
    useState: (initial) => {
      const index = stateIndex++;
      states[index] ??= typeof initial === "function"
        ? (initial as () => unknown)()
        : initial;
      return [
        states[index],
        (next: unknown) => {
          states[index] = typeof next === "function"
            ? (next as (current: unknown) => unknown)(states[index])
            : next;
          for (const listener of [...updated]) listener();
        },
      ] as never;
    },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  const { useSqliteQuery } = createFabricReact(hooks, client);
  return {
    states,
    get effects() {
      return effects;
    },
    render(name: string) {
      refIndex = 0;
      stateIndex = 0;
      effects = [];
      return useSqliteQuery(name, "SELECT owner FROM notes");
    },
    /** Resolves once the query's state next changes. */
    nextUpdate(): Promise<void> {
      return new Promise((resolve) => {
        const listener = () => {
          updated.delete(listener);
          resolve();
        };
        updated.add(listener);
      });
    },
  };
}

describe("React bridge adapter", () => {
  it("supports interface-shaped cell values and updater writes", async () => {
    interface Counter {
      count: number;
    }

    const writes: Counter[] = [];
    const reads: string[] = [];
    let snapshot: ResourceSnapshot<Counter> = { status: "loading" };
    const remote = withUpdater({
      getSnapshot: () => snapshot,
      subscribeSnapshot: () => () => {},
      pull: () => {
        reads.push("pull");
        snapshot = { status: "ready", value: { count: 2 } };
        return Promise.resolve({ count: 2 });
      },
      set: (value: Counter) => {
        writes.push(value);
        return Promise.resolve();
      },
    });
    const client = { cell: () => remote } as unknown as FabricClient;
    const effects: Array<() => void | (() => void)> = [];
    const hooks: ReactHooks = {
      useCallback: (callback) => callback,
      useEffect: (effect) => effects.push(effect),
      useMemo: (factory) => factory(),
      useRef: (initial) => ({ current: initial }),
      useState: (initial) =>
        [
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial,
          () => {},
        ] as never,
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    };
    const { useCell } = createFabricReact(hooks, client);

    const counter = useCell<Counter>("counter");
    for (const effect of effects) effect();
    await counter.set((value) => ({ count: value.count + 1 }));

    expect(reads).toEqual(["pull"]);
    expect(writes).toEqual([{ count: 3 }]);
  });

  it("serializes overlapping updater writes against the latest snapshot", async () => {
    type Counter = { count: number };
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const writes: Counter[] = [];
    let snapshot: ResourceSnapshot<Counter> = {
      status: "ready",
      value: { count: 1 },
    };
    const remote = withUpdater({
      getSnapshot: () => snapshot,
      subscribeSnapshot: () => () => {},
      pull: () => Promise.resolve((snapshot as { value: Counter }).value),
      set: async (value: Counter) => {
        writes.push(value);
        if (writes.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        snapshot = { status: "ready", value };
      },
    });
    const client = { cell: () => remote } as unknown as FabricClient;
    const hooks: ReactHooks = {
      useCallback: (callback) => callback,
      useEffect: () => {},
      useMemo: (factory) => factory(),
      useRef: (initial) => ({ current: initial }),
      useState: (initial) =>
        [
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial,
          () => {},
        ] as never,
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    };
    const counter = createFabricReact(hooks, client).useCell<Counter>("count");

    const first = counter.set((value) => ({ count: value.count + 1 }));
    const second = counter.set((value) => ({ count: value.count + 1 }));
    await firstStarted.promise;
    expect(writes).toEqual([{ count: 2 }]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(writes).toEqual([{ count: 2 }, { count: 3 }]);
  });

  it("serializes updater writes from separate hooks for the same cell", async () => {
    type Counter = { count: number };
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const writes: Counter[] = [];
    let snapshot: ResourceSnapshot<Counter> = {
      status: "ready",
      value: { count: 1 },
    };
    const remote = withUpdater({
      getSnapshot: () => snapshot,
      subscribeSnapshot: () => () => {},
      pull: () => Promise.resolve((snapshot as { value: Counter }).value),
      set: async (value: Counter) => {
        writes.push(value);
        if (writes.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        snapshot = { status: "ready", value };
      },
    });
    const client = { cell: () => remote } as unknown as FabricClient;
    const hooks: ReactHooks = {
      useCallback: (callback) => callback,
      useEffect: () => {},
      useMemo: (factory) => factory(),
      useRef: (initial) => ({ current: initial }),
      useState: (initial) =>
        [
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial,
          () => {},
        ] as never,
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    };
    const { useCell } = createFabricReact(hooks, client);
    const firstHook = useCell<Counter>("count");
    const secondHook = useCell<Counter>("count");

    const first = firstHook.set((value) => ({ count: value.count + 1 }));
    const second = secondHook.set((value) => ({ count: value.count + 1 }));
    await firstStarted.promise;
    expect(writes).toEqual([{ count: 2 }]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(writes).toEqual([{ count: 2 }, { count: 3 }]);
  });

  it("serializes updater writes from separate adapters for the same cell", async () => {
    type Counter = { count: number };
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const writes: Counter[] = [];
    let snapshot: ResourceSnapshot<Counter> = {
      status: "ready",
      value: { count: 1 },
    };
    const remote = withUpdater({
      getSnapshot: () => snapshot,
      subscribeSnapshot: () => () => {},
      pull: () => Promise.resolve((snapshot as { value: Counter }).value),
      set: async (value: Counter) => {
        writes.push(value);
        if (writes.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        snapshot = { status: "ready", value };
      },
    });
    const client = { cell: () => remote } as unknown as FabricClient;
    const hooks: ReactHooks = {
      useCallback: (callback) => callback,
      useEffect: () => {},
      useMemo: (factory) => factory(),
      useRef: (initial) => ({ current: initial }),
      useState: (initial) =>
        [
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial,
          () => {},
        ] as never,
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    };
    const firstAdapter = createFabricReact(hooks, client);
    const secondAdapter = createFabricReact(hooks, client);
    const firstHook = firstAdapter.useCell<Counter>("count");
    const secondHook = secondAdapter.useCell<Counter>("count");

    const first = firstHook.set((value) => ({ count: value.count + 1 }));
    const second = secondHook.set((value) => ({ count: value.count + 1 }));
    await firstStarted.promise;
    expect(writes).toEqual([{ count: 2 }]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(writes).toEqual([{ count: 2 }, { count: 3 }]);
  });

  it("keeps the write queue when React discards memoized values", async () => {
    type Counter = { count: number };
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const writes: Counter[] = [];
    let snapshot: ResourceSnapshot<Counter> = {
      status: "ready",
      value: { count: 1 },
    };
    const remote = withUpdater({
      getSnapshot: () => snapshot,
      subscribeSnapshot: () => () => {},
      pull: () => Promise.resolve((snapshot as { value: Counter }).value),
      set: async (value: Counter) => {
        writes.push(value);
        if (writes.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        snapshot = { status: "ready", value };
      },
    });
    const other = {
      ...remote,
      getSnapshot: () => ({
        status: "ready",
        value: { count: 100 },
      } as const),
    };
    const client = {
      cell: (name: string) => name === "count" ? remote : other,
    } as unknown as FabricClient;
    const refs: Array<{ current: unknown }> = [];
    let refIndex = 0;
    const hooks: ReactHooks = {
      useCallback: (callback) => callback,
      useEffect: () => {},
      useMemo: (factory) => factory(),
      useRef: (initial) => {
        const index = refIndex++;
        refs[index] ??= { current: initial };
        return refs[index] as { current: typeof initial };
      },
      useState: (initial) =>
        [
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial,
          () => {},
        ] as never,
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    };
    const { useCell } = createFabricReact(hooks, client);
    const render = (name: string) => {
      refIndex = 0;
      return useCell<Counter>(name);
    };

    const first = render("count").set((value) => ({ count: value.count + 1 }));
    await firstStarted.promise;
    render("discarded");
    const second = render("count").set((value) => ({ count: value.count + 1 }));
    await Promise.resolve();
    expect(writes).toEqual([{ count: 2 }]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(writes).toEqual([{ count: 2 }, { count: 3 }]);
  });

  it("invalidates an active SQLite query subscription on cleanup", () => {
    let unsubscribed = false;
    const calls: string[] = [];
    const database = {
      query: () => {
        calls.push("query");
        return Promise.resolve({ rows: [] });
      },
      sink: () => {
        calls.push("subscribe");
        return () => {
          unsubscribed = true;
        };
      },
    };
    const client = { sqlite: () => database } as unknown as FabricClient;
    const effects: Array<() => void | (() => void)> = [];
    const hooks: ReactHooks = {
      useCallback: (callback) => callback,
      useEffect: (effect) => effects.push(effect),
      useMemo: (factory) => factory(),
      useRef: (initial) => ({ current: initial }),
      useState: (initial) =>
        [
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial,
          () => {},
        ] as never,
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    };
    const { useSqliteQuery } = createFabricReact(hooks, client);

    useSqliteQuery("database", "SELECT 1");
    const cleanup = effects[0]?.();
    expect(calls).toEqual(["subscribe", "query"]);
    expect(typeof cleanup).toBe("function");
    (cleanup as () => void)();
    expect(unsubscribed).toBe(true);
  });

  it("returns loading when the SQLite query identity changes", async () => {
    const harness = queryHarness({
      alice: {
        query: () => Promise.resolve({ rows: [{ owner: "alice" }] }),
        sink: () => () => {},
      },
      bob: {
        query: () => Promise.resolve({ rows: [{ owner: "bob" }] }),
        sink: () => () => {},
      },
    });

    expect(harness.render("alice").status).toBe("loading");
    harness.effects[0]?.();
    await harness.nextUpdate();
    expect(harness.render("alice")).toMatchObject({
      status: "ready",
      rows: [{ owner: "alice" }],
    });

    const bob = harness.render("bob");
    expect(bob).toMatchObject({
      status: "loading",
      rows: undefined,
      error: undefined,
    });
    expect(typeof bob.refresh).toBe("function");
    const cleanupBob = harness.effects[0]?.();
    expect(containsValue(harness.states[0], "alice")).toBe(false);
    if (typeof cleanupBob === "function") cleanupBob();
  });

  it("keeps the current query when a retained old refresh completes", async () => {
    const aliceInitial = Promise.withResolvers<{
      rows: Array<{ owner: string }>;
    }>();
    const bobResult = Promise.withResolvers<{
      rows: Array<{ owner: string }>;
    }>();
    const queries: string[] = [];
    let retainedAliceRefresh: (() => void) | undefined;
    const harness = queryHarness({
      alice: {
        query: () => {
          queries.push("alice");
          return aliceInitial.promise;
        },
        sink: (listener: () => void) => {
          retainedAliceRefresh = listener;
          return () => {};
        },
      },
      bob: {
        query: () => {
          queries.push("bob");
          return bobResult.promise;
        },
        sink: () => () => {},
      },
    });

    harness.render("alice");
    const cleanupAlice = harness.effects[0]?.() as () => void;
    cleanupAlice();
    harness.render("bob");
    const cleanupBob = harness.effects[0]?.() as () => void;
    retainedAliceRefresh?.();
    expect(queries).toEqual(["alice", "bob"]);

    const ready = harness.nextUpdate();
    bobResult.resolve({ rows: [{ owner: "bob" }] });
    await ready;
    aliceInitial.resolve({ rows: [{ owner: "oldest-alice" }] });
    // The hook took up Alice's query before this did, so its handler of the
    // result has run by the time this one does.
    await aliceInitial.promise;

    expect(harness.render("bob")).toMatchObject({
      status: "ready",
      rows: [{ owner: "bob" }],
    });
    cleanupBob();
  });

  describe("a SQLite query that fails", () => {
    for (
      const [what, cause] of [
        ["an `Error`", new Error("no such table")],
        ["anything else, as an `Error`", "no such table"],
      ] as const
    ) {
      it(`returns the error state carrying ${what}`, async () => {
        const query = Promise.withResolvers<{ rows: unknown[] }>();
        const harness = queryHarness({
          notes: { query: () => query.promise, sink: () => () => {} },
        });

        expect(harness.render("notes").status).toBe("loading");
        const cleanup = harness.effects[0]?.();
        const failed = harness.nextUpdate();
        query.reject(cause);
        await failed;

        expect(harness.render("notes")).toEqual({
          status: "error",
          rows: undefined,
          error: new Error("no such table"),
          refresh: expect.any(Function),
        });
        if (typeof cleanup === "function") cleanup();
      });
    }

    it("keeps the current query when an old query's failure arrives", async () => {
      const aliceQuery = Promise.withResolvers<{ rows: unknown[] }>();
      const bobQuery = Promise.withResolvers<{ rows: unknown[] }>();
      const harness = queryHarness({
        alice: { query: () => aliceQuery.promise, sink: () => () => {} },
        bob: { query: () => bobQuery.promise, sink: () => () => {} },
      });

      harness.render("alice");
      const cleanupAlice = harness.effects[0]?.();
      if (typeof cleanupAlice === "function") cleanupAlice();
      harness.render("bob");
      const cleanupBob = harness.effects[0]?.();
      const ready = harness.nextUpdate();
      bobQuery.resolve({ rows: [{ owner: "bob" }] });
      await ready;

      aliceQuery.reject(new Error("stale"));
      // The hook took up Alice's query before this did, so its handler of
      // the failure has run by the time this one does.
      await aliceQuery.promise.catch(() => {});

      expect(harness.render("bob")).toMatchObject({
        status: "ready",
        rows: [{ owner: "bob" }],
      });
      if (typeof cleanupBob === "function") cleanupBob();
    });
  });
});
