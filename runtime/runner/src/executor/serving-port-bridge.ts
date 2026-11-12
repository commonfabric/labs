/**
 * The main-thread side of one serving port (serving-loop-worker.md): serves
 * the worker's requests against the memory server it holds, carries to the
 * worker the server's observer events its owner routes there, owns one
 * server connection per loopback transport the worker opens, applies the
 * worker's wave commits through a sink of its own per session, and keeps the
 * latest counters the worker posted.
 */

import type { FabricValue } from "@commonfabric/data-model";
import {
  acquireServerExecutionEnabler,
  decodeTrustedMemoryBoundary,
  encodeMemoryBoundary,
} from "@commonfabric/memory/v2";
import type { Engine } from "@commonfabric/memory/v2/engine";
import type {
  Server,
  ServerExecutionObserver,
} from "@commonfabric/memory/v2/server";
import { getLogger } from "@commonfabric/logger";
import type { CollectedMemory } from "../collected-memory.ts";
import type { MemorySpace } from "../storage/interface.ts";
import { EngineWaveCommitSink } from "./engine-wave-sink.ts";
import type { HostOccupancy } from "./host.ts";
import type { LoopbackConnection } from "./host-memory-server.ts";
import {
  type BridgeNotices,
  type BridgeRequests,
  type DelegatedAppendEntry,
  type LifecycleVerbDescriptor,
  type LifecycleVerbRun,
  type PlaneNotices,
  type PlaneRequests,
  PortEndpoint,
  type PortLike,
  type ServingLoopDiagnostics,
  type ServingWorkerInit,
} from "./serving-port-protocol.ts";
import { servedAclChangeOf } from "./served-acl-change.ts";
import { emptyServingLoopStats, type ServingLoopStats } from "./stats.ts";
import type { WaveSpaceCommit } from "./wave.ts";

const logger = getLogger("serving-port-bridge", {
  enabled: true,
  level: "warn",
});

/** The sink the bridge keeps for one worker-side session. */
type BridgeSink = {
  sink: EngineWaveCommitSink;
  localSeq: { value: number };
  engines: Map<string, Engine>;
};

/**
 * What a bridge serves: the memory server, the port its worker answers on, and
 * the observers of what the worker's host reports.
 */
export type ServingPortBridgeOptions = {
  server: Server;
  port: PortLike;

  /**
   * The process-instance component of the lease holder the worker's host
   * acquires under, which the worker's loopback connections name to the
   * server (`ServerConnectOptions.leaseHolderInstance`). Absent, the
   * component this realm mints holders with.
   */
  leaseHolderInstance?: string;

  /**
   * DIAGNOSTIC (tests): the worker's activation outcomes, as its host reports
   * them.
   */
  onActivationSettled?: (
    space: MemorySpace,
    outcome: "active" | "refused" | "failed",
  ) => void;

  /** DIAGNOSTIC (tests): the worker's parks, as its host reports them. */
  onSpaceParked?: (space: MemorySpace, reason: string) => void;

  /**
   * Called each time a wave commit the worker sent lands in the store, with
   * the space it landed in.
   */
  onWaveCommitted?: (space: MemorySpace) => void;

  /** Called with what the worker's host holds, each time the host says. */
  onOccupancy?: (occupancy: HostOccupancy) => void;

  /** Called with the worker's heap size, in bytes, at each heartbeat. */
  onHeartbeat?: (heapUsed: number) => void;
};

/** The observer events a bridge carries to its worker. */
export type ForwardedObserver = Required<ServerExecutionObserver>;

/**
 * The server's end of one worker's port. Constructing one claims the
 * process's ambient server-execution flag, which the memory server's
 * admission of derived commits reads and which the host, in its own realm,
 * cannot claim for this one. The server takes one execution observer, so a
 * bridge installs none: whoever holds the bridges installs it and hands each
 * event to the bridge of the worker it concerns, through `observer`.
 */
export class ServingPortBridge {
  readonly #options: ServingPortBridgeOptions;
  readonly #endpoint: PortEndpoint<
    BridgeRequests,
    BridgeNotices,
    PlaneRequests,
    PlaneNotices
  >;
  readonly #connections = new Map<number, LoopbackConnection>();
  readonly #sinks = new Map<string, BridgeSink>();
  readonly #workerReady = Promise.withResolvers<void>();
  readonly #releaseServerExecution: () => void;
  readonly #observer: ForwardedObserver;
  #stats: ServingLoopStats | undefined;
  #closed = false;

