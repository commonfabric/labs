/// <reference path="./clock.d.ts" />
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import type { SessionReport } from "@commonfabric/memory/v2";

import { ECHO_TRIP_THRESHOLD } from "../src/scheduler/constants.ts";
import type { EchoStep } from "../src/scheduler/echo-breaker.ts";
import type {
  Action,
  EventHandler,
  SchedulerObservationIdentity,
} from "../src/scheduler/types.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { captureLogs } from "./support/captured-logs.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type Runtime,
  type SchedulerTestStorageManager,
  space,
  toMemorySpaceAddress,
} from "./scheduler-test-utils.ts";

const otherSpace = "did:key:z6MkOtherSpaceForFacadeCoverage" as MemorySpace;

describe("scheduler facade", () => {
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

  /** The link of a fresh event stream named `name`. */
  function streamLink(name: string) {
    return runtime.getCell<number>(space, name).getAsNormalizedFullLink();
  }

  /** A handler that counts its runs, carrying `identity` when given. */
  function countingHandler(
    identity?: SchedulerObservationIdentity,
  ): { handler: EventHandler; runs: { count: number } } {
    const runs = { count: 0 };
    const handler: EventHandler = () => {
      runs.count++;
    };
    return {
      handler: identity === undefined
        ? handler
        : Object.assign(handler, { schedulerObservationIdentity: identity }),
      runs,
    };
  }

  describe("hasQueuedEventFor()", () => {
    it("returns `false` when no event is queued", () => {
      expect(runtime.scheduler.hasQueuedEventFor(space, "of:piece")).toBe(
        false,
      );
    });

    it("returns `true` only for the piece and space a queued event's handler names", async () => {
      const link = streamLink("identified events");
      const { handler, runs } = countingHandler({
        ownerSpace: space,
        pieceId: "of:piece",
      });
      runtime.scheduler.addEventHandler(handler, link);
      runtime.scheduler.queueEvent(link, 1);

      expect(runtime.scheduler.hasQueuedEventFor(space, "of:piece")).toBe(true);
      expect(runtime.scheduler.hasQueuedEventFor(space, "of:other")).toBe(
        false,
      );
      expect(runtime.scheduler.hasQueuedEventFor(otherSpace, "of:piece"))
        .toBe(false);

      await runtime.idle();
      expect(runs.count).toBe(1);
      expect(runtime.scheduler.hasQueuedEventFor(space, "of:piece")).toBe(
        false,
      );
    });

    it("returns `true` for any piece while a queued event's handler names none", async () => {
      const link = streamLink("anonymous events");
      const { handler, runs } = countingHandler();
      runtime.scheduler.addEventHandler(handler, link);
      runtime.scheduler.queueEvent(link, 1);

      expect(runtime.scheduler.hasQueuedEventFor(space, "of:any")).toBe(true);
      expect(runtime.scheduler.hasQueuedEventFor(otherSpace, "of:any")).toBe(
        true,
      );

      await runtime.idle();
      expect(runs.count).toBe(1);
    });

    it("returns `true` for any piece while a queued event waits for its handler to load", async () => {
      const link = streamLink("loading events");
      const { handler, runs } = countingHandler({
        ownerSpace: otherSpace,
        pieceId: "of:elsewhere",
      });
      runtime.scheduler.addEventHandler(handler, link);
      runtime.scheduler.queueEvent(link, 1);
      const [queued] = runtime.scheduler.accessForTestingOnly.eventQueue;
      queued.handlerLoadPending = true;

      expect(runtime.scheduler.hasQueuedEventFor(space, "of:piece")).toBe(true);

      delete queued.handlerLoadPending;
      expect(runtime.scheduler.hasQueuedEventFor(space, "of:piece")).toBe(
        false,
      );
      runtime.scheduler.queueExecution();
      await runtime.idle();
      expect(runs.count).toBe(1);
    });
  });

  describe("an event held behind a multi-space commit", () => {
    it("stays at the head, unrun, through further passes until the commit's writes are applied", async () => {
      const applied = Promise.withResolvers<void>();
      let holds = 0;
      using _applied = stub(storageManager, "multiSpaceCommitsApplied", () => {
        holds++;
        return holds === 1 ? applied.promise : undefined;
      });
      const link = streamLink("held events");
      const { handler, runs } = countingHandler();
      runtime.scheduler.addEventHandler(handler, link);
      runtime.scheduler.queueEvent(link, 1);

      await clock.settle();
      expect(holds).toBe(1);
      runtime.scheduler.queueExecution();
      await clock.settle();

      expect(runs.count).toBe(0);
      expect(runtime.scheduler.accessForTestingOnly.eventQueue.length).toBe(1);
      expect(holds).toBe(1);

      applied.resolve();
      await runtime.idle();
      expect(runs.count).toBe(1);
      expect(runtime.scheduler.accessForTestingOnly.eventQueue.length).toBe(0);
    });
  });

  describe("a remote-echo breaker event", () => {
    // The scheduler's own breaker is driven with synthetic echo steps, so
    // each case trips it at a chosen moment and sees what the scheduler does
    // with the report.

    const ACTION = "facade-echo-action";
    const document = { space, id: "of:echo-doc", scopeKey: "space" as const };
    const step: EchoStep = { docKey: "echo-doc", document, changed: true };

    /** Echoes until the breaker trips, returning the trip's deadline. */
    function trip(): number | undefined {
      const breaker = runtime.scheduler.accessForTestingOnly.echoBreaker;
      let deadline: number | undefined;
      for (let i = 0; i < ECHO_TRIP_THRESHOLD; i++) {
        deadline = breaker.observe(ACTION, [step], i);
      }
      return deadline;
    }

    type Provider = ReturnType<SchedulerTestStorageManager["open"]>;

    it("is reported to the provider of the document's space", () => {
      const reports: SessionReport[] = [];
      using opened = stub(
        storageManager,
        "open",
        () =>
          ({
            sendReport: (report: SessionReport) => reports.push(report),
          }) as unknown as Provider,
      );

      expect(trip()).toBeDefined();
      expect(opened.calls.map((call) => call.args[0])).toEqual([space]);
      expect(reports).toEqual([{
        kind: "echo-breaker",
        document: { id: "of:echo-doc", scopeKey: "space" },
        action: ACTION,
        event: "trip",
      }]);
    });

    it("is reported to nothing, and still trips, when the provider cannot take reports", () => {
      using opened = stub(
        storageManager,
        "open",
        () => ({}) as unknown as Provider,
      );
      using logs = captureLogs("scheduler");

      expect(trip()).toBeDefined();
      expect(opened.calls.length).toBe(1);
      expect(logs.textsOf("echo-breaker-report-failed")).toEqual([]);
    });

    it("is logged as unreported, and still trips, when the provider cannot be opened", () => {
      using _opened = stub(storageManager, "open", () => {
        throw new Error("the space would not open");
      });
      using logs = captureLogs("scheduler");

      expect(trip()).toBeDefined();
      expect(logs.textsOf("echo-breaker-report-failed")).toEqual([
        "could not report a remote-echo breaker event the space would not open",
      ]);
    });

    it("is not reported once the scheduler is disposed", () => {
      const reports: SessionReport[] = [];
      using opened = stub(
        storageManager,
        "open",
        () =>
          ({
            sendReport: (report: SessionReport) => reports.push(report),
          }) as unknown as Provider,
      );
      runtime.scheduler.dispose();

      expect(trip()).toBeDefined();
      expect(opened.calls.length).toBe(0);
      expect(reports).toEqual([]);
    });
  });

  describe("a budget backoff", () => {
    it("logs how many actions it deferred and when they wake", async () => {
      const cellA = runtime.getCell<number>(space, "backoff-A", undefined, tx);
      cellA.set(0);
      const cellB = runtime.getCell<number>(space, "backoff-B", undefined, tx);
      cellB.set(0);
      const output = runtime.getCell<number>(
        space,
        "backoff-output",
        undefined,
        tx,
      );
      output.set(0);
      await tx.commit().settled;
      tx = runtime.edit();

      // Two computations that each increment what the other wrote never
      // converge, so the settle loop defers them once they spend its budget.
      const actionA: Action = (actionTx) => {
        cellA.withTx(actionTx).send(cellB.withTx(actionTx).get() + 1);
      };
      const actionB: Action = (actionTx) => {
        cellB.withTx(actionTx).send(cellA.withTx(actionTx).get() + 1);
      };
      const effect: Action = (actionTx) => {
        output.withTx(actionTx).send(cellB.withTx(actionTx).get());
      };
      const address = (cell: typeof cellA) =>
        toMemorySpaceAddress(cell.getAsNormalizedFullLink());

      using logs = captureLogs("scheduler");
      runtime.scheduler.subscribe(actionA, {
        reads: [address(cellB)],
        shallowReads: [],
        writes: [address(cellA)],
      }, {});
      runtime.scheduler.subscribe(actionB, {
        reads: [address(cellA)],
        shallowReads: [],
        writes: [address(cellB)],
      }, {});
      runtime.scheduler.subscribe(effect, {
        reads: [address(cellB)],
        shallowReads: [],
        writes: [address(output)],
      }, { isEffect: true });
      try {
        await runtime.scheduler.idle();
      } finally {
        runtime.scheduler.unsubscribe(actionA);
        runtime.scheduler.unsubscribe(actionB);
        runtime.scheduler.unsubscribe(effect);
      }

      const backoffs = logs.textsOf("schedule-backoff");
      expect(backoffs.length).toBeGreaterThan(0);
      for (const text of backoffs) {
        expect(text).toMatch(
          /^\[BACKOFF\] (iteration-cap|pass-budget): deferred [1-9]\d* action\(s\) wake in \d+ms$/,
        );
      }
    });

    it("logs nothing for actions that converge", async () => {
      const input = runtime.getCell<number>(
        space,
        "settled-input",
        undefined,
        tx,
      );
      input.set(1);
      const output = runtime.getCell<number>(
        space,
        "settled-output",
        undefined,
        tx,
      );
      output.set(0);
      await tx.commit().settled;
      tx = runtime.edit();

      const effect: Action = (actionTx) => {
        output.withTx(actionTx).send(input.withTx(actionTx).get() * 2);
      };
      using logs = captureLogs("scheduler");
      runtime.scheduler.subscribe(effect, {
        reads: [toMemorySpaceAddress(input.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      }, { isEffect: true });
      try {
        await output.pull();
        await runtime.scheduler.idle();
      } finally {
        runtime.scheduler.unsubscribe(effect);
      }

      expect(output.get()).toBe(2);
      expect(logs.textsOf("schedule-backoff")).toEqual([]);
    });
  });
});
