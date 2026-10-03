import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import type { CommitError } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("wish built-in tests");
const space = signer.did();

describe("interval #now wish", () => {
  // The `#now/N` grid ticks on a recurring wall-clock-boundary timer. These
  // cases observe the grid value advancing across a boundary, driving the beat
  // with `clock.tick` and reading the coarsened value before and after. They
  // are split out of `wish.test.ts` because the grid's heartbeat and its shared
  // result cell carry state across a suite's cases: run alongside the ~30 other
  // `#now` cases, the beat fires but the observed value stays frozen. In their
  // own file each case starts from a clean grid.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: ReturnType<Runtime["edit"]>;
  let wish: ReturnType<typeof createBuilder>["commonfabric"]["wish"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

  beforeEach(() => {
    // One frozen clock wraps the whole describe; these cases read absolute
    // coarsened time, so start each from logical zero.
    clock.reset();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ wish, pattern } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  });

  it("#now/1 ticks and updates value", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/1" }) };
    });

    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "ticking now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();
    const initial = result.key("nowValue").get()?.result;
    expect(typeof initial).toBe("number");
    expect(initial! % 1000).toBe(0);

    // Advance one second: the interval fires, the value re-coarsens, and the
    // reactive read reflects the next grid instant.
    await clock.tick(1000);
    await result.pull();
    const updated = result.key("nowValue").get()?.result;
    expect(updated).toBeGreaterThan(initial!);
    expect(updated! % 1000).toBe(0);

    runtime.runner.stop(resultCell);
  });

  it("writes the current instant when the grid cell holds a past one", async () => {
    // The grid cell is content-addressed by space and interval, so it outlives
    // the timer that ticks it: a reload, or another tab that has stopped,
    // leaves it holding whatever instant that session last wrote. The wish that
    // acquires the grid next writes the current instant straight away rather
    // than serving the past one until the boundary, which at this interval is
    // a minute off — so the instant the cell takes on names which of the two
    // wrote it.
    const intervalMs = 60_000;
    const current = Math.floor(Date.now() / intervalMs) * intervalMs;
    const stale = current - intervalMs;

    const gridCell = runtime.getCell<number>(
      space,
      { wish: { now: true, interval: intervalMs } },
      undefined,
      tx,
    );
    gridCell.set(stale);
    await tx.commit();
    tx = runtime.edit();

    const { promise: republished, resolve } = Promise.withResolvers<number>();
    const cancelSink = gridCell.sink((value) => {
      if (typeof value === "number" && value !== stale) resolve(value);
    });

    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/60" }) };
    });

    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "stale grid now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();
    expect(await republished).toBe(current);

    cancelSink();
    runtime.runner.stop(resultCell);
    // The acquire's own write is issued outside the action's transaction, so
    // let it reach storage before the case tears that storage down under it.
    // After the stop, never before: while the grid still holds a user its
    // boundary timer re-arms itself, and `settled()` would advance the clock
    // through one interval after another until the runaway ceiling trips.
    await runtime.settled();
  });

  it("reports a failed #now interval tick", async () => {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/1" }) };
    });

    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "failed interval now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    const failure = {
      name: "StorageTransactionAborted" as const,
      message: "interval tick failed",
      reason: "interval tick failed",
    } satisfies CommitError;
    const reported: unknown[][] = [];
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const originalConsoleError = console.error;
    runtime.editWithRetry =
      (() =>
        Promise.resolve({ error: failure })) as typeof runtime.editWithRetry;
    console.error = (...args: unknown[]) => {
      if (args[0] === "[wish] #now interval tick failed:") {
        reported.push(args);
      } else {
        originalConsoleError(...args);
      }
    };

    try {
      await clock.tick(1000);
      expect(reported).toEqual([[
        "[wish] #now interval tick failed:",
        failure,
      ]]);
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
      console.error = originalConsoleError;
      runtime.runner.stop(resultCell);
    }
  });

  // The cases below share this: an interval grid ticking, with every tick's
  // commit answered by `failure` instead of reaching storage, collecting both
  // report prefixes the tick writes. `attempts` counts the ticks that tried to
  // commit, `reported` what each of them said.
  async function stubbedInterval(
    resultName: string,
    failure: CommitError,
  ): Promise<{
    attempts: () => number;
    reported: () => string[];
    grid: () => number | undefined;
    unstub: () => void;
    stopPiece: () => void;
  }> {
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/1" }) };
    });

    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      resultName,
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();

    let attempts = 0;
    let restored = false;
    const reported: string[] = [];
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const originalConsoleError = console.error;
    runtime.editWithRetry = (() => {
      attempts++;
      return Promise.resolve({ error: failure });
    }) as typeof runtime.editWithRetry;
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith("[wish] #now ")) {
        reported.push(args[0]);
      } else {
        originalConsoleError(...args);
      }
    };

    return {
      attempts: () => attempts,
      reported: () => [...reported],
      grid: () => result.key("nowValue").get()?.result,
      unstub: () => {
        if (restored) return;
        restored = true;
        runtime.editWithRetry = originalEditWithRetry;
        console.error = originalConsoleError;
      },
      stopPiece: () => runtime.runner.stop(resultCell),
    };
  }

  // A refusal from the CFC boundary, the shape `rejectCommitBeforeStorage`
  // mints: a verdict on the labels the transaction carries, which the instant
  // the tick writes has no part in.
  const CFC_REFUSAL = {
    name: "CfcCommitRefusalError" as const,
    message: "CFC enforcement rejected commit: relevant transaction was " +
      "not prepared: writer-fit confidentiality misfit for of:grid at / " +
      "(canWrite, §8.12.4)",
    reasons: [
      "writer-fit confidentiality misfit for of:grid at / " +
      "(canWrite, §8.12.4)",
    ],
    refusals: [],
  } satisfies CommitError;

  it(
    "stops the #now interval after a refusal from the CFC boundary",
    async () => {
      // The next tick would carry the same labels to the same cell and be
      // refused the same way, so the beat stops on the first one and says so
      // once.
      //
      // `clock.tick` fires every timer armed for the second it advances
      // through, so the three boundaries after the refusal are the ones a
      // still-armed interval would have been carried into. Their silence is
      // the assertion; no wall-clock wait stands behind it.
      const stub = await stubbedInterval(
        "cfc refused interval now result",
        CFC_REFUSAL,
      );
      try {
        await clock.tick(1000);
        await clock.tick(1000);
        await clock.tick(1000);
        await clock.tick(1000);
        expect(stub.attempts()).toBe(1);
        expect(stub.reported()).toEqual([
          "[wish] #now interval tick refused; the tick is stopped:",
        ]);
      } finally {
        stub.unstub();
        stub.stopPiece();
      }
    },
  );

  it("a wish acquiring the interval after a refusal revives the beat", async () => {
    // The stop leaves the shared timer in place holding whoever still wants
    // the interval, so a stopped beat must not reach the instance that asks
    // for that interval next. That instance revives it, and the wish frozen
    // by the refusal comes forward with it.
    const stub = await stubbedInterval(
      "revived interval now result",
      CFC_REFUSAL,
    );
    const secondResultCell = runtime.getCell<
      { nowValue?: { result?: number } }
    >(
      space,
      "revived interval second result",
      undefined,
      tx,
    );
    try {
      const frozen = stub.grid()!;
      await clock.tick(1000);
      expect(stub.attempts()).toBe(1);
      stub.unstub();

      // Two more boundaries pass with nothing beating the cell, so the grid
      // is three instants ahead of what the first wish reads.
      await clock.tick(1000);
      await clock.tick(1000);
      expect(stub.grid()).toBe(frozen);
      expect(Math.floor(Date.now() / 1000) * 1000).toBe(frozen + 3000);

      const secondPattern = pattern(() => {
        return { nowValue: wish({ query: "#now/1" }) };
      });
      const second = runtime.run(tx, secondPattern, {}, secondResultCell);
      await tx.commit();
      tx = runtime.edit();
      await second.pull();

      expect(stub.grid()).toBe(frozen + 3000);

      // And the revived beat goes on ticking.
      await clock.tick(1000);
      expect(stub.grid()).toBe(frozen + 4000);
    } finally {
      stub.unstub();
      runtime.runner.stop(secondResultCell);
      stub.stopPiece();
    }
  });

  it("a refusal from a retired beat leaves the one that replaced it alone", async () => {
    // Two ticks are in flight at once when the first is refused, so the
    // second was armed under the generation that stop retires. By the time
    // it answers, another wish has revived the beat, and the beat it would
    // stop is not the one it belongs to. It says what it dropped and leaves
    // the timer running.
    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/1" }) };
    });
    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "retired beat interval now result",
      undefined,
      tx,
    );
    const secondResultCell = runtime.getCell<
      { nowValue?: { result?: number } }
    >(
      space,
      "retired beat second result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();
    await result.pull();

    // Every tick's commit waits for this test to answer it, which is what
    // lets two of them be in flight at the same time.
    const answers: ((answer: { error?: CommitError }) => void)[] = [];
    const reported: string[] = [];
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const originalConsoleError = console.error;
    runtime.editWithRetry = (() => {
      const { promise, resolve } = Promise.withResolvers<
        { error?: CommitError }
      >();
      answers.push(resolve);
      return promise;
    }) as typeof runtime.editWithRetry;
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith("[wish] #now ")) {
        reported.push(args[0]);
      } else {
        originalConsoleError(...args);
      }
    };

    try {
      await clock.tick(1000);
      await clock.tick(1000);
      expect(answers.length).toBe(2);

      // The first refusal stops the beat it belongs to.
      answers[0]({ error: CFC_REFUSAL });
      await clock.settle();
      expect(reported).toEqual([
        "[wish] #now interval tick refused; the tick is stopped:",
      ]);

      // A second wish revives it.
      const secondPattern = pattern(() => {
        return { nowValue: wish({ query: "#now/1" }) };
      });
      const second = runtime.run(tx, secondPattern, {}, secondResultCell);
      await tx.commit();
      tx = runtime.edit();
      await second.pull();
      const revived = answers.length;

      // Now the tick armed before the stop answers, with the same refusal.
      answers[1]({ error: CFC_REFUSAL });
      await clock.settle();
      expect(reported).toEqual([
        "[wish] #now interval tick refused; the tick is stopped:",
        "[wish] #now interval tick failed:",
      ]);

      // The revived beat is still beating.
      await clock.tick(1000);
      expect(answers.length).toBeGreaterThan(revived);
    } finally {
      // Nothing is waiting on the commits still outstanding; answering them
      // with no error lets their handlers finish as no-ops.
      for (const answer of answers) answer({});
      runtime.editWithRetry = originalEditWithRetry;
      console.error = originalConsoleError;
      runtime.runner.stop(secondResultCell);
      runtime.runner.stop(resultCell);
    }
  });

  // The two controls the case above rests on. Each rejection here reaches the
  // same `.then` and must leave the beat running: three boundaries, three
  // attempts. `ConflictError` says another writer reached the cell first, and
  // the next tick can win it. `SpeculativeBasisError` is terminal for its own
  // transaction — it sits beside the CFC refusal in
  // `TERMINAL_REJECTION_NAMES` — and names the next derivation as its own
  // recovery, so a beat is what performs that recovery.
  //
  // Each fixture carries the name and the message and not the commit fields
  // the real rejection also holds, which is what the cast stands in for. The
  // tick reads the name; `storage/v2.ts` mints the speculative one through a
  // cast of its own.
  const KEEPS_BEATING: readonly { label: string; error: CommitError }[] = [
    {
      label: "a conflict",
      error: {
        name: "ConflictError",
        message: "stale confirmed read: of:grid at seq 1 conflicted with 2",
      } as unknown as CommitError,
    },
    {
      label: "a speculative basis refusal",
      error: {
        name: "SpeculativeBasisError",
        message: "authored commit refused: its read basis names speculative " +
          "overlay layer(s) 3",
      } as unknown as CommitError,
    },
  ];

  for (const { label, error } of KEEPS_BEATING) {
    it(`keeps the #now interval ticking through ${label}`, async () => {
      const stub = await stubbedInterval(
        `${label} interval now result`,
        error,
      );
      try {
        await clock.tick(1000);
        await clock.tick(1000);
        await clock.tick(1000);
        expect(stub.attempts()).toBe(3);
        expect(stub.reported()).toEqual([
          "[wish] #now interval tick failed:",
          "[wish] #now interval tick failed:",
          "[wish] #now interval tick failed:",
        ]);
      } finally {
        stub.unstub();
        stub.stopPiece();
      }
    });
  }

  it("#now interval keeps ticking when other dependencies change", async () => {
    // Regression: re-running the wish action (here via an unrelated cell the
    // pattern reads) must not reset or starve the shared interval timer.
    const triggerCell = runtime.getCell<number>(
      space,
      "tick collision trigger",
      undefined,
      tx,
    );
    triggerCell.set(0);

    const wishPattern = pattern(() => {
      triggerCell.get();
      return { nowValue: wish({ query: "#now/1" }) };
    });

    const resultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "collision now result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, wishPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    await result.pull();
    const initial = result.key("nowValue").get()?.result;
    expect(typeof initial).toBe("number");

    // Flip the trigger to re-run the wish action, then advance a second: the
    // shared interval must still fire and update the value regardless of the
    // unrelated re-run.
    triggerCell.withTx(tx).set(1);
    await tx.commit();
    tx = runtime.edit();

    await clock.tick(1000);
    await result.pull();
    const updated = result.key("nowValue").get()?.result;
    expect(updated).toBeGreaterThan(initial!);

    runtime.runner.stop(resultCell);
  });

  it("brings a stale grid cell forward when the timer is re-acquired", async () => {
    // The grid cell outlives the timer that ticks it: the last release stops
    // the timer and drops the registry entry, leaving the cell holding the
    // instant it last ticked. A later acquire therefore visits a cell that is
    // behind the grid once the clock crossed a boundary in between, and the
    // acquire brings it forward at once. A minute grid keeps the next boundary
    // far enough away that the acquire's own write is the only one this case
    // can see.
    const INTERVAL_MS = 60_000;
    const coarsen = (ms: number) => Math.floor(ms / INTERVAL_MS) * INTERVAL_MS;

    const wishPattern = pattern(() => {
      return { nowValue: wish({ query: "#now/60" }) };
    });

    const firstResultCell = runtime.getCell<{ nowValue?: { result?: number } }>(
      space,
      "stale grid first result",
      undefined,
      tx,
    );
    const first = runtime.run(tx, wishPattern, {}, firstResultCell);
    await tx.commit();
    tx = runtime.edit();

    await first.pull();
    const stale = first.key("nowValue").get()?.result;
    expect(stale).toBe(coarsen(Date.now()));

    // Last user gone: the timer stops, so nothing writes the cell across the
    // minute boundary that follows and it falls a grid instant behind.
    runtime.runner.stop(firstResultCell);
    await runtime.idle();
    await clock.tick(INTERVAL_MS);
    const current = coarsen(Date.now());
    expect(current).toBeGreaterThan(stale!);

    // The shared cell, addressed the way the timer addresses it, so that the
    // writes the re-acquire makes can be read in order.
    const gridCell = runtime.getCell<number>(
      space,
      { wish: { now: true, interval: INTERVAL_MS } },
      undefined,
      tx,
    );
    const observed: (number | undefined)[] = [];
    const cancelSink = gridCell.sink((value) => {
      observed.push(value);
    });

    const secondResultCell = runtime.getCell<
      { nowValue?: { result?: number } }
    >(
      space,
      "stale grid second result",
      undefined,
      tx,
    );
    const second = runtime.run(tx, wishPattern, {}, secondResultCell);
    await tx.commit();
    tx = runtime.edit();

    await second.pull();
    cancelSink();

    // Still inside the grid instant the acquire saw, so no boundary timer can
    // have fired: the second write is the acquire's own.
    expect(coarsen(Date.now())).toBe(current);
    expect(observed).toEqual([stale, current]);

    runtime.runner.stop(secondResultCell);
  });
});