  constructor(options: ServingPortBridgeOptions) {
    this.#options = options;
    this.#endpoint = new PortEndpoint(options.port, (error) => {
      logger.warn("port-fault", () => ["the serving port faulted", error]);
    });
    this.#installHandlers();
    this.#releaseServerExecution = acquireServerExecutionEnabler();
    const endpoint = this.#endpoint;
    this.#observer = {
      commitAdmitted: (notice) =>
        endpoint.notify("observer.commitAdmitted", { notice }),
      sessionOpened: (space) =>
        endpoint.notify("observer.sessionOpened", { space }),
      demandChanged: (space, reason, principal, sessionId) =>
        endpoint.notify("observer.demandChanged", {
          space,
          reason,
          principal,
          sessionId,
        }),
      viewsChanged: (space, sessionId) =>
        endpoint.notify("observer.viewsChanged", { space, sessionId }),
      sessionChanged: (event) =>
        endpoint.notify("observer.sessionChanged", { event }),
    };
  }

  /** How many messages of any kind have arrived from the worker. */
  get messagesReceived(): number {
    return this.#endpoint.messagesReceived;
  }

  /**
   * Carries the server's observer events to the worker. The worker's host
   * has to be serving, with its own observer installed on its plane, or an
   * event has nowhere to go: a notice posted before the worker listens is
   * dropped, and one that arrives before the host exists finds no observer.
   * So nothing is sent through here before `init()` has settled. The
   * worker's session mirror starts empty, and `sessionChanged` is what
   * brings it up to date and keeps it current.
   */
  get observer(): ForwardedObserver {
    return this.#observer;
  }

  /**
   * Hands the worker's entry what it builds its host from, and settles once
   * that host serves. Only a bridge over a worker started from
   * `serving-worker.ts` sends this.
   */
  async init(
    init: ServingWorkerInit,
  ): Promise<{ lifetimeLock: string | undefined }> {
    await this.#workerReady.promise;
    return await this.#endpoint.request("worker.init", init);
  }

  /**
   * Tells the worker's host that an admitted commit wrote `space`'s
   * access-list document, for a space whose commits this worker does not
   * hear of.
   */
  noteSpaceAclChanged(space: string): void {
    this.#endpoint.notify("observer.spaceAclChanged", { space });
  }

  /** The counters the worker last posted, or none before its first. */
  stats(): ServingLoopStats | undefined {
    return this.#stats;
  }

  /** The worker's counters as of now. */
  async requestStats(): Promise<ServingLoopStats> {
    const stats = await this.#endpoint.request("host.stats", null);
    this.#stats = stats;
    return stats;
  }

  /** What the worker's realm logged, as of now. */
  requestDiagnostics(): Promise<ServingLoopDiagnostics> {
    return this.#endpoint.request("host.diagnostics", null);
  }

  /** The memory the worker's isolate holds after a full collection. */
  requestCollectedMemory(): Promise<CollectedMemory> {
    return this.#endpoint.request("host.collectedMemory", null);
  }

  /**
   * Runs a lifecycle verb on the worker's host; its receipt and the steps the
   * worker timed come back as data.
   */
  runLifecycleVerb(
    space: MemorySpace,
    verb: LifecycleVerbDescriptor,
  ): Promise<LifecycleVerbRun> {
    return this.#endpoint.request("host.runLifecycleVerb", { space, verb });
  }

  /** Asks the worker's host to close, and settles once it has. */
  closeHost(): Promise<void> {
    return this.#endpoint.request("host.close", null);
  }

  /**
   * Asks the worker's host to close if it holds nothing, or with
   * `evenIfParked` nothing but runtimes kept from idle parks, as of every
   * message sent before this call. Settles with whether it closed; the
   * counters of a host that did are its last.
   */
  async retireHost(
    { evenIfParked }: { evenIfParked: boolean },
  ): Promise<ServingLoopDiagnostics | undefined> {
    const retired = await this.#endpoint.request("host.retire", {
      evenIfParked,
    });
    if (retired === null) return undefined;
    this.#stats = retired.stats;
    return retired.diagnostics;
  }

  /**
   * Detaches from the server and the port, closing every loopback connection
   * the worker still holds. The worker's host is not closed by this; a caller
   * that wants it closed asks first through `closeHost()`.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const connection of this.#connections.values()) connection.close();
    this.#connections.clear();
    const closed = new Error("the serving port bridge closed");
    this.#workerReady.reject(closed);
    this.#workerReady.promise.catch(() => {});
    this.#endpoint.close(closed);
    this.#releaseServerExecution();
  }

  /**
   * Releases every lease `holder` holds, and returns how many there were: what
   * the worker's successor needs when the worker died holding them, since the
   * host leaves a space parked on another holder's lease rather than contending
   * for it. A commit the worker left in flight is refused from here on, since
   * it names a holder the memory server no longer knows.
   */
  releaseLeasesOf(holder: string): number {
    return this.#options.server.executionLeases.releaseAllOf(holder);
  }

  /** The sink for `sessionId`, built on first use. */
  #sinkFor(sessionId: string): BridgeSink {
    let entry = this.#sinks.get(sessionId);
    if (entry !== undefined) return entry;
    const { server } = this.#options;
    const engines = new Map<string, Engine>();
    const engineFor = (space: MemorySpace): Engine => {
      const engine = engines.get(space);
      if (engine === undefined) {
        throw new Error(`no engine resolved for ${space} ahead of its commit`);
      }
      return engine;
    };
    const localSeq = { value: 0 };
    const sink = new EngineWaveCommitSink({
      engineFor,
      sessionId,
      localSeqRef: localSeq,
      sqliteAttachmentsFor: (space, operations, scopeKeyByOpIndex) =>
        server.attachWaveCommitSqliteDbs(
          engineFor(space),
          space,
          operations,
          scopeKeyByOpIndex,
        ),
      // Reported here, with the apply: the fan-out of the rows is under way
      // before the loop, on its own thread, acts on the commit.
      reportCommit: (notice) => server.noteExecutorCommit(notice),
      commitServedAclChange: (change, envelope) =>
        server.commitServedAclChange({ ...change, ...envelope }),
    });
    entry = { sink, localSeq, engines };
    this.#sinks.set(sessionId, entry);
    return entry;
  }

  #installHandlers(): void {
    const { server } = this.#options;
    const endpoint = this.#endpoint;
    endpoint.onRequest("space.open", async ({ space }) => {
      const engine = await server.engineForSpace(space);
      if (engine.url.protocol !== "file:") {
        throw new Error(
          `the store of ${space} is at ${engine.url.href}, which another ` +
            "thread cannot open; a serving worker needs a file store",
        );
      }
      return { url: engine.url.href };
    });
    endpoint.onRequest(
      "server.acquireExecutionLease",
      ({ space, holder }) => server.executionLeases.acquire(space, holder),
    );
    endpoint.onRequest(
      "server.releaseExecutionLease",
      ({ space, holder }) => server.executionLeases.release(space, holder),
    );
    endpoint.onRequest(
      "server.commitDeliveryFailureNotice",
      ({ notice }) => server.commitDeliveryFailureNotice(notice),
    );
    endpoint.onRequest("server.idle", () => server.idle());
    endpoint.onRequest(
      "server.flushSessions",
      ({ spaces }) => server.flushSessions(spaces),
    );
    endpoint.onRequest(
      "server.demandForSessions",
      ({ space, sessionIds, excludePrincipal }) =>
        server.demandForSessions(
          space,
          sessionIds,
          excludePrincipal === undefined ? {} : { excludePrincipal },
        ),
    );
    endpoint.onRequest(
      "server.viewInterestsForSpace",
      ({ space, excludePrincipal }) => [
        ...server.viewInterestsForSpace(
          space,
          excludePrincipal === undefined ? {} : { excludePrincipal },
        ),
      ],
    );
    endpoint.onRequest(
      "server.setViewSelection",
      ({ space, handle, selection }) =>
        server.setViewSelection(space, handle, selection),
    );
    endpoint.onRequest(
      "server.foreignWriteAuthorityFor",
      ({ space, principal }) =>
        server.foreignWriteAuthorityFor(space, principal),
    );
    endpoint.onRequest(
      "server.foreignReadAuthorityFor",
      ({ space, principal }) =>
        server.foreignReadAuthorityFor(space, principal),
    );
    endpoint.onRequest(
      "server.checkServedAclChange",
      ({ change }) => server.checkServedAclChange(servedAclChangeOf(change)),
    );
    endpoint.onRequest(
      "server.commitServedAclChange",
      ({ change, sessionId, localSeq }) =>
        server.commitServedAclChange({
          ...servedAclChangeOf(change),
          sessionId,
          localSeq,
        }),
    );
    endpoint.onRequest(
      "server.commitDelegatedAppend",
      ({ entry }) =>
        server.commitDelegatedAppend(
          decodeTrustedMemoryBoundary(entry) as unknown as DelegatedAppendEntry,
        ),
    );
    endpoint.onRequest(
      "sink.commitWave",
      async ({ sessionId, localSeq, batch: encoded }) => {
        const batch = decodeTrustedMemoryBoundary(
          encoded,
        ) as unknown as WaveSpaceCommit;
        const entry = this.#sinkFor(sessionId);
        entry.engines.set(
          batch.space,
          await server.engineForSpace(batch.space),
        );
        // The sink mints its number before its call returns, so the counter
        // is set around the call with no await between: another space's commit
        // under the same session may be in flight.
        entry.localSeq.value = localSeq - 1;
        const result = await entry.sink.commitWave(batch);
        if (result.error === undefined) {
          this.#options.onWaveCommitted?.(batch.space);
        }
        return result;
      },
    );
    endpoint.onRequest(
      "sink.commitSpaceAccessChange",
      ({ sessionId, localSeq, change }) => {
        const entry = this.#sinkFor(sessionId);
        entry.localSeq.value = localSeq - 1;
        return entry.sink.commitSpaceAccessChange(servedAclChangeOf(change));
      },
    );
    endpoint.onRequest("loopback.open", ({ transport }) => {
      if (this.#closed) throw new Error("the serving port bridge is closed");
      // The worker's sessions are this process's own: the serving loop's
      // home sessions reach the server over the port.
      const connection = server.connect(
        (message) => {
          endpoint.notify("loopback.frame", {
            transport,
            frame: encodeMemoryBoundary(message as unknown as FabricValue),
          });
        },
        undefined,
        {
          inProcess: true,
          ...(this.#options.leaseHolderInstance === undefined ? {} : {
            leaseHolderInstance: this.#options.leaseHolderInstance,
          }),
        },
      );
      this.#connections.set(transport, connection);
    });
    endpoint.onRequest("loopback.send", ({ transport, payload }) => {
      const connection = this.#connections.get(transport);
      if (connection === undefined) {
        throw new Error(`loopback connection ${transport} is not open`);
      }
      return connection.receive(payload);
    });
    endpoint.onNotice("loopback.close", ({ transport }) => {
      const connection = this.#connections.get(transport);
      this.#connections.delete(transport);
      connection?.close();
    });
    endpoint.onNotice("server.noteExecutorCommit", ({ notice }) => {
      server.noteExecutorCommit(notice);
    });
    endpoint.onNotice("worker.ready", () => {
      this.#workerReady.resolve();
    });
    // The endpoint has already counted it, which is all the watchdog reads.
    endpoint.onNotice("worker.heartbeat", ({ heapUsed }) => {
      this.#options.onHeartbeat?.(heapUsed);
    });
    endpoint.onNotice("host.occupancy", ({ occupancy }) => {
      this.#options.onOccupancy?.(occupancy);
    });
    endpoint.onNotice("host.stats", ({ stats }) => {
      this.#stats = stats;
    });
    // The port delivers in order, so a full post is never older than a
    // counters post that arrived before it: the merged counters stand until
    // the next full post replaces them with everything else.
    endpoint.onNotice("host.counters", ({ counters }) => {
      this.#stats = {
        ...(this.#stats ?? emptyServingLoopStats()),
        ...counters,
      };
    });
    endpoint.onNotice("host.activationSettled", ({ space, outcome }) => {
      this.#options.onActivationSettled?.(space, outcome);
    });
    endpoint.onNotice("host.spaceParked", ({ space, reason }) => {
      this.#options.onSpaceParked?.(space, reason);
    });
  }
}
