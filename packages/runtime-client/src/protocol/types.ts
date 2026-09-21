import type { CellScope } from "@commonfabric/api";
import type { CfcAtom } from "@commonfabric/api/cfc";
import type {
  FabricArray,
  FabricPlainObject,
  FabricValue,
} from "@commonfabric/data-model";
import type {
  FabricBytes,
  FabricKeyPair,
} from "@commonfabric/data-model/fabric-primitives";
import type { DID } from "@commonfabric/identity";
import { type Program } from "@commonfabric/js-compiler/interface";
import type {
  ApplyOpResolution,
  DeliveryAttention,
  EventAttentionResolution,
  OpCursor,
  OperationFieldSnapshot,
} from "@commonfabric/memory/v2";
import type { MetaField } from "@commonfabric/runner";
import type { CfcConfClause } from "@commonfabric/runner/cfc";
import type { CfcLabelView } from "@commonfabric/runner/cfc/label-view-core";
import type {
  ActionRunTraceEntry,
  JSONObject,
  JSONSchema,
  JSONValue,
  NormalizedFullLink,
  PatternCoverageData,
  RuntimeTelemetryMarkerResult,
  SchedulerDiagnosisResult,
  SchedulerGraphSnapshot,
  SettleStats,
  SettleStatsHistoryEntry,
  TriggerTraceEntry,
  WriteStackTraceEntry,
  WriteStackTraceMatcher,
} from "@commonfabric/runner/shared";
export type { JSONObject, JSONSchema, JSONValue, Program };

export type { CfcLabelView };

/**
 * Identifies one request and the response answering it. The client allocates
 * them and the worker echoes back what it was sent, so an unmatched id on
 * either side means a message was lost rather than mis-addressed.
 */
export type MessageId = number;

/**
 * A cell as this connection names it: a normalized link, plus the cell's
 * display label where the read asked for one. This is what a `CellHandle`
 * becomes on the wire, and what one is rebuilt from at the other end.
 */
export type CellRef = NormalizedFullLink & {
  /**
   * The cell's display label, present only where the read that produced
   * this ref asked for one.
   */
  cfcLabelView?: CfcLabelView;
};

/** A piece as this connection names it, by the cell that holds it. */
export type PieceRef = {
  /**
   * The cell holding the piece.
   */
  cell: CellRef;
};

/**
 * The requests a client sends the worker. Every one is answered, whether or
 * not it carries data back: a request whose handler returns nothing is acked
 * with a bare envelope, which many members here do -- the `Set*` and `Reset*`
 * ones, and others besides. {@link Commands} is where a given request's
 * answer is settled.
 */
export enum RequestType {
  // Lifecycle

  /**
   * Stands the worker's runtime up from an {@link InitializationData}. Refused
   * if initialization has already been attempted, successfully or not.
   */
  Initialize = "initialize",

  /**
   * Joins a client to the runtime a first client already stood up, over a
   * duplex of its own. It carries the {@link RuntimeSecurityContext} the
   * joining client believes it is joining, and is refused when that disagrees
   * with the one the runtime runs under -- a runtime acts as one principal
   * under one enforcement configuration, and an attach never merges a second.
   * Refused too before any {@link RequestType.Initialize}: an attach joins a
   * runtime rather than standing one up.
   */
  Attach = "attach",

  /**
   * Tears down what the requesting client owns. From the client that
   * initialized the runtime that is the runtime itself; from an attached one
   * it is that client's own subscriptions and mounts, the runtime and every
   * other client's work left running. Requests arriving after it are acked in
   * silence rather than refused, teardown running concurrently with whatever
   * the client had in flight.
   */
  Dispose = "dispose",

  // Cell operations (main -> worker)

  /**
   * Reads a cell's value, optionally with its display CFC label and a ref to
   * the cell the read resolved to.
   */
  CellGet = "cell:get",

  /**
   * Pulls a cell through the scheduler before reading it. Unlike
   * {@link CellGet}, this demands lazy producers and waits for their
   * transitive work to settle.
   */
  CellPull = "cell:pull",

  /**
   * Stores a value only when the cell has no backing value, using the raw read
   * as an optimistic-concurrency precondition. A schema fallback does not
   * count as stored. Returns the value that won.
   */
  CellInitialize = "cell:initialize",

  /**
   * Overwrites a cell's value blindly: the write carries no value-equality
   * precondition, so a concurrent write to the same cell does not make it
   * fail. That is not the same as unconditional. A blind write still carries
   * one structural precondition, on the cell's *parent*, so a concurrent
   * delete of the enclosing document or a reshape of an ancestor rejects it.
   * Which of this and {@link CellPush} a write uses is decided by the request
   * type rather than by inspecting the value.
   */
  CellSet = "cell:set",

  /**
   * Appends values to an array cell as a mergeable server-side operation.
   * The counterpart to {@link CellSet}'s blind overwrite.
   */
  CellPush = "cell:push",

  /**
   * Sends an event to a cell in a transaction of its own. Local visibility
   * lands with the commit; remote confirmation is not waited for, so that a
   * slow server cannot block cell IPC.
   */
  CellSend = "cell:send",

  /**
   * Starts notifying the client of a cell's changes, optionally including its
   * display label with each.
   */
  CellSubscribe = "cell:subscribe",

  /** Stops the notifications {@link CellSubscribe} started. */
  CellUnsubscribe = "cell:unsubscribe",

  /**
   * Follows a cell's aliases to the cell it stands for, answering with a ref
   * to that one.
   */
  CellResolveAsCell = "cell:resolveAsCell",

  /** Reads a cell's display CFC label, without its value. */
  CellGetCfcLabel = "cell:getCfcLabel",

  /** Prepares an exact snapshot and audience for trusted host confirmation. */
  SnapshotSharePrepare = "snapshotShare:prepare",

  /** Commits one client-owned snapshot confirmation without authored claims. */
  SnapshotShareCommit = "snapshotShare:commit",

  /** Discards an unconfirmed snapshot owned by this client. */
  SnapshotShareCancel = "snapshotShare:cancel",

  /** Lists the operation codecs available for a cell. */
  OperationCapabilities = "operation:capabilities",

  /** Reads a cell's operation-backed state and retained operation tail. */
  OperationQuery = "operation:query",

  /** Applies one codec-specific operation to a cell. */
  OperationApply = "operation:apply",

  /** Releases retained operations through a cursor. */
  OperationRelease = "operation:release",

  /** Starts notifying the client of a cell's operation-backed changes. */
  OperationSubscribe = "operation:subscribe",

  /** Stops an operation subscription. */
  OperationUnsubscribe = "operation:unsubscribe",

  /** Forgets a client's pinned operation target. */
  OperationSessionClose = "operation:session-close",

  /** Runs a read-only SQL query against a SQLite database cell. */
  SqliteQuery = "sqlite:query",

  /** Commits a SQL write through a SQLite database cell. */
  SqliteExec = "sqlite:exec",

  // Runtime operations

  /**
   * Derives a cell from a space, a cause, and an optional schema, answering
   * with a ref to it.
   */
  GetCell = "runtime:getCell",

  /** Answers with a ref to the home space's own cell. */
  GetHomeSpaceCell = "runtime:getHomeSpaceCell",

  /**
   * Ensures the home space's default pattern is running, answering with a ref
   * to it. Always through the pieces controller, which reconciles the
   * persisted identity and repairs an aged home root -- starting the pattern
   * directly would skip that repair, and nothing else performs it.
   */
  EnsureHomePatternRunning = "runtime:ensureHomePatternRunning",

  /**
   * Waits for reactive quiescence *and* for every issued commit to be durable.
   * The client reads that pair as the point at which navigating or reloading
   * is safe, so quiescence alone is a weaker condition than this reports.
   */
  Idle = "runtime:idle",

  /** Lists unresolved terminal event-delivery notices for a space. */
  ListEventAttention = "runtime:listEventAttention",

  /** Retries or dismisses one terminal event-delivery notice. */
  ResolveEventAttention = "runtime:resolveEventAttention",

  /**
   * Waits for every opened space to finish syncing. {@link PieceSynced} is the
   * same wait narrowed to one space.
   */
  RuntimeSynced = "runtime:synced",

  /** Resolves a space's name to its DID. */
  ResolveSpaceName = "runtime:resolveSpaceName",

  /**
   * Routes one space's storage to a named host, answering with whether the
   * route was accepted. The host is validated here and acceptance is the
   * storage manager's to decide, so a manager with no remote resolution
   * declines every route. A host that does not validate is refused with an
   * error rather than a `false`.
   */
  RegisterSpaceHost = "runtime:registerSpaceHost",

  /** Waits for the pattern manager's compile-cache writes to land. */
  FlushCompileCacheWrites = "runtime:flushCompileCacheWrites",

  /** Answers with a snapshot of the scheduler's reactive graph. */
  GetGraphSnapshot = "runtime:getGraphSnapshot",

  /**
   * Answers with the logger counts, metadata, timings, and flags together, one
   * round trip covering all four.
   */
  GetLoggerCounts = "runtime:getLoggerCounts",

  /**
   * Answers with the pattern coverage collector's data, or `null` where this
   * worker was built without a collector -- which is a different state from a
   * collector that recorded nothing.
   */
  GetPatternCoverage = "runtime:getPatternCoverage",

  /** Sets one named logger's level, or every logger's when none is named. */
  SetLoggerLevel = "runtime:setLoggerLevel",

  /**
   * Enables or disables one named logger, or every logger when none is named.
   */
  SetLoggerEnabled = "runtime:setLoggerEnabled",

  /** Turns telemetry notifications on or off. */
  SetTelemetryEnabled = "runtime:setTelemetryEnabled",

  /** Enables read measurements on subsequent reactive action bodies. */
  SetReadStatsEnabled = "runtime:setReadStatsEnabled",

  /** Changes memory WebSocket compression without reconnecting. */
  SetMemoryMessageCompression = "runtime:setMemoryMessageCompression",

  /**
   * Turns the worker's console bridge on or off. Answered by the worker entry
   * rather than by the runtime -- the console patch lives there -- and so
   * answered whether or not the runtime is initialized.
   */
  SetForwardWorkerConsole = "runtime:setForwardWorkerConsole",

  /**
   * Resets every logger's count and timing baseline, so that reads after it
   * measure from here rather than from worker start.
   */
  ResetLoggerBaselines = "runtime:resetLoggerBaselines",

  /**
   * Answers with the scheduler's settle statistics from the last settle pass.
   * `null` covers two states and does not distinguish them: recording is off,
   * or it is on and no pass has completed yet.
   */
  GetSettleStats = "runtime:getSettleStats",

  /** Answers with the settle statistics recorded per pass, oldest first. */
  GetSettleStatsHistory = "runtime:getSettleStatsHistory",

  /**
   * Turns settle-statistics recording on or off. Off by default, the
   * collection costing something per settle pass. Turning it *off* also
   * discards the statistics and history already collected, so a client that
   * toggles it loses what it had.
   */
  SetSettleStatsEnabled = "runtime:setSettleStatsEnabled",

  /** Answers with the recorded per-action run trace. */
  GetActionRunTrace = "runtime:getActionRunTrace",

  /**
   * Turns action-run tracing on or off. Off by default, and turning it off
   * also discards the trace already collected.
   */
  SetActionRunTraceEnabled = "runtime:setActionRunTraceEnabled",

  /** Answers with the recorded trigger trace. */
  GetTriggerTrace = "runtime:getTriggerTrace",

  /**
   * Turns trigger tracing on or off. Off by default, and turning it off also
   * discards the trace already collected.
   */
  SetTriggerTraceEnabled = "runtime:setTriggerTraceEnabled",

  /** Answers with the recorded write stack traces. */
  GetWriteStackTrace = "runtime:getWriteStackTrace",

  /**
   * Replaces the matchers deciding which writes have their stack recorded.
   * Recording every write is expensive, so the matchers are the throttle.
   */
  SetWriteStackTraceMatchers = "runtime:setWriteStackTraceMatchers",

  /**
   * Runs the scheduler's non-idempotency diagnosis for a bounded period,
   * answering with what it found.
   */
  DetectNonIdempotent = "runtime:detectNonIdempotent",

  /**
   * Answers with the source of every pattern in the scheduler's graph, one
   * entry per distinct pattern rather than per node.
   */
  GetPatternSources = "runtime:getPatternSources",

  /** Replaces the scheduler's breakpoints with the named actions. */
  SetBreakpoints = "runtime:setBreakpoints",

  /**
   * Uploads bytes to the named space's host, answering with the blob's id and
   * URL. The space is required and refused when absent, an upload without one
   * otherwise failing as a confusing server 404.
   */
  UploadBlob = "runtime:uploadBlob",

  // Piece operations (main -> worker)

  /**
   * Answers with a space's root pattern, creating it if the space has none.
   */
  GetSpaceRootPattern = "pattern:getSpaceRoot",

  /** Replaces a space's root pattern with a freshly created one. */
  RecreateSpaceRootPattern = "pattern:recreateSpaceRoot",

  /**
   * Creates a piece in a space from a URL or a program, optionally running it
   * once created.
   */
  PieceCreate = "piece:create",

  /** Reads a piece by id, optionally running it. */
  PieceGet = "piece:get",

  /** Reads a piece's slug, which a piece need not have. */
  PieceGetSlug = "piece:getSlug",

  /**
   * Answers with the piece a slug reference names, without starting it: the
   * piece the slug reaches, or the member of the collection it names.
   */
  SlugResolve = "slug:resolve",

  /** Removes a piece from its space's list. */
  PieceRemove = "piece:remove",

  /** Starts a piece running. */
  PieceStart = "piece:start",

  /** Stops a running piece. */
  PieceStop = "piece:stop",

  /**
   * Answers with a ref to the cell holding a space's piece registry. The
   * pieces themselves are read from that cell, not carried here.
   */
  PieceGetAll = "piece:getAll",

  /**
   * Waits for one space's pieces to finish syncing, {@link RuntimeSynced}
   * being the same wait across every opened space.
   */
  PieceSynced = "piece:synced",

