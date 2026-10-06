// Backpressure for committed writes under sustained contention.
//
// A committed write that represents real user intent must converge or fail
// loudly; it must never be silently dropped because a fixed retry budget ran
// out before the contention cleared. These tests drive the event-handler commit
// path against an emulated server that rejects commits on demand:
//
//   1. A burst of transient conflicts longer than the old fixed budget still
//      lets the write land.
//   2. The default backoff curve is near-immediate at first and reaches 25ms by
//      the seventh attempt.
//   3. A permanent rejection is not retried (no infinite loop) and stays
//      observable.
//   4. A transient conflict that never clears surfaces a terminal error within
//      the retry window instead of vanishing.
//   5. A zero-window policy fails the first conflict loudly without dropping it
//      silently.
//   6. Three array appends survive a conflict storm so the durable count reaches
//      three (the profile-append bug in miniature).

import { defer } from "@commonfabric/utils/defer";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";

import { resolveLink } from "../src/link-resolution.ts";
import {
  computeBackoffDelayMs,
  resolveCommitBackpressure,
} from "../src/scheduler/backpressure.ts";
import {
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  Runtime,
  space,
} from "./scheduler-test-utils.ts";
import type {
  Cell,
  ErrorWithContext,
  IExtendedStorageTransaction,
  RuntimeTelemetryMarker,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

type TransactMessage = { requestId: string };
type TransactResponse = {
  type: "response";
  requestId: string;
  ok?: unknown;
  error?: { name: string; message: string; precondition?: string };
};
type PublishTransactVerdict = (response: TransactResponse) => void;
type TestMemoryServer = {
  transact(
    message: TransactMessage,
    publishVerdict?: PublishTransactVerdict,
  ): Promise<TransactResponse>;
};

function emulatedServer(
  storageManager: SchedulerTestStorageManager,
): TestMemoryServer {
  return (storageManager as unknown as { server(): TestMemoryServer }).server();
}

/**
 * Rejects server commits with `error` until `predicate(rejected)` returns false,
 * then passes through to the real server. Returns the number of rejections
 * issued and a restore function. `count: Infinity` rejects every commit.
 */
function rejectServerTransacts(
  storageManager: SchedulerTestStorageManager,
  count: number,
  error: { name: string; message: string; precondition?: string },
): { rejected: () => number; restore: () => void } {
  const server = emulatedServer(storageManager);
  const original = server.transact.bind(server);
  let rejected = 0;
  server.transact = (message, publishVerdict) => {
    if (rejected < count) {
      rejected++;
      const response: TransactResponse = {
        type: "response",
        requestId: message.requestId,
        error,
      };
      publishVerdict?.(response);
      return Promise.resolve(response);
    }
    return original(message, publishVerdict);
  };
  return {
    rejected: () => rejected,
    restore: () => {
      server.transact = original;
    },
  };
}

function collectEventCommitMarkers(runtime: Runtime): {
  markers: RuntimeTelemetryMarker[];
  firstMarker: Promise<void>;
  dispose(): void;
} {
  const markers: RuntimeTelemetryMarker[] = [];
  const firstMarker = defer<void>();
  const listener = (event: Event) => {
    const marker = (event as CustomEvent<{
      marker: RuntimeTelemetryMarker;
    }>).detail.marker;
    if (marker.type === "scheduler.event.commit") {
      markers.push(marker);
      firstMarker.resolve();
    }
  };
  runtime.telemetry.addEventListener("telemetry", listener);
  return {
    markers,
    firstMarker: firstMarker.promise,
    dispose: () => runtime.telemetry.removeEventListener("telemetry", listener),
  };
}

function schedulerWarningCount(): number {
  return getLoggerCountsBreakdown().scheduler?.scheduler?.warn ?? 0;
}

async function waitFor(
  runtime: Runtime,
  condition: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition() && performance.now() < deadline) {
    await runtime.idle();
    await clock.tick(1);
  }
  if (!condition()) {
    throw new Error(message);
  }
}

/**
 * Builds a piece with a single effect handler that adds the event value to a
 * running total. The handler's commit is the committed write under test.
 */
