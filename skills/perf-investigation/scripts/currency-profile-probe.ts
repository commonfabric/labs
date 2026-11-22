/**
 * What the currency index does for a space whose pieces read each viewer's
 * home space (docs/plans/stored-output-currency-across-spaces.md, step 8).
 * Makes `<pieces>` pieces in one space, each with a wish for the viewer's
 * `#favorites` and one output derived from it, and `<viewers>` viewers, each
 * with a home space that holds one favorite. A serving loop in this process
 * serves them. The probe measures, with no index and with the index leaving
 * current pieces unstarted (`skip`):
 *
 * - **return**: every viewer comes back to a space nothing is serving, in a
 *   new session, and watches every piece;
 * - **change**: one viewer renames their favorite while every viewer
 *   watches, timed until that viewer reads the new name from every piece;
 * - **away**: a viewer who is not watching renames theirs.
 *
 * Each phase prints its wall time, how many pieces a serving runtime runs,
 * what the serving loop counted, and what passed between the spaces'
 * indexes.
 *
 *   deno run -A --config deno.jsonc \
 *     skills/perf-investigation/scripts/currency-profile-probe.ts <pieces> <viewers>
 *
 * Run from the repository root. The loop runs on this thread, so the times
 * say how the phases compare and not what a toolshed's worker would take.
 */

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { SessionRegistry } from "@commonfabric/memory/v2/server";
import { type Cell, Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { CurrencyIndexMode } from "../../../runtime/runner/src/executor/store-currency.ts";
import { waitForSettled } from "../../../runtime/runner/src/executor/watermark.ts";
import { newLoopbackServer } from "../../../runtime/runner/src/storage/v2-emulate.ts";

const [piecesArgument, viewersArgument] = Deno.args;
const pieceCount = Number(piecesArgument);
const viewerCount = Number(viewersArgument);
if (
  !Number.isInteger(pieceCount) || pieceCount <= 0 ||
  !Number.isInteger(viewerCount) || viewerCount <= 0
) {
  console.error("usage: currency-profile-probe.ts <pieces> <viewers>");
  Deno.exit(2);
}

const serviceSigner = await Identity.fromPassphrase(
  "currency profile probe service",
);
const ownerSigner = await Identity.fromPassphrase(
  "currency profile probe owner",
);
const space = (await Identity.fromPassphrase("currency profile probe space"))
  .did() as MemorySpace;
const viewers: Identity[] = [];
for (let at = 0; at < viewerCount; at++) {
  viewers.push(
    await Identity.fromPassphrase(`currency profile probe viewer ${at}`),
  );
}

/** A viewer's home space. */
const homeOf = (viewer: Identity): MemorySpace => viewer.did() as MemorySpace;

// A piece with one wish for the viewer's favorites, and one output that
// holds what the wish resolved to.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, wish } from 'commonfabric';",
      "export default pattern<{ n?: number }, { reader: string }>(() => {",
      "  const found = wish<any>({ query: '#favorites' });",
      "  return {",
      "    reader: computed(() => JSON.stringify(found.result ?? null)),",
      "  };",
      "});",
    ].join("\n"),
  }],
};

/** What one run of the probe, with the index kept one way, works with. */
type Run = {
  server: ReturnType<typeof newLoopbackServer>;
  sessions: SessionRegistry;
  host: ExecutorHost;
  /** The serving runtimes the host made, one for each space it serves. */
  servingRuntimes: Runtime[];
  /** Main-thread time, in ms, of each currency request the server answered. */
  requestMs: Record<string, { calls: number; ms: number }>;
  /** One number read from the space's store. */
  scalar: (sql: string) => number;
};

/**
 * A memory server of its own and a host serving it, keeping the currency
 * index as `mode` says. A process has one host for a store: its commits are
 * numbered on one session, which a second host would number again from the
 * start.
 */
