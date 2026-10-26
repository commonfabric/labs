/**
 * The main-thread side of the serving port (serving-loop-worker.md): serves
 * the worker's requests against the memory server it holds, forwards the
 * server's observer events, owns one server connection per loopback transport
 * the worker opens, applies the worker's wave commits through a sink of its
 * own per session, and keeps the latest counters the worker posted for the
 * health route.
 */

import type { FabricValue } from "@commonfabric/data-model";
import {
  acquireServerExecutionEnabler,
  decodeTrustedMemoryBoundary,
  encodeMemoryBoundary,
} from "@commonfabric/memory/v2";
import type { Engine } from "@commonfabric/memory/v2/engine";
import { releaseExecutionLease } from "@commonfabric/memory/v2/execution-lease";
import type { ServedAclChange, Server } from "@commonfabric/memory/v2/server";
import { getLogger } from "@commonfabric/utils/logger";
import { applyAccessListChanges, validateStoredAcl } from "../acl-manager.ts";
import type { MemorySpace } from "../storage/interface.ts";
import { EngineWaveCommitSink } from "./engine-wave-sink.ts";
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
  type ServedAclChangeData,
  type ServingLoopDiagnostics,
  type ServingWorkerInit,
} from "./serving-port-protocol.ts";
import {
  emptyServingLoopStats,
  registerServingLoopStatsProvider,
  type ServingLoopStats,
} from "./stats.ts";
import type { WaveSpaceCommit } from "./wave.ts";

const logger = getLogger("serving-port-bridge", {
  enabled: true,
  level: "warn",
});

/** The served access-list change `data` stands for, its function rebuilt. */
const servedAclChangeOf = (data: ServedAclChangeData): ServedAclChange => ({
  ...data,
  change: (stored) =>
    applyAccessListChanges(
      data.space as MemorySpace,
      validateStoredAcl(stored),
      data.changes,
    ),
});

/** The sink the bridge keeps for one worker-side session. */
type BridgeSink = {
  sink: EngineWaveCommitSink;
  localSeq: { value: number };
  engines: Map<string, Engine>;
  /** Set by the sink's refusal hook during a home batch's commit. */
  state: { homeRefused: boolean };
};

/**
 * What a bridge serves: the memory server, the port its worker answers on, and
 * the observers of what the worker's host reports.
 */
export type ServingPortBridgeOptions = {
  server: Server;
  port: PortLike;

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

  /** Called each time a wave commit the worker sent lands in the store. */
  onWaveCommitted?: () => void;
};