  /** Reads a piece's current source. */
  PieceGetSource = "piece:getSource",

  /** Reads one named revision of a piece's source. */
  PieceGetSourceRevision = "piece:getSourceRevision",

  /**
   * Copies a piece into another space, optionally seeding the copy with
   * snapshots of the source piece's durable data.
   */
  PieceClone = "piece:clone",

  /**
   * Applies a source action to a piece. An incompatible update answers with a
   * warning and a token rather than proceeding; sending the token back is what
   * confirms it.
   */
  PieceUpdateSource = "piece:updateSource",

  /** Reads a space's access list. */
  SpaceGetAcl = "space:getAcl",

  /** Grants one user a capability on a space, replacing any they held. */
  SpaceSetAclEntry = "space:setAclEntry",

  /** Removes one user's entry from a space's access list. */
  SpaceRemoveAclEntry = "space:removeAclEntry",

  // VDOM operations (main -> worker)

  /**
   * Starts rendering a cell as VDOM under a client-chosen mount id, answering
   * with the tree's root node.
   */
  VDomMount = "vdom:mount",

  /** Stops the rendering {@link VDomMount} started, by its mount id. */
  VDomUnmount = "vdom:unmount",
}

/**
 * One-way client-to-worker notifications. Unlike a request, one of these
 * carries no `msgId` and is not answered, which suits a signal the client
 * does not wait on.
 */
export enum ClientNotificationType {
  /** Delivers a DOM event to the handler a rendered node registered. */
  VDomEvent = "vdom:event",

  /**
   * Reports that a batch reached the DOM, by mount and batch id. The worker
   * holds back the retirement of an event handler whose node a batch removed
   * until that batch is acked, so an event dispatched against a node the
   * client had not yet stopped showing still finds its handler. Nothing about
   * this paces what the worker sends -- ops flush on a microtask regardless.
   */
  VDomBatchApplied = "vdom:batch-applied",
}

/**
 * The worker's unsolicited messages to the client: what it reports rather than
 * what it answers. None carries a `msgId`, and none is replied to.
 */
export enum NotificationType {
  /** Reports a new value for a cell the client subscribed to. */
  CellUpdate = "cell:update",

  /**
   * Carries one `console.*` call made by a pattern, with its arguments as
   * values rather than as rendered text. Distinct from the worker's own
   * console output, which the transport handles.
   */
  ConsoleMessage = "callback:console",

  /** Asks the client to navigate to a cell a pattern named. */
  NavigateRequest = "callback:navigate",

  /**
   * Reports an error that surfaced with no request to fail: a renderer error,
   * or one raised by a pattern between requests.
   */
  ErrorReport = "callback:error",

  /** Reports authoritative loss of the runtime principal's access to a space. */
  SpaceAccessLost = "callback:space-access-lost",

  /** Carries one telemetry marker, sent only while telemetry is enabled. */
  Telemetry = "callback:telemetry",

  /** Carries a batch of DOM mutations for the client's applicator to apply. */
  VDomBatch = "vdom:batch",

  /**
   * Mirrors the storage manager's durability barrier, so the client can tell
   * whether a reload would drop an unconfirmed write.
   */
  PendingWritesChanged = "callback:pending-writes",

  /** Reports a new operation-backed snapshot for a subscription. */
  OperationUpdate = "operation:update",

  /** Reports one authoritative terminal event-delivery notice. */
  EventNeedsAttention = "callback:event-needs-attention",
  EventIntentOutcome = "callback:event-intent-outcome",
}

/**
 * Worker-to-main-thread signals the transport acts on itself, rather than
 * forwarding to the connection. Their own enum because they are the channel's
 * traffic rather than the runtime's: one settles the channel and one annotates
 * it, and no `RuntimeConnection` ever sees either.
 */
export enum TransportNotificationType {
  /**
   * The worker's entry has run and its message listener is installed; see
   * {@link WorkerReadyNotification}.
   */
  WorkerReady = "worker:ready",

  /**
   * One line of the worker's own console output, forwarded for the page
   * console; see {@link WorkerConsoleNotification}.
   */
  WorkerConsole = "worker:console",
}

/**
 * Main-thread-to-worker signals the worker entry acts on itself, rather than
 * handing to the runtime. The mirror of {@link TransportNotificationType}, and
 * its own enum for the same reason: this is the channel's traffic, and no
 * `RuntimeProcessor` ever sees it.
 */
export enum ClientTransportNotificationType {
  /**
   * Hands the worker one end of a duplex a further client will speak over;
   * see {@link AttachPortNotification}.
   */
  AttachPort = "client:attach-port",
}

/**
 * Gives the worker a duplex for a new client. The port itself rides the
 * `postMessage` transfer list rather than this message -- a port is not a
 * `FabricValue` and has no encoding -- so what crosses here is the marker that
 * says what the transferred port is for.
 *
 * Accepted only from the client that initialized the runtime, which is the one
 * that owns the worker. A client that arrived over a port does not get to
 * enlarge the family it joined.
 */
export type AttachPortNotification = {
  type: ClientTransportNotificationType.AttachPort;
};

/**
 * A request together with the id its answer will carry. The only shape the
 * client sends that expects a reply -- a notification carries neither.
 */
export type IPCClientMessage = {
  /**
   * Identifies this request, and the response that will answer it.
   */
  msgId: MessageId;

  /**
   * The request itself.
   */
  data: IPCClientRequest;
};

/**
 * Codes naming a failure the client can act on, carried alongside an error
 * response or report. A failure with no code is an ordinary one, distinguished
 * only by its message.
 */
export enum RuntimeErrorCode {
  /**
   * The worker could not load its compiler stack, so nothing it was asked to
   * compile can run. Distinguished because the client's remedy is a reload
   * rather than a retry.
   */
  CompilerStackLoadFailed = "compiler-stack-load-failed",
}

/**
 * One answer to one request, matched to it by `msgId`. Either arm may carry
 * nothing beyond that id: a success whose handler returned nothing, and an
 * error whose `code` is absent because no code names its kind.
 */
export type IPCRemoteResponse = {
  /**
   * The request this answers.
   */
  msgId: MessageId;

  /**
   * What the handler returned, absent where it returned nothing.
   */
  data?: RemoteResponse;
} | {
  /**
   * The request this answers.
   */
  msgId: MessageId;

  /**
   * What went wrong, as text. Its presence is what makes this the
   * failure arm.
   */
  error: string;

  /**
   * Names the kind of failure where one is named; an ordinary failure
   * carries no code.
   */
  code?: RuntimeErrorCode;
};

/**
 * What the connection receives from the worker: an answer to a request, or
 * something the worker reports unasked. The transport's own traffic is not
 * among it, having been handled before dispatch.
 */
export type IPCRemoteMessage = IPCRemoteNotification | IPCRemoteResponse;

/** The notifications the transport handles itself. */
export type IPCTransportNotification =
  | WorkerReadyNotification
  | WorkerConsoleNotification;

/**
 * Everything the worker posts: what the connection receives, plus what the
 * transport intercepts on the way to it. One type for one send, which is what
 * `postToClient()` takes.
 */
export type IPCRemotePost = IPCRemoteMessage | IPCTransportNotification;

/**
 * Base of every request a handler receives.
 *
 * **Ownership.** Any value reaching a handler implementation is owned outright
 * by the receiver: it is guaranteed not to be shared elsewhere already, and not
 * to become shared later, except by the receiver's own action. A handler may
 * therefore retain or cede what it is given without defending itself.
 *
 * Ownership is about sharing, not about mutability. A request arrives through
 * a decode, and every container a decode returns is frozen -- see "Decoding"
 * in `docs/specs/space-model-formal-spec/4-realm-encoding.md`. A handler that
 * wants a different value builds one; it does not edit this one.
 *
 * That is a requirement on whatever delivers a request, not a property of any
 * particular transport -- see `RuntimeTransport.send()`.
 */
export type BaseRequest = {
  /**
   * Which request this is. Every arm narrows it to one member, so it is
   * the discriminant dispatch turns on. Each arm's narrowing is left
   * undocumented on purpose: what a request does belongs on the request
   * type, so a doc on `type: RequestType.Foo` would have nothing of its own
   * to say.
   */
  type: RequestType;
};

/**
 * Everything the worker needs to stand a runtime up. Sent once, as
 * {@link RequestType.Initialize}'s payload, and fixed for the connection's
 * lifetime -- nothing here can be changed by a later request.
 */
export type InitializationData = {
  /**
   * The backend server, and the default host for any space `spaceHostMap`
   * does not list.
   */
  apiUrl: string;

  /**
   * Per-space storage hosts, by space DID, as HTTP or HTTPS origins. A listed
   * space resolves against its own host instead of `apiUrl`; an absent map or
   * an absent entry falls back to `apiUrl`, byte-identical to the single-host
   * behavior. A plain record, since no function crosses the worker boundary.
   * Fixed for the connection's lifetime.
   */
  spaceHostMap?: Record<string, string>;

  /**
   * The signer's key pair. It crosses inside the envelope's own encoding,
   * which is the one format carrying either state of a key pair -- key
   * handles included -- across a realm boundary whole.
   */
  identity: FabricKeyPair;

  /**
   * The space this connection opens on.
   */
  spaceDid: DID;

  /**
   * The space's name, where the client knows it. Temporary.
   */
  spaceName?: string;

  /** Temporary key pair for the space, carried as `identity` above is. */
  spaceIdentity?: FabricKeyPair;

  /**
   * Experimental space-model feature flags, declared by the host. The worker
   * runs the arm named here rather than resolving its own, so that the two
   * realms cannot diverge.
   */
  experimental?: {
    /**
     * Whether a link is a `FabricLink` and an entity reference a
     * `FabricHash`, rather than the plain `{ "/": ... }` envelopes that
     * represent both otherwise. Recognition is strict per regime, so the two
     * spellings are a clean break rather than a pair a reader accepts.
     */
    modernCellRep?: boolean;

    /**
     * Whether server-execution v2 is on
     * (`docs/specs/server-side-execution/`). The host declares its posture
     * here so the worker runs the same arm, and the worker refuses
     * initialization when its own resolved posture disagrees. That refusal
     * is why this is a declared field rather than an untyped excess
     * property: as one, a typed re-packaging could revert a worker to off
     * while the host stayed on, and each realm would believe a different
     * answer.
     */
    serverExecution?: boolean;

    /** Global default for server-selected view replication. */
    viewScopedReplication?: boolean;

    /** Web client override of the global view replication default. */
    webViewScopedReplication?: boolean;

    /**
     * Whether a link writer emits `cid:` schema-document references, each
     * closure materialized in the carrying transaction. Default on; an
     * explicit `false` is the rollback override.
     */
    contentAddressedSchemas?: boolean;

    /**
     * Whether a link crossing resolves its schema by reader precedence,
     * through `combineSchemaForLink`. Server-authoritative: the host
     * declares the deployment's posture so the worker resolves a hop under
     * the same combine rule as the server shipping its subscriptions.
     * Default on; an explicit `false` is the rollback override.
     */
    readerSchemaPrecedence?: boolean;
  };

  /**
   * The commit-boundary CFC mode the worker runtime runs under, in
   * increasing strictness. `disabled` checks nothing. `observe` checks and
   * reports without refusing anything. `enforce-explicit` refuses against a
   * declared policy and stays permissive where none is declared, which is
   * the rollout posture. `enforce-strict` refuses a commit whose writes
   * carry confidentiality the target's declared policy does not admit.
   */
  cfcEnforcementMode?:
    | "disabled"
    | "observe"
    | "enforce-explicit"
    | "enforce-strict";

  /**
   * The flow-label propagation dial. `off` derives nothing; `observe`
   * computes the per-transaction conservative join and emits diagnostics
   * while persisting nothing; `persist` writes the derived label components.
   * Propagation never rejects a write by itself. Absent leaves the runner's
   * default, which is `off`.
   */
  cfcFlowLabels?: "off" | "observe" | "persist";

  /**
   * The runtime-wide read ceiling every `db.query` the worker's runtime
   * issues reads under (`RuntimeOptions.cfcReadMaxConfidentiality`). A
   * worker is one device's runtime, so a ceiling set here is per device by
   * construction: it never touches the space, and a query's own ceiling can
   * only tighten it. It applies to session-scoped query results; a query
   * whose result is space- or user-scoped is refused before it is staged,
   * and a row the ceiling does not admit is handled as `cfcReadOnExceed`
   * says (`fail` refuses the query, `skip` drops the row). Absent means no
   * ceiling — the owner view. An empty list admits nothing and the runtime
   * refuses to start on it.
   */
  cfcReadMaxConfidentiality?: readonly CfcConfClause[];

  /**
   * What a read under that ceiling does with a row the ceiling does not
   * admit when the query declares no `onExceed` of its own: `fail` refuses
   * the query, `skip` drops the row. Absent leaves the runner's default,
   * which is `fail`.
   */
  cfcReadOnExceed?: "fail" | "skip";

  /**
   * Whether author-supplied render-boundary declassification is honored.
   * `allow` is the default. `deny` ignores an author's
   * `declassifyConfidentiality`, so that a pattern cannot release a secret
   * upward through a render boundary.
   */
  renderDeclassificationPolicy?: "allow" | "deny";

  /**
   * The confidentiality a display surface admits by default: exact `atoms`,
   * which is where an acting user's identity atoms go, plus the Caveat
   * `caveatKinds` a display can discharge. Absent means no ceiling.
   */
  renderConfidentialityCeiling?: {
    /**
     * The exact confidentiality clauses a display surface admits, an acting
     * user's own identity atoms among them.
     */
    atoms?: readonly CfcConfClause[];

    /**
     * The kinds of Caveat a display surface can discharge, named rather
     * than carried, so a label bearing only these is still displayable.
     */
    caveatKinds?: readonly string[];
  };

  /**
   * A static trust snapshot applied to worker-owned transactions, declared by
   * the host so the worker runs against the same one rather than resolving
   * its own.
   */
  trustSnapshot?: {
    /** Identifies the snapshot. The CFC gates require it to be present. */
    id: string;

    /**
     * The principal whose trust the snapshot is taken from. Absent leaves
     * the worker to run against the snapshot with no acting principal
     * named.
     */
    actingPrincipal?: DID;

    /**
     * Which revision of the snapshot this is: the runtime id with the
     * trust configuration's digest folded in. It compares as equal or not
     * rather than as older or newer, and a change to it is what invalidates
     * digests prepared against the previous one.
     */
    revision?: string;
  };

  /**
   * Mirror the worker's own console output to the main thread, which re-emits
   * it on the page console prefixed with `[worker]`, so runtime-internal logs
   * reach devtools and integration-test console capture. Off by default: each
   * forwarded call costs one `postMessage`, so it is for diagnostic runs.
   * {@link RequestType.SetForwardWorkerConsole} changes it later.
   */
  forwardWorkerConsole?: boolean;

  /**
   * Instrument every pattern compile for statement coverage and accumulate
   * hits, which the integration harness pulls at teardown through
   * {@link RequestType.GetPatternCoverage}. Test and CI only -- the coverage
   * shell build sets it -- and off by default.
   */
  patternCoverage?: boolean;

  /**
   * Let the worker's remote storage overlap watch-refresh round trips up to a
   * bounded window, rather than the default strict single-flight. Fixed at
   * `StorageManager.open` time, so like the render ceiling it takes effect on
   * the next runtime rather than live. Off by default.
   */
  concurrentWatchRefresh?: boolean;
};

