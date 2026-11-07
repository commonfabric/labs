/**
 * What a read costs against a serving worker. Serves a fresh board from a
 * `ServingWorker` the way a toolshed does, creates `<topics>` Topics through
 * the board's `addTopic` verb, and then reads the way `cf cell get` does, each
 * read from a client of its own that connects, reads, and leaves: the board's
 * `index`, which lists every Topic, twice, and then `<reads>` Topics spread
 * over the board, each twice. Every read reports the client's wall time and
 * the process's CPU time, the frames and documents the client received, the
 * waves and derived commits the worker ran, and the worker's heap after a
 * collection once the client has left.
 *
 *   CF_MEMORY_FRAME_LOG=<outdir>/frames.jsonl deno run -A --config deno.jsonc \
 *     --v8-flags=--expose-gc \
 *     skills/perf-investigation/scripts/read-worker-probe.ts <topics> <reads> <outdir> [path...]
 *
 * `[path...]` is the path read inside each Topic, the whole result when
 * absent. The board's root is the loop's demand, as `cf piece new` makes it;
 * `PROBE_START=0` creates it without. `PROBE_CONCURRENCY=<n>` sends that many
 * creates at once, and `PROBE_RESTART=1` replaces the worker after the creates,
 * so the reads meet a worker that holds nothing. `PROBE_TIMINGS=<rows>` prints,
 * after each read, the worker's timing statistics that grew most during it.
 * Without `CF_MEMORY_FRAME_LOG` the frame columns read zero. Run from the
 * repository root.
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
import { getCellValue } from "../../../runtime/cli/lib/piece.ts";
import { newLoopbackServer } from "../../../runtime/runner/src/storage/v2-emulate.ts";

const root = fromFileUrl(new URL("../../../", import.meta.url)).replace(
  /\/$/,
  "",
);
const [topicsArgument, readsArgument, outDir, ...topicPath] = Deno.args;
const topics = Number(topicsArgument);
const reads = Number(readsArgument);
if (
  !Number.isInteger(topics) || topics <= 0 || !Number.isInteger(reads) ||
  reads < 0 || reads > topics || outDir === undefined
) {
  console.error(
    "usage: read-worker-probe.ts <topics> <reads> <outdir> [path...]",
  );
  Deno.exit(2);
}
const start = Deno.env.get("PROBE_START") !== "0";
const restart = Deno.env.get("PROBE_RESTART") === "1";
const timingRows = Number(Deno.env.get("PROBE_TIMINGS") ?? "0");
const concurrency = Number(Deno.env.get("PROBE_CONCURRENCY") ?? "1");
if (!Number.isInteger(concurrency) || concurrency <= 0) {
  console.error(`PROBE_CONCURRENCY takes a positive count, not ${concurrency}`);
  Deno.exit(2);
}
await Deno.mkdir(outDir, { recursive: true });
// This isolate's memory client read the variable when it loaded. The worker
// reads it when it starts, and its frames are not a client's.
const frameLog = Deno.env.get("CF_MEMORY_FRAME_LOG");
Deno.env.delete("CF_MEMORY_FRAME_LOG");

const serviceSigner = await Identity.fromPassphrase(
  "read worker probe service",
);
const userSigner = await Identity.fromPassphrase("read worker probe user");
const space = userSigner.did() as MemorySpace;

const storeDir = await Deno.makeTempDir({ prefix: "read-worker-probe-" });
const server = newLoopbackServer({
  store: toFileUrl(`${storeDir}/`),
  delegatingDids: [serviceSigner.did()],
});
const newWorker = () =>
  new ServingWorker({
    server,
    identity: serviceSigner,
    apiUrl: new URL(import.meta.url),
    policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    workerModule: new URL("./heap-worker-module.ts", import.meta.url),
  });
let worker = newWorker();
await worker.ready;
const session = createSession({
  identity: serviceSigner,
  spaceDid: space as DID,
});

type Client = {
  pieces: PiecesController;
  runtime: Runtime;
  dispose: () => Promise<void>;
};
const connect = async (): Promise<Client> => {
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
  return {
    pieces,
    runtime,
    dispose: async () => {
      await runtime.dispose();
      await manager.close();
    },
  };
};

const setup = await connect();
const program: RuntimeProgram = await resolveLocalProgram(
  (resolver) => setup.runtime.harness.resolve(resolver),
  { main: `${root}/patterns/apps/topics/main.tsx`, root },
);
const created = await worker.runLifecycleVerb(space, {
  name: "instantiate",
  request: { source: { program }, actingUser: userSigner.did(), start },
});
const boardId = (created.receipt as { pieceId: string }).pieceId;
console.log("board", boardId, start ? "demanded" : "not demanded");

const board = setup.pieces.getResult(
  await setup.pieces.getPieceCell(boardId, { reconcile: false, start: false }),
);
const addTopic = board.key("addTopic" as never)
  .asSchemaFromLinks() as Cell<unknown>;
let count = 0;
const addOne = async () => {
  const index = ++count;
  const sent = await sendVerbEvent(addTopic, {
    title: `Probe topic ${index}`,
    body: "Filed by the read probe.",
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
const createStarted = performance.now();
for (let sent = 0; sent < topics; sent += concurrency) {
  const batch = Math.min(concurrency, topics - sent);
  await Promise.all(Array.from({ length: batch }, addOne));
}
console.log(
  "created",
  topics,
  "topics in",
  ((performance.now() - createStarted) / 1000).toFixed(1),
  "s",
);
await setup.dispose();

if (restart) {
  await worker.close();
  worker = newWorker();
  await worker.ready;
  console.log("worker replaced");
}

/** The frames the client received since the last call, from the frame log. */
let frameLogOffset = 0;
const framesReceived = async () => {
  const tally = { frames: 0, bytes: 0, documents: 0, documentBytes: 0 };
  if (frameLog === undefined) return tally;
  const text = await Deno.readTextFile(frameLog);
  const lines = text.slice(frameLogOffset).split("\n").filter(Boolean);
  frameLogOffset = text.length;
  for (const line of lines) {
    const record = JSON.parse(line) as {
      dir?: string;
      bytes?: number;
      sync?: { upserts?: { bytes?: number }[] };
      entities?: { bytes?: number }[];
    };
    if (record.dir !== "in") continue;
    tally.frames++;
    tally.bytes += record.bytes ?? 0;
    for (
      const doc of [...record.sync?.upserts ?? [], ...record.entities ?? []]
    ) {
      tally.documents++;
      tally.documentBytes += doc.bytes ?? 0;
    }
  }
  return tally;
};

