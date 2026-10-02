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
  [RequestType.CellGetCfcLabel]: DECIDED,
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
  [RequestType.OperationQuery]: DECIDED,
  [RequestType.OperationApply]: DECIDED,
  [RequestType.OperationRelease]: write,
  [RequestType.OperationSubscribe]: {
    kind: "no-cell-value",
    why: "whether a subscription opened; its operations arrive as updates",
  },
  [RequestType.OperationUnsubscribe]: write,
  [RequestType.OperationSessionClose]: write,
  [RequestType.PresenceJoin]: {
    kind: "no-cell-value",
    why: "the records a presence room's members publish",
  },
  [RequestType.PresencePublish]: write,
  [RequestType.PresenceLeave]: write,
  [RequestType.SqliteQuery]: DECIDED,
  [RequestType.SqliteExec]: write,
  [RequestType.GetCell]: reference,
  [RequestType.GetHomeSpaceCell]: reference,
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
  [RequestType.GetTriggerTrace]: DECIDED,
  [RequestType.SetTriggerTraceEnabled]: setting,
  [RequestType.GetWriteStackTrace]: {
    kind: "no-cell-value",
    why: "where writes came from, by address and stack",
  },
  [RequestType.SetWriteStackTraceMatchers]: setting,
  [RequestType.DetectNonIdempotent]: DECIDED,
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
  [RequestType.PieceGetSlug]: DECIDED,
  [RequestType.SlugResolve]: reference,
  [RequestType.PieceRemove]: write,
  [RequestType.PieceStart]: write,
  [RequestType.PieceStop]: write,
  [RequestType.PieceGetAll]: reference,
  [RequestType.PieceSynced]: lifecycle,
  [RequestType.PieceGetSource]: DECIDED,
  [RequestType.PieceGetSourceRevision]: DECIDED,
  [RequestType.PieceClone]: reference,
  [RequestType.PieceUpdateSource]: DECIDED,
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
  [NotificationType.ConsoleMessage]: DECIDED,
  [NotificationType.NavigateRequest]: reference,
  [NotificationType.ErrorReport]: DECIDED,
  [NotificationType.SpaceAccessLost]: lifecycle,
  [NotificationType.Telemetry]: DECIDED,
  [NotificationType.VDomBatch]: { kind: "rendered" },
  [NotificationType.PendingWritesChanged]: lifecycle,
  [NotificationType.OperationUpdate]: DECIDED,
  [NotificationType.PresenceUpdate]: {
    kind: "no-cell-value",
    why: "the records a presence room's members publish",
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