const startRun = async (mode: CurrencyIndexMode | undefined): Promise<Run> => {
  // A closed connection's sessions, and their demand, outlive it for the
  // registry's resume window, so the probe removes them itself between
  // phases.
  const sessions = new SessionRegistry();
  const server = newLoopbackServer({
    sessions,
    delegatingDids: [serviceSigner.did()],
    subscriptionRefreshDelayMs: 0,
  });
  const requestMs: Run["requestMs"] = {};
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
  const servingRuntimes: Runtime[] = [];
  const host = new ExecutorHost({
    server,
    serviceIdentity: serviceSigner.did(),
    createRuntime: () => {
      const manager = EmulatedStorageManager.connectTo(server, {
        as: serviceSigner,
      });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        servingPosture: true,
        experimental: { serverExecution: true },
      });
      servingRuntimes.push(runtime);
      return Promise.resolve({
        runtime,
        dispose: async () => {
          await runtime.dispose();
          await manager.close();
        },
      });
    },
    policy: {
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      ...(mode !== undefined &&
        { currencyIndex: mode, currencyEpoch: "probe" }),
    },
  });
  const engine = await server.engineForSpace(space);
  return {
    server,
    sessions,
    host,
    servingRuntimes,
    requestMs,
    scalar: (sql) => (engine.prepare(sql).get({}) as { n: number }).n,
  };
};

type Client = { runtime: Runtime; dispose: () => Promise<void> };

/** A client of `run`'s server acting for `as`. */
const connect = (run: Run, as: Identity, serverExecution = true): Client => {
  const manager = EmulatedStorageManager.connectTo(run.server, { as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: manager,
    experimental: { serverExecution },
  });
  return {
    runtime,
    dispose: async () => {
      await runtime.dispose();
      await manager.close();
    },
  };
};

let pokes = 0;

/**
 * Commits an authored write to a document no piece reads, as `client`, and
 * resolves once the watermark covers it: one wave cycle, ordered after
 * whatever the loop was going to run.
 */
const settleACycle = async (run: Run, client: Client): Promise<void> => {
  const poke = client.runtime.getCell<{ n: number }>(
    space,
    "currency-profile-probe-poke",
    undefined,
  );
  await poke.sync();
  pokes += 1;
  const tx = client.runtime.edit();
  poke.withTx(tx).set({ n: pokes });
  const committed = await tx.commit().settled;
  if (committed.error) throw new Error(`poke failed: ${committed.error}`);
  await client.runtime.storageManager.synced();
  const authored = run.scalar(
    `SELECT COALESCE(MAX(seq), 0) AS n FROM "commit" WHERE class = 'authored'`,
  );
  await waitForSettled(client.runtime, space, authored);
};

/**
 * Runs wave cycles until two in a row leave the serving loop's counters and
 * the store's document count where they were.
 */
const settle = async (run: Run, client: Client): Promise<void> => {
  const reading = () =>
    JSON.stringify([
      run.host.stats().currency,
      run.scalar(`SELECT COUNT(*) AS n FROM head`),
    ]);
  let last = "";
  for (let same = 0; same < 2;) {
    await settleACycle(run, client);
    await run.host.whenQuiescent();
    const now = reading();
    same = now === last ? same + 1 : 0;
    last = now;
  }
};

/** The cause a piece's result document is made from. */
const resultCause = (at: number) => `currency profile probe result ${at}`;

/** The result documents of the pieces, as `client` reads them. */
const resultsOf = (
  client: Client,
  schema: unknown,
): Cell<Record<string, unknown>>[] =>
  Array.from(
    { length: pieceCount },
    (_, at) =>
      client.runtime.getCell<Record<string, unknown>>(
        space,
        resultCause(at),
        schema as never,
      ),
  );

/** How many of the pieces a serving runtime of `run` runs. */
const running = (
  run: Run,
  results: Cell<Record<string, unknown>>[],
): number =>
  results.filter((result) => {
    const link = result.getAsNormalizedFullLink();
    return run.servingRuntimes.some((runtime) =>
      runtime.runner.isRunning(runtime.getCellFromLink(link))
    );
  }).length;

