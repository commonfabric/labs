import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getLogger } from "@commonfabric/logger";
import type { NormalizedFullLink } from "../../src/link-utils.ts";
import type { EnsurePieceVerdict } from "../../src/ensure-piece-running.ts";
import { EventDroppedError } from "../../src/scheduler/backpressure.ts";
import { MAX_EVENT_BACKLOG_PER_STREAM } from "../../src/scheduler/constants.ts";
import {
  addSchedulerEventHandler,
  dispatchQueuedEvent,
  dropQueuedEvent,
  eventHandlerImplementations,
  EventHandlerRegistry,
  preflightQueuedEventDependencies,
  refusedReadIn,
  selectEventImplementation,
} from "../../src/scheduler/events.ts";
import {
  type EventHandler,
  LT1_LATE_SEAL_REFUSED,
  type QueuedEvent,
  type ServedEventFailureOutcome,
} from "../../src/scheduler/types.ts";
import type {
  IExtendedStorageTransaction,
  IStorageNotification,
} from "../../src/storage/interface.ts";
import {
  restrictToLocalReads,
  usesLocalReads,
} from "../../src/storage/local-read-policy.ts";
import {
  refuseFirstEventCommit,
  staleReadRefusal,
} from "../support/refuse-event-commit.ts";
import { captureLogs } from "../support/log-capture.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type SchedulerTestRuntime,
  space,
} from "../scheduler-test-utils.ts";

