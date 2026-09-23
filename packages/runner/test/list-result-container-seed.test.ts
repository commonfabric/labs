import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Logger, type LogMessage } from "@commonfabric/utils/logger";

import {
  resumeContainerWait,
  seedResultContainerWhenPullSettles,
} from "../src/builtins/list-result-container-seed.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime, type ServerRunInfo } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

// The seed is the list coordinators' recovery for a result container that was
// never persisted: the resume reconcile defers on an undefined container and
// pulls it, and a pull that settles with the container still undefined leaves
// nothing on its way to re-trigger the reconcile.
//
// These cases drive the recovery's outcomes and both of its failure reports.
// The reports otherwise run only where a suite happens to tear a runtime down
// while a container write is in flight, so they flip between covered and
// uncovered across identical CI runs. Each case here constructs the failure it
// wants and pins the report the recovery produces from it.

const signer = await Identity.fromPassphrase("list result container seed");
const space = signer.did();

/** Stands in for a coordinator that is not being watched for a re-trigger. */
const noop = () => {};

/** A logger that keeps every warning rather than printing it. */
class RecordingLogger extends Logger {
  readonly warnings: Array<{ key: string; messages: LogMessage[] }> = [];

  override warn(key: string, ...messages: LogMessage[]): void {
    this.warnings.push({ key, messages });
  }

  /** The `{ error }` payload the warning at `index` carried. */
  reportedError(index: number): unknown {
    return (this.warnings[index].messages[1] as { error: unknown }).error;
  }
}

