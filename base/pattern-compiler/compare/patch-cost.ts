/**
 * Measures what a change of one member of a document of links costs in the
 * runtime's transactions and the memory server, apart from any piece: the
 * cost that an array or a record of links in one document has for a change
 * of one link, which no compiled piece removes.
 *
 * `deno run -A --no-check base/pattern-compiler/compare/patch-cost.ts [sizes]`
 *
 * For each size a runtime of its own on emulated storage holds one document
 * of that many links to other documents, as an array and as a record. Each
 * step is one transaction of the runtime with one write, timed from before
 * the write until the commit is settled and the scheduler is idle:
 *
 * - `replace`: the link at the middle position of the array is replaced.
 * - `append`: a link is appended to the array.
 * - `move`: the link at the middle is removed and put at the front, written
 *   as the array.
 * - `add`: a member is added to the record.
 *
 * Each line of JSON holds the size, the bytes of the document as JSON and
 * the median of the timed steps in milliseconds. With `--timings`, it also
 * holds the six timing statistics of the logger that took longest over the
 * steps. With `--labels`, the document is written under a schema that
 * declares a clause, so each commit runs the preparation of Contextual Flow
 * Control with stored labels.
 */
import { Identity } from "@commonfabric/identity";

import {
  getTimingStatsBreakdown,
  resetAllTimingStats,
} from "../../logger/src/logger.ts";
import type { JSONSchema } from "../../../runtime/runner/src/builder/types.ts";
import { Runtime } from "../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../runtime/runner/src/storage/cache.deno.ts";

const STEPS = 9;

const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * The timing statistics that took longest since they were reset: the name
 * of each, as its logger and its key, with its time in milliseconds.
 */
const longest = (most: number): Record<string, number> =>
  Object.fromEntries(
    Object.entries(getTimingStatsBreakdown()).flatMap(([logger, keys]) =>
      Object.entries(keys).map((
        [key, stats],
      ): [string, number] => [`${logger}/${key}`, round(stats.totalTime)])
    ).sort((a, b) => b[1] - a[1]).slice(0, most),
  );

const measure = async (size: number, labels: boolean) => {
  const signer = await Identity.fromPassphrase("pattern-compiler-compare");
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    ...(labels ? { cfcFlowLabels: "persist" as const } : {}),
  });
  const schema = labels
    ? {
      ifc: { confidentiality: [{ anyOf: [{ type: "space", id: space }] }] },
    } as unknown as JSONSchema
    : undefined;
  const commit = async (write: (tx: ReturnType<Runtime["edit"]>) => void) => {
    const tx = runtime.edit();
    write(tx);
    runtime.prepareTxForCommit(tx);
    const { error } = await tx.commit().settled;
    if (error !== undefined) throw error;
    await runtime.scheduler.idleWithPendingCommits();
  };
  const members = Array.from(
    { length: size + STEPS + 1 },
    (_, index) =>
      runtime.getCell<{ title: string }>(space, `patch-cost member ${index}`),
  );
  const list = runtime.getCell<unknown[]>(space, "patch-cost list", schema);
  const record = runtime.getCell<Record<string, unknown>>(
    space,
    "patch-cost record",
    schema,
  );
  await commit((tx) => {
    members.forEach((member, index) =>
      member.withTx(tx).set({ title: `t${index}` })
    );
    list.withTx(tx).set(members.slice(0, size));
    record.withTx(tx).set(
      Object.fromEntries(
        members.slice(0, size).map((member, index) => [`n${index}`, member]),
      ),
    );
  });
  const bytes = (() => {
    const tx = runtime.edit();
    try {
      return JSON.stringify(
        tx.readValueOrThrow({
          ...list.getAsNormalizedFullLink(),
          path: [],
        }),
      ).length;
    } finally {
      tx.abort();
    }
  })();
  const step = async (
    name: string,
    write: (tx: ReturnType<Runtime["edit"]>, turn: number) => void,
  ) => {
    const times: number[] = [];
    resetAllTimingStats();
    for (let turn = 0; turn < STEPS; turn++) {
      const began = performance.now();
      await commit((tx) => write(tx, turn));
      times.push(performance.now() - began);
    }
    console.log(JSON.stringify({
      step: name,
      labels,
      size,
      bytes,
      ms: round(median(times)),
      ...(Deno.args.includes("--timings")
        ? { [`longest timings of the ${STEPS} steps, ms`]: longest(6) }
        : {}),
    }));
  };
  const middle = Math.floor(size / 2);
  await step(
    "replace",
    (tx, turn) => list.withTx(tx).key(middle).set(members[size + turn]),
  );
  await step(
    "append",
    (tx, turn) => list.withTx(tx).push(members[size + turn]),
  );
  await step("move", (tx) => {
    const held = [...(list.withTx(tx).getRaw() as unknown[])];
    const [moved] = held.splice(middle, 1);
    list.withTx(tx).setRaw([moved, ...held]);
  });
  await step(
    "add",
    (tx, turn) =>
      record.withTx(tx).key(`added${turn}`).set(members[size + turn]),
  );
  await runtime.dispose();
  await storageManager.close();
};

if (import.meta.main) {
  const labels = Deno.args.includes("--labels");
  const sizes = Deno.args.filter((arg) => /^\d+$/.test(arg)).map(Number);
  for (const size of sizes.length > 0 ? sizes : [1000, 2000, 4000, 8000]) {
    await measure(size, labels);
  }
}
