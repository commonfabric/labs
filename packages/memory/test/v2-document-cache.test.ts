/**
 * The engine's decoded-document cache: that a working set stays resident
 * across the walks that read it, what its bounds evict first, and what it
 * declines to remember.
 *
 * The bounds are exercised with small budgets set through `open()`; the
 * default budget holds far more than any test here writes. The in-transaction
 * branch needs a read taken inside a transaction that is not a commit, which
 * nothing in the engine does today and which the guard exists to keep safe if
 * something starts to.
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import { ensureDir } from "@std/fs";
import { describe, it } from "@std/testing/bdd";
import { join, toFileUrl } from "@std/path";

import {
  applyCommit,
  close,
  DEFAULT_DOCUMENT_CACHE_MAX_ENTRIES,
  DocumentCacheCoordinator,
  documentCacheDiagnostics,
  type Engine,
  evictDocumentCacheEntries,
  open,
  type OpenOptions,
  read,
} from "../v2/engine.ts";
import {
  getDocumentCachesDiagnostics,
  getPushPriorityStats,
  Server,
} from "../v2/server.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";
import { encodeMemoryBoundary } from "../v2.ts";

/** What the cache weighs an entry by: the document encoded as stored, in
 * UTF-8 bytes. */
const encodedWeight = (document: unknown): number =>
  new TextEncoder().encode(encodeMemoryBoundary(document as never)).byteLength;

const withEngine = async (
  fn: (engine: Engine) => void | Promise<void>,
  options: Omit<OpenOptions, "url"> = {},
): Promise<void> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path), ...options });
  try {
    await fn(engine);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
};

const setOp = (id: string, value: unknown) =>
  ({ op: "set", id, value: { value } }) as never;

const commit = (localSeq: number, extra: Record<string, unknown>) =>
  ({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [],
    ...extra,
  }) as never;

const entityId = (index: number) =>
  `of:fid1:cache-${String(index).padStart(4, "0")}`;

const storedValue = (engine: Engine, index: number): unknown =>
  read(engine, { id: entityId(index) } as never);

const seed = (
  engine: Engine,
  count: number,
  valueOf: (i: number) => unknown = (i) => i,
) => {
  for (let index = 0; index < count; index++) {
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(index + 1, {
        operations: [setOp(entityId(index), valueOf(index))],
      }),
    } as never);
  }
};

/** A commit whose one operation replaces `/value/count` on the first seeded
 * entity. */
const commitCountPatch = (engine: Engine, localSeq: number, count: number) =>
  applyCommit(engine, {
    sessionId: "s:a",
    commit: commit(localSeq, {
      operations: [{
        op: "patch",
        id: entityId(0),
        patches: [{ op: "replace", path: "/value/count", value: count }],
      }],
    }),
  } as never);

