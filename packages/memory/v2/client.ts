import type { FabricPlainObject, FabricValue } from "@commonfabric/api";
import { debugStr } from "@commonfabric/data-model";
import { getLogger } from "@commonfabric/utils/logger";
import {
  isObjectNotArray,
  isPlainObject,
  unsafeObjectKeyIn,
} from "@commonfabric/utils/types";

import {
  type ClientCommit,
  compatibleMemoryProtocolFlags,
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type EntityId,
  type EntityIdListOptions,
  type EntityIdListResult,
  type EntityIdLookupResult,
  type EntitySnapshot,
  type EventAttentionResolveResult,
  type GenesisRoot,
  getMemoryProtocolFlags,
  type GraphQuery,
  type GraphQueryResult,
  MAX_ENTITY_ID_PAGE_SIZE,
  MEMORY_PROTOCOL,
  type MemoryProtocolFlags,
  type OperationFieldQuery,
  type OperationFieldQueryResult,
  parseMemoryProtocolFlags,
  type ResponseMessage,
  type SessionEffectMessage,
  type SessionHolding,
  type SessionOpenAuthMetadata,
  type SessionOpenChallenge,
  type SessionOpenResult,
  type SessionReadCeiling,
  type SessionRevokedMessage,
  type SessionSync,
  type SqliteDbRef,
  type SqliteParamsWire,
  type SqliteQueryReader,
  type SqliteQueryResult,
  type SqliteQueryWireResult,
  type SqliteRegisterDiskSourceResult,
  sqliteRowFromWire,
  type ViewInterest,
  type WatchAddResult,
  type WatchSetResult,
  type WatchSpec,
} from "../v2.ts";
import type { AppliedCommit } from "./engine.ts";
import { logIncomingFrame, logOutgoingFrame } from "./frame-log.ts";
import { memoryMessageFrameBytes } from "./message-compression.ts";
import type { Server } from "./server.ts";
import { containsReservedSchemaRefSubstring } from "./sync-schema-ref.ts";
import { expandServerMessageSchemas } from "./sync-schema-table.ts";
import { type ArmedTurn, armTurn } from "./turn.ts";

const logger = getLogger("memory.v2.client", {
  enabled: true,
  level: "error",
});

export type Transport = {
  /** Whether this transport can exchange negotiated compression envelopes. */
  readonly supportsMessageCompression?: boolean;

  send(payload: string): Promise<void>;
  close(): Promise<void>;
  setReceiver(receiver: (payload: string) => void): void;
  setCloseReceiver?(receiver: (error?: Error) => void): void;

  /** Enables compression after a successful capability handshake. */
  setMessageCompressionEnabled?(enabled: boolean): void;
};

export type ConnectOptions = {
  transport: Transport;
  signal?: AbortSignal;
};

/**
 * The connection states a `Client` distinguishes, one member per branch of
 * its `#ensureConnected()` guard — the decision every request passes through,
 * which reads the same fields to settle whether to proceed, to reconnect, or
 * to throw. A branch added to that guard is a member owed here.
 */
export type ConnectionState =
  | "connected"
  | "reconnecting"
  | "failed"
  | "closed";

export type MountOptions = {
  /** Require the space's complete persisted custom-root intent. */
  genesisRoot?: GenesisRoot;
  sessionId?: string;
  seenSeq?: number;
  sessionToken?: string;

  /** The session-level delegated READ binding (OW31; see the wire
   * `SessionDescriptor.actingAs`): only the serving plane's loopback
   * managers set it; the server admits it for delegating-class
   * principals only. Carried on reopen so a route replacement keeps
   * the binding. */
  actingAs?: "space-owner";

  /** The session's declared read ceiling (the wire
   * `SessionDescriptor.readCeiling`): set by a client runtime under server
   * execution that is configured with one, and carried on every reopen so
   * a resumed session is bounded exactly as the first open was. */
  readCeiling?: SessionReadCeiling;
};

export type SessionOpenAuth = {
  invocation: FabricPlainObject;
  authorization: FabricValue;
};

export type SessionOpenAuthContext = {
  challenge: SessionOpenChallenge;
  audience: string;
};

export type SessionOpenAuthFactory = (
  space: string,
  session: MountOptions,
  context: SessionOpenAuthContext,
) => Promise<SessionOpenAuth | undefined> | SessionOpenAuth | undefined;

export type WatchMutationResult = {
  view: WatchView;

  /** Effects delivered before the first watch response, in wire order. */
  precedingSyncs: SessionSync[];

  sync: SessionSync;
};

const RECONNECT_BASE_DELAY_MS = 25;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.2;

const reconnectDelayMs = (attempt: number): number => {
  const baseDelay = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * 2 ** attempt,
  );
  return Math.min(
    RECONNECT_MAX_DELAY_MS,
    Math.floor(baseDelay * (1 + Math.random() * RECONNECT_JITTER_RATIO)),
  );
};

// The view's entity key: per scope INSTANCE where the frame names one
// (server-execution v2 stage A, OW17's wire leg — lease-holder frames
// carry `scopeKey`, and such a session may hold two instances of one
// (branch, id, scope) at once), else per scope NAME as always. An unkeyed
// frame's key text is byte-identical to before.
const watchKey = (
  branch: string,
  id: string,
  scope: string | undefined,
  scopeKey?: string,
): string => `${branch}\0${scopeKey ?? scope ?? "space"}\0${id}`;

const compareEntitySnapshot = (
  left: EntitySnapshot,
  right: EntitySnapshot,
): number =>
  left.branch.localeCompare(right.branch) ||
  (left.scope ?? "space").localeCompare(right.scope ?? "space") ||
  left.id.localeCompare(right.id);