/** The worker's time per logger key, in milliseconds, and its span count. */
const workerTimings = async () => {
  const totals = new Map<string, { ms: number; count: number }>();
  if (timingRows === 0) return totals;
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

const workerHeap = async () => (await worker.collectedMemory()).heapUsed;
const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};
const kb = (bytes: number) => Math.round(bytes / 1000);

let heapBefore = await workerHeap();
await framesReceived();

/**
 * One read as `cf cell get <piece> <path>` makes it, from a client that
 * connects for it and leaves after, and a line saying what it cost. `inspect`
 * runs while the client is connected, outside what the line counts as CPU.
 */
const read = async (
  label: string,
  piece: string,
  path: (string | number)[],
  inspect?: (client: Client, value: unknown) => Promise<void>,
) => {
  const timingsBefore = await workerTimings();
  const statsBefore = await worker.requestStats();
  const cpuBefore = cpuMs();
  const started = performance.now();
  const client = await connect();
  const connected = performance.now();
  const value = await getCellValue(
    { apiUrl: import.meta.url, space, identity: "", piece },
    path,
    {},
    { loadPieces: () => Promise.resolve(client.pieces) },
  );
  // What `cf` prints, written while the client that read it is connected.
  const valueBytes = JSON.stringify(value)?.length ?? 0;
  const done = performance.now();
  const inspectStarted = cpuMs();
  await inspect?.(client, value);
  const inspecting = cpuMs() - inspectStarted;
  await client.dispose();
  const cpu = cpuMs() - cpuBefore - inspecting;
  const statsAfter = await worker.requestStats();
  const frames = await framesReceived();
  const heapAfter = await workerHeap();
  console.log(JSON.stringify({
    read: label,
    connectMs: Math.round(connected - started),
    readMs: Math.round(done - connected),
    processCpuMs: Math.round(cpu),
    valueKb: kb(valueBytes),
    framesIn: frames.frames,
    framesInKb: kb(frames.bytes),
    documents: frames.documents,
    documentsKb: kb(frames.documentBytes),
    waves: statsAfter.waves - statsBefore.waves,
    derivedCommits: statsAfter.derivedCommits - statsBefore.derivedCommits,
    workerHeapMb: Number((heapAfter / 1e6).toFixed(1)),
    workerHeapGrowthKb: kb(heapAfter - heapBefore),
    load: Deno.loadavg()[0].toFixed(0),
  }));
  heapBefore = heapAfter;
  const grew = [...await workerTimings()].map(([key, after]) => {
    const before = timingsBefore.get(key) ?? { ms: 0, count: 0 };
    return { key, ms: after.ms - before.ms, count: after.count - before.count };
  }).sort((a, b) => b.ms - a.ms).slice(0, timingRows);
  for (const row of grew) {
    console.log(
      "  worker",
      `${Math.round(row.ms)} ms`.padStart(9),
      String(row.count).padStart(7),
      row.key,
    );
  }
};

console.log(
  "worker heap",
  (heapBefore / 1e6).toFixed(1),
  "MB after the creates",
);

// The Topics to read, spread over the board, named by the pieces the index's
// rows link.
const topicIds: string[] = [];
await read("index", boardId, ["index"], async (client, value) => {
  const rows = Array.isArray(value) ? value.length : 0;
  if (rows !== topics) {
    throw new Error(`The index lists ${rows} Topics, not ${topics}`);
  }
  const index = client.pieces.getResult(
    await client.pieces.getPieceCell(boardId, {
      reconcile: false,
      start: false,
    }),
  ).key("index" as never).asSchemaFromLinks() as Cell<unknown[]>;
  for (let picked = 0; picked < reads; picked++) {
    const at = Math.floor((picked + 0.5) * topics / reads);
    const row = index.key(at).resolveAsCell();
    topicIds.push(row.getAsNormalizedFullLink().id);
  }
});
await read("index again", boardId, ["index"]);
for (const [at, id] of topicIds.entries()) {
  await read(`topic ${at + 1}`, id, topicPath);
}
for (const [at, id] of topicIds.entries()) {
  await read(`topic ${at + 1} again`, id, topicPath);
}
await read("index after the Topics", boardId, ["index"]);

await worker.close();
await server.close();
await Deno.remove(storeDir, { recursive: true });
Deno.exit(0);
