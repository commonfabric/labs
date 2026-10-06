/**
 * Measures what one dispatched handler event costs, phase by phase, as the
 * list its bound context reaches grows. Every sample sends one event through
 * the scheduler to a compiled handler and waits for its commit; the timed
 * interval runs from the send to the commit callback. The dispatch's phases —
 * presync, dependency preflight, argument read, body, post-run, commit — are
 * read back from the phase timers the runtime keeps — as the time
 * each timer accumulated between a snapshot before the send and one at the
 * commit callback, so a phase that runs twice in a dispatch counts twice
 * and a phase that did not run in it counts nothing — so the whole dispatch
 * and its parts come from the same interval. The runtime's drains after
 * the callback sit outside the timed interval, and so does the reset of the
 * counter before each sample and of the list after the one workload that
 * writes to it, so every sample dispatches over a list of the size its name
 * states and writes a value the store does not hold. Those timers are kept
 * per process, one active start per key, so the runtimes here run one at a
 * time.
 *
 * Two context shapes are measured. A handle context binds the list as a
 * `Writable` cell, which is what the lunch poll's handlers declare, so the
 * argument read mints a handle and the body decides what to read. A plain
 * context declares the list as a value, so the argument read materializes
 * every row before the body runs. Read counts are collected in a separate,
 * untimed pass with accounting enabled, never in the timed samples, and only
 * when `HANDLER_DISPATCH_COUNTS=1` is set.
 */

import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/utils/logger";

import { sendEvent } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { RuntimeTelemetryEvent } from "../src/telemetry.ts";
import { benchDiagnostic } from "./bench-diagnostics.ts";

const identity = await Identity.fromPassphrase("handler dispatch benchmark");
const space = identity.did();

const PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "type Vote = {",
  "  amount: number;",
  "  title: string;",
  "  metadata: { category: string; tags: string[] };",
  "};",
  "type Handle = { votes: Writable<Vote[]>; out: Writable<number> };",
  "type Plain = { votes: Vote[]; out: Writable<number> };",
  // One element by key, which is how the lunch poll reaches one vote.
  "const scalarKey = handler<unknown, Handle>((_ev, { votes, out }) => {",
  "  out.set(votes.key(0).get().amount);",
  "});",
  // One element out of a whole-list read.
  "const scalarGet = handler<unknown, Handle>((_ev, { votes, out }) => {",
  "  out.set(votes.get()[0].amount);",
  "});",
  "const walk = handler<unknown, Handle>((_ev, { votes, out }) => {",
  "  out.set(votes.get().reduce((sum, vote) => sum + vote.amount, 0));",
  "});",
  // A list write and an element write, the two shapes a vote cast takes.
  "const mutate = handler<unknown, Handle>((_ev, { votes, out }) => {",
  "  votes.key(0).key('amount').set(votes.key(0).get().amount + 1);",
  "  votes.push({",
  "    amount: 1,",
  "    title: 'added',",
  "    metadata: { category: 'example', tags: ['first', 'second'] },",
  "  });",
  "  out.set(votes.key(0).get().amount);",
  "});",
  "const plainScalar = handler<unknown, Plain>((_ev, { votes, out }) => {",
  "  out.set(votes[0].amount);",
  "});",
  "const plainWalk = handler<unknown, Plain>((_ev, { votes, out }) => {",
  "  out.set(votes.reduce((sum, vote) => sum + vote.amount, 0));",
  "});",
  "export default pattern<",
  "  { votes: Writable<Vote[]>; out: Writable<number> },",
  "  {",
  "    out: number;",
  "    scalarKey: Stream<unknown>;",
  "    scalarGet: Stream<unknown>;",
  "    walk: Stream<unknown>;",
  "    mutate: Stream<unknown>;",
  "    plainScalar: Stream<unknown>;",
  "    plainWalk: Stream<unknown>;",
  "  }",
  ">(({ votes, out }) => ({",
  "  out,",
  "  scalarKey: scalarKey({ votes, out }),",
  "  scalarGet: scalarGet({ votes, out }),",
  "  walk: walk({ votes, out }),",
  "  mutate: mutate({ votes, out }),",
  "  plainScalar: plainScalar({ votes, out }),",
  "  plainWalk: plainWalk({ votes, out }),",
  "}));",
].join("\n");

type Workload =
  | "scalarKey"
  | "scalarGet"
  | "walk"
  | "mutate"
  | "plainScalar"
  | "plainWalk";

const WORKLOADS: readonly Workload[] = [
  "scalarKey",
  "scalarGet",
  "walk",
  "mutate",
  "plainScalar",
  "plainWalk",
];

const SIZES = [74, 296, 1184] as const;

/**
 * Phase timers a dispatch leaves behind, by logger and key path. The
 * preflight's five steps are read separately; the handler action's timer
 * spans the argument read, the body, the post-run, the trusted-write
 * collection after the body, and the commit's preparation and synchronous
 * steps.
 */
