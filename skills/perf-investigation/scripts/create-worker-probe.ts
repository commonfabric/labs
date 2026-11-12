/**
 * What a create costs a serving worker as its board grows. Serves a fresh
 * board from a `ServingWorker` the way a toolshed does, and for each of the
 * given board sizes, in ascending order, creates Topics through the board's
 * `addTopic` verb until the board holds that many and then has the worker
 * profile its own CPU over `<creates>` more. Each size reports the wall time
 * and the process's CPU time per create, the worker's timing statistics that
 * grew most, and writes
 * `<outdir>/creates-at-<size>.cpuprofile`, which Chrome DevTools and
 * speedscope load.
 *
 *   deno run -A --config deno.jsonc --v8-flags=--expose-gc \
 *     skills/perf-investigation/scripts/create-worker-probe.ts <creates> <outdir> <size>...
 *
 * The board's root is the loop's demand, as `cf piece new` makes it;
 * `PROBE_START=0` creates it without. `PROBE_CONCURRENCY=<n>` sends that many
 * creates at once. Run from the repository root.
 */

// deno-lint-ignore no-external-import -- Deno reads a process's CPU time through this Node builtin alone.
import process from "node:process";
import { fromFileUrl, toFileUrl } from "@std/path";
import { createSession, Identity } from "@commonfabric/identity";
import type { DID, MemorySpace } from "@commonfabric/memory/interface";
import { type Cell, Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { ServingWorker } from "@commonfabric/runner/executor/serving-worker-host";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "@commonfabric/piece/ops";
import { sendVerbEvent } from "@commonfabric/piece/verb-call";
import { newLoopbackServer } from "../../../runtime/runner/src/storage/v2-emulate.ts";

const root = fromFileUrl(new URL("../../../", import.meta.url)).replace(
  /\/$/,
  "",
);
const [createsArgument, outDir, ...sizeArguments] = Deno.args;
const creates = Number(createsArgument);
const sizes = sizeArguments.map(Number);
if (
  !Number.isInteger(creates) || creates <= 0 || outDir === undefined ||
  sizes.length === 0 ||
  sizes.some((size, at) =>
    !Number.isInteger(size) || size < 0 ||
    (at > 0 && size < sizes[at - 1] + creates)
  )
) {
  console.error(
    "usage: create-worker-probe.ts <creates> <outdir> <size>...\n" +
      "sizes ascend, each at least <creates> past the one before",
  );
  Deno.exit(2);
}
const start = Deno.env.get("PROBE_START") !== "0";
const concurrency = Number(Deno.env.get("PROBE_CONCURRENCY") ?? "1");
if (!Number.isInteger(concurrency) || concurrency <= 0) {
  console.error(`PROBE_CONCURRENCY takes a positive count, not ${concurrency}`);
  Deno.exit(2);
}
const timingRows = 16;
await Deno.mkdir(outDir, { recursive: true });
// The worker reads this when it starts, so it is set before the worker is.
Deno.env.set("HEAP_PROBE_DIR", outDir);

const serviceSigner = await Identity.fromPassphrase(
  "create worker probe service",
);
const userSigner = await Identity.fromPassphrase("create worker probe user");
const space = userSigner.did() as MemorySpace;

const storeDir = await Deno.makeTempDir({ prefix: "create-worker-probe-" });
const server = newLoopbackServer({
  store: toFileUrl(`${storeDir}/`),
  delegatingDids: [serviceSigner.did()],
});
const worker = new ServingWorker({
  server,
  identity: serviceSigner,
  apiUrl: new URL(import.meta.url),
  policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
  workerModule: new URL("./heap-worker-module.ts", import.meta.url),
});
await worker.ready;
const session = createSession({
  identity: serviceSigner,
  spaceDid: space as DID,
});
const manager = EmulatedStorageManager.connectTo(server, { as: userSigner });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager: manager,
  experimental: { serverExecution: true },
});
const pieces = new PiecesController(session, runtime, {
  deferSpaceCellSync: true,
});
await pieces.ready;

