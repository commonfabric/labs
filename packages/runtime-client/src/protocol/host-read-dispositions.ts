/**
 * What each message the worker sends a host is, with respect to the display
 * ceiling: a host shows what it is sent, so every channel that can carry a
 * cell's contents to the host either has its answers built by the host-read
 * gate, or says here why it does not.
 *
 * The tables are typed as records over every `RequestType` and every
 * `NotificationType`, so a request or a notification added later fails to
 * type-check until it is given a disposition. A disposition of `decided` is
 * held to the answer types as well: the check below the tables fails to
 * type-check unless exactly the requests and notifications marked `decided`
 * have answers that carry the gate's mark, `HostReadDecided`, which only the
 * gate gives an answer.
 */

import {
  type CommandResponse,
  type HostReadDecided,
  type IPCRemoteNotification,
  NotificationType,
  RequestType,
} from "./types.ts";

/**
 * How a channel stands with respect to the display ceiling:
 *
 * - `decided`: its answers are built by the host-read gate, which decides
 *   them under the display ceiling.
 * - `rendered`: what it carries is a render, which the reconciler decides
 *   under the same ceiling.
 * - `no-cell-value`: it carries nothing of a cell's contents.
 * - `reference`: it carries a cell's reference, whose label view comes with
 *   it; that view is a label read, which the gate does not decide.
 * - `trusted-operation`: a worker operation decides what it returns, as the
 *   operation's own rules say.
 * - `ungated`: it returns what it reads, and nothing decides it under the
 *   display ceiling. `why` names what it carries.
 */
export type HostReadDisposition =
  | { readonly kind: "decided" }
  | { readonly kind: "rendered" }
  | { readonly kind: "no-cell-value"; readonly why: string }
  | { readonly kind: "reference"; readonly why: string }
  | { readonly kind: "trusted-operation"; readonly why: string }
  | { readonly kind: "ungated"; readonly why: string };

const DECIDED = { kind: "decided" } as const;
const lifecycle = {
  kind: "no-cell-value",
  why: "lifecycle: the runtime's state, not a cell's",
} as const;
const write = {
  kind: "no-cell-value",
  why: "a write or an event the host sends; the answer carries no value",
} as const;
const setting = {
  kind: "no-cell-value",
  why: "a diagnostic setting or counter",
} as const;
const reference = {
  kind: "reference",
  why: "a cell ref, with the label view a ref carries",
} as const;