const PHASES = [
  ["scheduler", "scheduler/execute/event/presyncInputs"],
  ["scheduler", "scheduler/execute/event/pullPopulateDependencies"],
  ["scheduler", "scheduler/execute/event/pullTxToReactivityLog"],
  ["scheduler", "scheduler/execute/event/pullDepCommitStart"],
  ["scheduler", "scheduler/execute/event/pullCollectInvalidUpstream"],
  ["scheduler", "scheduler/execute/event/pullScheduleInvalidUpstream"],
  ["runner", "stream/readInputs"],
  ["runner", "stream/invokeJavaScriptImplementation"],
  ["runner", "stream/postRun"],
  ["scheduler", "scheduler/execute/event/handlerAction"],
  ["storage.v2.transaction", "commit/getNativeCommit"],
  ["storage.v2.transaction", "commit/validate"],
  ["storage.v2.transaction", "commit/commitNative"],
] as const;

// Mirrors `IStreamable.send`'s value-and-commit-callback shape; the result
// cell's key is reached through it because the compiled pattern's result type
// is not known here.
type Sender = {
  send(
    value: unknown,
    onCommit: (tx: { status(): { status: string } }) => void,
  ): void;
};

/** A runtime with the pattern running over a seeded list of `size` rows. */
async function prepare(size: number, readStats: boolean) {
  const storage = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  if (readStats) {
    runtime.scheduler.setReadStatsEnabled(true, { attempts: true });
    runtime.scheduler.setEventPreflightTelemetryEnabled(true);
  }
  const tx = runtime.edit();
  const compiled = await runtime.patternManager.compilePattern({
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: PATTERN }],
  }, { space, tx });
  const rows = Array.from({ length: size }, (_, index) => ({
    amount: index + 1,
    title: `Row ${index}`,
    metadata: { category: "example", tags: ["first", "second"] },
  }));
  const votes = runtime.getCell<typeof rows>(space, "votes", undefined, tx);
  votes.set(rows);
  const initialAmount = rows[0].amount;
  const out = runtime.getCell<number>(space, "out", undefined, tx);
  out.set(0);
  const argument = runtime.getCell<{ votes: unknown; out: unknown }>(
    space,
    "argument",
    undefined,
    tx,
  );
  argument.set({ votes, out });
  const result = runtime.getCell<Record<string, unknown>>(
    space,
    "result",
    compiled.resultSchema,
    tx,
  );
  runtime.run(tx, compiled, argument, result);
  const committed = await tx.commit().settled;
  if (committed.error) throw new Error("Benchmark seeding failed");
  await runtime.idle();

  /**
   * Sends one event and resolves, with the time from the send to the commit
   * callback, once that callback has run.
   */
  const dispatch = async (workload: Workload): Promise<number> => {
    const settled = Promise.withResolvers<{ status: string; end: number }>();
    const start = performance.now();
    sendEvent(result.key(workload), {}, (commitTx) => {
      settled.resolve({
        status: commitTx.status().status,
        end: performance.now(),
      });
    });
    const { status, end } = await settled.promise;
    if (status !== "done") {
      throw new Error(`Dispatch of ${workload} settled as ${status}`);
    }
    return end - start;
  };

  /** Waits for whatever the dispatch left running. */
  const drain = async (): Promise<void> => {
    await runtime.idle();
    await runtime.scheduler.idleWithPendingCommits();
  };

  /**
   * Puts the counter, and for `mutate` the list, back as seeded, so every
   * sample's handler writes a value the store does not already hold and the
   * expected-value check can fail. The list is re-seeded only where a
   * sample wrote to it, since re-seeding 1,184 rows before every sample
   * would leave the next dispatch collecting that commit's garbage.
   */
  const reseed = async (workload: Workload): Promise<void> => {
    const write = runtime.edit();
    if (workload === "mutate") votes.withTx(write).set(rows);
    out.withTx(write).set(0);
    const written = await write.commit().settled;
    if (written.error) throw new Error("Benchmark re-seeding failed");
    await drain();
  };

  const expected = (workload: Workload): number => {
    switch (workload) {
      case "scalarKey":
      case "scalarGet":
      case "plainScalar":
        return initialAmount;
      case "mutate":
        return initialAmount + 1;
      case "walk":
      case "plainWalk":
        return size * (size + 1) / 2;
    }
  };

  const dispose = async () => {
    await runtime.dispose({ closeStorage: false });
    await storage.close();
  };

  return { runtime, out, dispatch, drain, reseed, expected, dispose };
}

/**
 * The phase timers' accumulated time and sample count, keyed by phase path.
 * Two snapshots bracketing a dispatch give the time each phase spent in it,
 * however many times it ran, and no sample from an earlier dispatch.
 */
function phaseTotals(): Record<string, { totalTime: number; count: number }> {
  const totals: Record<string, { totalTime: number; count: number }> = {};
  for (const [loggerName, key] of PHASES) {
    const stats = getLogger(loggerName).getTimeStats(key);
    totals[key] = {
      totalTime: stats?.totalTime ?? 0,
      count: stats?.count ?? 0,
    };
  }
  return totals;
}

