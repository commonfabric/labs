/** Builds matched compiled aggregate and full-reduce workloads over linked rows. */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { Runtime } from "../src/runtime.ts";
import { RuntimeTelemetryEvent } from "../src/telemetry.ts";

/** Named workloads; count uses a predicate so a field edit changes its result. */
export type AggregateWorkload =
  | "count"
  | "sum"
  | "min"
  | "max"
  | "minBy"
  | "maxBy";

const signer = await Identity.fromPassphrase("aggregate-comparison");
const nativeExpressions: Record<AggregateWorkload, string> = {
  count: "items.get().reduce((count, item) => count + (item.n > 0 ? 1 : 0), 0)",
  sum: "numbers.get().reduce((sum, n) => sum + n, 0)",
  min: "numbers.get().reduce((minimum, n) => Math.min(minimum, n), Infinity)",
  max: "numbers.get().reduce((maximum, n) => Math.max(maximum, n), -Infinity)",
  minBy:
    "items.get().reduce<{n: number} | undefined>((best, item) => best === undefined || item.n < best.n ? item : best, undefined)",
  maxBy:
    "items.get().reduce<{n: number} | undefined>((best, item) => best === undefined || item.n > best.n ? item : best, undefined)",
};
const incrementalExpressions: Record<AggregateWorkload, string> = {
  count: "items.count(item => item.n > 0)",
  sum: "numbers.sum()",
  min: "numbers.min()",
  max: "numbers.max()",
  minBy: "items.minBy(item => item.n)",
  maxBy: "items.maxBy(item => item.n)",
};

/** Creates and settles a fresh graph, with explicit cleanup for every invocation. */
export async function createAggregateFixture(
  operation: AggregateWorkload,
  size: number,
  generic: boolean,
  collectReads = false,
) {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  runtime.scheduler.setReadStatsEnabled(collectReads);
  const reads = {
    runs: 0,
    proxyAccesses: 0,
    linkResolutions: 0,
    distinctDocuments: 0,
    registeredDependencies: 0,
  };
  if (collectReads) {
    runtime.telemetry.addEventListener("telemetry", (event) => {
      const marker = (event as RuntimeTelemetryEvent).marker;
      if (marker.type !== "scheduler.run.complete") return;
      reads.runs++;
      for (
        const key of [
          "proxyAccesses",
          "linkResolutions",
          "distinctDocuments",
          "registeredDependencies",
        ] as const
      ) reads[key] += marker.reads?.[key] ?? 0;
    });
  }
  let cancel: (() => void) | undefined;
  const dispose = async () => {
    cancel?.();
    await storageManager.synced();
    await runtime.dispose();
    await storageManager.close();
  };
  try {
    const expression = generic
      ? `computed(() => ${nativeExpressions[operation]})`
      : incrementalExpressions[operation];
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
        import { pattern, computed, Writable } from "commonfabric";
        export default pattern<{
          items: Writable<{n: number}[]>; numbers: Writable<number[]>;
        }>(({items, numbers}) => ({ value: ${expression} }));
      `,
      }],
    });
    const tx = runtime.edit();
    const rows = Array.from({ length: size }, (_, n) => {
      const row = runtime.getCell<{ n: number }>(
        signer.did(),
        { row: n },
        undefined,
        tx,
      );
      row.set({ n });
      return row;
    });
    const items = runtime.getCell<{ n: number }[]>(
      signer.did(),
      "items",
      undefined,
      tx,
    );
    items.set(rows);
    const numbers = runtime.getCell<number[]>(
      signer.did(),
      "numbers",
      undefined,
      tx,
    );
    numbers.set(rows.map((row) => row.key("n")));
    const output = runtime.getCell<
      { value: number | { n: number } | undefined }
    >(signer.did(), "output", compiled.resultSchema, tx);
    const initializationStart = performance.now();
    const result = runtime.run(tx, compiled, { items, numbers }, output);
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    cancel = result.sink(() => {});
    await runtime.idle();
    await result.key("value").pull();
    const initialization = {
      ms: performance.now() - initializationStart,
      ...reads,
    };
    let iteration = 0;
    const update = async () => {
      iteration++;
      const value = operation === "count"
        ? (iteration % 2 ? 1 : -1)
        : operation === "min" || operation === "minBy"
        ? (iteration % 2 ? -iteration : size + iteration)
        : operation === "max" || operation === "maxBy"
        ? (iteration % 2 ? size + iteration : -iteration)
        : size + iteration;
      const edit = runtime.edit();
      rows[0].withTx(edit).key("n").set(value);
      await edit.commit().settled;
      await runtime.idle();
      const actual = await result.key("value").pull();
      const expected = operation === "count"
        ? size - 1 + (value > 0 ? 1 : 0)
        : operation === "sum"
        ? size * (size - 1) / 2 + value
        : operation === "min" || operation === "minBy"
        ? Math.min(value, 1)
        : operation === "max" || operation === "maxBy"
        ? Math.max(value, size - 1)
        : value;
      if ((typeof actual === "object" ? actual?.n : actual) !== expected) {
        throw new Error(`Incorrect ${operation} result after update`);
      }
    };
    return { runtime, result, update, dispose, initialization, reads };
  } catch (error) {
    await dispose();
    throw error;
  }
}
