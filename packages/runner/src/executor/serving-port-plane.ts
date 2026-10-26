/**
 * The worker side of the serving port (serving-loop-worker.md): the memory
 * server as the host in a worker reaches it. Reads of the store stay on the
 * worker's own engine connections, which this module opens at the file the
 * server's thread names; the three session lookups the loop makes
 * synchronously read a mirror the server's lifecycle events keep current;
 * everything else crosses the port as a request, a notice, or a loopback
 * frame. Wave commits cross to the sink the server's thread keeps, under the
 * counter this side owns.
 */

import type { CellScope } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import { encodeMemoryBoundary } from "@commonfabric/memory/v2";
import type {
  SessionReadCeiling,
  SessionViewInterest,
} from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  resolveSpaceOwnerOf,
  type ServedAclChange,
  type ServerExecutionObserver,
  type SessionLifecycleEvent,
} from "@commonfabric/memory/v2/server";
import { getLogger } from "@commonfabric/utils/logger";
import type { MemorySpace, Result } from "../storage/interface.ts";
import { DemandShareCache } from "./demand-shares.ts";
import {
  EngineWaveCommitSink,
  waveCommitFailureResult,
} from "./engine-wave-sink.ts";
import type { HostMemoryServer } from "./host-memory-server.ts";
import type { LoopbackPlane } from "./loopback-storage.ts";
import {
  type BridgeNotices,
  type BridgeRequests,
  type LifecycleVerbDescriptor,
  type LifecycleVerbRun,
  type PlaneNotices,
  type PlaneRequests,
  PortEndpoint,
  type PortLike,
  type ServedAclChangeData,
  type ServingLoopDiagnostics,
} from "./serving-port-protocol.ts";
import type { WaveCommitSinkDeps } from "./space-server.ts";
import type { ServingLoopStats } from "./stats.ts";
import { ViewInterestCache } from "./view-interests.ts";
import type {
  ListedServedAclChange,
  WaveCommitRejection,
  WaveCommitSink,
  WaveSpaceCommit,
} from "./wave.ts";

const logger = getLogger("serving-port-plane", {
  enabled: true,
  level: "warn",
});

/** The worker's end of the port, typed by what each side sends. */
export type ServingPlaneEndpoint = PortEndpoint<
  PlaneRequests,
  PlaneNotices,
  BridgeRequests,
  BridgeNotices
>;

/** Builds the worker's end of the port over `port`. */
export const servingPlaneEndpoint = (port: PortLike): ServingPlaneEndpoint =>
  new PortEndpoint(port, (error) => {
    logger.warn("port-fault", () => ["the serving port faulted", error]);
  });

/** What the worker's host answers the server's thread with. */
export type ServingPlaneHost = {
  stats: () => ServingLoopStats;
  diagnostics: () => ServingLoopDiagnostics;
  runLifecycleVerb: (
    space: MemorySpace,
    verb: LifecycleVerbDescriptor,
  ) => Promise<LifecycleVerbRun>;
  close: () => Promise<void>;
};

/**
 * A served access-list change as data: the list its function applies in place
 * of the function. The wave attaches the list to every change it builds; a
 * change without one cannot cross.
 */
const servedAclChangeData = (
  change: ServedAclChange,
): ServedAclChangeData => {
  const { change: _apply, ...data } = change as ListedServedAclChange;
  if (data.changes === undefined) {
    throw new Error(
      `the access-list change to ${change.space} carries no change list, ` +
        "so it cannot cross to the memory server's thread",
    );
  }
  return data;
};

/** A session as the mirror holds it. */
type MirroredSession = {
  principal: string | undefined;
  readCeiling: SessionReadCeiling | undefined;
  expiresAt: number | null;
};

/**
 * The server's sessions, kept current by its lifecycle events, answering
 * the questions the loop asks without waiting. A detached session counts as
 * live until the expiry the server gave it, as it does in the server's own
 * registry. `expired` hears of each session that lapses without an event,
 * and `emptied` of each space whose last session leaves.
 */