/** The time and sample count each phase added between two snapshots. */
function phaseDeltas(
  before: ReturnType<typeof phaseTotals>,
  after: ReturnType<typeof phaseTotals>,
): Record<string, { ms: number; samples: number }> {
  const deltas: Record<string, { ms: number; samples: number }> = {};
  for (const key of Object.keys(after)) {
    deltas[key] = {
      ms: after[key].totalTime - before[key].totalTime,
      samples: after[key].count - before[key].count,
    };
  }
  return deltas;
}

/**
 * Heap in use after a full collection, or `undefined` without `--expose-gc`.
 */
function collectedHeapUsed(): number | undefined {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) return undefined;
  gc();
  return Deno.memoryUsage().heapUsed;
}

//
// Read counts and allocation, collected once per variant before any timed
// sample, with accounting enabled. This pass is a load phase rather than a
// benchmark, and the scheduled benchmark workflow runs every `*.bench.ts` in
// this directory, so it runs only when `HANDLER_DISPATCH_COUNTS=1` asks for
// it.
//

if (Deno.env.get("HANDLER_DISPATCH_COUNTS") === "1") {
  for (const size of SIZES) {
    for (const workload of WORKLOADS) {
      const prepared = await prepare(size, true);
      const attempts: Record<string, unknown>[] = [];
      const preflights: Record<string, unknown>[] = [];
      const onTelemetry = (event: Event) => {
        const { marker } = (event as RuntimeTelemetryEvent).detail;
        if (marker.type === "scheduler.read-attempt") {
          attempts.push({ kind: marker.kind, ...marker.reads });
        }
        if (marker.type === "scheduler.event.preflight") {
          preflights.push({
            skipped: marker.skipped,
            readCount: marker.readCount,
            shallowReadCount: marker.shallowReadCount,
            populateMs: marker.populateMs,
            txToLogMs: marker.txToLogMs,
            depCommitMs: marker.depCommitMs,
            collectMs: marker.collectMs,
            scheduleMs: marker.scheduleMs,
          });
        }
      };
      const { nodes } = prepared.runtime.scheduler.accessForTestingOnly;
      const nodesBefore = nodes.effects.size + nodes.computations.size;
      const heapBefore = collectedHeapUsed();
      prepared.runtime.telemetry.addEventListener("telemetry", onTelemetry);
      await prepared.dispatch(workload);
      await prepared.drain();
      prepared.runtime.telemetry.removeEventListener("telemetry", onTelemetry);
      // Intended as what the dispatch left behind, read after it settled and
      // the heap was collected again. On a runtime this cold the delta is
      // dominated by setup garbage collected in passing, so it is not a
      // retention measurement; the record that reads it says so.
      const heapAfter = collectedHeapUsed();
      const nodesAfter = nodes.effects.size + nodes.computations.size;
      benchDiagnostic(JSON.stringify({
        size,
        workload,
        nodesBefore,
        nodesAfter,
        retainedBytes: heapBefore !== undefined && heapAfter !== undefined
          ? heapAfter - heapBefore
          : undefined,
        preflights,
        attempts,
      }));
      await prepared.dispose();
    }
  }
}

//
// Timed samples, with accounting disabled
//

// The variant whose runtime is live. A new variant's first sample disposes
// the previous one's runtime before preparing its own, so one runtime exists
// at a time and nothing an earlier variant allocated is retained across the
// next one's samples.
let live:
  | { key: string; prepared: Awaited<ReturnType<typeof prepare>> }
  | undefined;

// `Deno.bench` has no per-file teardown, so the last variant's runtime is
// disposed, as far as a synchronous handler can dispose it, when the process
// unloads.
globalThis.addEventListener("unload", () => {
  live?.prepared.dispose();
});

for (const size of SIZES) {
  for (const workload of WORKLOADS) {
    const key = `${size}/${workload}`;
    let dispatches = 0;
    Deno.bench({
      name: `${workload} (${size} rows)`,
      group: `handler-dispatch-${size}`,
      baseline: workload === "scalarKey",
      n: 7,
      warmup: 1,
      async fn(b) {
        if (live?.key !== key) {
          await live?.prepared.dispose();
          live = { key, prepared: await prepare(size, false) };
        }
        const { prepared } = live;
        if (dispatches > 0) await prepared.reseed(workload);
        const before = phaseTotals();
        b.start();
        const elapsed = await prepared.dispatch(workload);
        b.end();
        // Snapshot before the drain, so the phase window is the elapsed one:
        // the handler action and the commit's synchronous steps end before
        // the callback fires, and the drain adds nothing these keys time.
        const phases = phaseDeltas(before, phaseTotals());
        await prepared.drain();
        dispatches += 1;
        const value = prepared.out.get();
        const expected = prepared.expected(workload);
        if (value !== expected) {
          throw new Error(`Expected ${expected}, received ${value}`);
        }
        benchDiagnostic(JSON.stringify({
          size,
          workload,
          dispatch: dispatches,
          elapsed,
          phases,
        }));
      },
    });
  }
}
