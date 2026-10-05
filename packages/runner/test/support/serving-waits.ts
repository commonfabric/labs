// Event-driven waits for the suites that drive a live memory server, and
// usually a live ExecutorHost with it (docs/development/waiting-in-tests.md).
// Those suites watch state that only the server produces — a wave's derived
// writes, a session instance's contents, the watermark — and none of it is
// reachable from a cell sink alone, which is what made a poll loop the reflex.
// Each wait here names the event it sleeps on instead.

import { defer, type Deferred } from "@commonfabric/utils/defer";
import { stuckNet, withStuckNet } from "@commonfabric/test-support/stuck-net";
import * as Engine from "@commonfabric/memory/v2/engine";
import type { Runtime } from "../../src/runtime.ts";
import type {
  IStorageNotification,
  MemorySpace,
} from "../../src/storage/interface.ts";
import { waitForSettled } from "../../src/executor/watermark.ts";

/**
 * A source of wake-ups. Installing `wake` returns the function that detaches
 * it again, so a wait can hold several at once and release them together.
 */
export type Edge = (wake: () => void) => () => void;

/**
 * Resolve once `predicate` holds, sleeping on `edges` between attempts. Every
 * wait in this module is this loop over one edge or another, and a wait whose
 * subject moves on two different edges takes both: the first to fire wakes the
 * next attempt.
 *
 * The predicate may be async, for a condition that is itself a read across the
 * wire — resolving a link and then its target, say, or settling a runtime
 * before comparing one of its cells.
 *
 * Every wait here carries a stuck-condition net. A live SpaceServer renews its
 * lease on a repeating timer, so the process holding one never goes quiet and
 * Deno's pending-promise report never fires; without a net a wait whose
 * condition never arrives burns the whole job. The failure it raises names no
 * condition, because these waits carry no labels; its stack names the call
 * site, which is more precise.
 */
export const awaitEdges = async (
  edges: readonly Edge[],
  predicate: () => boolean | Promise<boolean>,
): Promise<void> => {
  let changed = defer<void>();
  // A cell sink resubscribes as its action finalizes, so a detach issued from
  // that action's own continuation — which is where this wait returns — does
  // not always land. The flag is what makes the wake stop regardless.
  let waiting = true;
  const detach = edges.map((edge) =>
    edge(() => {
      if (!waiting) return;
      changed.resolve();
      changed = defer<void>();
    })
  );
  const stuck = stuckNet("a serving-suite wait's condition");
  try {
    while (true) {
      // Captured before the read, so an arrival racing the predicate wakes the
      // next attempt instead of being missed.
      const next = changed.promise;
      if (await predicate()) return;
      await Promise.race([next, stuck.rejects]);
    }
  } finally {
    waiting = false;
    stuck.clear();
    for (const off of detach) off();
  }
};

/**
 * A record of things that arrived through a callback the test registered — a
 * navigate callback, a scheduler `onError`, a transport hook — with a promise
 * per arrival, so a test waits on the arrival itself rather than on a count
 * turning true.
 */
export class ArrivalLog<T> {
  readonly entries: T[] = [];
  readonly #counts: Deferred<void>[] = [];
  readonly #matchers = new Set<
    { predicate: (entry: T) => boolean; deferred: Deferred<T> }
  >();
  readonly #watchers = new Set<() => void>();