/**
 * The {@link RequestType.Initialize} request. Its `data` is fixed for the
 * connection's lifetime.
 */
export type InitializeRequest = BaseRequest & {
  type: RequestType.Initialize;

  /**
   * What the runtime is stood up from.
   */
  data: InitializationData;
};

/**
 * The part of an {@link InitializationData} a runtime's security posture is
 * made of: whom it acts as, and under which enforcement configuration. One
 * runtime carries exactly one of these, fixed by the client that initialized
 * it, and every client attached to that runtime shares it.
 *
 * `identity` is the acting principal's DID rather than the key pair
 * {@link InitializationData} carries, because an attach states which principal
 * it believes the runtime acts as and never supplies a signer of its own.
 * Every other field is the initialization field of the same name, so what an
 * attach asserts and what initialization declared compare directly.
 *
 * `apiUrl` and `spaceHostMap` are here as posture rather than as routing: a
 * document believing it reads from a different backend than the runtime does
 * is as wrong about what it is joined to as one believing a different
 * enforcement mode, and the reads would silently go to the runtime's hosts.
 * Both are normalized before they are stored or asserted, so two spellings of
 * one origin are one posture.
 *
 * **Every field here holds plain JSON-shaped values only.** They are compared
 * with `deepEqual`, which compares a class instance by its enumerable own
 * properties -- so a `FabricValue`-carrying field would compare EQUAL between
 * two different values whose state lives in private fields, and an attach
 * asserting a different one would be accepted. A field that must carry such a
 * value needs `valueEqual` from `data-model` and a deliberate decision about
 * what equality means for it; adding one without that is a false accept, not
 * a missing check.
 */
export type RuntimeSecurityContext =
  & Pick<
    InitializationData,
    | "apiUrl"
    | "spaceHostMap"
    | "spaceDid"
    | "experimental"
    | "cfcEnforcementMode"
    | "cfcFlowLabels"
    | "cfcReadMaxConfidentiality"
    | "cfcReadOnExceed"
    | "renderDeclassificationPolicy"
    | "renderConfidentialityCeiling"
    | "trustSnapshot"
  >
  & {
    /** The principal the runtime acts as. */
    identity: DID;
  };

/**
 * The {@link RequestType.Attach} request. Its `data` is the context the
 * joining client asserts, which the worker compares field for field against
 * the running runtime's and refuses on any disagreement.
 */
export type AttachRequest = BaseRequest & {
  type: RequestType.Attach;

  /** The security context this client believes it is joining. */
  data: RuntimeSecurityContext;
};

/** The {@link RequestType.Dispose} request, which carries no payload. */
export type DisposeRequest = BaseRequest & {
  type: RequestType.Dispose;
};

/**
 * The {@link RequestType.CellGet} request. `meta` reads a metadata field in
 * place of the cell's value, and each `include*` flag adds a field to the
 * answer.
 */
export type CellGetRequest = BaseRequest & {
  type: RequestType.CellGet;

  /**
   * The cell to read.
   */
  cell: CellRef;

  /**
   * Reads this metadata field instead of the cell's value.
   */
  meta?: MetaField;

  /**
   * Have the cell's display label returned alongside the value, so a caller
   * needing both pays one round trip instead of a separate
   * {@link RequestType.CellGetCfcLabel}.
   */
  includeCfcLabel?: boolean;

  /**
   * Have the read cell's own schema-bearing ref returned. Useful where `meta`
   * names a link field -- pattern, argument, result -- since the resolved
   * cell is then not the one asked for: its ref lets the caller subscribe to
   * it or read it again directly, and its schema carries declarations such as
   * stream fields that the value alone does not.
   */
  includeRef?: boolean;
};

/** The {@link RequestType.CellPull} request. */
export type CellPullRequest = BaseRequest & {
  type: RequestType.CellPull;

  /**
   * The cell whose producers to demand before reading its current value.
   */
  cell: CellRef;
};

/** The {@link RequestType.CellInitialize} request. */
export type CellInitializeRequest = BaseRequest & {
  type: RequestType.CellInitialize;

  /** The cell to initialize when it has no backing value. */
  cell: CellRef;

  /** The non-undefined default to store. */
  value: FabricValue;
};

/**
 * The {@link RequestType.CellSet} request. `value` is the whole
 * already-resolved value rather than a delta.
 */
export type CellSetRequest = BaseRequest & {
  type: RequestType.CellSet;

  /**
   * The cell to overwrite.
   */
  cell: CellRef;

  /**
   * The value to store, whole and already resolved.
   */
  value: FabricValue;

  /** Wait for commit confirmation and return a refusal to the caller. */
  awaitCommit?: boolean;
};

/**
 * The {@link RequestType.CellPush} request: a mergeable server-side append.
 * It carries only the invocation-time member snapshots, so an equivalent
 * client handle with a stale local cache cannot replace a newer array base.
 */
export type CellPushRequest = BaseRequest & {
  type: RequestType.CellPush;

  /**
   * The cell to apply to.
   */
  cell: CellRef;

  /** The members to append, already resolved. */
  values: FabricValue[];

  /** Wait for commit confirmation and return a refusal to the caller. */
  awaitCommit?: boolean;
};

/**
 * The {@link RequestType.CellSend} request. `event` is delivered rather than
 * stored.
 */
export type CellSendRequest = BaseRequest & {
  type: RequestType.CellSend;

  /**
   * The cell to send to.
   */
  cell: CellRef;

  /**
   * The event to deliver.
   */
  event: FabricValue;

  /** Wait for commit confirmation and return a refusal to the caller. */
  awaitCommit?: boolean;
};

/**
 * The {@link RequestType.CellSubscribe} request. `includeCfcLabel` makes every
 * update carry the cell's label too.
 */
export type CellSubscribeRequest = BaseRequest & {
  type: RequestType.CellSubscribe;

  /**
   * The cell to watch.
   */
  cell: CellRef;

  /**
   * Opt in to reactive label delivery: every update then carries the cell's
   * current display label, and the worker reads that label as a tracked
   * dependency of the sink, so a label-only write with the value unchanged
   * re-fires the subscription. Off by default -- only a label-displaying
   * caller pays for it.
   */
  includeCfcLabel?: boolean;
};

/** The {@link RequestType.CellUnsubscribe} request. */
export type CellUnsubscribeRequest = BaseRequest & {
  type: RequestType.CellUnsubscribe;

  /**
   * The cell to stop watching.
   */
  cell: CellRef;
};

/** The {@link RequestType.CellResolveAsCell} request. */
export type CellResolveAsCellRequest = BaseRequest & {
  type: RequestType.CellResolveAsCell;

  /**
   * The cell whose aliases to follow.
   */
  cell: CellRef;
};

/** The {@link RequestType.CellGetCfcLabel} request. */
export type CellGetCfcLabelRequest = BaseRequest & {
  type: RequestType.CellGetCfcLabel;

  /**
   * The cell whose label to read.
   */
  cell: CellRef;
};

/** A held profile or space cell whose audience the runtime verifies. */
export type SnapshotShareAudienceRef = { user: CellRef } | { space: CellRef };

/** The exact value and verified audience a trusted host must show. */
export type SnapshotSharePreview = {
  id: string;
  value: JSONValue;
  audience: CfcAtom;
};

/** The {@link RequestType.SnapshotSharePrepare} request. */
export type SnapshotSharePrepareRequest = BaseRequest & {
  type: RequestType.SnapshotSharePrepare;
  source: CellRef;
  audience: SnapshotShareAudienceRef;
  appendBooksTo?: { recommended: CellRef; received: CellRef };
};

/** The {@link RequestType.SnapshotShareCommit} request. */
export type SnapshotShareCommitRequest = BaseRequest & {
  type: RequestType.SnapshotShareCommit;
  id: string;
};

/** The {@link RequestType.SnapshotShareCancel} request. */
export type SnapshotShareCancelRequest = BaseRequest & {
  type: RequestType.SnapshotShareCancel;
  id: string;
};

/** The {@link RequestType.OperationQuery} request. */
export type OperationQueryRequest = BaseRequest & {
  type: RequestType.OperationQuery;

  /** The cell whose operation field this addresses. */
  cell: CellRef;

  /**
   * Groups this request into a named operation session. The worker pins a
   * session to one cell when it opens, and refuses a later request naming
   * the same session against a different one. Absent works outside any
   * session, which is what a one-off request does.
   */
  operationSessionId?: string;

  /**
   * The cursor to report from, exclusive: only operations integrated after
   * it come back. Absent asks for the field from its beginning, which a
   * field whose history has been trimmed answers with no operations and
   * `reset`, telling the caller to rebuild from `materialized` instead.
   */
  after?: OpCursor;
};

/** The {@link RequestType.OperationCapabilities} request. */
export type OperationCapabilitiesRequest = BaseRequest & {
  type: RequestType.OperationCapabilities;

  /** The cell whose operation field this addresses. */
  cell: CellRef;

  /**
   * Groups this request into a named operation session. The worker pins a
   * session to one cell when it opens, and refuses a later request naming
   * the same session against a different one. Absent works outside any
   * session, which is what a one-off request does.
   */
  operationSessionId?: string;
};

/** The {@link RequestType.OperationApply} request. */
export type OperationApplyRequest = BaseRequest & {
  type: RequestType.OperationApply;

  /** The cell whose operation field this addresses. */
  cell: CellRef;

  /**
   * Groups this request into a named operation session. The worker pins a
   * session to one cell when it opens, and refuses a later request naming
   * the same session against a different one. Absent works outside any
   * session, which is what a one-off request does.
   */
  operationSessionId?: string;

  /**
   * Names the operation codec the payload is written in, which is what
   * decides how it integrates. {@link OperationCapabilitiesResponse} is
   * where the choices come from.
   */
  codec: string;

  /**
   * Identifies this submission, chosen by the submitter. It is what lets a
   * re-sent apply be recognized as the same one rather than integrated
   * twice; {@link ApplyOpResolution} reports that case as `duplicate`.
   */
  submissionId: string;

  /**
   * The cursor the payload is expressed against. `null` submits against the
   * field's beginning, which is what a first submission does.
   */
  base: OpCursor | null;

  /**
   * The hash of the materialized value the payload was written against.
   * Required exactly when `base` is `null`, and refused otherwise: an apply
   * opening an epoch names the baseline it assumes, and one continuing from
   * a cursor inherits it. A hash that does not match the field's own
   * refuses the apply rather than integrating against a value the payload
   * was not written for.
   */
  baselineHash?: string;

  /** The operations themselves, in whatever form `codec` gives them. */
  payload: FabricValue;
};

/** The {@link RequestType.OperationSubscribe} request. */
export type OperationSubscribeRequest = BaseRequest & {
  type: RequestType.OperationSubscribe;

  /**
   * Identifies this subscription, chosen by the subscriber. Every
   * {@link OperationUpdateNotification} carries it back, which is how a
   * client with several subscriptions open routes an update to the one that
   * asked for it.
   */
  subscriptionId: string;

  /** The cell whose operation field this addresses. */
  cell: CellRef;

  /**
   * Groups this request into a named operation session. The worker pins a
   * session to one cell when it opens, and refuses a later request naming
   * the same session against a different one. Absent works outside any
   * session, which is what a one-off request does.
   */
  operationSessionId?: string;

  /**
   * The cursor to report from, exclusive: only operations integrated after
   * it come back. Absent asks for the field from its beginning, which a
   * field whose history has been trimmed answers with no operations and
   * `reset`, telling the caller to rebuild from `materialized` instead.
   */
  after?: OpCursor;
};

/** The {@link RequestType.OperationRelease} request. */
export type OperationReleaseRequest = BaseRequest & {
  type: RequestType.OperationRelease;

  /** The cell whose operation field this addresses. */
  cell: CellRef;

  /**
   * Groups this request into a named operation session. The worker pins a
   * session to one cell when it opens, and refuses a later request naming
   * the same session against a different one. Absent works outside any
   * session, which is what a one-off request does.
   */
  operationSessionId?: string;

  /** The field's codec, which must be the one it currently holds. */
  codec: string;

  /**
   * The field's head, exactly -- epoch and version both. A release naming
   * anything else is refused, which is what keeps one racing an apply from
   * discarding the other writer's work. Releasing deactivates the field for
   * every client, and the next apply opens a fresh epoch.
   */
  cursor: OpCursor;
};

