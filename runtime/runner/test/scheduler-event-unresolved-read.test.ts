import type { ServedEventFailureOutcome } from "../src/scheduler/types.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import type { ScopedReadStanding } from "../src/storage/interface.ts";
import { ReplicaLoadFailureError } from "../src/storage/interface.ts";
import {
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  type EventHandler,
  expect,
  it,
  type SchedulerTestRuntime,
  space,
} from "./scheduler-test-utils.ts";

describe("a served run that read a document under an unresolved grant", () => {
  // The storage manager answers "unresolved" for a foreign scoped read whose
  // actor's grant is still being asked for (protocol.md §2's grant-scoped
  // read), and the read kicks the instance's load. A served run that reaches
  // such a document in its body alone is withdrawn and re-queued behind that
  // load (events.md §5). What the cases below pin is how the re-queued entry
  // leaves the queue: through a re-run once the load settles, and through
  // the dispatch-load failure path when the load fails.

  let env: SchedulerTestRuntime;

  beforeEach(() => {
    env = createSchedulerTestRuntime(import.meta.url);
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime(env);
  });

  type StubbedManager = {
    scopedReadStanding(
      address: { space: string; id: string; scope?: string },
    ): ScopedReadStanding;
    loadsSettled(keys: readonly string[]): Promise<void>;
  };

  /**
   * Queues one served event whose handler reads `cold`, which the manager
   * reports as unresolved until `settle` is called, and whose load the
   * returned `load` settles. Returns the handler's run count, the failure
   * outcomes the event reported, and the keys the re-queue awaited.
   */
  async function dispatchReadingUnresolved(name: string) {
    const { runtime, tx } = env;
    const cold = runtime.getCell<string>(space, `${name}-cold`, undefined);
    const eventCell = runtime.getCell<number>(
      space,
      `${name}-events`,
      undefined,
    );
    await tx.commit().settled;
    env.tx = runtime.edit();

    const link = cold.getAsNormalizedFullLink();
    const key = `${link.space}/${link.scope}/${link.id}`;
    let resolved = false;
    const load = Promise.withResolvers<void>();
    const awaited = Promise.withResolvers<readonly string[]>();
    const manager = runtime.storageManager as unknown as StubbedManager;
    manager.scopedReadStanding = (address) =>
      address.id === link.id && !resolved ? "unresolved" : "admitted";
    manager.loadsSettled = (keys) => {
      awaited.resolve(keys);
      return load.promise;
    };

    const runs = { count: 0 };
    const handler: EventHandler = (actionTx) => {
      runs.count++;
      cold.withTx(actionTx).get();
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
    );

    const outcomes: ServedEventFailureOutcome[] = [];
    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      1,
      true,
      undefined,
      false,
      {
        eventId: `evt:${name}`,
        served: {
          streamEntry: { sidecarId: `of:${name}-stream`, index: 0, seq: 1 },
          onFailure: (outcome) => outcomes.push(outcome),
        },
      },
    );
    expect(await awaited.promise).toEqual([key]);
    expect(runs.count).toBe(1);
    expect(outcomes).toEqual([]);

    return {
      key,
      runs,
      outcomes,
      load,
      eventLink: eventCell.getAsNormalizedFullLink(),
      settle: () => {
        resolved = true;
      },
    };
  }

  it("runs again once the load it read under settles", async () => {
    const { runs, outcomes, load, settle } = await dispatchReadingUnresolved(
      "unresolved-settles",
    );

    settle();
    load.resolve();
    await env.runtime.idle();
    await env.runtime.scheduler.idleWithPendingCommits();

    expect(runs.count).toBe(2);
    expect(outcomes).toEqual([]);
  });

  it("fails as a load that failed before dispatch when the load fails, holding a later same-space served event behind it", async () => {
    const { key, runs, outcomes, load, eventLink } =
      await dispatchReadingUnresolved("unresolved-fails");
    const followerLink: NormalizedFullLink = {
      ...eventLink,
      id: "of:unresolved-fails-follower",
    };
    const followerRuns: unknown[] = [];
    const followerOutcomes: ServedEventFailureOutcome[] = [];
    env.runtime.scheduler.addEventHandler((_tx, value) => {
      followerRuns.push(value);
    }, followerLink);
    env.runtime.scheduler.queueEvent(
      followerLink,
      2,
      true,
      undefined,
      false,
      {
        eventId: "evt:unresolved-fails-follower",
        served: {
          streamEntry: {
            sidecarId: "of:unresolved-fails-follower-stream",
            index: 0,
            seq: 2,
          },
          onFailure: (outcome) => followerOutcomes.push(outcome),
        },
      },
    );

    const failure = {
      failureClass: "connection" as const,
      recoveryEpoch: `load-key:${key}`,
      permanentEvidence: false,
    };
    load.reject(
      new ReplicaLoadFailureError(failure, new Error("replica unavailable")),
    );
    await env.runtime.idle();
    await env.runtime.scheduler.idleWithPendingCommits();

    // The run is not repeated against a replica whose load failed: the entry
    // is deferred with the load's typed failure, the way the preflight's park
    // fails a head, and the later arrival carries the barrier, not the
    // failure.
    expect(runs.count).toBe(1);
    expect(outcomes).toEqual([{
      kind: "deferred",
      cause: "load-park",
      role: "failed-head",
      failure,
    }]);
    expect(followerRuns).toEqual([]);
    expect(followerOutcomes).toEqual([{
      kind: "deferred",
      cause: "arrival-barrier",
      blockedBy: "evt:unresolved-fails",
    }]);
  });
});