/**
 * The server's end of the port. Constructing one installs the process's
 * serving-loop stats provider and claims the process's ambient
 * server-execution flag, which the memory server's admission of derived
 * commits reads and which the host, in its own realm, cannot claim for this
 * one; `attach()`, which `init()` calls once the worker's host serves,
 * installs the server's execution observer. One bridge serves per process, as
 * one in-process host does.
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
  /** Every space the worker opened an engine for. */
  readonly #openedSpaces = new Set<string>();

  readonly #workerReady = Promise.withResolvers<void>();
  readonly #releaseServerExecution: () => void;
  #stats: ServingLoopStats | undefined;
  #attached = false;
  #closed = false;

  constructor(options: ServingPortBridgeOptions) {
    this.#options = options;
    this.#endpoint = new PortEndpoint(options.port, (error) => {
      logger.warn("port-fault", () => ["the serving port faulted", error]);
    });
    this.#installHandlers();
    this.#releaseServerExecution = acquireServerExecutionEnabler();
    registerServingLoopStatsProvider(() =>
      this.#stats ?? emptyServingLoopStats()
    );
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
    const answer = await this.#endpoint.request("worker.init", init);
    this.attach();
    return answer;
  }

  /**
   * Installs the server's execution observer, forwarding its events to the
   * worker from here on. The worker's host has to be serving, with its own
   * observer installed on its plane, or the events have nowhere to go: a
   * notice posted before the worker listens is dropped, and one that arrives
   * before the host exists finds no observer.
   *
   * Installing the observer replays the server's sessions, which brings the
   * worker's session mirror up to date; the sessions that opened before this
   * then get the activation trigger their opens would have been, once per
   * space, since the host gates each on the sessions the mirror holds.
   */
  attach(): void {
    if (this.#attached || this.#closed) return;
    this.#attached = true;
    const replayed = new Set<string>();
    let replaying = true;
    this.#options.server.setServerExecutionObserver({
      commitAdmitted: (notice) =>
        this.#endpoint.notify("observer.commitAdmitted", { notice }),
      sessionOpened: (space) =>
        this.#endpoint.notify("observer.sessionOpened", { space }),
      demandChanged: (space, reason, principal, sessionId) =>
        this.#endpoint.notify("observer.demandChanged", {
          space,
          reason,
          principal,
          sessionId,
        }),
      viewsChanged: (space, sessionId) =>
        this.#endpoint.notify("observer.viewsChanged", { space, sessionId }),
      sessionChanged: (event) => {
        if (replaying && event.kind === "opened") replayed.add(event.space);
        this.#endpoint.notify("observer.sessionChanged", { event });
      },
    });
    replaying = false;
    for (const space of replayed) {
      this.#endpoint.notify("observer.sessionOpened", { space });
    }
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
   * Detaches from the server and the port, closing every loopback connection
   * the worker still holds. The worker's host is not closed by this; a caller
   * that wants it closed asks first through `closeHost()`.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#options.server.setServerExecutionObserver(undefined);
    registerServingLoopStatsProvider(undefined);
    for (const connection of this.#connections.values()) connection.close();
    this.#connections.clear();
    const closed = new Error("the serving port bridge closed");
    this.#workerReady.reject(closed);
    this.#workerReady.promise.catch(() => {});
    this.#endpoint.close(closed);
    this.#releaseServerExecution();
  }

  /**
   * Releases the lease rows `holder` holds in every space the worker opened:
   * what the worker's successor needs when the worker died holding them,
   * since the host leaves a space parked on another holder's live lease
   * rather than contending for it. A row held by anyone else is left alone,
   * and a space whose rows cannot be released is reported and leaves the
   * others to be released.
   */
  async releaseLeasesOf(holder: string): Promise<void> {
    const { server } = this.#options;
    for (const space of this.#openedSpaces) {
      try {
        releaseExecutionLease(await server.engineForSpace(space), {
          space,
          holder,
        });
      } catch (error) {
        logger.warn("lease-release-failed", () => [
          `releasing ${holder}'s lease rows in ${space} failed`,
          error,
        ]);
      }
    }
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
    const state = { homeRefused: false };
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
      onHomeRefused: () => {
        state.homeRefused = true;
      },
      // Reported here, with the apply: the fan-out of the rows is under way
      // before the loop, on its own thread, acts on the commit.
      reportCommit: (notice) => server.noteExecutorCommit(notice),
      commitServedAclChange: (change, envelope) =>
        server.commitServedAclChange({ ...change, ...envelope }),
    });
    entry = { sink, localSeq, engines, state };
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
      this.#openedSpaces.add(space);
      return { url: engine.url.href };
    });
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
        // The sink mints its number and reports a refused home batch before
        // its call returns, so both are set and read around the call with no
        // await between: another space's commit under the same session may
        // be in flight.
        entry.localSeq.value = localSeq - 1;
        entry.state.homeRefused = false;
        const pending = entry.sink.commitWave(batch);
        const homeRefused = entry.state.homeRefused;
        const result = await pending;
        if (result.error === undefined) this.#options.onWaveCommitted?.();
        return { result, homeRefused };
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
      const connection = server.connect((message) => {
        endpoint.notify("loopback.frame", {
          transport,
          frame: encodeMemoryBoundary(message as unknown as FabricValue),
        });
      });
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
    endpoint.onNotice("server.noteLeaseReacquired", ({ notice }) => {
      server.noteLeaseReacquired(notice);
    });
    endpoint.onNotice("worker.ready", () => {
      this.#workerReady.resolve();
    });
    endpoint.onNotice("host.stats", ({ stats }) => {
      this.#stats = stats;
    });
    endpoint.onNotice("host.activationSettled", ({ space, outcome }) => {
      this.#options.onActivationSettled?.(space, outcome);
    });
    endpoint.onNotice("host.spaceParked", ({ space, reason }) => {
      this.#options.onSpaceParked?.(space, reason);
    });
  }
}