const runWithAbortSignal = async <T>(
  signal: AbortSignal | undefined,
  fallbackMessage: string,
  start: () => T | PromiseLike<T>,
): Promise<T> => {
  const abortError = (): Error =>
    signal?.reason instanceof Error
      ? signal.reason
      : new Error(fallbackMessage);
  if (signal?.aborted) {
    throw abortError();
  }
  if (signal === undefined) {
    return await start();
  }

  const cancelled = Promise.withResolvers<never>();
  const cancel = (): void => cancelled.reject(abortError());
  signal.addEventListener("abort", cancel, { once: true });
  let work: Promise<T>;
  try {
    work = Promise.resolve(start());
  } catch (error) {
    signal.removeEventListener("abort", cancel);
    throw error;
  }
  if (signal.aborted) {
    cancel();
  }
  try {
    return await Promise.race([work, cancelled.promise]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
};

export class Client {
  #pending = new Map<string, PromiseWithResolvers<unknown>>();
  #spaces = new Set<SpaceSession>();
  #nextRequest = 1;
  #helloPending: PromiseWithResolvers<void> | null = null;
  #sessionOpenAuthContext: SessionOpenAuthContext | null = null;
  #serverFlags: MemoryProtocolFlags | null = null;
  #reconnecting: Promise<void> | null = null;
  #cancelReconnectDelay: (() => void) | null = null;
  #connected = false;
  #closed = false;

  /**
   * The error that ended reconnection, set when a reconnect handshake fails
   * for a reason retrying cannot change (a protocol-flag mismatch — the
   * transport is fundamentally incompatible). The client stops reconnecting
   * and fails every further request with it, instead of looping forever. A
   * per-session authorization denial does _not_ land here: it terminates only
   * that session (see `SpaceSession.restore()`), leaving sessions for other
   * spaces on this client alive.
   */
  #fatalError: Error | null = null;

  /**
   * The resolvers for the promise `whenStateChanged()` hands out, or `null`
   * when nobody has called since the last notification. One set serves every
   * caller waiting on the same notification, and clearing it as the client
   * notifies is what makes a caller that registers again wait for the next
   * one rather than see the notification it has just observed.
   */
  #stateChanged: PromiseWithResolvers<void> | null = null;

  readonly #transport: Transport;

  private constructor(
    transport: Transport,
  ) {
    this.#transport = transport;
    this.#transport.setReceiver((payload) => this.#onMessage(payload));
    this.#transport.setCloseReceiver?.((error) => this.#onClose(error));
  }

  static async connect(options: ConnectOptions): Promise<Client> {
    const client = new Client(options.transport);
    const abortError = (): Error =>
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error("memory client connection cancelled");
    const closeForAbort = (): void => {
      void client.close().catch(() => {});
    };
    options.signal?.addEventListener("abort", closeForAbort, { once: true });
    try {
      if (options.signal?.aborted) throw abortError();
      await client.#hello();
      if (options.signal?.aborted) throw abortError();
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw options.signal?.aborted ? abortError() : error;
    } finally {
      options.signal?.removeEventListener("abort", closeForAbort);
    }
  }

  /** The flags the SERVER advertised in its `hello.ok` (null before the first
   *  handshake). Capability keys an old server never sent parse to `false`, so
   *  optional-capability consumers fail closed by reading this. */
  get serverFlags(): MemoryProtocolFlags | null {
    return this.#serverFlags;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#connected = false;
    this.#noteStateChange();
    this.#cancelReconnectDelay?.();
    this.#rejectPending(new Error("memory client closed"));
    await Promise.all([...this.#spaces].map((space) => space.close()));
    this.#spaces.clear();
    await this.#transport.close();
    await this.#reconnecting?.catch(() => undefined);
  }

  async mount(
    space: string,
    options: MountOptions = {},
    openAuthFactory?: SessionOpenAuthFactory,
    signal?: AbortSignal,
  ): Promise<SpaceSession> {
    const auth = await runWithAbortSignal(
      signal,
      "memory session mount cancelled",
      () =>
        openAuthFactory?.(
          space,
          options,
          this.sessionOpenAuthContext(),
        ),
    );
    const result = await runWithAbortSignal(
      signal,
      "memory session mount cancelled",
      () => this.openSession(space, options, auth),
    );
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("memory session mount cancelled");
    }
    // Between openSession resolving (the session now exists server-side)
    // and the registration below, a session-scoped frame would find no
    // routing entry. Unreachable for a transport that delivers one frame
    // per event-loop task: this continuation is synchronous plus
    // microtasks, which drain before the next task, and only a
    // resume-mount has frames to deliver that early.
    const session = new SpaceSession(
      this,
      space,
      result.sessionId,
      result.sessionToken,
      result.serverSeq,
      openAuthFactory,
      signal,
      options.actingAs,
      options.readCeiling,
      options.genesisRoot,
    );
    this.#spaces.add(session);
    return session;
  }

  forgetSession(session: SpaceSession): void {
    this.#spaces.delete(session);
  }

  async request<Result>(message: FabricPlainObject): Promise<Result> {
    await this.#ensureConnected();
    // `ensureConnected()` is async even when the transport is already live, so
    // close() can run while this request is suspended there. Recheck before
    // registering the request; otherwise it can miss close()'s rejectPending()
    // sweep and wait forever for a response on the closed transport.
    if (this.#closed) {
      throw new Error("memory client is closed");
    }
    const requestId = message.requestId as string;
    const pending = Promise.withResolvers<unknown>();
    // The rejection handler below only attaches after the transport send
    // completes, and send suspends across event-loop turns on any real
    // transport — close()'s rejectPending() can fire in that window with
    // no handler attached yet, surfacing as an unhandled rejection. The
    // pre-attached no-op keeps the window closed; the await below still
    // observes the rejection.
    pending.promise.catch(() => {});
    this.#pending.set(requestId, pending);
    const encoded = encodeMemoryBoundary(message);
    logOutgoingFrame(message, memoryMessageFrameBytes(encoded));
    await this.#transport.send(encoded);
    const result = await pending.promise as ResponseMessage<Result>;
    if (result.error) {
      const error = new Error(result.error.message);
      error.name = result.error.name;
      if (result.error.precondition !== undefined) {
        (error as Error & { precondition?: string }).precondition =
          result.error.precondition;
      }
      if (result.error.retryAfterSeq !== undefined) {
        (error as Error & { retryAfterSeq?: number }).retryAfterSeq =
          result.error.retryAfterSeq;
      }
      if (result.error.conflicts !== undefined) {
        (error as Error & { conflicts?: unknown }).conflicts =
          result.error.conflicts;
      }
      if (result.error.retriable !== undefined) {
        (error as Error & { retriable?: boolean }).retriable =
          result.error.retriable;
      }
      if (result.error.permanentEvidence === true) {
        (error as Error & { permanentEvidence?: true }).permanentEvidence =
          true;
      }
      if (result.error.aclRevision !== undefined) {
        (error as Error & { aclRevision?: number }).aclRevision =
          result.error.aclRevision;
      }
      throw error;
    }
    return result.ok as Result;
  }

  async openSession(
    space: string,
    session: MountOptions,
    auth?: SessionOpenAuth,
    holdings?: SessionHolding[],
  ): Promise<SessionOpenResult> {
    // Every open passes through here — a first mount and each reopen after
    // a dropped connection alike — so this is where a declared ceiling is
    // held to the server it is declared to. A server that does not
    // advertise `sessionReadCeiling` would accept the descriptor and serve
    // every query unbounded.
    if (
      session.readCeiling !== undefined &&
      this.serverFlags?.sessionReadCeiling !== true
    ) {
      throw protocolError(
        "memory server does not record a session's read ceiling " +
          "(`sessionReadCeiling` is not among its protocol flags), so a " +
          "session declaring one cannot be bounded by it",
      );
    }
    if (
      session.genesisRoot !== undefined &&
      this.serverFlags?.genesisRoot !== true
    ) {
      throw protocolError(
        "memory server does not support a custom root intent",
      );
    }
    const result = await this.request<SessionOpenResult>({
      type: "session.open",
      requestId: this.#nextRequestId(),
      space,
      session,
      ...(auth ? auth : {}),
      ...(holdings !== undefined ? { holdings } : {}),
    });
    this.#updateSessionOpenAuthContext(result.sessionOpen);
    return result;
  }

  isConnected(): boolean {
    return this.#connected;
  }

  /**
   * The state this client is in now, decided in the branch order
   * `#ensureConnected()` uses. Reading `#connected` before falling through to
   * `reconnecting` is what makes this agree with `isConnected()` across the
   * window a successful reconnect opens, where the handshake has already
   * marked the client connected while the reconnect it belongs to is still in
   * flight.
   *
   * The agreement stops there rather than holding in general. A `close()`
   * landing while a handshake continuation is queued leaves `#connected` true
   * under `#closed`, and this reports `closed` where `isConnected()` reports
   * `true`. Where they differ, this is the accurate one.
   */
  get connectionState(): ConnectionState {
    if (this.#closed) return "closed";
    if (this.#fatalError) return "failed";
    if (this.#connected) return "connected";
    return "reconnecting";
  }

  /**
   * Resolves the next time the client settles its connection state, which is
   * usually a change to `.connectionState` and sometimes is not. A caller
   * waits on that instead of registering and removing a listener:
   *
   * ```js
   * while (client.connectionState !== desired) {
   *   await client.whenStateChanged();
   * }
   * ```
   *
   * That loop reads the getter and calls this in one synchronous step, which
   * is what stops a change slipping between the two. A caller that awaits
   * anything else in between can miss one.
   *
   * It yields no value, deliberately: the state can move again between the
   * resolution and the caller resuming, so anything handed over would be
   * stale by construction. Giving up on a reconnect shows it concretely. The
   * reconnect loop's catch settles on `reconnecting` and notifies, then
   * records a permanent failure in the same synchronous block, so a waiter
   * resuming on a microtask reads `failed` — the state when it looks, not
   * the one that held when it was woken.
   *
   * A wakeup carrying no change is harmless for the same reason: the loop
   * re-tests and waits again. Calling `close()` on a closed client is one.
   *
   * The bound on it: `closed` is the one state nothing follows. Closing an
   * already-closed client still wakes a waiter, which reads `closed` again,
   * so a loop waiting for any other state never leaves. `failed` is left
   * only by `close()`, never by a reconnect. Test for both rather than
   * waiting through them.
   */
  whenStateChanged(): Promise<void> {
    this.#stateChanged ??= Promise.withResolvers<void>();
    return this.#stateChanged.promise;
  }

  sessionOpenAuthContext(): SessionOpenAuthContext {
    if (this.#sessionOpenAuthContext === null) {
      const error = new Error(
        "memory server did not provide session.open authentication metadata",
      );
      error.name = "ProtocolError";
      throw error;
    }
    return this.#sessionOpenAuthContext;
  }

  #updateSessionOpenAuthContext(sessionOpen: unknown): void {
    this.#sessionOpenAuthContext = requireSessionOpenAuthMetadata(sessionOpen);
  }

  /** Waits for the transport handshake and restoration of existing sessions. */
  async restoreConnection(): Promise<void> {
    await this.#ensureConnected();
    await this.#reconnecting;
  }

  async #hello(): Promise<void> {
    this.#transport.setMessageCompressionEnabled?.(false);
    const ack = Promise.withResolvers<void>();
    this.#helloPending = ack;
    const expectedFlags = getMemoryProtocolFlags();
    try {
      const hello = {
        type: "hello",
        protocol: MEMORY_PROTOCOL,
        flags: {
          ...expectedFlags,
          messageCompressionV1: expectedFlags.messageCompressionV1 &&
            this.#transport.supportsMessageCompression === true,
        },
      };
      const encoded = encodeMemoryBoundary(hello);
      logOutgoingFrame(hello, memoryMessageFrameBytes(encoded));
      await Promise.all([this.#transport.send(encoded), ack.promise]);
      this.#connected = true;
      this.#noteStateChange();
    } finally {
      this.#helloPending = null;
    }
  }

  #onMessage(payload: string): void {
    let message: unknown;
    try {
      const decodeStart = performance.now();
      message = decodeMemoryBoundary(payload);
      logger.time(decodeStart, "receive", "decodeBoundary");
      logIncomingFrame(message, memoryMessageFrameBytes(payload));
      // A frame whose raw text lacks every reserved reference prefix cannot
      // carry a schema reference (strings serialize verbatim — see the note
      // on encodeMemoryBoundary), so the expansion walk over its upserts is
      // skipped entirely.
      if (containsReservedSchemaRefSubstring(payload)) {
        const schemaExpansionStart = performance.now();
        message = expandServerMessageSchemas(message);
        logger.time(schemaExpansionStart, "receive", "schemaExpansion");
      }
    } catch (cause) {
      const error = new Error("Unable to parse memory server message", {
        cause,
      });
      error.name = "InvalidMessageError";
      if (this.#helloPending !== null) {
        this.#helloPending.reject(error);
      } else {
        this.#rejectPending(error);
      }
      return;
    }

    if (this.#helloPending !== null) {
      const helloOk = parseHelloOk(message);
      if (helloOk !== null) {
        const expectedFlags = getMemoryProtocolFlags();
        if (!helloOk.flags.stableExpressionResultIds) {
          this.#helloPending.reject(permanentProtocolError(
            "The memory server does not enforce stable expression result " +
              "identities. Update the server before connecting this runtime.",
          ));
          return;
        }
        if (!compatibleMemoryProtocolFlags(helloOk.flags, expectedFlags)) {
          // A data-model wire-contract mismatch: this client and server cannot
          // talk at all, and no retry changes that. Mark it permanent so a
          // reconnect that hits it gives up rather than retrying a doomed
          // handshake.
          const error = permanentProtocolError(
            debugStr`memory flag mismatch: client=$quote,long${expectedFlags} server=$quote,long${helloOk.flags}`,
          );
          this.#helloPending.reject(error);
          return;
        }
        // The server's advertised flags (refreshed per hello, so a reconnect
        // to a different server version updates them). Optional-capability
        // consumers (e.g. the runner's sqlite write-gate relaxation) read
        // these; absent-on-old-server keys parse to false — fail closed.
        this.#serverFlags = helloOk.flags;
        this.#transport.setMessageCompressionEnabled?.(
          expectedFlags.messageCompressionV1 &&
            this.#transport.supportsMessageCompression === true &&
            helloOk.flags.messageCompressionV1,
        );
        try {
          this.#sessionOpenAuthContext = requireSessionOpenAuthMetadata(
            helloOk.sessionOpen,
          );
        } catch (error) {
          this.#helloPending.reject(
            error instanceof Error ? error : protocolError(String(error)),
          );
          return;
        }
        this.#helloPending.resolve();
        return;
      }

      if (isResponse(message) && message.requestId === "handshake") {
        if (message.error) {
          const error = new Error(message.error.message);
          error.name = message.error.name;
          this.#helloPending.reject(error);
        } else {
          const error = new Error("memory handshake failed");
          error.name = "ProtocolError";
          this.#helloPending.reject(error);
        }
        return;
      }

      const error = new Error("memory handshake expected hello.ok");
      error.name = "ProtocolError";
      this.#helloPending.reject(error);
      return;
    }

    if (isSessionEffect(message)) {
      for (const session of this.#spaces) {
        if (
          session.sessionId === message.sessionId &&
          session.space === message.space
        ) {
          session.handleEffect(message.effect);
        }
      }
      return;
    }
    if (isSessionRevoked(message)) {
      for (const session of this.#spaces) {
        if (
          session.sessionId === message.sessionId &&
          session.space === message.space
        ) {
          session.handleRevoked(message.reason);
        }
      }
      return;
    }
    if (isResponse(message)) {
      const pending = this.#pending.get(message.requestId);
      if (pending) {
        pending.resolve(message);
        this.#pending.delete(message.requestId);
      }
    }
  }

  #nextRequestId(): string {
    return `req:${this.#nextRequest++}`;
  }

  async #ensureConnected(): Promise<void> {
    if (this.#closed) {
      throw new Error("memory client is closed");
    }
    if (this.#fatalError) {
      throw this.#fatalError;
    }
    if (this.#connected) {
      return;
    }
    await this.#reconnect();
    // #reconnect() resolves without connecting when it gives up on a permanent
    // handshake failure; surface it here rather than returning as if connected.
    if (this.#fatalError) {
      throw this.#fatalError;
    }
  }

  #onClose(error?: Error): void {
    if (this.#closed) {
      return;
    }
    this.#connected = false;
    this.#noteStateChange();
    for (const session of this.#spaces) {
      session.handleDisconnect();
    }
    this.#rejectPending(toConnectionError(error));
    void this.#reconnect().catch(() => undefined);
  }

  async #reconnect(): Promise<void> {
    if (this.#closed) {
      throw new Error("memory client is closed");
    }
    if (this.#fatalError) {
      throw this.#fatalError;
    }
    if (this.#reconnecting) {
      return await this.#reconnecting;
    }
    this.#reconnecting = (async () => {
      let attempt = 0;
      while (!this.#closed) {
        try {
          await this.#hello();
          for (const session of this.#spaces) {
            await session.restore();
          }
          return;
        } catch (error) {
          this.#connected = false;
          this.#noteStateChange();
          const err = error instanceof Error ? error : new Error(String(error));
          if (isPermanentConnectionFailure(err)) {
            // A handshake the server refuses identically every time (a
            // protocol-flag mismatch). Stop looping and remember the failure so
            // every present and future request fails fast with it.
            this.#fatalError = err;
            // Redundant today: the notification at the top of this catch
            // has already woken every waiter, and none of them resumes
            // until this block finishes, so each reads the state this
            // line settles. It stays because no write to a field
            // `.connectionState` reads leaves its block without a
            // notification covering it, and that rule is what lets the
            // write sites be checked rather than reasoned about one by
            // one.
            this.#noteStateChange();
            this.#rejectPending(err);
            for (const session of this.#spaces) {
              session.handleConnectionFailure(err);
            }
            return;
          }
          this.#rejectPending(err);
          await this.#waitForReconnectDelay(reconnectDelayMs(attempt));
          attempt += 1;
        }
      }
    })();

    try {
      await this.#reconnecting;
    } finally {
      this.#reconnecting = null;
    }
  }

  /**
   * Waits `delayMs` between a failed reconnect attempt and the next. The
   * reconnect attempt itself is event-driven: `hello()` awaits the transport's
   * real open/error/close. The pause runs on a timer, since a returning server
   * raises no event to await. The delay bounds the retry rate, and `close()`
   * ends it through the stored canceller.
   */
  #waitForReconnectDelay(delayMs: number): Promise<void> {
    if (this.#closed) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#cancelReconnectDelay = null;
        resolve();
      }, delayMs);
      this.#cancelReconnectDelay = () => {
        clearTimeout(timer);
        this.#cancelReconnectDelay = null;
        resolve();
      };
    });
  }

  /**
   * Wakes every caller waiting on `whenStateChanged()`. Runs after a write
   * that can move `.connectionState`, including one that leaves it where it
   * was: a wakeup with nothing behind it costs a waiter one re-read, which is
   * the loop it is already in.
   */
  #noteStateChange(): void {
    const waiting = this.#stateChanged;
    this.#stateChanged = null;
    waiting?.resolve();
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
    this.#helloPending?.reject(error);
    this.#helloPending = null;
  }
}