function buildCounterPiece(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  label: string,
): {
  total: () => number;
  invocations: () => number;
  queueAdd: (value: number, eventId: string) => void;
} {
  const { commonfabric } = createTrustedBuilder(runtime);
  const { cell, handler, pattern } = commonfabric;
  let invocations = 0;
  const recordEvent = handler<
    { value: number },
    { effects: Cell<{ total: number }> }
  >(
    true,
    {
      type: "object",
      properties: { effects: { type: "object", asCell: ["cell"] } },
    },
    (event, { effects }) => {
      invocations++;
      const total = effects.key("total");
      total.set(total.get() + event.value);
    },
  );
  // Expose the stored effects cell directly so the running total can be read
  // synchronously without pulling a computation (pull-mode computations do not
  // run without a subscriber).
  const rootPattern = pattern(() => {
    const effects = cell({ total: 0 });
    return { effects, stream: recordEvent({ effects }) };
  });
  const rootCell = runtime.getCell<
    { effects: { total: number }; stream: unknown }
  >(space, label, undefined, tx);
  const root = runtime.run(tx, rootPattern, {}, rootCell);

  const streamLink = () =>
    resolveLink(
      runtime,
      runtime.readTx(),
      root.key("stream").getAsNormalizedFullLink(),
    );

  return {
    total: () => (root.key("effects").key("total") as Cell<number>).get() ?? 0,
    invocations: () => invocations,
    queueAdd: (value, eventId) => {
      runtime.scheduler.queueEvent(
        streamLink(),
        { value },
        undefined,
        undefined,
        false,
        { eventId },
      );
    },
  };
}

/**
 * Builds a piece whose handler appends the event value to a stored array with a
 * whole-array set (`list = [...list, value]`) — the shape of the profile-append
 * bug, where each append rewrites the list entity and so conflicts with any
 * concurrent writer that bumped the entity's basis sequence.
 */
function buildListPiece(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  label: string,
): {
  list: () => readonly number[];
  invocations: () => number;
  queueAppend: (value: number, eventId: string) => void;
} {
  const { commonfabric } = createTrustedBuilder(runtime);
  const { cell, handler, pattern } = commonfabric;
  let invocations = 0;
  const appendEvent = handler<
    { value: number },
    { effects: Cell<{ list: number[] }> }
  >(
    true,
    {
      type: "object",
      properties: { effects: { type: "object", asCell: ["cell"] } },
    },
    (event, { effects }) => {
      invocations++;
      const list = effects.key("list");
      list.set([...(list.get() ?? []), event.value]);
    },
  );
  const rootPattern = pattern(() => {
    const effects = cell<{ list: number[] }>({ list: [] });
    return { effects, stream: appendEvent({ effects }) };
  });
  const rootCell = runtime.getCell<
    { effects: { list: number[] }; stream: unknown }
  >(space, label, undefined, tx);
  const root = runtime.run(tx, rootPattern, {}, rootCell);

  const streamLink = () =>
    resolveLink(
      runtime,
      runtime.readTx(),
      root.key("stream").getAsNormalizedFullLink(),
    );

  return {
    list: () => (root.key("effects").key("list") as Cell<number[]>).get() ?? [],
    invocations: () => invocations,
    queueAppend: (value, eventId) => {
      runtime.scheduler.queueEvent(
        streamLink(),
        { value },
        undefined,
        undefined,
        false,
        { eventId },
      );
    },
  };
}