class SessionMirror {
  readonly #spaces = new Map<string, Map<string, MirroredSession>>();

  constructor(
    readonly expired: (space: string, sessionId: string) => void,
    readonly emptied: (space: string) => void,
  ) {}

  /** Applies one of the server's session lifecycle events to the mirror. */
  apply(event: SessionLifecycleEvent): void {
    let sessions = this.#spaces.get(event.space);
    if (sessions === undefined) {
      if (event.kind === "removed") return;
      sessions = new Map();
      this.#spaces.set(event.space, sessions);
    }
    switch (event.kind) {
      case "opened":
        sessions.set(event.sessionId, {
          principal: event.principal,
          readCeiling: event.readCeiling,
          expiresAt: null,
        });
        return;
      case "detached": {
        const session = sessions.get(event.sessionId);
        if (session !== undefined) session.expiresAt = event.expiresAt;
        return;
      }
      case "removed":
        sessions.delete(event.sessionId);
        if (sessions.size === 0) {
          this.#spaces.delete(event.space);
          this.emptied(event.space);
        }
        return;
    }
  }

  /** The space's sessions still live now, the lapsed ones dropped. */
  live(space: string): ReadonlyMap<string, MirroredSession> {
    const sessions = this.#spaces.get(space);
    if (sessions === undefined) return new Map();
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (session.expiresAt !== null && session.expiresAt <= now) {
        sessions.delete(sessionId);
        this.expired(space, sessionId);
      }
    }
    if (sessions.size === 0) {
      this.#spaces.delete(space);
      this.emptied(space);
    }
    return sessions;
  }
}

/**
 * One loopback connection's transport: a
 * {@link MemoryClient.queuedFrameTransport} whose client frames are requests
 * the server's thread answers once its connection took them, and whose server
 * frames arrive as notices. The frames reach the client the way they do over
 * the in-process loopback, one per turn, and a close drops the frames still
 * held.
 */
const planeTransport = (
  endpoint: ServingPlaneEndpoint,
  id: number,
  unregister: () => void,
): MemoryClient.QueuedFrameTransport =>
  MemoryClient.queuedFrameTransport({
    async receive(payload) {
      try {
        await endpoint.request("loopback.send", { transport: id, payload });
      } catch (error) {
        if (endpoint.closed) {
          throw MemoryClient.connectionError("the serving port closed", error);
        }
        throw error;
      }
    },
    close() {
      unregister();
      endpoint.notify("loopback.close", { transport: id });
    },
  });

/**
 * The members of a wave commit sink that read the store rather than commit,
 * each one required: the worker's sink makes every one of them on its own
 * engines, so a read the sink's contract gains is one it must forward.
 */
type WaveCommitSinkReads = Required<
  Omit<
    WaveCommitSink,
    "reportsCommits" | "commitWave" | "commitSpaceAccessChange"
  >
>;

/**
 * The tenure's wave commit sink on the worker: the reads run on the worker's
 * engines, and each commit crosses to the sink the server's thread keeps for
 * this session, carrying the number this side's counter minted for it.
 */
class PlaneWaveCommitSink implements WaveCommitSink, WaveCommitSinkReads {
  readonly #endpoint: ServingPlaneEndpoint;
  readonly #deps: WaveCommitSinkDeps;
  readonly #reads: EngineWaveCommitSink;