export class SpaceSession {
  #outstandingCommits = new Map<number, {
    commit: ClientCommit;
    pending: PromiseWithResolvers<AppliedCommit>;
  }>();
  #watchSpecs: WatchSpec[] = [];
  #viewInterests: ViewInterest[] = [];
  #viewsDirty = false;
  #viewIntentVersion = 0;
  #restoreComplete: PromiseWithResolvers<void> | undefined;
  #viewCapabilityLostObservers = new Set<() => void>();
  #accessLossObservers = new Set<(error: Error) => void>();
  #watchSpecPositions = new Map<string, number[]>();
  #watchView: WatchView | null = null;
  #precedingWatchSyncs: SessionSync[] = [];
  #sessionId: string;
  #sessionToken: string | undefined;
  #serverSeq: number;
  #ackedSeq = 0;
  #pendingAckSeq = 0;
  #ackScheduled = false;
  #ackFlushing = false;
  #background = new Set<Promise<void>>();

  /**
   * Serializes the _application_ of watch responses (the `#watchSpecs` /
   * `#watchView` mutations) in call order, so application stays ordered even
   * when round trips overlap on the wire.
   */
  #watchApply: Promise<void> = Promise.resolve();

  /**
   * Serializes request _issue_ in call order; in concurrent mode it advances
   * as soon as a request has been _sent_ (not answered), so multiple watch
   * round trips overlap on the wire. In single-flight mode it is unused and
   * each mutation's request and apply run together on `#watchApply`.
   */
  #watchIssue: Promise<void> = Promise.resolve();

  /**
   * Whether watch-refresh round trips may overlap (default off). Per-session,
   * _not_ a process global. Set by the runner from the
   * `experimentalConcurrentWatchRefresh` storage setting; see
   * `docs/development/EXPERIMENTAL_OPTIONS.md`.
   */
  #concurrentWatchRefresh = false;

  #closed = false;
  #closeError: Error | null = null;
  #readyOnConnection = true;
  #restoring = false;
  #caughtUpLocalSeq = 0;

  /** Invoked when a restore REPLACES the session (a new session id, or the
   * same id re-opened without resume): the marker epoch reset, so
   * marker-keyed client state (parked accepted promotions) must be
   * reconciled immediately (CT-1927). */
  onSessionReplaced: (() => void) | undefined;

  /** Supplies the replica's declared holdings for a reconnect (see the
   * wire `SessionHolding`): consulted on every reopen. The session itself
   * holds no document state — the replica that consumes its frames does —
   * so the statement comes from the consumer. Absent, a reconnect
   * declares nothing and takes the declaration-less delivery paths (the
   * server-memory resume, the full re-establishment). Present, the
   * declaration is what makes those paths safe to skip — so a server that
   * cannot take it (`sessionHoldings` unadvertised) terminates the
   * session at restore rather than silently degrading (see `restore`). */
  holdingsProvider: (() => SessionHolding[] | undefined) | undefined;

  /**
   * Highest `caughtUpLocalSeq` already pushed into the `WatchView` (via a real
   * sync or a synthetic forward). Subscribers such as runner storage only
   * advance their own caught-up seq from emitted syncs, so a resume that
   * promotes `caughtUpLocalSeq` via the top-level `SessionOpenResult` field
   * (no sync) must be forwarded explicitly or their conflict-retry waiters
   * strand.
   */
  #forwardedCaughtUpLocalSeq = 0;

  #caughtUpLocalSeqWaiters: {
    localSeq: number;
    pending: PromiseWithResolvers<void>;
  }[] = [];

  readonly #client: Client;
  readonly #openAuthFactory?: SessionOpenAuthFactory;
  readonly #routeSignal?: AbortSignal;
  readonly #actingAs?: "space-owner";
  readonly #readCeiling?: SessionReadCeiling;
  readonly #genesisRoot?: GenesisRoot;

  constructor(
    client: Client,
    readonly space: string,
    sessionId: string,
    sessionToken: string | undefined,
    serverSeq: number,
    openAuthFactory?: SessionOpenAuthFactory,
    routeSignal?: AbortSignal,
    actingAs?: "space-owner",
    readCeiling?: SessionReadCeiling,
    genesisRoot?: GenesisRoot,
  ) {
    this.#client = client;
    this.#openAuthFactory = openAuthFactory;
    this.#routeSignal = routeSignal;
    this.#actingAs = actingAs;
    this.#readCeiling = readCeiling;
    this.#genesisRoot = genesisRoot;
    this.#sessionId = sessionId;
    this.#sessionToken = sessionToken;
    this.#serverSeq = serverSeq;
    this.#ackedSeq = serverSeq;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get sessionToken(): string | undefined {
    return this.#sessionToken;
  }

  get serverSeq(): number {
    return this.#serverSeq;
  }

  /** The error this session was terminated with, or undefined while it is open.
   *  A permanent reopen denial stores its `AuthorizationError` here (see
   *  `restore`), which is what `#assertOpen` rethrows; a storage subscriber reads
   *  it to observe a denial that terminated the session without a fresh watch
   *  result to carry it. */
  get closeError(): Error | undefined {
    return this.#closeError ?? undefined;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw this.#closeError ?? new Error("memory session closed");
    }
  }

  /** Waits for restored session identity before constructing an ordinary request. */
  async #ensureSessionRestored(): Promise<void> {
    this.#assertOpen();
    await this.#client.restoreConnection();
    this.#assertOpen();
  }

  /**
   * `beforeIssue` runs after the open-session check and before this mutation
   * enters the session's outstanding request state. Throwing prevents issue.
   */
  async transact(
    commit: ClientCommit,
    beforeIssue?: () => void,
  ): Promise<AppliedCommit> {
    this.#assertOpen();
    if (
      commit.operations.some((operation) =>
        operation.op === "apply-op" || operation.op === "release-op-field"
      ) && this.#client.serverFlags?.applyOp !== true
    ) {
      throw protocolError("memory server does not support apply-op");
    }
    const existing = this.#outstandingCommits.get(commit.localSeq);
    if (existing) {
      return await existing.pending.promise;
    }

    beforeIssue?.();
    const pending = Promise.withResolvers<AppliedCommit>();
    this.#outstandingCommits.set(commit.localSeq, {
      commit,
      pending,
    });

    const outstanding = this.#outstandingCommits.get(commit.localSeq);
    if (
      outstanding !== undefined &&
      this.#client.isConnected() &&
      this.#readyOnConnection &&
      !this.#restoring
    ) {
      this.#sendOutstandingCommit(commit.localSeq, outstanding);
    } else {
      void this.#client.restoreConnection();
    }

    return await pending.promise;
  }

  async queryGraph(query: GraphQuery): Promise<GraphQueryResult> {
    await this.#ensureSessionRestored();
    const result = await this.#client.request<GraphQueryResult>({
      type: "graph.query",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      query,
    });

    this.#noteResult(result.serverSeq);
    return result;
  }

  async queryOperationField(
    query: Omit<OperationFieldQuery, "principal" | "sessionId">,
  ): Promise<OperationFieldQueryResult> {
    await this.#ensureSessionRestored();
    if (this.#client.serverFlags?.applyOp !== true) {
      throw protocolError("memory server does not support apply-op");
    }
    const result = await this.#client.request<OperationFieldQueryResult>({
      type: "op.query",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      query,
    });
    this.#noteResult(result.serverSeq);
    return result;
  }

  async resolveEventAttention(
    eventId: string,
    seq: number,
    sidecarId: string,
    action: "retry" | "dismiss",
  ): Promise<EventAttentionResolveResult> {
    await this.#ensureSessionRestored();
    const result = await this.#client.request<EventAttentionResolveResult>({
      type: "event.attention.resolve",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      eventId,
      seq,
      sidecarId,
      action,
    });
    this.#noteResult(result.serverSeq);
    return result;
  }

  async listEntityIds(
    options: EntityIdListOptions = {},
  ): Promise<EntityIdListResult | undefined> {
    await this.#ensureSessionRestored();
    if (this.#client.serverFlags?.entityIdListing !== true) {
      return undefined;
    }
    const pagination = this.#client.serverFlags.entityIdPagination === true;
    if (!pagination && Object.keys(options).length > 0) {
      return undefined;
    }
    const result = await this.#client.request<EntityIdListResult>({
      type: "entity-id.list",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      ...(pagination
        ? { ...options, limit: options.limit ?? MAX_ENTITY_ID_PAGE_SIZE }
        : {}),
    });

    this.#noteResult(result.serverSeq);
    return result;
  }

  async entityIdExists(
    id: EntityId,
  ): Promise<EntityIdLookupResult | undefined> {
    await this.#ensureSessionRestored();
    if (this.#client.serverFlags?.entityIdLookup !== true) {
      return undefined;
    }
    const result = await this.#client.request<EntityIdLookupResult>({
      type: "entity-id.exists",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      id,
    });

    this.#noteResult(result.serverSeq);
    return result;
  }

  /** Run a server-side read-only SQLite query against a cell-derived db. */
  async sqliteQuery(
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
    reader?: SqliteQueryReader,
  ): Promise<SqliteQueryResult> {
    await this.#ensureSessionRestored();
    if (
      reader !== undefined &&
      this.#client.serverFlags?.sqliteQueryReader !== true
    ) {
      throw new Error(
        "sqlite: server does not support carried reader authorization",
      );
    }
    const paramFields = params === undefined
      ? {}
      : !Array.isArray(params) && unsafeObjectKeyIn(params) !== undefined
      ? { namedParams: Object.entries(params) }
      : { params };
    const result = await this.#client.request<SqliteQueryWireResult>({
      type: "sqlite.query",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      db,
      sql,
      ...paramFields,
      ...(reader === undefined ? {} : { reader }),
    });
    return {
      rows: result.rows.map(sqliteRowFromWire),
      columns: result.columns,
    };
  }

  // No `sqliteExecute` write RPC: writes go through the commit fold (a `sqlite`
  // op inside `transact`), applied atomically with cell ops — never a standalone
  // non-atomic write request.

  /**
   * Register an injected on-disk SQLite source (Phase 7, read-only v1). After
   * this, server-side reads for `id` resolve against the on-disk file at `path`
   * (attached read-only) instead of the cell-derived db; writes are rejected.
   */
  async registerSqliteDiskSource(
    id: string,
    path: string,
    beforeIssue?: () => void,
  ): Promise<SqliteRegisterDiskSourceResult> {
    await this.#ensureSessionRestored();
    const requestId = crypto.randomUUID();
    beforeIssue?.();
    return await this.#client.request<SqliteRegisterDiskSourceResult>({
      type: "sqlite.register-disk-source",
      requestId,
      space: this.space,
      sessionId: this.#sessionId,
      id,
      path,
    });
  }

  async watchSet(watches: WatchSpec[]): Promise<WatchView> {
    this.#assertOpen();
    const hadView = this.#watchView !== null;
    const result = await this.watchSetSync(watches);
    if (hadView && !isEmptySync(result.sync)) {
      result.view.emit(result.sync);
    }
    return result.view;
  }

  /** Replaces watches, or replays the owned set after queued changes apply. */
  async watchSetSync(
    watches: WatchSpec[] | undefined,
    holdings?: SessionHolding[],
    views?: ViewInterest[],
  ): Promise<WatchMutationResult> {
    this.#assertOpen();
    if (
      (views?.length ?? 0) > 0 &&
      this.#client.serverFlags?.viewScopedReplicationV1 !== true
    ) {
      throw new Error("Server does not support view-scoped replication");
    }
    const viewIntentVersion = views === undefined
      ? undefined
      : ++this.#viewIntentVersion;
    if (views !== undefined) {
      this.#viewInterests = views;
      this.#viewsDirty = true;
    }
    let requestedWatches: WatchSpec[];
    return await this.#runWatchMutation(
      () => {
        requestedWatches = watches ?? this.#watchSpecs;
        return this.#client.request<WatchSetResult>({
          type: "session.watch.set",
          requestId: crypto.randomUUID(),
          space: this.space,
          sessionId: this.#sessionId,
          watches: requestedWatches,
          ...(views === undefined ? {} : { views }),
          ...(holdings !== undefined ? { holdings } : {}),
        });
      },
      (result) => {
        this.#noteResult(result.serverSeq);
        this.#replaceWatchSpecs(requestedWatches);
        if (viewIntentVersion === this.#viewIntentVersion) {
          this.#viewsDirty = false;
        }
        this.#noteOperationWatchCursors(result.sync);
        if (this.#watchView === null) {
          this.#watchView = WatchView.fromSync(result.sync);
        } else {
          this.#watchView.applySync(result.sync, false);
        }
        this.#scheduleAck(result.serverSeq);
        return {
          view: this.#watchView,
          precedingSyncs: this.#takePrecedingWatchSyncs(),
          sync: result.sync,
        };
      },
      watches === undefined ? "apply" : "issue",
    );
  }

  /** Observes a reconnect that cannot retain the view protocol. */
  subscribeViewCapabilityLost(observer: () => void): () => void {
    this.#viewCapabilityLostObservers.add(observer);
    return () => this.#viewCapabilityLostObservers.delete(observer);
  }

  /**
   * Observes an authoritative loss of this session's access. A permanent
   * denial is replayed synchronously to late observers; normal closure,
   * takeover, and transient connection failures do not report access loss.
   */
  subscribeAccessLoss(observer: (error: Error) => void): () => void {
    if (isPermanentAuthorizationError(this.#closeError)) {
      observer(this.#closeError!);
      return () => {};
    }
    if (this.#closed) return () => {};
    this.#accessLossObservers.add(observer);
    return () => this.#accessLossObservers.delete(observer);
  }

  /**
   * Replaces renderer interests independently from ordinary explicit watches.
   * `consume` integrates the result synchronously in watch-mutation order,
   * before a later mutation can read holdings or apply its response.
   */
  async viewSetSync(
    views: ViewInterest[],
    consume?: (result: WatchMutationResult) => void,
  ): Promise<WatchMutationResult> {
    this.#assertOpen();
    if (
      views.length > 0 &&
      this.#client.serverFlags?.viewScopedReplicationV1 !== true
    ) {
      throw new Error("Server does not support view-scoped replication");
    }
    // Record desired ownership before queueing the request. Reconnect can
    // restore while an older watch mutation still holds the send queue.
    this.#viewInterests = views;
    this.#viewsDirty = true;
    const viewIntentVersion = ++this.#viewIntentVersion;
    return await this.#runWatchMutation(
      () => {
        const holdings = this.#client.serverFlags?.sessionHoldings === true
          ? this.#declaredHoldings()
          : undefined;
        return this.#client.request<WatchSetResult>({
          type: "session.watch.set",
          requestId: crypto.randomUUID(),
          space: this.space,
          sessionId: this.#sessionId,
          watches: this.#watchSpecs,
          views,
          ...(holdings === undefined ? {} : { holdings }),
        });
      },
      (result) => {
        if (viewIntentVersion === this.#viewIntentVersion) {
          this.#viewsDirty = false;
        }
        this.#noteResult(result.serverSeq);
        this.#noteOperationWatchCursors(result.sync);
        if (this.#watchView === null) {
          this.#watchView = WatchView.fromSync(result.sync);
        } else this.#watchView.applySync(result.sync, false);
        this.#scheduleAck(result.serverSeq);
        const mutation = {
          view: this.#watchView,
          precedingSyncs: this.#takePrecedingWatchSyncs(),
          sync: result.sync,
        };
        consume?.(mutation);
        return mutation;
      },
      "apply",
    );
  }

  async watchAdd(watches: WatchSpec[]): Promise<WatchView> {
    this.#assertOpen();
    const hadView = this.#watchView !== null;
    const result = await this.watchAddSync(watches);
    if (hadView && !isEmptySync(result.sync)) {
      result.view.emit(result.sync);
    }
    return result.view;
  }

  async watchAddSync(watches: WatchSpec[]): Promise<WatchMutationResult> {
    this.#assertOpen();
    return await this.#runWatchMutation(
      async () => {
        const requestStart = performance.now();
        const result = await this.#client.request<WatchAddResult>({
          type: "session.watch.add",
          requestId: crypto.randomUUID(),
          space: this.space,
          sessionId: this.#sessionId,
          watches,
        });
        logger.time(requestStart, "watchAdd", "request");
        return result;
      },
      (result) => {
        const applyStart = performance.now();
        this.#noteResult(result.serverSeq);
        if (this.#watchSpecPositions.size !== this.#watchSpecs.length) {
          this.#replaceWatchSpecs([
            ...new Map(this.#watchSpecs.map((watch) => [watch.id, watch]))
              .values(),
          ]);
        }
        for (const watch of watches) {
          const positions = this.#watchSpecPositions.get(watch.id);
          if (positions !== undefined) this.#watchSpecs[positions[0]] = watch;
          else {
            this.#watchSpecPositions.set(watch.id, [this.#watchSpecs.length]);
            this.#watchSpecs.push(watch);
          }
        }
        this.#noteOperationWatchCursors(result.sync);
        if (this.#watchView === null) {
          this.#watchView = WatchView.fromSync(result.sync);
        } else {
          this.#watchView.applySync(result.sync, false);
        }
        this.#scheduleAck(result.serverSeq);
        const mutation = {
          view: this.#watchView,
          precedingSyncs: this.#takePrecedingWatchSyncs(),
          sync: result.sync,
        };
        logger.time(applyStart, "watchAdd", "apply");
        return mutation;
      },
    );
  }

  /**
   * Removes watches from both the live session and reconnect intent, retaining
   * unrelated watches acquired by preceding mutations during concurrent refresh.
   */
  async watchRemoveSync(
    watchIds: readonly string[],
  ): Promise<WatchMutationResult> {
    const removed = new Set(watchIds);
    return await this.#runWatchMutation(
      () => {
        // Cancellation is local intent even when the request fails: a later
        // reconnect must not restore a watch its last subscriber removed.
        const watches = this.#watchSpecs.filter((watch) =>
          !removed.has(watch.id)
        );
        this.#replaceWatchSpecs(watches);
        return this.#client.request<WatchSetResult>({
          type: "session.watch.set",
          requestId: crypto.randomUUID(),
          space: this.space,
          sessionId: this.#sessionId,
          watches,
        });
      },
      (result) => {
        this.#noteResult(result.serverSeq);
        this.#noteOperationWatchCursors(result.sync);
        if (this.#watchView === null) {
          this.#watchView = WatchView.fromSync(result.sync);
        } else {
          this.#watchView.applySync(result.sync, false);
        }
        this.#scheduleAck(result.serverSeq);
        return {
          view: this.#watchView,
          precedingSyncs: this.#takePrecedingWatchSyncs(),
          sync: result.sync,
        };
      },
      "apply",
    );
  }

  async ack(seenSeq: number): Promise<void> {
    if (this.#closed) {
      return;
    }
    if (!this.#client.isConnected() || seenSeq <= this.#ackedSeq) {
      this.#ackedSeq = Math.max(this.#ackedSeq, seenSeq);
      return;
    }
    await this.#client.request({
      type: "session.ack",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      seenSeq,
    });
    this.#ackedSeq = Math.max(this.#ackedSeq, seenSeq);
  }

  handleEffect(effect: SessionSync): void {
    if (this.#closed) {
      return;
    }
    this.#noteResult(effect.toSeq);
    this.#noteOperationWatchCursors(effect);
    if (this.#watchView === null) {
      this.#watchView = WatchView.fromSync(effect);
      this.#precedingWatchSyncs.push(effect);
    } else if (this.#precedingWatchSyncs.length > 0) {
      this.#watchView.applySync(effect, false);
      this.#precedingWatchSyncs.push(effect);
    } else {
      this.#watchView.applySync(effect, true);
    }
    this.#scheduleAck(effect.toSeq);
    this.#noteCaughtUpLocalSeq(effect.caughtUpLocalSeq);
  }

  /** Waits for session authentication and watch restoration on this connection. */
  async whenRestored(): Promise<void> {
    this.#assertOpen();
    await this.#restoreComplete?.promise;
  }

  async restore(): Promise<void> {
    if (this.#closed) {
      return;
    }
    if (
      this.holdingsProvider !== undefined &&
      this.#client.serverFlags?.sessionHoldings !== true
    ) {
      // A consumer that installed a holdings provider relies on the
      // declaration for reconnect correctness: without it, a resume is
      // diffed against the server's memory of the session — which can
      // elide a document the replica lost — and a re-establishment
      // re-downloads the whole union. Against a server that cannot take
      // the declaration, restoring would silently reintroduce both, so
      // the session fails here, loudly, with the cause. The initial
      // connection is unaffected: nothing was held, so nothing needed
      // declaring.
      this.#terminateSession(
        new Error(
          "memory session cannot be restored: the server does not " +
            "advertise sessionHoldings, so the replica's declared " +
            "holdings cannot be the reconnect's delivery base",
        ),
      );
      return;
    }
    if (this.#restoreComplete === undefined) {
      this.#restoreComplete = Promise.withResolvers<void>();
      // Session closure rejects this barrier even if no consumer is waiting.
      this.#restoreComplete.promise.catch(() => {});
    }
    if (
      this.#client.serverFlags?.viewScopedReplicationV1 !== true &&
      (this.#viewInterests.length > 0 || this.#viewsDirty)
    ) {
      this.#viewInterests = [];
      this.#viewIntentVersion++;
      this.#viewsDirty = true;
      for (const observer of this.#viewCapabilityLostObservers) observer();
    }
    this.#restoring = true;
    this.#readyOnConnection = false;
    let replayedThroughLocalSeq = 0;
    try {
      let restored: SessionOpenResult;
      try {
        restored = await this.#reopen();
      } catch (error) {
        if (isSessionRevokedError(error)) {
          this.handleRevoked("taken-over");
          return;
        }
        throw error;
      }
      if (this.#closed) {
        return;
      }
      this.#readyOnConnection = true;
      replayedThroughLocalSeq = Math.max(
        0,
        ...this.#outstandingCommits.keys(),
      );
      const replayTasks = [...this.#outstandingCommits.entries()].map((
        [localSeq, pendingCommit],
      ) =>
        this.#sendOutstandingCommit(localSeq, pendingCommit, {
          throwOnConnectionError: true,
        })
      );
      if (restored.sync) {
        this.#noteCaughtUpLocalSeq(restored.sync.caughtUpLocalSeq);
        this.#noteOperationWatchCursors(restored.sync);
        if (this.#watchView === null) {
          this.#watchView = WatchView.fromSync(restored.sync);
        } else {
          this.#watchView.applySync(restored.sync, false);
        }
        if (
          !isEmptySync(restored.sync) ||
          restored.sync.caughtUpLocalSeq !== undefined
        ) {
          this.#watchView.emit(restored.sync);
          if (restored.sync.caughtUpLocalSeq !== undefined) {
            this.#forwardedCaughtUpLocalSeq = Math.max(
              this.#forwardedCaughtUpLocalSeq,
              restored.sync.caughtUpLocalSeq,
            );
          }
        }
        this.#scheduleAck(restored.serverSeq);
      } else if (restored.resumed === true && this.#watchSpecs.length > 0) {
        this.#scheduleAck(restored.serverSeq);
      }
      this.#noteCaughtUpLocalSeq(restored.caughtUpLocalSeq);
      // Forward a top-level-only caught-up marker (resume with no sync) to
      // WatchView subscribers; the guard above suppresses a duplicate when a
      // real sync already carried it.
      this.#forwardCaughtUpLocalSeqToWatchers(restored.caughtUpLocalSeq);
      if (
        this.#viewsDirty ||
        (restored.resumed !== true &&
          (this.#watchSpecs.length > 0 || this.#viewInterests.length > 0))
      ) {
        // The server forgot this session (or never had it): re-establish
        // the watch set, declaring what the replica still holds so the
        // response carries the difference rather than the whole union.
        const { view, sync } = await this.watchSetSync(
          undefined,
          this.#declaredHoldings(),
          this.#viewsDirty || this.#viewInterests.length > 0
            ? this.#viewInterests
            : undefined,
        );
        if (!isEmptySync(sync)) {
          view.emit(sync);
        }
      }
      await Promise.all(replayTasks);
      this.#restoreComplete?.resolve();
      this.#restoreComplete = undefined;
    } catch (error) {
      // A permanent authorization denial ANYWHERE in the reopen — the initial
      // session.open OR the watch re-establishment (watchSetSync) that follows a
      // fresh, non-resumed session — terminates just this session with the real
      // error: its pending commits and waiters reject with it, and its next watch
      // or transact rethrows it. It must NOT propagate to the client-wide
      // reconnect loop, which would then fail sessions for other spaces on the
      // same client. Every other error propagates so the loop retries it.
      if (isPermanentAuthorizationError(error)) {
        this.#terminateSession(error as Error);
        return;
      }
      throw error;
    } finally {
      this.#restoring = false;
      if (!this.#closed && this.#outstandingCommits.size > 0) {
        this.#replayOutstandingCommits(replayedThroughLocalSeq);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#closeError = new Error("memory session closed");
    this.#restoreComplete?.reject(this.#closeError);
    this.#restoreComplete = undefined;
    this.#readyOnConnection = false;
    this.#client.forgetSession(this);
    this.#rejectCaughtUpLocalSeqWaiters(this.#closeError);
    const background = [...this.#background];
    this.#background.clear();
    await Promise.allSettled(background);
    for (const pending of this.#outstandingCommits.values()) {
      pending.pending.reject(new Error("memory session closed"));
    }
    this.#outstandingCommits.clear();
    this.#replaceWatchSpecs([]);
    this.#viewInterests = [];
    this.#viewCapabilityLostObservers.clear();
    this.#accessLossObservers.clear();
    this.#watchView?.close();
    this.#watchView = null;
  }

  handleRevoked(reason: SessionRevokedMessage["reason"]): void {
    if (this.#closed) {
      return;
    }
    const error = new Error(`memory session revoked: ${reason}`);
    error.name = reason === "unauthorized"
      ? "AuthorizationError"
      : "SessionRevokedError";
    this.#terminateSession(error);
  }

  /**
   * Close this session terminally with `error`: reject its outstanding commits
   * and caught-up waiters, forget it from the client, and drop its watch state.
   * The stored error is what `#assertOpen()` rethrows for any later call, so a
   * storage subscriber observes the real cause on its next watch or transact.
   * Shared by session revocation, a permanent reopen authorization denial,
   * a restore against a server that cannot take declared holdings, and
   * a permanent connection failure.
   */
  #terminateSession(error: Error): void {
    this.#closed = true;
    this.#closeError = error;
    this.#restoreComplete?.reject(error);
    this.#restoreComplete = undefined;
    this.#readyOnConnection = false;
    this.#client.forgetSession(this);
    for (const pending of this.#outstandingCommits.values()) {
      pending.pending.reject(error);
    }
    this.#rejectCaughtUpLocalSeqWaiters(error);
    this.#outstandingCommits.clear();
    this.#replaceWatchSpecs([]);
    this.#viewInterests = [];
    this.#viewCapabilityLostObservers.clear();
    this.#watchView?.close();
    this.#watchView = null;
    const observers = [...this.#accessLossObservers];
    this.#accessLossObservers.clear();
    if (isPermanentAuthorizationError(error)) {
      for (const observer of observers) observer(error);
    }
  }

  /** Terminates the session when its client cannot restore the connection. */
  handleConnectionFailure(error: Error): void {
    if (this.#closed) return;
    this.#terminateSession(error);
  }

  handleDisconnect(): void {
    if (this.#closed) {
      return;
    }
    this.#readyOnConnection = false;
  }

  #queueBackground(task: Promise<void>): void {
    const tracked = task
      .catch(() => undefined)
      .finally(() => this.#background.delete(tracked));
    this.#background.add(tracked);
  }

  #scheduleAck(seenSeq: number): void {
    if (this.#closed) {
      return;
    }
    this.#pendingAckSeq = Math.max(this.#pendingAckSeq, seenSeq);
    if (this.#ackScheduled || this.#ackFlushing) {
      return;
    }
    this.#ackScheduled = true;
    this.#queueBackground(
      (async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        this.#ackScheduled = false;
        this.#ackFlushing = true;
        try {
          await this.#flushScheduledAcks();
        } finally {
          this.#ackFlushing = false;
          if (
            this.#pendingAckSeq > this.#ackedSeq &&
            !this.#closed &&
            this.#client.isConnected()
          ) {
            this.#scheduleAck(this.#pendingAckSeq);
          }
        }
      })(),
    );
  }

  async #flushScheduledAcks(): Promise<void> {
    while (true) {
      const target = this.#pendingAckSeq;
      if (
        this.#closed || target <= this.#ackedSeq || !this.#client.isConnected()
      ) {
        this.#ackedSeq = Math.max(this.#ackedSeq, target);
        return;
      }
      await this.#client.request({
        type: "session.ack",
        requestId: crypto.randomUUID(),
        space: this.space,
        sessionId: this.#sessionId,
        seenSeq: target,
      });
      this.#ackedSeq = Math.max(this.#ackedSeq, target);
      if (this.#pendingAckSeq <= this.#ackedSeq) {
        return;
      }
    }
  }

  /**
   * Enable/disable concurrent watch refresh for THIS session (default off).
   * Set by the runner from the `experimentalConcurrentWatchRefresh` storage
   * setting. Per-session by design — no process global — so one storage
   * manager's choice never leaks to another client in the same process.
   */
  setConcurrentWatchRefresh(enabled: boolean): void {
    this.#concurrentWatchRefresh = enabled;
  }

  #takePrecedingWatchSyncs(): SessionSync[] {
    const syncs = this.#precedingWatchSyncs;
    this.#precedingWatchSyncs = [];
    // Effects can arrive between request issue and response application. They
    // were observed against the old watch spec, so replay their operation
    // cursors after the mutation has installed the new spec as well.
    for (const sync of syncs) this.#noteOperationWatchCursors(sync);
    return syncs;
  }

  /**
   * Serialize a watch mutation (`watch.set` / `watch.add`). `send` issues the
   * request; `apply` mutates the session view (`#watchSpecs` / `#watchView`)
   * from the response. Splitting them lets concurrent mode overlap the request
   * round trips while keeping application ordered. A mutation whose request is
   * derived from session state (`watchRemoveSync`) passes `sendAfter: "apply"`,
   * which also holds `send` until every preceding response has been applied;
   * it still claims its place in issue order, so later mutations wait behind
   * it.
   */
  async #runWatchMutation<R, T>(
    send: () => Promise<R>,
    apply: (result: R) => T,
    sendAfter: "issue" | "apply" = "issue",
  ): Promise<T> {
    this.#assertOpen();
    if (!this.#concurrentWatchRefresh) {
      // Single-flight (default): send + apply run together, chained on the
      // prior mutation's completion. Nothing is issued until the previous
      // mutation fully resolves. `apply` runs in the microtask cascade
      // rooted at the response frame's delivery, and one-frame-per-turn
      // transports (loopback included) cannot deliver a later effect frame
      // until that cascade completes — so no handleEffect can mutate the
      // watch view between the response resolving and `apply` running.
      const previous = this.#watchApply;
      const current = previous.catch(() => undefined).then(async () =>
        apply(await send())
      );
      this.#watchApply = current.then(() => undefined, () => undefined);
      return await current;
    }
    // Concurrent: preserve wire order across the WHOLE watch-mutation family
    // (set + add) by issuing requests in call order, while applying responses
    // in that same order.
    //  - `#watchIssue` advances as soon as `send()` has been called (its frame
    //    scheduled ahead of the next mutation's), so an earlier `watch.set` can
    //    never be overtaken on the wire by a later `watch.add`.
    //  - the apply step waits for [prior apply, this response], so `#watchSpecs`
    //    / `#watchView` mutate in call order regardless of which response lands
    //    first.
    const previousApply = this.#watchApply;
    // A removal derives a full replacement set from `#watchSpecs`, so its
    // send must see earlier acquisitions applied. Reserve its place in the
    // issue chain while waiting, keeping later acquisitions behind it.
    const readyToIssue = sendAfter === "apply"
      ? Promise.all([this.#watchIssue, previousApply])
      : this.#watchIssue;
    let response!: Promise<R>;
    const issued = readyToIssue.catch(() => undefined).then(() => {
      response = send();
      // Attach a rejection handler immediately: a later request may reject
      // while an earlier mutation is still pending, which would otherwise
      // surface as an unhandled rejection even though the caller-facing
      // apply-chain promise below has its own catch.
      response.catch(() => undefined);
    });
    this.#watchIssue = issued.then(() => undefined, () => undefined);

    const current = Promise.all([
      previousApply.catch(() => undefined),
      issued,
    ]).then(() => response).then((result) => apply(result));
    this.#watchApply = current.then(() => undefined, () => undefined);
    return await current;
  }

  #noteResult(serverSeq: number): void {
    this.#serverSeq = Math.max(this.#serverSeq, serverSeq);
  }

  #noteOperationWatchCursors(sync: SessionSync): void {
    if ((sync.operationFields?.length ?? 0) === 0) return;
    const delivered = new Map(
      sync.operationFields!.map((delivery) =>
        [
          delivery.watchId,
          delivery.field.cursor,
        ] as const
      ),
    );
    for (const [id, cursor] of delivered) {
      for (const position of this.#watchSpecPositions.get(id) ?? []) {
        const watch = this.#watchSpecs[position];
        if (watch.kind !== "operation") continue;
        const query = { ...watch.query };
        if (cursor === null) delete query.after;
        else if (cursor !== undefined) query.after = cursor;
        this.#watchSpecs[position] = { ...watch, query };
      }
    }
  }

  /** Replaces reconnect intent and indexes every accepted list position. */
  #replaceWatchSpecs(watches: readonly WatchSpec[]): void {
    this.#watchSpecs = [...watches];
    this.#watchSpecPositions = new Map();
    for (let position = 0; position < watches.length; position++) {
      const id = watches[position].id;
      const positions = this.#watchSpecPositions.get(id);
      if (positions === undefined) this.#watchSpecPositions.set(id, [position]);
      else positions.push(position);
    }
  }

  #noteCaughtUpLocalSeq(localSeq: number | undefined): void {
    if (localSeq === undefined) {
      return;
    }
    this.#caughtUpLocalSeq = Math.max(this.#caughtUpLocalSeq, localSeq);
    const ready: PromiseWithResolvers<void>[] = [];
    this.#caughtUpLocalSeqWaiters = this.#caughtUpLocalSeqWaiters.filter(
      (waiter) => {
        if (waiter.localSeq <= this.#caughtUpLocalSeq) {
          ready.push(waiter.pending);
          return false;
        }
        return true;
      },
    );
    for (const pending of ready) {
      pending.resolve();
    }
  }

  /**
   * Forwards a caught-up marker to `WatchView` subscribers when it was
   * delivered out-of-band (the top-level `SessionOpenResult.caughtUpLocalSeq`
   * on resume) rather than via a sync they already observed. Emits an empty
   * caught-up sync so downstream waiters (notably runner storage's read-repair
   * gate) resolve instead of stranding after a reconnect.
   */
  #forwardCaughtUpLocalSeqToWatchers(
    localSeq: number | undefined,
  ): void {
    if (
      localSeq === undefined ||
      localSeq <= this.#forwardedCaughtUpLocalSeq ||
      this.#watchView === null
    ) {
      return;
    }
    this.#forwardedCaughtUpLocalSeq = localSeq;
    this.#watchView.emit({
      type: "sync",
      fromSeq: this.#serverSeq,
      toSeq: this.#serverSeq,
      caughtUpLocalSeq: localSeq,
      upserts: [],
      removes: [],
    });
  }

  #waitForCaughtUpLocalSeq(localSeq: number): Promise<void> {
    if (this.#closed) {
      return Promise.reject(
        this.#closeError ?? new Error("memory session closed"),
      );
    }
    if (this.#caughtUpLocalSeq >= localSeq) {
      return Promise.resolve();
    }
    const pending = Promise.withResolvers<void>();
    this.#caughtUpLocalSeqWaiters.push({ localSeq, pending });
    return pending.promise;
  }

  #rejectCaughtUpLocalSeqWaiters(error: Error | null): void {
    const waiters = this.#caughtUpLocalSeqWaiters;
    this.#caughtUpLocalSeqWaiters = [];
    for (const waiter of waiters) {
      waiter.pending.reject(error ?? new Error("memory session closed"));
    }
  }

  /** The consumer's current delivery base for reconnects and view changes. */
  #declaredHoldings(): SessionHolding[] | undefined {
    return this.holdingsProvider?.();
  }

  async #reopen(): Promise<SessionOpenResult> {
    const oldSessionId = this.#sessionId;
    const session = {
      ...(this.#genesisRoot === undefined
        ? {}
        : { genesisRoot: this.#genesisRoot }),
      sessionId: this.#sessionId,
      seenSeq: this.#serverSeq,
      sessionToken: this.#sessionToken,
      // The delegated READ binding survives a route replacement (OW31):
      // a reopen without it would silently drop to envelope-only READ.
      ...(this.#actingAs !== undefined ? { actingAs: this.#actingAs } : {}),
      // The server takes a session's ceiling from the descriptor of its
      // LAST open: a reopen without it would leave the session reading
      // unbounded from the first dropped connection on.
      ...(this.#readCeiling !== undefined
        ? { readCeiling: this.#readCeiling }
        : {}),
    };
    const auth = await runWithAbortSignal(
      this.#routeSignal,
      "memory session route cancelled",
      () =>
        this.#openAuthFactory?.(
          this.space,
          session,
          this.#client.sessionOpenAuthContext(),
        ),
    );
    const holdings = this.#declaredHoldings();
    const restored = await runWithAbortSignal(
      this.#routeSignal,
      "memory session route cancelled",
      () => this.#client.openSession(this.space, session, auth, holdings),
    );
    const sessionChanged = restored.sessionId !== oldSessionId;
    const sessionReplaced = sessionChanged || restored.resumed !== true;
    this.#sessionId = restored.sessionId;
    this.#sessionToken = restored.sessionToken ?? this.#sessionToken;
    this.#noteResult(restored.serverSeq);

    if (sessionReplaced) {
      const sessionChangedError = new Error(
        sessionChanged
          ? `session changed: ${oldSessionId} -> ${restored.sessionId}`
          : `session replaced without resume: ${restored.sessionId}`,
      );
      if (sessionChanged) {
        for (const pending of this.#outstandingCommits.values()) {
          pending.pending.reject(sessionChangedError);
        }
        this.#outstandingCommits.clear();
      }
      this.#caughtUpLocalSeq = 0;
      this.#forwardedCaughtUpLocalSeq = 0;
      // An unforwarded effect belongs to the retired session's delivery
      // epoch. A replacement establishes its own watch state and must not
      // apply that effect as though the new session delivered it.
      this.#precedingWatchSyncs = [];
      this.#rejectCaughtUpLocalSeqWaiters(sessionChangedError);
      // The marker epoch died with the old session: obligations it staged
      // are gone, and the fresh session's markers know nothing of the old
      // localSeqs. Consumers holding marker-keyed state (the runner's
      // parked accepted promotions, CT-1927) must reconcile now rather
      // than wait for markers that can never arrive.
      this.onSessionReplaced?.();
    }
    this.#noteCaughtUpLocalSeq(restored.caughtUpLocalSeq);

    return restored;
  }

  #replayOutstandingCommits(minLocalSeqExclusive = 0): void {
    if (
      this.#outstandingCommits.size === 0 ||
      !this.#readyOnConnection ||
      !this.#client.isConnected()
    ) {
      return;
    }
    for (
      const [localSeq, pendingCommit] of this.#outstandingCommits.entries()
    ) {
      if (localSeq <= minLocalSeqExclusive) {
        continue;
      }
      this.#sendOutstandingCommit(localSeq, pendingCommit);
    }
  }

  #sendOutstandingCommit(
    localSeq: number,
    pendingCommit: {
      commit: ClientCommit;
      pending: PromiseWithResolvers<AppliedCommit>;
    },
    options: {
      throwOnConnectionError?: boolean;
    } = {},
  ): Promise<void> {
    const task = (async () => {
      if (
        this.#closed ||
        !this.#readyOnConnection ||
        !this.#client.isConnected()
      ) {
        return;
      }

      try {
        const applied = await this.#client.request<AppliedCommit>({
          type: "transact",
          requestId: crypto.randomUUID(),
          space: this.space,
          sessionId: this.#sessionId,
          commit: pendingCommit.commit,
        });
        this.#noteResult(applied.seq);
        if (this.#outstandingCommits.get(localSeq) === pendingCommit) {
          this.#outstandingCommits.delete(localSeq);
        }
        pendingCommit.pending.resolve(applied);
        if (!this.#closed) {
          void this.ack(applied.seq).catch(() => undefined);
        }
      } catch (error) {
        if (isConnectionError(error) || isSessionRevokedError(error)) {
          if (options.throwOnConnectionError) {
            throw error;
          }
          return;
        }
        if (this.#outstandingCommits.get(localSeq) === pendingCommit) {
          this.#outstandingCommits.delete(localSeq);
        }
        if (isRetryableConflict(error)) {
          error.readyToRetry = () => this.#waitForCaughtUpLocalSeq(localSeq);
        }
        pendingCommit.pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    })();
    this.#queueBackground(task);
    return task;
  }
}