/** A temporary store directory for a Server, removed afterwards. */
const withStoreDir = async (
  fn: (store: URL) => Promise<void>,
): Promise<void> => {
  const dir = await Deno.makeTempDir();
  try {
    await fn(toFileUrl(join(dir, "/")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

/** Populate each space's store directly, before a server opens it; every
 * engine is closed whether or not its seeding completes. */
const seedSpaces = async (
  store: URL,
  spaces: readonly `did:${string}:${string}`[],
  count: number,
  valueOf: (i: number) => unknown,
): Promise<void> => {
  for (const space of spaces) {
    const url = resolveSpaceStoreUrl(store, space);
    await ensureDir(new URL("./", url));
    const engine = await open({ url });
    try {
      seed(engine, count, valueOf);
    } finally {
      close(engine);
    }
  }
};

const serverOptions = (store: URL, totalBudget?: number) => ({
  store,
  subscriptionRefreshDelayMs: 0,
  ...(totalBudget === undefined
    ? {}
    : { documentCacheTotalBudgetBytes: totalBudget }),
  authorizeSessionOpen: () => "did:key:z6Mk-document-cache-principal",
  sessionOpenAuth: { audience: "did:key:z6Mk-document-cache-audience" },
});

describe("v2 document cache", () => {
  it("keeps a working set larger than the old bound resident across passes", async () => {
    // Four hundred documents — past the 256 the cache used to clear itself
    // at, and the shape of a board load, which reads its whole set again on
    // every load. The second pass must be served entirely from the cache.
    const count = 400;
    await withEngine((engine) => {
      seed(engine, count);
      // Seeding reads its own rows through the staged cache, so start the
      // count from whatever that left behind.
      const before = documentCacheDiagnostics(engine);
      for (let index = 0; index < count; index++) {
        assertEquals(storedValue(engine, index), { value: index });
      }
      const afterFirst = documentCacheDiagnostics(engine);
      for (let index = 0; index < count; index++) {
        assertEquals(storedValue(engine, index), { value: index });
      }
      const afterSecond = documentCacheDiagnostics(engine);
      assertEquals(
        afterSecond.misses - afterFirst.misses,
        0,
        "the second pass decoded something again",
      );
      assertEquals(afterSecond.hits - afterFirst.hits, count);
      assertEquals(afterSecond.evictions - before.evictions, 0);
      assertEquals(afterSecond.entries >= count, true);
      assertEquals(afterSecond.maxEntries, DEFAULT_DOCUMENT_CACHE_MAX_ENTRIES);
    });
  });

  it("evicts the least recently read entry first at the entry cap", async () => {
    await withEngine((engine) => {
      seed(engine, 10);
      // Reads outside any commit go straight to the cache; an entry cap of
      // eight is reached by reading eight documents.
      for (let index = 0; index < 8; index++) storedValue(engine, index);
      const filled = documentCacheDiagnostics(engine);
      assertEquals(filled.entries, 8);
      // Touch the oldest, so it is no longer the oldest.
      storedValue(engine, 0);
      // The ninth document displaces the least recently read one: document 1,
      // not document 0.
      storedValue(engine, 8);
      const evicted = documentCacheDiagnostics(engine);
      assertEquals(evicted.entries, 8);
      assertEquals(evicted.evictions - filled.evictions, 1);
      const beforeProbe = documentCacheDiagnostics(engine);
      storedValue(engine, 0);
      assertEquals(documentCacheDiagnostics(engine).hits - beforeProbe.hits, 1);
      storedValue(engine, 1);
      assertEquals(
        documentCacheDiagnostics(engine).misses - beforeProbe.misses,
        1,
        "document 1 should have been the eviction victim",
      );
    }, { documentCacheMaxEntries: 8 });
  });

  it("holds the byte budget and does not retain a document heavier than it", async () => {
    // Forty small documents (a few dozen encoded bytes each) cannot all fit
    // in four hundred; the heavy one alone is far past the budget.
    const budget = 400;
    const small = 40;
    await withEngine((engine) => {
      seed(
        engine,
        small + 1,
        (index) => index === small ? "x".repeat(20_000) : index,
      );
      for (let index = 0; index < small; index++) storedValue(engine, index);
      const filled = documentCacheDiagnostics(engine);
      assertEquals(filled.bytes <= budget, true, `bytes ${filled.bytes}`);
      assertEquals(filled.entries < small, true, "the budget evicted nothing");
      assertEquals(filled.evictions > 0, true);
      // The heavy document is served but not remembered: reading it twice
      // misses twice, and the cache's occupancy does not move.
      const before = documentCacheDiagnostics(engine);
      assertEquals(storedValue(engine, small), { value: "x".repeat(20_000) });
      assertEquals(storedValue(engine, small), { value: "x".repeat(20_000) });
      const after = documentCacheDiagnostics(engine);
      assertEquals(after.misses - before.misses, 2);
      assertEquals(after.entries, before.entries);
      assertEquals(after.bytes, before.bytes);
      assertEquals(after.budgetBytes, budget);
    }, { documentCacheBudgetBytes: budget });
  });

  it("does not remember a document read inside an open transaction", async () => {
    // A cap of one: after seeding two documents at most one is cached, so
    // the other is a guaranteed miss when read inside the transaction below.
    await withEngine((engine) => {
      seed(engine, 2);
      // Document 0 is the one the cap of one has let go; read it cold inside
      // the transaction. A transaction that is not a commit stages nothing,
      // and what it decodes must not outlive it: the rows behind the read are
      // not durable until the transaction returns.
      const uncached = 0;
      const before = documentCacheDiagnostics(engine);
      engine.database.transaction(() => {
        assertEquals(storedValue(engine, uncached), { value: uncached });
      })();
      const inside = documentCacheDiagnostics(engine);
      assertEquals(inside.misses - before.misses, 1, "expected a cold read");
      // Not remembered: the same read outside the transaction misses again,
      // and only then is it cached — the read after that is a hit.
      assertEquals(storedValue(engine, uncached), { value: uncached });
      const after = documentCacheDiagnostics(engine);
      assertEquals(
        after.misses - inside.misses,
        1,
        "the transaction's read was remembered",
      );
      assertEquals(storedValue(engine, uncached), { value: uncached });
      assertEquals(documentCacheDiagnostics(engine).hits - after.hits, 1);
    }, { documentCacheMaxEntries: 1 });
  });

  it("reports each open space's cache through the health provider, withdrawn on close", async () => {
    const space = "did:key:z6Mk-document-cache-diagnostics";
    // Whatever an earlier test left registered is what closing hands back to.
    const registeredBefore = getDocumentCachesDiagnostics();
    const pushBefore = getPushPriorityStats();
    const server = new Server(
      serverOptions(new URL("memory://document-cache-diagnostics")),
    );
    try {
      const empty = getDocumentCachesDiagnostics();
      assertEquals(empty, server.documentCachesDiagnostics());
      // The push-priority provider follows the same registration.
      assertEquals(getPushPriorityStats(), server.pushPriorityStats());
      assertEquals(empty?.spaces, {});
      assertEquals(empty?.bytes, 0);
      assertEquals(typeof empty?.totalBudgetBytes, "number");
      assertEquals(empty?.totalBudgetEvictions, 0);
      // Any read opens the space's engine; a never-opened space is absent.
      await server.evaluateGraphQuery(space, {
        roots: [{ id: "of:doc:1", selector: { path: [], schema: true } }],
      });
      const report = getDocumentCachesDiagnostics();
      assertEquals(report, server.documentCachesDiagnostics());
      assertEquals(Object.keys(report!.spaces), [space]);
      const cache = report!.spaces[space];
      assertEquals(typeof cache.hits, "number");
      assertEquals(typeof cache.misses, "number");
      assertEquals(cache.entries, cache.entries | 0);
      assertEquals(cache.bytes <= cache.budgetBytes, true);
    } finally {
      await server.close();
    }
    // Closing withdraws both providers (back to whatever was registered
    // before), so a closed server is never the one reported.
    assertEquals(getDocumentCachesDiagnostics(), registeredBefore);
    assertEquals(getPushPriorityStats(), pushBefore);
  });
  it("rejects cache bounds that are not positive integers at open", async () => {
    const url = toFileUrl(await Deno.makeTempFile({ suffix: ".sqlite" }));
    try {
      for (const bad of [0, -1, 1.5]) {
        await assertRejects(
          () => open({ url, documentCacheBudgetBytes: bad }),
          TypeError,
          "documentCacheBudgetBytes",
        );
        await assertRejects(
          () => open({ url, documentCacheMaxEntries: bad }),
          TypeError,
          "documentCacheMaxEntries",
        );
      }
    } finally {
      await Deno.remove(new URL(url));
    }
  });
  it("weighs a reconstructed document by what it retains, not by any row it replayed", async () => {
    // Nine additive patches on a small base: no single row bounds the
    // result, and the result is what the cache keeps.
    const id = entityId(0);
    const chunk = "x".repeat(449);
    await withEngine((engine) => {
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(1, { operations: [setOp(id, { seed: true })] }),
      } as never);
      for (let n = 1; n <= 9; n++) {
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(n + 1, {
            operations: [{
              op: "patch",
              id,
              patches: [{ op: "add", path: `/value/p${n}`, value: chunk }],
            }],
          }),
        } as never);
      }
      // Read outside any commit, cold: drop whatever the commits' own reads
      // left cached so this read decodes and weighs the document itself.
      evictDocumentCacheEntries(engine, Number.MAX_SAFE_INTEGER);
      const before = documentCacheDiagnostics(engine);
      const body = storedValue(engine, 0) as { value: Record<string, unknown> };
      assertEquals(body.value.p9, chunk);
      const after = documentCacheDiagnostics(engine);
      assertEquals(after.misses - before.misses, 1);
      // Exactly the result as it would be stored: no less (the nine chunks
      // are all in it) and no more (a replay-cost sum would charge the base
      // and every patch again, and evict useful entries early).
      assertEquals(after.bytes >= 9 * chunk.length, true, `${after.bytes}`);
      assertEquals(after.bytes, encodedWeight(body));
    }, { documentCacheMaxEntries: 1 });
  });

  it("weighs each replayed revision exactly as it would be stored", async () => {
    // Each revision is weighed from the one it replays, by what its patch
    // changed. The ops between them reach every shape the encoding treats
    // differently: a quoted `/`-keyed record, a record turning into one, an
    // array with a hole, a tagged `undefined`, and text outside ASCII.
    const id = entityId(0);
    const patches = [
      { op: "replace", path: "/value/record/a", value: "y" },
      { op: "add", path: "/value/record/added", value: { deep: [1] } },
      { op: "remove", path: "/value/gone" },
      { op: "replace", path: "/value/link/~1/link@1/id", value: "of:y" },
      { op: "add", path: "/value/link/~1extra", value: 1 },
      { op: "append", path: "/value/list", values: [4, 5] },
      { op: "splice", path: "/value/list", index: 1, remove: 1, add: ["a"] },
      { op: "add-unique", path: "/value/list", values: [1, 9] },
      { op: "remove-by-value", path: "/value/list", value: 9 },
      { op: "increment", path: "/value/n", by: 5 },
      { op: "move", from: "/value/record/added", path: "/value/moved" },
      { op: "replace", path: "/value/holes/0", value: 7 },
      { op: "replace", path: "/value/text", value: "字字" },
      { op: "add", path: "/value/record/empty", value: undefined },
      { op: "replace", path: "/value/record", value: { "/weird": 1 } },
      { op: "remove", path: "/value/moved" },
      { op: "replace", path: "/value", value: { fresh: true } },
    ];
    await withEngine((engine) => {
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(1, {
          operations: [setOp(id, {
            list: [1, 2, 3],
            record: { a: "x", b: { c: 1 } },
            link: { "/": { "link@1": { id: "of:x", path: [] } } },
            // deno-lint-ignore no-sparse-arrays
            holes: [1, , 3],
            text: "字",
            n: 0,
            gone: "bye",
          })],
        }),
      } as never);
      const resumesBefore = documentCacheDiagnostics(engine).resumes;
      patches.forEach((patch, index) => {
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(index + 2, {
            operations: [{ op: "patch", id, patches: [patch] }],
          }),
        } as never);
        const stored = storedValue(engine, 0);
        expect(documentCacheDiagnostics(engine).bytes, patch.op).toBe(
          encodedWeight(stored),
        );
      });
      // Every revision after the first was weighed from the one before it,
      // not decoded and weighed afresh.
      expect(documentCacheDiagnostics(engine).resumes - resumesBefore).toBe(
        patches.length - 1,
      );
    }, { documentCacheMaxEntries: 1, snapshotInterval: 100 });
  });

  it("resumes the commit after a snapshot from the revision the snapshot holds", async () => {
    // The snapshot is written from a revision the cache already holds, so the
    // next rebuild starts there rather than decoding the snapshot.
    await withEngine((engine) => {
      seed(engine, 1, () => ({ count: 0, untouched: { list: [1, 2, 3] } }));
      commitCountPatch(engine, 2, 1);
      commitCountPatch(engine, 3, 2);
      const before = documentCacheDiagnostics(engine);
      commitCountPatch(engine, 4, 3);
      const after = documentCacheDiagnostics(engine);
      const stored = storedValue(engine, 0);

      expect(stored).toEqual({
        value: { count: 3, untouched: { list: [1, 2, 3] } },
      });
      expect(after.resumes - before.resumes).toBe(1);
      expect(after.bytes).toBe(encodedWeight(stored));
    }, { documentCacheMaxEntries: 1, snapshotInterval: 2 });
  });

  it("serializes as many bytes committing one entry of a long record as of a short one", async () => {
    // Weighing a revision by encoding it whole would serialize every entry;
    // weighing it by what its patch changed serializes the same bytes
    // whatever the record around the change holds.
    const serializedBytes = async (length: number): Promise<number> => {
      let bytes = 0;
      await withEngine((engine) => {
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(1, {
            operations: [setOp(
              entityId(0),
              Object.fromEntries(
                Array.from({ length }, (_, index) => [
                  `key-${index}`,
                  { name: `entry-${index}` },
                ]),
              ),
            )],
          }),
        } as never);
        const stringify = JSON.stringify;
        JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
          const text = stringify(...args);
          bytes += text?.length ?? 0;
          return text;
        }) as typeof JSON.stringify;
        try {
          applyCommit(engine, {
            sessionId: "s:a",
            commit: commit(2, {
              operations: [{
                op: "patch",
                id: entityId(0),
                patches: [{
                  op: "replace",
                  path: "/value/key-0/name",
                  value: "edited",
                }],
              }],
            }),
          } as never);
        } finally {
          JSON.stringify = stringify;
        }
      });
      return bytes;
    };

    const short = await serializedBytes(20);
    const long = await serializedBytes(2_000);

    // Both are needed: the equality alone passes a total that is flat but
    // large, and the bound alone passes one that grows slowly with the record.
    // The short record alone encodes to more than 500 bytes.
    expect(long).toBe(short);
    expect(long).toBeLessThan(500);
  });

  it("weighs documents in encoded bytes, not string code units", async () => {
    const cjk = "字".repeat(900); // three UTF-8 bytes per character
    await withEngine((engine) => {
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(1, { operations: [setOp(entityId(0), cjk)] }),
      } as never);
      evictDocumentCacheEntries(engine, Number.MAX_SAFE_INTEGER);
      const before = documentCacheDiagnostics(engine);
      assertEquals(storedValue(engine, 0), { value: cjk });
      const after = documentCacheDiagnostics(engine);
      assertEquals(after.misses - before.misses, 1);
      assertEquals(
        after.bytes >= 3 * cjk.length,
        true,
        `weight ${after.bytes} counted code units, not bytes`,
      );
      // Exactly the stored row, which is the document encoded.
      assertEquals(after.bytes, encodedWeight({ value: cjk }));
    }, { documentCacheMaxEntries: 1 });
  });

  it("drains the least recently read entries first when asked to free bytes", async () => {
    await withEngine((engine) => {
      seed(engine, 5);
      for (let index = 0; index < 5; index++) storedValue(engine, index);
      const filled = documentCacheDiagnostics(engine);
      // Free two entries' worth: the two least recently read go, the rest
      // stay, and what was freed is reported.
      const perEntry = filled.bytes / filled.entries;
      const freed = evictDocumentCacheEntries(engine, 2 * perEntry - 1);
      const drained = documentCacheDiagnostics(engine);
      assertEquals(freed >= 2 * perEntry - 1, true);
      assertEquals(drained.evictions - filled.evictions, 2);
      assertEquals(drained.entries, filled.entries - 2);
      assertEquals(drained.bytes, filled.bytes - freed);
      const probe = documentCacheDiagnostics(engine);
      storedValue(engine, 4);
      assertEquals(documentCacheDiagnostics(engine).hits - probe.hits, 1);
      storedValue(engine, 0);
      assertEquals(documentCacheDiagnostics(engine).misses - probe.misses, 1);
    }, { documentCacheMaxEntries: 64 });
  });

  it("holds the total budget across spaces, draining the least recently used space first", async () => {
    const spaces = [
      "did:key:z6Mk-document-cache-process-a",
      "did:key:z6Mk-document-cache-process-b",
    ] as const;
    await withStoreDir(async (store) => {
      // Thirty documents of one weight each (the index is padded so every
      // row encodes to the same length): sixty-odd bytes apiece, so one
      // space's set fits the budget below and two sets do not.
      await seedSpaces(
        store,
        spaces,
        30,
        (index) =>
          `document ${String(index).padStart(2, "0")} ${"·".repeat(20)}`,
      );
      // Larger than one space's set, smaller than two: reading the second
      // space must trim the first — and only as far as needed.
      const budget = 2_500;
      const server = new Server(serverOptions(store, budget));
      try {
        const readAll = (space: string) =>
          server.evaluateGraphQuery(space, {
            roots: Array.from({ length: 30 }, (_, index) => ({
              id: entityId(index),
              selector: { path: [], schema: true },
            })),
          });
        await readAll(spaces[0]);
        const afterA = server.documentCachesDiagnostics();
        assertEquals(afterA.totalBudgetBytes, budget);
        // One space fits whole.
        const first = afterA.spaces[spaces[0]];
        assertEquals(first.entries, 30);
        assertEquals(first.evictions, 0);
        assertEquals(afterA.bytes, first.bytes);
        assertEquals(afterA.bytes > budget / 2, true, `bytes ${afterA.bytes}`);
        const weight = first.bytes / 30;
        assertEquals(Number.isInteger(weight), true, "unequal row weights");

        await readAll(spaces[1]);
        const afterB = server.documentCachesDiagnostics();
        assertEquals(afterB.bytes <= budget, true, `bytes ${afterB.bytes}`);
        // The newest space is untouched; the least recently used one gave up
        // exactly what the budget needed — the fewest entries that bring the
        // total under it — and kept the rest.
        const newest = afterB.spaces[spaces[1]];
        assertEquals(newest.entries, 30);
        assertEquals(newest.evictions, 0);
        const older = afterB.spaces[spaces[0]];
        const required = Math.ceil(
          (first.bytes + newest.bytes - budget) / weight,
        );
        assertEquals(required > 0 && required < 30, true, `${required}`);
        assertEquals(
          older.evictions,
          required,
          "trimmed further than the budget required",
        );
        assertEquals(older.entries, 30 - required);
        assertEquals(
          afterB.bytes,
          first.bytes + newest.bytes - required * weight,
        );
        // The total is what the spaces hold, and every eviction was the
        // total budget's doing, not a space's own bounds.
        assertEquals(afterB.bytes, older.bytes + newest.bytes);
        assertEquals(afterB.totalBudgetEvictions, required);
      } finally {
        await server.close();
      }
    });
  });

  it("holds the total budget on a plain document read, not only after an evaluation", async () => {
    // The budget is held as each document is cached, so a path with no
    // enforcement of its own — the public readDocument here — returns
    // within it: two spaces holding one document each of more than half the
    // budget cannot both stay resident, and the second read drains the
    // first space rather than returning over budget.
    const spaces = [
      "did:key:z6Mk-document-cache-read-a",
      "did:key:z6Mk-document-cache-read-b",
    ] as const;
    const body = "x".repeat(700);
    await withStoreDir(async (store) => {
      await seedSpaces(store, spaces, 1, () => body);
      const budget = 1_000;
      const server = new Server(serverOptions(store, budget));
      try {
        assertEquals(await server.readDocument(spaces[0], entityId(0)), {
          value: body,
        });
        const afterA = server.documentCachesDiagnostics();
        assertEquals(afterA.spaces[spaces[0]].entries, 1);
        assertEquals(afterA.bytes > budget / 2, true, `bytes ${afterA.bytes}`);
        assertEquals(afterA.bytes <= budget, true, `bytes ${afterA.bytes}`);

        assertEquals(await server.readDocument(spaces[1], entityId(0)), {
          value: body,
        });
        const afterB = server.documentCachesDiagnostics();
        assertEquals(afterB.bytes <= budget, true, `bytes ${afterB.bytes}`);
        assertEquals(afterB.spaces[spaces[1]].entries, 1);
        assertEquals(afterB.spaces[spaces[0]].entries, 0);
        assertEquals(afterB.spaces[spaces[0]].evictions, 1);
      } finally {
        await server.close();
      }
    });
  });

  it("rejects a cache bound that is not a positive integer at construction", () => {
    // Where it is configured, not at the first request that opens a space —
    // and a rejected server registers nothing for the health route.
    const registeredBefore = getDocumentCachesDiagnostics();
    const pushBefore = getPushPriorityStats();
    const bounds = [
      "documentCacheBudgetBytes",
      "documentCacheMaxEntries",
      "documentCacheTotalBudgetBytes",
    ] as const;
    for (const bound of bounds) {
      for (const bad of [0, -5, 2.5]) {
        assertThrows(
          () =>
            new Server({
              ...serverOptions(new URL("memory://document-cache-bad-bound")),
              [bound]: bad,
            }),
          TypeError,
          bound,
        );
      }
    }
    assertEquals(getDocumentCachesDiagnostics(), registeredBefore);
    assertEquals(getPushPriorityStats(), pushBefore);
  });
  it("drains by recency of access, not by order of opening: a retained engine's reads count", async () => {
    // A, then B, then A again THROUGH THE ENGINE HANDED OUT EARLIER (the
    // runner's SpaceServer holds one, and its reads never pass
    // `Server.#openEngine()`),
    // then C under pressure: the least recently used space is B, and B
    // alone must give. Recency by order of opening would drain A, the hot
    // space, while B survived.
    const spaces = [
      "did:key:z6Mk-document-cache-recency-a",
      "did:key:z6Mk-document-cache-recency-b",
      "did:key:z6Mk-document-cache-recency-c",
    ] as const;
    const valueOf = (index: number) =>
      `document ${String(index).padStart(2, "0")} ${"·".repeat(20)}`;
    await withStoreDir(async (store) => {
      await seedSpaces(store, spaces, 30, valueOf);
      // Two sets fit, three do not (checked below once the weight is known).
      const budget = 5_000;
      const server = new Server(serverOptions(store, budget));
      try {
        const readAll = (space: string) =>
          server.evaluateGraphQuery(space, {
            roots: Array.from({ length: 30 }, (_, index) => ({
              id: entityId(index),
              selector: { path: [], schema: true },
            })),
          });
        await readAll(spaces[0]);
        const retained = await server.engineForSpace(spaces[0]);
        await readAll(spaces[1]);
        const two = server.documentCachesDiagnostics();
        const weight = two.spaces[spaces[0]].bytes / 30;
        assertEquals(Number.isInteger(weight), true, "unequal row weights");
        assertEquals(
          60 * weight <= budget && 90 * weight > budget,
          true,
          `budget ${budget} against sets of ${30 * weight}`,
        );
        assertEquals(two.totalBudgetEvictions, 0);
        // A again, one hit through the retained engine: A is now the most
        // recently used space.
        assertEquals(read(retained, { id: entityId(0) } as never), {
          value: valueOf(0),
        });
        assertEquals(
          server.documentCachesDiagnostics().spaces[spaces[0]].hits -
            two.spaces[spaces[0]].hits,
          1,
        );
        await readAll(spaces[2]);
        const three = server.documentCachesDiagnostics();
        const required = Math.ceil((90 * weight - budget) / weight);
        assertEquals(
          three.spaces[spaces[1]].evictions,
          required,
          "B, the least recently used space, should have given",
        );
        assertEquals(three.spaces[spaces[1]].entries, 30 - required);
        assertEquals(
          three.spaces[spaces[0]].entries,
          30,
          "A, re-read through its retained engine, was drained",
        );
        assertEquals(three.spaces[spaces[0]].evictions, 0);
        assertEquals(three.spaces[spaces[2]].entries, 30);
        assertEquals(three.totalBudgetEvictions, required);
        assertEquals(three.bytes <= budget, true, `bytes ${three.bytes}`);
      } finally {
        await server.close();
      }
    });
  });

  it("bounds each live server's own total: a second server keeps its own", async () => {
    // Per instance, not per process: the toolshed hosts one memory server,
    // and a test's extra server neither drains it nor is drained by it. The
    // health route reports the newest live one, then the one before it.
    const body = "x".repeat(700);
    const budget = 1_000;
    const registeredBefore = getDocumentCachesDiagnostics();
    const first = new Server(
      serverOptions(new URL("memory://document-cache-two-servers-a"), budget),
    );
    try {
      const second = new Server(
        serverOptions(new URL("memory://document-cache-two-servers-b"), budget),
      );
      try {
        const space = "did:key:z6Mk-document-cache-two-servers";
        for (const server of [first, second]) {
          await server.writeDocument(space, entityId(0), body);
          assertEquals(await server.readDocument(space, entityId(0)), {
            value: body,
          });
        }
        for (const server of [first, second]) {
          const report = server.documentCachesDiagnostics();
          assertEquals(report.totalBudgetBytes, budget);
          assertEquals(report.spaces[space].entries, 1);
          assertEquals(
            report.bytes > budget / 2 && report.bytes <= budget,
            true,
          );
          assertEquals(report.totalBudgetEvictions, 0);
        }
        assertEquals(
          getDocumentCachesDiagnostics(),
          second.documentCachesDiagnostics(),
        );
      } finally {
        await second.close();
      }
      assertEquals(
        getDocumentCachesDiagnostics(),
        first.documentCachesDiagnostics(),
      );
    } finally {
      await first.close();
    }
    assertEquals(getDocumentCachesDiagnostics(), registeredBefore);
  });

  it("keeps one coordinator's total exact across its engines and forgets a closed one", async () => {
    assertThrows(
      () => new DocumentCacheCoordinator(0),
      TypeError,
      "documentCacheTotalBudgetBytes",
    );
    const coordinator = new DocumentCacheCoordinator(10_000);
    const paths = [
      await Deno.makeTempFile({ suffix: ".sqlite" }),
      await Deno.makeTempFile({ suffix: ".sqlite" }),
    ];
    const engines: Engine[] = [];
    const closed = new Set<Engine>();
    const shut = (engine: Engine) => {
      if (!closed.has(engine)) {
        closed.add(engine);
        close(engine);
      }
    };
    try {
      for (const path of paths) {
        engines.push(
          await open({
            url: toFileUrl(path),
            documentCacheCoordinator: coordinator,
          }),
        );
      }
      for (const engine of engines) {
        seed(engine, 5);
        for (let index = 0; index < 5; index++) storedValue(engine, index);
      }
      const [a, b] = engines.map(documentCacheDiagnostics);
      assertEquals(coordinator.bytes, a.bytes + b.bytes);
      assertEquals(coordinator.engines, 2);
      assertEquals(coordinator.evictions, 0);
      // An eviction an engine makes on its own account leaves the total too.
      const freed = evictDocumentCacheEntries(engines[0], 1);
      assertEquals(coordinator.bytes, a.bytes + b.bytes - freed);
      shut(engines[0]);
      assertEquals(coordinator.bytes, b.bytes);
      assertEquals(coordinator.engines, 1);
      shut(engines[1]);
      assertEquals(coordinator.bytes, 0);
      assertEquals(coordinator.engines, 0);
    } finally {
      for (const engine of engines) shut(engine);
      for (const path of paths) await Deno.remove(path);
    }
  });

  it("remembers the revision a commit wrote once its rows are durable, and serves the next read from it", async () => {
    const id = entityId(0);
    await withEngine((engine) => {
      const patch = (localSeq: number, field: string) =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(localSeq, {
            operations: [{
              op: "patch",
              id,
              patches: [{ op: "add", path: `/value/${field}`, value: true }],
            }],
          }),
        } as never);
      seed(engine, 1, () => ({ seed: true }));
      // Cold: nothing is cached when the commit below runs. A commit reads
      // the revision it has just written inside its own transaction
      // (snapshot materialization asks for the state it wrote), so that read
      // is staged and reaches the cache only once the commit's rows are
      // durable — as the one entry here.
      evictDocumentCacheEntries(engine, Number.MAX_SAFE_INTEGER);
      const cold = documentCacheDiagnostics(engine);
      assertEquals(cold.entries, 0);
      patch(2, "edited");
      const merged = documentCacheDiagnostics(engine);
      assertEquals(merged.entries, 1, "the commit's read was not remembered");
      // So the first read after the commit already sees the patched revision
      // from the cache.
      assertEquals(storedValue(engine, 0), {
        value: { seed: true, edited: true },
      });
      assertEquals(
        documentCacheDiagnostics(engine).hits - merged.hits,
        1,
        "the patched revision was not served from the cache",
      );
      // The next commit stages its own new revision the same way: one more
      // entry, nothing counted twice — the byte accounting equals the
      // entries' weights.
      patch(3, "again");
      const after = documentCacheDiagnostics(engine);
      assertEquals(after.entries, 2);
      assertEquals(storedValue(engine, 0), {
        value: { seed: true, edited: true, again: true },
      });
      assertEquals(documentCacheDiagnostics(engine).hits - after.hits, 1);
      let sum = 0;
      for (const entry of engine.documentCache.values()) sum += entry.weight;
      assertEquals(after.bytes, sum, "bytes drifted from the entries' weights");
      assertEquals(after.entries, engine.documentCache.size);
    });
  });

  it("forgets what a rolled-back commit read, so a retry at the same coordinates is served fresh", async () => {
    const x = entityId(0);
    const y = entityId(1);
    const attempt = (engine: Engine, body: string, andThen: unknown[]) =>
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(1, {
          operations: [
            { op: "set", id: x, value: { value: body } },
            ...andThen,
          ],
        }),
      } as never);
    await withEngine((engine) => {
      // A commit that writes X and Y, then fails while reading its own rows
      // back (materialization reconstructs Y's patch, which cannot apply):
      // by then X's read-back is staged. SQLite rolls both revisions back,
      // and the staged read must go with them — it answers to the retry's
      // key (same sequence, operation index, op and data length) with
      // content that never existed.
      const before = documentCacheDiagnostics(engine);
      assertThrows(() =>
        attempt(engine, "b".repeat(20), [
          { op: "set", id: y, value: { value: 1 } },
          {
            op: "patch",
            id: y,
            patches: [{ op: "replace", path: "/value/missing/deep", value: 1 }],
          },
        ])
      );
      const rolledBack = documentCacheDiagnostics(engine);
      assertEquals(rolledBack.misses - before.misses, 2, "no read was staged");
      assertEquals(rolledBack.entries, before.entries);
      assertEquals(rolledBack.bytes, before.bytes);
      // The retry at the same coordinates, same length, different content.
      const applied = attempt(engine, "c".repeat(20), []);
      assertEquals(applied.seq, 1);
      assertEquals(storedValue(engine, 0), { value: "c".repeat(20) });
      const served = documentCacheDiagnostics(engine);
      assertEquals(served.entries, 1);
      assertEquals(served.bytes, encodedWeight({ value: "c".repeat(20) }));
      assertEquals(storedValue(engine, 0), { value: "c".repeat(20) });
      assertEquals(documentCacheDiagnostics(engine).hits - served.hits, 1);
    });
  });

  describe("what each counter counts", () => {
    // `hits` and `misses` count reads that resolved to a stored revision,
    // and each such read lands in one of the two. `resumes` and
    // `patchReplays` count rebuilds instead: how many found a revision to
    // start from, and how many stored rows they replayed. The lookup a
    // rebuild makes to find that revision is not a read, so it moves
    // neither `hits` nor `misses`.
    //
    // A commit reaches a rebuild the same way a reader does, through a read
    // that misses: `maybeMaterializeSnapshot` reads back the revision the
    // commit just wrote to decide whether to snapshot it. That read happens
    // only while `snapshotInterval` is positive, so every test here sets one
    // rather than leaning on the engine's default. The interval is set high
    // enough that no snapshot is taken, which would end the patch span a
    // rebuild resumes within.

    const snapshots = { snapshotInterval: 100 };

    it("counts a rebuild's resume apart from a read the cache serves", async () => {
      await withEngine((engine) => {
        seed(engine, 1, () => ({ count: 0 }));
        const seeded = documentCacheDiagnostics(engine);
        for (let count = 1; count <= 3; count++) {
          commitCountPatch(engine, count + 1, count);
        }

        // Three commits, three rebuilds. The only reads are the read-backs
        // the commits themselves make, and each of those misses.
        const committed = documentCacheDiagnostics(engine);
        expect(committed.misses - seeded.misses).toBe(3);
        expect(committed.hits - seeded.hits).toBe(0);

        // The first rebuild has no earlier row to start from. The two after
        // it resume from the one their predecessor left behind, so each of
        // the three replays exactly one row.
        expect(committed.resumes - seeded.resumes).toBe(2);
        expect(committed.patchReplays - seeded.patchReplays).toBe(3);

        // The read that follows is the one thing the cache serves here, and
        // it rebuilds nothing.
        expect(storedValue(engine, 0)).toEqual({ value: { count: 3 } });
        const served = documentCacheDiagnostics(engine);
        expect(served.hits - committed.hits).toBe(1);
        expect(served.misses - committed.misses).toBe(0);
        expect(served.resumes - committed.resumes).toBe(0);
        expect(served.patchReplays - committed.patchReplays).toBe(0);
      }, snapshots);
    });

    it("counts no resume for a rebuild that starts at the base", async () => {
      await withEngine((engine) => {
        seed(engine, 1, () => ({ count: 0 }));
        commitCountPatch(engine, 2, 1);

        // With the cache emptied the next rebuild has nothing to find, so it
        // starts at the base and replays both rows rather than the one a
        // resume would have left it. That difference is the whole of what a
        // resume buys, and `patchReplays` alone does not say which of the
        // two happened.
        evictDocumentCacheEntries(engine, Number.MAX_SAFE_INTEGER);
        const emptied = documentCacheDiagnostics(engine);
        commitCountPatch(engine, 3, 2);
        const rebuilt = documentCacheDiagnostics(engine);
        expect(rebuilt.resumes - emptied.resumes).toBe(0);
        expect(rebuilt.patchReplays - emptied.patchReplays).toBe(2);
        expect(rebuilt.hits - emptied.hits).toBe(0);
        expect(storedValue(engine, 0)).toEqual({ value: { count: 2 } });
      }, snapshots);
    });

    it("counts a rebuild whose replay throws", async () => {
      await withEngine((engine) => {
        seed(engine, 1, () => ({ count: 0 }));
        commitCountPatch(engine, 2, 1);
        const before = documentCacheDiagnostics(engine);

        // The patch cannot apply to what it replays onto, so the rebuild
        // throws and the commit rolls back. The work it did is counted all
        // the same: these are cost counters, not records of what survived.
        // The rebuild resumes from the revision the previous commit left, so
        // the single row after it is both the row replayed and the row whose
        // application throws.
        expect(() =>
          applyCommit(engine, {
            sessionId: "s:a",
            commit: commit(3, {
              operations: [{
                op: "patch",
                id: entityId(0),
                patches: [{ op: "add", path: "/value/count/deep", value: 1 }],
              }],
            }),
          } as never)
        ).toThrow("path is not traversable");
        const after = documentCacheDiagnostics(engine);
        expect(after.resumes - before.resumes).toBe(1);
        expect(after.patchReplays - before.patchReplays).toBe(1);
        expect(storedValue(engine, 0)).toEqual({ value: { count: 1 } });
      }, snapshots);
    });

    it("counts neither a hit nor a miss for an entity with no revision", async () => {
      await withEngine((engine) => {
        seed(engine, 1, () => ({ count: 0 }));
        const seeded = documentCacheDiagnostics(engine);

        // The read resolves to no stored revision, so there is nothing for
        // the cache to have served or failed to serve.
        expect(storedValue(engine, 1)).toBe(null);
        const after = documentCacheDiagnostics(engine);
        expect(after.hits - seeded.hits).toBe(0);
        expect(after.misses - seeded.misses).toBe(0);
      });
    });
  });
});
