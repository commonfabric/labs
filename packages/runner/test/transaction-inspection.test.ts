import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { NormalizedFullLink } from "../src/link-utils.ts";
import { txToReactivityLog } from "../src/scheduler.ts";
import {
  ExtendedStorageTransaction,
  TransactionWrapper,
} from "../src/storage/extended-storage-transaction.ts";
import type {
  IExtendedStorageTransaction,
  IReadActivity,
  ITransactionJournal,
  ITransactionWriteRequest,
  TransactionReactivityLog,
} from "../src/storage/interface.ts";
import { reactivityLogFromActivities } from "../src/storage/reactivity-log.ts";
import {
  getTransactionReadActivities,
  getTransactionWriteAttempts,
  getTransactionWriteDetails,
  getTransactionWrittenSpaces,
} from "../src/storage/transaction-inspection.ts";

const signer = await Identity.fromPassphrase("transaction-inspection");
const space = signer.did();

class EmptyJournal implements ITransactionJournal {
  activity(): Iterable<any> {
    return [];
  }

  novelty(_space: any): Iterable<any> {
    return [];
  }

  history(_space: any): Iterable<any> {
    return [];
  }
}

describe("transaction inspection", () => {
  it("uses direct reactivity logs when provided", () => {
    const journal = new EmptyJournal();
    const tx = {
      journal,
      getReactivityLog: () => ({
        reads: [{
          space: "did:key:test" as any,
          scope: "space",
          id: "of:read" as any,
          path: ["field"],
        }],
        shallowReads: [],
        writes: [{
          space: "did:key:test" as any,
          scope: "space",
          id: "of:write" as any,
          path: ["field"],
        }],
      }),
      status: () => ({ status: "done" as const, journal }),
      tx: {} as any,
    } as unknown as IExtendedStorageTransaction;

    assertEquals(txToReactivityLog(tx), {
      reads: [{
        space: "did:key:test",
        scope: "space",
        id: "of:read",
        path: ["field"],
      }],
      shallowReads: [],
      writes: [{
        space: "did:key:test",
        scope: "space",
        id: "of:write",
        path: ["field"],
      }],
    });
  });

  it("preserves document-root paths in derived reactivity logs", () => {
    assertEquals(
      reactivityLogFromActivities([
        {
          read: {
            space: "did:key:test" as any,
            scope: "space",
            id: "of:read" as any,
            path: ["links", "peer"],
            meta: {},
          },
        },
        {
          read: {
            space: "did:key:test" as any,
            scope: "space",
            id: "of:shallow" as any,
            path: ["value", "items"],
            meta: {},
            nonRecursive: true,
          },
        },
        {
          write: {
            space: "did:key:test" as any,
            scope: "space",
            id: "of:write" as any,
            path: ["meta", "updatedAt"],
          },
        },
      ]),
      {
        reads: [{
          space: "did:key:test",
          scope: "space",
          id: "of:read",
          path: ["links", "peer"],
        }],
        shallowReads: [{
          space: "did:key:test",
          scope: "space",
          id: "of:shallow",
          path: ["value", "items"],
        }],
        writes: [{
          space: "did:key:test",
          scope: "space",
          id: "of:write",
          path: ["meta", "updatedAt"],
        }],
      },
    );
  });

  it("uses the native v2 transaction reactivity log hook", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });

    try {
      const tx = storageManager.edit();
      const id = "test:transaction-inspection-direct-v2" as const;
      tx.write({
        space,
        scope: "space",
        id,
        path: [],
      }, { value: { count: 1 } });
      tx.read({
        space,
        scope: "space",
        id,
        path: ["value"],
      });

      const expected: TransactionReactivityLog = {
        reads: [{
          space,
          scope: "space",
          id,
          path: ["value"],
        }],
        shallowReads: [],
        writes: [{
          space,
          scope: "space",
          id,
          path: [],
        }],
      };
      const direct = tx.getReactivityLog?.();
      assertExists(direct);
      assertEquals(direct, expected);

      const extended = {
        tx,
        journal: tx.journal,
        status: tx.status.bind(tx),
      } as unknown as IExtendedStorageTransaction;
      assertEquals(txToReactivityLog(extended), expected);
    } finally {
      await storageManager.close();
    }
  });

  it("preserves full-document paths in native v2 reactivity logs", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });

    try {
      const id =
        "test:transaction-inspection-direct-v2-document-paths" as const;

      const seed = storageManager.edit();
      seed.write({
        space,
        scope: "space",
        id,
        path: [],
      }, {
        value: { count: 1 },
        source: { "/": "origin" },
        meta: { updatedAt: "before" },
      });
      await seed.commit();

      const tx = storageManager.edit();
      tx.read({
        space,
        scope: "space",
        id,
        path: ["source"],
      });
      tx.write({
        space,
        scope: "space",
        id,
        path: ["meta", "updatedAt"],
      }, "after");

      const expected: TransactionReactivityLog = {
        reads: [{
          space,
          scope: "space",
          id,
          path: ["source"],
        }],
        shallowReads: [],
        writes: [{
          space,
          scope: "space",
          id,
          path: ["meta", "updatedAt"],
        }],
      };

      assertEquals(tx.getReactivityLog?.(), expected);
    } finally {
      await storageManager.close();
    }
  });

  it("forwards native v2 hooks through extended transaction wrappers", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });

    try {
      const tx = storageManager.edit();
      const id = "test:transaction-inspection-wrapped-v2" as const;
      tx.write({
        space,
        scope: "space",
        id,
        path: [],
      }, { value: { count: 1 } });
      tx.read({
        space,
        scope: "space",
        id,
        path: ["value"],
      });

      const expected: TransactionReactivityLog = {
        reads: [{
          space,
          scope: "space",
          id,
          path: ["value"],
        }],
        shallowReads: [],
        writes: [{
          space,
          scope: "space",
          id,
          path: [],
        }],
      };

      const extended = new ExtendedStorageTransaction(tx);
      const wrapped = new TransactionWrapper(extended);

      assertEquals(extended.getReactivityLog?.(), expected);
      assertEquals(wrapped.getReactivityLog?.(), expected);
      assertEquals(txToReactivityLog(wrapped), expected);
    } finally {
      await storageManager.close();
    }
  });

  it("forwards the current candidate journal without copying records or replacing absent capabilities", () => {
    const records: IReadActivity[] = [{
      space,
      id: "test:candidate-journal",
      path: ["value"],
      meta: { internalVerifierRead: false },
    }];
    const inner = {
      getPotentiallyExternalReadActivities() {
        return records;
      },
    } as unknown as IExtendedStorageTransaction;
    const wrapper = new TransactionWrapper(inner);
    expect(wrapper.getPotentiallyExternalReadActivities()).toBe(records);
    records[0].meta.internalVerifierRead = true;
    records.push({
      space,
      id: "test:later-candidate",
      path: ["value", "field"],
      meta: {},
    });
    expect([...wrapper.getPotentiallyExternalReadActivities()!]).toEqual(
      records,
    );
    expect([...wrapper.getPotentiallyExternalReadActivities()!][0]).toBe(
      records[0],
    );
    delete inner.getPotentiallyExternalReadActivities;
    expect(wrapper.getPotentiallyExternalReadActivities()).toBeUndefined();
    inner.getPotentiallyExternalReadActivities = () => undefined;
    expect(wrapper.getPotentiallyExternalReadActivities()).toBeUndefined();
  });

  it("does not fan out batch writes when the wrapped transaction already handles them", () => {
    const writes: Array<{ address: NormalizedFullLink; value: FabricValue }> = [
      {
        address: {
          space,
          scope: "space",
          id: "test:transaction-wrapper-write-values-1" as const,
          path: ["count"],
        },
        value: 1,
      },
      {
        address: {
          space,
          scope: "space",
          id: "test:transaction-wrapper-write-values-2" as const,
          path: ["count"],
        },
        value: 2,
      },
    ];
    const observed: ITransactionWriteRequest[] = [];
    const wrapped = new TransactionWrapper({
      writeValuesOrThrow(batch: Iterable<ITransactionWriteRequest>) {
        observed.push(...batch);
      },
      writeValueOrThrow() {
        throw new Error("wrapper should not replay batch writes");
      },
    } as unknown as IExtendedStorageTransaction);

    wrapped.writeValuesOrThrow(writes);

    assertEquals(observed, writes);
  });

  it("uses the native v2 read activity hook without journal replay", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });

    try {
      const tx = storageManager.edit();
      const id = "test:transaction-inspection-read-activities-v2" as const;
      tx.read({
        space,
        scope: "space",
        id,
        path: ["value", "count"],
      }, { nonRecursive: true, meta: { source: "direct-hook" } });

      assertEquals([...getTransactionReadActivities(tx)], [{
        space,
        scope: "space",
        id,
        path: ["value", "count"],
        meta: { source: "direct-hook" },
        nonRecursive: true,
        // The per-tx activity clock (shared with write attempts), stamped
        // natively by the V2 transaction at record time.
        journalIndex: 0,
      }]);
    } finally {
      await storageManager.close();
    }
  });

  it("derives positional clock stamps from a journal-backed transaction", () => {
    // Journal fallback: reads and writes share one enumeration of the
    // activity stream, so the derived indices sit on one clock — the same
    // contract the native V2 stamps satisfy.
    const id = "test:transaction-inspection-journal-fallback" as const;
    const read = { space, scope: "space", id, path: ["value"], meta: {} };
    const write = { space, scope: "space", id, path: ["value", "count"] };
    const journalTx = {
      journal: {
        activity: () => [{ read }, { write }, { read }],
      },
    } as unknown as IExtendedStorageTransaction;

    assertEquals(
      [...getTransactionReadActivities(journalTx)].map((r) => r.journalIndex),
      [0, 2],
    );
    assertEquals(
      getTransactionWriteAttempts(journalTx)?.map((attempt) => ({
        path: attempt.path,
        journalIndex: attempt.journalIndex,
      })),
      [{ path: ["value", "count"], journalIndex: 1 }],
    );

    // Neither a native log nor a working journal: "order unknown" — callers
    // must degrade to transaction-global gating, never a too-early bound.
    const bareTx = {
      journal: {
        activity: () => {
          throw new Error("no activity");
        },
      },
    } as unknown as IExtendedStorageTransaction;
    assertEquals(getTransactionWriteAttempts(bareTx), undefined);
  });

  it("stamps reads and write attempts on one shared activity clock (D4)", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });

    try {
      const tx = storageManager.edit();
      const id = "test:transaction-inspection-activity-clock-v2" as const;
      // read | write | read | write — the write-prefix provenance gate
      // depends on this interleaving being recoverable, so the clock is one
      // monotonic counter across BOTH record points, and the attempt log
      // keeps one entry per applied write in temporal order (unlike the
      // per-path upserts in write details).
      tx.read({ space, scope: "space", id, path: ["value", "count"] });
      tx.write({ space, scope: "space", id, path: [] }, {
        value: { count: 1 },
      });
      tx.read({ space, scope: "space", id, path: ["value", "count"] });
      tx.write({ space, scope: "space", id, path: ["value", "count"] }, 2);

      assertEquals(
        [...getTransactionReadActivities(tx)].map((read) => read.journalIndex),
        [0, 2],
      );
      const attempts = getTransactionWriteAttempts(tx);
      assertEquals(
        attempts?.map((attempt) => ({
          path: attempt.path,
          journalIndex: attempt.journalIndex,
        })),
        [
          { path: [], journalIndex: 1 },
          { path: ["value", "count"], journalIndex: 3 },
        ],
      );
    } finally {
      await storageManager.close();
    }
  });

  it("elides value-equal writes from the attempt log like the rest of the inspection surface", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });

    try {
      const seed = storageManager.edit();
      const id = "test:transaction-inspection-attempt-elision-v2" as const;
      seed.write({ space, scope: "space", id, path: [] }, {
        value: { count: 1 },
      });
      await seed.commit();

      const tx = storageManager.edit();
      // A value-equal write is elided storage-wide (no write details, no
      // reactivity) — the attempt log matches, so the CFC prefix gate sees
      // exactly the write set every other enforcement source sees.
      tx.write({ space, scope: "space", id, path: ["value", "count"] }, 1);
      assertEquals(getTransactionWriteAttempts(tx)?.length, 0);
      tx.write({ space, scope: "space", id, path: ["value", "count"] }, 2);
      assertEquals(getTransactionWriteAttempts(tx)?.length, 1);
    } finally {
      await storageManager.close();
    }
  });

  it("throws when native v2 code tries to replay journal activity", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });

    try {
      const tx = storageManager.edit();
      const id = "test:transaction-inspection-activity-order-v2" as const;
      tx.write({
        space,
        scope: "space",
        id,
        path: [],
      }, { value: { count: 1 } });
      tx.read({
        space,
        scope: "space",
        id,
        path: ["value"],
      });
      tx.write({
        space,
        scope: "space",
        id,
        path: ["value", "count"],
      }, 2);

      assertThrows(
        () => [...tx.journal.activity()],
        Error,
        "V2 transactions do not support journal.activity()",
      );
    } finally {
      await storageManager.close();
    }
  });

  it("preserves the original previousValue in native v2 write details", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });

    try {
      const seed = storageManager.edit();
      const id = "test:transaction-inspection-write-details-v2" as const;
      seed.write({
        space,
        scope: "space",
        id,
        path: [],
      }, { value: { count: 1 } });
      await seed.commit();

      const tx = storageManager.edit();
      tx.write({
        space,
        scope: "space",
        id,
        path: ["value", "count"],
      }, 2);
      tx.write({
        space,
        scope: "space",
        id,
        path: ["value", "count"],
      }, 3);

      assertEquals([...getTransactionWriteDetails(tx, space)], [{
        address: {
          space,
          scope: "space",
          id,
          path: ["value", "count"],
        },
        value: 3,
        previousValue: 1,
        previousPresent: true,
      }]);

      assertEquals([...tx.journal.novelty(space)], [{
        address: {
          id,
          path: ["value", "count"],
        },
        value: 3,
      }]);

      assertEquals([...tx.journal.history(space)], [{
        address: {
          id,
          path: ["value", "count"],
        },
        value: 1,
      }]);
    } finally {
      await storageManager.close();
    }
  });

  it("lists a space whose only write returned to its starting value among the written spaces", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    try {
      const id = "test:transaction-inspection-written-spaces-revert" as const;
      const seed = storageManager.edit();
      seed.write({ space, scope: "space", id, path: [] }, {
        value: { count: 1 },
      });
      await seed.commit();

      const tx = storageManager.edit();
      const address = {
        space,
        scope: "space",
        id,
        path: ["value", "count"],
      } as const;
      tx.write(address, 2);
      tx.write(address, 1);

      // The reactivity log lists only changed paths, so it names no write.
      expect(tx.getReactivityLog?.().writes).toEqual([]);
      expect(getTransactionWrittenSpaces(tx)).toEqual([space]);
    } finally {
      await storageManager.close();
    }
  });

  it("leaves a space the transaction only read out of the written spaces", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    try {
      const id = "test:transaction-inspection-written-spaces-read" as const;
      const seed = storageManager.edit();
      seed.write({ space, scope: "space", id, path: [] }, {
        value: { count: 1 },
      });
      await seed.commit();

      const tx = storageManager.edit();
      tx.read({ space, scope: "space", id, path: ["value", "count"] });

      expect(getTransactionWrittenSpaces(tx)).toEqual([]);
    } finally {
      await storageManager.close();
    }
  });

  it(
    "preserves correct previousValue across distinct-path writes within a single transaction " +
      "(regression: applyMutablePathWrite mutates current.value in place on 2nd+ write)",
    async () => {
      // Two writes at *different* leaf paths within one transaction. The
      // second write's `previousValue` must capture what was at path
      // ["value", "b"] BEFORE the second write (= the seed value), not the
      // value that's just been written. Reading the activity-path snapshot
      // AFTER `applyMutablePathWrite()` would observe the post-mutation
      // state because the helper mutates `current.value` in place on the
      // second-and-later write (cloneForMutation short-circuits to
      // identity on an already-mutable root).
      const storageManager = StorageManager.emulate({ as: signer });
      try {
        const id =
          "test:transaction-inspection-previousvalue-across-paths-v2" as const;
        const seed = storageManager.edit();
        seed.write({ space, scope: "space", id, path: [] }, {
          value: { a: 1, b: 2 },
        });
        await seed.commit();

        const tx = storageManager.edit();
        tx.write({ space, scope: "space", id, path: ["value", "a"] }, 10);
        tx.write({ space, scope: "space", id, path: ["value", "b"] }, 20);

        const details = [...getTransactionWriteDetails(tx, space)].sort(
          (l, r) =>
            l.address.path.join("/").localeCompare(r.address.path.join("/")),
        );
        assertEquals(details, [
          {
            address: { space, scope: "space", id, path: ["value", "a"] },
            value: 10,
            previousValue: 1,
            previousPresent: true,
          },
          {
            address: { space, scope: "space", id, path: ["value", "b"] },
            value: 20,
            previousValue: 2, // <- regression: was 20 (post-mutation) before fix
            previousPresent: true,
          },
        ]);
      } finally {
        await storageManager.close();
      }
    },
  );

  it(
    "captures correct previousActivityValue for a create-parents write that follows " +
      "an earlier in-tx write (regression: read-before-mutate ordering for the " +
      "materialization-parent activity snapshot)",
    async () => {
      // The first write thaws `doc.current.value` in place (sub-tree at
      // `/value/a` becomes mutable). The second write creates new parents
      // at a sibling subtree `/value/new/nested`. Its
      // `findMaterializedParentPath` walks the (already-mutable)
      // `current.value` and returns `["value"]` as the materialization
      // point. `previousActivityValue` at that path must capture the
      // PRE-second-write state of `/value` (= `{a: 10}` from the first
      // write's in-place result, not the POST-second-write state with the
      // `new` child added).
      const storageManager = StorageManager.emulate({ as: signer });
      try {
        const id =
          "test:transaction-inspection-create-parents-after-mutation-v2" as const;
        const seed = storageManager.edit();
        seed.write({ space, scope: "space", id, path: [] }, {
          value: { a: 1 },
        });
        await seed.commit();

        const tx = storageManager.edit();
        // 1st write: mutates `/value/a` in place (thaws the spine).
        tx.write({ space, scope: "space", id, path: ["value", "a"] }, 10);
        // 2nd write: create-parents at `/value/new/nested`. The activity
        // path will be `["value"]` (the materialization point); the
        // previousActivityValue there must be `{a: 10}` -- the inter-write
        // state of `/value` -- not the post-second-write state.
        tx.write({
          space,
          scope: "space",
          id,
          path: ["value", "new", "nested"],
        }, "hello");

        const detailByPath = new Map<
          string,
          ReturnType<typeof getTransactionWriteDetails> extends
            Iterable<infer T> ? T
            : never
        >();
        for (const detail of getTransactionWriteDetails(tx, space)) {
          detailByPath.set(detail.address.path.join("/"), detail);
        }
        // `/value/a` is a simple-path leaf write -- previousValue is the
        // seed value `1` (pre-transaction).
        assertEquals(detailByPath.get("value/a"), {
          address: { space, scope: "space", id, path: ["value", "a"] },
          value: 10,
          previousValue: 1,
          previousPresent: true,
        });
        // `/value` is the create-parents materialization point. The
        // entry's previousValue is what was at `/value` before the
        // second write -- the inter-write `{a: 10}` -- not the post-write
        // `{a: 10, new: {nested: "hello"}}`.
        assertEquals(detailByPath.get("value"), {
          address: { space, scope: "space", id, path: ["value"] },
          value: { a: 10, new: { nested: "hello" } },
          previousValue: { a: 10 },
          previousPresent: true,
        });
      } finally {
        await storageManager.close();
      }
    },
  );

  it("records the rewritten parent path when a single native v2 batch write materializes missing parents", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });

    try {
      const id = "test:transaction-inspection-batch-parent-write-v2" as const;
      const seed = storageManager.edit();
      seed.write({
        space,
        scope: "space",
        id,
        path: [],
      }, { value: { count: 1 } });
      await seed.commit();

      const tx = storageManager.edit();
      const extended = new ExtendedStorageTransaction(tx);
      extended.writeValuesOrThrow([{
        address: {
          space,
          scope: "space",
          id,
          path: ["profile", "name"],
        },
        value: "Ada",
      }]);

      assertEquals(extended.getReactivityLog(), {
        reads: [],
        shallowReads: [],
        writes: [{
          space,
          scope: "space",
          id,
          path: ["value"],
        }, {
          space,
          scope: "space",
          id,
          path: ["value", "profile"],
        }, {
          space,
          scope: "space",
          id,
          path: ["value", "profile", "name"],
        }],
      });

      assertEquals(
        [...getTransactionWriteDetails(extended, space)].map((detail) =>
          detail.address
        ),
        [{
          space,
          scope: "space",
          id,
          path: ["value"],
        }],
      );
    } finally {
      await storageManager.close();
    }
  });

  it("records the rewritten parent path during native v2 batch materialization before later leaf writes", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });

    try {
      const id =
        "test:transaction-inspection-batch-parent-write-run-v2" as const;
      const seed = storageManager.edit();
      seed.write({
        space,
        scope: "space",
        id,
        path: [],
      }, { value: { count: 1 } });
      await seed.commit();

      const tx = storageManager.edit();
      const extended = new ExtendedStorageTransaction(tx);
      extended.writeValuesOrThrow([{
        address: {
          space,
          scope: "space",
          id,
          path: ["profile", "name"],
        },
        value: "Ada",
      }, {
        address: {
          space,
          scope: "space",
          id,
          path: ["profile", "age"],
        },
        value: 42,
      }]);

      assertEquals(extended.getReactivityLog(), {
        reads: [],
        shallowReads: [],
        writes: [{
          space,
          scope: "space",
          id,
          path: ["value"],
        }, {
          space,
          scope: "space",
          id,
          path: ["value", "profile"],
        }, {
          space,
          scope: "space",
          id,
          path: ["value", "profile", "age"],
        }, {
          space,
          scope: "space",
          id,
          path: ["value", "profile", "name"],
        }],
      });

      assertEquals(
        [...getTransactionWriteDetails(extended, space)].map((detail) =>
          detail.address
        ),
        [{
          space,
          scope: "space",
          id,
          path: ["value"],
        }, {
          space,
          scope: "space",
          id,
          path: ["value", "profile", "age"],
        }],
      );
    } finally {
      await storageManager.close();
    }
  });

  it("derives precise array reactivity writes while keeping structural ancestors for length changes", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });

    try {
      const id = "test:transaction-inspection-array-reactivity-v2" as const;
      const seed = storageManager.edit();
      seed.write({
        space,
        scope: "space",
        id,
        path: [],
      }, { value: { tags: ["one", "two"] } });
      await seed.commit();

      const tx = storageManager.edit();
      tx.write({
        space,
        scope: "space",
        id,
        path: ["value", "tags", "0"],
      }, "zero");
      tx.write({
        space,
        scope: "space",
        id,
        path: ["value", "tags", "length"],
      }, 1);

      assertEquals(tx.getReactivityLog?.(), {
        reads: [],
        shallowReads: [],
        writes: [{
          space,
          scope: "space",
          id,
          path: ["value", "tags"],
        }, {
          space,
          scope: "space",
          id,
          path: ["value", "tags", "0"],
        }, {
          space,
          scope: "space",
          id,
          path: ["value", "tags", "length"],
        }],
      });
    } finally {
      await storageManager.close();
    }
  });

  it("keeps same-length array element writes exact in native v2 reactivity logs", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });

    try {
      const id =
        "test:transaction-inspection-array-element-reactivity-v2" as const;
      const seed = storageManager.edit();
      seed.write({
        space,
        scope: "space",
        id,
        path: [],
      }, { value: { tags: ["one", "two"] } });
      await seed.commit();

      const tx = storageManager.edit();
      tx.write({
        space,
        scope: "space",
        id,
        path: ["value", "tags", "0"],
      }, "zero");

      assertEquals(tx.getReactivityLog?.(), {
        reads: [],
        shallowReads: [],
        writes: [{
          space,
          scope: "space",
          id,
          path: ["value", "tags", "0"],
        }],
      });
    } finally {
      await storageManager.close();
    }
  });
});