type RetryableConflictError = Error & {
  name: "ConflictError";
  retryAfterSeq: number;
  readyToRetry?: () => Promise<void>;
};

function isRetryableConflict(error: unknown): error is RetryableConflictError {
  return error instanceof Error && error.name === "ConflictError" &&
    typeof (error as { retryAfterSeq?: unknown }).retryAfterSeq === "number";
}

export class WatchView {
  #queue: GraphQueryResult[] = [];
  #pending = new Set<PromiseWithResolvers<IteratorResult<GraphQueryResult>>>();
  #subscribers = 0;
  #syncQueue: SessionSync[] = [];
  #syncPending = new Set<PromiseWithResolvers<IteratorResult<SessionSync>>>();
  #entities = new Map<string, EntitySnapshot>();
  #orderedEntitiesCache: EntitySnapshot[] | null = null;
  #closed = false;
  #serverSeq = 0;

  static fromSync(sync: SessionSync): WatchView {
    const view = new WatchView();
    view.applySync(sync, false);
    return view;
  }

  get entities(): EntitySnapshot[] {
    return [...this.#orderedEntities()];
  }

  get serverSeq(): number {
    return this.#serverSeq;
  }

  subscribe(): AsyncIterator<GraphQueryResult> {
    this.#subscribers += 1;
    let active = true;
    const iteratorPending = new Set<
      PromiseWithResolvers<IteratorResult<GraphQueryResult>>
    >();
    return {
      next: async () => {
        if (this.#closed || !active) {
          return {
            done: true,
            value: undefined as never,
          };
        }
        const queued = this.#queue.shift();
        if (queued) {
          return { done: false, value: queued };
        }
        const pending = Promise.withResolvers<
          IteratorResult<GraphQueryResult>
        >();
        this.#pending.add(pending);
        iteratorPending.add(pending);
        try {
          return await pending.promise;
        } finally {
          iteratorPending.delete(pending);
        }
      },
      return: () => {
        if (active) {
          active = false;
          this.#subscribers = Math.max(0, this.#subscribers - 1);
        }
        for (const pending of iteratorPending) {
          this.#pending.delete(pending);
          pending.resolve({
            done: true,
            value: undefined as never,
          });
        }
        iteratorPending.clear();
        return Promise.resolve({
          done: true,
          value: undefined as never,
        });
      },
    };
  }

  applySync(sync: SessionSync, emit: boolean): void {
    const upserts = new Map<string, EntitySnapshot>();
    for (const upsert of sync.upserts) {
      upserts.set(
        watchKey(upsert.branch, upsert.id, upsert.scope, upsert.scopeKey),
        {
          branch: upsert.branch,
          id: upsert.id,
          ...(upsert.scope !== undefined ? { scope: upsert.scope } : {}),
          ...(upsert.scopeKey !== undefined
            ? { scopeKey: upsert.scopeKey }
            : {}),
          seq: upsert.seq,
          document: upsert.doc ?? null,
          // `upsert.coverClass` is deliberately NOT cached here: no
          // WatchView consumer reads it (the arrival-witness predicate's
          // consumer is the runner replica's confirmed record, which
          // integrates frames directly), and a correct cache would need
          // the replica's same-seq-preserve rule — a classless refresh
          // snapshot would otherwise CLEAR a known class. Dead weight
          // until a real consumer arrives with the rule.
        },
      );
    }

    const removeKeys = new Set<string>();
    for (const remove of sync.removes) {
      const key = watchKey(
        remove.branch,
        remove.id,
        remove.scope,
        remove.scopeKey,
      );
      removeKeys.add(key);
    }

    let changedEntities = false;
    for (const [key, entity] of upserts) {
      if (!removeKeys.has(key)) {
        this.#entities.set(key, entity);
        changedEntities = true;
      }
    }

    for (const key of removeKeys) {
      changedEntities = this.#entities.delete(key) || changedEntities;
    }

    if (changedEntities) {
      this.#orderedEntitiesCache = null;
    }

    this.#serverSeq = Math.max(this.#serverSeq, sync.toSeq);
    if (emit) {
      this.emit(sync);
    }
  }

  emit(sync: SessionSync): void {
    this.pushSync(sync);
    if (
      this.#subscribers > 0 || this.#pending.size > 0 || this.#queue.length > 0
    ) {
      this.push(this.snapshot());
    }
  }

  snapshot(): GraphQueryResult {
    return {
      serverSeq: this.#serverSeq,
      entities: [...this.#orderedEntities()],
    };
  }

  subscribeSync(): AsyncIterator<SessionSync> {
    return {
      next: async () => {
        if (this.#closed) {
          return {
            done: true,
            value: undefined as never,
          };
        }
        const queued = this.#syncQueue.shift();
        if (queued) {
          return { done: false, value: queued };
        }
        const pending = Promise.withResolvers<IteratorResult<SessionSync>>();
        this.#syncPending.add(pending);
        return await pending.promise;
      },
    };
  }

  push(result: GraphQueryResult): void {
    if (this.#closed) {
      return;
    }
    const pending = this.#pending.values().next().value;
    if (pending) {
      this.#pending.delete(pending);
      pending.resolve({ done: false, value: result });
      return;
    }
    this.#queue.push(result);
  }

  pushSync(sync: SessionSync): void {
    if (this.#closed) {
      return;
    }
    const pending = this.#syncPending.values().next().value;
    if (pending) {
      this.#syncPending.delete(pending);
      pending.resolve({ done: false, value: sync });
      return;
    }
    this.#syncQueue.push(sync);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const pending of this.#pending) {
      pending.resolve({
        done: true,
        value: undefined as never,
      });
    }
    this.#pending.clear();
    this.#subscribers = 0;
    for (const pending of this.#syncPending) {
      pending.resolve({
        done: true,
        value: undefined as never,
      });
    }
    this.#syncPending.clear();
    this.#queue = [];
    this.#syncQueue = [];
  }

  #orderedEntities(): EntitySnapshot[] {
    if (this.#orderedEntitiesCache === null) {
      this.#orderedEntitiesCache = [...this.#entities.values()]
        .sort(compareEntitySnapshot);
    }
    return this.#orderedEntitiesCache;
  }
}

