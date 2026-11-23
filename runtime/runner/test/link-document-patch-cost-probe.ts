/**
 * Measures what a change of one link costs in a document that holds many
 * links, with no pattern running: the cost the runtime's transactions, the
 * storage client and the memory server have for one written path of a large
 * document.
 *
 *   deno run -A --no-check \
 *     runtime/runner/test/link-document-patch-cost-probe.ts \
 *     [sizes] [--storage=emulated|socket] [--labels] [--typed] [--timings] \
 *     [--cpu-profile=<directory>] [--no-own-write-echo]
 *
 * For each size a runtime of its own holds one document of that many links to
 * other documents, once as an array and once as a record. Each step is one
 * transaction with one write, timed from before the write until the commit
 * has settled and the scheduler is idle. Each step runs one such transaction
 * untimed before the timed ones:
 *
 * - `replace`: the link at the middle position of the array is replaced.
 * - `append`: a link is appended to the array.
 * - `move`: the link at the middle is removed and put at the front, written
 *   as the whole array.
 * - `add`: a member is added to the record.
 *
 * `--storage=emulated` (the default) uses the loopback memory server of
 * `StorageManager.emulate()`. `--storage=socket` starts a
 * `StandaloneMemoryServer` in this process and connects to it over a
 * WebSocket, so the figures include encoding and decoding of every frame.
 *
 * With `--labels`, the documents are written under a schema that declares a
 * confidentiality clause and the runtime persists flow labels, so each commit
 * runs the preparation of Contextual Flow Control with stored labels. That
 * schema declares no type, so the memory server's watch of each document
 * follows every link it holds without a schema to narrow the walk.
 *
 * With `--typed`, the schema declares the array's items and the record's
 * members as objects with a `title`, as a pattern's list of pieces does, so
 * the watch follows each link under the member's schema.
 *
 * Each line of JSON on stdout holds the step, the size, the bytes of the
 * array document as JSON, and the median, minimum and maximum of the timed
 * steps in milliseconds. With `--timings`, it also holds the logger's timing
 * statistics that took longest over the steps. With `--cpu-profile`, each
 * step writes a V8 CPU profile into the named directory.
 *
 * With `--no-own-write-echo`, the memory server leaves the document a
 * session's own patch produced out of that session's sync frame
 * (`setOwnWriteEchoConfig(false)`), which shows what the echo of the whole
 * document to its writer costs.
 */

import { Session } from "@node/inspector";

import { maxOf, minOf } from "@commonfabric/collections/math";
import { Identity } from "@commonfabric/identity";
import {
  getTimingStatsBreakdown,
  resetAllTimingStats,
} from "@commonfabric/logger";
import { setOwnWriteEchoConfig } from "@commonfabric/memory/v2";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";

import type { JSONSchema } from "../src/builder/types.ts";
import { namesInstancesByDefault } from "../src/builder/instance-name.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

/** How many timed transactions each step runs. */
const STEPS = 9;

const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * The timing statistics that took longest since they were reset, each named
 * by its logger and its key, with its total time in milliseconds and its
 * count.
 */
const longest = (most: number): Record<string, string> =>
  Object.fromEntries(
    Object.entries(getTimingStatsBreakdown()).flatMap(([logger, keys]) =>
      Object.entries(keys).map((
        [key, stats],
      ): [string, number, number] => [
        `${logger}/${key}`,
        stats.totalTime,
        stats.count,
      ])
    ).sort((a, b) => b[1] - a[1]).slice(0, most).map((
      [name, total, count],
    ) => [name, `${round(total)} ms / ${count}`]),
  );

/** Runs `body` under the V8 sampling profiler and writes the profile. */
const profiled = async (
  path: string | undefined,
  body: () => Promise<void>,
): Promise<void> => {
  if (path === undefined) return await body();
  const session = new Session();
  session.connect();
  const post = (method: string, params?: object): Promise<unknown> =>
    new Promise((resolve, reject) =>
      session.post(
        method,
        params,
        (error: Error | null, result: unknown) =>
          error ? reject(error) : resolve(result),
      )
    );
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: 100 });
  await post("Profiler.start");
  await body();
  const { profile } = await post("Profiler.stop") as { profile: unknown };
  await Deno.writeTextFile(path, JSON.stringify(profile));
  session.disconnect();
};