describe("events", () => {
  let env: SchedulerTestRuntime;

  beforeEach(() => {
    env = createSchedulerTestRuntime(import.meta.url);
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime(env);
  });

  function streamLink(cause: string): NormalizedFullLink {
    return env.runtime.getCell(space, cause).getAsNormalizedFullLink();
  }

  describe("guarded dispatcher", () => {
    // Each implementation here matches while `selected` names its key, so a
    // case chooses the implementation by setting `selected` before the call.

    let selected: string | undefined;
    let calls: string[];
    let probes: string[];

    beforeEach(() => {
      selected = undefined;
      calls = [];
      probes = [];
    });

    function implementation(key: string): EventHandler {
      const handler: EventHandler = (_tx, event) => {
        calls.push(`${key}:${event}`);
      };
      handler.implementationSelection = {
        key,
        matches: () => selected === key,
      };
      handler.populateDependencies = (_tx, event) => {
        probes.push(`${key}:${event}`);
      };
      return handler;
    }

    function registerBoth(registry: EventHandlerRegistry) {
      const ref = streamLink("events-guarded-dispatcher");
      addSchedulerEventHandler({ eventHandlers: registry }, {
        handler: implementation("a"),
        ref,
      });
      addSchedulerEventHandler({ eventHandlers: registry }, {
        handler: implementation("b"),
        ref,
      });
      return { ref, dispatcher: registry.get(ref)! };
    }

    it("runs the implementation whose guard matches when called directly", () => {
      const { dispatcher } = registerBoth(new EventHandlerRegistry());
      const tx = env.runtime.edit();
      selected = "b";

      dispatcher(tx, 7);

      expect(calls).toEqual(["b:7"]);
      expect(tx.dispatchedHandlerNotRun).toBeUndefined();
      tx.abort();
    });

    it("records that no handler ran when no guard matches", () => {
      const { dispatcher } = registerBoth(new EventHandlerRegistry());
      const tx = env.runtime.edit();
      selected = "neither";

      dispatcher(tx, 7);

      expect(calls).toEqual([]);
      expect(tx.dispatchedHandlerNotRun).toEqual({
        reason: "no unique event implementation matches the current program",
      });
      tx.abort();
    });

    it("forwards `populateDependencies` to the selected implementation only", () => {
      const { dispatcher } = registerBoth(new EventHandlerRegistry());
      const tx = env.runtime.edit();

      selected = "a";
      dispatcher.populateDependencies!(tx, 1);
      selected = "neither";
      dispatcher.populateDependencies!(tx, 2);

      expect(probes).toEqual(["a:1"]);
      tx.abort();
    });

    it("selects the plain handler that took the stream over from a dispatcher", () => {
      const registry = new EventHandlerRegistry();
      const { ref, dispatcher } = registerBoth(registry);
      const plain: EventHandler = () => {};
      const tx = env.runtime.edit();
      selected = "a";

      const cancel = addSchedulerEventHandler({ eventHandlers: registry }, {
        handler: plain,
        ref,
      });

      // The dispatcher a queued event still holds drops its implementations
      // and follows the stream to the handler registered there now.
      expect(registry.get(ref)).toBe(plain);
      expect(eventHandlerImplementations(dispatcher)).toEqual([]);
      expect(selectEventImplementation(dispatcher, tx)).toBe(plain);

      cancel();
      expect(registry.get(ref)).toBeUndefined();
      expect(selectEventImplementation(dispatcher, tx)).toBeUndefined();
      tx.abort();
    });
  });

  describe("refusedReadIn()", () => {
    it("returns `undefined` for a storage manager that keeps no read standing", () => {
      const cell = env.runtime.getCell<number>(space, "events-refused-read");
      const tx = env.runtime.edit();
      cell.withTx(tx).get();

      // The same read is reported once a manager does keep standing, so the
      // `undefined` comes from the manager and not from an empty read set.
      expect(refusedReadIn({}, tx.tx)).toBeUndefined();
      expect(
        refusedReadIn({ scopedReadStanding: () => "refused" }, tx.tx),
      ).toMatchObject({ standing: "refused" });
      tx.abort();
    });
  });

  describe("dropQueuedEvent()", () => {
    it("logs a quiet drop at debug and still settles the event's callback", async () => {
      const ref = streamLink("events-quiet-drop");
      env.runtime.scheduler.addEventHandler(() => {}, ref);
      const settled: string[] = [];
      env.runtime.scheduler.queueEvent(ref, 1, true, (tx) => {
        settled.push(tx.status().status);
      });
      const { eventQueue } = env.runtime.scheduler.accessForTestingOnly;
      const event = eventQueue[0];
      const warnsBefore =
        getLogger("scheduler").countsByKey["scheduler"]?.warn ?? 0;
      const capture = captureLogs("scheduler");
      try {
        dropQueuedEvent(
          { runtime: env.runtime, eventQueue },
          event,
          "routine purge",
          "dropped",
          { quiet: true },
        );
      } finally {
        capture[Symbol.dispose]();
      }

      expect(eventQueue).not.toContain(event);
      expect(settled).toEqual(["error"]);
      expect(capture.messages("scheduler")).toContainEqual([
        "routine purge",
        { eventLink: ref },
      ]);
      expect(getLogger("scheduler").countsByKey["scheduler"]?.warn ?? 0)
        .toBe(warnsBefore);
      await env.runtime.idle();
    });
  });

  describe("queued event backlog", () => {
    // Past `MAX_EVENT_BACKLOG_PER_STREAM` pending events on one stream, a new
    // event from the same origin collapses into the last pending one, which
    // then settles both senders' callbacks.

    function fillBacklog(ref: NormalizedFullLink, count: number) {
      for (let i = 1; i <= count; i++) {
        env.runtime.scheduler.queueEvent(ref, i);
      }
    }

    it("keeps the pending callback when the collapsed event brings none", async () => {
      const ref = streamLink("events-collapse-no-callback");
      const received: unknown[] = [];
      env.runtime.scheduler.addEventHandler((_tx, event) => {
        received.push(event);
      }, ref);
      fillBacklog(ref, MAX_EVENT_BACKLOG_PER_STREAM - 1);
      let settled = 0;
      env.runtime.scheduler.queueEvent(ref, "last", true, () => settled++);
      env.runtime.scheduler.queueEvent(ref, "collapsed");

      await env.runtime.idle();

      expect(received.length).toBe(MAX_EVENT_BACKLOG_PER_STREAM);
      expect(received.at(-1)).toBe("collapsed");
      expect(settled).toBe(1);
    });

    it("runs every chained callback when one of them throws", async () => {
      const ref = streamLink("events-collapse-throwing-callback");
      env.runtime.scheduler.addEventHandler(() => {}, ref);
      fillBacklog(ref, MAX_EVENT_BACKLOG_PER_STREAM - 1);
      const logger = getLogger("scheduler");
      const errorsBefore =
        logger.countsByKey["onCommit-callback-error"]?.error ?? 0;
      const settled: string[] = [];
      env.runtime.scheduler.queueEvent(ref, "last", true, () => {
        settled.push("first");
        throw new Error("first callback failed");
      });
      env.runtime.scheduler.queueEvent(ref, "collapsed", true, () => {
        settled.push("second");
      });

      await env.runtime.idle();

      expect(settled).toEqual(["first", "second"]);
      expect(logger.countsByKey["onCommit-callback-error"]?.error).toBe(
        errorsBefore + 1,
      );
    });

    it("records the collapsed event against its origin transaction", async () => {
      const ref = streamLink("events-collapse-origin");
      const received: unknown[] = [];
      env.runtime.scheduler.addEventHandler((_tx, event) => {
        received.push(event);
      }, ref);
      const origin: IExtendedStorageTransaction = env.runtime.edit();
      for (let i = 1; i <= MAX_EVENT_BACKLOG_PER_STREAM + 1; i++) {
        env.runtime.scheduler.queueEvent(ref, i, true, undefined, false, {
          originTx: origin,
        });
      }
      await origin.commit().settled;

      await env.runtime.idle();

      // The collapsed event waits on its origin like the others and is
      // delivered once that origin commits.
      expect(received.length).toBe(MAX_EVENT_BACKLOG_PER_STREAM);
      expect(received.at(-1)).toBe(MAX_EVENT_BACKLOG_PER_STREAM + 1);
    });
  });

  describe("event dispatch", () => {
    it("logs each handler's run time at debug", async () => {
      const ref = streamLink("events-action-timing");
      let ran = 0;
      env.runtime.scheduler.addEventHandler(() => {
        ran++;
      }, ref);
      const capture = captureLogs("scheduler");
      try {
        env.runtime.scheduler.queueEvent(ref, 1);
        await env.runtime.idle();
      } finally {
        capture[Symbol.dispose]();
      }

      expect(ran).toBe(1);
      const timings = capture.messages("action-timing");
      expect(timings.length).toBe(1);
      expect(String(timings[0][0])).toMatch(/^Action .* completed in /);
    });

    it("logs an error thrown by the event's commit callback and still runs the handler's commit", async () => {
      const ref = streamLink("events-throwing-on-commit");
      const target = env.runtime.getCell<number>(
        space,
        "events-on-commit-target",
      );
      env.runtime.scheduler.addEventHandler((tx, event) => {
        target.withTx(tx).set(event as number);
      }, ref);
      const logger = getLogger("scheduler");
      const errorsBefore = logger.countsByKey["schedule-error"]?.error ?? 0;
      let callbacks = 0;
      env.runtime.scheduler.queueEvent(ref, 5, true, () => {
        callbacks++;
        throw new Error("callback failed");
      });

      await env.runtime.idle();
      await env.runtime.scheduler.idleWithPendingCommits();

      expect(callbacks).toBe(1);
      expect(target.get()).toBe(5);
      expect(logger.countsByKey["schedule-error"]?.error).toBe(
        errorsBefore + 1,
      );
    });

    it("does not run an event that is no longer at the head of the queue", async () => {
      const ref = streamLink("events-dispatch-not-head");
      const received: unknown[] = [];
      env.runtime.scheduler.addEventHandler((_tx, event) => {
        received.push(event);
      }, ref);
      env.runtime.scheduler.queueEvent(ref, "first");
      env.runtime.scheduler.queueEvent(ref, "second");
      const { eventExecutionState, eventQueue } =
        env.runtime.scheduler.accessForTestingOnly;
      const second = eventQueue[1];

      await dispatchQueuedEvent(eventExecutionState, second);

      expect(received).toEqual([]);
      expect(eventQueue[1]).toBe(second);
      await env.runtime.idle();
      expect(received).toEqual(["first", "second"]);
    });

    it("settles the commit callback once for an event dropped while its handler ran", async () => {
      const ref = streamLink("events-dropped-mid-run");
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      env.runtime.scheduler.addEventHandler(async () => {
        started.resolve();
        await release.promise;
      }, ref);
      const settled: string[] = [];
      env.runtime.scheduler.queueEvent(ref, 1, true, (tx) => {
        settled.push(tx.status().status);
      });
      const event = env.runtime.scheduler.accessForTestingOnly.eventQueue[0];

      await started.promise;
      // The event has left the queue to run; a drop now is what a failed
      // origin does to an event it recorded.
      dropQueuedEvent(
        env.runtime.scheduler.accessForTestingOnly.eventQueueState,
        event,
        "dropped while running",
      );
      expect(settled).toEqual(["error"]);
      release.resolve();
      await env.runtime.idle();

      expect(settled).toEqual(["error"]);
    });

    it("dispatches a queued event whose handler stays registered for another stream", async () => {
      // The handler's piece reports a graph installed, so a handler
      // registered nowhere would be judged replaced and its event dropped.

      const ref = streamLink("events-shared-handler-a");
      const other = streamLink("events-shared-handler-b");
      const received: unknown[] = [];
      const handler: EventHandler = (_tx, event) => {
        received.push(event);
      };
      Object.assign(handler, {
        viewPiece: streamLink("events-shared-handler-piece"),
      });
      const runner = env.runtime.runner;
      const graphIsInstalled = runner.pieceGraphIsInstalled.bind(runner);
      runner.pieceGraphIsInstalled = () => true;
      try {
        const cancel = env.runtime.scheduler.addEventHandler(handler, ref);
        env.runtime.scheduler.addEventHandler(handler, other);
        env.runtime.scheduler.queueEvent(ref, "queued");
        cancel();

        await env.runtime.idle();
      } finally {
        runner.pieceGraphIsInstalled = graphIsInstalled;
      }

      expect(received).toEqual(["queued"]);
    });

    it("keeps dispatching after a handler throws a value that cannot be converted to a string", async () => {
      const ref = streamLink("events-unprintable-throw");
      const received: unknown[] = [];
      env.runtime.scheduler.addEventHandler((_tx, event) => {
        if (event === "unprintable") throw Object.create(null);
        received.push(event);
      }, ref);

      env.runtime.scheduler.queueEvent(ref, "unprintable");
      env.runtime.scheduler.queueEvent(ref, "after");
      await env.runtime.idle();

      expect(received).toEqual(["after"]);
    });

    it("fails loudly when a served event that opted into retries meets a stale-basis refusal", async () => {
      const ref = streamLink("events-served-retry");
      const target = env.runtime.getCell<number>(
        space,
        "events-served-retry-out",
      );
      let runs = 0;
      env.runtime.scheduler.addEventHandler((tx) => {
        runs++;
        target.withTx(tx).set(runs);
      }, ref);
      const refusal = refuseFirstEventCommit(
        env.runtime,
        staleReadRefusal(
          space,
          target.getAsNormalizedFullLink().id,
          () => Promise.resolve(),
        ),
      );
      const logger = getLogger("scheduler");
      const keptBefore = logger.errorMessagesByKey["schedule-error"]?.length ??
        0;
      try {
        env.runtime.scheduler.queueEvent(ref, 1, true, undefined, false, {
          eventId: "served-with-retries",
          served: { onFailure: () => {} },
        });
        await env.runtime.idle();
        await env.runtime.scheduler.idleWithPendingCommits();
      } finally {
        refusal.restore();
      }

      // The served carriage would be shed by a scheduler-side retry, so the
      // refusal is reported as a fault rather than re-run.
      expect(refusal.refusals()).toBe(1);
      expect(runs).toBe(1);
      const kept = logger.errorMessagesByKey["schedule-error"] ?? [];
      expect(kept.length).toBe(keptBefore + 1);
      expect(kept.at(-1)).toContain(
        "requeueForBackoff reached with a served event",
      );
    });
  });

  describe("commit preparation", () => {
    // `Runtime.prepareTxForCommit()` is replaced for the event's own
    // transaction only, so each case chooses how preparing that commit goes.

    function prepareEventCommitWith(
      eventId: string,
      prepare: (tx: IExtendedStorageTransaction) => void,
    ): () => void {
      const original = env.runtime.prepareTxForCommit.bind(env.runtime);
      env.runtime.prepareTxForCommit = (tx) =>
        tx.dispatchedEventId === eventId ? prepare(tx) : original(tx);
      return () => {
        env.runtime.prepareTxForCommit = original;
      };
    }

    function queueTracked(
      ref: NormalizedFullLink,
      eventId: string,
    ): { readonly statuses: string[] } {
      const statuses: string[] = [];
      env.runtime.scheduler.queueEvent(
        ref,
        1,
        true,
        (tx) => statuses.push(tx.status().status),
        false,
        { eventId },
      );
      return { statuses };
    }

    it("reports a failure to prepare the event's commit as the event's error", async () => {
      const ref = streamLink("events-prepare-throws");
      const target = env.runtime.getCell<number>(
        space,
        "events-prepare-target",
      );
      env.runtime.scheduler.addEventHandler((tx) => {
        target.withTx(tx).set(1);
      }, ref);
      const errors: string[] = [];
      env.runtime.scheduler.onError((error) => errors.push(error.message));
      const restore = prepareEventCommitWith("prepare-throws", () => {
        throw new Error("prepare failed");
      });
      try {
        const { statuses } = queueTracked(ref, "prepare-throws");
        await env.runtime.idle();

        expect(statuses).toEqual(["error"]);
        expect(errors).toEqual(["prepare failed"]);
        expect(target.get()).toBeUndefined();
      } finally {
        restore();
      }
    });

    describe("of a run restricted to local reads", () => {
      // The event's transaction is restricted to local reads the way
      // `prepareViewAction()` restricts a view action's, with one document
      // left out, and the preparation reads that document. Such a run is
      // withdrawn rather than failed: its callback sees the aborted
      // transaction and no error is reported.

      function restrictEventReads(
        eventId: string,
        unavailable: NormalizedFullLink,
      ): () => void {
        const scheduler = env.runtime.scheduler;
        const original = scheduler.prepareViewAction.bind(scheduler);
        scheduler.prepareViewAction = (tx, action) => {
          if (tx.dispatchedEventId === eventId && !usesLocalReads(tx)) {
            restrictToLocalReads(
              tx.tx,
              () => (address) => address.id !== unavailable.id,
            );
          }
          original(tx, action);
        };
        return () => {
          scheduler.prepareViewAction = original;
        };
      }

      async function runPreparingWith(
        name: string,
        prepare: (read: () => void) => void,
      ) {
        const ref = streamLink(`events-prepare-${name}`);
        env.runtime.scheduler.addEventHandler(() => {}, ref);
        const unavailable = env.runtime.getCell<number>(
          space,
          `events-prepare-${name}-doc`,
        );
        const errors: Error[] = [];
        env.runtime.scheduler.onError((error) => errors.push(error));
        const reads: string[] = [];
        const restoreReads = restrictEventReads(
          name,
          unavailable.getAsNormalizedFullLink(),
        );
        const restorePrepare = prepareEventCommitWith(
          name,
          (tx) =>
            prepare(() => {
              reads.push("attempted");
              unavailable.withTx(tx).get();
            }),
        );
        try {
          const { statuses } = queueTracked(ref, name);
          await env.runtime.idle();
          return { statuses, errors, reads };
        } finally {
          restorePrepare();
          restoreReads();
        }
      }

      it("withdraws a run whose commit preparation throws on an unavailable read", async () => {
        const { statuses, errors, reads } = await runPreparingWith(
          "unavailable-throw",
          (read) => read(),
        );

        expect(reads).toEqual(["attempted"]);
        expect(statuses).toEqual(["error"]);
        expect(errors).toEqual([]);
      });

      it("withdraws a run whose commit preparation swallowed an unavailable read", async () => {
        const caught: unknown[] = [];
        const { statuses, errors, reads } = await runPreparingWith(
          "unavailable-caught",
          (read) => {
            try {
              read();
            } catch (error) {
              caught.push(error);
            }
          },
        );

        expect(reads).toEqual(["attempted"]);
        expect(caught.length).toBe(1);
        expect(statuses).toEqual(["error"]);
        expect(errors).toEqual([]);
      });
    });
  });

  describe("dependency preflight", () => {
    it("drops the event without throwing when reporting its failure throws", () => {
      const ref = streamLink("events-preflight-report-throws");
      env.runtime.scheduler.addEventHandler(() => {}, ref);
      env.runtime.scheduler.queueEvent(ref, 1);
      const { eventExecutionState, eventQueue } =
        env.runtime.scheduler.accessForTestingOnly;
      const drops: string[] = [];

      const result = preflightQueuedEventDependencies({
        ...eventExecutionState,
        pendingActions: new Set(),
        eventBlockingDeps: new Set(),
        collectInvalidUpstreamForLog: () => {
          throw new Error("collect failed");
        },
        handleError: () => {
          throw new Error("error channel failed");
        },
        dropEvent: (_event, reason) => drops.push(reason),
      }, eventQueue[0]);

      expect(result.shouldSkipEvent).toBe(true);
      expect(drops).toEqual([
        `Event dropped: dependency preflight failed for ${ref.id}`,
      ]);
    });
  });

  describe("pattern change", () => {
    it("holds the head event and those behind it while its piece changes pattern", async () => {
      const ref = streamLink("events-pattern-change");
      const piece = streamLink("events-pattern-change-piece");
      const received: unknown[] = [];
      const handler: EventHandler = (_tx, event) => {
        received.push(event);
      };
      Object.assign(handler, { viewPiece: piece });
      env.runtime.scheduler.addEventHandler(handler, ref);
      const change = Promise.withResolvers<void>();
      const runner = env.runtime.runner;
      const consult = runner.pendingPatternChangeFor.bind(runner);
      let held = false;
      runner.pendingPatternChangeFor = (pieces) => {
        if (held) return consult(pieces);
        held = true;
        return change.promise;
      };
      const capture = captureLogs("scheduler");
      try {
        env.runtime.scheduler.queueEvent(ref, "first");
        await clock.settle();
        env.runtime.scheduler.queueEvent(ref, "second");
        await clock.settle();

        expect(received).toEqual([]);
        expect(
          env.runtime.scheduler.accessForTestingOnly.eventQueue.map((event) =>
            event.event
          ),
        ).toEqual(["first", "second"]);
      } finally {
        capture[Symbol.dispose]();
      }
      change.resolve();
      await env.runtime.idle();
      runner.pendingPatternChangeFor = consult;

      expect(received).toEqual(["first", "second"]);
      expect(capture.messages("scheduler")).toContainEqual([
        expect.stringMatching(/waits for its piece's pattern change$/),
      ]);
    });
  });

  describe("lineage", () => {
    it("drops an event whose origin had already failed, logging the drop at debug", async () => {
      const ref = streamLink("events-failed-origin");
      const received: unknown[] = [];
      env.runtime.scheduler.addEventHandler((_tx, event) => {
        received.push(event);
      }, ref);
      const origin = env.runtime.edit();
      origin.abort(new Error("origin failed"));
      const settled: string[] = [];
      const capture = captureLogs("scheduler");
      try {
        env.runtime.scheduler.queueEvent(
          ref,
          1,
          true,
          (tx) => settled.push(tx.status().status),
          false,
          { eventId: "events-failed-origin-event", originTx: origin },
        );
        await env.runtime.idle();
      } finally {
        capture[Symbol.dispose]();
      }

      expect(received).toEqual([]);
      expect(settled).toEqual(["error"]);
      expect(capture.messages("scheduler-lineage"))
        .toEqual([[
          "Dropping event from failed lineage origin",
          { eventId: "events-failed-origin-event" },
        ]]);
    });
  });

  describe("piece start", () => {
    // An event sent to a stream with no handler holds the queue's head while
    // the scheduler starts the stream's piece. `loadPieceForEvent` stands in
    // for the start, so each case says what every attempt finds.

    function setLoadPieceForEvent(
      load: (
        runtime: unknown,
        eventLink: NormalizedFullLink,
      ) => Promise<EnsurePieceVerdict>,
    ): void {
      Object.assign(
        env.runtime.scheduler.accessForTestingOnly.eventQueueState,
        {
          loadPieceForEvent: load,
        },
      );
    }

    function sendTracked(
      ref: NormalizedFullLink,
      event: unknown,
      options: { served?: QueuedEvent["served"] } = {},
    ) {
      const statuses: string[] = [];
      env.runtime.scheduler.queueEvent(
        ref,
        event,
        true,
        (tx) => statuses.push(tx.status().status),
        false,
        options,
      );
      return statuses;
    }

    function collectErrors(): Error[] {
      const errors: Error[] = [];
      env.runtime.scheduler.onError((error) => errors.push(error));
      return errors;
    }

    /** A verdict for a piece that may still start once a commit lands. */
    function notYetStarted(
      observed: readonly NormalizedFullLink[],
    ): EnsurePieceVerdict {
      return {
        started: false,
        reason: "no-pattern-meta",
        root: { space, id: "of:events-elsewhere", scope: "space" },
        observedDocIds: observed.map((doc) => doc.id),
        observedDocs: observed.map(({ space, id, scope }) => ({
          space,
          id,
          scope,
        })),
      };
    }

    it("drops a send at once when the start reaches no owning document", async () => {
      const ref = streamLink("events-no-root");
      let attempts = 0;
      setLoadPieceForEvent(() => {
        attempts++;
        return Promise.resolve({
          started: false,
          reason: "no-pattern-meta",
          observedDocIds: [],
          observedDocs: [],
        });
      });
      const errors = collectErrors();

      const statuses = sendTracked(ref, 1);
      await env.runtime.idle();

      expect(attempts).toBe(1);
      expect(statuses).toEqual(["error"]);
      expect(errors.length).toBe(1);
      expect(errors[0]).toBeInstanceOf(EventDroppedError);
      expect(errors[0]).toMatchObject({
        attempts: 1,
        pieceStartReason: "no-pattern-meta",
      });
    });

    it("holds a placeholder handler that throws, naming the event, until its piece loads", async () => {
      const ref = streamLink("events-placeholder");
      const load = Promise.withResolvers<EnsurePieceVerdict>();
      setLoadPieceForEvent(() => load.promise);
      const received: unknown[] = [];

      sendTracked(ref, "queued");
      const queued = env.runtime.scheduler.accessForTestingOnly.eventQueue[0];
      expect(queued.handlerLoadPending).toBe(true);
      const tx = env.runtime.edit();
      expect(() => queued.handler(tx, "queued")).toThrow(
        `Event ${queued.id} dispatched before its handler loaded`,
      );
      tx.abort();

      env.runtime.scheduler.addEventHandler((_tx, event) => {
        received.push(event);
      }, ref);
      load.resolve({ started: true, observedDocIds: [], observedDocs: [] });
      await env.runtime.idle();
      expect(received).toEqual(["queued"]);
    });

    it("reports nothing for a send settled elsewhere before its start failed", async () => {
      const ref = streamLink("events-settled-then-start-failed");
      const load = Promise.withResolvers<EnsurePieceVerdict>();
      setLoadPieceForEvent(() => load.promise);
      const errors = collectErrors();

      const statuses = sendTracked(ref, 1);
      const { eventQueueState } = env.runtime.scheduler.accessForTestingOnly;
      dropQueuedEvent(
        eventQueueState,
        eventQueueState.eventQueue[0],
        "dropped elsewhere",
      );
      load.reject(new Error("start failed"));
      await env.runtime.idle();

      // The drop settled the callback; the failed start adds no second
      // settlement and no `EventDroppedError`.
      expect(statuses).toEqual(["error"]);
      expect(errors).toEqual([]);
    });

    it("drops a served send whose started piece registered no handler for its stream", async () => {
      const ref = streamLink("events-served-no-handler");
      setLoadPieceForEvent(() =>
        Promise.resolve({
          started: true,
          graphIsInstalled: () => true,
          observedDocIds: [],
          observedDocs: [],
        })
      );
      const errors = collectErrors();
      const outcomes: ServedEventFailureOutcome[] = [];

      sendTracked(ref, 1, {
        served: { onFailure: (outcome) => outcomes.push(outcome) },
      });
      await env.runtime.idle();

      expect(outcomes).toEqual([{
        kind: "dropped",
        message: `Event dropped: no handler registered for ${ref.id} ` +
          "after starting its piece",
      }]);
      expect(errors).toEqual([]);
    });

    describe("waiting for the piece", () => {
      // An attempt that finds the piece not yet startable waits for a commit
      // to a document it read, after asking once more with the wait in place.

      let subscriptions: IStorageNotification[];

      beforeEach(() => {
        subscriptions = [];
        const manager = env.runtime.storageManager;
        const subscribe = manager.subscribe.bind(manager);
        manager.subscribe = (subscription) => {
          subscriptions.push(subscription);
          subscribe(subscription);
        };
      });

      it("ends the wait without asking again once the send is settled elsewhere", async () => {
        const ref = streamLink("events-wait-settled");
        const watched = streamLink("events-wait-settled-doc");
        let attempts = 0;
        const rechecked = Promise.withResolvers<void>();
        setLoadPieceForEvent(() => {
          attempts++;
          if (attempts === 2) rechecked.resolve();
          return Promise.resolve(notYetStarted([watched]));
        });
        const errors = collectErrors();

        const statuses = sendTracked(ref, 1);
        await rechecked.promise;
        await clock.settle();
        const { eventQueueState } = env.runtime.scheduler.accessForTestingOnly;
        expect(eventQueueState.pieceStartWaits.size).toBe(1);
        dropQueuedEvent(
          eventQueueState,
          eventQueueState.eventQueue[0],
          "dropped elsewhere",
        );
        await env.runtime.idle();

        expect(attempts).toBe(2);
        expect(statuses).toEqual(["error"]);
        expect(errors).toEqual([]);
        expect(eventQueueState.pieceStartWaits.size).toBe(0);
      });

      it("asks again when storage resets while it waits", async () => {
        const ref = streamLink("events-wait-reset");
        const watched = streamLink("events-wait-reset-doc");
        const received: unknown[] = [];
        let attempts = 0;
        setLoadPieceForEvent(() => {
          attempts++;
          if (attempts === 2) {
            // The wait subscribed before this recheck began.
            subscriptions.at(-1)!.next({ type: "reset", space });
          }
          if (attempts < 3) return Promise.resolve(notYetStarted([watched]));
          env.runtime.scheduler.addEventHandler((_tx, event) => {
            received.push(event);
          }, ref);
          return Promise.resolve({
            started: true,
            observedDocIds: [],
            observedDocs: [],
          });
        });

        const statuses = sendTracked(ref, "queued");
        await env.runtime.idle();

        expect(attempts).toBe(3);
        expect(received).toEqual(["queued"]);
        expect(statuses).toEqual(["done"]);
      });

      it("asks again when a document only the recheck read changed while it ran", async () => {
        const ref = streamLink("events-wait-recheck-read");
        const first = streamLink("events-wait-recheck-first");
        const second = env.runtime.getCell<number>(
          space,
          "events-wait-recheck-second",
        );
        const received: unknown[] = [];
        let attempts = 0;
        setLoadPieceForEvent(async () => {
          attempts++;
          if (attempts === 1) return notYetStarted([first]);
          if (attempts === 2) {
            // A commit lands on a document the first attempt did not read,
            // and the recheck reads it.
            const tx = env.runtime.edit();
            second.withTx(tx).set(1);
            await tx.commit().settled;
            return notYetStarted([second.getAsNormalizedFullLink()]);
          }
          env.runtime.scheduler.addEventHandler((_tx, event) => {
            received.push(event);
          }, ref);
          return { started: true, observedDocIds: [], observedDocs: [] };
        });

        const statuses = sendTracked(ref, "queued");
        await env.runtime.idle();

        expect(attempts).toBe(3);
        expect(received).toEqual(["queued"]);
        expect(statuses).toEqual(["done"]);
      });
    });
  });

  describe("served run reading under an unresolved grant", () => {
    it("defers the entry with an untyped failure when the load it waited on fails untyped", async () => {
      const cold = env.runtime.getCell<string>(space, "events-unresolved-cold");
      const ref = streamLink("events-unresolved-events");
      const link = cold.getAsNormalizedFullLink();
      const load = Promise.withResolvers<void>();
      const awaited = Promise.withResolvers<void>();
      Object.assign(env.runtime.storageManager, {
        scopedReadStanding: (address: { id: string }) =>
          address.id === link.id ? "unresolved" : "admitted",
        loadsSettled: () => {
          awaited.resolve();
          return load.promise;
        },
      });
      let runs = 0;
      env.runtime.scheduler.addEventHandler((tx) => {
        runs++;
        cold.withTx(tx).get();
      }, ref);
      const outcomes: ServedEventFailureOutcome[] = [];
      env.runtime.scheduler.queueEvent(ref, 1, true, undefined, false, {
        eventId: "evt:events-unresolved",
        served: {
          streamEntry: { sidecarId: "of:events-unresolved", index: 0, seq: 1 },
          onFailure: (outcome) => outcomes.push(outcome),
        },
      });
      await awaited.promise;

      load.reject(new Error("transport gone"));
      await env.runtime.idle();
      await env.runtime.scheduler.idleWithPendingCommits();

      expect(runs).toBe(1);
      expect(outcomes).toEqual([{
        kind: "deferred",
        cause: "load-park",
        role: "failed-head",
        failure: {
          failureClass: "unknown",
          recoveryEpoch: "untyped",
          permanentEvidence: false,
        },
      }]);
    });
  });

  describe("served LT1 copy", () => {
    it("settles quietly when the seal refuses it as completed outside its wave", async () => {
      const served = createSchedulerTestRuntime(import.meta.url, {
        experimental: { serverExecution: true },
      });
      try {
        const ref = served.runtime.getCell(space, "events-lt1-stream")
          .getAsNormalizedFullLink();
        const target = served.runtime.getCell<number>(space, "events-lt1-out");
        served.runtime.installSealDestination({
          seal: (tx) =>
            Promise.resolve(
              tx.dispatchedEventId === "lt1-copy"
                ? {
                  error: {
                    name: "StorageTransactionAborted" as const,
                    message: "refused at the seal",
                    reason: new Error(LT1_LATE_SEAL_REFUSED),
                  },
                }
                : { ok: {} },
            ),
        });
        served.runtime.scheduler.addEventHandler((tx) => {
          target.withTx(tx).set(1);
        }, ref);
        const logger = getLogger("scheduler");
        const warnsBefore =
          logger.countsByKey["served-event-commit-failed"]?.warn ?? 0;
        const outcomes: ServedEventFailureOutcome[] = [];
        let callbacks = 0;
        const capture = captureLogs("scheduler");
        try {
          served.runtime.scheduler.queueEvent(
            ref,
            1,
            false,
            () => callbacks++,
            false,
            {
              eventId: "lt1-copy",
              served: { onFailure: (outcome) => outcomes.push(outcome) },
            },
          );
          await served.runtime.idle();
          await served.runtime.scheduler.idleWithPendingCommits();
        } finally {
          capture[Symbol.dispose]();
        }

        expect(callbacks).toBe(1);
        expect(outcomes).toEqual([]);
        expect(logger.countsByKey["served-event-commit-failed"]?.warn ?? 0)
          .toBe(warnsBefore);
        expect(capture.messages("lt1-late-seal-refused"))
          .toEqual([[
            "LT1 in-process copy of lt1-copy sealed outside its appending " +
            "wave and was refused; the drain delivers the entry",
          ]]);
      } finally {
        await disposeSchedulerTestRuntime(served);
      }
    });
  });
});
