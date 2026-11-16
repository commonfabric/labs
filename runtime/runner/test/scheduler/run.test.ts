import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Cell } from "../../src/cell.ts";
import type { Action } from "../../src/scheduler/types.ts";
import type { StorageDiagnostics } from "../../src/storage/diagnostics.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type SchedulerTestRuntime,
  space,
  toMemorySpaceAddress,
} from "../scheduler-test-utils.ts";
import { captureLogs, type LogCapture } from "../support/log-capture.ts";

describe("run", () => {
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

  /** Declares the cells an action writes, which is its write surface. */
  function declareWrites(action: Action, cells: readonly Cell<unknown>[]) {
    Object.assign(action, {
      writes: cells.map((cell) => cell.getAsNormalizedFullLink()),
    });
  }

  function addressOf(cell: Cell<unknown>) {
    return toMemorySpaceAddress(cell.getAsNormalizedFullLink());
  }

  describe("committing a reactive run", () => {
    it("lists the run's disposition among the storage's pending commits", async () => {
      // Each time the scheduler registers a pending commit, the case reads
      // the storage diagnostics as they stand at that moment.
      const manager = env.storageManager;
      const track = manager.trackPendingCommit;
      const pending: StorageDiagnostics["pendingCommits"][] = [];
      Object.assign(manager, {
        trackPendingCommit: (...args: Parameters<typeof track>) => {
          track.apply(manager, args);
          pending.push(manager.getDiagnostics().pendingCommits);
        },
      });
      try {
        const input = await committedCell("disposition-input", 1);
        const output = await committedCell("disposition-output", 0);
        const effect: Action = (tx) => {
          output.withTx(tx).send(input.withTx(tx).get() + 1);
        };
        declareWrites(effect, [output]);
        env.runtime.scheduler.subscribe(effect, {
          reads: [addressOf(input)],
          shallowReads: [],
          writes: [addressOf(output)],
        }, { isEffect: true });
        await env.runtime.scheduler.idle();

        expect(output.get()).toBe(2);
        expect(
          pending.flat().filter((entry) => entry.kind === "action-disposition"),
        ).toContainEqual(expect.objectContaining({
          kind: "action-disposition",
          spaces: [space],
          spacesOmitted: 0,
        }));
      } finally {
        Object.assign(manager, { trackPendingCommit: track });
      }
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

    it("logs a write outside the computation's declared surface", async () => {
      const input = await committedCell("surface-input", 0);
      const declared = await committedCell("surface-declared", 0);
      const undeclared = await committedCell("surface-undeclared", 0);
      const computation: Action = (tx) => {
        const value = input.withTx(tx).get();
        declared.withTx(tx).send(value + 1);
        undeclared.withTx(tx).send(value + 2);
      };
      declareWrites(computation, [declared]);

      env.runtime.scheduler.subscribe(computation, {
        reads: [addressOf(input)],
        shallowReads: [],
        writes: [addressOf(declared)],
      }, {});
      await declared.pull();

      const actionId = env.runtime.scheduler.accessForTestingOnly.getActionId(
        computation,
      );
      const violations = debug.messages("write-surface-violation");
      expect(violations.map(([message]) => message)).toEqual([
        `Action ${actionId} wrote outside its declared surface`,
      ]);
      expect(violations[0][1]).toMatchObject({
        id: undeclared.getAsNormalizedFullLink().id,
      });
    });
  });
});