/** Gives each viewer's home space one favorite. */
const seedHomes = async (run: Run): Promise<void> => {
  for (const [at, viewer] of viewers.entries()) {
    const home = homeOf(viewer);
    const client = connect(run, viewer, false);
    const tx = client.runtime.edit();
    const favorite = client.runtime.getCell(home, "favorite", undefined, tx);
    favorite.set({ name: `favorite of ${at}` });
    client.runtime.getCell(home, home, undefined, tx).set({
      defaultPattern: { favorites: [{ cell: favorite, tags: ["probe"] }] },
    });
    const committed = await tx.commit().settled;
    if (committed.error) throw new Error(`seed failed: ${committed.error}`);
    await client.runtime.storageManager.synced();
    await client.dispose();
  }
};

let renames = 0;

/** Renames `viewer`'s favorite, as a client that runs nothing. */
const rename = async (run: Run, viewer: Identity): Promise<string> => {
  renames += 1;
  const name = `renamed ${renames}`;
  const client = connect(run, viewer, false);
  const favorite = client.runtime.getCell<{ name: string }>(
    homeOf(viewer),
    "favorite",
    { type: "object", properties: { name: { type: "string" } } },
  );
  await favorite.sync();
  const tx = client.runtime.edit();
  favorite.withTx(tx).key("name").set(name);
  const committed = await tx.commit().settled;
  if (committed.error) throw new Error(`rename failed: ${committed.error}`);
  await client.runtime.storageManager.synced();
  await client.dispose();
  return name;
};

type Watch = {
  client: Client;
  results: Cell<Record<string, unknown>>[];
  stop: () => void;
};

/** Has a new client of `viewer`'s watch every piece. */
const watchAll = async (
  run: Run,
  viewer: Identity,
  schema: unknown,
): Promise<Watch> => {
  const client = connect(run, viewer);
  const results = resultsOf(client, schema);
  const cancels: Array<() => void> = [];
  for (const result of results) {
    await result.sync();
    cancels.push(result.sink(() => {}));
  }
  return {
    client,
    results,
    stop: () => cancels.forEach((cancel) => cancel()),
  };
};

/** Resolves once each of `results` holds `name` in its `reader`. */
const allRead = (
  results: Cell<Record<string, unknown>>[],
  name: string,
): Promise<void> =>
  Promise.all(results.map((result) => {
    const done = Promise.withResolvers<void>();
    const cancel = result.key("reader").sink((value) => {
      if (typeof value === "string" && value.includes(name)) done.resolve();
    });
    return done.promise.finally(cancel);
  })).then(() => {});

/** The counts a phase is measured by, as they stand. */
const countsOf = (run: Run) => {
  const { currency } = run.host.stats();
  const delivery = run.server.currencyDelivery();
  return {
    judged: currency.judged,
    servable: currency.servable,
    servedFromStore: currency.servedFromStore,
    rearmed: currency.rearmed,
    indexWakes: currency.indexWakes,
    recordsStored: currency.recordsStored,
    falseClean: currency.falseClean,
    triggers: delivery.triggers,
    pulls: delivery.pulls,
    advancesQueued: delivery.advancesQueued,
  };
};

/**
 * Starts a phase: the counts it is measured against, with the request
 * times cleared.
 */
const begin = (run: Run) => {
  for (const row of Object.values(run.requestMs)) row.calls = row.ms = 0;
  return { counts: countsOf(run), start: performance.now() };
};

/** Prints what a phase cost since `from`. */
const report = (
  label: string,
  run: Run,
  from: ReturnType<typeof begin>,
  results: Cell<Record<string, unknown>>[],
  extra: Record<string, unknown> = {},
): void => {
  const now = countsOf(run);
  console.log(
    label,
    JSON.stringify({
      seconds: Number(((performance.now() - from.start) / 1000).toFixed(2)),
      ...extra,
      piecesRunning: running(run, results),
      ...Object.fromEntries(
        Object.entries(now).map(([name, value]) => [
          name,
          value - from.counts[name as keyof typeof now],
        ]),
      ),
      mainThreadMs: Object.fromEntries(
        Object.entries(run.requestMs).map((
          [name, row],
        ) => [name, { calls: row.calls, ms: Number(row.ms.toFixed(1)) }]),
      ),
    }),
  );
};

