import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { BoundedKeyMap, LRUCache } from "@commonfabric/utils/cache";

describe("LRUCache", () => {
  describe("basic operations", () => {
    it("stores and retrieves values", () => {
      const cache = new LRUCache<string, number>();
      cache.put("a", 1);
      cache.put("b", 2);
      expect(cache.get("a")).toBe(1);
      expect(cache.get("b")).toBe(2);
    });

    it("returns `undefined` for missing keys", () => {
      const cache = new LRUCache<string, number>();
      expect(cache.get("missing")).toBe(undefined);
    });

    it("reports `.size` as the number of entries", () => {
      const cache = new LRUCache<string, number>();
      expect(cache.size).toBe(0);
      cache.put("a", 1);
      expect(cache.size).toBe(1);
      cache.put("b", 2);
      expect(cache.size).toBe(2);
    });

    it("returns `true` from `has()` only for a stored key", () => {
      const cache = new LRUCache<string, number>();
      cache.put("a", 1);
      expect(cache.has("a")).toBe(true);
      expect(cache.has("b")).toBe(false);
    });

    it("updates existing keys", () => {
      const cache = new LRUCache<string, number>();
      cache.put("a", 1);
      cache.put("a", 2);
      expect(cache.get("a")).toBe(2);
      expect(cache.size).toBe(1);
    });

    it("deletes keys", () => {
      const cache = new LRUCache<string, number>();
      cache.put("a", 1);
      expect(cache.delete("a")).toBe(true);
      expect(cache.has("a")).toBe(false);
      expect(cache.size).toBe(0);
    });

    it("returns `false` from `delete()` for a missing key", () => {
      const cache = new LRUCache<string, number>();
      expect(cache.delete("missing")).toBe(false);
    });

    it("clears all entries", () => {
      const cache = new LRUCache<string, number>();
      cache.put("a", 1);
      cache.put("b", 2);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.has("a")).toBe(false);
      expect(cache.has("b")).toBe(false);
    });
  });

  describe("eviction", () => {
    it("evicts least recently used on capacity overflow", () => {
      const cache = new LRUCache<string, number>({ capacity: 3 });
      cache.put("a", 1);
      cache.put("b", 2);
      cache.put("c", 3);
      cache.put("d", 4);
      expect(cache.has("a")).toBe(false);
      expect(cache.has("b")).toBe(true);
      expect(cache.has("c")).toBe(true);
      expect(cache.has("d")).toBe(true);
      expect(cache.size).toBe(3);
    });

    it("promotes an entry to most recently used on `get()`", () => {
      const cache = new LRUCache<string, number>({ capacity: 3 });
      cache.put("a", 1);
      cache.put("b", 2);
      cache.put("c", 3);
      cache.get("a");
      cache.put("d", 4);
      expect(cache.has("a")).toBe(true);
      expect(cache.has("b")).toBe(false);
      expect(cache.has("c")).toBe(true);
      expect(cache.has("d")).toBe(true);
    });

    it("promotes an entry to most recently used on a `put()` over it", () => {
      const cache = new LRUCache<string, number>({ capacity: 3 });
      cache.put("a", 1);
      cache.put("b", 2);
      cache.put("c", 3);
      cache.put("a", 10);
      cache.put("d", 4);
      expect(cache.has("a")).toBe(true);
      expect(cache.get("a")).toBe(10);
      expect(cache.has("b")).toBe(false);
    });

    it("evicts on every put at a capacity of `1`", () => {
      const cache = new LRUCache<string, number>({ capacity: 1 });
      cache.put("a", 1);
      cache.put("b", 2);
      expect(cache.size).toBe(1);
      expect(cache.has("a")).toBe(false);
      expect(cache.get("b")).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("stores and retrieves under a numeric key", () => {
      const cache = new LRUCache<number, string>();
      cache.put(1, "one");
      cache.put(2, "two");
      expect(cache.get(1)).toBe("one");
      expect(cache.get(2)).toBe("two");
    });

    it("keeps evicting in order after the head entry is deleted", () => {
      const cache = new LRUCache<string, number>({ capacity: 3 });
      cache.put("a", 1);
      cache.put("b", 2);
      cache.put("c", 3);
      cache.delete("a");
      cache.put("d", 4);
      cache.put("e", 5);
      expect(cache.size).toBe(3);
      expect(cache.has("b")).toBe(false);
    });

    it("keeps evicting in order after the tail entry is deleted", () => {
      const cache = new LRUCache<string, number>({ capacity: 3 });
      cache.put("a", 1);
      cache.put("b", 2);
      cache.put("c", 3);
      cache.delete("c");
      expect(cache.size).toBe(2);
      cache.put("d", 4);
      cache.put("e", 5);
      expect(cache.has("a")).toBe(false);
    });

    it("keeps both neighbors reachable after a middle entry is deleted", () => {
      const cache = new LRUCache<string, number>({ capacity: 3 });
      cache.put("a", 1);
      cache.put("b", 2);
      cache.put("c", 3);
      cache.delete("b");
      expect(cache.size).toBe(2);
      expect(cache.get("a")).toBe(1);
      expect(cache.get("c")).toBe(3);
    });

    it("keeps the eviction order intact after a `get()` on the tail entry", () => {
      const cache = new LRUCache<string, number>({ capacity: 3 });
      cache.put("a", 1);
      cache.put("b", 2);
      cache.put("c", 3);
      cache.get("c");
      cache.put("d", 4);
      expect(cache.has("a")).toBe(false);
      expect(cache.has("b")).toBe(true);
      expect(cache.has("c")).toBe(true);
      expect(cache.has("d")).toBe(true);
    });
  });
  describe("weight budget", () => {
    const weighByValue = { weigh: (_key: string, value: number) => value };

    it("evicts the least recently used entry until the budget is met", () => {
      const cache = new LRUCache<string, number>({
        capacity: 100,
        maxWeight: 10,
        ...weighByValue,
      });
      cache.put("a", 4);
      cache.put("b", 4);
      expect(cache.weight).toBe(8);
      cache.get("a");
      cache.put("c", 4);
      expect(cache.has("b")).toBe(false);
      expect(cache.has("a")).toBe(true);
      expect(cache.has("c")).toBe(true);
      expect(cache.weight).toBe(8);
    });

    it("keeps a single entry that alone exceeds the budget", () => {
      const cache = new LRUCache<string, number>({
        capacity: 100,
        maxWeight: 10,
        ...weighByValue,
      });
      cache.put("huge", 1000);
      expect(cache.get("huge")).toBe(1000);
      expect(cache.size).toBe(1);
      cache.put("small", 1);
      expect(cache.has("huge")).toBe(false);
      expect(cache.get("small")).toBe(1);
    });

    it("tracks weight through replacement, delete, and clear", () => {
      const cache = new LRUCache<string, number>({
        capacity: 100,
        maxWeight: 100,
        ...weighByValue,
      });
      cache.put("a", 5);
      cache.put("a", 7);
      expect(cache.size).toBe(1);
      expect(cache.weight).toBe(7);
      cache.put("b", 3);
      cache.delete("a");
      expect(cache.weight).toBe(3);
      cache.clear();
      expect(cache.weight).toBe(0);
    });

    it("still honors the entry count when no budget is set", () => {
      const cache = new LRUCache<string, number>({ capacity: 2 });
      cache.put("a", 1);
      cache.put("b", 2);
      cache.put("c", 3);
      expect(cache.has("a")).toBe(false);
      expect(cache.weight).toBe(0);
    });
  });
});

describe("BoundedKeyMap", () => {
  it("reads back what it stored", () => {
    const map = new BoundedKeyMap<string, number>(10);
    map.set("a", 1);
    expect(map.get("a")).toBe(1);
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(false);
    expect(map.get("b")).toBeUndefined();
    expect(map.size).toBe(1);
  });

  it("drops the oldest key once it is full", () => {
    const map = new BoundedKeyMap<string, number>(3);
    for (const key of ["a", "b", "c", "d"]) map.set(key, 1);
    expect(map.size).toBe(3);
    expect(map.has("a")).toBe(false);
    expect(map.has("d")).toBe(true);
  });

  it("stays bounded however many distinct keys arrive", () => {
    const map = new BoundedKeyMap<number, number>(64);
    for (let key = 0; key < 100_000; key++) map.set(key, key);
    expect(map.size).toBe(64);
    expect(map.get(99_999)).toBe(99_999);
    expect(map.has(0)).toBe(false);
  });

  it("keeps a key that is written again", () => {
    const map = new BoundedKeyMap<string, number>(4);
    map.set("keep", 0);
    for (let round = 0; round < 100; round++) {
      map.set(`churn-${round}`, round);
      map.set("keep", round);
    }
    expect(map.get("keep")).toBe(99);
  });

  it("does not keep a key that is only ever read", () => {
    // Reads are free: eviction order tracks writes alone, so a hot reader with
    // no writer still ages out. Callers that need read-recency want an LRU.
    const map = new BoundedKeyMap<string, number>(4);
    map.set("read-only", 7);
    for (let round = 0; round < 100; round++) {
      map.get("read-only");
      map.set(`churn-${round}`, round);
    }
    expect(map.has("read-only")).toBe(false);
  });

  it("forgets a deleted key and everything on clear", () => {
    const map = new BoundedKeyMap<string, number>(10);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.delete("a")).toBe(true);
    expect(map.delete("a")).toBe(false);
    expect(map.size).toBe(1);
    map.clear();
    expect(map.size).toBe(0);
    expect(map.has("b")).toBe(false);
  });

  it("reports capacity evictions — and only those — through onEvict", () => {
    // Eviction and the caller's own removals must stay distinguishable: a
    // consumer whose absence-check feeds a decision records tombstones here,
    // and a delete/clear/refresh must NOT look like an eviction.
    const evicted: Array<[string, number]> = [];
    const map = new BoundedKeyMap<string, number>(3, {
      onEvict: (key, value) => evicted.push([key, value]),
    });
    map.set("a", 1);
    map.set("b", 2);
    map.set("a", 10); // refresh: not an eviction
    map.delete("b"); // caller removal: not an eviction
    map.set("c", 3);
    map.set("d", 4);
    expect(evicted).toEqual([]);
    map.set("e", 5); // capacity: "a" (oldest) evicts, with its CURRENT value
    expect(evicted).toEqual([["a", 10]]);
    expect(map.has("a")).toBe(false);
    map.clear(); // caller removal: not an eviction
    expect(evicted).toEqual([["a", 10]]);
  });

  it("reads like a `ReadonlyMap`, oldest entry first", () => {
    const map = new BoundedKeyMap<string, number>(10);
    map.set("a", 1);
    map.set("b", 2);
    expect([...map]).toEqual([["a", 1], ["b", 2]]);
    expect([...map.entries()]).toEqual([["a", 1], ["b", 2]]);
    expect([...map.keys()]).toEqual(["a", "b"]);
    expect([...map.values()]).toEqual([1, 2]);
    const seen: Array<[string, number]> = [];
    map.forEach((value, key) => seen.push([key, value]));
    expect(seen).toEqual([["a", 1], ["b", 2]]);
    // Re-setting a key moves it to the young end, so traversal order tracks
    // writes rather than first sight.
    map.set("a", 3);
    expect([...map.keys()]).toEqual(["b", "a"]);
    const readonlyView: ReadonlyMap<string, number> = map;
    expect(readonlyView.get("a")).toBe(3);
  });

  it("holds one entry when given a nonsensical limit", () => {
    const map = new BoundedKeyMap<string, number>(0);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.size).toBe(1);
    expect(map.get("b")).toBe(2);
  });
});
