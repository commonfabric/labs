import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type {
  Entity,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { createQueryResultProxy } from "../src/query-result-proxy.ts";
import { readStatsActive, startReadStats } from "../src/read-stats.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler/types.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import { RuntimeTelemetryEvent } from "../src/telemetry.ts";
import {
  createDefaultTraversalContext,
  getAtPath,
  type IMemorySpaceValueAttestation,
  ManagedStorageTransaction,
} from "../src/traverse.ts";

const signer = await Identity.fromPassphrase("read-stats");
const space = signer.did();
const rowsSchema = {
  type: "array",
  items: { type: "object", properties: { n: { type: "number" } } },
} as const satisfies JSONSchema;

describe("read-stats", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await storageManager.synced();
    await runtime.dispose();
    await storageManager.close();
    expect(readStatsActive).toBe(false);
  });

  for (const schema of [undefined, rowsSchema]) {
    describe(schema ? "schema views" : "query result proxies", () => {
      for (const size of [10, 100, 1000]) {
        it(`counts all ${size} elements and fields on each reduce scan`, async () => {
          const write = runtime.edit();
          const cell = runtime.getCell<{ n: number }[]>(
            space,
            "rows",
            schema,
            write,
          );
          cell.set(Array.from({ length: size }, (_, n) => ({ n })));
          await write.commit();
          const tx = runtime.edit();
          tx.markLazyMaterialize();
          const view = schema
            ? cell.withTx(tx).get()
            : createQueryResultProxy<{ n: number }[]>(
              runtime,
              tx,
              cell.getAsNormalizedFullLink(),
            );
          const finish = startReadStats(tx);
          try {
            expect(view.reduce((sum, row) => sum + row.n, 0)).toBe(
              size * (size - 1) / 2,
            );
            expect(view.reduce((sum, row) => sum + row.n, 0)).toBe(
              size * (size - 1) / 2,
            );
          } finally {
            const reads = finish(0);
            expect(reads.proxyAccesses).toBe(size * 4);
            // Cell writes anchor each object element in its own document.
            expect(reads.distinctDocuments).toBe(size + 1);
            tx.abort();
          }
        });
      }

      it("counts repeated array length reads directly and through descriptors", async () => {
        const write = runtime.edit();
        const cell = runtime.getCell<{ n: number }[]>(
          space,
          "rows",
          schema,
          write,
        );
        cell.set([{ n: 7 }]);
        await write.commit();
        const tx = runtime.edit();
        tx.markLazyMaterialize();
        const view = schema
          ? cell.withTx(tx).get()
          : createQueryResultProxy<{ n: number }[]>(
            runtime,
            tx,
            cell.getAsNormalizedFullLink(),
          );
        const finish = startReadStats(tx);
        try {
          expect(view.length).toBe(1);
          expect(view.length).toBe(1);
          expect(Object.getOwnPropertyDescriptor(view, "length")?.value).toBe(
            1,
          );
          expect(Object.getOwnPropertyDescriptor(view, "length")?.value).toBe(
            1,
          );
        } finally {
          const reads = finish(0);
          tx.abort();
          expect(reads.proxyAccesses).toBe(4);
        }
      });

      it("counts iterator element reads and repeated cached property reads", async () => {
        const write = runtime.edit();
        const cell = runtime.getCell<{ n: number }[]>(
          space,
          "rows",
          schema,
          write,
        );
        cell.set([{ n: 7 }, { n: 8 }]);
        await write.commit();
        const tx = runtime.edit();
        tx.markLazyMaterialize();
        const view = schema
          ? cell.withTx(tx).get()
          : createQueryResultProxy<{ n: number }[]>(
            runtime,
            tx,
            cell.getAsNormalizedFullLink(),
          );
        const finish = startReadStats(tx);
        try {
          let sum = 0;
          for (const row of view) sum += row.n + row.n;
          expect(sum).toBe(30);
        } finally {
          expect(finish(0).proxyAccesses).toBe(6);
          tx.abort();
        }
      });

      it("counts repeated property descriptor reads", async () => {
        const write = runtime.edit();
        const cell = runtime.getCell<{ n: number }[]>(
          space,
          "rows",
          schema,
          write,
        );
        cell.set([{ n: 7 }]);
        await write.commit();
        const tx = runtime.edit();
        tx.markLazyMaterialize();
        const view = schema
          ? cell.withTx(tx).get()
          : createQueryResultProxy<{ n: number }[]>(
            runtime,
            tx,
            cell.getAsNormalizedFullLink(),
          );
        const row = view[0];
        const finish = startReadStats(tx);
        try {
          expect(Object.getOwnPropertyDescriptor(row, "n")?.get?.call(row))
            .toBe(7);
          expect(Object.getOwnPropertyDescriptor(row, "n")?.get?.call(row))
            .toBe(7);
        } finally {
          const reads = finish(0);
          tx.abort();
          // Optional schema properties also project their presence before
          // exposing an accessor; each accessor then reads the value.
          expect(reads.proxyAccesses).toBe(schema ? 4 : 2);
        }
      });
    });
  }

  const reductions = [
    {
      name: "count",
      run: (rows: readonly { n: number }[]) =>
        rows.reduce((count) => count + 1, 0),
      accesses: () => 0,
      result: (n: number) => n,
      runs: 0,
    },
    {
      name: "count(predicate)",
      run: (rows: readonly { n: number }[]) =>
        rows.reduce((count, row) => count + (row.n % 2 === 0 ? 1 : 0), 0),
      accesses: (n: number) => 2 * n,
      result: (n: number) => n / 2,
    },
    {
      name: "sum",
      run: (rows: readonly { n: number }[]) =>
        rows.reduce((sum, row) => sum + row.n, 0),
      accesses: (n: number) => 2 * n,
      result: (n: number) => n * (n - 1) / 2 + 10,
    },
    {
      name: "min",
      run: (rows: readonly { n: number }[]) =>
        rows.reduce((min, row) => Math.min(min, row.n), Infinity),
      accesses: (n: number) => 2 * n,
      result: () => 1,
    },
    {
      name: "max",
      run: (rows: readonly { n: number }[]) =>
        rows.reduce((max, row) => Math.max(max, row.n), -Infinity),
      accesses: (n: number) => 2 * n,
      result: (n: number) => Math.max(10, n - 1),
    },
    {
      name: "minBy",
      run: (rows: readonly { n: number }[]) =>
        rows.reduce<{ n: number } | undefined>(
          (best, row) => best === undefined || row.n < best.n ? row : best,
          undefined,
        )!.n,
      accesses: (n: number) => 3 * n - 1,
      result: () => 1,
    },
    {
      name: "maxBy",
      run: (rows: readonly { n: number }[]) =>
        rows.reduce<{ n: number } | undefined>(
          (best, row) => best === undefined || row.n > best.n ? row : best,
          undefined,
        )!.n,
      accesses: (n: number) => 3 * n - 1,
      result: (n: number) => Math.max(10, n - 1),
    },
  ];
  for (const reduction of reductions) {
    for (const size of [10, 100, 1000]) {
      it(`counts update work for ${size} rows reduced to ${reduction.name}`, async () => {
        const write = runtime.edit();
        const cell = runtime.getCell<{ n: number }[]>(
          space,
          "rows",
          rowsSchema,
          write,
        );
        cell.set(Array.from({ length: size }, (_, n) => ({ n })));
        await write.commit();
        runtime.scheduler.setReadStatsEnabled(true);
        let result = 0;
        const action: Action = (tx) => {
          tx.markLazyMaterialize();
          result = reduction.run(cell.withTx(tx).get());
        };
        const cancel = runtime.scheduler.subscribe(action, {
          reads: [],
          shallowReads: [],
          writes: [],
        }, { isEffect: true });
        try {
          await runtime.idle();
          const initial = runtime.scheduler.getActionStats(action)!;
          const beforeRuns = initial.runCount;
          const beforeAccesses = initial.reads!.proxyAccesses;
          const edit = runtime.edit();
          cell.withTx(edit).key(0).key("n").set(10);
          await edit.commit();
          await runtime.idle();
          expect(result).toBe(reduction.result(size));
          const updated = runtime.scheduler.getActionStats(action)!;
          expect(updated.runCount - beforeRuns).toBe(reduction.runs ?? 1);
          expect(updated.reads!.proxyAccesses - beforeAccesses).toBe(
            reduction.accesses(size),
          );
        } finally {
          cancel();
        }
      });
    }
  }

  it("rescans every element for a reduce-based count after an append", async () => {
    const write = runtime.edit();
    const cell = runtime.getCell<number[]>(space, "count-rows", {
      type: "array",
      items: { type: "number" },
    }, write);
    cell.set(Array.from({ length: 100 }, (_, n) => n));
    await write.commit();
    runtime.scheduler.setReadStatsEnabled(true);
    let result = 0;
    const action: Action = (tx) => {
      tx.markLazyMaterialize();
      result = cell.withTx(tx).get().reduce((count) => count + 1, 0);
    };
    const cancel = runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    try {
      await runtime.idle();
      expect(result).toBe(100);
      const before =
        runtime.scheduler.getActionStats(action)!.reads!.proxyAccesses;
      const edit = runtime.edit();
      cell.withTx(edit).push(100);
      await edit.commit();
      await runtime.idle();
      expect(result).toBe(101);
      expect(
        runtime.scheduler.getActionStats(action)!.reads!.proxyAccesses - before,
      ).toBe(101);
    } finally {
      cancel();
    }
  });

  it("isolates overlapping transactions and counts only traversed link hops", async () => {
    const write = runtime.edit();
    const target = runtime.getCell<number>(space, "target", undefined, write);
    target.set(7);
    const holder = runtime.getCell<{ n: number }>(
      space,
      "holder",
      undefined,
      write,
    );
    holder.key("n").set(target);
    await write.commit();
    const tx1 = runtime.edit();
    const tx2 = runtime.edit();
    const view1 = holder.withTx(tx1).get();
    const view2 = holder.withTx(tx2).get();
    const finish1 = startReadStats(tx1);
    const finish2 = startReadStats(tx2);
    try {
      expect(view1.n).toBe(7);
      expect(view1.n).toBe(7);
      expect(view2.n).toBe(7);
    } finally {
      const first = finish1(0);
      const second = finish2(0);
      expect(first.proxyAccesses).toBe(2);
      expect(second.proxyAccesses).toBe(1);
      expect(first.linkResolutions).toBe(1);
      expect(second.linkResolutions).toBe(1);
      expect(first.distinctDocuments).toBe(2);
      expect(second.distinctDocuments).toBe(2);
      tx1.abort();
      tx2.abort();
    }
  });

  for (const size of [1, 2, 10]) {
    it(`counts each stored link when eagerly materializing ${size} array items`, async () => {
      const write = runtime.edit();
      const rows = runtime.getCell<{ n: number }[]>(
        space,
        "rows",
        rowsSchema,
        write,
      );
      const values = Array.from({ length: size }, (_, n) => ({ n }));
      rows.set(values);
      await write.commit();
      const tx = runtime.edit();
      const finish = startReadStats(tx);
      try {
        expect(rows.withTx(tx).get()).toEqual(values);
      } finally {
        const reads = finish(0);
        tx.abort();
        expect(reads.linkResolutions).toBe(size);
        expect(reads.distinctDocuments).toBe(size + 1);
      }
    });
  }

  it("counts both target reads when a prepared array hop needs a fallback", async () => {
    const write = runtime.edit();
    const rows = runtime.getCell<{ n: number }[]>(
      space,
      "rows",
      rowsSchema,
      write,
    );
    rows.set([{ n: 1 }, { n: 2 }]);
    await write.commit();
    const tx = runtime.edit();
    const sourceId = rows.getAsNormalizedFullLink().id;
    const read = tx.read.bind(tx);
    let fallbackRequested = false;
    tx.read = (address, options) => {
      const result = read(address, options);
      if (
        !fallbackRequested && address.id !== sourceId &&
        address.path.length === 1 && address.path[0] === "value" &&
        options?.nonRecursive === true && result.ok
      ) {
        // The fast read performs its work but supplies no usable value,
        // forcing the general traversal to read this target again.
        fallbackRequested = true;
        return { ok: { ...result.ok, value: undefined } };
      }
      return result;
    };
    const finish = startReadStats(tx);
    try {
      expect(rows.withTx(tx).get()).toEqual([{ n: 1 }, { n: 2 }]);
      expect(fallbackRequested).toBe(true);
    } finally {
      const reads = finish(0);
      tx.abort();
      expect(reads.linkResolutions).toBe(3);
      expect(reads.distinctDocuments).toBe(3);
    }
  });

  it("does not count a link traversal rejected by cycle detection", () => {
    const id = "of:self" as URI;
    const value = { "/": { "link@1": { id, space, path: [] } } };
    const store = new Map<string, Revision<State>>([
      [`${id}/application/json`, {
        the: "application/json",
        of: id as Entity,
        is: { value },
        since: 1,
      }],
    ]);
    const tx = new ExtendedStorageTransaction(
      new ManagedStorageTransaction(new StoreObjectManager(store)),
    );
    const doc: IMemorySpaceValueAttestation = {
      address: { id, type: "application/json", path: ["value"], space },
      value,
    };
    const context = createDefaultTraversalContext({
      principal: space,
      sessionId: "test",
    });
    const finish = startReadStats(tx);
    try {
      const [result] = getAtPath(tx, doc, [], context);
      expect(result.value).toBeUndefined();
    } finally {
      const reads = finish(0);
      expect(reads.linkResolutions).toBe(1);
    }
  });

  it("counts the stored link followed by eager cell handle materialization", async () => {
    const write = runtime.edit();
    const target = runtime.getCell<number>(space, "target", undefined, write);
    target.set(7);
    const holder = runtime.getCell<{ n: number }>(
      space,
      "holder",
      undefined,
      write,
    );
    holder.key("n").set(target);
    await write.commit();
    const tx = runtime.edit();
    const finish = startReadStats(tx);
    try {
      const view = holder.withTx(tx).asSchema<{ n: Cell<number> }>({
        type: "object",
        properties: { n: { type: "number", asCell: ["cell"] } },
      }).get();
      expect(view.n.getAsNormalizedFullLink().id).toBe(
        target.getAsNormalizedFullLink().id,
      );
    } finally {
      const reads = finish(0);
      tx.abort();
      expect(reads.linkResolutions).toBe(1);
    }
  });

  it("counts link traversal when eagerly materializing a linked value", async () => {
    const write = runtime.edit();
    const target = runtime.getCell<number>(space, "target", undefined, write);
    target.set(7);
    const holder = runtime.getCell<{ n: number }>(
      space,
      "holder",
      undefined,
      write,
    );
    holder.key("n").set(target);
    await write.commit();
    const tx = runtime.edit();
    const finish = startReadStats(tx);
    try {
      expect(
        holder.withTx(tx).asSchema<{ n: number }>({
          type: "object",
          properties: { n: { type: "number" } },
        }).get(),
      ).toEqual({ n: 7 });
    } finally {
      const reads = finish(0);
      tx.abort();
      expect(reads.linkResolutions).toBe(1);
    }
  });

  it("counts the stored link followed by lazy cell handle materialization", async () => {
    const write = runtime.edit();
    const target = runtime.getCell<number>(space, "target", undefined, write);
    target.set(7);
    const holder = runtime.getCell<{ n: number }>(
      space,
      "holder",
      undefined,
      write,
    );
    holder.key("n").set(target);
    await write.commit();
    const tx = runtime.edit();
    tx.markLazyMaterialize();
    const finish = startReadStats(tx);
    try {
      const view = holder.withTx(tx).asSchema<{ n: Cell<number> }>({
        type: "object",
        properties: { n: { type: "number", asCell: ["cell"] } },
      }).get();
      const handle = view.n;
      const targetId = target.getAsNormalizedFullLink().id;
      expect(handle.getAsNormalizedFullLink().id).toBe(targetId);
      expect(
        [...(tx.getReadActivities?.() ?? [])].filter((read) =>
          read.id === targetId && read.path[0] === "value"
        ),
      ).toEqual([]);
      expect(handle.get()).toBe(7);
      expect(
        [...(tx.getReadActivities?.() ?? [])].some((read) =>
          read.id === targetId && read.path.length === 1 &&
          read.path[0] === "value"
        ),
      ).toBe(true);
    } finally {
      const reads = finish(0);
      tx.abort();
      expect(reads.linkResolutions).toBe(1);
    }
  });

  it("rejects duplicate accounting without resetting an active measurement", async () => {
    const write = runtime.edit();
    const cell = runtime.getCell<{ n: number }>(
      space,
      "value",
      undefined,
      write,
    );
    cell.set({ n: 7 });
    await write.commit();
    const tx = runtime.edit();
    const view = cell.withTx(tx).get();
    const finish = startReadStats(tx);
    try {
      expect(view.n).toBe(7);
      expect(() => startReadStats(tx)).toThrow(
        "Read accounting is already active for this transaction",
      );
      expect(view.n).toBe(7);
    } finally {
      const reads = finish(0);
      tx.abort();
      expect(reads.proxyAccesses).toBe(2);
      expect(readStatsActive).toBe(false);
    }
  });

  it("accumulates scheduler runs without changing earlier per-run counts", async () => {
    const write = runtime.edit();
    const cell = runtime.getCell<{ n: number }[]>(
      space,
      "rows",
      rowsSchema,
      write,
    );
    cell.set([{ n: 1 }, { n: 2 }]);
    await write.commit();
    const events: RuntimeTelemetryEvent[] = [];
    runtime.telemetry.addEventListener("telemetry", (event) => {
      if (
        (event as RuntimeTelemetryEvent).marker.type ===
          "scheduler.run.complete"
      ) {
        events.push(event as RuntimeTelemetryEvent);
      }
    });
    const action: Action = (tx) => {
      tx.markLazyMaterialize();
      return cell.withTx(tx).get().reduce((sum, row) => sum + row.n, 0);
    };
    runtime.scheduler.setReadStatsEnabled(true);
    await runtime.scheduler.run(action);
    const first = runtime.scheduler.getActionStats(action)!.lastRunReads!;
    expect(first.proxyAccesses).toBe(4);
    expect(first.registeredDependencies).toBeGreaterThan(0);
    await runtime.scheduler.run(action);
    expect(runtime.scheduler.getActionStats(action)!.reads!.proxyAccesses).toBe(
      8,
    );
    expect(first.proxyAccesses).toBe(4);
    const marker = events[0].marker;
    expect(marker.type).toBe("scheduler.run.complete");
    if (marker.type === "scheduler.run.complete") {
      expect(marker.reads).toEqual(first);
    }
    runtime.scheduler.setReadStatsEnabled(false);
    await runtime.scheduler.run(action);
    expect(runtime.scheduler.getActionStats(action)!.lastRunReads)
      .toBeUndefined();
    expect(runtime.scheduler.getActionStats(action)!.reads!.proxyAccesses).toBe(
      8,
    );
  });

  it("records a failed run and releases its collector", async () => {
    const write = runtime.edit();
    const cell = runtime.getCell<{ n: number }>(
      space,
      "failed",
      undefined,
      write,
    );
    cell.set({ n: 3 });
    await write.commit();
    const errors: Error[] = [];
    runtime.scheduler.onError((error) => errors.push(error));
    runtime.scheduler.setReadStatsEnabled(true);
    const action: Action = (tx) => {
      const n = cell.withTx(tx).get().n;
      throw new Error(`Failed after reading ${n}`);
    };
    await runtime.scheduler.run(action);
    expect(errors.map((error) => error.message)).toContain(
      "Failed after reading 3",
    );
    expect(
      runtime.scheduler.getActionStats(action)!.lastRunReads!.proxyAccesses,
    ).toBe(1);
    expect(readStatsActive).toBe(false);
  });

  it("leaves the disabled read path without an active collector", async () => {
    const write = runtime.edit();
    const cell = runtime.getCell<{ n: number }>(
      space,
      "unmeasured",
      undefined,
      write,
    );
    cell.set({ n: 3 });
    await write.commit();
    const action: Action = (tx) => cell.withTx(tx).get().n;
    expect(await runtime.scheduler.run(action)).toBe(3);
    expect(readStatsActive).toBe(false);
    const stats = runtime.scheduler.getActionStats(action)!;
    expect(stats.runCount).toBe(1);
    expect(stats.reads).toBeUndefined();
  });
});
