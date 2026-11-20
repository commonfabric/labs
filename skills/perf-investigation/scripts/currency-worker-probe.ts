/**
 * What the currency index does for a served Topics board
 * (docs/plans/stored-output-currency.md, stage 3). Serves a fresh board from
 * a `ServingWorkerPool` the way a toolshed does, files `<topics>` Topics with
 * the index in its `record` mode, and then views the board four times, each
 * from a new session and a new worker, as a restart leaves them: twice in
 * `record`, once in `skip`, and once with no index. Nothing demands a Topic
 * while the board is built, so the first view is the one that records them,
 * and the second is where `record` judges pieces it holds records of. Each
 * view prints what the serving loop counted, what the index holds, the
 * main-thread time its requests took, the documents the view left in the
 * store, and the worker's heap after a collection.
 *
 *   deno run -A --config deno.jsonc --v8-flags=--expose-gc \
 *     skills/perf-investigation/scripts/currency-worker-probe.ts <topics> [view]
 *
 * `view` is `refs` (the default), which resolves each Topic reference as a
 * card's link does and reads nothing else, or `index`, which reads the
 * board's `index` under its schema as `cf cell get` does. Run from the
 * repository root.
 */

import { fromFileUrl, toFileUrl } from "@std/path";
import { createSession, Identity } from "@commonfabric/identity";
import type { DID, MemorySpace } from "@commonfabric/memory/interface";
import type { Engine } from "@commonfabric/memory/v2/engine";
import { SessionRegistry } from "@commonfabric/memory/v2/server";
import { type Cell, Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { ServingWorkerPool } from "@commonfabric/runner/executor/serving-worker-host";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "@commonfabric/piece/ops";
import { sendVerbEvent } from "@commonfabric/piece/verb-call";
import type { CurrencyIndexMode } from "../../../runtime/runner/src/executor/store-currency.ts";
import { waitForSettled } from "../../../runtime/runner/src/executor/watermark.ts";
import { newLoopbackServer } from "../../../runtime/runner/src/storage/v2-emulate.ts";

const root = fromFileUrl(new URL("../../../", import.meta.url)).replace(
  /\/$/,
  "",
);
const [topicsArgument, viewArgument] = Deno.args;
const topics = Number(topicsArgument);
const viewKind = viewArgument ?? "refs";
if (
  !Number.isInteger(topics) || topics <= 0 ||
  (viewKind !== "refs" && viewKind !== "index")
) {
  console.error("usage: currency-worker-probe.ts <topics> [refs|index]");
  Deno.exit(2);
}

const serviceSigner = await Identity.fromPassphrase(
  "currency worker probe service",
);
const userSigner = await Identity.fromPassphrase("currency worker probe user");
const space = userSigner.did() as MemorySpace;

const storeDir = await Deno.makeTempDir({ prefix: "currency-worker-probe-" });
// A closed connection's sessions, and their demand, outlive it for the
// registry's resume window, so the probe removes them itself between views.
const sessions = new SessionRegistry();
const server = newLoopbackServer({
  store: toFileUrl(`${storeDir}/`),
  sessions,
  delegatingDids: [serviceSigner.did()],
});

/** Main-thread time, in ms, of each currency request the server answered. */
const requestMs: Record<string, { calls: number; ms: number }> = {};
for (
  const name of [
    "advanceCurrency",
    "storeCurrencyRecords",
    "judgeCurrencyRoots",
  ] as const
) {
  const target = server as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const original = target[name].bind(server);
  target[name] = async (...args: unknown[]) => {
    const start = performance.now();
    try {
      return await original(...args);
    } finally {
      const row = requestMs[name] ??= { calls: 0, ms: 0 };
      row.calls += 1;
      row.ms += performance.now() - start;
    }
  };
}

/** A pool serving the store, keeping the currency index as `mode` says. */
const startPool = async (
  mode: CurrencyIndexMode | undefined,
): Promise<ServingWorkerPool> => {
  const pool = new ServingWorkerPool({
    server,
    identity: serviceSigner,
    apiUrl: new URL(import.meta.url),
    policy: {
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      ...(mode !== undefined &&
        { currencyIndex: mode, currencyEpoch: "probe" }),
    },
    workerModule: new URL("./heap-worker-module.ts", import.meta.url),
  });
  await pool.ready;
  return pool;
};

const session = createSession({
  identity: serviceSigner,
  spaceDid: space as DID,
});

type Client = {
  pieces: PiecesController;
  runtime: Runtime;
  dispose: () => Promise<void>;
};

/** A client of the user's, in a session of its own. */
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

const engine: Engine = await server.engineForSpace(space);

/**
 * Removes every session of the space, once its client and its pool are
 * closed, so the next view's demand is its own client's alone.
 */
const forgetSessions = (): void => {
  for (const { id } of sessions.sessionsForSpace(space)) {
    sessions.remove(space, id);
  }
};

/** One number read from the store. */
const scalar = (sql: string): number =>
  (engine.prepare(sql).get({}) as { n: number }).n;

/** The store's documents, and what the currency index holds. */
const storeCounts = () => ({
  documents: scalar(`SELECT COUNT(*) AS n FROM head`),
  sessionDocuments: scalar(
    `SELECT COUNT(*) AS n FROM head WHERE scope_key LIKE 'session:%'`,
  ),
  pieces: scalar(`SELECT COUNT(DISTINCT piece) AS n FROM currency_slice`),
  slices: scalar(`SELECT COUNT(*) AS n FROM currency_slice`),
  clean: scalar(`SELECT COUNT(*) AS n FROM currency_slice WHERE mark = 0`),
  upstream: scalar(`SELECT COUNT(*) AS n FROM currency_slice WHERE mark = 1`),
  stale: scalar(`SELECT COUNT(*) AS n FROM currency_slice WHERE mark = 2`),
  reads: scalar(`SELECT COUNT(*) AS n FROM currency_read`),
  writes: scalar(`SELECT COUNT(*) AS n FROM currency_write`),
  vouches: scalar(`SELECT COUNT(*) AS n FROM currency_vouch`),
});

let pokes = 0;

/** The document each client pokes, which no piece reads. */
const pokeCells = new Map<Client, Cell<{ n: number }>>();

/**
 * Commits an authored write to the client's poke document, and resolves once
 * the watermark covers it: one wave cycle, ordered after whatever the loop
 * was going to run. A client pokes one document throughout, so a cycle after
 * its first changes no session's demand.
 */
const settleACycle = async (client: Client): Promise<void> => {
  if (Deno.env.get("PROBE_TRACE") === "1") console.error("cycle", pokes + 1);
  let poke = pokeCells.get(client);
  if (poke === undefined) {
    poke = client.runtime.getCell<{ n: number }>(
      space,
      `currency-probe-poke-${pokeCells.size + 1}`,
      undefined,
    );
    pokeCells.set(client, poke);
    await poke.sync();
  }
  pokes += 1;
  const tx = client.runtime.edit();
  poke.withTx(tx).set({ n: pokes });
  const committed = await tx.commit().settled;
  if (committed.error) throw new Error(`poke failed: ${committed.error}`);
  await client.runtime.storageManager.synced();
  const authored = scalar(
    `SELECT COALESCE(MAX(seq), 0) AS n FROM "commit" WHERE class = 'authored'`,
  );
  await waitForSettled(client.runtime, space, authored);
};

/**
 * Runs wave cycles until two in a row leave the serving loop's counters and
 * the store's document count where they were.
 */
const settle = async (
  pool: ServingWorkerPool,
  client: Client,
): Promise<void> => {
  const reading = () => {
    const stats = pool.stats();
    return JSON.stringify([
      stats.currency,
      stats.demand.ownedDefaultSeeds,
      stats.demand.demandedWriters,
      scalar(`SELECT COUNT(*) AS n FROM head`),
    ]);
  };
  let last = "";
  for (let same = 0; same < 2;) {
    await settleACycle(client);
    const now = reading();
    if (Deno.env.get("PROBE_TRACE") === "1") console.error("reading", now);
    same = now === last ? same + 1 : 0;
    last = now;
  }
};

let client = await connect();
const program: RuntimeProgram = await resolveLocalProgram(
  (resolver) => client.runtime.harness.resolve(resolver),
  { main: `${root}/patterns/apps/topics/main.tsx`, root },
);
let pool = await startPool("record");
const created = await pool.runLifecycleVerb(space, {
  name: "instantiate",
  request: {
    source: { program },
    actingUser: userSigner.did(),
    start: true,
  },
});
const pieceId = (created.receipt as { pieceId: string }).pieceId;

/** The board's result, as `client` reads it. */
const boardOf = async (c: Client): Promise<Cell<unknown>> =>
  c.pieces.getResult(
    await c.pieces.getPieceCell(pieceId, { reconcile: false, start: false }),
  ) as Cell<unknown>;

const buildStart = performance.now();
{
  const stream = (await boardOf(client)).key("addTopic" as never)
    .asSchemaFromLinks() as Cell<unknown>;
  for (let index = 1; index <= topics; index++) {
    const sent = await sendVerbEvent(stream, {
      title: `Probe topic ${index}`,
      body: "Filed by the currency probe.",
      agentName: "Claude",
    }, { invocation: { id: `probe-${index}`, session: "probe" }, echo: false });
    if (sent.status !== "committed") {
      throw new Error(`send failed: ${sent.error.message}`);
    }
    const handled = await sent.handled();
    if (handled.status !== "handled") {
      throw new Error(`not handled: ${JSON.stringify(handled)}`);
    }
  }
}
await settle(pool, client);
console.log(
  "built",
  topics,
  "topics in",
  ((performance.now() - buildStart) / 1000).toFixed(1),
  "s",
  JSON.stringify({ stats: pool.stats().currency, store: storeCounts() }),
);
await client.dispose();
await pool.close();
forgetSessions();

/**
 * Views the board from a new session over a new worker that keeps the index
 * as `mode` says, and prints what that cost.
 */
const view = async (
  label: string,
  mode: CurrencyIndexMode | undefined,
): Promise<void> => {
  for (const row of Object.values(requestMs)) row.calls = row.ms = 0;
  pool = await startPool(mode);
  client = await connect();
  const before = storeCounts();
  const start = performance.now();
  const board = await boardOf(client);
  const cancels: Array<() => void> = [];
  if (viewKind === "index") {
    const index = board.key("index" as never).asSchemaFromLinks() as Cell<
      unknown
    >;
    await index.sync();
    cancels.push(index.sink(() => {}));
  } else {
    const list = board.key("topics" as never) as Cell<unknown[]>;
    await list.sync();
    const count = (list.get() as unknown[] | undefined)?.length ?? 0;
    for (let index = 0; index < count; index++) {
      const topic = list.key(index).resolveAsCell();
      await topic.sync();
      cancels.push(topic.sink(() => {}));
    }
  }
  await settle(pool, client);
  const seconds = (performance.now() - start) / 1000;
  const after = storeCounts();
  const stats = pool.stats();
  const memory = await pool.collectedMemory();
  console.log(
    label,
    JSON.stringify({
      seconds: Number(seconds.toFixed(1)),
      currency: stats.currency,
      ownedDefaultSeeds: stats.demand.ownedDefaultSeeds,
      demandedWriters: stats.demand.demandedWriters,
      // The client's poke document is the probe's own.
      documentsWritten: after.documents - before.documents - 1,
      sessionDocumentsWritten: after.sessionDocuments - before.sessionDocuments,
      index: {
        pieces: after.pieces,
        slices: after.slices,
        clean: after.clean,
        upstream: after.upstream,
        stale: after.stale,
        reads: after.reads,
        writes: after.writes,
        vouches: after.vouches,
      },
      mainThreadMs: Object.fromEntries(
        Object.entries(requestMs).map((
          [name, row],
        ) => [name, { calls: row.calls, ms: Number(row.ms.toFixed(1)) }]),
      ),
      workerHeapMB: memory.map((entry) =>
        Number((entry.heapUsed / 1e6).toFixed(1))
      ),
    }),
  );
  for (const cancel of cancels) cancel();
  await client.dispose();
  await pool.close();
  forgetSessions();
};

await view("record-first", "record");
await view("record-again", "record");
await view("skip", "skip");
await view("off", undefined);

await server.close();
await Deno.remove(storeDir, { recursive: true });
Deno.exit(0);