/** The {@link RequestType.OperationUnsubscribe} request. */
export type OperationUnsubscribeRequest = BaseRequest & {
  type: RequestType.OperationUnsubscribe;

  /**
   * The subscription to end, as {@link OperationSubscribeRequest} named it.
   */
  subscriptionId: string;
};

/** The {@link RequestType.OperationSessionClose} request. */
export type OperationSessionCloseRequest = BaseRequest & {
  type: RequestType.OperationSessionClose;

  /**
   * The session to close, releasing the worker's bookkeeping for it. Unlike
   * the other requests in this family it is required, a close having
   * nothing to name otherwise.
   */
  operationSessionId: string;
};

/** A response carrying one operation-backed field snapshot. */
export type OperationFieldResponse = {
  /**
   * The field as it stands: its codec and cursor, the materialized value,
   * and the integrated operations the request asked to see.
   */
  field: OperationFieldSnapshot;
};

/** A response naming the operation codecs available for a cell. */
export type OperationCapabilitiesResponse = {
  /**
   * The operation codecs the space's server connection advertises, by name.
   * It is what a submitter chooses an {@link OperationApplyRequest.codec}
   * from, and it says nothing about any one cell: the answer is the same
   * for every cell in the space, and a field pins its codec once its epoch
   * is open, so the choice exists only at the apply that opens one.
   */
  codecs: readonly string[];
};

/** A response carrying the authoritative resolution of an operation. */
export type OperationApplyResponse = {
  /**
   * Where the submission landed: the cursor span it moved the field
   * through, the operations as integrated, and whether the submission was
   * a duplicate of one already there.
   */
  resolution: ApplyOpResolution;
};

/** SQLite bind values as the main-thread connection carries them. */
export type SqliteParams =
  | {
    /** Marks the positional form, whose values bind in the order given. */
    kind: "positional";

    /** The bind values, one per placeholder, in statement order. */
    values: readonly FabricValue[];
  }
  | {
    /** Marks the named form, whose entries bind by parameter name. */
    kind: "named";

    /** The bindings, as name/value pairs in no particular order. */
    entries: readonly (readonly [string, FabricValue])[];
  };

/** The {@link RequestType.SqliteQuery} request. */
export type SqliteQueryRequest = BaseRequest & {
  type: RequestType.SqliteQuery;

  /** The cell whose database to read. */
  cell: CellRef;

  /** The statement to run, with its bind parameters left as placeholders. */
  sql: string;

  /** What to bind the statement's placeholders to. Absent binds nothing. */
  params?: SqliteParams;
};

/** The {@link RequestType.SqliteExec} request. */
export type SqliteExecRequest = BaseRequest & {
  type: RequestType.SqliteExec;

  /** The cell whose database to write. */
  cell: CellRef;

  /** The statement to run, with its bind parameters left as placeholders. */
  sql: string;

  /** What to bind the statement's placeholders to. Absent binds nothing. */
  params?: SqliteParams;
};

/**
 * The {@link RequestType.GetCell} request. `cause` is what derives the
 * cell: the same space and cause always name the same one.
 */
export type GetCellRequest = BaseRequest & {
  type: RequestType.GetCell;

  /**
   * The space to derive the cell in.
   */
  space: DID;

  /**
   * What derives the cell. The same space and cause always name the same
   * cell, which is what makes this a derivation rather than an allocation.
   */
  cause: FabricValue;

  /**
   * The schema to read the cell under, where one is wanted.
   */
  schema?: JSONSchema;
};

/**
 * The {@link RequestType.GetHomeSpaceCell} request, which carries no payload.
 */
export type GetHomeSpaceCellRequest = BaseRequest & {
  type: RequestType.GetHomeSpaceCell;
};

/**
 * The {@link RequestType.EnsureHomePatternRunning} request, which carries no
 * payload.
 */
export type EnsureHomePatternRunningRequest = BaseRequest & {
  type: RequestType.EnsureHomePatternRunning;
};

/** The {@link RequestType.Idle} request, which carries no payload. */
export type IdleRequest = BaseRequest & {
  type: RequestType.Idle;
};

/** Reads unresolved attention notices for one open or reconnecting space. */
export type ListEventAttentionRequest = BaseRequest & {
  type: RequestType.ListEventAttention;

  /** The space whose unresolved notices to read. */
  space: DID;
};

/** Resolves one notice through the authenticated memory-v2 CAS endpoint. */
export type ResolveEventAttentionRequest = BaseRequest & {
  type: RequestType.ResolveEventAttention;

  /** The space the notice belongs to. */
  space: DID;

  /** The event the notice was raised for. */
  eventId: string;

  /**
   * The stream seq the engine stamped on the commit that appended the
   * event, which with `eventId` is what identifies the entry.
   */
  seq: number;

  /** The sidecar record holding the notice, which is what is compared and
   * swapped. */
  sidecarId: string;

  /**
   * What to do with it: `retry` asks for the delivery again, `dismiss`
   * accepts the failure and closes the notice. A notice whose
   * {@link EventAttentionNotice.retryable} is false takes only `dismiss`.
   */
  action: "retry" | "dismiss";
};

/**
 * Await storage/piece-manager convergence for EVERY space this worker
 * has opened. Genuinely spaceless — like Idle — unlike PieceSynced,
 * which awaits one named space's piece context.
 */
export type RuntimeSyncedRequest = BaseRequest & {
  type: RequestType.RuntimeSynced;
};

/** Resolve a legacy named space inside the worker so its derived identity can
 * be retained as fresh-space ACL bootstrap authority. */
export type ResolveSpaceNameRequest = BaseRequest & {
  type: RequestType.ResolveSpaceName;

  /**
   * The name to resolve.
   */
  name: string;
};

/**
 * Record a runtime-learned HTTP or HTTPS host hint for a space (site-table v0).
 * The durable record is the home-space site table; this IPC lets an
 * embedder make a just-learned hint (e.g. from a share link) effective
 * on the live runtime without waiting for a sync round-trip. The
 * worker returns whether it accepted or confirmed the hint. A seed, an
 * accepted late hint fixes the route for the session. A read-only unseeded
 * provider opened through the default host remains provisional.
 *
 * ORDERING CONTRACT: an embedder sends a newly learned hint before it relies
 * on the space and proceeds only when the worker returns true. The first hint
 * replaces and reloads a read-only provisional default-host provider. An
 * accepted site-table route can reject a conflicting IPC hint. The IPC does
 * not override a seed or route already accepted for the session.
 */
export type RegisterSpaceHostRequest = BaseRequest & {
  type: RequestType.RegisterSpaceHost;

  /**
   * The space to route.
   */
  space: DID;

  /**
   * The origin its storage should resolve against.
   */
  host: string;
};

/**
 * Await all in-flight compile-cache write-backs (persistence durability), as
 * distinct from `Idle` (reactive/scheduler quiescence). Used by tests that
 * assert a precompiled pattern loads without an in-client recompile: the cache
 * write must be durable before a subsequent load reads it.
 */
export type FlushCompileCacheWritesRequest = BaseRequest & {
  type: RequestType.FlushCompileCacheWrites;
};

/**
 * The {@link RequestType.GetGraphSnapshot} request, which carries no payload.
 */
export type GetGraphSnapshotRequest = BaseRequest & {
  type: RequestType.GetGraphSnapshot;
};

/**
 * The {@link RequestType.GetLoggerCounts} request, which carries no payload.
 */
export type GetLoggerCountsRequest = BaseRequest & {
  type: RequestType.GetLoggerCounts;
};

/**
 * The {@link RequestType.GetPatternCoverage} request, which carries no payload.
 */
export type GetPatternCoverageRequest = BaseRequest & {
  type: RequestType.GetPatternCoverage;
};

/** The severities a logger records at, least to most severe. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * The {@link RequestType.SetLoggerLevel} request. An absent `loggerName`
 * addresses every logger.
 */
export type SetLoggerLevelRequest = BaseRequest & {
  type: RequestType.SetLoggerLevel;

  /** Logger name. If not provided, sets level for all loggers. */
  loggerName?: string;

  /**
   * The level to record at.
   */
  level: LogLevel;
};

/**
 * The {@link RequestType.SetLoggerEnabled} request. An absent `loggerName`
 * addresses every logger.
 */
export type SetLoggerEnabledRequest = BaseRequest & {
  type: RequestType.SetLoggerEnabled;

  /** Logger name. If not provided, sets enabled for all loggers. */
  loggerName?: string;

  /**
   * Whether the addressed loggers record at all.
   */
  enabled: boolean;
};

/** The {@link RequestType.SetTelemetryEnabled} request. */
export type SetTelemetryEnabledRequest = BaseRequest & {
  type: RequestType.SetTelemetryEnabled;

  /**
   * Whether telemetry notifications are sent.
   */
  enabled: boolean;
};

/** The {@link RequestType.SetReadStatsEnabled} request. */
export type SetReadStatsEnabledRequest = BaseRequest & {
  type: RequestType.SetReadStatsEnabled;
  /** Whether subsequent reactive bodies record read counts. */
  enabled: boolean;
};

/** The {@link RequestType.SetMemoryMessageCompression} request. */
export type SetMemoryMessageCompressionRequest = BaseRequest & {
  type: RequestType.SetMemoryMessageCompression;

  /** Whether live and later memory WebSocket sessions send compressed frames. */
  enabled: boolean;
};

/** The {@link RequestType.SetForwardWorkerConsole} request. */
export type SetForwardWorkerConsoleRequest = BaseRequest & {
  type: RequestType.SetForwardWorkerConsole;

  /**
   * Whether the worker's console bridge is installed.
   */
  enabled: boolean;
};

/**
 * The {@link RequestType.ResetLoggerBaselines} request, which carries no
 * payload.
 */
export type ResetLoggerBaselinesRequest = BaseRequest & {
  type: RequestType.ResetLoggerBaselines;
};

/** The {@link RequestType.GetSettleStats} request, which carries no payload. */
export type GetSettleStatsRequest = BaseRequest & {
  type: RequestType.GetSettleStats;
};

/** The {@link RequestType.SetSettleStatsEnabled} request. */
export type SetSettleStatsEnabledRequest = BaseRequest & {
  type: RequestType.SetSettleStatsEnabled;

  /**
   * Whether settle statistics are recorded. Setting it false also discards
   * what has been collected.
   */
  enabled: boolean;
};

/**
 * The {@link RequestType.GetSettleStatsHistory} request, which carries no
 * payload.
 */
export type GetSettleStatsHistoryRequest = BaseRequest & {
  type: RequestType.GetSettleStatsHistory;
};

/**
 * The {@link RequestType.GetActionRunTrace} request, which carries no payload.
 */
export type GetActionRunTraceRequest = BaseRequest & {
  type: RequestType.GetActionRunTrace;
};

/** The {@link RequestType.SetActionRunTraceEnabled} request. */
export type SetActionRunTraceEnabledRequest = BaseRequest & {
  type: RequestType.SetActionRunTraceEnabled;

  /**
   * Whether action runs are traced. Setting it false also discards the trace
   * already collected.
   */
  enabled: boolean;
};

/**
 * The {@link RequestType.GetTriggerTrace} request, which carries no payload.
 */
export type GetTriggerTraceRequest = BaseRequest & {
  type: RequestType.GetTriggerTrace;
};

/** The {@link RequestType.SetTriggerTraceEnabled} request. */
export type SetTriggerTraceEnabledRequest = BaseRequest & {
  type: RequestType.SetTriggerTraceEnabled;

  /**
   * Whether triggers are traced. Setting it false also discards the trace
   * already collected.
   */
  enabled: boolean;
};

/**
 * The {@link RequestType.GetWriteStackTrace} request, which carries no payload.
 */
export type GetWriteStackTraceRequest = BaseRequest & {
  type: RequestType.GetWriteStackTrace;
};

/**
 * The {@link RequestType.SetWriteStackTraceMatchers} request. The matchers
 * replace the current set rather than adding to it.
 */
export type SetWriteStackTraceMatchersRequest = BaseRequest & {
  type: RequestType.SetWriteStackTraceMatchers;

  /**
   * The writes whose stack to record. Replaces the current set rather than
   * adding to it.
   */
  matchers: readonly WriteStackTraceMatcher[];
};

/**
 * The {@link RequestType.DetectNonIdempotent} request. `durationMs` bounds how
 * long the diagnosis runs.
 */
export type DetectNonIdempotentRequest = BaseRequest & {
  type: RequestType.DetectNonIdempotent;

  /**
   * How long to run the diagnosis.
   */
  durationMs?: number;
};

/** The scheduler's settle statistics, or `null` while recording is off. */
export type SettleStatsResponse = {
  /**
   * The statistics from the last settle pass. `null` where recording is off,
   * and equally where it is on but no pass has completed.
   */
  stats: SettleStats | null;
};

/** One entry per recorded settle pass, oldest first. */
export type SettleStatsHistoryResponse = {
  /**
   * One entry per recorded pass, oldest first.
   */
  history: readonly SettleStatsHistoryEntry[];
};

/** The recorded action runs, in the order they ran. */
export type ActionRunTraceResponse = {
  /**
   * The recorded runs, in the order they ran.
   */
  trace: readonly ActionRunTraceEntry[];
};

/** The recorded triggers, in the order they fired. */
export type TriggerTraceResponse = {
  /**
   * The recorded triggers, in the order they fired.
   */
  trace: readonly TriggerTraceEntry[];
};

/**
 * The recorded write stacks. Only writes matching the configured matchers
 * appear, recording every write being too costly to leave on.
 */
export type WriteStackTraceResponse = {
  /**
   * The recorded writes, in the order they happened.
   */
  trace: readonly WriteStackTraceEntry[];
};

/** What the scheduler's non-idempotency diagnosis found. */
export type DetectNonIdempotentResponse = {
  /**
   * What the diagnosis found.
   */
  result: SchedulerDiagnosisResult;
};

/**
 * The {@link RequestType.GetPatternSources} request, which carries no payload.
 */
export type GetPatternSourcesRequest = BaseRequest & {
  type: RequestType.GetPatternSources;
};

