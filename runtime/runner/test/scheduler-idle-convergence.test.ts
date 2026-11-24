// idle() convergence-hold tests (scheduler-v2 F1).
//
// The settle loop caps a pass at MAX_ITERS iterations and, when a live subgraph
// is still churning at the cap, defers its frontier with a convergence backoff
// wake (~BACKOFF_BASE_MS later). That backoff is the deliberate escape valve
// that lets idle() resolve for a genuinely non-converging (cyclic) subgraph.
//
// F1 (fixed here): a backoff-deferred RE-RUN of an already-ran DEMANDED
// COMPUTATION whose downstream effect is still CLEAN at cap time used to block
// nothing, so idle() resolved mid-wave and callers sampled a pre-convergence
// graph — the effect only ran on the later backoff wake. The fix holds idle()
// open for such a deferred computation, but only for a bounded number of
// consecutive backoff passes (CONVERGENCE_IDLE_HOLD_MAX_BACKOFF_PASSES), so a
// true cycle still resolves idle() via the escape valve.

import { stub } from "@std/testing/mock";
import {
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  getStaleSchedulerInternals,
  it,
  Runtime,
  space,
  toMemorySpaceAddress,
} from "./scheduler-test-utils.ts";
import type {
  Action,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import { MAX_ITERS } from "../src/scheduler/constants.ts";
import { RuntimeTelemetryEvent } from "../src/telemetry.ts";

function addr(cell: { getAsNormalizedFullLink(): unknown }): ReturnType<
  typeof toMemorySpaceAddress
> {
  // deno-lint-ignore no-explicit-any
  return toMemorySpaceAddress((cell as any).getAsNormalizedFullLink());
}

// Race idle() against a wall-clock deadline so a hang surfaces as a value
// instead of wedging the test runner.
async function idleWithin(
  runtime: Runtime,
  ms: number,
): Promise<{ resolved: boolean; elapsed: number }> {
  const t0 = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((res) => {
    timer = setTimeout(() => res("timeout"), ms);
  });
  const result = await Promise.race([
    runtime.idle().then(() => "idle" as const),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
  return {
    resolved: result === "idle",
    elapsed: Math.round(performance.now() - t0),
  };
}

describe("idle convergence hold", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  it("holds idle() until a slow (> MAX_ITERS) convergence wave reaches its effect", async () => {
    // A churning head computation drives a short declared chain to an effect.
    // The head re-runs itself PASS_RUN_BUDGET times per settle pass and reaches
    // its converged value only after several passes (TARGET > 2*MAX_ITERS), so
    // pass 1 hits the settle cap with the head backoff-deferred and the chain's
    // tail effect still holding a pre-convergence value. Before the fix, idle()
    // resolved here (the deferred already-ran head "blocks nothing") and a
    // caller sampled the stale effect; after the fix idle() stays open until the
    // wave converges. TARGET's pass count (~TARGET/MAX_ITERS) stays well under
    // the convergence-hold budget, so the escape valve does not fire.
    const stale = getStaleSchedulerInternals(runtime.scheduler);
    const TARGET = 25;
    const DEPTH = 3;
    expect(TARGET).toBeGreaterThan(2 * MAX_ITERS);
    const nonSettlingMarkers: unknown[] = [];
    const onTelemetry = (event: Event) => {
      const marker = (event as RuntimeTelemetryEvent).marker;
      if (marker.type === "scheduler.non-settling") {
        nonSettlingMarkers.push(marker);
      }
    };
    runtime.telemetry.addEventListener("telemetry", onTelemetry);

    const cells = Array.from(
      { length: DEPTH + 1 },
      (_, i) => runtime.getCell<number>(space, `conv-${i}`, undefined, tx),
    );
    for (const c of cells) c.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let step = 0;
    const head: Action = (t) => {
      step++;
      cells[0].withTx(t).send(step);
      if (step < TARGET) stale.markDirty(head); // re-run until converged
    };
    runtime.scheduler.subscribe(head, {
      reads: [],
      shallowReads: [],
      writes: [addr(cells[0])],
    }, {});

    for (let i = 1; i <= DEPTH; i++) {
      const src = cells[i - 1];
      const dst = cells[i];
      const relay: Action = (t) => {
        dst.withTx(t).send(src.withTx(t).get() ?? 0);
      };
      runtime.scheduler.subscribe(relay, {
        reads: [addr(src)],
        shallowReads: [],
        writes: [addr(dst)],
      }, {});
    }

    let observed: number | undefined;
    const effect: Action = (t) => {
      observed = cells[DEPTH].withTx(t).get();
    };
    runtime.scheduler.subscribe(effect, {
      reads: [addr(cells[DEPTH])],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });

    const warn = stub(console, "warn", () => {});
    let r: Awaited<ReturnType<typeof idleWithin>>;
    try {
      r = await idleWithin(runtime, 5000);
    } finally {
      warn.restore();
    }
    runtime.telemetry.removeEventListener("telemetry", onTelemetry);
    step = TARGET; // belt-and-braces: stop churn before teardown

    // idle() must have waited for the wave to fully converge, not sampled a
    // mid-flight (pre-fix: observed === MAX_ITERS) value.
    expect(r.resolved).toBe(true);
    expect(observed).toBe(TARGET);
    expect(nonSettlingMarkers.length).toBeGreaterThan(0);
  });

  it("still resolves idle() for a genuinely non-converging cycle (escape valve)", async () => {
    // A head computation that self-re-dirties FOREVER, demanded by a downstream
    // effect it feeds. The subgraph never settles, so every settle pass hits the
    // cap and applies convergence backoff. idle() is held while the convergence
    // budget lasts, then the escape valve releases it — it must resolve in
    // bounded time rather than hang. (Before the fix this class of cycle — whose
    // deferred sink is a perpetually-invalid effect — wedged idle() forever.)
    const stale = getStaleSchedulerInternals(runtime.scheduler);
    const mid = runtime.getCell<number>(space, "cyc-mid", undefined, tx);
    mid.set(0);
    const out = runtime.getCell<number>(space, "cyc-out", undefined, tx);
    out.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let step = 0;
    let stop = false;
    const nonConvergingHead: Action = (t) => {
      step++;
      mid.withTx(t).send(step);
      if (!stop) stale.markDirty(nonConvergingHead); // never converges
    };
    runtime.scheduler.subscribe(nonConvergingHead, {
      reads: [],
      shallowReads: [],
      writes: [addr(mid)],
    }, {});

    const effect: Action = (t) => {
      out.withTx(t).send(mid.withTx(t).get() ?? 0);
    };
    runtime.scheduler.subscribe(effect, {
      reads: [addr(mid)],
      shallowReads: [],
      writes: [addr(out)],
    }, { isEffect: true });

    const warnings: unknown[][] = [];
    const warn = stub(console, "warn", (...args: unknown[]) => {
      warnings.push(args);
    });
    let r: Awaited<ReturnType<typeof idleWithin>>;
    try {
      r = await idleWithin(runtime, 6000);
      stop = true; // let the subgraph settle so teardown is prompt
    } finally {
      warn.restore();
    }

    expect(r.resolved).toBe(true);
    const diagnostic = warnings
      .map((args) => args.map(String).join(" "))
      .filter((line) => line.includes("Reactive graph did not settle"));
    expect(diagnostic).toHaveLength(1);
    expect(diagnostic[0]).toContain("nonConvergingHead");
    expect(diagnostic[0]).toContain("detectNonIdempotent");
  });
});
