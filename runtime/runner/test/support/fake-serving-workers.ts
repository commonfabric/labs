/**
 * Stand-ins for the two things a `ServingWorkerPool` sits between, so that a
 * test decides what each one does and when: a `Worker` whose side of the
 * serving port the test plays through a real `PortEndpoint`, and a memory
 * server whose sessions and admitted commits the test makes up. Neither runs
 * a host, a runtime or a store, so they show what the pool sends, where, and
 * what it does with the answers.
 */

import type { Engine } from "@commonfabric/memory/v2/engine";
import { ExecutionLeases } from "@commonfabric/memory/v2/execution-lease";
import type {
  AdmittedCommitNotice,
  Server,
  ServerExecutionObserver,
  SessionLifecycleEvent,
} from "@commonfabric/memory/v2/server";
import type { HostOccupancy } from "../../src/executor/host.ts";
import {
  type BridgeNotices,
  type BridgeRequests,
  type PlaneNotices,
  type PlaneRequests,
  PortEndpoint,
  type PortLike,
  type ServingLoopDiagnostics,
  type ServingWorkerInit,
} from "../../src/executor/serving-port-protocol.ts";
import {
  emptyServingLoopStats,
  type ServingLoopStats,
} from "../../src/executor/stats.ts";

/** A notice the pool sent a stand-in worker, as its host would receive it. */
export type ReceivedNotice = {
  [Method in keyof BridgeNotices]: {
    method: Method;
    params: BridgeNotices[Method];
  };
}[keyof BridgeNotices];

/** What the realm of a stand-in's host logged: nothing. */
const NO_DIAGNOSTICS: ServingLoopDiagnostics = {
  loggerCounts: { total: 0 } as ServingLoopDiagnostics["loggerCounts"],
  timingStats: {},
};

/** The notices a worker's host receives, which a stand-in records. */
const RECORDED_NOTICES = [
  "observer.commitAdmitted",
  "observer.sessionOpened",
  "observer.demandChanged",
  "observer.viewsChanged",
  "observer.sessionChanged",
  "observer.spaceAclChanged",
  "loopback.frame",
] as const satisfies readonly (keyof BridgeNotices)[];

/**
 * A `Worker` stand-in. The pool holds it as it would a worker; the test plays
 * the worker's host through `host`, the worker's end of the port, and reads
 * what the pool sent from `received`. Messages cross on a microtask each, in
 * the order they were posted.
 */
export class FakeServingWorker implements PortLike {
  readonly #received: ReceivedNotice[] = [];
  readonly #host: PortEndpoint<
    PlaneRequests,
    PlaneNotices,
    BridgeRequests,
    BridgeNotices
  >;
  readonly #toPool = new Set<(event: MessageEvent) => void>();
  readonly #toHost = new Set<(event: MessageEvent) => void>();
  #onerror: ((event: ErrorEvent) => void) | null = null;
  #init: ServingWorkerInit | undefined;
  #terminated = false;
  #occupancy: HostOccupancy = "vacant";
  #finalStats: ServingLoopStats = emptyServingLoopStats();
  #diagnostics: ServingLoopDiagnostics = NO_DIAGNOSTICS;
  #hostCloses = 0;