/** One file of a pattern's source, by name and contents. */
export type PatternSourceFile = {
  /**
   * The file's name, as the pattern refers to it.
   */
  name: string;

  /**
   * The file's text.
   */
  contents: string;
};

/**
 * A pattern's source as the worker reports it. `files` carries both code and
 * data; `dataFiles` is what tells them apart.
 */
export type PatternSourceInfo = {
  /** Content identity of the pattern's entry module (`cf:module/<hash>`). */
  identity: string;

  /**
   * Every file of the pattern, code and data alike.
   */
  files: readonly PatternSourceFile[];

  /** Names among `files` that carry data rather than code. */
  dataFiles?: readonly string[];
};

/** One entry per distinct pattern in the graph, not per graph node. */
export type PatternSourcesResponse = {
  /**
   * One entry per distinct pattern.
   */
  patterns: readonly PatternSourceInfo[];
};

/**
 * The {@link RequestType.SetBreakpoints} request. The ids replace the current
 * breakpoints rather than adding to them.
 */
export type SetBreakpointsRequest = BaseRequest & {
  type: RequestType.SetBreakpoints;

  /**
   * The actions to break on. Replaces the current set.
   */
  actionIds: readonly string[];
};

/**
 * The {@link RequestType.UploadBlob} request. `space` is required, and decides
 * which host the upload targets; `suffix` names the extension the stored blob
 * is served under.
 */
export type UploadBlobRequest = BaseRequest & {
  type: RequestType.UploadBlob;

  /** The space the blob belongs to — uploads target ITS host. */
  space: DID;

  /**
   * The media type the blob is served as.
   */
  contentType: string;

  /**
   * The blob's bytes. The envelope's encoding carries a `FabricBytes` as a
   * bare `ArrayBuffer` that structured cloning delivers whole, and decodes it
   * back into a `FabricBytes`, so the bytes are an immutable value at both
   * ends rather than a view a sender still holds.
   */
  body: FabricBytes;

  /**
   * The extension the stored blob is served under, defaulting to `bin`.
   * A leading dot is stripped.
   */
  suffix?: string;
};

/** The stored blob's id, and the URL it is served from. */
export type UploadBlobResponse = {
  /**
   * The stored blob's id.
   */
  id: string;

  /**
   * Where the blob is served from.
   */
  url: string;
};

/**
 * How many messages were recorded at each level, with `total` alongside so
 * a reader need not sum the four. Mirrors the shape
 * `@commonfabric/utils/logger` uses, this being that data on the wire.
 */
export type LogCounts = {
  /**
   * Messages recorded at `debug`.
   */
  debug: number;

  /**
   * Messages recorded at `info`.
   */
  info: number;

  /**
   * Messages recorded at `warn`.
   */
  warn: number;

  /**
   * Messages recorded at `error`.
   */
  error: number;

  /**
   * All four levels together.
   */
  total: number;
};

/**
 * One logger's counts split per distinct message, with the logger's own total
 * alongside. Keys are message texts, so `total` is reserved and cannot name a
 * message.
 */
export type LoggerBreakdown = {
  [messageKey: string]: LogCounts;
} & {
  /**
   * Every message of this logger together. Reserved, so no message text
   * may be `total`.
   */
  total: number;
};

/**
 * Counts for every logger, keyed by logger name, with a grand total
 * alongside. `total` is reserved here the same way.
 */
export type LoggerCountsData = Record<string, LoggerBreakdown> & {
  /**
   * Every logger together. Reserved, so no logger may be named `total`.
   */
  total: number;
};

/** Whether a logger is enabled, and the level it records at. */
export type LoggerInfo = {
  /**
   * Whether the logger records at all.
   */
  enabled: boolean;

  /**
   * The lowest severity it records.
   */
  level: LogLevel;
};

/** Every logger's enabled state and level, by logger name. */
export type LoggerMetadata = Record<string, LoggerInfo>;

/**
 * One point of a cumulative distribution: a latency, and the fraction of
 * samples at or below it. Mirrors the shape
 * `@commonfabric/utils/logger` uses.
 */
export type CDFPoint = {
  /**
   * Latency, in milliseconds.
   */
  x: number;

  /**
   * The fraction of samples at or below `x`, from 0 to 1.
   */
  y: number;
};

/**
 * What one timed operation's samples add up to. Two distributions are kept:
 * `cdf` over every sample since the worker started, and `cdfSinceBaseline`
 * over those since the last baseline reset, which is `null` until one has
 * happened.
 */
export type TimingStats = {
  /**
   * How many measurements have been taken.
   */
  count: number;

  /**
   * The fastest measurement, in milliseconds.
   */
  min: number;

  /**
   * The slowest measurement, in milliseconds.
   */
  max: number;

  /**
   * Every measurement summed, which is what `average` divides.
   */
  totalTime: number;

  /**
   * `totalTime` over `count`.
   */
  average: number;

  /**
   * The median measurement.
   */
  p50: number;

  /**
   * The 95th percentile measurement.
   */
  p95: number;

  /**
   * The most recent measurement, in milliseconds.
   */
  lastTime: number;

  /**
   * When that measurement was taken.
   */
  lastTimestamp: number;

  /**
   * The distribution over every sample since the worker started.
   */
  cdf: readonly CDFPoint[];

  /**
   * The distribution over samples since the last baseline reset, `null`
   * until one has happened.
   */
  cdfSinceBaseline: CDFPoint[] | null;
};

/**
 * Timing statistics for every timed operation, keyed by logger name and then
 * by the operation's own name.
 */
export type LoggerTimingData = Record<
  string,
  Record<string, TimingStats>
>;

/**
 * Active logger flags, by logger name, flag name and id. A flag set without
 * metadata is `null`.
 */
export type LoggerFlagsData = Record<
  string,
  Record<string, Record<string, FabricPlainObject | null>>
>;

/**
 * The {@link RequestType.PieceCreate} request. `source` names a URL or a
 * program, never both.
 */
export type PieceCreateRequest = BaseRequest & {
  type: RequestType.PieceCreate;

  /** The space the piece is created in — part of its address. */
  space: DID;

  /**
   * Where the piece's program comes from: a URL to fetch, or a program
   * given directly. Never both.
   */
  source: {
    /** Where to fetch the program from. */
    url: string;
  } | {
    /** The program's entry point and its sources, given rather than fetched. */
    program: Program;
  };

  /**
   * The argument the piece is created with. The wire carries a `FabricValue`,
   * which is what the envelope's encoding makes true of it.
   *
   * A piece's input is a record of named inputs, which is narrower, and that
   * is what the client API asks for. `handlePieceCreate()` holds the same line
   * at the far end rather than casting, so the arms this admits and
   * `FabricPlainObject` does not -- a `bigint`, a `FabricBytes`, a bare string
   * -- reach it only from a sender that went around that API, and are turned
   * away with a message naming what arrived.
   *
   * This value reaches the wire as the caller built it, no conversion walk
   * standing between, so it is where the encoding's tree shape shows: a cycle
   * in it is refused, and a subtree needing encoding that the record reaches
   * twice arrives twice. `RuntimeTransport.send()` states that shape.
   */
  argument?: FabricValue;

  /**
   * What derives the piece's identity, so that the same cause names the
   * same piece.
   */
  cause?: string;

  /**
   * Start the piece once created.
   */
  run?: boolean;
};

/**
 * Piece operations resolve against one space's piece context, and every
 * request names its space explicitly — there is no implicit/default
 * space at this layer. The worker lazily builds a piece context per
 * space, sharing the one runtime/storage connection.
 */
export type GetSpaceRootPatternRequest = BaseRequest & {
  type: RequestType.GetSpaceRootPattern;

  /**
   * The space whose root pattern to read.
   */
  space: DID;

  /**
   * Whether the root is wanted RUNNING. Defaults to true, which is what a
   * view that renders the root needs — the space home, where running the
   * root is the page.
   *
   * A caller that only reads what the root exported passes false. Starting
   * a root materializes everything its result reaches, which on a space
   * whose root reaches a large piece is the dominant cost of opening
   * anything; a stored export costs a read. Either way an absent root is
   * still created, since a space needs one before it can have exports.
   */
  start?: boolean;
};

/** The {@link RequestType.RecreateSpaceRootPattern} request. */
export type RecreateSpaceRootPatternRequest = BaseRequest & {
  type: RequestType.RecreateSpaceRootPattern;

  /**
   * The space whose root pattern to replace.
   */
  space: DID;
};

/**
 * Which document a request means by a piece: an id, and the scope that id is
 * resolved in within whichever space the request names. A piece reached
 * through a link into a narrower scope is addressed by both, and the id alone
 * reaches nothing — or reaches a different document that happens to share it.
 *
 * Every request naming a piece by id intersects this, so that the two halves
 * of one address cannot be declared apart. The assertion under
 * {@link IPCClientRequest} is what holds a new one to it, and says with what
 * bound.
 */
export type PieceAddress = {
  /**
   * The piece's document id.
   */
  pieceId: string;

  /**
   * The scope that id resolves in, defaulting to the space.
   */
  scope?: CellScope;
};

/**
 * The {@link RequestType.PieceGet} request. `runIt` starts the piece as part of
 * the read.
 */
export type PieceGetRequest = BaseRequest & PieceAddress & {
  type: RequestType.PieceGet;

  /**
   * Start the piece as part of the read.
   */
  runIt?: boolean;

  /**
   * The space the piece lives in.
   */
  space: DID;
};

/** The {@link RequestType.PieceGetSlug} request. */
export type PieceGetSlugRequest = BaseRequest & PieceAddress & {
  type: RequestType.PieceGetSlug;

  /**
   * The space the piece lives in.
   */
  space: DID;
};

/** The {@link RequestType.SlugResolve} request. */
export type SlugResolveRequest = BaseRequest & {
  type: RequestType.SlugResolve;

  /**
   * The slug to resolve.
   */
  slug: string;

  /**
   * The member to select out of the collection the slug names, absent where
   * the reference stops at the slug. One member name, never a path: a
   * member's own fields are addressed inside the piece it resolves to.
   */
  member?: string;

  /**
   * The space the slug is bound in.
   */
  space: DID;
};

/** The {@link RequestType.PieceRemove} request. */
export type PieceRemoveRequest = BaseRequest & PieceAddress & {
  type: RequestType.PieceRemove;

  /**
   * The space to remove the piece from.
   */
  space: DID;
};

/** The {@link RequestType.PieceStart} request. */
export type PieceStartRequest = BaseRequest & PieceAddress & {
  type: RequestType.PieceStart;

  /**
   * The space the piece lives in.
   */
  space: DID;
};

/** The {@link RequestType.PieceStop} request. */
export type PieceStopRequest = BaseRequest & PieceAddress & {
  type: RequestType.PieceStop;

  /**
   * The space the piece lives in.
   */
  space: DID;
};

/** The {@link RequestType.PieceGetAll} request. */
export type PieceGetAllRequest = BaseRequest & {
  type: RequestType.PieceGetAll;

  /**
   * The space whose pieces to list.
   */
  space: DID;
};

/** The {@link RequestType.PieceSynced} request. */
export type PieceSyncedRequest = BaseRequest & {
  type: RequestType.PieceSynced;

  /**
   * The space whose pieces to wait for.
   */
  space: DID;
};

/**
 * Read one piece's source state: the pattern it runs, the origin it tracks, the
 * history metadata it carries, and its authored source files. See
 * `docs/specs/piece-source-lifecycle.md`.
 */
export type PieceGetSourceRequest = BaseRequest & PieceAddress & {
  type: RequestType.PieceGetSource;

  /**
   * The space the piece lives in.
   */
  space: DID;
};

/** Read the authored files retained for one recorded source revision. */
export type PieceGetSourceRevisionRequest = BaseRequest & PieceAddress & {
  type: RequestType.PieceGetSourceRevision;

  /**
   * The space the piece lives in.
   */
  space: DID;

  /**
   * The revision to read.
   */
  revisionId: string;
};

/**
 * Create a copy of a piece in another space. The address is read in
 * `sourceSpace`, that being the space the request names a piece in.
 */
export type PieceCloneRequest = BaseRequest & PieceAddress & {
  type: RequestType.PieceClone;

  /**
   * The space to copy from.
   */
  sourceSpace: DID;

  /**
   * The space to copy into.
   */
  destinationSpace: DID;

  /** Seed the clone with snapshots of the source piece's durable data. */
  copyData?: boolean;
};

/** How a piece's origin URL resolves. */
export type PieceOriginKind = "system" | "fabric-piece" | "fabric-pattern";

/**
 * Where a piece's source came from. `recorded` is present only when
 * normalization changed the URL, so that the piece's own text stays visible
 * next to the resolved form.
 */
export type PieceOriginView = {
  /**
   * Where the source came from, resolved.
   */
  url: string;

  /**
   * How that URL resolves.
   */
  kind: PieceOriginKind;

  /** The URL as recorded on the piece, when normalization changed it. */
  recorded?: string;
};

/** A pattern, named by its content identity and the symbol exported from it. */
export type PiecePatternRefView = {
  /**
   * The pattern's content identity.
   */
  identity: string;

  /**
   * The export within it that is the pattern.
   */
  symbol: string;
};

/** What the last attempt to follow a piece's active origin did. */
export type PieceReconciliationOutcome =
  | "followed"
  | "unreachable"
  | "refused";

/**
 * Why a reconciliation did not adopt what its origin offered. Only
 * `incompatible-schema` can be overruled: `argument-mismatch` says the
 * piece's own stored data does not satisfy the candidate, so there is nothing
 * to accept — the piece could not run it.
 */
export type PieceReconciliationReason =
  | "incompatible-schema"
  | "argument-mismatch"
  | "source-invalid"
  | "identity-mismatch"
  | "apply-failed";

/**
 * The outcome of the last attempt to follow a piece's active origin. Recording
 * an origin is not the same as running what it offers, and without this the two
 * are indistinguishable.
 */