/**
 * Has every client leave, and parks the space: the state a returning viewer
 * finds when nothing has been serving it.
 */
const leave = async (run: Run, clients: Client[]): Promise<void> => {
  for (const client of clients) await client.dispose();
  for (const of of [space, ...viewers.map(homeOf)]) {
    for (const { id, principal } of run.sessions.sessionsForSpace(of)) {
      // A serving runtime's own session stays: the host resumes it.
      if (principal !== serviceSigner.did()) run.sessions.remove(of, id);
    }
  }
  await run.host.whenQuiescent();
  await run.host.spaceServer(space)?.park("probe");
};

/**
 * Runs the phases over a server and a host of their own, with the index
 * kept as `mode` says.
 */
const measure = async (
  label: string,
  mode: CurrencyIndexMode | undefined,
): Promise<void> => {
  const run = await startRun(mode);
  await seedHomes(run);

  // The pieces are made, and every viewer views them once.
  let owner = connect(run, ownerSigner);
  const compiled = await owner.runtime.patternManager.compilePattern(PROGRAM, {
    space,
  });
  let from = begin(run);
  for (let at = 0; at < pieceCount; at++) {
    const argument = owner.runtime.getCell<Record<string, unknown>>(
      space,
      `currency profile probe argument ${at}`,
      compiled.argumentSchema,
    );
    const result = owner.runtime.getCell<Record<string, unknown>>(
      space,
      resultCause(at),
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    const tx = owner.runtime.edit();
    argument.withTx(tx).set({});
    owner.runtime.run(tx, compiled, argument, result);
    const committed = await tx.commit().settled;
    if (committed.error) throw new Error(`run failed: ${committed.error}`);
  }
  let watches: Watch[] = [];
  for (const viewer of viewers) {
    watches.push(await watchAll(run, viewer, compiled.resultSchema));
  }
  await settle(run, owner);
  report(
    `${label} build`,
    run,
    from,
    resultsOf(owner, compiled.resultSchema),
    mode === undefined ? {} : {
      slices: run.scalar(`SELECT COUNT(*) AS n FROM currency_slice`),
      clean: run.scalar(
        `SELECT COUNT(*) AS n FROM currency_slice WHERE mark = 0`,
      ),
    },
  );
  for (const watch of watches) watch.stop();
  await leave(run, [owner, ...watches.map((watch) => watch.client)]);

  // Every viewer comes back and watches every piece.
  owner = connect(run, ownerSigner);
  from = begin(run);
  watches = [];
  for (const viewer of viewers) {
    watches.push(await watchAll(run, viewer, compiled.resultSchema));
  }
  await settle(run, owner);
  const results = resultsOf(owner, compiled.resultSchema);
  report(`${label} return`, run, from, results);

  // The first viewer renames their favorite while every viewer watches.
  from = begin(run);
  const name = await rename(run, viewers[0]);
  await allRead(watches[0].results, name);
  const readSeconds = Number(
    ((performance.now() - from.start) / 1000).toFixed(2),
  );
  await settle(run, owner);
  report(`${label} change`, run, from, results, { readSeconds });
  for (const watch of watches) watch.stop();
  await leave(run, [owner, ...watches.map((watch) => watch.client)]);

  // A viewer who is not watching renames their favorite while the others
  // watch.
  if (viewerCount > 1) {
    owner = connect(run, ownerSigner);
    watches = [];
    for (const viewer of viewers.slice(1)) {
      watches.push(await watchAll(run, viewer, compiled.resultSchema));
    }
    await settle(run, owner);
    const others = resultsOf(owner, compiled.resultSchema);
    const runningBefore = running(run, others);
    from = begin(run);
    await rename(run, viewers[0]);
    await settle(run, owner);
    report(`${label} away`, run, from, others, { runningBefore });
    for (const watch of watches) watch.stop();
    await leave(run, [owner, ...watches.map((watch) => watch.client)]);
  }

  await run.host.close();
  await run.server.close();
};

await measure("off", undefined);
await measure("skip", "skip");
Deno.exit(0);