  /** Constructs an instance whose host answers nothing until told to. */
  constructor() {
    this.#host = new PortEndpoint({
      postMessage: (message) => this.#deliver(this.#toPool, message),
      addEventListener: (_type, listener) => this.#toHost.add(listener),
      removeEventListener: (_type, listener) => this.#toHost.delete(listener),
    }, (error) => {
      throw error;
    });
    for (const method of RECORDED_NOTICES) {
      this.#host.onNotice(method, (params) => {
        this.#received.push({ method, params } as ReceivedNotice);
      });
    }
    this.#host.onRequest("host.close", () => {
      this.#hostCloses += 1;
    });
    this.#host.onRequest("host.stats", () => this.#finalStats);
    this.#host.onRequest("host.diagnostics", () => this.#diagnostics);
    this.#host.onRequest("host.retire", ({ evenIfParked }) => {
      if (
        this.#occupancy === "busy" ||
        (this.#occupancy === "parked" && !evenIfParked)
      ) {
        return null;
      }
      return { stats: this.#finalStats, diagnostics: this.#diagnostics };
    });
  }

  /** The pool's error handler, as it installs it on a worker. */
  get onerror(): ((event: ErrorEvent) => void) | null {
    return this.#onerror;
  }

  set onerror(handler: ((event: ErrorEvent) => void) | null) {
    this.#onerror = handler;
  }

  /** Whether the pool has terminated this worker. */
  get terminated(): boolean {
    return this.#terminated;
  }

  /**
   * The process-instance component the pool started this worker's host
   * with, which its lease holder is minted from. Throws before the host has
   * taken its `worker.init`.
   */
  get processInstanceId(): string {
    if (this.#init === undefined) {
      throw new Error("the stand-in worker's host has not been started");
    }
    return this.#init.processInstanceId;
  }

  /** The notices the pool has sent, in order. */
  get received(): readonly ReceivedNotice[] {
    return this.#received;
  }

  /** The worker's end of the port, for what the stand-in does not play. */
  get host(): PortEndpoint<
    PlaneRequests,
    PlaneNotices,
    BridgeRequests,
    BridgeNotices
  > {
    return this.#host;
  }

  /** The counters the host reports, and hands back as its last on retiring. */
  get finalStats(): ServingLoopStats {
    return this.#finalStats;
  }

  set finalStats(stats: ServingLoopStats) {
    this.#finalStats = stats;
  }

  /**
   * What the host's realm logged, which it reports on request and hands
   * back as its last on retiring.
   */
  get diagnostics(): ServingLoopDiagnostics {
    return this.#diagnostics;
  }

  set diagnostics(diagnostics: ServingLoopDiagnostics) {
    this.#diagnostics = diagnostics;
  }

  /** How many times the pool asked the host to close outright. */
  get hostCloses(): number {
    return this.#hostCloses;
  }

  /** @inheritDoc */
  postMessage(message: unknown): void {
    if (!this.#terminated) this.#deliver(this.#toHost, message);
  }

  /** @inheritDoc */
  addEventListener(
    _type: "message",
    listener: (event: MessageEvent) => void,
  ): void {
    this.#toPool.add(listener);
  }

  /** @inheritDoc */
  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent) => void,
  ): void {
    this.#toPool.delete(listener);
  }

  /** Terminates the worker, as the pool does when it is done with it. */
  terminate(): void {
    this.#terminated = true;
  }

  /**
   * Plays a host that starts: its entry reports ready and its host answers
   * the pool's `worker.init`, which is when the pool counts it as serving.
   */
  serve(): void {
    this.#host.onRequest("worker.init", (init) => {
      this.#init = init;
      return { lifetimeLock: undefined };
    });
    this.#host.notify("worker.ready", null);
  }

  /** Plays a host whose `worker.init` never settles. */
  hang(): void {
    this.#host.onRequest("worker.init", () => new Promise<never>(() => {}));
    this.#host.notify("worker.ready", null);
  }

  /** Plays a host that cannot start. */
  refuse(message: string): void {
    this.#host.onRequest("worker.init", () => {
      throw new Error(message);
    });
    this.#host.notify("worker.ready", null);
  }

  /** Fails the worker as an error it did not handle does. */
  fail(): void {
    this.#onerror!(
      new ErrorEvent("error", { message: "worker failed", cancelable: true }),
    );
  }

  /**
   * Has the host say what it holds, as it does when that changes; a later
   * `host.retire` is answered by it.
   */
  report(occupancy: HostOccupancy): void {
    this.#occupancy = occupancy;
    this.#host.notify("host.occupancy", { occupancy });
  }

  /** Posts a heartbeat carrying `heapUsed`, as the worker's timer does. */
  beat(heapUsed: number): void {
    this.#host.notify("worker.heartbeat", { heapUsed });
  }

  /** The notices of one method the pool has sent, in order. */
  receivedOf<Method extends keyof BridgeNotices>(
    method: Method,
  ): BridgeNotices[Method][] {
    return this.#received.flatMap((notice) =>
      notice.method === method ? [notice.params as BridgeNotices[Method]] : []
    );
  }

  /** Hands `data` to `listeners` on a microtask, as a port's turn. */
  #deliver(
    listeners: ReadonlySet<(event: MessageEvent) => void>,
    data: unknown,
  ): void {
    queueMicrotask(() => {
      for (const listener of [...listeners]) {
        listener(new MessageEvent("message", { data }));
      }
    });
  }
}

/**
 * Installs {@link FakeServingWorker} as the global `Worker` until the result
 * is disposed. Each stand-in is handed to `start` as it is spawned, which by
 * default has it serve; `next()` settles with the next one spawned.
 */