describe("list-result-container-seed", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let logger: RecordingLogger;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    logger = new RecordingLogger("list-result-container-seed test");
  });

  afterEach(async () => {
    // `closeStorage: false` drains the runtime's outstanding work first,
    // including the background loads a container read starts; closing under
    // them reports each one as a sync failure.
    await runtime?.dispose({ closeStorage: false });
    await storageManager?.close();
  });

  /** A fresh container cell, with no value of its own. */
  function newContainer(cause: string): Cell<any[]> {
    return runtime.getCell<any[]>(space, cause, undefined);
  }

  /** What `container` holds now, read through a transaction of its own. */
  function valueOf(container: Cell<any[]>): unknown {
    const tx = runtime.edit();
    try {
      return container.withTx(tx).getRaw();
    } finally {
      tx.abort("read-only probe");
    }
  }

  /**
   * Make every commit this runtime opens fail with `rejection`, leaving the
   * transaction's reads and writes real and only its outcome injected.
   * `AuthorizationError` without the server's `retriable` marker is a terminal
   * rejection, so `editWithRetry` reports it after a single commit.
   */
  function rejectEveryCommit(rejection: { name: string; message: string }) {
    const openTransaction = runtime.edit.bind(runtime);
    (runtime as any).edit = () => {
      const tx: IExtendedStorageTransaction = openTransaction();
      (tx as any).commit = () => {
        tx.abort(rejection);
        return Promise.resolve({ error: rejection });
      };
      return tx;
    };
  }

  /**
   * Refuse this runtime's first commit with `rejection` and let every later one
   * through, reporting how many commits were attempted. `ConflictError` is a
   * retryable rejection, so `editWithRetry` awaits the rejection's catch-up gate
   * and runs the action again.
   */
  function refuseFirstCommit(
    rejection: { name: string; message: string; readyToRetry?: () => unknown },
  ): () => number {
    const openTransaction = runtime.edit.bind(runtime);
    let commits = 0;
    (runtime as any).edit = () => {
      const tx: IExtendedStorageTransaction = openTransaction();
      const commit = tx.commit.bind(tx);
      (tx as any).commit = () => {
        commits++;
        if (commits > 1) return commit();
        tx.abort(rejection);
        return Promise.resolve({ error: rejection });
      };
      return tx;
    };
    return () => commits;
  }

  describe("seedResultContainerWhenPullSettles()", () => {
    it("writes an empty array to a container the pull left absent", async () => {
      const container = newContainer("absent-after-pull");
      expect(valueOf(container)).toBeUndefined();
      await seedResultContainerWhenPullSettles(
        runtime,
        container,
        () => true,
        noop,
        Promise.resolve(),
        logger,
        "filter/resume-seed/of:absent-after-pull",
      );
      expect(valueOf(container)).toEqual([]);
      expect(logger.warnings).toEqual([]);
    });

    it("counts against the storage settle barrier until the seed has landed", async () => {
      const container = newContainer("barrier-held-until-seeded");
      const pull = Promise.withResolvers<void>();
      const seeded = seedResultContainerWhenPullSettles(
        runtime,
        container,
        () => true,
        noop,
        pull.promise,
        logger,
        "filter/resume-seed/of:barrier-held-until-seeded",
      );
      // The cross-space promise set is what `Cell.pull()`,
      // `storageManager.synced()` and the `settled(Infinity)` drain in
      // `Runtime.dispose({ closeStorage: false })` consult, so membership in it
      // is what places the seed's write inside each of those barriers. The
      // coordinator drops the returned promise, so this registration is the
      // only thing holding the chain.
      expect(storageManager.pendingCrossSpacePromiseCount()).toBe(1);
      pull.resolve();
      await storageManager.synced();
      // Out of the set once the chain settles, and the container carries the
      // seed the chain wrote.
      expect(storageManager.pendingCrossSpacePromiseCount()).toBe(0);
      expect(valueOf(container)).toEqual([]);
      await seeded;
      expect(logger.warnings).toEqual([]);
    });

    it("leaves a container that arrived during the pull at the value it arrived with", async () => {
      const container = newContainer("arrived-during-pull");
      const pull = Promise.withResolvers<void>();
      const seeded = seedResultContainerWhenPullSettles(
        runtime,
        container,
        () => true,
        noop,
        pull.promise,
        logger,
        "filter/resume-seed/of:arrived-during-pull",
      );
      const { error } = await runtime.editWithRetry((tx) => {
        container.withTx(tx).set([1, 2, 3]);
      });
      expect(error).toBeUndefined();
      pull.resolve();
      await seeded;
      expect(valueOf(container)).toEqual([1, 2, 3]);
      expect(logger.warnings).toEqual([]);
    });

    it("writes nothing and re-triggers nothing when the coordinator no longer holds the container", async () => {
      const container = newContainer("coordinator-torn-down");
      let rearms = 0;
      await seedResultContainerWhenPullSettles(
        runtime,
        container,
        () => false,
        () => rearms++,
        Promise.resolve(),
        logger,
        "filter/resume-seed/of:coordinator-torn-down",
      );
      expect(valueOf(container)).toBeUndefined();
      expect(rearms).toBe(0);
      expect(logger.warnings).toEqual([]);
    });

    it("seeds after a rejected pull and reports the rejection", async () => {
      const container = newContainer("rejected-pull");
      const pullFailure = new Error("the container pull could not complete");
      // Awaiting proves the returned promise resolves: the coordinator drops
      // it, so a rejection here would surface as an unhandled rejection with
      // nothing left to report it.
      await seedResultContainerWhenPullSettles(
        runtime,
        container,
        () => true,
        noop,
        Promise.reject(pullFailure),
        logger,
        "filter/resume-seed/of:rejected-pull",
      );
      expect(valueOf(container)).toEqual([]);
      expect(logger.warnings.length).toBe(1);
      expect(logger.warnings[0].key).toBe("resume-pull");
      expect(logger.reportedError(0)).toBe(pullFailure);
    });

    it("writes nothing on a retry the coordinator released the container before", async () => {
      const container = newContainer("released-between-attempts");
      let held = true;
      // The catch-up gate runs between the refused attempt and the retry, which
      // is the window a coordinator's teardown lands in.
      const commits = refuseFirstCommit({
        name: "ConflictError",
        message: "stale confirmed read: of:test at seq 0 conflicted with seq 9",
        readyToRetry: () => {
          held = false;
          return Promise.resolve();
        },
      });
      await seedResultContainerWhenPullSettles(
        runtime,
        container,
        () => held,
        noop,
        Promise.resolve(),
        logger,
        "filter/resume-seed/of:released-between-attempts",
      );
      // The retry ran, and wrote nothing: a seed that only asked once would
      // have re-written the container on this attempt.
      expect(commits()).toBe(2);
      expect(valueOf(container)).toBeUndefined();
      expect(logger.warnings).toEqual([]);
    });

    it("reports a seed whose commit the storage layer refused", async () => {
      const container = newContainer("refused-seed");
      const rejection = {
        name: "AuthorizationError",
        message: "the space refused the seed",
      };
      rejectEveryCommit(rejection);
      await seedResultContainerWhenPullSettles(
        runtime,
        container,
        () => true,
        noop,
        Promise.resolve(),
        logger,
        "filter/resume-seed/of:refused-seed",
      );
      expect(valueOf(container)).toBeUndefined();
      expect(logger.warnings.length).toBe(1);
      expect(logger.warnings[0].key).toBe("resume-seed");
      expect(logger.warnings[0].messages[0]).toBe(
        "seeding the empty result container failed",
      );
      expect(logger.reportedError(0)).toBe(rejection);
    });

    it("retains each deferred seed's identity when pulls settle in reverse order", async () => {
      const firstIdentity = { ...runtime.scopeKeyIdentity };
      const other = await Identity.fromPassphrase("other deferred seed owner");
      const secondIdentity = { ...firstIdentity, principal: other.did() };
      const identities = [firstIdentity, secondIdentity];
      const pulls = identities.map(() => Promise.withResolvers<void>());
      const containers = identities.map((_, index) =>
        newContainer(`identity-seed-${index}`)
      );
      const stamped: ServerRunInfo[] = [];
      const transactionIdentities: unknown[] = [];
      const stamp = runtime.stampServerRun.bind(runtime);
      (runtime as any).stampServerRun = (
        tx: IExtendedStorageTransaction,
        info: ServerRunInfo,
      ) => {
        transactionIdentities.push(tx.tx.scopeKeyIdentity);
        stamped.push(info);
        stamp(tx, info);
      };
      const pending = identities.map((identity, index) =>
        seedResultContainerWhenPullSettles(
          runtime,
          containers[index],
          () => true,
          noop,
          pulls[index].promise,
          logger,
          `identity-seed-${index}`,
          identity,
        )
      );
      expect(stamped).toEqual([]);
      pulls[1].resolve();
      await pending[1];
      expect(valueOf(containers[0])).toBeUndefined();
      expect(valueOf(containers[1])).toEqual([]);
      pulls[0].resolve();
      await pending[0];
      expect(valueOf(containers[0])).toEqual([]);
      expect(transactionIdentities).toEqual([secondIdentity, firstIdentity]);
      expect(stamped).toEqual([1, 0].map((index) => ({
        actionId: `identity-seed-${index}`,
        kind: "bookkeeping",
        scopeKeyIdentity: identities[index],
      })));
      expect(logger.warnings).toEqual([]);
    });

    it("stamps every seed attempt's transaction as sanctioned bookkeeping", async () => {
      const container = newContainer("stamped-seed");
      // The seed transaction is minted outside any scheduler run, so nothing
      // else stamps it, and a SERVING runtime's wave refuses an unstamped
      // seal (serving-loop.md §3d). A refused first commit forces a retry,
      // and each attempt opens a fresh transaction — the stamp has to land
      // on every one of them, or the retry's seal is the unstamped commit
      // the wave refuses.
      const commits = refuseFirstCommit({
        name: "ConflictError",
        message: "stale confirmed read: of:test at seq 0 conflicted with seq 9",
        readyToRetry: () => Promise.resolve(),
      });
      const stamped: ServerRunInfo[] = [];
      const stamp = runtime.stampServerRun.bind(runtime);
      (runtime as any).stampServerRun = (
        tx: IExtendedStorageTransaction,
        info: ServerRunInfo,
      ) => {
        stamped.push(info);
        stamp(tx, info);
      };
      await seedResultContainerWhenPullSettles(
        runtime,
        container,
        () => true,
        noop,
        Promise.resolve(),
        logger,
        "filter/resume-seed/of:stamped-seed",
      );
      expect(commits()).toBe(2);
      expect(stamped).toEqual([
        { actionId: "filter/resume-seed/of:stamped-seed", kind: "bookkeeping" },
        { actionId: "filter/resume-seed/of:stamped-seed", kind: "bookkeeping" },
      ]);
      expect(valueOf(container)).toEqual([]);
      expect(logger.warnings).toEqual([]);
    });

    it("re-triggers the coordinator after seeding the container", async () => {
      const container = newContainer("retrigger-after-seed");
      let rearms = 0;
      await seedResultContainerWhenPullSettles(
        runtime,
        container,
        () => true,
        () => rearms++,
        Promise.resolve(),
        logger,
        "map/resume-seed/of:retrigger-after-seed",
      );
      expect(valueOf(container)).toEqual([]);
      expect(rearms).toBe(1);
      expect(logger.warnings).toEqual([]);
    });

    it("re-triggers the coordinator when the container already held a value", async () => {
      // The coordinator defers on its own read of the container, and the seed
      // decides whether to write from the durable view. The two can disagree:
      // a client speculation layer standing on the container hides a value the
      // durable view has, and the coordinator then waits while the seed
      // declines. Nothing was written, so a wait that ended only on the write
      // would never end. The pull settling is what ends it.
      const container = newContainer("retrigger-without-seed");
      const { error } = await runtime.editWithRetry((tx) => {
        container.withTx(tx).set(["already here"]);
      });
      expect(error).toBeUndefined();
      let rearms = 0;
      await seedResultContainerWhenPullSettles(
        runtime,
        container,
        () => true,
        () => rearms++,
        Promise.resolve(),
        logger,
        "map/resume-seed/of:retrigger-without-seed",
      );
      expect(valueOf(container)).toEqual(["already here"]);
      expect(rearms).toBe(1);
      expect(logger.warnings).toEqual([]);
    });

    it("re-triggers the coordinator after a rejected pull", async () => {
      // A pull that rejects leaves the container as absent as a resolved one
      // does, and leaves the coordinator waiting the same way.
      const container = newContainer("retrigger-after-rejected-pull");
      let rearms = 0;
      await seedResultContainerWhenPullSettles(
        runtime,
        container,
        () => true,
        () => rearms++,
        Promise.reject(new Error("the container pull could not complete")),
        logger,
        "map/resume-seed/of:retrigger-after-rejected-pull",
      );
      expect(valueOf(container)).toEqual([]);
      expect(rearms).toBe(1);
      expect(logger.warnings.length).toBe(1);
      expect(logger.warnings[0].key).toBe("resume-pull");
    });

    it("carries the viewing identity into every deferred seed attempt", async () => {
      const container = newContainer("viewing-instance-seed");
      const identity = {
        principal: (await Identity.fromPassphrase("list seed viewer")).did(),
        sessionId: "viewer-session",
      };
      const commits = refuseFirstCommit({
        name: "ConflictError",
        message: "stale confirmed read: of:test at seq 0 conflicted with seq 9",
        readyToRetry: () => Promise.resolve(),
      });
      const stamped: ServerRunInfo[] = [];
      const transactionIdentities:
        IExtendedStorageTransaction["tx"]["scopeKeyIdentity"][] = [];
      const stamp = runtime.stampServerRun.bind(runtime);
      runtime.stampServerRun = (tx, info) => {
        transactionIdentities.push(tx.tx.scopeKeyIdentity);
        stamped.push(info);
        stamp(tx, info);
      };
      const pull = Promise.withResolvers<void>();
      const seeded = seedResultContainerWhenPullSettles(
        runtime,
        container,
        () => true,
        noop,
        pull.promise,
        logger,
        "map/resume-seed/viewing-instance",
        identity,
      );
      pull.resolve();
      await seeded;
      expect(commits()).toBe(2);
      expect(transactionIdentities).toEqual([identity, identity]);
      expect(stamped.map((info) => info.scopeKeyIdentity)).toEqual([
        identity,
        identity,
      ]);
      expect(logger.warnings).toEqual([]);
    });
  });

  describe("resumeContainerWait()", () => {
    // The wait a resuming coordinator takes on one container. Its answer to
    // `mayWait` is what the coordinator's reconcile asks before it reads the
    // container, so the cases here are about which reconciles wait and which
    // go on.

    it("lets the reconcile after the pull through, having seeded the container", async () => {
      const wait = resumeContainerWait(
        runtime,
        logger,
        "map/resume-seed/of:waited-once",
      );
      const container = newContainer("waited-once");
      let rearms = 0;
      expect(wait.mayWait(container)).toBe(true);
      wait.begin(container, () => true, () => rearms++);
      await storageManager.synced();
      // The wait ended: the coordinator was re-armed, the container carries
      // the empty array the seed wrote, and the reconcile that re-arm starts
      // reconciles rather than wait again.
      expect(rearms).toBe(1);
      expect(valueOf(container)).toEqual([]);
      expect(wait.mayWait(container)).toBe(false);
      expect(logger.warnings).toEqual([]);
    });

    it("joins an outstanding wait rather than opening a second one", async () => {
      const wait = resumeContainerWait(
        runtime,
        logger,
        "map/resume-seed/of:joined-wait",
      );
      const container = newContainer("joined-wait");
      let rearms = 0;
      // Both calls land in one synchronous turn, so the first one's pull is
      // still outstanding when the second arrives — the window a reconcile
      // triggered while a coordinator waits falls in.
      wait.begin(container, () => true, () => rearms++);
      wait.begin(container, () => true, () => rearms++);
      // One chain, not two: the settle barrier counts what the wait
      // registered, and a second pull would have registered a second.
      expect(storageManager.pendingCrossSpacePromiseCount()).toBe(1);
      await storageManager.synced();
      expect(rearms).toBe(1);
      expect(valueOf(container)).toEqual([]);
      expect(logger.warnings).toEqual([]);
    });

    it("waits afresh for a container the coordinator let go and took up again", async () => {
      const wait = resumeContainerWait(
        runtime,
        logger,
        "map/resume-seed/of:returned-container",
      );
      const container = newContainer("returned-container");
      let held = false;
      let rearms = 0;
      // The coordinator has swapped this container away by the time the pull
      // settles, so the wait ends having told it nothing: nothing is re-armed
      // and nothing is written.
      wait.begin(container, () => held, () => rearms++);
      await storageManager.synced();
      expect(rearms).toBe(0);
      expect(valueOf(container)).toBeUndefined();
      expect(wait.mayWait(container)).toBe(true);

      // It takes the same container up again. The wait it takes now runs to a
      // re-arm of its own, where joining the settled one would answer nobody.
      held = true;
      wait.begin(container, () => held, () => rearms++);
      await storageManager.synced();
      expect(rearms).toBe(1);
      expect(valueOf(container)).toEqual([]);
      expect(wait.mayWait(container)).toBe(false);
      expect(logger.warnings).toEqual([]);
    });

    it("waits again for a container that replaced the one it waited for", async () => {
      const wait = resumeContainerWait(
        runtime,
        logger,
        "map/resume-seed/of:replacement-container",
      );
      const first = newContainer("replaced-container");
      const second = newContainer("replacement-container");
      wait.begin(first, () => true, noop);
      await storageManager.synced();
      // A replacement's own state is what its first reconcile confirms, so the
      // wait the first container spent is not spent for it.
      expect(wait.mayWait(first)).toBe(false);
      expect(wait.mayWait(second)).toBe(true);
      expect(logger.warnings).toEqual([]);
    });
  });
});