  constructor(endpoint: ServingPlaneEndpoint, deps: WaveCommitSinkDeps) {
    this.#endpoint = endpoint;
    this.#deps = deps;
    // Its counter never advances: only the reads are called on it.
    this.#reads = new EngineWaveCommitSink({
      engineFor: (space) =>
        space === deps.space ? deps.engine : deps.foreignEngineFor(space),
      sessionId: deps.sessionId,
    });
  }

  /** The sink on the server's thread reports each commit as it applies it. */
  get reportsCommits(): boolean {
    return true;
  }

  /** @inheritDoc */
  currentHeads(
    space: MemorySpace,
    docs: ReadonlyArray<{ id: string; scope?: CellScope; scopeKey: string }>,
  ): Promise<ReadonlyMap<string, number>> {
    return this.#reads.currentHeads(space, docs);
  }

  /** @inheritDoc */
  concurrentWritePaths(
    space: MemorySpace,
    doc: { id: string; scope?: CellScope; scopeKey: string },
    sinceSeq: number,
  ): Promise<ReadonlyArray<readonly string[]>> {
    return this.#reads.concurrentWritePaths(space, doc, sinceSeq);
  }

  /** @inheritDoc */
  intrusionSince(
    space: MemorySpace,
    doc: { id: string; scope?: CellScope; scopeKey: string },
    sinceSeq: number,
    holder: string | undefined,
  ): Promise<boolean> {
    return this.#reads.intrusionSince(space, doc, sinceSeq, holder);
  }

  /** @inheritDoc */
  sessionOverwritePathsSince(
    space: MemorySpace,
    doc: { id: string; scope?: CellScope; scopeKey: string },
    sinceSeq: number,
    session: { principal: string; sessionId: string },
  ): Promise<ReadonlyArray<readonly string[]>> {
    return this.#reads.sessionOverwritePathsSince(
      space,
      doc,
      sinceSeq,
      session,
    );
  }

  /** @inheritDoc */
  async commitWave(
    batch: WaveSpaceCommit,
  ): Promise<Result<{ seq: number }, WaveCommitRejection>> {
    const localSeq = ++this.#deps.localSeqRef.value;
    try {
      const { result, homeRefused } = await this.#endpoint.request(
        "sink.commitWave",
        {
          sessionId: this.#deps.sessionId,
          localSeq,
          batch: encodeMemoryBoundary(batch as unknown as FabricValue),
        },
      );
      if (homeRefused) this.#deps.onHomeRefused();
      return result;
    } catch (error) {
      if (batch.home) this.#deps.onHomeRefused();
      return waveCommitFailureResult(error);
    }
  }

  /** @inheritDoc */
  async commitSpaceAccessChange(
    change: ServedAclChange,
  ): Promise<Result<{ seq?: number }, WaveCommitRejection>> {
    const localSeq = ++this.#deps.localSeqRef.value;
    try {
      return await this.#endpoint.request("sink.commitSpaceAccessChange", {
        sessionId: this.#deps.sessionId,
        localSeq,
        change: servedAclChangeData(change),
      });
    } catch (error) {
      return waveCommitFailureResult(error);
    }
  }
}

/**
 * The memory server as the worker's host sees it. Every member is one of
 * the placements this module's header describes.
 */
class PlaneMemoryServer implements HostMemoryServer {
  readonly #plane: ServingPlane;
  readonly #endpoint: ServingPlaneEndpoint;
  readonly #sessions: SessionMirror;
  readonly #demandShares: DemandShareCache;
  readonly #viewInterests: ViewInterestCache;

  constructor(
    plane: ServingPlane,
    endpoint: ServingPlaneEndpoint,
    sessions: SessionMirror,
    demandShares: DemandShareCache,
    viewInterests: ViewInterestCache,
  ) {
    this.#plane = plane;
    this.#endpoint = endpoint;
    this.#sessions = sessions;
    this.#demandShares = demandShares;
    this.#viewInterests = viewInterests;
  }

  /** @inheritDoc */
  setServerExecutionObserver(
    observer: ServerExecutionObserver | undefined,
  ): void {
    this.#plane.observer = observer;
  }

  /** @inheritDoc */
  hasLiveSessionsForSpace(
    space: string,
    options: { excludePrincipal?: string } = {},
  ): boolean {
    for (const session of this.#sessions.live(space).values()) {
      if (
        options.excludePrincipal === undefined ||
        session.principal !== options.excludePrincipal
      ) {
        return true;
      }
    }
    return false;
  }