export function fakeServingWorkers(
  start: (worker: FakeServingWorker) => void = (worker) => worker.serve(),
): Disposable & {
  workers: FakeServingWorker[];
  next(): Promise<FakeServingWorker>;
} {
  const original = globalThis.Worker;
  const workers: FakeServingWorker[] = [];
  let waiting: ((worker: FakeServingWorker) => void) | undefined;
  globalThis.Worker = class extends FakeServingWorker {
    constructor() {
      super();
      workers.push(this);
      start(this);
      const settle = waiting;
      waiting = undefined;
      settle?.(this);
    }
  } as unknown as typeof Worker;
  return {
    workers,
    next: () =>
      new Promise((resolve) => {
        waiting = resolve;
      }),
    [Symbol.dispose]: () => {
      globalThis.Worker = original;
    },
  };
}

/** A session a {@link FakeMemoryServer} holds. */
type FakeSession = { sessionId: string; principal: string };

/**
 * A memory server stand-in holding what a `ServingWorkerPool` reaches: the
 * execution observer, the sessions the pool gates placements on, and the
 * lease map. A test opens and closes sessions and admits commits through it,
 * each of which calls the observer as the server would.
 */
export class FakeMemoryServer {
  readonly #executionLeases = new ExecutionLeases();
  readonly #sessions = new Map<string, FakeSession[]>();
  #observer: ServerExecutionObserver | undefined;
  #openEngine: ((space: string) => Promise<Engine>) | undefined;

  /** The lease map, which the pool releases a gone worker's leases from. */
  get executionLeases(): ExecutionLeases {
    return this.#executionLeases;
  }

  /** What opens a space's engine, where a test commits through the pool. */
  get openEngine(): ((space: string) => Promise<Engine>) | undefined {
    return this.#openEngine;
  }

  set openEngine(open: ((space: string) => Promise<Engine>) | undefined) {
    this.#openEngine = open;
  }

  /** The server as the pool's options take it. */
  get asServer(): Server {
    return this as unknown as Server;
  }

  /** Whether a pool's observer is installed. */
  get observed(): boolean {
    return this.#observer !== undefined;
  }

  /** As `Server.setServerExecutionObserver()`, replaying the sessions held. */
  setServerExecutionObserver(
    observer: ServerExecutionObserver | undefined,
  ): void {
    this.#observer = observer;
    if (observer?.sessionChanged === undefined) return;
    for (const space of this.#sessions.keys()) {
      for (const event of this.sessionSnapshot(space)) {
        observer.sessionChanged(event);
      }
    }
  }

  /** As `Server.hasLiveSessionsForSpace()`. */
  hasLiveSessionsForSpace(
    space: string,
    options: { excludePrincipal?: string } = {},
  ): boolean {
    return (this.#sessions.get(space) ?? []).some((session) =>
      session.principal !== options.excludePrincipal
    );
  }

  /** As `Server.sessionSnapshot()`. */
  sessionSnapshot(space: string): SessionLifecycleEvent[] {
    return (this.#sessions.get(space) ?? []).map((session) => ({
      kind: "opened",
      space,
      ...session,
    }));
  }

  /**
   * As `Server.engineForSpace()`: the engine `openEngine` returns, for a
   * test that commits through the pool, or a refusal.
   */
  engineForSpace(space: string): Promise<Engine> {
    return this.#openEngine?.(space) ??
      Promise.reject(new Error("the stand-in server holds no store"));
  }

  /** As `Server.noteExecutorCommit()`; a stand-in fans nothing out. */
  noteExecutorCommit(): void {}

  /** Opens a session on `space`, as a client's `session.open` does. */
  openSession(space: string, sessionId: string, principal = "did:key:client") {
    const sessions = this.#sessions.get(space) ?? [];
    this.#sessions.set(space, [...sessions, { sessionId, principal }]);
    this.#observer?.sessionChanged?.({
      kind: "opened",
      space,
      sessionId,
      principal,
    });
    this.#observer?.sessionOpened?.(space);
  }

  /** Removes a session from `space`, as its expiry does. */
  closeSession(space: string, sessionId: string): void {
    this.#sessions.set(
      space,
      (this.#sessions.get(space) ?? []).filter((session) =>
        session.sessionId !== sessionId
      ),
    );
    this.#observer?.sessionChanged?.({ kind: "removed", space, sessionId });
  }

  /** Reports `notice` as a commit the server admitted. */
  admit(notice: AdmittedCommitNotice): void {
    this.#observer?.commitAdmitted?.(notice);
  }
}

/** An admitted-commit notice for `space`, authored unless `over` says. */
export function admittedNotice(
  space: string,
  over: Partial<AdmittedCommitNotice> = {},
): AdmittedCommitNotice {
  return {
    space,
    seq: 1,
    class: "authored",
    sessionId: "session",
    writes: [],
    ...over,
  };
}