export const connect = Client.connect;

// Loopback delivers server frames on EVENT LOOP turns, one frame per
// turn, like a socket: no response or push ever arrives inside the sender's
// own await cascade, so code that accidentally depends on "nothing arrives
// until I yield" fails here the way it would against a deployment. One
// frame per macrotask also guarantees a frame's full microtask cascade
// (response resolution, request() continuation, caller continuation)
// completes before the next frame delivers. Client→server keeps awaiting
// the server's processing: the server's fan-out drain-wait counts a frame
// from receive() entry, and a send that merely enqueued would let fan-out
// read heads that predate a write already handed to the transport. Frames
// staged at close() are dropped — nothing arrives after the socket is
// gone. Remaining fidelity gap: setCloseReceiver is a no-op, so a
// server-initiated disconnect is invisible over loopback.
//
// The pump takes that turn through armTurn, so a queued frame always has an
// armed zero-delay timer for `clock.settle()` to see without the delivery
// itself waiting on one. A posted message is not an option in its place:
// Node's MessageChannel replaces the web one as soon as anything in the
// process loads node compatibility, and its ports deliver inside a microtask
// cascade rather than on a turn of their own.
export const loopback = (server: Server): Transport => {
  let receiver = (_payload: string) => {};
  let closed = false;
  const queue: string[] = [];
  let turn: ArmedTurn | null = null;
  const drainOne = () => {
    turn = null;
    if (closed) return;
    const frame = queue.shift();
    if (frame === undefined) return;
    receiver(frame);
    if (queue.length > 0) schedule();
  };
  const schedule = () => {
    turn ??= armTurn(drainOne);
  };
  const connection = server.connect((message) => {
    if (closed) return;
    queue.push(encodeMemoryBoundary(message));
    schedule();
  });
  return {
    async send(payload: string) {
      await connection.receive(payload);
    },
    close() {
      closed = true;
      turn?.cancel();
      turn = null;
      queue.length = 0;
      connection.close();
      return Promise.resolve();
    },
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver() {},
  };
};

