import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import {
  $conn,
  $onCellUpdate,
  CellHandle,
  type CellRef,
  type RuntimeClient,
} from "@/mod.ts";

const ref: CellRef = {
  id: "of:cache-change" as CellRef["id"],
  space: "did:key:test",
  scope: "space",
  path: [],
  schema: { type: "string" },
};

describe("CellHandle.onCacheChange()", () => {
  it("observes unchanged confirmations after value callbacks and cancels locally", () => {
    let subscriptions = 0;
    const runtime = {
      [$conn]: () => ({
        subscribe() {
          subscriptions++;
        },
        unsubscribe() {
          subscriptions--;
        },
      }),
    } as unknown as RuntimeClient;
    const cell = new CellHandle(runtime, ref, "initial");
    const seen: string[] = [];
    const cancelCache = cell.onCacheChange(() => {
      seen.push(`cache:${cell.get()}`);
    });
    expect(seen).toEqual([]);
    expect(subscriptions).toBe(0);
    const cancelValue = cell.subscribe((value) => {
      seen.push(`value:${value}`);
    });
    try {
      cell[$onCellUpdate]("initial");
      cell[$onCellUpdate]("next");
      expect(seen).toEqual([
        "value:initial",
        "cache:initial",
        "value:next",
        "cache:next",
      ]);
      cancelCache();
      cell[$onCellUpdate]("next");
      expect(seen).toHaveLength(4);
      expect(subscriptions).toBe(1);
    } finally {
      cancelCache();
      cancelValue();
    }
    expect(subscriptions).toBe(0);
  });

  it("observes sync and pull cache installations without notifying value subscribers", async () => {
    const runtime = {
      [$conn]: () => ({
        request: () => Promise.resolve({ value: "read" }),
        subscribe() {},
        unsubscribe() {},
      }),
    } as unknown as RuntimeClient;
    const cell = new CellHandle(runtime, ref, "initial");
    const values: unknown[] = [];
    const caches: unknown[] = [];
    const cancelValue = cell.subscribe((value) => {
      values.push(value);
    });
    const cancelCache = cell.onCacheChange(() => caches.push(cell.get()));
    try {
      await cell.sync();
      await cell.pull();
      expect(caches).toEqual(["read", "read"]);
      expect(values).toEqual(["initial"]);
    } finally {
      cancelCache();
      cancelValue();
    }
  });

  it("leaves a refused or invalidated read unannounced", async () => {
    const response = Promise.withResolvers<{ value: string }>();
    const connection = { request: () => response.promise };
    const runtime = {
      [$conn]: () => connection,
    } as unknown as RuntimeClient;
    const cell = new CellHandle(runtime, ref, "initial");
    const sibling = new CellHandle(runtime, ref, "initial");
    const seen: unknown[] = [];
    const cancel = cell.onCacheChange(() => seen.push(cell.get()));
    try {
      const reading = cell.sync();
      sibling[$onCellUpdate]("newer");
      response.resolve({ value: "snapshot" });
      await reading;
      expect(seen).toEqual([]);
      using _request = stub(connection, "request", () => {
        return Promise.reject(new Error("refused"));
      });
      await expect(cell.sync()).rejects.toThrow("refused");
      expect(seen).toEqual([]);
    } finally {
      cancel();
    }
  });

  it("observes local publication and isolates a failing listener from later listeners", async () => {
    const runtime = {
      [$conn]: () => ({ request: () => Promise.resolve() }),
    } as unknown as RuntimeClient;
    const cell = new CellHandle(runtime, ref, "initial");
    const failure = new Error("observer failed");
    using log = stub(console, "error");
    const cancelBad = cell.onCacheChange(() => {
      throw failure;
    });
    const seen: unknown[] = [];
    const cancelGood = cell.onCacheChange(() => seen.push(cell.get()));
    try {
      await cell.set("published");
      expect(seen).toEqual(["published"]);
      expect(log.calls.map(({ args }) => args)).toEqual([
        ["[CellHandle] Cache callback error:", failure],
      ]);
      await cell.setForUI("pending delivery");
      expect(seen).toEqual(["published"]);
    } finally {
      cancelBad();
      cancelGood();
    }
  });
});