export type PieceReconciliationView = {
  /**
   * What that attempt did.
   */
  outcome: PieceReconciliationOutcome;

  /**
   * When the piece reached this outcome.
   */
  at: number;

  /**
   * The origin the attempt was following.
   */
  origin: string;

  /**
   * The pattern the origin offered, when one was resolved.
   */
  offered?: PiecePatternRefView;

  /**
   * Why the candidate was refused. Absent unless `outcome` is `refused`.
   */
  reason?: PieceReconciliationReason;

  /**
   * What the attempt reported, in its own words.
   */
  detail?: string;
};

/** A recorded source string no resolver can follow, with why. */
export type PieceUnusableOriginView = {
  /**
   * The string the piece records.
   */
  recorded: string;

  /**
   * Why nothing can follow it.
   */
  reason: string;
};

/** What produced one revision of a piece's source. */
export type PieceSourceRevisionOperation =
  | "baseline"
  | "create"
  | "edit"
  | "origin-update"
  | "detach"
  | "revert"
  | "follow"
  | "repoint";

/**
 * One entry of a piece's source history: what the piece pointed at, when, and
 * which operation put it there.
 */
export type PieceSourceRevisionView = {
  /**
   * This revision's id.
   */
  revisionId: string;

  /**
   * When it was made.
   */
  timestamp: number;

  /**
   * What the piece pointed at afterwards.
   */
  pattern: PiecePatternRefView;

  /**
   * Where that pattern came from, for a pattern that came from anywhere.
   */
  origin?: PieceOriginView;

  /**
   * What produced this revision.
   */
  operation: PieceSourceRevisionOperation;

  /**
   * The revision this operation acted on, for the operations that name
   * one -- a revert or a follow.
   */
  selectedRevisionId?: string;
};

/**
 * A piece's source as the client displays it -- its name, the patterns bound
 * to it, where it came from, its files, and its whole revision history.
 * `displacedPattern` records a pattern an update moved aside rather than one
 * in use.
 */
export type PieceSourceView = {
  /**
   * The space the piece lives in.
   */
  space: DID;

  /**
   * The piece this describes.
   */
  pieceId: string;

  /**
   * The piece's name, where it has one.
   */
  name?: string;

  /**
   * The pattern the piece currently runs.
   */
  pattern?: PiecePatternRefView;

  /**
   * The pattern that set the piece up, where that differs from the one
   * it runs.
   */
  setupPattern?: PiecePatternRefView;

  /**
   * A pattern an update moved aside, with when it happened. Recorded so
   * the displacement stays visible; this is not a pattern in use.
   */
  displacedPattern?: PiecePatternRefView & { displacedAt?: number };

  /**
   * Where the source came from.
   */
  origin?: PieceOriginView;

  /**
   * A recorded source string no resolver can follow. A piece carrying one is
   * neither following nor detached.
   */
  unusableOrigin?: PieceUnusableOriginView;

  /**
   * What following the active origin last did.
   */
  reconciliation?: PieceReconciliationView;

  /**
   * The repository the source is tracked in, where it is.
   */
  repository?: string;

  /**
   * The entry file among `files`.
   */
  entry?: string;

  /**
   * Every file of the source, code and data alike.
   */
  files: readonly PatternSourceFile[];

  /** Names among `files` that carry data rather than code. */
  dataFiles?: readonly string[];

  /**
   * Every revision, which is what the current one is chosen from.
   */
  history: readonly PieceSourceRevisionView[];

  /**
   * Which of `history` the piece is on.
   */
  currentRevisionId?: string;
};

/** A piece's current source, with its whole revision history. */
export type PieceSourceResponse = {
  /**
   * The piece's source and history.
   */
  source: PieceSourceView;
};

/**
 * One historical revision's source: the pattern and files as they stood then,
 * without the surrounding history that {@link PieceSourceView} carries.
 */
export type PieceSourceRevisionSourceView = {
  /**
   * The pattern as of that revision.
   */
  pattern: PiecePatternRefView;

  /**
   * The files as of that revision.
   */
  files: readonly PatternSourceFile[];

  /** Names among `files` that carry data rather than code. */
  dataFiles?: readonly string[];
};

/** One named revision of a piece's source, without the history around it. */
export type PieceSourceRevisionResponse = {
  /**
   * That revision's source.
   */
  source: PieceSourceRevisionSourceView;
};

/**
 * A change to which source a piece follows. `repoint` moves the piece to an
 * origin supplied by its owner, which may be one the piece has never followed;
 * `adopt` takes what the active origin offers now, which is how a refused
 * automatic update is overridden without giving up the origin.
 */
export type PieceSourceAction =
  | { kind: "detach" }
  | { kind: "restore"; revisionId: string }
  | { kind: "follow"; revisionId: string }
  | { kind: "repoint"; url: string }
  | { kind: "adopt" };

/**
 * The {@link RequestType.PieceUpdateSource} request. `confirmationToken` is the
 * token an incompatibility warning returned; sending it back is what confirms
 * the update.
 */
export type PieceUpdateSourceRequest = BaseRequest & PieceAddress & {
  type: RequestType.PieceUpdateSource;

  /**
   * The space the piece lives in.
   */
  space: DID;

  /**
   * What to change about which source the piece follows.
   */
  action: PieceSourceAction;

  /** Opaque token returned with an incompatibility warning. */
  confirmationToken?: string;
};

/**
 * The piece's source after an update, or the reason one did not happen. A
 * `compatibilityWarning` comes with a `confirmationToken`, and sending that
 * token back is what turns the refusal into an update; an `executionWarning`
 * reports an update that landed but whose pattern then misbehaved.
 */
export type PieceUpdateSourceResponse = PieceSourceResponse & {
  /**
   * Why the update was not applied, where it was refused as
   * incompatible. Comes with a `confirmationToken`.
   */
  compatibilityWarning?: string;

  /**
   * Sent back on a repeat request to apply the update anyway.
   */
  confirmationToken?: string;

  /**
   * Reports an update that landed but whose pattern then misbehaved --
   * which is a different outcome from a refusal.
   */
  executionWarning?: string;
};

/** One access level in a space ACL. */
export type SpaceAclCapability = "READ" | "WRITE" | "OWNER";

/** The space ACL and the current principal's ability to administer it. */
export type SpaceAclView = {
  /**
   * The space this describes.
   */
  space: DID;

  /**
   * Whose view this is, capabilities being reported as they stand for
   * one reader.
   */
  principal: DID;

  /**
   * What each user may do, by user.
   */
  acl: Record<string, SpaceAclCapability>;

  /**
   * Whether `principal` may change the list at all.
   */
  canEdit: boolean;
};

/** Response carrying a space's access-control view. */
export type SpaceAclResponse = {
  /**
   * The space's access list, as it stands for the caller.
   */
  access: SpaceAclView;
};

/** Reads the ACL for one space. */
export type SpaceGetAclRequest = BaseRequest & {
  type: RequestType.SpaceGetAcl;

  /**
   * The space whose access list to read.
   */
  space: DID;
};

/** Adds or replaces one explicit ACL entry in a space. */
export type SpaceSetAclEntryRequest = BaseRequest & {
  type: RequestType.SpaceSetAclEntry;

  /**
   * The space to grant on.
   */
  space: DID;

  /**
   * Who to grant to.
   */
  user: string;

  /**
   * What to grant, replacing whatever the user held.
   */
  capability: SpaceAclCapability;
};

/** Removes one explicit ACL entry from a space. */
export type SpaceRemoveAclEntryRequest = BaseRequest & {
  type: RequestType.SpaceRemoveAclEntry;

  /**
   * The space to remove from.
   */
  space: DID;

  /**
   * Whose entry to remove.
   */
  user: string;
};

/** Common shape for one-way main -> worker notifications. */
export type BaseClientNotification = {
  /**
   * Which notification this is.
   */
  type: ClientNotificationType;
};

/**
 * VDOM event message sent from main thread to worker when a DOM event fires.
 */
export type VDomEventNotification = BaseClientNotification & {
  type: ClientNotificationType.VDomEvent;

  /** The mount ID that this event belongs to */
  mountId: number;

  /** The handler ID that should process this event */
  handlerId: number;

  /** The serialized event data */
  event: SerializedDomEvent;

  /** The node ID where the event occurred */
  nodeId: number;
};

/**
 * The shape a DOM event crosses in, and the shape of its target within it.
 *
 * `serializeEvent()` in `@commonfabric/html` is what produces both, so that is
 * where they are defined; the protocol re-exports them so a message shape and
 * the event inside it cannot describe different things. That is the same
 * arrangement, and for the same reason, as the VDOM op union below.
 *
 * The event's name here is `SerializedDomEvent`, which says which of this
 * file's messages it belongs to; `SerializedEvent` alone would not, among the
 * other serialized things around it.
 */
import type {
  SerializedEvent as SerializedDomEvent,
  SerializedEventTarget,
} from "@commonfabric/html/events";

export type { SerializedDomEvent, SerializedEventTarget };

/**
 * Request to start VDOM rendering for a cell.
 * The worker will subscribe to the cell and send VDomBatch notifications.
 */
export type VDomMountRequest = BaseRequest & {
  type: RequestType.VDomMount;

  /** Unique ID for this mount instance (used to match unmount) */
  mountId: number;

  /** The cell to render as VDOM */
  cell: CellRef;
};

/**
 * Request to stop VDOM rendering for a mount.
 */
export type VDomUnmountRequest = BaseRequest & {
  type: RequestType.VDomUnmount;

  /** The mount ID to stop */
  mountId: number;
};

/**
 * Notification sent after the main thread applies a VDOM batch.
 */
export type VDomBatchAppliedNotification = BaseClientNotification & {
  type: ClientNotificationType.VDomBatchApplied;

  /** The mount ID that received the batch */
  mountId: number;

  /** The applied batch ID */
  batchId: number;
};

/** Union of all one-way main -> worker notifications. */
export type IPCClientNotification =
  | VDomEventNotification
  | VDomBatchAppliedNotification;

/**
 * Response to VDomMount, naming the tree's root node.
 */
export type VDomMountResponse = {
  /**
   * The root node ID for this mount; `null` when the tree has no root child.
   * `VDomBatchNotification` represents absence the same way, so a reader maps
   * both directions with one rule.
   */
  rootId: number | null;
};

/**
 * Every request a client can send.
 *
 * Each arm is a type alias rather than an `interface`, and must stay one: the
 * envelope is encoded as a `FabricValue`, and TypeScript grants the implicit
 * index signature that `FabricPlainObject` needs to an anonymous object type
 * and not to an interface.
 */
export type IPCClientRequest =
  | InitializeRequest
  | AttachRequest
  | DisposeRequest
  | CellGetRequest
  | CellPullRequest
  | CellInitializeRequest
  | CellSetRequest
  | CellPushRequest
  | CellSendRequest
  | CellSubscribeRequest
  | CellUnsubscribeRequest
  | CellResolveAsCellRequest
  | CellGetCfcLabelRequest
  | SnapshotSharePrepareRequest
  | SnapshotShareCommitRequest
  | SnapshotShareCancelRequest
  | OperationCapabilitiesRequest
  | OperationQueryRequest
  | OperationApplyRequest
  | OperationReleaseRequest
  | OperationSubscribeRequest
  | OperationUnsubscribeRequest
  | OperationSessionCloseRequest
  | SqliteQueryRequest
  | SqliteExecRequest
  | GetCellRequest
  | GetHomeSpaceCellRequest
  | EnsureHomePatternRunningRequest
  | ListEventAttentionRequest
  | ResolveEventAttentionRequest
  | GetGraphSnapshotRequest
  | GetLoggerCountsRequest
  | GetPatternCoverageRequest
  | SetLoggerLevelRequest
  | SetLoggerEnabledRequest
  | SetTelemetryEnabledRequest
  | SetReadStatsEnabledRequest
  | SetMemoryMessageCompressionRequest
  | SetForwardWorkerConsoleRequest
  | ResetLoggerBaselinesRequest
  | GetSettleStatsRequest
  | GetSettleStatsHistoryRequest
  | SetSettleStatsEnabledRequest
  | GetActionRunTraceRequest
  | SetActionRunTraceEnabledRequest
  | GetTriggerTraceRequest
  | SetTriggerTraceEnabledRequest
  | GetWriteStackTraceRequest
  | SetWriteStackTraceMatchersRequest
  | IdleRequest
  | FlushCompileCacheWritesRequest
  | PieceCreateRequest
  | GetSpaceRootPatternRequest
  | RecreateSpaceRootPatternRequest
  | PieceGetRequest
  | PieceGetSlugRequest
  | SlugResolveRequest
  | PieceRemoveRequest
  | PieceStartRequest
  | PieceStopRequest
  | PieceGetAllRequest
  | PieceSyncedRequest
  | PieceGetSourceRequest
  | PieceGetSourceRevisionRequest
  | PieceCloneRequest
  | PieceUpdateSourceRequest
  | SpaceGetAclRequest
  | SpaceSetAclEntryRequest
  | SpaceRemoveAclEntryRequest
  | RuntimeSyncedRequest
  | ResolveSpaceNameRequest
  | RegisterSpaceHostRequest
  | VDomMountRequest
  | VDomUnmountRequest
  | DetectNonIdempotentRequest
  | GetPatternSourcesRequest
  | SetBreakpointsRequest
  | UploadBlobRequest;

/**
 * The requests naming a piece by id, read off {@link IPCClientRequest} rather
 * than listed, so that a request joins this by being declared rather than by
 * anyone remembering to enroll it.
 *
 * Membership is having a `pieceId` member at all, whatever its type: an
 * optional one, and one whose type admits `undefined`, each still name a
 * piece on the requests that send one, so both are in. That is what the test
 * on `keyof` buys. A property that may be absent, and one whose type includes
 * `undefined`, are each unassignable to a required `string`, so a membership
 * test written as an assignment would see neither.
 */
export type PieceAddressedRequest = IPCClientRequest extends infer Request
  ? Request extends unknown ? "pieceId" extends keyof Request ? Request : never
  : never
  : never;

