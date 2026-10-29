import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import type { EventHandler } from "../src/scheduler.ts";
import {
  EventHandlerNotRunError,
  HANDLER_NOT_RUN_BACKOFF_LIMIT,
} from "../src/scheduler/backpressure.ts";
import type { IStorageNotification } from "../src/storage/interface.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type SchedulerTestRuntime,
  space,
} from "./scheduler-test-utils.ts";

const NOT_RUN_REASON = "action argument is undefined (test)";

describe("event dispatch whose handler body did not run", () => {
  // A handler run that records `tx.dispatchedHandlerNotRun` on its
  // transaction stands for the runner's argument-did-not-resolve skip. The
  // handlers below record it themselves, so what each case pins is the
  // scheduler's disposition of the marker on a client dispatch: withdrawn
  // and re-run, never sealed as an empty commit.

  let env: SchedulerTestRuntime;

  beforeEach(() => {
    env = createSchedulerTestRuntime(import.meta.url);
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime(env);
  });

  // Counts the commits that carry a change, so a sealed skip — an empty
  // commit — is told apart from the run that wrote.
  function countCommittedChanges(): () => number {
    let commits = 0;
    const subscription: IStorageNotification = {
      next(notification) {
        if (notification.type === "commit") {
          for (const _change of notification.changes) {
            commits++;
            break;
          }
        }
        return { done: false };
      },
    };
    env.storageManager.subscribe(subscription);
    return () => commits;
  }

  it("re-runs the handler once the marker is gone, and fires the commit callback once, on the run that wrote", async () => {
    const { runtime, tx } = env;
    const target = runtime.getCell<number>(space, "not-run-target", undefined);
    const eventCell = runtime.getCell<number>(
      space,
      "not-run-events",
      undefined,
    );
    await tx.commit().settled;
    env.tx = runtime.edit();
    const committedChanges = countCommittedChanges();

    let runs = 0;
    const handler: EventHandler = (actionTx, event: number) => {
      runs++;
      if (runs === 1) {
        actionTx.dispatchedHandlerNotRun = { reason: NOT_RUN_REASON };
        return;
      }
      target.withTx(actionTx).send(event);
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
    );

    const callbackStatuses: string[] = [];
    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      7,
      true,
      (commitTx) => {
        callbackStatuses.push(commitTx.status().status);
      },
    );
    await runtime.idle();
    await runtime.scheduler.idleWithPendingCommits();

    expect(runs).toBe(2);
    expect(target.get()).toBe(7);
    expect(callbackStatuses).toEqual(["done"]);
    expect(committedChanges()).toBe(1);
  });

  it("parks the re-run on a load the run's own reads registered, and dispatches when it settles", async () => {
    const { runtime, tx } = env;
    const coldDoc = runtime.getCell<string>(space, "not-run-cold", undefined);
    const target = runtime.getCell<string>(
      space,
      "not-run-park-target",
      undefined,
    );
    const eventCell = runtime.getCell<number>(
      space,
      "not-run-park-events",
      undefined,
    );
    await tx.commit().settled;
    env.tx = runtime.edit();

    // The cold document's load is in flight for as long as the test holds
    // `load` open; the storage manager reports it pending, and settles it
    // through the promise the park awaits.
    const link = coldDoc.getAsNormalizedFullLink();
    const key = `${link.space}/${link.scope}/${link.id}`;
    const load = Promise.withResolvers<void>();
    const parked = Promise.withResolvers<readonly string[]>();
    const manager = runtime.storageManager as unknown as {
      pendingLoadAddresses(): readonly {
        space: string;
        scope: string;
        id: string;
      }[];
      pendingLoadGeneration(key: string): number | undefined;
      loadsSettled(keys: readonly string[]): Promise<void>;
    };
    manager.pendingLoadAddresses = () => [{
      space: link.space,
      scope: link.scope,
      id: link.id,
    }];
    manager.pendingLoadGeneration = (candidate) =>
      candidate === key ? 1 : undefined;
    manager.loadsSettled = (keys) => {
      parked.resolve(keys);
      return load.promise;
    };

    let runs = 0;
    const handler: EventHandler = (actionTx) => {
      runs++;
      // The read is what puts the cold document in the run's log, which is
      // what the park is keyed on.
      const value = coldDoc.withTx(actionTx).get();
      if (runs === 1) {
        actionTx.dispatchedHandlerNotRun = { reason: NOT_RUN_REASON };
        return;
      }
      target.withTx(actionTx).send(`ran with ${value}`);
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
    );

    let callbackRuns = 0;
    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      1,
      true,
      () => {
        callbackRuns++;
      },
    );
    expect(await parked.promise).toEqual([key]);
    expect(runs).toBe(1);
    expect(callbackRuns).toBe(0);

    load.resolve();
    await runtime.idle();
    await runtime.scheduler.idleWithPendingCommits();
    expect(runs).toBe(2);
    expect(target.get()).toBe("ran with undefined");
    expect(callbackRuns).toBe(1);
  });

  // Drives a handler that never runs through its re-runs and returns what
  // the outcome looked like from outside: how many dispatches there were,
  // what the commit callback saw, how many commits carried a change, and
  // what reached the error channel.
  async function runNeverResolvingHandler(
    cellName: string,
  ): Promise<{
    runs: number;
    callbackStatuses: string[];
    committedChanges: number;
    errors: Error[];
  }> {
    const { runtime, tx } = env;
    const eventCell = runtime.getCell<number>(space, cellName, undefined);
    await tx.commit().settled;
    env.tx = runtime.edit();
    const committedChanges = countCommittedChanges();

    let runs = 0;
    const handler: EventHandler = (actionTx) => {
      runs++;
      actionTx.dispatchedHandlerNotRun = { reason: NOT_RUN_REASON };
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
    );
    const errors: Error[] = [];
    runtime.scheduler.onError((error) => {
      errors.push(error);
    });

    const callbackStatuses: string[] = [];
    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      1,
      true,
      (commitTx) => {
        callbackStatuses.push(commitTx.status().status);
      },
    );
    await runtime.idle();
    await runtime.scheduler.idleWithPendingCommits();
    return {
      runs,
      callbackStatuses,
      committedChanges: committedChanges(),
      errors,
    };
  }

  it("fails through the error channel after `HANDLER_NOT_RUN_BACKOFF_LIMIT` re-runs with nothing to park on, with the callback seeing the aborted transaction", async () => {
    const outcome = await runNeverResolvingHandler("not-run-limit-events");

    expect(outcome.runs).toBe(HANDLER_NOT_RUN_BACKOFF_LIMIT + 1);
    expect(outcome.callbackStatuses).toEqual(["error"]);
    expect(outcome.committedChanges).toBe(0);
    expect(outcome.errors).toHaveLength(1);
    const error = outcome.errors[0];
    expect(error).toBeInstanceOf(EventHandlerNotRunError);
    expect((error as EventHandlerNotRunError).reason).toBe(NOT_RUN_REASON);
    expect((error as EventHandlerNotRunError).attempts).toBe(outcome.runs);
    expect(error.message).toContain(NOT_RUN_REASON);
  });

  it("fails on the first dispatch when the retry window is already spent", async () => {
    await disposeSchedulerTestRuntime(env);
    env = createSchedulerTestRuntime(import.meta.url, {
      commitBackpressure: { retryWindowMs: 0 },
    });
    const outcome = await runNeverResolvingHandler("not-run-window-events");

    expect(outcome.runs).toBe(1);
    expect(outcome.callbackStatuses).toEqual(["error"]);
    expect(outcome.committedChanges).toBe(0);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toBeInstanceOf(EventHandlerNotRunError);
    expect((outcome.errors[0] as EventHandlerNotRunError).attempts).toBe(1);
  });

  it("drops a one-shot (`retries: false`) at once, with the callback seeing the aborted transaction and nothing on the error channel", async () => {
    const { runtime, tx } = env;
    const eventCell = runtime.getCell<number>(
      space,
      "not-run-one-shot-events",
      undefined,
    );
    await tx.commit().settled;
    env.tx = runtime.edit();
    const committedChanges = countCommittedChanges();

    let runs = 0;
    const handler: EventHandler = (actionTx) => {
      runs++;
      actionTx.dispatchedHandlerNotRun = { reason: NOT_RUN_REASON };
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
    );
    const errors: Error[] = [];
    runtime.scheduler.onError((error) => {
      errors.push(error);
    });

    const callbackStatuses: string[] = [];
    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      1,
      false,
      (commitTx) => {
        callbackStatuses.push(commitTx.status().status);
      },
    );
    await runtime.idle();
    await runtime.scheduler.idleWithPendingCommits();

    expect(runs).toBe(1);
    expect(callbackStatuses).toEqual(["error"]);
    expect(committedChanges()).toBe(0);
    expect(errors).toEqual([]);
  });

  it("seals the skip of a flag-ON client echo, which the server re-drains, instead of re-running it", async () => {
    await disposeSchedulerTestRuntime(env);
    env = createSchedulerTestRuntime(import.meta.url, {
      experimental: { serverExecution: true },
    });
    const { runtime, tx } = env;
    const eventCell = runtime.getCell<number>(
      space,
      "not-run-echo-events",
      undefined,
    );
    await tx.commit().settled;
    env.tx = runtime.edit();

    let runs = 0;
    const handler: EventHandler = (actionTx) => {
      runs++;
      actionTx.dispatchedHandlerNotRun = { reason: NOT_RUN_REASON };
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
    );
    const errors: Error[] = [];
    runtime.scheduler.onError((error) => {
      errors.push(error);
    });

    const callbackStatuses: string[] = [];
    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      1,
      true,
      (commitTx) => {
        callbackStatuses.push(commitTx.status().status);
      },
    );
    await runtime.idle();
    await runtime.scheduler.idleWithPendingCommits();

    expect(runs).toBe(1);
    expect(callbackStatuses).toEqual(["done"]);
    expect(errors).toEqual([]);
  });
});