/** Every request's disposition. */
export const REQUEST_DISPOSITIONS = {
  [RequestType.Initialize]: lifecycle,
  [RequestType.Attach]: lifecycle,
  [RequestType.Dispose]: lifecycle,
  [RequestType.CellGet]: DECIDED,
  [RequestType.CellPull]: DECIDED,
  [RequestType.CellInitialize]: DECIDED,
  [RequestType.CellSet]: write,
  [RequestType.CellPush]: write,
  [RequestType.CellSend]: write,
  [RequestType.CellSubscribe]: {
    kind: "no-cell-value",
    why: "whether a subscription opened; its values arrive as cell updates",
  },
  [RequestType.CellUnsubscribe]: write,
  [RequestType.CellResolveAsCell]: reference,
  [RequestType.CellGetCfcLabel]: {
    kind: "ungated",
    why: "a cell's display label, whatever the ceiling",
  },
  [RequestType.CellFields]: DECIDED,
  [RequestType.SnapshotSharePrepare]: {
    kind: "trusted-operation",
    why: "the snapshot the owner is asked to confirm sharing",
  },
  [RequestType.SnapshotShareCommit]: reference,
  [RequestType.SnapshotShareCancel]: write,
  [RequestType.CustodySealPrepare]: {
    kind: "trusted-operation",
    why: "the terms and stance a member is asked to confirm sealing",
  },
  [RequestType.CustodySealCommit]: reference,
  [RequestType.CustodySealCancel]: write,
  [RequestType.CustodyAnswerPublish]: {
    kind: "trusted-operation",
    why: "the answer the seal releases",
  },
  [RequestType.CustodyAnswerRead]: {
    kind: "trusted-operation",
    why: "the answer the seal released",
  },
  [RequestType.OperationCapabilities]: {
    kind: "no-cell-value",
    why: "the codecs a cell's operation field offers",
  },
  [RequestType.OperationQuery]: {
    kind: "ungated",
    why: "a collaborative field's operations and materialized value",
  },
  [RequestType.OperationApply]: {
    kind: "ungated",
    why: "a collaborative field's resolution after the host's operation",
  },
  [RequestType.OperationRelease]: write,
  [RequestType.OperationSubscribe]: {
    kind: "ungated",
    why: "a collaborative field's operations and materialized value",
  },
  [RequestType.OperationUnsubscribe]: write,
  [RequestType.OperationSessionClose]: write,
  [RequestType.PresenceJoin]: {
    kind: "ungated",
    why: "the records a presence room's members publish, whose facets are " +
      "whatever each member chose to share, which may be a cell's contents",
  },
  [RequestType.PresencePublish]: write,
  [RequestType.PresenceLeave]: write,
  [RequestType.SqliteQuery]: {
    kind: "ungated",
    why: "the rows a query of a database cell returns",
  },
  [RequestType.SqliteExec]: write,
  [RequestType.GetCell]: reference,
  [RequestType.GetHomeSpaceCell]: reference,
  [RequestType.GetSharedSpaceCatalog]: {
    kind: "trusted-operation",
    why:
      "validated Home catalog snapshot; its source passes the host-read gate before admission",
  },
  [RequestType.RegisterSharedSpace]: {
    kind: "trusted-operation",
    why:
      "Home catalog transaction; its backing value passes the host-read gate before admission",
  },
  [RequestType.ChangeSharedSpaceMembership]: {
    kind: "trusted-operation",
    why:
      "Home catalog transaction; its backing value passes the host-read gate before admission",
  },
  [RequestType.EnsureHomePatternRunning]: lifecycle,
  [RequestType.Idle]: lifecycle,
  [RequestType.ListEventAttention]: {
    kind: "no-cell-value",
    why: "events that need attention, by id and reason",
  },
  [RequestType.ResolveEventAttention]: write,
  [RequestType.RuntimeSynced]: lifecycle,
  [RequestType.CreateSpace]: lifecycle,
  [RequestType.RegisterSpaceHost]: lifecycle,
  [RequestType.RegisterSpaceHostDetailed]: lifecycle,
  [RequestType.RetrySpaceAccess]: lifecycle,
  [RequestType.FlushCompileCacheWrites]: lifecycle,
  [RequestType.GetGraphSnapshot]: {
    kind: "no-cell-value",
    why: "the scheduler's graph of actions and the cells they touch",
  },
  [RequestType.GetLoggerCounts]: setting,
  [RequestType.GetStorageDiagnostics]: {
    kind: "no-cell-value",
    why: "storage state, which exports no cell values",
  },
  [RequestType.GetPatternCoverage]: setting,
  [RequestType.SetLoggerLevel]: setting,
  [RequestType.SetLoggerEnabled]: setting,
  [RequestType.SetTelemetryEnabled]: setting,
  [RequestType.SetReadStatsEnabled]: setting,
  [RequestType.SetMemoryMessageCompression]: setting,
  [RequestType.SetForwardWorkerConsole]: setting,
  [RequestType.ResetLoggerBaselines]: setting,
  [RequestType.GetSettleStats]: setting,
  [RequestType.GetSettleStatsHistory]: setting,
  [RequestType.SetSettleStatsEnabled]: setting,
  [RequestType.GetActionRunTrace]: setting,
  [RequestType.SetActionRunTraceEnabled]: setting,
  [RequestType.GetTriggerTrace]: {
    kind: "ungated",
    why: "a preview of a cell's value before and after each trigger",
  },
  [RequestType.SetTriggerTraceEnabled]: setting,
  [RequestType.GetWriteStackTrace]: {
    kind: "no-cell-value",
    why: "where writes came from, by address and stack",
  },
  [RequestType.SetWriteStackTraceMatchers]: setting,
  [RequestType.DetectNonIdempotent]: {
    kind: "ungated",
    why: "the reads and writes of the runs it compares",
  },
  [RequestType.GetPatternSources]: {
    kind: "no-cell-value",
    why: "the source of the patterns the runtime runs",
  },
  [RequestType.SetBreakpoints]: setting,
  [RequestType.UploadBlob]: write,
  [RequestType.GetSpaceRootPattern]: reference,
  [RequestType.RecreateSpaceRootPattern]: reference,
  [RequestType.PieceCreate]: reference,
  [RequestType.PieceGet]: reference,
  [RequestType.PieceGetSlug]: {
    kind: "ungated",
    why: "a piece's slug, a metadata field",
  },
  [RequestType.SlugResolve]: reference,
  [RequestType.PieceRemove]: write,
  [RequestType.PieceStart]: write,
  [RequestType.PieceStop]: write,
  [RequestType.PieceGetAll]: reference,
  [RequestType.PieceSynced]: lifecycle,
  [RequestType.PieceGetSource]: {
    kind: "ungated",
    why: "a piece's source state, from its metadata fields",
  },
  [RequestType.PieceGetSourceRevision]: {
    kind: "ungated",
    why: "a retained source revision of a piece",
  },
  [RequestType.PieceClone]: reference,
  [RequestType.PieceUpdateSource]: {
    kind: "ungated",
    why: "a piece's source state after a change, from its metadata fields",
  },
  [RequestType.SpaceGetAcl]: {
    kind: "ungated",
    why: "a space's access list",
  },
  [RequestType.SpaceSetAclEntry]: {
    kind: "ungated",
    why: "a space's access list after a change",
  },
  [RequestType.SpaceRemoveAclEntry]: {
    kind: "ungated",
    why: "a space's access list after a change",
  },
  [RequestType.VDomMount]: { kind: "rendered" },
  [RequestType.VDomUnmount]: { kind: "rendered" },
} as const satisfies Record<RequestType, HostReadDisposition>;