const program: RuntimeProgram = await resolveLocalProgram(
  (resolver) => runtime.harness.resolve(resolver),
  { main: `${root}/patterns/apps/topics/main.tsx`, root },
);
const created = await worker.runLifecycleVerb(space, {
  name: "instantiate",
  request: { source: { program }, actingUser: userSigner.did(), start },
});
const boardId = (created.receipt as { pieceId: string }).pieceId;
console.log("board", boardId, start ? "demanded" : "not demanded");

const board = pieces.getResult(
  await pieces.getPieceCell(boardId, { reconcile: false, start: false }),
);
const addTopic = board.key("addTopic" as never)
  .asSchemaFromLinks() as Cell<unknown>;
let count = 0;
const addOne = async () => {
  const index = ++count;
  const sent = await sendVerbEvent(addTopic, {
    title: `Probe topic ${index}`,
    body: "Filed by the create probe.",
    agentName: "Claude",
  }, { invocation: { id: `probe-${index}`, session: "probe" }, echo: false });
  if (sent.status !== "committed") {
    throw new Error(`send failed: ${sent.error.message}`);
  }
  const handled = await sent.handled();
  if (handled.status !== "handled") {
    throw new Error(`not handled: ${JSON.stringify(handled)}`);
  }
};
const addTopics = async (total: number) => {
  for (let sent = 0; sent < total; sent += concurrency) {
    const batch = Math.min(concurrency, total - sent);
    await Promise.all(Array.from({ length: batch }, addOne));
  }
};

/** Writes `request` for the worker and resolves once it has written `done`. */
const asked = async (request: string, body: string, done: string) => {
  const watcher = Deno.watchFs(outDir);
  await Deno.writeTextFile(`${outDir}/${request}`, body);
  try {
    for await (const event of watcher) {
      if (event.paths.some((path) => path.endsWith(done))) return;
    }
  } finally {
    watcher.close();
  }
};

/** The worker's time per logger key, in milliseconds, and its span count. */
const workerTimings = async () => {
  const totals = new Map<string, { ms: number; count: number }>();
  const { timingStats } = await worker.diagnostics();
  for (const [logger, keys] of Object.entries(timingStats)) {
    for (const [key, stats] of Object.entries(keys)) {
      totals.set(`${logger}/${key}`, {
        ms: stats.totalTime,
        count: stats.count,
      });
    }
  }
  return totals;
};

for (const size of sizes) {
  const building = performance.now();
  await addTopics(size - count);
  console.log(
    "board at",
    count,
    "after",
    ((performance.now() - building) / 1000).toFixed(1),
    "s, load",
    Deno.loadavg()[0].toFixed(0),
  );
  const timingsBefore = await workerTimings();
  const statsBefore = await worker.requestStats();
  const profile = `creates-at-${size}.cpuprofile`;
  await asked("prof.start", "", "prof.start.done");
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  await addTopics(creates);
  const elapsed = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  await asked("prof.stop", `${outDir}/${profile}`, `${profile}.done`);
  const statsAfter = await worker.requestStats();
  console.log(JSON.stringify({
    boardBefore: size,
    creates,
    msPerCreate: Math.round(elapsed / creates),
    processCpuMsPerCreate: Math.round(
      (cpu.user + cpu.system) / 1000 / creates,
    ),
    waves: statsAfter.waves - statsBefore.waves,
    derivedCommits: statsAfter.derivedCommits - statsBefore.derivedCommits,
    workerHeapMb: Number(
      ((await worker.collectedMemory()).heapUsed / 1e6).toFixed(1),
    ),
    load: Deno.loadavg()[0].toFixed(0),
  }));
  const grew = [...await workerTimings()].map(([key, after]) => {
    const before = timingsBefore.get(key) ?? { ms: 0, count: 0 };
    return { key, ms: after.ms - before.ms, count: after.count - before.count };
  }).sort((a, b) => b.ms - a.ms).slice(0, timingRows);
  for (const row of grew) {
    console.log(
      "  worker",
      `${Math.round(row.ms)} ms`.padStart(10),
      String(row.count).padStart(7),
      row.key,
    );
  }
}

await runtime.dispose();
await manager.close();
await worker.close();
await server.close();
await Deno.remove(storeDir, { recursive: true });
Deno.exit(0);