const toConnectionError = (error?: Error): Error => {
  const connectionError = new Error(
    error?.message ?? "memory transport closed",
    error ? { cause: error } : undefined,
  );
  connectionError.name = "ConnectionError";
  return connectionError;
};

const isConnectionError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "ConnectionError" ||
    error.message.includes("transport closed") ||
    error.message.includes("disconnect"));

const protocolError = (message: string): Error => {
  const error = new Error(message);
  error.name = "ProtocolError";
  return error;
};

// A ProtocolError that no retry can heal (the peers disagree on a data-model
// wire contract). Tagged so the reconnect loop gives up rather than retrying it.
const permanentProtocolError = (message: string): Error =>
  Object.assign(new Error(message), { name: "ProtocolError", permanent: true });

// An authorization denial retrying cannot change. A retriable auth failure — an
// anti-replay race the server marked `retriable` (an expired/used/mismatched
// challenge, a stale signed `exp`) — is excluded, so the client keeps reopening
// through a token-refresh window or a challenge race a fresh handshake heals.
const isPermanentAuthorizationError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AuthorizationError" &&
  (error as { retriable?: unknown }).retriable !== true;

// A reconnect handshake failure the whole client must give up on rather than
// retry: an incompatible protocol negotiation at hello. An authorization denial
// is deliberately NOT here — it is per-space, handled inside restore() by
// terminating just that session, so it never escalates to a client-wide failure
// that would take down sessions for other spaces.
const isPermanentConnectionFailure = (error: Error): boolean =>
  (error as { permanent?: unknown }).permanent === true;

