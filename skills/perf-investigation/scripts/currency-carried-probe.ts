/**
 * What a demand carried from another space costs the space it is carried
 * into (docs/plans/stored-output-currency-across-spaces.md, step 5). Makes
 * `<pieces>` pieces in a source space, each with one output derived from its
 * input once for each viewer who demands it, and `<viewers>` viewers who
 * hold READ on that space. A serving loop in this process serves both
 * spaces and keeps the currency index in its `skip` mode. The probe runs
 * the same phases over two arrangements:
 *
 * - **carried**: a reading space holds one piece for each source piece,
 *   whose argument is that piece's output. The viewers watch the reading
 *   pieces and have no session in the source space, so what demands their
 *   instances there is what the reading space's loop carries.
 * - **direct**: the viewers watch the source pieces themselves.
 *
 * The phases:
 *
 * - **build**: the pieces are made and every viewer views them once;
 * - **return**: every viewer comes back, in a new session, to spaces
 *   nothing is serving, with nothing changed;
 * - **changed away**: every source piece's input changes while nobody is
 *   there, and every viewer comes back, timed until each reads the new
 *   value from every piece;
 * - **change**: one source piece's input changes while every viewer
 *   watches, timed until each reads the new value.
 *
 * Each phase prints its wall time, how many pieces a serving runtime runs
 * in each space, what the serving loop counted, the derived commits of each
 * space, the main-thread time of the memory server's currency requests the
 * probe wraps (the advance, the store of records, the judgment and the
 * carried demand it was handed), and how many carried rows stood in the
 * source's demand set at the most.
 *
 *   deno run -A --config deno.jsonc \
 *     skills/perf-investigation/scripts/currency-carried-probe.ts <pieces> <viewers>
 *
 * Run from the repository root. The loop runs on this thread, so the times
 * say how the arrangements compare and not what a toolshed's worker would
 * take.
 */

import { Identity } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { SessionRegistry } from "@commonfabric/memory/v2/server";
import { type Cell, Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import { waitForSettled } from "../../../runtime/runner/src/executor/watermark.ts";
import { newLoopbackServer } from "../../../runtime/runner/src/storage/v2-emulate.ts";

const [piecesArgument, viewersArgument] = Deno.args;
const pieceCount = Number(piecesArgument);
const viewerCount = Number(viewersArgument);
if (
  !Number.isInteger(pieceCount) || pieceCount <= 0 ||
  !Number.isInteger(viewerCount) || viewerCount <= 0
) {
  console.error("usage: currency-carried-probe.ts <pieces> <viewers>");
  Deno.exit(2);
}

const serviceSigner = await Identity.fromPassphrase(
  "currency carried probe service",
);
const ownerSigner = await Identity.fromPassphrase(
  "currency carried probe owner",
);

/** The space whose pieces derive an output once for each viewer. */
const source = (await Identity.fromPassphrase("currency carried probe source"))
  .did() as MemorySpace;

/** The space whose pieces read those outputs. */
const reader = (await Identity.fromPassphrase("currency carried probe reader"))
  .did() as MemorySpace;
const viewers: Identity[] = [];
for (let at = 0; at < viewerCount; at++) {
  viewers.push(
    await Identity.fromPassphrase(`currency carried probe viewer ${at}`),
  );
}

// A piece with one output, derived from its input once for each viewer.
const SOURCE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, PerUser } from 'commonfabric';",
      "export default pattern<{ n?: number }, { out: string }>(({ n }) => {",
      "  const out = computed((): PerUser<string> => 'out:' + String(n ?? 0));",
      "  return { out };",
      "});",
    ].join("\n"),
  }],
};

// A piece with one output, derived from what its argument links to.
const READER_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "export default pattern<{ from: string }, { out: string }>(",
      "  ({ from }) => ({ out: computed(() => 'read:' + from) }),",
      ");",
    ].join("\n"),
  }],
};