/** Every notification's disposition. */
export const NOTIFICATION_DISPOSITIONS = {
  [NotificationType.CellUpdate]: DECIDED,
  [NotificationType.ConsoleMessage]: {
    kind: "ungated",
    why: "the arguments a pattern passes to `console`",
  },
  [NotificationType.NavigateRequest]: reference,
  [NotificationType.ErrorReport]: {
    kind: "ungated",
    why: "a runtime error's message, which can quote a value",
  },
  [NotificationType.SpaceAccessLost]: lifecycle,
  [NotificationType.Telemetry]: {
    kind: "ungated",
    why: "telemetry markers, including a cell update's values",
  },
  [NotificationType.VDomBatch]: { kind: "rendered" },
  [NotificationType.PendingWritesChanged]: lifecycle,
  [NotificationType.OperationUpdate]: {
    kind: "ungated",
    why: "a collaborative field's operations and materialized value",
  },
  [NotificationType.PresenceUpdate]: {
    kind: "ungated",
    why: "the records a presence room's members publish, whose facets are " +
      "whatever each member chose to share, which may be a cell's contents",
  },
  [NotificationType.EventNeedsAttention]: {
    kind: "no-cell-value",
    why: "an event that needs attention, by id and reason",
  },
  [NotificationType.EventIntentOutcome]: {
    kind: "no-cell-value",
    why: "an event's admission outcome, by id",
  },
} as const satisfies Record<NotificationType, HostReadDisposition>;

/** The requests and notifications whose disposition is `decided`. */
type DecidedRequest = {
  [K in RequestType]: (typeof REQUEST_DISPOSITIONS)[K]["kind"] extends "decided"
    ? K
    : never;
}[RequestType];
type DecidedNotification = {
  [K in NotificationType]: (typeof NOTIFICATION_DISPOSITIONS)[K]["kind"] extends
    "decided" ? K : never;
}[NotificationType];

/** The requests and notifications whose answers carry the gate's mark. */
type MarkedRequest = {
  [K in RequestType]: CommandResponse<K> extends HostReadDecided ? K : never;
}[RequestType];
type MarkedNotification = {
  [K in NotificationType]: Extract<IPCRemoteNotification, { type: K }> extends
    HostReadDecided ? K : never;
}[NotificationType];

/** Whether two unions hold the same members. */
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;

/**
 * Fails to type-check unless the dispositions marked `decided` are exactly
 * the channels whose answers only the host-read gate can build.
 */
export const DISPOSITIONS_MATCH_ANSWER_TYPES: {
  readonly requests: Same<DecidedRequest, MarkedRequest>;
  readonly notifications: Same<DecidedNotification, MarkedNotification>;
} = { requests: true, notifications: true };
