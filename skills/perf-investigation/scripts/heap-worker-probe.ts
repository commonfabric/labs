/**
 * What a create leaves on a serving worker's heap. Serves a fresh board from a
 * `ServingWorkerPool` the way a toolshed does, creates Topics through the board's
 * `addTopic` verb, and has the worker write its own heap snapshot after the
 * first `<first>` creates and again after `<more>` more. The growth between
 * the two, divided by `<more>`, is what one create leaves; `heap-retained.ts`
 * and `heap-removal.ts` beside this say what holds it.
 *
 *   deno run -A --config deno.jsonc --v8-flags=--expose-gc \
 *     skills/perf-investigation/scripts/heap-worker-probe.ts <first> <more> <outdir> [pattern]
 *
 * The board's root is the loop's demand, as `cf piece new` makes it;
 * `PROBE_START=0` creates it without. `PROBE_CONCURRENCY=<n>` sends that many
 * creates at once, and `DISPOSE_CLIENT=1` disconnects the client before each
 * snapshot, as a client that leaves does. Run from the repository root.
 */

import { fromFileUrl, toFileUrl } from "@std/path";
import { createSession, Identity } from "@commonfabric/identity";
import type { DID, MemorySpace } from "@commonfabric/memory/interface";
import { type Cell, Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { ServingWorkerPool } from "@commonfabric/runner/executor/serving-worker-host";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "@commonfabric/piece/ops";
import { sendVerbEvent } from "@commonfabric/piece/verb-call";
import { newLoopbackServer } from "../../../runtime/runner/src/storage/v2-emulate.ts";

const root = fromFileUrl(new URL("../../../", import.meta.url)).replace(
  /\/$/,
  "",
);
const [firstArgument, moreArgument, outDir, patternArgument] = Deno.args;
const first = Number(firstArgument);
const more = Number(moreArgument);
if (
  !Number.isInteger(first) || first < 0 || !Number.isInteger(more) ||
  more <= 0 || outDir === undefined
) {
  console.error(
    "usage: heap-worker-probe.ts <first> <more> <outdir> [pattern]",
  );
  Deno.exit(2);
}
const pattern = patternArgument ?? `${root}/patterns/apps/topics/main.tsx`;
const start = Deno.env.get("PROBE_START") !== "0";
const concurrency = Number(Deno.env.get("PROBE_CONCURRENCY") ?? "1");
if (!Number.isInteger(concurrency) || concurrency <= 0) {
  console.error(`PROBE_CONCURRENCY takes a positive count, not ${concurrency}`);
  Deno.exit(2);
}
const disposeClient = Deno.env.get("DISPOSE_CLIENT") === "1";
await Deno.mkdir(outDir, { recursive: true });
// The worker reads this when it starts, so it is set before the worker is.
Deno.env.set("HEAP_PROBE_DIR", outDir);

const serviceSigner = await Identity.fromPassphrase(
  "heap worker probe service",
);
const userSigner = await Identity.fromPassphrase("heap worker probe user");
const space = userSigner.did() as MemorySpace;

const storeDir = await Deno.makeTempDir({ prefix: "heap-worker-probe-" });
const server = newLoopbackServer({
  store: toFileUrl(`${storeDir}/`),
  delegatingDids: [serviceSigner.did()],
});
const worker = new ServingWorkerPool({
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

let client = await connect();
const program: RuntimeProgram = await resolveLocalProgram(
  (resolver) => client.runtime.harness.resolve(resolver),
  { main: pattern, root },
);
const created = await worker.runLifecycleVerb(space, {
  name: "instantiate",
  request: {
    source: { program },
    actingUser: userSigner.did(),
    start,
  },
});
const pieceId = (created.receipt as { pieceId: string }).pieceId;
console.log("board", pieceId, start ? "demanded" : "not demanded");

const addTopicOf = async (c: Client): Promise<Cell<unknown>> => {
  const board = c.pieces.getResult(
    await c.pieces.getPieceCell(pieceId, { reconcile: false, start: false }),
  );
  return board.key("addTopic" as never).asSchemaFromLinks() as Cell<unknown>;
};

let count = 0;
let stream: Cell<unknown> | undefined;
const addOne = async (stream: Cell<unknown>) => {
  const index = ++count;
  const sent = await sendVerbEvent(stream, {
    title: `Probe topic ${index}`,
    body: "Filed by the heap probe.",
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
  stream ??= await addTopicOf(client);
  for (let sent = 0; sent < total; sent += concurrency) {
    const batch = Math.min(concurrency, total - sent);
    await Promise.all(Array.from({ length: batch }, () => addOne(stream!)));
  }
};

/** Resolves with the worker's heap size once it has written `<out>.done`. */
const workerSnapshot = async (out: string): Promise<number> => {
  const done = `${out}.done`;
  const watcher = Deno.watchFs(outDir);
  await Deno.writeTextFile(`${outDir}/snap.req`, out);
  try {
    for await (const event of watcher) {
      if (!event.paths.includes(done)) continue;
      // The worker renames the file into place, so it arrives whole.
      const heapUsed = await Deno.readTextFile(done);
      if (!/^\d+$/.test(heapUsed)) {
        throw new Error(`${done} holds "${heapUsed}", not a heap size`);
      }
      return Number(heapUsed);
    }
  } finally {
    watcher.close();
  }
  throw new Error("The worker wrote no snapshot");
};

const snapshot = async (name: string) => {
  if (disposeClient) {
    await client.dispose();
    stream = undefined;
  }
  const collected = await worker.collectedMemory();
  const heapUsed = await workerSnapshot(`${outDir}/${name}.heapsnapshot`);
  console.log(
    name,
    "topics",
    count,
    "worker heapUsed",
    (heapUsed / 1e6).toFixed(1),
    "MB after collection",
    JSON.stringify(collected),
  );
  if (disposeClient) client = await connect();
};

await addTopics(first);
await snapshot("a");
await addTopics(more);
await snapshot("b");

await client.dispose();
await worker.close();
await server.close();
await Deno.remove(storeDir, { recursive: true });
Deno.exit(0);