/**
 * Those {@link PieceAddressedRequest}s declaring no `scope`, which is `never`
 * exactly while every one of them intersects {@link PieceAddress}.
 *
 * The bound is the member name, on both sides. What puts a request in front
 * of this check is declaring `pieceId`, so a request naming a piece under
 * some other field is outside it, as is one reaching a piece through a
 * {@link CellRef}, which carries its own scope. And what satisfies the check
 * is declaring `scope` in any form: the shape a scope has is
 * {@link PieceAddress}'s to state, and is not read here.
 */
type PieceAddressedRequestMissingScope = PieceAddressedRequest extends
  infer Request
  ? Request extends unknown ? "scope" extends keyof Request ? never : Request
  : never
  : never;

/**
 * Refuses anything but `never`, so that instantiating it with a union of
 * requests reports those requests as the error.
 */
type NoSuchRequest<T extends never> = T;

/**
 * A piece's address is its id and its scope together, and this is what says
 * so at the protocol level: a new request naming a piece by id without a
 * scope inhabits {@link PieceAddressedRequestMissingScope}, and this
 * declaration then fails `deno task check` naming that request.
 */
type EveryPieceAddressCarriesItsScope = NoSuchRequest<
  PieceAddressedRequestMissingScope
>;

/** A response whose whole content is `null`. */
export type NullResponse = null;

/**
 * A response carrying nothing at all. The envelope omits `data` entirely
 * rather than sending `undefined`, so an ack is a bare `{ msgId }`.
 */
export type EmptyResponse = undefined;

/** A single boolean verdict. */
export type BooleanResponse = {
  /**
   * The verdict.
   */
  value: boolean;
};

/**
 * A cell's value on its way _out_ of the worker. The two directions carry the
 * same domain, which they did not before the envelope was encoded: outbound
 * lost a `FabricPrimitive` to structured clone where inbound refused one
 * outright.
 */
export type CellValueResponse = {
  /**
   * The value read. A read that finds nothing is not distinguishable here:
   * `undefined` is a `FabricValue` and a value a cell can hold, so it is what
   * both answers look like.
   */
  value: FabricValue;
};

/**
 * A cell read's answer. `cfcLabel` is present only when the request asked for
 * it, and `cell` only when it asked and the read resolved to a cell -- a raw
 * metadata read has none to name.
 */
export type CellGetResponse = CellValueResponse & {
  /**
   * The cell's display label, present only where the request set
   * `includeCfcLabel`. `undefined` is a valid value, the cell carrying no
   * label; the field is omitted rather than undefined when not requested.
   */
  cfcLabel?: CfcLabelView | undefined;

  /**
   * A ref to the cell the read resolved to, present only where the request
   * set `includeRef` and the read reached a cell -- a raw metadata read has
   * none to reference.
   */
  cell?: CellRef;
};

/** Rows returned by {@link RequestType.SqliteQuery}. */
export type SqliteQueryResponse = {
  /**
   * The result set, one entry per row, each keyed by the column names the
   * statement selected. Empty when the statement returned no rows.
   */
  rows: readonly {
    readonly [key: string]: FabricValue;
  }[];
};

/** A reference to one cell, for a request whose answer is which cell. */
export type CellResponse = {
  /**
   * The cell in question.
   */
  cell: CellRef;
};

/**
 * A cell's display label. `undefined` means the cell carries none, which is
 * distinct from the request having failed.
 */
export type CfcLabelViewResponse = {
  /**
   * The cell's display label, `undefined` where it carries none.
   */
  cfcLabel: CfcLabelView | undefined;
};

/** A reference to one piece. */
export type PieceResponse = {
  /**
   * The piece in question.
   */
  piece: PieceRef;
};

/**
 * Why a slug reference reached nothing. This is an outcome, not a failure:
 * a name nobody has bound, or a member a collection does not hold, is what a
 * reader is asking about, so it crosses as data and leaves the error channel
 * to transport and decoding faults.
 */
export type SlugRefusal = {
  /**
   * Which refusal it is, as the runner's slug resolution names them.
   */
  code: string;

  /**
   * What to tell a reader, naming the collection and the member where the
   * refusal knows them.
   */
  message: string;
};

/**
 * Where a slug reference landed: the piece it reached and the segments the
 * walk did not spend, or the refusal that says it reached nothing.
 *
 * The two are arms of a union rather than optional fields of one object, so
 * that a response carrying both cannot be built. Written as optionals, the
 * contradiction is a shape the type admits and only a reader can catch, and a
 * reader that checks the refusal first reports a malformed answer as an
 * ordinary "no such member".
 */
export type SlugReferenceResponse =
  | {
    /**
     * The piece the reference reached.
     */
    piece: PieceRef;

    /**
     * What is left of the reference after the piece. Empty where the member
     * named a member; the member itself where the slug named a piece at its
     * root, which spends no segment and leaves the member a cell path the
     * piece's own address does not include.
     */
    pathAfter: string[];

    /** Absent, which is what makes this the landing arm. */
    refusal?: undefined;
  }
  | {
    /** Absent, which is what makes this the refusal arm. */
    piece?: undefined;

    /** Absent with the piece. */
    pathAfter?: undefined;

    /**
     * Why the reference reached nothing.
     */
    refusal: SlugRefusal;
  };

/** A piece's slug, `undefined` where the piece has none. */
export type SlugResponse = {
  /**
   * The piece's slug, `undefined` where it has none.
   */
  slug: string | undefined;
};

/** One space, by DID. */
export type SpaceResponse = {
  /**
   * The space in question.
   */
  space: DID;
};

/** A snapshot of the scheduler's reactive graph, as of the read. */
export type GraphSnapshotResponse = {
  /**
   * The graph as of the read.
   */
  snapshot: SchedulerGraphSnapshot;
};

/**
 * Everything the logger diagnostics read returns: counts, per-logger
 * metadata, timings, and active flags, gathered in one round trip because a
 * client comparing them wants them from the same moment.
 */
export type LoggerCountsResponse = {
  /**
   * How many messages each logger recorded.
   */
  counts: LoggerCountsData;

  /**
   * Each logger's enabled state and level.
   */
  metadata: LoggerMetadata;

  /**
   * Each timed operation's statistics.
   */
  timing: LoggerTimingData;

  /**
   * The flags currently set, by logger.
   */
  flags: LoggerFlagsData;

  /**
   * The runtime's CFC counters, in the same round trip. They answer questions
   * the logger's own rows cannot — how many flow-label probes were evaluated
   * rather than memoized, and how large a dereference-trace set any one
   * transaction held — and a client reading them against the timings wants
   * both from the same moment.
   *
   * A record of counters rather than the runner's `CfcRuntimeStats`: a
   * response crosses the boundary as a `FabricValue`, which an interface with
   * no index signature does not satisfy, and every counter there is a number.
   */
  cfc: Record<string, number>;
};

/** The worker's pattern coverage, where this worker collects any. */
export type PatternCoverageResponse = {
  /**
   * The worker collector's spans and hit counts, or `null` when this worker was
   * built without a collector. Null and empty are kept apart on purpose: a
   * worker that never had coverage on and one that had it on but ran nothing
   * instrumented are different failures, and reporting both as an empty report
   * makes the first invisible.
   */
  data: PatternCoverageData | null;
};

/**
 * A new value for a subscribed cell. `cfcLabel` rides along only for a
 * subscription that opted in, so that a label change re-renders without a
 * second round trip.
 */
export type CellUpdateNotification = {
  type: NotificationType.CellUpdate;

  /**
   * The cell that changed.
   */
  cell: CellRef;

  /** Its new value, as {@link CellValueResponse} carries the pulled form. */
  value: FabricValue;

  /**
   * The cell's current display label, present only for a subscription that
   * opted in through `includeCfcLabel`, so the client re-renders on a label
   * change without a separate round trip.
   */
  cfcLabel?: CfcLabelView | undefined;
};

/**
 * One `console.*` call made by a pattern, with the arguments it was given.
 * `metadata` names the piece, pattern, and space it came from where those are
 * known.
 */
export type ConsoleNotification = {
  type: NotificationType.ConsoleMessage;

  /**
   * Where the call came from, for the parts of that the worker knows.
   */
  metadata?: { pieceId?: string; patternId?: string; space?: string };

  /**
   * Which `console` method was called.
   */
  method: string;

  /**
   * The arguments, as the values the pattern logged. They cross inside the
   * envelope's own encoding, so a `FabricBytes` arrives as bytes and an
   * instance arrives with its class.
   */
  args: FabricArray;
};

/**
 * A console notification as the client emits it: the same shape the worker
 * sent. The arguments were values on the wire, so there is nothing left for
 * the client to convert.
 */
export type ConsoleMessage = ConsoleNotification;

/**
 * A pattern asking the client to navigate to a cell. A request in name only:
 * it carries no `msgId` and nothing is sent back, so the client is free to
 * ignore it.
 */
export type NavigateRequestNotification = {
  type: NotificationType.NavigateRequest;

  /**
   * The cell to navigate to.
   */
  targetCellRef: CellRef;
};

/** A refused event admission. Read access to the space can remain valid. */
export type EventIntentOutcomeNotice = {
  space: DID;
  eventId: string;
  kind: "refused";
  reason: "admission-refused";
};

/** A payload-free outcome delivered to the runtime's accepted clients. */
export type EventIntentOutcomeNotification = EventIntentOutcomeNotice & {
  type: NotificationType.EventIntentOutcome;
};

/** An authoritative loss of the runtime principal's access to one space. */
export type SpaceAccessLostNotification = {
  type: NotificationType.SpaceAccessLost;
  space: DID;
};

/**
 * An error with no request to fail -- a renderer error, or one a pattern
 * raised between requests. Every field but `message` is context that the
 * raising site may or may not have had.
 */
export type ErrorNotification = {
  type: NotificationType.ErrorReport;

  /**
   * What went wrong.
   */
  message: string;

  /**
   * Names the kind of failure where one is named.
   */
  code?: RuntimeErrorCode;

  /**
   * The piece it happened in, where that is known.
   */
  pieceId?: string;

  /**
   * The space it happened in, where that is known.
   */
  space?: string;

  /**
   * The pattern it happened in, where that is known.
   */
  patternId?: string;

  /**
   * The spell it happened in, where that is known.
   */
  spellId?: string;

  /**
   * The stack as raised, where one survived.
   */
  stackTrace?: string;
};

/** One telemetry marker. Sent only while telemetry is enabled. */
export type TelemetryNotification = {
  type: NotificationType.Telemetry;

  /**
   * The marker, with the timestamp the runtime stamped it at.
   */
  marker: RuntimeTelemetryMarkerResult;
};

/**
 * Worker-to-page mirror of the storage manager's durability barrier: `pending`
 * is true while any issued commit is still unconfirmed by the server, false
 * once the pending set drains. The shell consults the latest value from its
 * beforeunload handler so a reload with unconfirmed writes prompts the user.
 */
export type PendingWritesNotification = {
  type: NotificationType.PendingWritesChanged;

  /**
   * Whether any issued commit is still unconfirmed.
   */
  pending: boolean;
};

/** The authoritative safe recovery handle presented by the runtime client. */
export type EventAttentionNotice = {
  /** The space whose delivery ended this way. */
  space: DID;

  /** The event that failed to deliver. */
  eventId: string;

  /**
   * The stream seq the engine stamped on the commit that appended the
   * event. One notice covers every delivery attempt of that entry; the
   * attempts themselves are counted inside `attention`.
   */
  seq: number;

  /** The sidecar record the notice is stored as, and the handle a
   * resolution compares and swaps against. */
  sidecarId: string;

  /** False when the terminal event has no acting user and can only be
   * dismissed. Absence preserves Retry for older producers. */
  retryable?: boolean;

  /** Why the delivery ended, in terms meant for the person reading it. */
  reason: string;

  /** What the delivery is waiting on, which is what a surface renders the
   * notice from. */
  attention: DeliveryAttention;
};

/** Worker-to-page signal for a newly observed terminal delivery notice. */
export type EventNeedsAttentionNotification = EventAttentionNotice & {
  type: NotificationType.EventNeedsAttention;
};

/** The unresolved notices in one space that the requester may act on. */
export type EventAttentionListResponse = {
  /**
   * The notices still awaiting a person, in no promised order, narrowed to
   * those whose acting user is the requesting identity plus those with no
   * acting user at all. Empty therefore says the requester has none to act
   * on, not that the space is holding none.
   */
  notices: EventAttentionNotice[];
};

/** What became of one notice a resolution was asked for. */
export type EventAttentionResolveResponse = {
  /**
   * The outcome, which is the memory-v2 compare-and-swap's answer rather
   * than the request's: a notice another client resolved first comes back
   * as such rather than as a failure.
   */
  resolution: EventAttentionResolution;
};

/**
 * The worker's first post, announcing that its entry module has run and its
 * message listener is installed. The transport's `ready()` settles on it.
 */
export type WorkerReadyNotification = {
  type: TransportNotificationType.WorkerReady;
};

/** The `console` methods the worker's console bridge forwards. */
export const WORKER_CONSOLE_LEVELS = ["log", "warn", "error"] as const;

/** One of {@link WORKER_CONSOLE_LEVELS}. */
export type WorkerConsoleLevel = (typeof WORKER_CONSOLE_LEVELS)[number];

/**
 * One line of the worker's own `console` output, forwarded so that it reaches
 * the page console too. Opt-in, through `SetForwardWorkerConsole`.
 *
 * The subject is the worker itself, where `ConsoleNotification`'s is a pattern
 * running inside it. That is also why this one carries text: the worker's own
 * logging is rendered where it is written, and a pattern's arguments cross as
 * values.
 */
export type WorkerConsoleNotification = {
  type: TransportNotificationType.WorkerConsole;

  /**
   * Which `console` method the worker called.
   */
  level: WorkerConsoleLevel;

  /**
   * The call's arguments, already rendered to text.
   */
  text: string;
};