const requireSessionOpenAuthMetadata = (
  value: unknown,
): SessionOpenAuthMetadata => {
  if (value === undefined) {
    throw protocolError(
      "memory server did not provide session.open authentication metadata",
    );
  }
  if (!isObjectNotArray(value)) {
    throw protocolError(
      "memory server sent malformed session.open authentication metadata",
    );
  }

  const sessionOpen = value as {
    audience?: unknown;
    challenge?: unknown;
  };
  if (sessionOpen.challenge === undefined) {
    throw protocolError(
      "memory server did not provide a session.open challenge",
    );
  }
  if (sessionOpen.audience === undefined) {
    throw protocolError(
      "memory server did not provide a session.open audience",
    );
  }
  if (typeof sessionOpen.audience !== "string") {
    throw protocolError(
      "memory server sent malformed session.open authentication metadata",
    );
  }
  if (!isObjectNotArray(sessionOpen.challenge)) {
    throw protocolError(
      "memory server sent malformed session.open authentication metadata",
    );
  }
  const challenge = sessionOpen.challenge as {
    value?: unknown;
    expiresAt?: unknown;
  };
  if (
    typeof challenge.value !== "string" ||
    typeof challenge.expiresAt !== "number"
  ) {
    throw protocolError(
      "memory server sent malformed session.open authentication metadata",
    );
  }
  return {
    audience: sessionOpen.audience,
    challenge: {
      value: challenge.value,
      expiresAt: challenge.expiresAt,
    },
  };
};

