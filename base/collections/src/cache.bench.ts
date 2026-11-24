import { LRUCache } from "./cache.ts";

const CACHE_SIZE = 1000;
const OPERATIONS = 10000;

function createCache<K, V>(): LRUCache<K, V> {
  return new LRUCache<K, V>({ capacity: CACHE_SIZE });
}

function fillCache(cache: LRUCache<number, number>, count: number): void {
  for (let i = 0; i < count; i++) {
    cache.put(i, i);
  }
}

Deno.bench({
  name: "LRUCache (linked list) - sequential put",
  fn() {
    const cache = createCache<number, number>();
    for (let i = 0; i < OPERATIONS; i++) {
      cache.put(i, i);
    }
  },
});

Deno.bench({
  name: "LRUCache (linked list) - sequential get (hit)",
  fn(b) {
    const cache = createCache<number, number>();
    fillCache(cache, CACHE_SIZE);
    b.start();
    for (let i = 0; i < OPERATIONS; i++) {
      cache.get(i % CACHE_SIZE);
    }
    b.end();
  },
});

Deno.bench({
  name: "LRUCache (linked list) - sequential get (miss)",
  fn(b) {
    const cache = createCache<number, number>();
    fillCache(cache, CACHE_SIZE);
    b.start();
    for (let i = 0; i < OPERATIONS; i++) {
      cache.get(i + CACHE_SIZE);
    }
    b.end();
  },
});

Deno.bench({
  name: "LRUCache (linked list) - mixed put/get with eviction",
  fn(b) {
    const cache = createCache<number, number>();
    fillCache(cache, CACHE_SIZE);
    b.start();
    for (let i = 0; i < OPERATIONS; i++) {
      if (i % 2 === 0) {
        cache.put(i + CACHE_SIZE, i);
      } else {
        cache.get(i % CACHE_SIZE);
      }
    }
    b.end();
  },
});

Deno.bench({
  name: "LRUCache (linked list) - update existing keys",
  fn(b) {
    const cache = createCache<number, number>();
    fillCache(cache, CACHE_SIZE);
    b.start();
    for (let i = 0; i < OPERATIONS; i++) {
      cache.put(i % CACHE_SIZE, i);
    }
    b.end();
  },
});

Deno.bench({
  name: "LRUCache (linked list) - delete",
  fn(b) {
    const cache = createCache<number, number>();
    fillCache(cache, CACHE_SIZE);
    b.start();
    for (let i = 0; i < CACHE_SIZE; i++) {
      cache.delete(i);
    }
    b.end();
  },
});

Deno.bench({
  name: "LRUCache (linked list) - random access pattern",
  fn(b) {
    const cache = createCache<number, number>();
    fillCache(cache, CACHE_SIZE);
    const keys = Array.from(
      { length: OPERATIONS },
      () => Math.floor(Math.random() * CACHE_SIZE * 2),
    );
    b.start();
    for (const key of keys) {
      if (cache.has(key)) {
        cache.get(key);
      } else {
        cache.put(key, key);
      }
    }
    b.end();
  },
});