/**
 * The vocabulary of DOM mutations carried by a VDOM batch. The worker
 * reconciler that produces them and the main-thread applicator that consumes
 * them both live in `@commonfabric/html`, which defines the union; the protocol
 * re-exports it so a message shape and the ops inside it cannot describe
 * different things.
 */
import type { VDomOp } from "@commonfabric/html/vdom-ops";

export type { VDomOp };

/**
 * VDOM batch notification sent from worker to main thread.
 */
export type VDomBatchNotification = {
  type: NotificationType.VDomBatch;

  /** Identifier for this batch (for debugging/logging) */
  batchId: number;

  /** The operations to apply, in order */
  ops: readonly VDomOp[];

  /**
   * The root node ID for this render tree; `null` while the tree has no root
   * child, which the reconciler reports as a value rather than by omission.
   * Absent when the batch says nothing about the root at all.
   */
  rootId?: number | null;

  /** The mount ID this batch belongs to */
  mountId?: number;
};

/** A new operation-backed snapshot for one active subscription. */
export type OperationUpdateNotification = {
  type: NotificationType.OperationUpdate;

  /**
   * The subscription this is for, as
   * {@link OperationSubscribeRequest.subscriptionId} named it.
   */
  subscriptionId: string;

  /** The field as it now stands, in the shape a query returns it. */
  field: OperationFieldSnapshot;
};

/**
 * Every shape a successful response can carry. The arm a given request yields
 * is fixed by {@link Commands} rather than chosen here.
 */
export type RemoteResponse =
  | EmptyResponse
  | NullResponse
  | BooleanResponse
  | CellValueResponse
  | CellGetResponse
  | CellResponse
  | CfcLabelViewResponse
  | SnapshotSharePreview
  | SqliteQueryResponse
  | GraphSnapshotResponse
  | LoggerCountsResponse
  | PatternCoverageResponse
  | SettleStatsResponse
  | SettleStatsHistoryResponse
  | ActionRunTraceResponse
  | TriggerTraceResponse
  | WriteStackTraceResponse
  | PieceResponse
  | SlugReferenceResponse
  | PieceSourceResponse
  | PieceSourceRevisionResponse
  | PieceUpdateSourceResponse
  | SpaceAclResponse
  | SlugResponse
  | SpaceResponse
  | VDomMountResponse
  | DetectNonIdempotentResponse
  | PatternSourcesResponse
  | UploadBlobResponse
  | OperationCapabilitiesResponse
  | OperationFieldResponse
  | OperationApplyResponse
  | EventAttentionListResponse
  | EventAttentionResolveResponse;

/**
 * Everything the worker reports without being asked. Each arm is recognized
 * by its own guard in `guards.ts`; adding one means adding both.
 */
export type IPCRemoteNotification =
  | CellUpdateNotification
  | ConsoleNotification
  | NavigateRequestNotification
  | ErrorNotification
  | EventIntentOutcomeNotification
  | SpaceAccessLostNotification
  | TelemetryNotification
  | VDomBatchNotification
  | PendingWritesNotification
  | OperationUpdateNotification
  | EventNeedsAttentionNotification;

/**
 * The request-and-response pairing for every {@link RequestType}. This is what
 * types a call site's return, so adding a request means adding its entry here
 * as well as its arm to {@link IPCClientRequest}.
 *
 * The `request` and `response` members carry no doc comments of their own,
 * deliberately: each names a type documented where it is declared, and the
 * pairing is the whole of what an entry says. A comment on either would
 * restate the name beside it.
 */
export type Commands = {
  // Runtime requests
  [RequestType.Initialize]: {
    request: InitializeRequest;
    response: EmptyResponse;
  };
  [RequestType.Attach]: {
    request: AttachRequest;
    response: EmptyResponse;
  };
  [RequestType.Dispose]: {
    request: DisposeRequest;
    response: EmptyResponse;
  };
  [RequestType.GetCell]: {
    request: GetCellRequest;
    response: CellResponse;
  };
  [RequestType.GetHomeSpaceCell]: {
    request: GetHomeSpaceCellRequest;
    response: CellResponse;
  };
  [RequestType.EnsureHomePatternRunning]: {
    request: EnsureHomePatternRunningRequest;
    response: CellResponse;
  };
  [RequestType.Idle]: {
    request: IdleRequest;
    response: EmptyResponse;
  };
  [RequestType.ListEventAttention]: {
    request: ListEventAttentionRequest;
    response: EventAttentionListResponse;
  };
  [RequestType.ResolveEventAttention]: {
    request: ResolveEventAttentionRequest;
    response: EventAttentionResolveResponse;
  };
  [RequestType.FlushCompileCacheWrites]: {
    request: FlushCompileCacheWritesRequest;
    response: EmptyResponse;
  };
  [RequestType.GetGraphSnapshot]: {
    request: GetGraphSnapshotRequest;
    response: GraphSnapshotResponse;
  };
  [RequestType.GetLoggerCounts]: {
    request: GetLoggerCountsRequest;
    response: LoggerCountsResponse;
  };
  [RequestType.GetPatternCoverage]: {
    request: GetPatternCoverageRequest;
    response: PatternCoverageResponse;
  };
  [RequestType.SetLoggerLevel]: {
    request: SetLoggerLevelRequest;
    response: EmptyResponse;
  };
  [RequestType.SetLoggerEnabled]: {
    request: SetLoggerEnabledRequest;
    response: EmptyResponse;
  };
  [RequestType.SetTelemetryEnabled]: {
    request: SetTelemetryEnabledRequest;
    response: EmptyResponse;
  };
  [RequestType.SetReadStatsEnabled]: {
    request: SetReadStatsEnabledRequest;
    response: EmptyResponse;
  };
  [RequestType.SetMemoryMessageCompression]: {
    request: SetMemoryMessageCompressionRequest;
    response: EmptyResponse;
  };
  [RequestType.SetForwardWorkerConsole]: {
    request: SetForwardWorkerConsoleRequest;
    response: EmptyResponse;
  };
  [RequestType.ResetLoggerBaselines]: {
    request: ResetLoggerBaselinesRequest;
    response: EmptyResponse;
  };
  [RequestType.GetSettleStats]: {
    request: GetSettleStatsRequest;
    response: SettleStatsResponse;
  };
  [RequestType.GetSettleStatsHistory]: {
    request: GetSettleStatsHistoryRequest;
    response: SettleStatsHistoryResponse;
  };
  [RequestType.SetSettleStatsEnabled]: {
    request: SetSettleStatsEnabledRequest;
    response: EmptyResponse;
  };
  [RequestType.GetActionRunTrace]: {
    request: GetActionRunTraceRequest;
    response: ActionRunTraceResponse;
  };
  [RequestType.SetActionRunTraceEnabled]: {
    request: SetActionRunTraceEnabledRequest;
    response: EmptyResponse;
  };
  [RequestType.GetTriggerTrace]: {
    request: GetTriggerTraceRequest;
    response: TriggerTraceResponse;
  };
  [RequestType.SetTriggerTraceEnabled]: {
    request: SetTriggerTraceEnabledRequest;
    response: EmptyResponse;
  };
  [RequestType.GetWriteStackTrace]: {
    request: GetWriteStackTraceRequest;
    response: WriteStackTraceResponse;
  };
  [RequestType.SetWriteStackTraceMatchers]: {
    request: SetWriteStackTraceMatchersRequest;
    response: EmptyResponse;
  };
  // Cell requests
  [RequestType.CellGet]: {
    request: CellGetRequest;
    response: CellGetResponse;
  };
  [RequestType.CellPull]: {
    request: CellPullRequest;
    response: CellGetResponse;
  };
  [RequestType.CellInitialize]: {
    request: CellInitializeRequest;
    response: CellValueResponse;
  };
  [RequestType.CellSet]: {
    request: CellSetRequest;
    response: EmptyResponse;
  };
  [RequestType.CellPush]: {
    request: CellPushRequest;
    response: EmptyResponse;
  };
  [RequestType.CellSend]: {
    request: CellSendRequest;
    response: EmptyResponse;
  };
  [RequestType.CellSubscribe]: {
    request: CellSubscribeRequest;
    response: BooleanResponse;
  };
  [RequestType.CellUnsubscribe]: {
    request: CellUnsubscribeRequest;
    response: BooleanResponse;
  };
  [RequestType.CellResolveAsCell]: {
    request: CellResolveAsCellRequest;
    response: CellResponse;
  };
  [RequestType.CellGetCfcLabel]: {
    request: CellGetCfcLabelRequest;
    response: CfcLabelViewResponse;
  };
  [RequestType.SnapshotSharePrepare]: {
    request: SnapshotSharePrepareRequest;
    response: SnapshotSharePreview;
  };
  [RequestType.SnapshotShareCommit]: {
    request: SnapshotShareCommitRequest;
    response: CellResponse;
  };
  [RequestType.SnapshotShareCancel]: {
    request: SnapshotShareCancelRequest;
    response: EmptyResponse;
  };
  [RequestType.OperationCapabilities]: {
    request: OperationCapabilitiesRequest;
    response: OperationCapabilitiesResponse;
  };
  [RequestType.OperationQuery]: {
    request: OperationQueryRequest;
    response: OperationFieldResponse;
  };
  [RequestType.OperationApply]: {
    request: OperationApplyRequest;
    response: OperationApplyResponse;
  };
  [RequestType.OperationRelease]: {
    request: OperationReleaseRequest;
    response: BooleanResponse;
  };
  [RequestType.OperationSubscribe]: {
    request: OperationSubscribeRequest;
    response: BooleanResponse;
  };
  [RequestType.OperationUnsubscribe]: {
    request: OperationUnsubscribeRequest;
    response: BooleanResponse;
  };
  [RequestType.OperationSessionClose]: {
    request: OperationSessionCloseRequest;
    response: BooleanResponse;
  };
  [RequestType.SqliteQuery]: {
    request: SqliteQueryRequest;
    response: SqliteQueryResponse;
  };
  [RequestType.SqliteExec]: {
    request: SqliteExecRequest;
    response: EmptyResponse;
  };
  // Piece requests
  [RequestType.PieceCreate]: {
    request: PieceCreateRequest;
    response: PieceResponse;
  };
  [RequestType.PieceSynced]: {
    request: PieceSyncedRequest;
    response: EmptyResponse;
  };
  [RequestType.RuntimeSynced]: {
    request: RuntimeSyncedRequest;
    response: EmptyResponse;
  };
  [RequestType.ResolveSpaceName]: {
    request: ResolveSpaceNameRequest;
    response: SpaceResponse;
  };
  [RequestType.RegisterSpaceHost]: {
    request: RegisterSpaceHostRequest;
    response: BooleanResponse;
  };
  [RequestType.PieceGet]: {
    request: PieceGetRequest;
    response: PieceResponse | NullResponse;
  };
  [RequestType.PieceGetSlug]: {
    request: PieceGetSlugRequest;
    response: SlugResponse;
  };
  [RequestType.SlugResolve]: {
    request: SlugResolveRequest;
    response: SlugReferenceResponse;
  };
  [RequestType.PieceRemove]: {
    request: PieceRemoveRequest;
    response: BooleanResponse;
  };
  [RequestType.PieceStart]: {
    request: PieceStartRequest;
    response: BooleanResponse;
  };
  [RequestType.PieceStop]: {
    request: PieceStopRequest;
    response: BooleanResponse;
  };
  [RequestType.PieceGetAll]: {
    request: PieceGetAllRequest;
    response: CellResponse;
  };
  [RequestType.PieceGetSource]: {
    request: PieceGetSourceRequest;
    response: PieceSourceResponse;
  };
  [RequestType.PieceGetSourceRevision]: {
    request: PieceGetSourceRevisionRequest;
    response: PieceSourceRevisionResponse;
  };
  [RequestType.PieceClone]: {
    request: PieceCloneRequest;
    response: PieceResponse;
  };
  [RequestType.PieceUpdateSource]: {
    request: PieceUpdateSourceRequest;
    response: PieceUpdateSourceResponse;
  };
  [RequestType.SpaceGetAcl]: {
    request: SpaceGetAclRequest;
    response: SpaceAclResponse;
  };
  [RequestType.SpaceSetAclEntry]: {
    request: SpaceSetAclEntryRequest;
    response: SpaceAclResponse;
  };
  [RequestType.SpaceRemoveAclEntry]: {
    request: SpaceRemoveAclEntryRequest;
    response: SpaceAclResponse;
  };
  [RequestType.GetSpaceRootPattern]: {
    request: GetSpaceRootPatternRequest;
    response: PieceResponse;
  };
  [RequestType.RecreateSpaceRootPattern]: {
    request: RecreateSpaceRootPatternRequest;
    response: PieceResponse;
  };
  // Diagnosis requests
  [RequestType.DetectNonIdempotent]: {
    request: DetectNonIdempotentRequest;
    response: DetectNonIdempotentResponse;
  };
  [RequestType.GetPatternSources]: {
    request: GetPatternSourcesRequest;
    response: PatternSourcesResponse;
  };
  [RequestType.SetBreakpoints]: {
    request: SetBreakpointsRequest;
    response: EmptyResponse;
  };
  [RequestType.UploadBlob]: {
    request: UploadBlobRequest;
    response: UploadBlobResponse;
  };
  // VDOM requests
  [RequestType.VDomMount]: {
    request: VDomMountRequest;
    response: VDomMountResponse;
  };
  [RequestType.VDomUnmount]: {
    request: VDomUnmountRequest;
    response: EmptyResponse;
  };
};

/**
 * The request shape a given {@link RequestType} takes, read out of
 * {@link Commands}. `never` for anything that is not a request type, so a
 * mistyped call fails where it is written rather than where it is sent.
 */
export type CommandRequest<T> = T extends keyof Commands
  ? Commands[T]["request"]
  : never;

/**
 * The response shape a given {@link RequestType} yields, read out of
 * {@link Commands}. `never` for anything that is not a request type, as
 * {@link CommandRequest} is.
 */
export type CommandResponse<T> = T extends keyof Commands
  ? Commands[T]["response"]
  : never;
