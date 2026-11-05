/** Exercises the React adapter with the browser's real React renderer. */

// @deno-types="@types/react"
import React, { act } from "react";
// @deno-types="@types/react-dom/client"
import { createRoot } from "react-dom/client";
import { expect } from "@std/expect";

import type {
  FabricClient,
  ResourceSnapshot,
  SqliteQueryInput,
} from "../src/guest.ts";
import { createFabricReact } from "../src/react.ts";

type Counter = { count: number };
type Note = { id: number; title: string };

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
  });
}

function perform(action: () => void): Promise<void> {
  return act(async () => {
    action();
    await Promise.resolve();
  });
}

Deno.test("React renders bridged Cells and SQLite invalidations", async () => {
  const environment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;

  let counterSnapshot: ResourceSnapshot<Counter | undefined> = {
    status: "loading",
  };
  let durableCounter: Counter | undefined;
  let initializeCount = 0;
  const cellListeners = new Set<() => void>();
  let writeTail = Promise.resolve();
  const publishCounter = (value: Counter | undefined) => {
    counterSnapshot = { status: "ready", value };
    for (const listener of cellListeners) listener();
  };
  const counter = {
    getSnapshot: () => counterSnapshot,
    subscribeSnapshot: (listener: () => void) => {
      cellListeners.add(listener);
      listener();
      return () => cellListeners.delete(listener);
    },
    pull: () => {
      publishCounter(durableCounter);
      return Promise.resolve(durableCounter);
    },
    initialize: (value: Counter) => {
      initializeCount++;
      durableCounter ??= value;
      publishCounter(durableCounter);
      return Promise.resolve(durableCounter);
    },
    set: (value: Counter) => {
      durableCounter = value;
      publishCounter(value);
      return Promise.resolve();
    },
    update: (
      updater: (current: Counter | undefined) => Counter | undefined,
    ) => {
      const write = writeTail.then(async () => {
        const current = counterSnapshot.status === "ready"
          ? counterSnapshot.value
          : await counter.pull();
        const next = updater(current);
        if (next === undefined) {
          throw new Error("Counter update returned undefined.");
        }
        await counter.set(next);
      });
      writeTail = write.catch(() => {});
      return write;
    },
  };

  let notes: Note[] = [{ id: 1, title: "First" }];
  let queryCount = 0;
  const databaseListeners = new Set<() => void>();
  const database = {
    query: () => {
      queryCount++;
      return Promise.resolve({ rows: notes.map((note) => ({ ...note })) });
    },
    sink: (listener: () => void) => {
      databaseListeners.add(listener);
      return () => databaseListeners.delete(listener);
    },
  };
  const client = {
    cell: () => counter,
    sqlite: () => database,
  } as unknown as FabricClient;
  const { useCell, useSqliteQuery } = createFabricReact(React, client);

  function App() {
    const count = useCell<Counter | undefined>("counter");
    const countValue = count.status === "ready" ? count.value : undefined;
    const query = useSqliteQuery<Note>(
      "appDatabase",
      "SELECT id, title FROM notes ORDER BY id",
    );
    React.useEffect(() => {
      if (count.status === "ready" && countValue === undefined) {
        void count.initialize({ count: 1 });
      }
    }, [count.status, countValue, count.initialize]);
    if (
      count.status !== "ready" || countValue === undefined ||
      query.status !== "ready"
    ) {
      return React.createElement("p", { id: "status" }, "Loading");
    }
    return React.createElement(
      "main",
      null,
      React.createElement(
        "button",
        {
          id: "increment",
          type: "button",
          onClick: () =>
            void count.set((value) => ({
              count: (value?.count ?? 0) + 1,
            })),
        },
        `Count ${countValue.count}`,
      ),
      React.createElement(
        "p",
        { id: "notes" },
        query.rows.map((note) => note.title).join(", "),
      ),
    );
  }

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await perform(() => root.render(React.createElement(App)));
    await flush();

    const button = host.querySelector<HTMLButtonElement>("#increment")!;
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(button.textContent?.trim()).toBe("Count 1");
    expect(initializeCount).toBe(1);
    expect(host.querySelector("#notes")?.textContent).toBe("First");

    await perform(() => button.click());
    await flush();
    expect(button.textContent?.trim()).toBe("Count 2");

    notes = [...notes, { id: 2, title: "Second" }];
    await perform(() => {
      for (const listener of databaseListeners) listener();
    });
    await flush();
    expect(host.querySelector("#notes")?.textContent).toBe("First, Second");
    expect(queryCount).toBeGreaterThanOrEqual(2);
  } finally {
    await perform(() => root.unmount());
    host.remove();
    environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

Deno.test("React keeps supported SQLite parameter identities distinct", async () => {
  const environment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;

  const calls: Array<SqliteQueryInput["params"]> = [];
  const database = {
    query: (_sql: string, params?: SqliteQueryInput["params"]) => {
      calls.push(params);
      return Promise.resolve({ rows: [{ call: calls.length }] });
    },
    sink: () => () => {},
  };
  const client = { sqlite: () => database } as unknown as FabricClient;
  const { useSqliteQuery } = createFabricReact(React, client);

  function App({ params }: { params: SqliteQueryInput["params"] }) {
    const query = useSqliteQuery<{ call: number }>(
      "database",
      "SELECT :value",
      params,
    );
    return React.createElement(
      "p",
      { id: "query-call" },
      query.status === "ready" ? `Call ${query.rows[0].call}` : "Loading",
    );
  }

  const reservedNames = Object.fromEntries([
    ["constructor", 1],
    ["__proto__", 2],
  ]);
  const cases: Array<NonNullable<SqliteQueryInput["params"]>> = [
    [null],
    [NaN],
    [Infinity],
    [-Infinity],
    [-0],
    [0],
    reservedNames,
  ];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    for (let index = 0; index < cases.length; index++) {
      await perform(() =>
        root.render(React.createElement(App, { params: cases[index] }))
      );
      await flush();
      expect(host.querySelector("#query-call")?.textContent).toBe(
        `Call ${index + 1}`,
      );
    }
    expect(calls).toHaveLength(cases.length);
    expect(Number.isNaN((calls[1] as number[])[0])).toBe(true);
    expect((calls[2] as number[])[0]).toBe(Infinity);
    expect((calls[3] as number[])[0]).toBe(-Infinity);
    expect((calls[4] as number[])[0]).toBe(-0);
    expect((calls[5] as number[])[0]).toBe(0);
    const named = calls[6] as Record<string, unknown>;
    expect(Object.hasOwn(named, "constructor")).toBe(true);
    expect(Object.hasOwn(named, "__proto__")).toBe(true);
    expect(named.constructor).toBe(1);
    expect(named.__proto__).toBe(2);
  } finally {
    await perform(() => root.unmount());
    host.remove();
    environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