  /** @inheritDoc */
  hasLiveSessionFor(
    space: string,
    principal: string,
    sessionId: string,
  ): boolean {
    const session = this.#sessions.live(space).get(sessionId);
    return session !== undefined && session.principal === principal;
  }

  /** @inheritDoc */
  sessionReadCeiling(
    space: string,
    sessionId: string,
  ): SessionReadCeiling | undefined {
    return this.#sessions.live(space).get(sessionId)?.readCeiling;
  }

  /** @inheritDoc */
  idle(): Promise<void> {
    return this.#endpoint.request("server.idle", null);
  }

  /** @inheritDoc */
  flushSessions(spaces?: Iterable<string>): Promise<void> {
    return this.#endpoint.request("server.flushSessions", {
      spaces: spaces === undefined ? undefined : [...spaces],
    });
  }

  /** @inheritDoc */
  noteExecutorCommit(
    notice: Parameters<HostMemoryServer["noteExecutorCommit"]>[0],
  ): void {
    this.#endpoint.notify("server.noteExecutorCommit", { notice });
  }

  /** @inheritDoc */
  noteLeaseReacquired(notice: { space: string; principal: string }): void {
    this.#endpoint.notify("server.noteLeaseReacquired", { notice });
  }

  /** @inheritDoc */
  checkServedAclChange(
    change: ServedAclChange,
  ): ReturnType<HostMemoryServer["checkServedAclChange"]> {
    return this.#endpoint.request("server.checkServedAclChange", {
      change: servedAclChangeData(change),
    });
  }

  /** @inheritDoc */
  commitServedAclChange(
    change: ServedAclChange & { sessionId: string; localSeq: number },
  ): ReturnType<HostMemoryServer["commitServedAclChange"]> {
    const { sessionId, localSeq, ...rest } = change;
    return this.#endpoint.request("server.commitServedAclChange", {
      change: servedAclChangeData(rest),
      sessionId,
      localSeq,
    });
  }

  /** @inheritDoc */
  commitDelegatedAppend(
    entry: Parameters<HostMemoryServer["commitDelegatedAppend"]>[0],
  ): ReturnType<HostMemoryServer["commitDelegatedAppend"]> {
    return this.#endpoint.request("server.commitDelegatedAppend", {
      entry: encodeMemoryBoundary(entry as unknown as FabricValue),
    });
  }

  /** @inheritDoc */
  engineForSpace(space: string): Promise<Engine.Engine> {
    return this.#plane.engineForSpace(space);
  }

  /** @inheritDoc */
  foreignWriteAuthorityFor(
    space: string,
    principal: string | undefined,
  ): ReturnType<HostMemoryServer["foreignWriteAuthorityFor"]> {
    return this.#endpoint.request("server.foreignWriteAuthorityFor", {
      space,
      principal,
    });
  }

  /** @inheritDoc */
  resolveSpaceOwner(engine: Engine.Engine, space: string): string | undefined {
    return resolveSpaceOwnerOf(engine, space);
  }

  /** @inheritDoc */
  async setViewSelection(
    ...[space, handle, selection]: Parameters<
      HostMemoryServer["setViewSelection"]
    >
  ): Promise<boolean> {
    const installed = await this.#endpoint.request("server.setViewSelection", {
      space,
      handle,
      selection,
    });
    // The held interest then carries the generation the server holds, so
    // the next publish builds on it without reading the list again.
    if (installed) {
      this.#viewInterests.noteSelection(space, handle, selection.generation);
    }
    return installed;
  }

  /** @inheritDoc */
  demandForSpace(
    space: string,
    options: { excludePrincipal?: string } = {},
  ): ReturnType<HostMemoryServer["demandForSpace"]> {
    // The shares the server reported unchanged are handed over as the
    // objects of the last pass; only the changed sessions' cross the port.
    return this.#demandShares.sharesFor(
      space,
      this.#sessions.live(space),
      options.excludePrincipal,
      (sessionIds) =>
        this.#endpoint.request("server.demandForSessions", {
          space,
          sessionIds,
          excludePrincipal: options.excludePrincipal,
        }),
    );
  }

  /** @inheritDoc */
  async viewInterestsForSpace(
    space: string,
    options: { excludePrincipal?: string } = {},
  ): Promise<SessionViewInterest[]> {
    this.#sessions.live(space);
    // The list crosses the port once, and again only after the server
    // reported a change that can move it (`ServingPlane`'s notices).
    const interests = await this.#viewInterests.interestsFor(
      space,
      options.excludePrincipal,
      () =>
        this.#endpoint.request("server.viewInterestsForSpace", {
          space,
          excludePrincipal: undefined,
        }),
    );
    // A space with no session left keeps no list. The mirror's report of
    // its last session leaving drops the one held; a read that found the
    // space so, or left it so, holds its answer no longer than this call.
    if (this.#sessions.live(space).size === 0) {
      this.#viewInterests.forget(space);
    }
    return interests;
  }
}

