import { isCanonicalEd25519DID } from "@commonfabric/identity";
import type { FabricPlainObject, FabricValue } from "@commonfabric/api";
import { cloneIfNecessary, debugStr } from "@commonfabric/data-model";
import { getLogger } from "@commonfabric/utils/logger";
import { maxOf } from "@commonfabric/utils/math";
import {
  isObjectNotArray,
  isPlainObject,
  unsafeObjectKeyIn,
} from "@commonfabric/utils/types";

import {
  type ClientCommit,
  compatibleMemoryProtocolFlags,
  type ConnectionAuthResult,
  type ConnectionChallengeResult,
  decodeTrustedMemoryBoundary,
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
  type PresenceJoinResult,
  type PresencePublication,
  type PresenceRecord,
  type PresenceRemoveMessage,
  type PresenceUpsertMessage,
  type ResponseMessage,
  type SessionAdmissibleMessage,
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
import { ROUTED_HOLDINGS_LIMIT } from "./routed-limits.ts";
import {
  isPresenceRoom,
  PresenceError,
  validatePresencePublication,
} from "./presence.ts";
import type { Server } from "./server.ts";
import { containsReservedSchemaRefSubstring } from "./sync-schema-ref.ts";
import { expandServerMessageSchemas } from "./sync-schema-table.ts";
import { type ArmedTurn, armTurn } from "./turn.ts";

/**
 * Passed to `SpaceSession.watchSetSync()` by `restore()` alone, marking the
 * watch set a restore re-establishes, which is sent without waiting for its
 * session to reopen. It is not exported, so no other caller can skip that
 * wait.
 */
const RESTORE_WATCH_SET: unique symbol = Symbol("restore watch set");

/**
 * Returned by `Client.#authenticate()` and a signed open's turn when the
 * connection they signed for is gone: the caller waits for the reconnect and
 * signs again.
 */
const STALE: unique symbol = Symbol("stale connection");

/** Thrown inside the shared authentication to settle it as `STALE`. */
const STALE_AUTHENTICATION: unique symbol = Symbol("stale authentication");

/** The error a reopen fails with when the connection drops under it. */
const connectionLostWhileRestoring = (): Error =>
  toConnectionError(
    new Error("memory connection lost while restoring the session"),
  );

const logger = getLogger("memory.v2.client", {
  enabled: true,
  level: "error",
});

export type Transport = {
  /** Whether this transport can exchange negotiated compression envelopes. */
  readonly supportsMessageCompression?: boolean;

  /**
   * Hands `payload` to the connection, opening one first when there is none.
   *
   * Rejects with an error named `ConnectionError` (see `connectionError()`)
   * when the connection was lost or could not be opened before the write was
   * confirmed. The payload may still have reached the peer, so the request
   * has no verdict either way. The client keeps a commit rejected that way
   * for replay on the next connection, so the transport must report the same
   * loss to its close receiver, which starts the reconnect that replays it;
   * `reset()` and `close()` are the exceptions, as the client calls them
   * itself. A transport whose write of this very payload failed on an open
   * connection rejects with `writeFailedError()` instead, so that the client
   * stops replaying a commit whose own write keeps failing. Any other
   * rejection fails the request with that error.
   */
  send(payload: string): Promise<void>;

  close(): Promise<void>;

  /**
   * Discards the current connection without disposing the transport. The next
   * send opens a fresh connection; frames and close callbacks from the
   * discarded one are ignored.
   * Reconnectable transports implement this so a failed session restoration
   * can retry the handshake on a connection that has not accepted `hello`.
   * Without it, a failed reconnect terminates the client with that failure.
   */
  reset?(): void;

  setReceiver(receiver: (payload: string) => void): void;
  setCloseReceiver?(receiver: (error?: Error) => void): void;

  /** Enables compression after a successful capability handshake. */
  setMessageCompressionEnabled?(enabled: boolean): void;

  /** Selects bounded version-2 envelopes after routed authentication negotiation. */
  setRoutedMessagesEnabled?(enabled: boolean): void;

  /**
   * Resolves once every server frame this transport held at the call has been
   * handed to the receiver, and at once when it held none or has closed.
   * Frames that arrive after the call do not extend the wait. A transport
   * that hands each frame over as it arrives holds none and leaves this out.
   */
  delivered?(): Promise<void>;
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

  /** Require the space's sealed declared kind. */
  spaceKind?: string;

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

/**
 * The kind a space's genesis commit declares, as a `session.open` result
 * reported it: `kind` is absent when the genesis commit declares none, or when
 * the server does not advertise `spaceKind` and so reports none.
 */
export type DeclaredSpaceKind = { readonly kind?: string };

/**
 * What `result`, a `session.open` result, says of the kind the space's genesis
 * commit declares, or `undefined` when it says nothing either way: a result
 * for a space with no history reports no kind, whatever its genesis commit
 * will declare.
 */
function declaredSpaceKindOf(
  result: SessionOpenResult,
): DeclaredSpaceKind | undefined {
  if (result.spaceKind !== undefined) return { kind: result.spaceKind };
  return result.serverSeq > 0 ? {} : undefined;
}

export type SessionOpenAuth = {
  invocation: FabricPlainObject;
  authorization: FabricValue;
};

export type SessionOpenAuthContext = {
  challenge: SessionOpenChallenge;
  audience: string;
  /** Pinned deployment for a routed connection-auth invocation. */
  deployment?: string;
};

export type SessionOpenAuthFactory = (
  space: string,
  session: MountOptions,
  context: SessionOpenAuthContext,
) => Promise<SessionOpenAuth | undefined> | SessionOpenAuth | undefined;

/** Signed direct invocation/authorization, or a routed binary statement transport. */
export type ConnectionAuth = {
  invocation: FabricPlainObject;
  authorization: FabricValue;
} | { statement: string };

/** Signs a `connection.auth` over the audience and challenge in `context`. */
export type ConnectionAuthFactory = (
  context: SessionOpenAuthContext,
) => Promise<ConnectionAuth> | ConnectionAuth;

/**
 * The key a session acts as, and how that key signs. Against a server
 * advertising `connectionAuth` the key signs once per connection, whatever
 * the number of sessions mounted as it. Routed challenges require fresh signing
 * for renewal on that connection; against any other server it signs
 * each `session.open`.
 */
export type SessionPrincipal = {
  /** DID of the key. */
  readonly did: string;

  /** Signs the key's `connection.auth`. */
  readonly authorizeConnection: ConnectionAuthFactory;

  /** Signs a `session.open`, for a server that verifies only those. */
  readonly authorizeSessionOpen: SessionOpenAuthFactory;
};

/** How a session is authenticated when it opens and each time it reopens. */
export type SessionAuth = SessionOpenAuthFactory | SessionPrincipal;

/**
 * What a presence room delivers to an observer, in the order it happens. A
 * `snapshot` opens the membership and reopens it after every reconnect, each
 * time with the participant id the relay assigned for that connection; a
 * `failure` carries a refused publication or the session's termination, and
 * nothing follows the latter.
 */
export type PresenceEvent =
  | {
    kind: "snapshot";
    participantId: string;
    participants: PresenceRecord[];
  }
  | { kind: "upsert"; participant: PresenceRecord }
  | { kind: "remove"; participantId: string }
  | { kind: "failure"; error: Error };

/** One observer's membership in one presence room. */
export interface PresenceMembership {
  /** The id the relay assigned this connection in the room; changes on reconnect. */
  readonly participantId: string;

  /**
   * Replaces the record this session holds in the room, at the next
   * revision. It does not wait for the relay: a refused publication reaches
   * the observer as a `failure`. Throws a `PresenceError` for a publication
   * outside the relay's bounds, before anything is sent.
   */
  publish(publication: PresencePublication): void;

  /**
   * Ends this observer's membership. The session leaves the room once its
   * last observer has left; calling it again does nothing.
   */
  leave(): Promise<void>;
}

/**
 * What one session holds for one room: its observers, the relay's view of the
 * room as the session last applied it, and the record it last published.
 */
type PresenceRoomState = {
  room: string;
  observers: Set<(event: PresenceEvent) => void>;
  participantId: string;
  participants: Map<string, PresenceRecord>;

  /** Revision of the last publication; `0` until one is made. */
  revision: number;

  /** The last publication, republished after a reconnect. */
  publication: PresencePublication | null;

  /** Settles when the relay has responded to the current join. */
  joined: Promise<void>;
};

/**
 * A commit a session has issued and not yet seen answered, kept for replay on
 * the next connection while its outcome is unknown.
 */
type OutstandingCommit = {
  /** The commit, sent unchanged on every attempt. */
  commit: ClientCommit;

  /** Settles with the server's verdict on the commit. */
  pending: PromiseWithResolvers<AppliedCommit>;

  /**
   * How many attempts failed because the commit's own write failed on an open
   * connection. The client stops replaying the commit once this reaches
   * `MAX_COMMIT_WRITE_FAILURES`.
   */
  writeFailures?: number;
};

export type WatchMutationResult = {
  view: WatchView;

  /** Effects delivered before the first watch response, in wire order. */
  precedingSyncs: SessionSync[];

  sync: SessionSync;
};

const RECONNECT_BASE_DELAY_MS = 25;
const RECONNECT_MAX_DELAY_MS = 30_000;
/**
 * The least a routed `connection.auth` refused for now waits before it is
 * sent again: a router refuses one when its source's authentications pass
 * their rate, which refills over seconds, not milliseconds.
 */
const ROUTED_RETRY_FLOOR_MS = 1_000;
/**
 * How long a refused statement's challenge must still last when it is sent
 * again, by this clock: a router refuses a statement whose challenge has
 * expired by its own clock, which may run a little ahead.
 */
const ROUTED_RESEND_MARGIN_S = 5;
/** How often one refused statement is sent again before a new challenge. */
const ROUTED_RESENDS = 3;
/**
 * How many keys sign one challenge on a routed connection before the next
 * key asks for another. A router closes the connection on a challenge's
 * 65th signer by default (its `max_principals_per_challenge`), so this
 * stays well under that.
 */
const ROUTED_SIGNERS_PER_CHALLENGE = 32;
/** Marks an error a router's refusal of a routed authentication. */
const ROUTED_AUTH_REFUSAL: unique symbol = Symbol("routed auth refusal");
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

/** The error a mount fails with when its caller's `signal` has aborted. */
const mountCancelled = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new Error("memory session mount cancelled");

/**
 * A statement a router refused for now: the challenge it answers, when that
 * challenge expires (unix seconds), when it was refused (milliseconds) and
 * how often it has been sent again since.
 */
type RefusedStatement = {
  context: SessionOpenAuthContext;
  signed: ConnectionAuth;
  expiresAt: number;
  at: number;
  resends: number;
};

/**
 * Whether a statement a router refused for now may be sent again: it has
 * been sent again fewer than `ROUTED_RESENDS` times, and its challenge
 * still has the margin left once the wait after the refusal is over.
 */
const resendable = (refused: RefusedStatement): boolean => {
  const sentAt = Math.max(Date.now(), refused.at + ROUTED_RETRY_FLOOR_MS);
  return refused.resends < ROUTED_RESENDS &&
    refused.expiresAt * 1000 - sentAt >= ROUTED_RESEND_MARGIN_S * 1000;
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

/** Sessions a reconnect restores at once; the rest wait for a free slot. */
export const RESTORE_CONCURRENCY = 128;

/**
 * Runs `run` on every item, at most `limit` at a time, and settles once all
 * have settled, in item order, as `Promise.allSettled` does.
 */
export async function settleBounded<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<unknown>,
): Promise<PromiseSettledResult<unknown>[]> {
  const results: PromiseSettledResult<unknown>[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = {
          status: "fulfilled",
          value: await run(items[index]),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, lane),
  );
  return results;
}

export class Client {
  #pending = new Map<string, PromiseWithResolvers<unknown>>();
  #spaces = new Set<SpaceSession>();
  #nextRequest = 1;
  #helloPending: PromiseWithResolvers<void> | null = null;
  #sessionOpenAuthContext: SessionOpenAuthContext | null = null;
  #serverFlags: MemoryProtocolFlags | null = null;

  /**
   * Per key, the `connection.auth` it made on the current connection,
   * settling with the principal the server admitted it as. Emptied by every
   * `hello`, since a new connection has authenticated nobody.
   */
  #authenticated = new Map<string, Promise<string>>();
  #routedSigners = new Map<string, SessionPrincipal>();

  /**
   * Per authenticated key, the timer that renews its authentication before
   * the lease the server granted runs out.
   */
  #renewals = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * The keys that have signed the challenge `#sessionOpenAuthContext` holds.
   * A challenge accepts each key once, so a key in here authenticates over a
   * challenge it asks for.
   */
  #challengeSigners = new Set<string>();
  /**
   * On a routed connection, the latest request for a challenge that is
   * still unanswered. Its challenge becomes the held one, so another key
   * that needs a challenge waits for it before asking for its own.
   */
  #challengeAsked: Promise<ConnectionChallengeResult> | undefined;
  /** Statements a router refused for now, by principal; see `#authenticate`. */
  #refusedStatements = new Map<string, RefusedStatement>();
  /**
   * Ends the wait of each mount a router has refused for now and rejects
   * the mount with the error given. `close()` calls them, and so does a
   * connection failure that is permanent. See `#holdMount`.
   */
  #heldMounts = new Set<(error: Error) => void>();

  /**
   * Settles once every signed `session.open` issued so far has been
   * responded to. Each one uses the connection's single current challenge
   * and receives the next, so they are issued one at a time.
   */
  #signedOpens: Promise<unknown> = Promise.resolve();

  /**
   * Counts the connections this client has opened. A signature made under
   * one count and sent under another is over a challenge of a connection
   * that is gone.
   */
  #connectionEpoch = 0;

  #reconnecting: Promise<void> | null = null;
  #cancelReconnectDelay: (() => void) | null = null;
  #connected = false;
  #closed = false;

  /**
   * The connection restarts held sessions have asked for since none was
   * held (see `restartConnection()`), and the wait the next reconnect
   * attempt makes first after one. Each restart waits longer, so a restore
   * that keeps failing cannot reopen the connection as fast as it fails.
   */
  #restarts = 0;
  #restartDelayMs = 0;

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

  /** Observers of `session/admissible`, as `subscribeAdmissible()` added. */
  #admissibleObservers = new Set<
    (space: string, principal: string) => void
  >();

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

  /**
   * Resolves once every server frame the transport held at the call has
   * reached this client. What a frame goes on to do from there — a response resolving, a
   * sync frame handed to its session — is microtask work after that.
   */
  delivered(): Promise<void> {
    return this.#transport.delivered?.() ?? Promise.resolve();
  }

  /**
   * Calls `observer` with each `session/admissible` the server sends: the
   * space it refused `principal` on this client, which a `session.open`
   * would now be admitted to. The notice is a hint, and grants nothing until
   * a session opens. Returns the function that ends the subscription.
   */
  subscribeAdmissible(
    observer: (space: string, principal: string) => void,
  ): () => void {
    this.#admissibleObservers.add(observer);
    return () => {
      this.#admissibleObservers.delete(observer);
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#connected = false;
    this.#noteStateChange();
    this.#cancelReconnectDelay?.();
    this.#cancelRenewals();
    this.#endHeldMounts(new Error("memory client closed"));
    this.#rejectPending(new Error("memory client closed"));
    await Promise.all([...this.#spaces].map((space) => space.close()));
    this.#spaces.clear();
    await this.#transport.close();
    await this.#reconnecting?.catch(() => undefined);
  }

  async mount(
    space: string,
    options: MountOptions = {},
    auth?: SessionAuth,
    signal?: AbortSignal,
  ): Promise<SpaceSession> {
    options = {
      ...options,
      ...(options.genesisRoot === undefined ? {} : {
        genesisRoot: cloneIfNecessary(options.genesisRoot, { frozen: false }),
      }),
    };
    let opening: Promise<SessionOpenResult> | undefined;
    let result: SessionOpenResult;
    try {
      result = await runWithAbortSignal(
        signal,
        "memory session mount cancelled",
        () => (opening = this.openSession(space, options, auth, undefined, {
          signal,
        })),
      );
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("memory session mount cancelled");
      }
    } catch (error) {
      // A cancelled mount hands out no session, so one the server opened for
      // it has no holder to close it.
      if (signal?.aborted) {
        void opening?.then(({ sessionId }) =>
          this.#closeUnheldSession(space, sessionId)
        ).catch(() => undefined);
      }
      throw error;
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
      auth,
      signal,
      options.actingAs,
      options.readCeiling,
      options.genesisRoot,
      options.spaceKind,
      declaredSpaceKindOf(result),
    );
    this.#spaces.add(session);
    return session;
  }

  forgetSession(session: SpaceSession): void {
    this.#spaces.delete(session);
  }

  /**
   * Sends `message` and returns the `ok` of the server's response, or throws
   * its error. A request made while the connection is down waits for the
   * reconnect, unless `options.whileConnected` is set, in which case it
   * throws a `ConnectionError`: a request a session's restore makes would
   * otherwise wait for the reconnect that is running that restore.
   */
  async request<Result>(
    message: FabricPlainObject,
    options: { whileConnected?: boolean } = {},
  ): Promise<Result> {
    if (options.whileConnected === true && !this.#connected) {
      throw connectionLostWhileRestoring();
    }
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
      serverVerdicts.add(error);
      throw error;
    }
    return result.ok as Result;
  }

  /**
   * The holdings a request declares on this connection, given the ones its
   * session holds. A router and a routed toolshed close the connection on
   * a frame that names more than `ROUTED_HOLDINGS_LIMIT` holdings, and the
   * reconnect would declare the same list again, so on a routed connection
   * a longer list is cut to the limit. Declaring fewer is safe: the server
   * delivers again every document the list does not name, so the documents
   * cut are sent a second time and none is skipped. A direct server takes
   * the whole list.
   *
   * @internal For `SpaceSession`.
   */
  declarableHoldings<Holdings extends SessionHolding[] | undefined>(
    holdings: Holdings,
  ): Holdings | SessionHolding[] {
    return holdings !== undefined && holdings.length > ROUTED_HOLDINGS_LIMIT &&
        this.#sessionOpenAuthContext?.deployment !== undefined
      ? holdings.slice(0, ROUTED_HOLDINGS_LIMIT)
      : holdings;
  }

  /**
   * Ends the authentication of the key `did` on the current connection.
   * Sessions mounted as it stay open, and a later mount as it authenticates
   * again, as does a mount as it that is still under way. Sends nothing for
   * a key this connection has not authenticated.
   */
  async release(did: string): Promise<void> {
    this.#cancelRenewal(did);
    this.#routedSigners.delete(did);
    this.#refusedStatements.delete(did);
    if (!this.#authenticated.delete(did)) return;
    await this.request({
      type: "connection.release",
      requestId: this.#nextRequestId(),
      principal: did,
    });
  }

  /**
   * Opens or reopens a session, authenticated as `auth` says: named as a
   * principal the connection has authenticated where the server advertises
   * `connectionAuth`, and otherwise signed for this one session. A reopen
   * that a session's restore makes sets `options.restoring`, and is then
   * rejected with a `ConnectionError` if the connection drops under it. A
   * mount that a router refuses for now is tried again on the same
   * connection until it is admitted or refused for good, the client closes
   * or fails for good, or `options.signal` aborts. A connection that drops
   * under a request the mount has sent still fails the mount.
   */
  async openSession(
    space: string,
    session: MountOptions,
    auth?: SessionAuth,
    holdings?: SessionHolding[],
    options: { restoring?: boolean; signal?: AbortSignal } = {},
  ): Promise<SessionOpenResult> {
    const whileConnected = options.restoring === true;
    // A mount made while the connection is down waits for the reconnect to
    // finish, restores included, before it joins the key's authentication
    // or the signed-open chain: joined earlier, the restores would wait for
    // it while it waited for them. A reopen is part of that reconnect and
    // fails instead when the connection drops under it.
    if (!whileConnected) {
      await this.#ensureConnected();
    }
    // Every open passes through here — a first mount and each reopen after
    // a dropped connection alike — so this is where a declared ceiling is
    // held to the server it is declared to. A server that does not
    // advertise `sessionReadCeiling` would accept the descriptor and serve
    // every query unbounded.
    const requireCapabilities = (): void => {
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
      if (
        session.spaceKind !== undefined && this.serverFlags?.spaceKind !== true
      ) {
        throw protocolError(
          "memory server does not seal a space's declared kind",
        );
      }
    };
    requireCapabilities();
    // A mount whose caller has cancelled it sends nothing more.
    const requireUncancelled = (): void => {
      if (options.signal?.aborted) throw mountCancelled(options.signal);
    };
    // The refusals for now a mount has waited after; see `#holdMount`.
    let refusals = 0;
    // A drop while an open is being signed leaves it with a challenge of
    // the connection that is gone. A reopen fails then, for its reconnect
    // to retry; a mount waits for the reconnect and signs again.
    for (;;) {
      if (
        typeof auth === "object" && this.serverFlags?.connectionAuth === true
      ) {
        try {
          requireUncancelled();
          // A mount held below may have waited through a reconnect, and
          // the next connection's server may advertise other capabilities.
          requireCapabilities();
          const principal = await this.#authenticate(auth, whileConnected);
          if (principal !== STALE) {
            requireUncancelled();
            return await this.request<SessionOpenResult>({
              type: "session.open",
              requestId: this.#nextRequestId(),
              space,
              principal,
              session,
              ...(holdings !== undefined
                ? { holdings: this.declarableHoldings(holdings) }
                : {}),
            }, { whileConnected });
          }
        } catch (error) {
          // A router's refusal for now passes without a new connection,
          // whether of a challenge for the key, of its statement or of the
          // open: a source's authentication rate refills, and a toolshed
          // that is down or restarting comes back. A reopen fails here, and
          // its session holds and tries again. Nothing does that for a
          // mount, whose caller would be told the space failed to open, so
          // a mount is held here instead: it waits, then goes round again
          // on this connection, as often as it takes, since a held session
          // has no limit either. `#authenticate` then sends the statement
          // it kept, or signs a new challenge once that statement may not
          // be sent again. If the connection drops while the mount waits,
          // the next round waits for the reconnect and starts over; a drop
          // under a request the mount has sent fails it, as it does any
          // mount. A direct server's denial goes to the caller as before.
          if (
            whileConnected || !isRetriableAuthorizationError(error) ||
            this.#sessionOpenAuthContext?.deployment === undefined
          ) throw error;
          await this.#holdMount(refusals++, options.signal);
          continue;
        }
        await this.#ensureConnected();
        continue;
      }
      const sign = typeof auth === "object" ? auth.authorizeSessionOpen : auth;
      const opened = this.#signedOpens.then(
        async (): Promise<SessionOpenResult | typeof STALE> => {
          if (!this.#connected) {
            if (whileConnected) throw connectionLostWhileRestoring();
            return STALE;
          }
          const epoch = this.#connectionEpoch;
          const signed = await sign?.(
            space,
            session,
            this.sessionOpenAuthContext(),
          );
          if (this.#staleSince(epoch)) {
            if (whileConnected) throw connectionLostWhileRestoring();
            return STALE;
          }
          const result = await this.request<SessionOpenResult>({
            type: "session.open",
            requestId: this.#nextRequestId(),
            space,
            session,
            ...(signed ? signed : {}),
            ...(holdings !== undefined ? { holdings } : {}),
          }, { whileConnected });
          this.#updateSessionOpenAuthContext(result.sessionOpen);
          return result;
        },
      );
      this.#signedOpens = opened.catch(() => undefined);
      const result = await opened;
      if (result === STALE) {
        await this.#ensureConnected();
        continue;
      }
      return result;
    }
  }

  /**
   * Helper for `openSession()`, which waits before a mount tries again
   * after a router's refusal for now. `refusals` counts the refusals the
   * mount has already waited after. The wait is the reconnect backoff for
   * that count on top of a second, so mounts refused together do not all
   * try again in the same millisecond. The wait ends early, and rejects,
   * when the client closes or fails for good or when `signal` aborts, so no
   * timer outlives any of those.
   */
  #holdMount(refusals: number, signal?: AbortSignal): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("memory client closed"));
    if (this.#fatalError) return Promise.reject(this.#fatalError);
    if (signal?.aborted) return Promise.reject(mountCancelled(signal));
    return new Promise<void>((resolve, reject) => {
      const settle = (error?: Error): void => {
        clearTimeout(timer);
        this.#heldMounts.delete(settle);
        signal?.removeEventListener("abort", abort);
        if (error === undefined) resolve();
        else reject(error);
      };
      const abort = (): void => settle(mountCancelled(signal!));
      const timer = setTimeout(
        () => settle(),
        ROUTED_RETRY_FLOOR_MS + reconnectDelayMs(refusals),
      );
      this.#heldMounts.add(settle);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  /** Ends the wait of every held mount and rejects each with `error`. */
  #endHeldMounts(error: Error): void {
    for (const end of [...this.#heldMounts]) end(error);
  }

  /**
   * Whether a signature begun under connection `epoch` is over a challenge
   * of a connection that is gone: the connection dropped, or a new one
   * replaced it, while the signing ran.
   */
  #staleSince(epoch: number): boolean {
    return !this.#connected || this.#connectionEpoch !== epoch;
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
    this.#challengeSigners.clear();
  }

  /**
   * Helper for `mount()`, which ends a session the server holds on this
   * connection and no `SpaceSession` stands for. A server that does not
   * advertise `sessionClose` keeps it until the connection closes.
   */
  async #closeUnheldSession(space: string, sessionId: string): Promise<void> {
    if (
      this.#closed || !this.#connected ||
      this.serverFlags?.sessionClose !== true
    ) return;
    await this.request({
      type: "session.close",
      requestId: this.#nextRequestId(),
      space,
      sessionId,
    });
  }

  /**
   * Helper for `openSession()`, which authenticates the key of `principal`
   * on the current connection unless it already has, or is about to have.
   * Every caller naming one key waits for the same `connection.auth`, whose
   * requests are made `whileConnected` if the first of those callers asks.
   */
  async #authenticate(
    principal: SessionPrincipal,
    whileConnected: boolean,
    freshChallenge = false,
    routedChallenge?: SessionOpenAuthContext["challenge"],
  ): Promise<string | typeof STALE> {
    this.#routedSigners.set(principal.did, principal);
    // A connection that is down holds the challenge of the one that is
    // gone, and its authentications too: `#authenticated` is emptied by the
    // next hello, which a reconnect may put off, so this is tested before
    // the map is read. A key found there meanwhile is one the next
    // connection has not authenticated.
    if (!this.#connected) {
      if (whileConnected) throw connectionLostWhileRestoring();
      return STALE;
    }
    const existing = this.#authenticated.get(principal.did);
    if (existing !== undefined) {
      try {
        return await existing;
      } catch (error) {
        // The authentication tells the caller that began it that the
        // connection is gone with this signal, which that caller reads as
        // `STALE`. A caller that waited for it reads it the same way.
        if (error !== STALE_AUTHENTICATION) throw error;
        if (whileConnected) throw connectionLostWhileRestoring();
        return STALE;
      }
    }
    const epoch = this.#connectionEpoch;
    const held = this.sessionOpenAuthContext();
    // The server refuses a challenge that has expired, and one this key has
    // already signed, so either case takes a challenge of its own. The
    // expiry is read by this clock, which may lag the server's: a direct
    // server's refusal marked retriable is answered once with a challenge
    // asked for outright.
    // A statement a router refused for now was refused before its
    // challenge was spent, so a pushed challenge aside, it is sent again
    // while that challenge lasts, a second or more after the refusal,
    // rather than asking for one challenge after another.
    const refused = routedChallenge === undefined &&
        held.deployment !== undefined
      ? this.#refusedStatements.get(principal.did)
      : undefined;
    let resend = refused !== undefined && resendable(refused);
    // Whether this key may sign the challenge `context` holds: it has not
    // signed it, the challenge has not expired, and on a routed connection
    // it has signers to spare. A key that takes it is added to its signers.
    const takes = (context: SessionOpenAuthContext): boolean => {
      if (
        this.#challengeSigners.has(principal.did) ||
        context.challenge.expiresAt <= Math.floor(Date.now() / 1000) ||
        (context.deployment !== undefined &&
          this.#challengeSigners.size >= ROUTED_SIGNERS_PER_CHALLENGE)
      ) return false;
      this.#challengeSigners.add(principal.did);
      return true;
    };
    const needsChallenge = !resend &&
      (routedChallenge !== undefined || freshChallenge || !takes(held));
    const authenticated = (async () => {
      let context: SessionOpenAuthContext;
      let signed: ConnectionAuth;
      // A drop while the key signed, or while a refused statement waited,
      // leaves the signature over a challenge of the connection that is
      // gone; `hello` has emptied the map, so the next caller starts over on
      // the new connection.
      const requireCurrentConnection = (): void => {
        if (!this.#staleSince(epoch)) return;
        if (whileConnected) throw connectionLostWhileRestoring();
        throw STALE_AUTHENTICATION;
      };
      if (resend) {
        const wait = refused!.at + ROUTED_RETRY_FLOOR_MS - Date.now();
        if (wait > 0) {
          await new Promise((r) => setTimeout(r, wait));
          // Checked here as well as below: a statement that may no longer
          // be sent would otherwise ask the next connection for a
          // challenge that this authentication then throws away.
          requireCurrentConnection();
        }
        // The wait may have taken longer than asked; the challenge is
        // checked again before the statement goes.
        resend = resendable(refused!);
      }
      /** `held` with `challenge` in place of its own. */
      const over = (
        challenge: SessionOpenAuthContext["challenge"],
      ): SessionOpenAuthContext => ({
        audience: held.audience,
        ...(held.deployment === undefined
          ? {}
          : { deployment: held.deployment }),
        challenge,
      });
      const ask = () =>
        this.request<ConnectionChallengeResult>({
          type: "connection.challenge",
          requestId: this.#nextRequestId(),
        }, { whileConnected });
      // On a routed connection a challenge asked for outright becomes the
      // held one, with this key its first signer, so the keys that follow
      // sign it too. A router allows a connection 16 unexpired challenges,
      // and a client that opens spaces as many new keys would otherwise
      // ask for one each. A key that needs a challenge while another key's
      // request for one is unanswered waits for that one and signs it if
      // it may. A renewal still asks for its own, without waiting.
      const shared = async (): Promise<SessionOpenAuthContext> => {
        for (;;) {
          const asking = freshChallenge ? undefined : this.#challengeAsked;
          if (asking !== undefined) {
            try {
              await asking;
            } catch (error) {
              // Lost with its connection, which is not a refusal of this
              // key: the caller waits for the next connection.
              requireCurrentConnection();
              throw error;
            }
            requireCurrentConnection();
            const current = this.sessionOpenAuthContext();
            if (takes(current)) return current;
            continue;
          }
          const asked = ask();
          this.#challengeAsked = asked;
          let challenge: SessionOpenAuthContext["challenge"];
          try {
            ({ challenge } = await asked);
          } finally {
            if (this.#challengeAsked === asked) {
              this.#challengeAsked = undefined;
            }
          }
          requireCurrentConnection();
          const context = over(challenge);
          this.#sessionOpenAuthContext = context;
          this.#challengeSigners = new Set([principal.did]);
          return context;
        }
      };
      if (resend) {
        ({ context, signed } = refused!);
      } else {
        context = routedChallenge !== undefined
          ? over(routedChallenge)
          : !needsChallenge && refused === undefined
          ? held
          : held.deployment !== undefined
          ? await shared()
          : over((await ask()).challenge);
        signed = await principal.authorizeConnection(context);
      }
      requireCurrentConnection();
      try {
        const result = await this.request<ConnectionAuthResult>({
          type: "connection.auth",
          requestId: this.#nextRequestId(),
          ...signed,
        }, { whileConnected });
        this.#refusedStatements.delete(principal.did);
        this.#scheduleRenewal(principal, epoch, result.expiresAt);
        return result.principal;
      } catch (error) {
        if (
          context.deployment !== undefined &&
          isRetriableAuthorizationError(error) && !this.#staleSince(epoch)
        ) {
          this.#refusedStatements.set(principal.did, {
            context,
            signed,
            expiresAt: context.challenge.expiresAt,
            at: Date.now(),
            resends: resend ? refused!.resends + 1 : 0,
          });
        } else this.#refusedStatements.delete(principal.did);
        throw error;
      }
    })();
    this.#authenticated.set(principal.did, authenticated);
    try {
      return await authenticated;
    } catch (error) {
      if (this.#authenticated.get(principal.did) === authenticated) {
        this.#authenticated.delete(principal.did);
      }
      if (error === STALE_AUTHENTICATION) return STALE;
      // A router's refusal for now, of the statement or of a challenge for
      // it, passes over seconds: a held restore waits a second or more after
      // it, as a renewal does; see `#holdRestore`.
      if (
        held.deployment !== undefined && isRetriableAuthorizationError(error)
      ) {
        (error as { [ROUTED_AUTH_REFUSAL]?: true })[ROUTED_AUTH_REFUSAL] = true;
      }
      // A router's refusal for now is answered by sending the statement
      // again later, not by a new challenge now.
      if (
        !needsChallenge && held.deployment === undefined &&
        isRetriableAuthorizationError(error) && !this.#staleSince(epoch)
      ) {
        return await this.#authenticate(principal, whileConnected, true);
      }
      throw error;
    }
  }

  /**
   * Helper for `#authenticate()`, which arms the renewal of `principal`'s
   * authentication ahead of `expiresAt`, the unix second its lease runs out
   * at: two minutes ahead, or halfway through a lease shorter than four. A
   * renewal signs a challenge asked for outright, since the one held may be
   * one the key has signed. A renewal the server refuses for good ends the
   * sessions mounted as the key, as a refused reopen ends a session.
   */
  #scheduleRenewal(
    principal: SessionPrincipal,
    epoch: number,
    expiresAt: number,
  ): void {
    const leaseMs = expiresAt * 1000 - Date.now();
    this.#armRenewal(
      principal,
      epoch,
      0,
      Math.max(0, leaseMs - Math.min(120_000, leaseMs / 2)),
    );
  }

  /**
   * Arms another attempt at authenticating `principal` after the server
   * refused one for now: a renewal, or the answer to a pushed challenge.
   * `attempt` counts those refusals from 1. The attempt waits the reconnect
   * backoff for that count, on top of a second against a router, whose
   * refusal for now passes over seconds. The backoff is added to the second
   * and not capped below by it, so its jitter is kept and keys refused
   * together do not all try again in the same millisecond.
   *
   * It arms nothing when the connection of `epoch` is gone, since the next
   * connection authenticates the key itself, or when a renewal is already
   * armed for the key. An authentication admitted after the refused one
   * began arms that renewal, and replacing it with a retry would leave the
   * admitted lease without one.
   */
  #retryRenewal(
    principal: SessionPrincipal,
    epoch: number,
    attempt: number,
  ): void {
    if (this.#staleSince(epoch) || this.#renewals.has(principal.did)) return;
    // A router's refusal for now passes over seconds; a direct server's
    // retries at the reconnect backoff.
    const floor = this.#sessionOpenAuthContext?.deployment === undefined
      ? 0
      : ROUTED_RETRY_FLOOR_MS;
    this.#armRenewal(
      principal,
      epoch,
      attempt,
      floor + reconnectDelayMs(attempt - 1),
    );
  }

  /**
   * Sets the timer that authenticates `principal` again after `delayMs`.
   * Attempt 0 renews a lease; a later attempt follows a refusal for now.
   * It sets none for a key released since its authentication began, whether
   * that authentication was then admitted or refused for now: a released
   * key is not kept authenticated.
   */
  #armRenewal(
    principal: SessionPrincipal,
    epoch: number,
    attempt: number,
    delayMs: number,
  ): void {
    if (!this.#routedSigners.has(principal.did)) return;
    this.#cancelRenewal(principal.did);
    const timer = setTimeout(() => {
      this.#renewals.delete(principal.did);
      if (this.#closed || !this.#connected || epoch !== this.#connectionEpoch) {
        return;
      }
      // A first attempt replaces the authentication whose lease is running
      // out. A retry has nothing to replace. The refused attempt's entry is
      // gone, and an authentication admitted since then armed its own
      // renewal, which cancelled this timer or, if it was armed first, kept
      // `#retryRenewal` from arming this one. So an entry found here is
      // another caller's and still under way, and the retry waits for it:
      // replacing it would send the key's statement twice, and a router
      // closes the connection on a second statement for a challenge it has
      // accepted.
      if (attempt === 0) {
        this.#authenticated.delete(principal.did);
        // The authentication replaced may be one still under way, sending
        // a statement kept from a refusal for now. Dropping that statement
        // makes this renewal sign a challenge of its own, as a lease's
        // renewal always does, where it would send the kept one again
        // beside the copy that is unanswered.
        this.#refusedStatements.delete(principal.did);
      }
      void this.#authenticate(principal, false, true).catch((error) => {
        // A renewal refused for now is tried again after a backoff, so the
        // grant does not lapse and leave the principal's opens to a final
        // denial.
        if (isRetriableAuthorizationError(error)) {
          this.#retryRenewal(principal, epoch, attempt + 1);
          return;
        }
        if (!isPermanentAuthorizationError(error)) return;
        for (const session of [...this.#spaces]) {
          if (session.principal === principal.did) {
            session.handleConnectionFailure(error);
          }
        }
      });
    }, delayMs);
    this.#renewals.set(principal.did, timer);
  }

  #cancelRenewal(did: string): void {
    const timer = this.#renewals.get(did);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#renewals.delete(did);
    }
  }

  #cancelRenewals(): void {
    for (const timer of this.#renewals.values()) clearTimeout(timer);
    this.#renewals.clear();
  }

  /**
   * Discards the connection for a held session whose retried restore failed
   * with `error`, a reason only a new connection heals, as the reconnect loop
   * does when a restore fails: every session restores again on the next
   * connection, after a backoff that grows with each restart until no
   * session is held.
   *
   * @internal For `SpaceSession`.
   */
  restartConnection(error: Error): void {
    // A closed or failed client is never connected.
    if (!this.#connected) return;
    if (!this.#discardConnection(error)) return;
    this.#restartDelayMs = reconnectDelayMs(this.#restarts++);
    // A discarded connection reports no close, so the reconnect starts here.
    void this.#reconnect().catch(() => undefined);
  }

  /**
   * Notes that a session's hold ended other than by a drop: it reopened, or
   * it closed, ended or lost its route. Once no session is held, restarts
   * back off from the start again.
   *
   * @internal For `SpaceSession`.
   */
  noteHoldEnded(): void {
    if (![...this.#spaces].some((session) => session.held)) this.#restarts = 0;
  }

  /**
   * Waits for the transport handshake and restoration of existing sessions,
   * except those a retriable denial holds: each restores on its own.
   */
  async restoreConnection(): Promise<void> {
    await this.#ensureConnected();
    await this.#reconnecting;
  }

  async #hello(): Promise<void> {
    this.#transport.setMessageCompressionEnabled?.(false);
    this.#connectionEpoch += 1;
    this.#authenticated.clear();
    this.#routedSigners.clear();
    this.#transport.setRoutedMessagesEnabled?.(false);
    this.#cancelRenewals();
    this.#challengeSigners.clear();
    this.#challengeAsked = undefined;
    this.#refusedStatements.clear();
    // Signed opens waiting on the old connection's chain settle on their
    // own, as stale, and the restores that follow this handshake must not
    // wait behind them.
    this.#signedOpens = Promise.resolve();
    const ack = Promise.withResolvers<void>();
    this.#helloPending = ack;
    const expectedFlags = getMemoryProtocolFlags();
    try {
      const hello = {
        type: "hello",
        protocol: MEMORY_PROTOCOL,
        flags: {
          ...expectedFlags,
          routedAuthV1: this.#transport.setRoutedMessagesEnabled !== undefined,
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
      message = decodeTrustedMemoryBoundary(payload);
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
      if (
        helloOk?.flags.routedAuthV1 === true &&
        this.#transport.setRoutedMessagesEnabled === undefined
      ) {
        this.#helloPending.reject(
          new Error("Routed transport codec unavailable"),
        );
        return;
      }
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
        const routed = this.#sessionOpenAuthContext.deployment !== undefined;
        if (
          routed !== helloOk.flags.routedAuthV1 ||
          (routed && !helloOk.flags.connectionAuth)
        ) {
          this.#helloPending.reject(
            permanentProtocolError(
              "Routed authentication metadata does not match negotiated flags",
            ),
          );
          return;
        }
        this.#transport.setRoutedMessagesEnabled?.(routed);
        this.#transport.setMessageCompressionEnabled?.(
          expectedFlags.messageCompressionV1 &&
            this.#transport.supportsMessageCompression === true &&
            helloOk.flags.messageCompressionV1,
        );
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

    if (isObjectNotArray(message) && message.type === "connection/challenge") {
      const principal = typeof message.principal === "string"
        ? this.#routedSigners.get(message.principal)
        : undefined;
      if (
        principal === undefined ||
        this.#sessionOpenAuthContext?.deployment === undefined
      ) {
        this.#rejectPending(
          permanentProtocolError("Unexpected routed authentication challenge"),
        );
        return;
      }
      try {
        const context = requireSessionOpenAuthMetadata({
          ...this.#sessionOpenAuthContext,
          challenge: message.challenge,
        });
        const epoch = this.#connectionEpoch;
        this.#authenticated.delete(principal.did);
        this.#cancelRenewal(principal.did);
        void this.#authenticate(principal, false, true, context.challenge)
          .catch((error) => {
            // Refused for now: the router has refused the opens waiting for
            // this signature for now too, and the session or the mount
            // behind each tries again, which authenticates the key again.
            // No open may have been waiting, though; the renewal cancelled
            // above was then the key's only other authentication, and
            // without one its lease runs out and its sessions are denied
            // for good. So another attempt is armed, as after a renewal
            // refused for now. Refused for good: only the sessions mounted
            // as this key end, as when a renewal is. Neither touches the
            // connection's other requests.
            if (isRetriableAuthorizationError(error)) {
              this.#retryRenewal(principal, epoch, 1);
              return;
            }
            if (isPermanentAuthorizationError(error)) {
              for (const session of [...this.#spaces]) {
                if (session.principal === principal.did) {
                  session.handleConnectionFailure(error);
                }
              }
              return;
            }
            this.#rejectPending(error);
          });
      } catch (error) {
        this.#rejectPending(
          error instanceof Error ? error : protocolError(String(error)),
        );
      }
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
    if (isSessionAdmissible(message)) {
      for (const observer of [...this.#admissibleObservers]) {
        try {
          observer(message.space, message.principal);
        } catch (cause) {
          console.error("session-admissible subscriber threw:", cause);
        }
      }
      return;
    }
    if (isPresencePush(message)) {
      for (const session of this.#spaces) {
        if (
          session.sessionId === message.sessionId &&
          session.space === message.space
        ) {
          session.handlePresence(message);
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
    // A drop while a session is held counts as a restart: a peer that denies
    // a reopen and then drops the connection would otherwise be reconnected
    // to at once, every time.
    if ([...this.#spaces].some((session) => session.held)) {
      this.#restartDelayMs = reconnectDelayMs(this.#restarts++);
    }
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
    // The loop always waits before it ends, so `#reconnecting` holds it by
    // the time its `finally` runs, and nothing else starts a loop while it
    // runs. The `finally` clears it in the same turn as the loop's last
    // check, so a restart or a drop from then on starts a new loop.
    this.#reconnecting = (async () => {
      try {
        let attempt = 0;
        while (!this.#closed && this.#fatalError === null) {
          const restartDelayMs = this.#restartDelayMs;
          this.#restartDelayMs = 0;
          if (restartDelayMs > 0) {
            await this.#waitForReconnectDelay(restartDelayMs);
            if (this.#closed) return;
          }
          try {
            await this.#hello();
            // Sessions restore RESTORE_CONCURRENCY at a time, so a connection
            // holding hundreds of them does not send them all at once and
            // meet a router's in-flight limit. A failure is thrown only after
            // all of them have settled, so a retry starts from a connection
            // nothing is still using.
            const restored = await settleBounded(
              [...this.#spaces],
              RESTORE_CONCURRENCY,
              (session) => session.restore(),
            );
            for (const outcome of restored) {
              if (outcome.status === "rejected") throw outcome.reason;
            }
            // A restart or a drop that landed while the restores settled
            // discarded this connection, so go round again: the loop ends
            // only connected, closed or failed, and nothing waiting on it
            // resumes on a discarded connection.
            if (!this.#connected) continue;
            if (![...this.#spaces].some((session) => session.held)) {
              this.#restarts = 0;
            }
            return;
          } catch (error) {
            const err = error instanceof Error
              ? error
              : new Error(String(error));
            if (!this.#discardConnection(err)) return;
            await this.#waitForReconnectDelay(reconnectDelayMs(attempt));
            attempt += 1;
          }
        }
      } finally {
        this.#reconnecting = null;
      }
    })();
    await this.#reconnecting;
  }

  /**
   * Helper for the reconnect loop and `restartConnection()`, which discards
   * the connection after `err` and reports whether a reconnect can follow.
   */
  #discardConnection(err: Error): boolean {
    this.#connected = false;
    this.#noteStateChange();
    if (
      isPermanentConnectionFailure(err) || this.#transport.reset === undefined
    ) {
      // A permanent failure, or a transport unable to discard the failed
      // connection, cannot recover by repeating the handshake. Preserve the
      // cause for every present and future request.
      this.#fatalError = err;
      // Redundant today: the notification above has already woken every
      // waiter, and none of them resumes until this block finishes, so each
      // reads the state this line settles. It stays because no write to a
      // field `.connectionState` reads leaves its block without a
      // notification covering it, and that rule is what lets the write
      // sites be checked rather than reasoned about one by one.
      this.#noteStateChange();
      this.#endHeldMounts(err);
      this.#rejectPending(err);
      for (const session of this.#spaces) {
        session.handleConnectionFailure(err);
      }
      return false;
    }
    // Requests lost with this connection have no server verdict. Keep their
    // commits outstanding for replay, regardless of which error caused a
    // session's restore to fail.
    this.#rejectPending(toConnectionError(err));
    for (const session of this.#spaces) {
      session.handleDisconnect();
    }
    // A restore can fail after hello succeeded while the socket stays open.
    // The next hello needs a new connection and auth challenge.
    this.#transport.reset();
    return true;
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
  #outstandingCommits = new Map<number, OutstandingCommit>();
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
   * when round trips overlap on the wire. The watch set `restore()`
   * re-establishes is issued and applied outside this chain and
   * `#watchIssue`; see `#sendRestoreWatchMutation()`.
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
   * The most recent watch mutation to put its request on the wire, settling
   * once its response has been applied. The watch set a restore re-establishes
   * is sent after it.
   */
  #lastSentWatchMutation: Promise<unknown> | undefined;

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
  /** Counts `restore()` calls, so only the latest one ends the restoring state. */
  #restoreRun = 0;

  /**
   * Whether this session waits on its own restore after a retriable denial
   * (see `restore`), on a connection its other sessions use.
   */
  #held = false;

  /** Cancels the pending retry of a held restore. */
  #heldRestore: (() => void) | undefined;

  /** How many restores this session has held since it last restored. */
  #heldRestores = 0;

  /**
   * Whether this session's watch set must be sent again: set when a reopen
   * starts a new server session, cleared only once the watch set is
   * re-established. A held restore can reopen the new session as resumed,
   * and must still send the watch set the denied attempt did not.
   */
  #watchSetOwed = false;
  #caughtUpLocalSeq = 0;
  #presenceRooms = new Map<string, PresenceRoomState>();

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
  readonly #auth?: SessionAuth;
  readonly #routeSignal?: AbortSignal;
  readonly #actingAs?: "space-owner";
  readonly #readCeiling?: SessionReadCeiling;
  readonly #genesisRoot?: GenesisRoot;
  readonly #spaceKindIntent?: string;
  #declaredSpaceKind?: DeclaredSpaceKind;

  constructor(
    client: Client,
    readonly space: string,
    sessionId: string,
    sessionToken: string | undefined,
    serverSeq: number,
    auth?: SessionAuth,
    routeSignal?: AbortSignal,
    actingAs?: "space-owner",
    readCeiling?: SessionReadCeiling,
    genesisRoot?: GenesisRoot,
    spaceKindIntent?: string,
    declaredSpaceKind?: DeclaredSpaceKind,
  ) {
    this.#client = client;
    this.#auth = auth;
    this.#routeSignal = routeSignal;
    this.#actingAs = actingAs;
    this.#readCeiling = readCeiling;
    this.#genesisRoot = genesisRoot === undefined
      ? undefined
      : cloneIfNecessary(genesisRoot, { frozen: false });
    this.#spaceKindIntent = spaceKindIntent;
    this.#declaredSpaceKind = declaredSpaceKind;
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

  /** DID of the key this session acts as, when it was mounted with one. */
  get principal(): string | undefined {
    return typeof this.#auth === "object" ? this.#auth.did : undefined;
  }

  get serverSeq(): number {
    return this.#serverSeq;
  }

  /**
   * What this session's latest open told it of the kind the space's genesis
   * commit declares, or `undefined` when that open told it nothing either
   * way, having come before the space had any history. A session that opens
   * on a space with no history stays open as the space's genesis commits, and
   * learns its kind only by opening again.
   */
  get declaredSpaceKind(): DeclaredSpaceKind | undefined {
    return this.#declaredSpaceKind;
  }

  /** The error this session was terminated with, or undefined while it is open.
   *  A permanent reopen denial stores its `AuthorizationError` here (see
   *  `restore`), which is what `#assertOpen` rethrows; a storage subscriber reads
   *  it to observe a denial that terminated the session without a fresh watch
   *  result to carry it. */
  get closeError(): Error | undefined {
    return this.#closeError ?? undefined;
  }

  /**
   * Whether this session is waiting on its own restore after a retriable
   * denial, such as the router's while its space's toolshed is down. Its
   * requests wait meanwhile, while the connection's other sessions work.
   */
  get held(): boolean {
    return this.#held;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw this.#closeError ?? new Error("memory session closed");
    }
  }

  /**
   * Waits for restored session identity before constructing an ordinary
   * request: for this session's own restore where one is pending, whatever
   * the client's other sessions are doing, and otherwise for the connection.
   */
  async #ensureSessionRestored(): Promise<void> {
    this.#assertOpen();
    if (this.#restoreComplete !== undefined) {
      await this.#restoreComplete.promise;
    } else if (!this.#client.isConnected()) {
      await this.#client.restoreConnection();
    }
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
      // A terminal recovery failure rejects this commit through the session;
      // the background trigger must not also leave an unhandled rejection.
      void this.#client.restoreConnection().catch(() => undefined);
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

  /**
   * Joins the presence room `room` under this session's space and returns
   * the membership, after delivering the relay's current snapshot to
   * `observer`. Several observers may join one room; they share one
   * membership and one published record. Throws a `ProtocolError` when the
   * server does not advertise `presenceV1`, and a `PresenceError` for a
   * malformed room id.
   */
  async joinPresenceRoom(
    room: string,
    observer: (event: PresenceEvent) => void,
  ): Promise<PresenceMembership> {
    await this.#ensureSessionRestored();
    if (this.#client.serverFlags?.presenceV1 !== true) {
      throw protocolError("memory server does not support presence");
    }
    if (!isPresenceRoom(room)) {
      throw new PresenceError("Presence room id is invalid");
    }
    // The room's last observer may leave while the join is awaited, taking
    // the state with it; a state that is no longer the room's is not one to
    // attach to, so the join starts over on a fresh one.
    let state: PresenceRoomState;
    for (;;) {
      const existing = this.#presenceRooms.get(room);
      if (existing === undefined) {
        const created: PresenceRoomState = {
          room,
          observers: new Set(),
          participantId: "",
          participants: new Map(),
          revision: 0,
          publication: null,
          joined: Promise.resolve(),
        };
        created.joined = this.#joinPresence(created);
        this.#presenceRooms.set(room, created);
        state = created;
      } else {
        state = existing;
      }
      try {
        await state.joined;
      } catch (error) {
        if (
          this.#presenceRooms.get(room) === state && state.observers.size === 0
        ) {
          this.#presenceRooms.delete(room);
        }
        throw error;
      }
      this.#assertOpen();
      if (this.#presenceRooms.get(room) === state) break;
    }
    state.observers.add(observer);
    this.#deliverPresenceTo(observer, {
      kind: "snapshot",
      participantId: state.participantId,
      participants: [...state.participants.values()],
    });
    const joined = state;
    let left = false;
    return {
      get participantId() {
        return joined.participantId;
      },
      publish: (publication) => {
        if (left || this.#closed) return;
        validatePresencePublication(publication);
        joined.publication = publication;
        joined.revision += 1;
        this.#publishPresence(joined, joined.revision);
      },
      leave: async () => {
        if (left) return;
        left = true;
        joined.observers.delete(observer);
        if (joined.observers.size > 0) return;
        if (this.#presenceRooms.get(room) === joined) {
          this.#presenceRooms.delete(room);
        }
        if (this.#closed) return;
        await joined.joined.catch(() => undefined);
        await this.#client.request({
          type: "presence.leave",
          requestId: crypto.randomUUID(),
          space: this.space,
          sessionId: this.#sessionId,
          room,
        }).catch(() => undefined);
      },
    };
  }

  /** Applies one presence push from the relay to its room's observers. */
  handlePresence(message: PresenceUpsertMessage | PresenceRemoveMessage): void {
    const state = this.#presenceRooms.get(message.room);
    if (state === undefined) return;
    if (message.type === "presence/upsert") {
      const { participant } = message;
      const held = state.participants.get(participant.participantId);
      // The relay pushes only a revision above the one it last accepted for
      // a membership, so an older one here arrived out of order; the newer
      // record already shown is kept.
      if (held !== undefined && held.revision >= participant.revision) return;
      state.participants.set(participant.participantId, participant);
      this.#deliverPresence(state, { kind: "upsert", participant });
      return;
    }
    if (!state.participants.delete(message.participantId)) return;
    this.#deliverPresence(state, {
      kind: "remove",
      participantId: message.participantId,
    });
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

  /**
   * Replaces watches, or replays the owned set after queued changes apply.
   * `restore` is passed by `restore()` alone, for the watch set it
   * re-establishes.
   */
  async watchSetSync(
    watches: WatchSpec[] | undefined,
    holdings?: SessionHolding[],
    views?: ViewInterest[],
    restore?: typeof RESTORE_WATCH_SET,
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
          ...(holdings !== undefined
            ? { holdings: this.#client.declarableHoldings(holdings) }
            : {}),
        });
      },
      (result) => {
        this.#noteResult(result.serverSeq);
        // A replay sends `#watchSpecs` as it stands. The restore's replay does
        // not queue with other mutations, so one of them can change
        // `#watchSpecs` while its request is on the wire, and writing the sent
        // set back would undo that change.
        if (watches !== undefined) this.#replaceWatchSpecs(requestedWatches);
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
      { restoring: restore === RESTORE_WATCH_SET },
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
      try {
        observer(this.#closeError!);
      } catch (cause) {
        console.error("session-access-loss subscriber threw:", cause);
      }
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
          ? this.#client.declarableHoldings(this.#declaredHoldings())
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
    let watches: WatchSpec[] = [];
    return await this.#runWatchMutation(
      () =>
        this.#client.request<WatchSetResult>({
          type: "session.watch.set",
          requestId: crypto.randomUUID(),
          space: this.space,
          sessionId: this.#sessionId,
          watches,
        }),
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
      {
        // Cancellation is local intent from the moment this removal's turn
        // comes, while it waits for a restore and even when its request
        // fails: a reconnect must not restore a watch its last subscriber
        // removed.
        onTurn: () => {
          watches = this.#watchSpecs.filter((watch) => !removed.has(watch.id));
          this.#replaceWatchSpecs(watches);
        },
      },
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
    const run = ++this.#restoreRun;
    this.#cancelHeldRestore();
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
      // Reopened, the session no longer waits on its own retry. The restart
      // backoff starts over only once the whole restore succeeds: the watch
      // set can still be refused and hold the session again.
      const wasHeld = this.#held;
      this.#cancelHeldRestore();
      this.#held = false;
      this.#readyOnConnection = true;
      replayedThroughLocalSeq = Math.max(
        0,
        maxOf(this.#outstandingCommits.keys()),
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
        restored.resumed !== true &&
        (this.#watchSpecs.length > 0 || this.#viewInterests.length > 0)
      ) {
        this.#watchSetOwed = true;
      }
      if (this.#viewsDirty || this.#watchSetOwed) {
        // The server forgot this session (or never had it): re-establish
        // the watch set, declaring what the replica still holds so the
        // response carries the difference rather than the whole union.
        const { view, sync } = await this.watchSetSync(
          undefined,
          this.#declaredHoldings(),
          this.#viewsDirty || this.#viewInterests.length > 0
            ? this.#viewInterests
            : undefined,
          RESTORE_WATCH_SET,
        );
        this.#watchSetOwed = false;
        if (!isEmptySync(sync)) {
          view.emit(sync);
        }
      }
      this.#rejoinPresenceRooms();
      await Promise.all(replayTasks);
      this.#restoreComplete?.resolve();
      this.#restoreComplete = undefined;
      this.#heldRestores = 0;
      if (wasHeld) this.#client.noteHoldEnded();
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
      // A retriable denial of a session authenticated on the connection,
      // such as the router's while this space's toolshed is down, holds
      // this session alone: it retries on this connection with its own
      // backoff, keeping its commits and waiters, while the connection's
      // other sessions restore and new mounts proceed. A signed open's
      // retriable denial is an anti-replay race only a new connection's
      // challenge heals, so it still propagates.
      if (this.#holdsRestore(error)) {
        this.#holdRestore(
          (error as { [ROUTED_AUTH_REFUSAL]?: true })[ROUTED_AUTH_REFUSAL]
            ? ROUTED_RETRY_FLOOR_MS
            : 0,
        );
        return;
      }
      // A route cancelled during this restore ends the hold, as the abort
      // listener the restore removed would have.
      if (this.#routeSignal?.aborted) this.#endHold();
      throw error;
    } finally {
      if (run === this.#restoreRun) {
        this.#restoring = false;
        if (!this.#closed && this.#outstandingCommits.size > 0) {
          this.#replayOutstandingCommits(replayedThroughLocalSeq);
        }
      }
    }
  }

  /** Whether `restore()` holds this session on `error` rather than throwing. */
  #holdsRestore(error: unknown): boolean {
    return isRetriableAuthorizationError(error) &&
      typeof this.#auth === "object" &&
      this.#client.serverFlags?.connectionAuth === true;
  }

  /**
   * Helper for `restore()`, which retries this session's restore after the
   * reconnect backoff. A drop in the meantime cancels the retry, and the
   * client's reconnect restores the session instead.
   */
  #holdRestore(floorMs = 0): void {
    // After a denial in the watch phase the reopen has already made this
    // session ready. Only this keeps `restore()`'s `finally` from replaying
    // its commits, and `transact()` from sending new ones, before the
    // session is restored.
    this.#readyOnConnection = false;
    const signal = this.#routeSignal;
    // A route already cancelled, as it can be while the watch set is
    // re-established, ends the hold now, as a later cancellation would.
    if (signal?.aborted) {
      this.#endHold();
      return;
    }
    this.#held = true;
    // Closing the session or dropping the connection cancels this retry,
    // and `restore()` cancels it as it starts. `restore()` also does nothing
    // for a closed session and fails while disconnected, so the retry
    // checks neither. A router's refusal of the key's authentication passes
    // over seconds, so a retry after one waits a second or more.
    const timer = setTimeout(() => {
      void this.restore().catch((error) => {
        // A closed session needs no connection, and a cancelled route is
        // its owner's. Any other failure is what the reconnect loop
        // answers with a new connection, except a lost connection: a drop
        // has already started one, and a retry whose signer outlived its
        // connection must not discard the connection that replaced it.
        if (!this.#closed && !signal?.aborted && !isConnectionError(error)) {
          this.#client.restartConnection(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
    }, Math.max(floorMs, reconnectDelayMs(this.#heldRestores++)));
    // A route cancelled while the session waits ends the wait.
    const abort = () => this.#endHold();
    signal?.addEventListener("abort", abort, { once: true });
    this.#heldRestore = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
  }

  #cancelHeldRestore(): void {
    const cancel = this.#heldRestore;
    this.#heldRestore = undefined;
    cancel?.();
  }

  /**
   * Ends a hold other than by a drop: the session reopened, closed, ended or
   * lost its route. Once no session is held, the client's restarts back off
   * from the start again.
   */
  #endHold(): void {
    this.#cancelHeldRestore();
    if (!this.#held) return;
    this.#held = false;
    this.#client.noteHoldEnded();
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#closeError = new Error("memory session closed");
    this.#endHold();
    if (
      this.#client.serverFlags?.sessionClose === true &&
      this.#client.isConnected() && this.#readyOnConnection
    ) {
      // The server ends the session, and with it the session's presence
      // memberships. The response is not waited for.
      void this.#client.request({
        type: "session.close",
        requestId: crypto.randomUUID(),
        space: this.space,
        sessionId: this.#sessionId,
      }).catch(() => undefined);
    } else {
      // The relay keeps a membership until it hears otherwise, and a closed
      // session sends nothing further on its own, so each room is left now;
      // the leave is not waited for.
      for (const state of this.#presenceRooms.values()) {
        void this.#client.request({
          type: "presence.leave",
          requestId: crypto.randomUUID(),
          space: this.space,
          sessionId: this.#sessionId,
          room: state.room,
        }).catch(() => undefined);
      }
    }
    // Observers hear the close as a failure.
    this.#endPresenceRooms(this.#closeError);
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
    this.#endHold();
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
    this.#endPresenceRooms(error);
    const observers = [...this.#accessLossObservers];
    this.#accessLossObservers.clear();
    if (isPermanentAuthorizationError(error)) {
      for (const observer of observers) {
        try {
          observer(error);
        } catch (cause) {
          console.error("session-access-loss subscriber threw:", cause);
        }
      }
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
    // The next connection restores this session; a held retry belongs to
    // the connection that is gone.
    this.#held = false;
    this.#cancelHeldRestore();
    this.#heldRestores = 0;
    this.#readyOnConnection = false;
    // The restore this session now needs is pending from here on, so a
    // request made before the reconnect reaches it waits for it.
    if (this.#restoreComplete === undefined) {
      this.#restoreComplete = Promise.withResolvers<void>();
      this.#restoreComplete.promise.catch(() => {});
    }
  }

  async #joinPresence(state: PresenceRoomState): Promise<void> {
    const result = await this.#client.request<PresenceJoinResult>({
      type: "presence.join",
      requestId: crypto.randomUUID(),
      space: this.space,
      sessionId: this.#sessionId,
      room: state.room,
    });
    state.participantId = result.participantId;
    state.participants = new Map(
      result.participants.map((participant) => [
        participant.participantId,
        participant,
      ]),
    );
  }

  /**
   * Sends the room's record at `revision` once the session is restored and
   * the current join has settled — a reconnect in progress reopens the
   * session and rejoins the room, and a publication sent before either has
   * completed would be refused as not joined. A publication overtaken by a
   * newer one while it waited is not sent: the relay wants only the latest,
   * and it refuses a revision that does not advance. A connection error is
   * not reported, since the reconnect that follows rejoins and republishes;
   * any other refusal reaches the observers.
   */
  #publishPresence(state: PresenceRoomState, revision: number): void {
    const publication = state.publication;
    if (publication === null) return;
    const send = async (): Promise<void> => {
      // A restore that begins while the join is awaited replaces it, so the
      // wait is repeated until the join awaited is still the room's.
      for (;;) {
        const joined = state.joined;
        await this.#ensureSessionRestored();
        await joined;
        if (state.joined === joined) break;
      }
      if (
        this.#closed || state.revision !== revision ||
        this.#presenceRooms.get(state.room) !== state
      ) {
        return;
      }
      await this.#client.request({
        type: "presence.publish",
        requestId: crypto.randomUUID(),
        space: this.space,
        sessionId: this.#sessionId,
        room: state.room,
        revision,
        name: publication.name,
        facets: publication.facets,
      });
    };
    void send().catch((error) => {
      if (isConnectionError(error) || this.#closed) return;
      this.#deliverPresence(state, {
        kind: "failure",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
  }

  /**
   * Rejoins every room after the session is re-established, delivering the
   * new snapshot and republishing the last record at a fresh revision. The
   * relay assigned a new participant id with the new connection, so a
   * snapshot rather than an upsert is what tells the observers.
   */
  #rejoinPresenceRooms(): void {
    for (const state of this.#presenceRooms.values()) {
      state.joined = this.#joinPresence(state);
      void state.joined.then(() => {
        if (this.#presenceRooms.get(state.room) !== state) return;
        this.#deliverPresence(state, {
          kind: "snapshot",
          participantId: state.participantId,
          participants: [...state.participants.values()],
        });
        if (state.publication !== null) {
          state.revision += 1;
          this.#publishPresence(state, state.revision);
        }
      }).catch((error) => {
        if (isConnectionError(error) || this.#closed) return;
        this.#deliverPresence(state, {
          kind: "failure",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    }
  }

  #deliverPresence(state: PresenceRoomState, event: PresenceEvent): void {
    for (const observer of state.observers) {
      this.#deliverPresenceTo(observer, event);
    }
  }

  #deliverPresenceTo(
    observer: (event: PresenceEvent) => void,
    event: PresenceEvent,
  ): void {
    try {
      observer(event);
    } catch (cause) {
      console.error("presence observer threw:", cause);
    }
  }

  /** Ends every room with `error`, telling each observer once. */
  #endPresenceRooms(error: Error): void {
    const rooms = [...this.#presenceRooms.values()];
    this.#presenceRooms.clear();
    for (const state of rooms) {
      this.#deliverPresence(state, { kind: "failure", error });
    }
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
   *
   * A mutation whose turn comes while its session is disconnected or has not
   * reopened keeps the turn and waits in it until the restore completes, so
   * mutations reach the wire in call order across a reconnect. `onTurn` runs
   * when the turn comes, before that wait. `restoring` marks the watch set
   * `restore()` re-establishes, which does not queue here at all.
   */
  async #runWatchMutation<R, T>(
    send: () => Promise<R>,
    apply: (result: R) => T,
    sendAfter: "issue" | "apply" = "issue",
    options: { restoring?: boolean; onTurn?: () => void } = {},
  ): Promise<T> {
    this.#assertOpen();
    if (options.restoring === true) {
      return await this.#sendRestoreWatchMutation(send, apply);
    }
    const { onTurn } = options;
    if (!this.#concurrentWatchRefresh) {
      // Single-flight (default): send + apply run together, chained on the
      // prior mutation's completion. Nothing is issued until the previous
      // mutation fully resolves. `apply` runs in the microtask cascade
      // rooted at the response frame's delivery, and one-frame-per-turn
      // transports (loopback included) cannot deliver a later effect frame
      // until that cascade completes — so no handleEffect can mutate the
      // watch view between the response resolving and `apply` running.
      const previous = this.#watchApply;
      const current: Promise<T> = previous.catch(() => undefined).then(
        async () => {
          onTurn?.();
          while (this.#watchMutationWaitsForRestore()) {
            await this.#waitForSessionRestore();
          }
          this.#assertOpen();
          this.#lastSentWatchMutation = current;
          return apply(await send());
        },
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
    const issued = readyToIssue.catch(() => undefined).then(async () => {
      onTurn?.();
      while (this.#watchMutationWaitsForRestore()) {
        await this.#waitForSessionRestore();
      }
      this.#assertOpen();
      this.#lastSentWatchMutation = current;
      response = send();
      // Attach a rejection handler immediately: a later request may reject
      // while an earlier mutation is still pending, which would otherwise
      // surface as an unhandled rejection even though the caller-facing
      // apply-chain promise below has its own catch.
      response.catch(() => undefined);
    });
    this.#watchIssue = issued.then(() => undefined, () => undefined);

    const current: Promise<T> = Promise.all([
      previousApply.catch(() => undefined),
      issued,
    ]).then(() => response).then((result) => apply(result));
    this.#watchApply = current.then(() => undefined, () => undefined);
    return await current;
  }

  /**
   * Whether a watch mutation sent now would reach a session its server does
   * not have open: the connection is down, or this session has not reopened
   * on the current connection. The second is separate because a session's
   * restore takes as long as its own reopening takes, so a session can sit
   * connected with its restore unfinished. `#readyOnConnection` is false
   * only while a reconnect is running, while this session's restore is
   * pending, or once the session has closed, and `#waitForSessionRestore()`
   * waits on the first two and throws on the third, so a turn waiting on this
   * never spins.
   */
  #watchMutationWaitsForRestore(): boolean {
    return !this.#client.isConnected() || !this.#readyOnConnection;
  }

  /**
   * Helper for `#runWatchMutation()`, which waits for this session's restore,
   * if one is pending, and otherwise for the reconnect in progress, if any.
   * The caller checks `#watchMutationWaitsForRestore()` again afterwards, in
   * the same synchronous step as its send, since the connection can drop in
   * between. Throws the session's close error when the session closes, and the
   * client's error when it gives up reconnecting.
   */
  async #waitForSessionRestore(): Promise<void> {
    this.#assertOpen();
    if (this.#restoreComplete !== undefined) {
      await this.#restoreComplete.promise;
    } else if (!this.#client.isConnected()) {
      await this.#client.restoreConnection();
    }
  }

  /**
   * Helper for `restore()`, which sends the watch set it re-establishes
   * without queuing on the watch-mutation chain. Mutations waiting on that
   * chain hold their turns until the restore completes, so queuing behind
   * them would wait on the restore itself; they follow it instead, in call
   * order. The re-establishment is sent after the last mutation already on the
   * wire has been applied.
   */
  async #sendRestoreWatchMutation<R, T>(
    send: () => Promise<R>,
    apply: (result: R) => T,
  ): Promise<T> {
    for (;;) {
      const last = this.#lastSentWatchMutation;
      await last?.then(() => undefined, () => undefined);
      if (this.#lastSentWatchMutation === last) break;
    }
    this.#throwIfDisconnectedDuringRestore();
    return apply(await send());
  }

  /**
   * Helper for `restore()`, which throws a connection error when the client
   * is no longer connected. A request `restore()` made then would wait for
   * the reconnect that is running this restore; the error makes the reconnect
   * retry instead. Called synchronously before each such request, so no drop
   * can land between the check and the request's own.
   */
  #throwIfDisconnectedDuringRestore(): void {
    if (!this.#client.isConnected()) {
      throw toConnectionError(
        new Error("memory connection lost while restoring the session"),
      );
    }
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
      ...(this.#spaceKindIntent === undefined
        ? {}
        : { spaceKind: this.#spaceKindIntent }),
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
    const holdings = this.#declaredHoldings();
    const restored = await runWithAbortSignal(
      this.#routeSignal,
      "memory session route cancelled",
      () => {
        this.#throwIfDisconnectedDuringRestore();
        return this.#client.openSession(
          this.space,
          session,
          this.#auth,
          holdings,
          { restoring: true },
        );
      },
    );
    const sessionChanged = restored.sessionId !== oldSessionId;
    const sessionReplaced = sessionChanged || restored.resumed !== true;
    this.#sessionId = restored.sessionId;
    this.#sessionToken = restored.sessionToken ?? this.#sessionToken;
    this.#declaredSpaceKind = declaredSpaceKindOf(restored);
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
    pendingCommit: OutstandingCommit,
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
          // A commit whose own write fails on one new connection after
          // another is at fault itself, and replaying it again would only take
          // the next connection down with it. It is rejected with the write's
          // error rather than a `ConnectionError`, which a caller would retry.
          if (isOwnWriteFailure(error)) {
            pendingCommit.writeFailures = (pendingCommit.writeFailures ?? 0) +
              1;
          }
          if ((pendingCommit.writeFailures ?? 0) >= MAX_COMMIT_WRITE_FAILURES) {
            if (this.#outstandingCommits.get(localSeq) === pendingCommit) {
              this.#outstandingCommits.delete(localSeq);
            }
            const cause = (error as Error).cause;
            pendingCommit.pending.reject(
              cause instanceof Error
                ? cause
                : new Error((error as Error).message, { cause }),
            );
          }
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
  // Frames queued and frames handed over since the transport opened. A
  // `delivered()` caller waits for `handedOver` to reach the `queued` it saw,
  // so frames queued after its call never extend its wait.
  let queued = 0;
  let handedOver = 0;
  // Callers of `delivered()`, in call order and so in order of their targets.
  const deliveryWaiters: { target: number; resolve: () => void }[] = [];
  const releaseWaiters = () => {
    while (
      deliveryWaiters.length > 0 &&
      (closed || deliveryWaiters[0].target <= handedOver)
    ) {
      deliveryWaiters.shift()!.resolve();
    }
  };
  const drainOne = () => {
    turn = null;
    if (closed) return;
    const frame = queue.shift();
    if (frame === undefined) return;
    handedOver++;
    receiver(frame);
    if (queue.length > 0) schedule();
    releaseWaiters();
  };
  const schedule = () => {
    turn ??= armTurn(drainOne);
  };
  const connection = server.connect((message) => {
    if (closed) return;
    queue.push(encodeMemoryBoundary(message));
    queued++;
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
      releaseWaiters();
      connection.close();
      return Promise.resolve();
    },
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver() {},
    delivered() {
      if (closed || handedOver >= queued) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      deliveryWaiters.push({ target: queued, resolve });
      return promise;
    },
  };
};

/**
 * Returns an error named `ConnectionError`: the name the client reads as a
 * request that reached no verdict because its connection was lost or could not
 * be opened. A transport rejects a send with one under the conditions
 * `Transport.send()` describes.
 */
export const connectionError = (message: string, cause?: unknown): Error => {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "ConnectionError";
  return error;
};

/**
 * Like `connectionError()`, except that it also marks the payload's own write
 * as what failed, on a connection that was open until then, as opposed to a
 * payload lost because the connection closed under it. The client counts such
 * failures against a commit, and stops replaying a commit whose own write has
 * failed `MAX_COMMIT_WRITE_FAILURES` times.
 */
export const writeFailedError = (message: string, cause?: unknown): Error =>
  Object.assign(connectionError(message, cause), { ownWriteFailed: true });

/**
 * How many attempts may fail because one commit's own write failed before the
 * client stops replaying it and rejects it with the write's error.
 */
const MAX_COMMIT_WRITE_FAILURES = 5;

const isOwnWriteFailure = (error: unknown): boolean =>
  (error as { ownWriteFailed?: unknown } | null)?.ownWriteFailed === true;

const toConnectionError = (error?: Error): Error =>
  connectionError(error?.message ?? "memory transport closed", error);

/**
 * The errors `Client.request()` built from a server response. Each is the
 * server's verdict on a request, whatever its message says, so none of them is
 * a lost connection.
 */
const serverVerdicts = new WeakSet<Error>();

const isConnectionError = (error: unknown): boolean =>
  error instanceof Error && !serverVerdicts.has(error) &&
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

/**
 * Whether `error` is an authorization denial the server marked `retriable`:
 * an anti-replay race (an expired, used, or mismatched challenge, a stale
 * signed `exp`) or a lease that has run out, each of which a new signature
 * heals.
 */
const isRetriableAuthorizationError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AuthorizationError" &&
  (error as { retriable?: unknown }).retriable === true;

/**
 * Whether `error` is an authorization denial retrying cannot change. A
 * retriable auth failure — an anti-replay race the server marked `retriable`
 * (an expired/used/mismatched challenge, a stale signed `exp`) — is excluded,
 * so the client keeps reopening through a token-refresh window or a challenge
 * race a fresh handshake heals.
 */
export function isPermanentAuthorizationError(error: unknown): boolean {
  return error instanceof Error && error.name === "AuthorizationError" &&
    (error as { retriable?: unknown }).retriable !== true;
}

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
    deployment?: unknown;
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
    audience: sessionOpen.deployment === undefined ||
        isCanonicalEd25519DID(sessionOpen.audience)
      ? sessionOpen.audience
      : (() => {
        throw protocolError("malformed routed audience");
      })(),
    ...(sessionOpen.deployment === undefined ? {} : {
      deployment: requireDeployment(sessionOpen.deployment),
    }),
    challenge: {
      value: challenge.value,
      expiresAt: challenge.expiresAt,
    },
  };
};

const requireDeployment = (value: unknown): string => {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,256}$/.test(value)) {
    throw protocolError("memory server sent malformed routed deployment");
  }
  return value;
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

const isSessionAdmissible = (
  message: unknown,
): message is SessionAdmissibleMessage =>
  isPlainObject(message) && message.type === "session/admissible" &&
  typeof message.space === "string" && typeof message.principal === "string";

const isPresencePush = (
  message: unknown,
): message is PresenceUpsertMessage | PresenceRemoveMessage => {
  if (!isPlainObject(message)) return false;
  const { type, space, sessionId, room } = message;
  return (type === "presence/upsert" || type === "presence/remove") &&
    typeof space === "string" &&
    typeof sessionId === "string" &&
    typeof room === "string";
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