/** Which pieces the viewers watch. */
type Arrangement = "carried" | "direct";

/** What one run of the probe, over one arrangement, works with. */
type Run = {
  arrangement: Arrangement;

  /** The space the viewers watch pieces of. */
  watched: MemorySpace;
  server: ReturnType<typeof newLoopbackServer>;
  sessions: SessionRegistry;
  host: ExecutorHost;

  /** The serving runtimes the host made, each with the space it serves. */
  servingRuntimes: Array<{ space: MemorySpace; runtime: Runtime }>;

  /** Main-thread time, in ms, of each currency request the probe wraps. */
  requestMs: Record<string, { calls: number; ms: number }>;

  /** What the carried demand the server was handed came to. */
  carried: { rows: number; refused: number; standingMax: number };

  /** One number read from the store of `space`. */
  scalar: (space: MemorySpace, sql: string) => Promise<number>;
};

/** A memory server of its own and a host serving it, for `arrangement`. */
const startRun = async (arrangement: Arrangement): Promise<Run> => {
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
  const carried: Run["carried"] = { rows: 0, refused: 0, standingMax: 0 };

  // The carried rows that stand are counted each time anything reads the
  // source's demand set, which its serving loop does on every demand pass:
  // the memory server makes a row it holds stand again when the source's
  // index changes, with no request from the reading space.
  const demandForSpace = server.demandForSpace.bind(server);
  server.demandForSpace = (space, options) => {
    const shares = demandForSpace(space, options);
    if (space === source) {
      const standing = shares.reduce(
        (count, share) =>
          count +
          [...share.rows.values()].filter((row) => row.origin !== undefined)
            .length,
        0,
      );
      carried.standingMax = Math.max(carried.standingMax, standing);
    }
    return shares;
  };
  const target = server as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  for (
    const name of [
      "advanceCurrency",
      "storeCurrencyRecords",
      "judgeCurrencyRoots",
      "setCarriedDemand",
    ] as const
  ) {
    const original = target[name].bind(server);
    target[name] = async (...args: unknown[]) => {
      const start = performance.now();
      try {
        const returned = await original(...args);
        if (name === "setCarriedDemand") {
          carried.rows += (args[2] as unknown[]).length;
          carried.refused += (returned as { refused: number }).refused;
          // Read for the count it takes of the rows that now stand.
          server.demandForSpace(source);
        }
        return returned;
      } finally {
        const row = requestMs[name] ??= { calls: 0, ms: 0 };
        row.calls += 1;
        row.ms += performance.now() - start;
      }
    };
  }
  const servingRuntimes: Run["servingRuntimes"] = [];
  const host = new ExecutorHost({
    server,
    serviceIdentity: serviceSigner.did(),
    createRuntime: (space) => {
      const manager = EmulatedStorageManager.connectTo(server, {
        as: serviceSigner,
        servingHomeSpace: space,
      });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        servingPosture: true,
        experimental: { serverExecution: true },
      });
      servingRuntimes.push({ space: space as MemorySpace, runtime });
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
      currencyIndex: "skip",
      currencyEpoch: "probe",
    },
  });
  await server.writeDocument(source, aclDocId(source), {
    [ownerSigner.did()]: "OWNER",
    ...Object.fromEntries(viewers.map((viewer) => [viewer.did(), "READ"])),
  });
  return {
    arrangement,
    watched: arrangement === "carried" ? reader : source,
    server,
    sessions,
    host,
    servingRuntimes,
    requestMs,
    carried,
    scalar: async (space, sql) =>
      ((await server.engineForSpace(space)).prepare(sql).get({}) as {
        n: number;
      }).n,
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
 * Commits an authored write to a document of the watched space that no
 * piece reads, as `client`, and resolves once the watermark covers it: one
 * wave cycle, ordered after whatever the loop was going to run.
 */
const settleACycle = async (run: Run, client: Client): Promise<void> => {
  const poke = client.runtime.getCell<{ n: number }>(
    run.watched,
    "currency-carried-probe-poke",
    undefined,
  );
  await poke.sync();
  pokes += 1;
  const tx = client.runtime.edit();
  poke.withTx(tx).set({ n: pokes });
  const committed = await tx.commit().settled;
  if (committed.error) throw new Error(`poke failed: ${committed.error}`);
  await client.runtime.storageManager.synced();
  const authored = await run.scalar(
    run.watched,
    `SELECT COALESCE(MAX(seq), 0) AS n FROM "commit" WHERE class = 'authored'`,
  );
  await waitForSettled(client.runtime, run.watched, authored);
};

/**
 * Runs wave cycles until two in a row leave the serving loop's counters,
 * the carried rows that stand and both stores' document counts where they
 * were.
 */
const settle = async (run: Run, client: Client): Promise<void> => {
  const reading = async () =>
    JSON.stringify([
      run.host.stats().currency,
      run.carried,
      await run.scalar(source, `SELECT COUNT(*) AS n FROM head`),
      await run.scalar(reader, `SELECT COUNT(*) AS n FROM head`),
    ]);
  let last = "";
  for (let same = 0; same < 2;) {
    await settleACycle(run, client);
    await run.host.whenQuiescent();
    await run.server.idle();
    await run.host.whenQuiescent();
    const now = await reading();
    same = now === last ? same + 1 : 0;
    last = now;
  }
};

/** The cause a source piece's result document is made from. */
const sourceCause = (at: number) => `currency carried probe source ${at}`;

/** The cause a reading piece's result document is made from. */
const readerCause = (at: number) => `currency carried probe reader ${at}`;

/** The result documents of the pieces of `space`, as `client` reads them. */
const resultsOf = (
  client: Client,
  space: MemorySpace,
  schema: unknown,
): Cell<Record<string, unknown>>[] =>
  Array.from(
    { length: pieceCount },
    (_, at) =>
      client.runtime.getCell<Record<string, unknown>>(
        space,
        space === source ? sourceCause(at) : readerCause(at),
        schema as never,
      ),
  );

/** How many of the pieces of `space` a serving runtime of `run` runs. */
const running = (
  run: Run,
  space: MemorySpace,
  results: Cell<Record<string, unknown>>[],
): number =>
  results.filter((result) => {
    const link = result.getAsNormalizedFullLink();
    return run.servingRuntimes.some((serving) =>
      serving.space === space &&
      serving.runtime.runner.isRunning(serving.runtime.getCellFromLink(link))
    );
  }).length;

/** Sets the input of the source piece `at` to `n`, as a client that leaves. */
const setInput = async (run: Run, at: number, n: number): Promise<void> => {
  const client = connect(run, ownerSigner, false);
  const argument = client.runtime.getCell<{ n?: number }>(
    source,
    `${sourceCause(at)} argument`,
    { type: "object", properties: { n: { type: "number" } } },
  );
  await argument.sync();
  const tx = client.runtime.edit();
  argument.withTx(tx).set({ n });
  const committed = await tx.commit().settled;
  if (committed.error) throw new Error(`input failed: ${committed.error}`);
  await client.runtime.storageManager.synced();
  await client.dispose();
};

type Watch = {
  client: Client;
  results: Cell<Record<string, unknown>>[];
  stop: () => void;
};

/** Has a new client of `viewer`'s watch every piece of the watched space. */
const watchAll = async (
  run: Run,
  viewer: Identity,
  schema: unknown,
): Promise<Watch> => {
  const client = connect(run, viewer);
  const results = resultsOf(client, run.watched, schema);
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

/** Resolves once each of `results` holds a value ending in `:<n>`. */
const allRead = (
  results: Cell<Record<string, unknown>>[],
  n: number,
): Promise<void> =>
  Promise.all(results.map((result) => {
    const done = Promise.withResolvers<void>();
    const cancel = result.key("out").sink((value) => {
      if (typeof value === "string" && value.endsWith(`:${n}`)) done.resolve();
    });
    return done.promise.finally(cancel);
  })).then(() => {});

/** The counts a phase is measured by, as they stand. */
const countsOf = (run: Run) => {
  const stats = run.host.stats();
  const delivery = run.server.currencyDelivery();
  return {
    judged: stats.currency.judged,
    servedFromStore: stats.currency.servedFromStore,
    rearmed: stats.currency.rearmed,
    indexWakes: stats.currency.indexWakes,
    recordsStored: stats.currency.recordsStored,
    falseClean: stats.currency.falseClean,
    carriedRowsOffered: run.carried.rows,
    carriedRefused: run.carried.refused,
    demandPasses: stats.demand.demandPasses,
    demandPassMs: Math.round(stats.demand.demandPassMs),
    sourceDerivedCommits: stats.derivedCommitsBySpace[source] ?? 0,
    readerDerivedCommits: stats.derivedCommitsBySpace[reader] ?? 0,
    sourceTenures:
      run.servingRuntimes.filter((serving) => serving.space === source).length,
    triggers: delivery.triggers,
    pulls: delivery.pulls,
    advancesQueued: delivery.advancesQueued,
  };
};

/**
 * Starts a phase: the counts it is measured against, with the request
 * times and the carried rows' high-water mark cleared.
 */
const begin = (run: Run) => {
  for (const row of Object.values(run.requestMs)) row.calls = row.ms = 0;
  run.carried.standingMax = 0;
  return { counts: countsOf(run), start: performance.now() };
};

/** Prints what a phase cost since `from`. */
const report = (
  label: string,
  run: Run,
  from: ReturnType<typeof begin>,
  owner: Client,
  schemas: { source: unknown; reader: unknown },
  extra: Record<string, unknown> = {},
): void => {
  const now = countsOf(run);
  console.log(
    `${run.arrangement} ${label}`,
    JSON.stringify({
      seconds: Number(((performance.now() - from.start) / 1000).toFixed(2)),
      ...extra,
      sourcePiecesRunning: running(
        run,
        source,
        resultsOf(owner, source, schemas.source),
      ),
      ...(run.arrangement === "carried" && {
        readerPiecesRunning: running(
          run,
          reader,
          resultsOf(owner, reader, schemas.reader),
        ),
      }),
      ...Object.fromEntries(
        Object.entries(now).map(([name, value]) => [
          name,
          value - from.counts[name as keyof typeof now],
        ]),
      ),
      carriedStandingMax: run.carried.standingMax,
      mainThreadMs: Object.fromEntries(
        Object.entries(run.requestMs).map((
          [name, row],
        ) => [name, { calls: row.calls, ms: Number(row.ms.toFixed(1)) }]),
      ),
    }),
  );
};

/**
 * Has every client leave, and parks both spaces: the state a returning
 * viewer finds when nothing has been serving them.
 */
const leave = async (run: Run, clients: Client[]): Promise<void> => {
  for (const client of clients) await client.dispose();
  for (const served of [reader, source]) {
    for (const { id, principal } of run.sessions.sessionsForSpace(served)) {
      // A serving runtime's own session stays: the host resumes it.
      if (principal !== serviceSigner.did()) run.sessions.remove(served, id);
    }
  }
  await run.host.whenQuiescent();
  await run.server.idle();
  await run.host.whenQuiescent();
  for (const served of [reader, source]) {
    await run.host.spaceServer(served)?.park("probe");
  }
};

/** Runs the phases over a server and a host of their own. */
const measure = async (arrangement: Arrangement): Promise<void> => {
  const run = await startRun(arrangement);

  // The pieces are made, and every viewer views them once.
  let owner = connect(run, ownerSigner);
  const made = await owner.runtime.patternManager.compilePattern(
    SOURCE_PROGRAM,
    { space: source },
  );
  const reading = await owner.runtime.patternManager.compilePattern(
    READER_PROGRAM,
    { space: reader },
  );
  const schemas = { source: made.resultSchema, reader: reading.resultSchema };
  const watchedSchema = arrangement === "carried"
    ? schemas.reader
    : schemas.source;
  let from = begin(run);
  for (let at = 0; at < pieceCount; at++) {
    const argument = owner.runtime.getCell<Record<string, unknown>>(
      source,
      `${sourceCause(at)} argument`,
      made.argumentSchema,
    );
    const result = owner.runtime.getCell<Record<string, unknown>>(
      source,
      sourceCause(at),
      made.resultSchema,
    );
    await argument.sync();
    await result.sync();
    const tx = owner.runtime.edit();
    argument.withTx(tx).set({ n: 0 });
    owner.runtime.run(tx, made, argument, result);
    const committed = await tx.commit().settled;
    if (committed.error) throw new Error(`run failed: ${committed.error}`);
  }
  if (arrangement === "carried") {
    for (let at = 0; at < pieceCount; at++) {
      const argument = owner.runtime.getCell<Record<string, unknown>>(
        reader,
        `${readerCause(at)} argument`,
        reading.argumentSchema,
      );
      const result = owner.runtime.getCell<Record<string, unknown>>(
        reader,
        readerCause(at),
        reading.resultSchema,
      );
      await argument.sync();
      await result.sync();
      const tx = owner.runtime.edit();
      argument.withTx(tx).set({
        from: owner.runtime.getCell<Record<string, unknown>>(
          source,
          sourceCause(at),
          made.resultSchema,
          tx,
        ).key("out"),
      });
      owner.runtime.run(tx, reading, argument, result);
      const committed = await tx.commit().settled;
      if (committed.error) throw new Error(`run failed: ${committed.error}`);
    }
  }
  let watches: Watch[] = [];
  for (const viewer of viewers) {
    watches.push(await watchAll(run, viewer, watchedSchema));
  }
  await Promise.all(watches.map((watch) => allRead(watch.results, 0)));
  await settle(run, owner);
  report("build", run, from, owner, schemas);
  for (const watch of watches) watch.stop();
  await leave(run, [owner, ...watches.map((watch) => watch.client)]);

  // Every viewer comes back, with nothing changed.
  owner = connect(run, ownerSigner);
  from = begin(run);
  watches = [];
  for (const viewer of viewers) {
    watches.push(await watchAll(run, viewer, watchedSchema));
  }
  await Promise.all(watches.map((watch) => allRead(watch.results, 0)));
  await settle(run, owner);
  report("return", run, from, owner, schemas);
  for (const watch of watches) watch.stop();
  await leave(run, [owner, ...watches.map((watch) => watch.client)]);

  // Every source piece's input changes while nobody is there, and every
  // viewer comes back.
  for (let at = 0; at < pieceCount; at++) await setInput(run, at, 1);
  await run.server.idle();
  owner = connect(run, ownerSigner);
  from = begin(run);
  watches = [];
  for (const viewer of viewers) {
    watches.push(await watchAll(run, viewer, watchedSchema));
  }
  await Promise.all(watches.map((watch) => allRead(watch.results, 1)));
  let readSeconds = Number(
    ((performance.now() - from.start) / 1000).toFixed(2),
  );
  await settle(run, owner);
  report("changed away", run, from, owner, schemas, { readSeconds });

  // One source piece's input changes while every viewer watches.
  from = begin(run);
  await setInput(run, 0, 2);
  await Promise.all(watches.map((watch) => allRead([watch.results[0]], 2)));
  readSeconds = Number(((performance.now() - from.start) / 1000).toFixed(2));
  await settle(run, owner);
  report("change", run, from, owner, schemas, { readSeconds });
  for (const watch of watches) watch.stop();
  await leave(run, [owner, ...watches.map((watch) => watch.client)]);

  await run.host.close();
  await run.server.close();
};

await measure("direct");
await measure("carried");
Deno.exit(0);