type Storage = "emulated" | "socket";

const measure = async (
  size: number,
  options: {
    labels: boolean;
    typed: boolean;
    storage: Storage;
    timings: boolean;
    profileDirectory: string | undefined;
  },
) => {
  const { labels, storage } = options;
  const signer = await Identity.fromPassphrase("link document patch cost");
  const space = signer.did();
  const server = storage === "socket"
    ? StandaloneMemoryServer.start({ namesInstances: namesInstancesByDefault })
    : undefined;
  const storageManager = server === undefined
    ? StorageManager.emulate({ as: signer })
    : StorageManager.open({ as: signer, memoryHost: server.url });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    ...(labels ? { cfcFlowLabels: "persist" as const } : {}),
  });
  const ifc = labels
    ? { ifc: { confidentiality: [{ anyOf: [{ type: "space", id: space }] }] } }
    : {};
  const member = {
    type: "object",
    properties: { title: { type: "string" } },
  };
  const schemas = (labels || options.typed)
    ? {
      list: {
        ...(options.typed ? { type: "array", items: member } : {}),
        ...ifc,
      } as unknown as JSONSchema,
      record: {
        ...(options.typed
          ? { type: "object", additionalProperties: member }
          : {}),
        ...ifc,
      } as unknown as JSONSchema,
    }
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
  const list = runtime.getCell<unknown[]>(
    space,
    "patch-cost list",
    schemas?.list,
  );
  const record = runtime.getCell<Record<string, unknown>>(
    space,
    "patch-cost record",
    schemas?.record,
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
        tx.readValueOrThrow({ ...list.getAsNormalizedFullLink(), path: [] }),
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
    // One untimed turn first: the first change of a kind can open watches
    // that the later ones of that kind find open.
    await commit((tx) => write(tx, STEPS));
    resetAllTimingStats();
    await profiled(
      options.profileDirectory === undefined
        ? undefined
        : `${options.profileDirectory}/${storage}-${
          labels ? "labels" : "plain"
        }${options.typed ? "-typed" : ""}-${size}-${name}.cpuprofile`,
      async () => {
        for (let turn = 0; turn < STEPS; turn++) {
          const began = performance.now();
          await commit((tx) => write(tx, turn));
          times.push(performance.now() - began);
        }
      },
    );
    console.log(JSON.stringify({
      step: name,
      storage,
      labels,
      typed: options.typed,
      size,
      bytes,
      ms: round(median(times)),
      min: round(minOf(times)),
      max: round(maxOf(times)),
      ...(options.timings ? { longest: longest(8) } : {}),
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
  let order = members.slice(0, size + STEPS + 1);
  await step("move", (tx) => {
    const [moved] = order.splice(middle, 1);
    order = [moved, ...order];
    list.withTx(tx).set(order);
  });
  await step(
    "add",
    (tx, turn) =>
      record.withTx(tx).key(`added${turn}`).set(members[size + turn]),
  );
  await runtime.dispose();
  await storageManager.close();
  await server?.close();
};

if (import.meta.main) {
  const flag = (name: string): string | undefined =>
    Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.slice(
      name.length + 3,
    );
  const storage = flag("storage") ?? "emulated";
  if (storage !== "emulated" && storage !== "socket") {
    throw new Error(`Unknown storage \`${storage}\`.`);
  }
  if (Deno.args.includes("--no-own-write-echo")) setOwnWriteEchoConfig(false);
  const sizes = Deno.args.filter((arg) => /^\d+$/.test(arg)).map(Number);
  for (const size of sizes.length > 0 ? sizes : [1000, 2000, 4000, 8000]) {
    await measure(size, {
      labels: Deno.args.includes("--labels"),
      typed: Deno.args.includes("--typed"),
      storage,
      timings: Deno.args.includes("--timings"),
      profileDirectory: flag("cpu-profile"),
    });
  }
}