/**
 * The worker's serving plane: the memory server for an `ExecutorHost` built
 * in the worker, the loopback plane for its serving runtimes, and the wave
 * commit sink factory for its space servers, all over one port. `serve()`
 * installs the host the server's thread may ask things of.
 */
export class ServingPlane {
  readonly #endpoint: ServingPlaneEndpoint;
  readonly #demandShares = new DemandShareCache();
  readonly #viewInterests = new ViewInterestCache();
  readonly #sessions = new SessionMirror(
    (space, sessionId) => {
      this.#demandShares.forget(space, sessionId);
      this.#viewInterests.noteChanged(space);
    },
    (space) => this.#viewInterests.forget(space),
  );
  readonly #engines = new Map<string, Promise<Engine.Engine>>();
  readonly #transports = new Map<
    number,
    MemoryClient.QueuedFrameTransport
  >();
  readonly #server: HostMemoryServer;
  readonly #loopback: LoopbackPlane;
  #observer: ServerExecutionObserver | undefined;
  #nextTransport = 1;
  #closed = false;

  constructor(endpoint: ServingPlaneEndpoint) {
    this.#endpoint = endpoint;
    this.#server = new PlaneMemoryServer(
      this,
      endpoint,
      this.#sessions,
      this.#demandShares,
      this.#viewInterests,
    );
    this.#loopback = { createTransport: () => this.#createTransport() };
    endpoint.onNotice("observer.commitAdmitted", ({ notice }) => {
      this.#observer?.commitAdmitted?.(notice);
    });
    endpoint.onNotice("observer.sessionOpened", ({ space }) => {
      this.#observer?.sessionOpened?.(space);
    });
    endpoint.onNotice(
      "observer.demandChanged",
      ({ space, reason, principal, sessionId }) => {
        this.#demandShares.noteChanged(space, sessionId);
        this.#observer?.demandChanged?.(space, reason, principal, sessionId);
      },
    );
    // The two things that move a space's view interests: a watch set that
    // carried views, and a session's lifecycle, which attaches a view's
    // session or takes it out of the list.
    endpoint.onNotice("observer.viewsChanged", ({ space, sessionId }) => {
      this.#viewInterests.noteChanged(space);
      this.#observer?.viewsChanged?.(space, sessionId);
    });
    endpoint.onNotice("observer.sessionChanged", ({ event }) => {
      this.#sessions.apply(event);
      this.#viewInterests.noteChanged(event.space);
      if (event.kind === "removed") {
        this.#demandShares.forget(event.space, event.sessionId);
      }
      this.#observer?.sessionChanged?.(event);
    });
    endpoint.onNotice("loopback.frame", ({ transport, frame }) => {
      this.#transports.get(transport)?.deliver(frame);
    });
  }

  /** The memory server, for the host. */
  get server(): HostMemoryServer {
    return this.#server;
  }

  /** The loopback plane, for the serving runtime factory. */
  get loopback(): LoopbackPlane {
    return this.#loopback;
  }

  /**
   * DIAGNOSTIC (tests): how many spaces the plane keeps view interests, or a
   * note of their change, for.
   */
  get heldViewInterestSpaces(): number {
    return this.#viewInterests.size;
  }

  /** The host's observer of the server, as the host installed it. */
  get observer(): ServerExecutionObserver | undefined {
    return this.#observer;
  }

  set observer(observer: ServerExecutionObserver | undefined) {
    this.#observer = observer;
  }

  /** The tenure's sink; `ExecutorHostOptions.createWaveCommitSink`. */
  createWaveCommitSink(deps: WaveCommitSinkDeps): WaveCommitSink {
    return new PlaneWaveCommitSink(this.#endpoint, deps);
  }

  /** Installs what the server's thread may ask of the worker's host. */
  serve(host: ServingPlaneHost): void {
    this.#endpoint.onRequest("host.stats", () => host.stats());
    this.#endpoint.onRequest("host.diagnostics", () => host.diagnostics());
    this.#endpoint.onRequest(
      "host.runLifecycleVerb",
      ({ space, verb }) => host.runLifecycleVerb(space, verb),
    );
    this.#endpoint.onRequest("host.close", () => host.close());
  }

  /** Posts the host's counters for the server's thread to keep. */
  reportStats(stats: ServingLoopStats): void {
    this.#endpoint.notify("host.stats", { stats });
  }

  /** Posts a space's activation outcome for the server's thread to report. */
  reportActivationSettled(
    space: MemorySpace,
    outcome: "active" | "refused" | "failed",
  ): void {
    this.#endpoint.notify("host.activationSettled", { space, outcome });
  }

  /** Posts a space's park and its reason for the server's thread to report. */
  reportSpaceParked(space: MemorySpace, reason: string): void {
    this.#endpoint.notify("host.spaceParked", { space, reason });
  }

  /**
   * The worker's own connection to the space's store, opened once per space
   * at the file the server's thread names once it has the space open itself.
   */
  engineForSpace(space: string): Promise<Engine.Engine> {
    let opening = this.#engines.get(space);
    if (opening === undefined) {
      opening = (async () => {
        const { url } = await this.#endpoint.request("space.open", { space });
        return await Engine.open({ url: new URL(url) });
      })();
      this.#engines.set(space, opening);
      opening.catch(() => {
        if (this.#engines.get(space) === opening) this.#engines.delete(space);
      });
    }
    return opening;
  }

  /**
   * Closes the worker's engines and the port, losing every loopback
   * connection still open. Called once the host has closed.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const lost = new Error("the serving plane closed");
    for (const [id, transport] of [...this.#transports]) {
      this.#transports.delete(id);
      transport.lose(lost);
    }
    const engines = [...this.#engines.values()];
    this.#engines.clear();
    for (const opening of engines) {
      try {
        Engine.close(await opening);
      } catch (error) {
        logger.warn("engine-close-failed", () => [
          "closing a worker-side engine failed",
          error,
        ]);
      }
    }
    this.#endpoint.close(lost);
  }

  #createTransport(): MemoryClient.Transport {
    const id = this.#nextTransport++;
    const transport = planeTransport(this.#endpoint, id, () => {
      this.#transports.delete(id);
    });
    this.#transports.set(id, transport);
    this.#endpoint.request("loopback.open", { transport: id }).catch(
      (error) => {
        this.#transports.delete(id);
        transport.lose(
          MemoryClient.connectionError(
            "opening a loopback connection failed",
            error,
          ),
        );
      },
    );
    return transport;
  }
}