describe("committed-write backpressure", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
      {
        experimental: { commitPreconditions: true },
        // Fast backoff so retries do not stretch the test; the window is wide
        // enough for the conflict burst to clear in tests 1 and 2.
        commitBackpressure: {
          baseDelayMs: 1,
          maxDelayMs: 4,
          jitter: 0,
          retryWindowMs: 60_000,
        },
      },
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  it(
    "lands a write after a burst of transient conflicts longer than the old fixed budget",
    async () => {
      const piece = buildCounterPiece(runtime, tx, "backpressure-burst-root");
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.idle();

      const terminalErrors: ErrorWithContext[] = [];
      runtime.scheduler.onError((error) => terminalErrors.push(error));

      // Eight conflicts: well past the old fixed budget of five. That path gave
      // up after ~6 attempts and dropped the write; the window keeps retrying.
      const injector = rejectServerTransacts(storageManager, 8, {
        name: "ConflictError",
        message: "forced transient conflict",
      });

      try {
        piece.queueAdd(3, "evt:backpressure-burst:0:backpressure-burst-root");

        await waitFor(
          runtime,
          () => piece.total() === 3,
          `write did not land after transient conflicts ` +
            `(total=${piece.total()}, rejected=${injector.rejected()}, ` +
            `invocations=${piece.invocations()})`,
        );

        expect(piece.total()).toBe(3);
        expect(injector.rejected()).toBe(8);
        // The handler re-ran for each failed attempt plus the success.
        expect(piece.invocations()).toBeGreaterThanOrEqual(9);
        // The write converged, so no terminal error.
        expect(terminalErrors).toHaveLength(0);
      } finally {
        injector.restore();
      }
    },
  );

  it(
    "does not warn when a transient conflict converges on retry",
    async () => {
      const piece = buildCounterPiece(runtime, tx, "backpressure-warning-root");
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.idle();

      const warningBaseline = schedulerWarningCount();
      const injector = rejectServerTransacts(storageManager, 1, {
        name: "ConflictError",
        message: "forced transient conflict",
      });
      const converged = defer<void>();
      const listener = (event: Event) => {
        const marker = (event as CustomEvent<{
          marker: RuntimeTelemetryMarker;
        }>).detail.marker;
        if (
          marker.type === "scheduler.event.commit" &&
          marker.error === undefined
        ) {
          converged.resolve();
        }
      };
      runtime.telemetry.addEventListener("telemetry", listener);

      try {
        piece.queueAdd(
          3,
          "evt:backpressure-warning:0:backpressure-warning-root",
        );

        await converged.promise;
        await runtime.idle();

        expect(piece.total()).toBe(3);
        expect(injector.rejected()).toBe(1);
        expect(schedulerWarningCount() - warningBaseline).toBe(0);
      } finally {
        runtime.telemetry.removeEventListener("telemetry", listener);
        injector.restore();
      }
    },
  );

  it(
    "drops a write on a non-stale-basis transient error rather than windowing it",
    async () => {
      // Only a stale basis (a ConflictError, or a StorageTransactionInconsistent)
      // is windowed, because only a stale basis converges by re-running. A
      // non-permanent rejection that is not a stale basis — the server normalizes
      // an unrecognized rejection name to "TransactionError" — cannot be resolved
      // by re-running, so it fails fast: the handler runs once, the write drops,
      // and the retry window is never entered.
      const piece = buildCounterPiece(
        runtime,
        tx,
        "backpressure-nonstalebasis-root",
      );
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.idle();

      const terminalErrors: ErrorWithContext[] = [];
      runtime.scheduler.onError((error) => terminalErrors.push(error));

      // Reject every commit with a non-stale-basis error. Were it wrongly
      // windowed, the handler would re-run and ride past these injections.
      const injector = rejectServerTransacts(storageManager, 8, {
        name: "TransientCommitError",
        message: "forced non-stale-basis transient error",
      });

      try {
        piece.queueAdd(
          4,
          "evt:backpressure-nonstalebasis:0:backpressure-nonstalebasis-root",
        );

        // Give any erroneous retry a chance to run, then confirm none did.
        await runtime.idle();
        await clock.tick(30);
        await runtime.idle();

        // Failed fast: the handler ran exactly once (no windowed re-queue) and
        // the write did not land.
        expect(piece.invocations()).toBe(1);
        expect(piece.total()).toBe(0);
        // A fast-fail drop is not a terminal convergence error.
        expect(terminalErrors).toHaveLength(0);
      } finally {
        injector.restore();
      }
    },
  );

  it(
    "default backoff curve: first retries are sub-5ms, reaching 25ms by the seventh attempt",
    () => {
      // One exponential curve, no immediate-retry special case: the early steps
      // are near-immediate (sub-5ms) so a transient conflict converges fast, and
      // the delay before the seventh attempt is 25ms, then doubles to the cap.
      // random() === 0 removes the jitter reduction so we read the nominal curve.
      const policy = resolveCommitBackpressure();
      const step = (attempt: number) =>
        computeBackoffDelayMs(attempt, policy, () => 0);

      // The park before attempt N is step(N - 1).
      expect(step(1)).toBeLessThan(5); // before attempt 2
      expect(step(2)).toBeLessThan(5); // before attempt 3
      expect(step(3)).toBeLessThan(5); // before attempt 4
      expect(step(6)).toBe(25); // before the 7th attempt
      expect(step(7)).toBe(50);
      expect(step(8)).toBe(100);
      // Capped at maxDelayMs.
      expect(step(20)).toBe(policy.maxDelayMs);
    },
  );

  it(
    "does not retry a permanent rejection and keeps it observable",
    async () => {
      const piece = buildCounterPiece(
        runtime,
        tx,
        "backpressure-permanent-root",
      );
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.idle();

      const commitTelemetry = collectEventCommitMarkers(runtime);
      // receipt-exists is a permanent precondition failure (idempotent
      // dedup): retrying it would double-handle the event.
      const injector = rejectServerTransacts(storageManager, Infinity, {
        name: "PreconditionFailedError",
        message: "forced permanent rejection",
        precondition: "receipt-exists",
      });

      try {
        piece.queueAdd(
          5,
          "evt:backpressure-permanent:0:backpressure-permanent-root",
        );

        await commitTelemetry.firstMarker;
        // Give any erroneous retry a chance to run, then confirm none did.
        await runtime.idle();
        await clock.tick(30);
        await runtime.idle();

        // The handler ran once; a permanent rejection must not re-run it.
        expect(piece.invocations()).toBe(1);
        // The write did not land (the dedup is the whole point).
        expect(piece.total()).toBe(0);
        // The permanent rejection is observable via commit telemetry.
        expect(
          commitTelemetry.markers.some((marker) =>
            (marker as { permanentRejection?: string }).permanentRejection ===
              "receipt-exists"
          ),
        ).toBe(true);
      } finally {
        injector.restore();
        commitTelemetry.dispose();
      }
    },
  );

  it(
    "does not retry a terminal commit-rule rejection (RowLabelCommitError) and stops after one run",
    async () => {
      // A server-side commit-time row-label violation (E4 Phase 3.c,
      // memory/v2/sqlite/commit-eval.ts `RowLabelCommitError`) rolls back the
      // whole commit and can NEVER succeed on retry: re-running the identical
      // handler recomputes the identical refused write. Unlike a stale-read
      // ConflictError, it must not consume the retry budget — each doomed
      // re-run's speculative rev bumps starve concurrent sibling commits that
      // share reactive state (the E4 3.c integration test masked this with a
      // between-sends drain). It must therefore run exactly once, like a
      // permanent rejection.
      const piece = buildCounterPiece(
        runtime,
        tx,
        "backpressure-terminal-root",
      );
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.idle();

      const terminalErrors: ErrorWithContext[] = [];
      runtime.scheduler.onError((error) => terminalErrors.push(error));
      const commitTelemetry = collectEventCommitMarkers(runtime);

      const injector = rejectServerTransacts(storageManager, Infinity, {
        name: "RowLabelCommitError",
        message:
          "sqlite commit refused: rowLabel rule rejected committed row " +
          '(rowid 1) of table "emails"',
      });

      try {
        piece.queueAdd(
          4,
          "evt:backpressure-terminal:0:backpressure-terminal-root",
        );

        await commitTelemetry.firstMarker;
        // Give any erroneous retry a generous chance to run (a bounded-retry
        // misclassification would re-run the handler up to
        // DEFAULT_RETRIES_FOR_EVENTS more times), then confirm none did.
        await runtime.idle();
        await clock.tick(50);
        await runtime.idle();

        // The doomed handler ran exactly once — no retry budget consumed.
        expect(piece.invocations()).toBe(1);
        // The refused write did not land.
        expect(piece.total()).toBe(0);
        // A terminal deterministic refusal is reported, not silently dropped.
        expect(
          commitTelemetry.markers.some((marker) =>
            (marker as { terminal?: string }).terminal === "rule"
          ),
        ).toBe(true);
      } finally {
        injector.restore();
        commitTelemetry.dispose();
      }
    },
  );

  it(
    "does not mistake a RowLabel verdict with CFC-like text for a boundary refusal",
    async () => {
      // OW54 routes a RowLabel verdict through the proven-no-commit terminal
      // cover. Keep the older client-side CFC reporting arm keyed to its exact
      // error name: overlapping prose is not a type discriminator.
      const piece = buildCounterPiece(
        runtime,
        tx,
        "backpressure-cfc-refusal-root",
      );
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.idle();

      const commitTelemetry = collectEventCommitMarkers(runtime);
      const injector = rejectServerTransacts(storageManager, Infinity, {
        name: "RowLabelCommitError",
        message: "CFC enforcement rejected commit: relevant transaction was " +
          "not prepared: writer-fit confidentiality misfit",
      });
      const reported: unknown[][] = [];
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        reported.push(args);
      };

      try {
        piece.queueAdd(
          4,
          "evt:backpressure-cfc-refusal:0:backpressure-cfc-refusal-root",
        );
        await commitTelemetry.firstMarker;
        await runtime.idle();

        // The refused write did not land, but this is not the client-side CFC
        // refusal that owns the legacy report.
        expect(piece.total()).toBe(0);
        expect(
          reported.some((args) =>
            String(args[0]).includes("Owner-protected write dropped")
          ),
        ).toBe(false);
      } finally {
        console.error = originalConsoleError;
        injector.restore();
        commitTelemetry.dispose();
      }
    },
  );

  it(
    "surfaces a terminal error when a transient conflict never converges",
    async () => {
      await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
      ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
        import.meta.url,
        {
          experimental: { commitPreconditions: true },
          // Short window so the non-converging case fails loudly fast.
          commitBackpressure: {
            baseDelayMs: 1,
            maxDelayMs: 2,
            jitter: 0,
            retryWindowMs: 40,
          },
        },
      ));

      const piece = buildCounterPiece(
        runtime,
        tx,
        "backpressure-stuck-root",
      );
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.idle();

      const terminalErrors: ErrorWithContext[] = [];
      const gotConvergenceError = defer<void>();
      runtime.scheduler.onError((error) => {
        terminalErrors.push(error);
        if (error.name === "CommitConvergenceError") {
          gotConvergenceError.resolve();
        }
      });

      // Reject every commit: the conflict never clears.
      const injector = rejectServerTransacts(storageManager, Infinity, {
        name: "ConflictError",
        message: "forced unending conflict",
      });

      try {
        piece.queueAdd(7, "evt:backpressure-stuck:0:backpressure-stuck-root");

        await gotConvergenceError.promise;

        const convergence = terminalErrors.find((error) =>
          error.name === "CommitConvergenceError"
        );
        expect(convergence).toBeDefined();
        // The write never landed, but it failed loudly rather than silently.
        expect(piece.total()).toBe(0);
        // Bounded resource use: the retry window capped the attempt count.
        expect(piece.invocations()).toBeGreaterThan(1);
        expect(piece.invocations()).toBeLessThan(500);
      } finally {
        injector.restore();
      }
    },
  );

  it(
    "fails a zero-window conflict loudly on the first attempt without dropping silently",
    async () => {
      // A clamped policy can resolve to retryWindowMs: 0. That does not
      // reintroduce a silent drop: the first conflict surfaces a terminal error
      // and the handler is not retried.
      await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
      ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
        import.meta.url,
        {
          experimental: { commitPreconditions: true },
          commitBackpressure: { retryWindowMs: 0 },
        },
      ));

      const piece = buildCounterPiece(runtime, tx, "backpressure-zerowin-root");
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.idle();

      const terminalErrors: ErrorWithContext[] = [];
      const gotConvergenceError = defer<void>();
      runtime.scheduler.onError((error) => {
        terminalErrors.push(error);
        if (error.name === "CommitConvergenceError") {
          gotConvergenceError.resolve();
        }
      });

      const injector = rejectServerTransacts(storageManager, Infinity, {
        name: "ConflictError",
        message: "forced conflict against a zero window",
      });

      try {
        piece.queueAdd(
          9,
          "evt:backpressure-zerowin:0:backpressure-zerowin-root",
        );

        await gotConvergenceError.promise;

        // Give any erroneous retry a chance to run, then confirm none did.
        await runtime.idle();
        await clock.tick(20);
        await runtime.idle();

        // Loud, not silent: a terminal error surfaced.
        expect(
          terminalErrors.some((error) =>
            error.name === "CommitConvergenceError"
          ),
        ).toBe(true);
        // No retry: the handler ran exactly once and the write did not land.
        expect(piece.invocations()).toBe(1);
        expect(piece.total()).toBe(0);
      } finally {
        injector.restore();
      }
    },
  );

  it(
    "lands all three array appends through a conflict storm (durable count reaches 3)",
    async () => {
      // The profile-append-during-rehydration bug in miniature: three whole-
      // array appends issued while the entity is churned by a burst of conflicts.
      // Each append rewrites the list, so a stale basis sequence rejects it.
      const piece = buildListPiece(runtime, tx, "backpressure-list-root");
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.idle();

      const terminalErrors: ErrorWithContext[] = [];
      runtime.scheduler.onError((error) => terminalErrors.push(error));

      // A burst longer than the old fixed budget. The old path drops the first
      // append after ~6 attempts, leaving a durable count of 1.
      const injector = rejectServerTransacts(storageManager, 8, {
        name: "ConflictError",
        message: "forced rehydration conflict storm",
      });

      try {
        piece.queueAppend(1, "evt:backpressure-list:0:backpressure-list-root");
        piece.queueAppend(2, "evt:backpressure-list:1:backpressure-list-root");
        piece.queueAppend(3, "evt:backpressure-list:2:backpressure-list-root");

        await waitFor(
          runtime,
          () => piece.list().length === 3,
          `not all appends landed (list=${JSON.stringify(piece.list())}, ` +
            `rejected=${injector.rejected()})`,
        );

        expect(piece.list()).toEqual([1, 2, 3]);
        expect(terminalErrors).toHaveLength(0);
      } finally {
        injector.restore();
      }
    },
  );
});