const parseHelloOk = (
  message: unknown,
): {
  flags: MemoryProtocolFlags;
  sessionOpen?: unknown;
} | null => {
  if (!isPlainObject(message)) {
    return null;
  }
  if (message.type !== "hello.ok" || message.protocol !== MEMORY_PROTOCOL) {
    return null;
  }
  const parsed = parseMemoryProtocolFlags(message.flags);
  if (parsed === null) {
    return null;
  }
  return { flags: parsed, sessionOpen: message.sessionOpen };
};

const isSessionEffect = (
  message: unknown,
): message is SessionEffectMessage => {
  return isPlainObject(message) && message.type === "session/effect";
};

const isSessionRevoked = (
  message: unknown,
): message is SessionRevokedMessage => {
  if (!isPlainObject(message)) return false;
  const { type, space, sessionId, reason } = message;
  return type === "session/revoked" &&
    typeof space === "string" &&
    typeof sessionId === "string" &&
    (reason === "taken-over" || reason === "unauthorized");
};

const isResponse = (message: unknown): message is ResponseMessage<unknown> => {
  return isPlainObject(message) && message.type === "response" &&
    typeof message.requestId === "string";
};

const isEmptySync = (sync: SessionSync): boolean =>
  sync.upserts.length === 0 && sync.removes.length === 0 &&
  (sync.operationFields?.length ?? 0) === 0 && sync.viewPlans === undefined;

const isSessionRevokedError = (error: unknown): boolean =>
  error instanceof Error && error.name === "SessionRevokedError";