  /** Call this from the callback. */
  readonly record = (entry: T): void => {
    this.entries.push(entry);
    this.#counts[this.entries.length - 1]?.resolve();
    for (const matcher of [...this.#matchers]) {
      if (!matcher.predicate(entry)) continue;
      this.#matchers.delete(matcher);
      matcher.deferred.resolve(entry);
    }
    for (const watcher of [...this.#watchers]) watcher();
  };

  /** Resolves once the `n`th entry has arrived. `n` counts from one.
   * Carries the same stuck-condition net as {@link awaitEdges}, for the
   * same reason: an arrival that never comes would otherwise hang the
   * run rather than fail it. */
  reached(n: number): Promise<void> {
    if (n < 1) throw new RangeError(`arrival ${n} is not a position`);
    if (this.entries.length >= n) return Promise.resolve();
    while (this.#counts.length < n) this.#counts.push(defer<void>());
    return withStuckNet(this.#counts[n - 1].promise, `arrival ${n}`);
  }

  /** Resolves with the first entry `predicate` accepts, one already
   * recorded included. Netted like {@link reached}. */
  matching(predicate: (entry: T) => boolean): Promise<T> {
    for (const entry of this.entries) {
      if (predicate(entry)) return Promise.resolve(entry);
    }
    const deferred = defer<T>();
    this.#matchers.add({ predicate, deferred });
    return withStuckNet(deferred.promise, "an arrival matching a predicate");
  }

  /** How many entries `predicate` accepts. */
  count(predicate: (entry: T) => boolean): number {
    return this.entries.filter(predicate).length;
  }

  /** This log as an {@link Edge}: every arrival wakes the waiter. */
  readonly edge: Edge = (wake) => {
    this.#watchers.add(wake);
    return () => {
      this.#watchers.delete(wake);
    };
  };
}

/**
 * Resolve once `predicate` holds, re-checking on each arrival `log` records.
 * For state that moves inside something the log reports — a loop's counters
 * over its own cycles, say — where the entries themselves say nothing.
 */
export const awaitEach = <T>(
  log: ArrivalLog<T>,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> => awaitEdges([log.edge], predicate);

/** The watch side of the memory server — what {@link admittedCommits}
 * installs on. */
export interface CommitWatchableServer {
  watchAdmittedCommits(watcher: () => void): () => void;
}

/**
 * Every commit the memory server admits — a client transact, a delegated
 * append, the server's own direct write, and the serving loop's own wave
 * commits. The store's "something landed" edge, for state the server produces
 * and no client subscribes to: a doc outside every replica's watch set, a
 * commit's class, a scan over the space's own tables.
 */
export const admittedCommits =
  (server: CommitWatchableServer): Edge => (wake) =>
    server.watchAdmittedCommits(wake);

/** Resolve once `predicate` holds, sleeping on {@link admittedCommits}. The
 * predicate reads the engine, which is the store's truth. */
export const awaitAdmitted = (
  server: CommitWatchableServer,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> => awaitEdges([admittedCommits(server)], predicate);

/** The subscribe side of a storage manager — what {@link replicaChanges}
 * installs on. */
export interface NotifyingManager {
  subscribe(subscription: IStorageNotification): void;
  /** Optional on `IStorageManager`; the edge detaches when it is there. */
  unsubscribe?(subscription: IStorageNotification): void;
}

/**
 * Every change a client's replica integrates. This is the edge for what the
 * watermark does not imply: a write the serving loop makes as its own
 * bookkeeping, or one a wave the watermark already covered will make on a
 * later pass.
 */
export const replicaChanges = (manager: NotifyingManager): Edge => (wake) => {
  // `done` is the protocol's own way off the list, and it is what detaches
  // this edge from a manager that has no `unsubscribe`.
  let attached = true;
  const subscription: IStorageNotification = {
    next: () => {
      if (!attached) return { done: true };
      wake();
      return { done: false };
    },
  };
  manager.subscribe(subscription);
  return () => {
    attached = false;
    manager.unsubscribe?.(subscription);
  };
};

/**
 * Resolve once `predicate` holds, sleeping on {@link replicaChanges}.
 *
 * A predicate that compares one of the client's own cells belongs behind
 * `runtime.idle()`: a cell passes through states that exist only until the
 * scheduler drains, and a predicate can accept one that is about to be
 * superseded. The predicate may be async for exactly that.
 */
export const awaitReplica = (
  manager: NotifyingManager,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> => awaitEdges([replicaChanges(manager)], predicate);

/**
 * The highest AUTHORED seq in the space — the only seq class a settle barrier
 * may target (protocol.md §4: settled for a client = W ≥ seq of its own
 * AUTHORED commit). The class filter is what the barrier rests on: the serving
 * loop's own derived wave echoes ride the same counter, and W never claims a
 * trailing echo on a quiet space, since the advance is input-driven and
 * `#drainFeed` skips self-echoes. A target taken from `Engine.serverSeq`
 * therefore names a seq W never reaches.
 */
export const highestAuthoredSeq = (engine: Engine.Engine): number =>
  (engine.database.prepare(
    `SELECT MAX(seq) AS seq FROM "commit" WHERE class = 'authored'`,
  ).get() as { seq: number | null }).seq ?? 0;

/**
 * {@link waitForSettled} under the stuck-condition net: resolves with the
 * watermark once it covers `seq`, and fails the run if it never does — a
 * space whose serving never resumes leaves the watermark where it is.
 */
export const awaitSettled = (
  runtime: Runtime,
  space: MemorySpace,
  seq: number,
): Promise<number> =>
  withStuckNet(
    waitForSettled(runtime, space, seq),
    `the watermark to cover seq ${seq}`,
  );

/**
 * The settle barrier: flush `runtime`'s own pending work, then wait until the
 * space's watermark covers every authored commit in it. W ≥ seq is the settled
 * contract as a client applies it (protocol.md §4), and it orders this point
 * after the wave an authored commit was drained into: a consequence that never
 * arrived is then an absence to assert on, and one that arrives late has no
 * window left to hide in. `waitForSettled` sleeps on the watermark doc's own
 * subscription. Returns the seq it targeted.
 *
 * A barrier, not a delivery signal. A wave that REQUEUES the event it drained
 * still commits, and its advance still covers that event's seq, so a test whose
 * subject is the re-run's own output waits for that output on the replica and
 * uses this barrier only for what follows.
 */
export const settleServing = async (
  engine: Engine.Engine,
  runtime: Runtime,
  space: MemorySpace,
): Promise<number> => {
  await runtime.idle();
  await runtime.storageManager.synced();
  const target = highestAuthoredSeq(engine);
  await awaitSettled(runtime, space, target);
  return target;
};
