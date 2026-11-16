import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import type { Cell } from "../../src/cell.ts";
import { newFanOutNodeState } from "../../src/scheduler/fan-out.ts";
import type {
  Action,
  EventHandler,
  QueuedEvent,
} from "../../src/scheduler/types.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../../src/storage/interface.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type SchedulerTestRuntime,
  space,
  toMemorySpaceAddress,
} from "../scheduler-test-utils.ts";
import { captureLogs, type LogCapture } from "../support/log-capture.ts";

describe("facade", () => {
  let env: SchedulerTestRuntime;

  beforeEach(() => {
    env = createSchedulerTestRuntime(import.meta.url);
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime(env);
  });

  /** Creates a cell holding `value`, committed. */
  async function committedCell<T>(cause: string, value: T): Promise<Cell<T>> {
    const tx = env.runtime.edit();
    const cell = env.runtime.getCell<T>(space, cause, undefined, tx);
    cell.set(value);
    await tx.commit().settled;
    return cell;
  }

  /** Commits `value` to `cell` from outside any action. */
  async function write<T>(cell: Cell<T>, value: T): Promise<void> {
    const tx = env.runtime.edit();
    cell.withTx(tx).set(value);
    await tx.commit().settled;
  }

  /** Declares the cells an action writes, which is its write surface. */
  function declareWrites(action: Action, cells: readonly Cell<unknown>[]) {
    Object.assign(action, {
      writes: cells.map((cell) => cell.getAsNormalizedFullLink()),
    });
  }

  function addressOf(cell: Cell<unknown>) {
    return toMemorySpaceAddress(cell.getAsNormalizedFullLink());
  }

  describe("instance members", () => {
    describe("runDiagnosis()", () => {
      it("reports a computation that wrote different values over the same input", async () => {
        const input = await committedCell("diagnosis-input", 0);
        const output = await committedCell("diagnosis-output", 0);
        // Each run writes a new count, so two runs over the same input value
        // write different values. The count goes straight to the transaction,
        // which reads nothing of the output: the diagnosis compares what each
        // run read, and a read of the output would differ with each count.
        let runs = 0;
        const counter: Action = (tx) => {
          input.withTx(tx).get();
          tx.writeValueOrThrow(output.getAsNormalizedFullLink(), ++runs);
        };
        declareWrites(counter, [output]);

        const diagnosis = env.runtime.scheduler.runDiagnosis(60_000);
        env.runtime.scheduler.subscribe(counter, {
          reads: [addressOf(input)],
          shallowReads: [],
          writes: [addressOf(output)],
        }, {});
        await output.pull();
        await write(input, 1);
        await output.pull();
        await write(input, 0);
        await output.pull();
        const result = await diagnosis;

        expect(runs).toBe(3);
        const actionId = env.runtime.scheduler.accessForTestingOnly.getActionId(
          counter,
        );
        expect(result.nonIdempotent.map((finding) => finding.actionId))
          .toEqual([actionId]);
        expect(
          result.nonIdempotent[0].runs.map((run) => Object.values(run.writes)),
        ).toEqual([[1], [3]]);
        expect(result.duration).toBe(60_000);
      });

      it("reports nothing for a computation that writes what its input determines", async () => {
        // The output starts at a value no run writes, so every run's write
        // is a change the diagnosis records.
        const input = await committedCell("diagnosis-pure-input", 0);
        const output = await committedCell("diagnosis-pure-output", -1);
        let runs = 0;
        const double: Action = (tx) => {
          runs++;
          output.withTx(tx).send(input.withTx(tx).get() * 2);
        };
        declareWrites(double, [output]);

        const diagnosis = env.runtime.scheduler.runDiagnosis(60_000);
        env.runtime.scheduler.subscribe(double, {
          reads: [addressOf(input)],
          shallowReads: [],
          writes: [addressOf(output)],
        }, {});
        await output.pull();
        await write(input, 1);
        await output.pull();
        await write(input, 0);
        await output.pull();
        const result = await diagnosis;

        expect(runs).toBe(3);
        expect(output.get()).toBe(0);
        expect(result.nonIdempotent).toEqual([]);
      });
      it("reports two effects that trigger each other through the cells they write", async () => {
        // `forward` copies `back` into `ahead`, and `backward` writes `ahead`
        // plus one into `back` until it reaches 2, so the two settle after
        // triggering each other a few times. A diagnosis attributes a commit
        // to the action that made it through the action's change group. Each
        // writes straight to its transaction, which reads nothing of what it
        // writes.
        const ahead = await committedCell("diagnosis-cycle-ahead", 0);
        const back = await committedCell("diagnosis-cycle-back", 0);
        const forward: Action = (tx) => {
          tx.writeValueOrThrow(
            ahead.getAsNormalizedFullLink(),
            back.withTx(tx).get(),
          );
        };
        const backward: Action = (tx) => {
          tx.writeValueOrThrow(
            back.getAsNormalizedFullLink(),
            Math.min(ahead.withTx(tx).get() + 1, 2),
          );
        };
        declareWrites(forward, [ahead]);
        declareWrites(backward, [back]);

        const diagnosis = env.runtime.scheduler.runDiagnosis(60_000);
        env.runtime.scheduler.subscribe(forward, {
          reads: [addressOf(back)],
          shallowReads: [],
          writes: [addressOf(ahead)],
        }, { isEffect: true, changeGroup: "forward" });
        env.runtime.scheduler.subscribe(backward, {
          reads: [addressOf(ahead)],
          shallowReads: [],
          writes: [addressOf(back)],
        }, { isEffect: true, changeGroup: "backward" });
        await env.runtime.scheduler.idle();
        const result = await diagnosis;

        expect([ahead.get(), back.get()]).toEqual([2, 2]);
        const access = env.runtime.scheduler.accessForTestingOnly;
        const ids = [access.getActionId(forward), access.getActionId(backward)];
        // Every trigger records its edge, so a loop that went round more
        // than once can be reported more than once.
        expect(result.cycles.length).toBeGreaterThan(0);
        for (const { cycle } of result.cycles) {
          expect(cycle.map((step) => step.actionId).sort()).toEqual(
            ids.sort(),
          );
        }
      });

      it("reports no cycle for an effect that only follows another", async () => {
        // Each writes straight to its transaction, which reads nothing of
        // what it writes.

        const source = await committedCell("diagnosis-chain-source", 0);
        const middle = await committedCell("diagnosis-chain-middle", 0);
        const sink = await committedCell("diagnosis-chain-sink", 0);
        const first: Action = (tx) => {
          tx.writeValueOrThrow(
            middle.getAsNormalizedFullLink(),
            source.withTx(tx).get() + 1,
          );
        };
        const second: Action = (tx) => {
          tx.writeValueOrThrow(
            sink.getAsNormalizedFullLink(),
            middle.withTx(tx).get() + 1,
          );
        };
        declareWrites(first, [middle]);
        declareWrites(second, [sink]);

        const diagnosis = env.runtime.scheduler.runDiagnosis(60_000);
        env.runtime.scheduler.subscribe(first, {
          reads: [addressOf(source)],
          shallowReads: [],
          writes: [addressOf(middle)],
        }, { isEffect: true, changeGroup: "first" });
        env.runtime.scheduler.subscribe(second, {
          reads: [addressOf(middle)],
          shallowReads: [],
          writes: [addressOf(sink)],
        }, { isEffect: true, changeGroup: "second" });
        await env.runtime.scheduler.idle();
        await write(source, 5);
        await env.runtime.scheduler.idle();
        const result = await diagnosis;

        expect(sink.get()).toBe(7);
        expect(result.cycles).toEqual([]);
      });
    });

    describe("lineage", () => {
      it("logs a piece stop that throws once the speculative origin it was recorded under fails", () => {
        // The origin stands in for a transaction whose commit is pending
        // until the case settles it.
        const settle: ((error: Error) => void)[] = [];
        const origin = {
          isReadOnly: () => false,
          status: () => ({ status: "ready" }),
          addCommitCallback: (
            callback: (tx: unknown, result: { error?: Error }) => void,
          ) => settle.push((error) => callback(origin, { error })),
        };
        const stopFailure = new Error("stop failed");
        const errors: unknown[][] = [];
        const originalError = console.error;
        console.error = (...args: unknown[]) => errors.push(args);
        try {
          env.runtime.scheduler.lineage.recordPieceStop(
            origin as unknown as IExtendedStorageTransaction,
            () => {
              throw stopFailure;
            },
          );
          expect(errors).toEqual([]);

          for (const callback of settle) callback(new Error("origin failed"));
        } finally {
          console.error = originalError;
        }

        expect(
          errors.filter((call) => call.includes("lineage")).map((call) =>
            call.at(-1)
          ),
        ).toEqual([stopFailure]);
      });
    });

    describe("subscribe() holding the initial run until a space syncs", () => {
      // The held space is one the case's own provider answers for, so a
      // case decides what syncing that space does.

      const HELD_SPACE = "did:key:zHeldSpace" as MemorySpace;
      let warnings: unknown[][];
      let restore: () => void;

      beforeEach(() => {
        warnings = [];
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => warnings.push(args);
        restore = () => {
          console.warn = originalWarn;
        };
      });

      afterEach(() => {
        restore();
      });

      /** Answers `open()` for the held space with `provider`. */
      function provideHeldSpace(provider: () => unknown): void {
        const manager = env.runtime.storageManager;
        const open = manager.open;
        Object.assign(manager, {
          open: (space: MemorySpace) =>
            space === HELD_SPACE ? provider() : open.call(manager, space),
        });
        const restoreWarn = restore;
        restore = () => {
          Object.assign(manager, { open });
          restoreWarn();
        };
      }

      async function subscribeHeld(): Promise<() => number> {
        const input = await committedCell("held-input", 0);
        let runs = 0;
        const effect: Action = (tx) => {
          runs++;
          input.withTx(tx).get();
        };
        env.runtime.scheduler.subscribe(effect, {
          reads: [addressOf(input)],
          shallowReads: [],
          writes: [],
        }, {
          isEffect: true,
          awaitSyncBeforeInitialRun: { space: HELD_SPACE },
        });
        return () => runs;
      }

      it("runs the action once the space has synced", async () => {
        const synced = Promise.withResolvers<void>();
        provideHeldSpace(() => ({ synced: () => synced.promise }));

        const runs = await subscribeHeld();
        await clock.settle();
        expect(runs()).toBe(0);

        synced.resolve();
        await env.runtime.scheduler.idle();
        expect(runs()).toBe(1);
        expect(warnings).toEqual([]);
      });

      it("runs the action without waiting when the space's provider cannot sync", async () => {
        provideHeldSpace(() => ({}));

        const runs = await subscribeHeld();
        await env.runtime.scheduler.idle();

        expect(runs()).toBe(1);
        expect(warnings).toEqual([]);
      });

      it("warns and runs the action when opening the space throws", async () => {
        const failure = new Error("cannot open the held space");
        provideHeldSpace(() => {
          throw failure;
        });

        const runs = await subscribeHeld();
        await env.runtime.scheduler.idle();

        expect(runs()).toBe(1);
        const warned = warnings.filter((call) =>
          call.includes("scheduler-initial-sync-hold")
        );
        expect(warned.length).toBe(1);
        expect(warned[0]).toContain(
          "Failed to await sync before initial run; releasing the hold",
        );
        expect(warned[0].at(-1)).toBe(failure);
      });
    });

    describe("transientEventDemandersFor()", () => {
      function servedEvent(
        id: string,
        rootId: string,
        firedAt: { user?: string; session?: string } | undefined,
      ): QueuedEvent {
        const handler: EventHandler = () => {};
        Object.assign(handler, {
          schedulerObservationIdentity: {
            pieceId: rootId,
            pieceRootId: rootId,
          },
        });
        return {
          id,
          enqueueSeq: 0,
          eventLink: env.runtime.getCell(space, `stream-${id}`)
            .getAsNormalizedFullLink(),
          action: () => {},
          handler,
          event: { id },
          retry: false,
          served: firedAt === undefined ? {} : { firedAt },
        };
      }

      it("returns the actor of each queued served event whose handler reaches a root", () => {
        const queue = env.runtime.scheduler.accessForTestingOnly.eventQueue;
        queue.push(
          servedEvent("by-alice", "root-1", {
            user: "did:key:alice",
            session: "alice-session",
          }),
          servedEvent("by-server", "root-1", {
            user: "did:key:bob",
            session: "server",
          }),
          servedEvent("elsewhere", "root-2", { user: "did:key:carol" }),
          servedEvent("anonymous", "root-1", undefined),
        );
        try {
          expect(
            env.runtime.scheduler.transientEventDemandersFor(["root-1"]),
          ).toEqual([
            { principal: "did:key:alice", sessionId: "alice-session" },
            { principal: "did:key:bob" },
          ]);
        } finally {
          queue.length = 0;
        }
      });

      it("returns nobody while no event is queued", () => {
        expect(env.runtime.scheduler.transientEventDemandersFor(["root-1"]))
          .toEqual([]);
      });
    });

    describe("re-arming fanned-out writers that are not current", () => {
      // A writer's fan-out record is set by hand: narrowed, with Alice's
      // principal at session depth, so an identity for Alice that names no
      // session has no instance key.

      const alice = "did:key:alice";
      const aliceInSession = {
        principal: alice,
        sessionId: "alice-session",
      } as ScopeKeyIdentity;
      const aliceWithoutSession = { principal: alice } as ScopeKeyIdentity;

      async function subscribeWriter(fannedOut: boolean) {
        const input = await committedCell("rearm-input", 0);
        const output = await committedCell("rearm-output", 0);
        const writer: Action = (tx) => {
          output.withTx(tx).send(input.withTx(tx).get());
        };
        declareWrites(writer, [output]);
        env.runtime.scheduler.subscribe(writer, {
          reads: [addressOf(input)],
          shallowReads: [],
          writes: [addressOf(output)],
        }, {});
        await output.pull();
        const record = env.runtime.scheduler.accessForTestingOnly.nodes.get(
          writer,
        )!;
        if (fannedOut) {
          const fanOut = newFanOutNodeState();
          fanOut.narrowed = true;
          fanOut.sessionPrincipals.add(alice);
          record.fanOut = fanOut;
        }
        return { writer, output };
      }

      describe("rearmNotCurrentFanOutForActor()", () => {
        function readsOf(output: Cell<number>) {
          return { reads: [addressOf(output)], shallowReads: [], writes: [] };
        }

        it("returns a fanned-out writer whose instance for the actor has not run", async () => {
          const { writer, output } = await subscribeWriter(true);

          expect(
            env.runtime.scheduler.rearmNotCurrentFanOutForActor(
              readsOf(output),
              aliceInSession,
            ),
          ).toEqual([writer]);
        });

        it("returns nothing for a writer off the fan-out path", async () => {
          const { output } = await subscribeWriter(false);

          expect(
            env.runtime.scheduler.rearmNotCurrentFanOutForActor(
              readsOf(output),
              aliceInSession,
            ),
          ).toEqual([]);
        });

        it("returns nothing for an actor with no instance key at the writer's ratchet", async () => {
          const { output } = await subscribeWriter(true);

          expect(
            env.runtime.scheduler.rearmNotCurrentFanOutForActor(
              readsOf(output),
              aliceWithoutSession,
            ),
          ).toEqual([]);
        });
      });

      describe("rearmNotCurrentForDemander()", () => {
        function addressFor(output: Cell<number>) {
          const link = output.getAsNormalizedFullLink();
          return { space: link.space, id: link.id, scope: link.scope };
        }

        it("returns one for a fanned-out writer whose instance for the demander has not run", async () => {
          const { output } = await subscribeWriter(true);

          expect(
            env.runtime.scheduler.rearmNotCurrentForDemander(
              addressFor(output),
              aliceInSession,
            ),
          ).toBe(1);
        });

        it("returns zero for a writer off the fan-out path", async () => {
          const { output } = await subscribeWriter(false);

          expect(
            env.runtime.scheduler.rearmNotCurrentForDemander(
              addressFor(output),
              aliceInSession,
            ),
          ).toBe(0);
        });

        it("returns zero for a demander with no instance key at the writer's ratchet", async () => {
          const { output } = await subscribeWriter(true);

          expect(
            env.runtime.scheduler.rearmNotCurrentForDemander(
              addressFor(output),
              aliceWithoutSession,
            ),
          ).toBe(0);
        });
      });
    });

    describe("setBreakpoints()", () => {
      it("replaces the breakpoints already set", () => {
        const scheduler = env.runtime.scheduler;

        scheduler.setBreakpoints(["a", "b"]);
        scheduler.setBreakpoints(["c"]);

        expect(scheduler.getBreakpoints()).toEqual(["c"]);
        expect(scheduler.hasBreakpoint("c")).toBe(true);
        expect(scheduler.hasBreakpoint("a")).toBe(false);
      });
    });

    describe("setSettleStatsEnabled()", () => {
      it("drops the collected stats when collection is turned off", async () => {
        const scheduler = env.runtime.scheduler;
        const output = await committedCell("settle-stats-output", 0);
        const effect: Action = (tx) => {
          output.withTx(tx).get();
        };

        scheduler.setSettleStatsEnabled(true);
        scheduler.subscribe(effect, {
          reads: [addressOf(output)],
          shallowReads: [],
          writes: [],
        }, { isEffect: true });
        await scheduler.idle();
        expect(scheduler.getSettleStats()).not.toBe(null);
        expect(scheduler.getSettleStatsHistory().length).toBeGreaterThan(0);

        scheduler.setSettleStatsEnabled(false);

        expect(scheduler.getSettleStats()).toBe(null);
        expect(scheduler.getSettleStatsHistory()).toEqual([]);
      });
    });

    describe("a scheduler pass", () => {
      async function subscribeCounted(): Promise<{
        effect: Action;
        runs: () => number;
      }> {
        const input = await committedCell("pass-input", 0);
        let runs = 0;
        const effect: Action = (tx) => {
          runs++;
          input.withTx(tx).get();
        };
        env.runtime.scheduler.subscribe(effect, {
          reads: [addressOf(input)],
          shallowReads: [],
          writes: [],
        }, { isEffect: true });
        await env.runtime.scheduler.idle();
        return { effect, runs: () => runs };
      }

      it("runs nothing once the scheduler is disposed", async () => {
        const { effect, runs } = await subscribeCounted();
        const access = env.runtime.scheduler.accessForTestingOnly;
        expect(runs()).toBe(1);

        env.runtime.scheduler.dispose();
        access.markAndScheduleInvalidAction(effect);
        await access.execute();

        expect(runs()).toBe(1);
      });

      it("waits for a run already under way before running anything", async () => {
        const { effect, runs } = await subscribeCounted();
        const access = env.runtime.scheduler.accessForTestingOnly;
        const running = Promise.withResolvers<void>();

        env.runtime.scheduler.runningPromise = running.promise;
        access.markAndScheduleInvalidAction(effect);
        const pass = access.execute();
        await clock.settle();
        expect(runs()).toBe(1);

        running.resolve();
        await pass;
        await env.runtime.scheduler.idle();
        expect(runs()).toBe(2);
      });
    });

    describe("accessForTestingOnly", () => {
      it("reports whether a pass is scheduled", async () => {
        const access = env.runtime.scheduler.accessForTestingOnly;
        await env.runtime.scheduler.idle();
        expect(access.scheduled).toBe(false);

        env.runtime.scheduler.queueExecution();

        expect(access.scheduled).toBe(true);
        await env.runtime.scheduler.idle();
        expect(access.scheduled).toBe(false);
      });
    });
  });

  describe("debug logging", () => {
    let debug: LogCapture;

    beforeEach(() => {
      debug = captureLogs("scheduler");
    });

    afterEach(() => {
      debug[Symbol.dispose]();
    });

    it("logs an unsubscribed action's id and how many entities it watched", async () => {
      const input = await committedCell("unsubscribe-input", 0);
      const effect: Action = (tx) => {
        input.withTx(tx).get();
      };
      const cancel = env.runtime.scheduler.subscribe(effect, {
        reads: [addressOf(input)],
        shallowReads: [],
        writes: [],
      }, { isEffect: true });
      await env.runtime.scheduler.idle();

      cancel();

      const actionId = env.runtime.scheduler.accessForTestingOnly.getActionId(
        effect,
      );
      expect(debug.messages("schedule-unsubscribe")).toContainEqual([
        `Action: ${actionId}`,
        "Entities: 1",
      ]);
    });

    it("logs an effect's debounce when a change schedules it", async () => {
      const input = await committedCell("debounce-log-input", 0);
      let runs = 0;
      const effect: Action = (tx) => {
        runs++;
        input.withTx(tx).get();
      };
      env.runtime.scheduler.subscribe(effect, {
        reads: [addressOf(input)],
        shallowReads: [],
        writes: [],
      }, { isEffect: true, debounce: 50 });
      await clock.tick(50);
      await env.runtime.scheduler.idle();
      const runsBefore = runs;

      await write(input, 1);
      await clock.settle();

      const actionId = env.runtime.scheduler.accessForTestingOnly.getActionId(
        effect,
      );
      expect(debug.messages("schedule-debounce")).toContainEqual([
        `[DEBOUNCE] Action ${actionId} debounced for 50ms`,
      ]);
      expect(runs).toBe(runsBefore);
      await clock.tick(50);
      await env.runtime.scheduler.idle();
      expect(runs).toBe(runsBefore + 1);
    });

    it("logs a debounced computation's trailing run when its input changes", async () => {
      const source = await committedCell("debounce-log-source", 1);
      const result = await committedCell("debounce-log-result", 0);
      const computation: Action = (tx) => {
        result.withTx(tx).send(source.withTx(tx).get() * 10);
      };
      env.runtime.scheduler.subscribe(computation, {
        reads: [addressOf(source)],
        shallowReads: [],
        writes: [addressOf(result)],
      }, { debounce: 50 });
      await result.pull();
      const actionId = env.runtime.scheduler.accessForTestingOnly.getActionId(
        computation,
      );
      const trailing =
        `[DEBOUNCE] Computation ${actionId} trailing flush scheduled for 50ms`;
      expect(debug.messages("schedule-debounce")).not.toContainEqual([
        trailing,
      ]);

      await write(source, 2);
      await clock.settle();

      expect(debug.messages("schedule-debounce")).toContainEqual([
        trailing,
      ]);
    });

    it("logs an effect it debounces automatically for running slowly", () => {
      const output = env.runtime.getCell<number>(space, "auto-debounce-log");
      const effect: Action = (tx) => {
        output.withTx(tx).send(1);
      };
      env.runtime.scheduler.subscribe(effect, {
        reads: [],
        shallowReads: [],
        writes: [addressOf(output)],
      }, { isEffect: true });
      const access = env.runtime.scheduler.accessForTestingOnly;
      access.actionStats.set(access.getActionId(effect), {
        runCount: 3,
        totalTime: 180,
        averageTime: 60,
        lastRunTime: 60,
        lastRunTimestamp: performance.now(),
      });

      access.maybeAutoDebounce(effect);

      expect(debug.messages("schedule-debounce")).toEqual([[
        `[AUTO-DEBOUNCE] Action ${
          access.getActionId(effect)
        } auto-debounced (avg 60.0ms >= 50ms)`,
      ]]);
    });
  });
});
