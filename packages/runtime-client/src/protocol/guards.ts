/**
 * Runtime shape tests for the IPC protocol's message types.
 *
 * Each one answers what its name asks and stops there. They test the fields a
 * receiver dispatches on -- a discriminant, a message id -- and not the payload
 * underneath, so a value passing one of these is routable rather than vetted.
 * Each doc below says where its particular guarantee stops.
 */

import { isDID } from "@commonfabric/identity/did";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  AttachPortNotification,
  CellRef,
  CellUpdateNotification,
  ClientNotificationType,
  ClientTransportNotificationType,
  ConsoleNotification,
  ErrorNotification,
  EventIntentOutcomeNotification,
  EventNeedsAttentionNotification,
  InitializationData,
  IPCClientMessage,
  IPCClientNotification,
  IPCClientRequest,
  IPCRemoteMessage,
  IPCRemoteNotification,
  IPCRemoteResponse,
  NavigateRequestNotification,
  NotificationType,
  OperationUpdateNotification,
  PendingWritesNotification,
  RequestType,
  SpaceAccessLostNotification,
  TelemetryNotification,
  TransportNotificationType,
  VDomBatchNotification,
  WORKER_CONSOLE_LEVELS,
  WorkerConsoleLevel,
  WorkerConsoleNotification,
  WorkerReadyNotification,
} from "./types.ts";

/**
 * Is `value` a {@link CellRef}? Checks that `path` is an array, `id` a
 * non-empty string, and `space` a DID. The path's own entries are not
 * examined, and nothing here says the cell it addresses exists.
 */
export function isCellRef(value: unknown): value is CellRef {
  if (!isObjectNotArray(value)) return false;
  return Array.isArray(value.path) && typeof value.id === "string" &&
    !!value.id &&
    isDID(value.space);
}

/**
 * Is `value` an {@link InitializationData}? The shallowest guard here: it
 * checks `apiUrl` and `spaceDid` are strings and that `identity` is present at
 * all, and looks at nothing else the type declares. What it establishes is
 * that initialization has something to work with, not that the worker will
 * accept it.
 */
export function isInitializationData(
  value: unknown,
): value is InitializationData {
  return (
    isObjectNotArray(value) &&
    typeof value.apiUrl === "string" && !!value.identity &&
    typeof value.spaceDid === "string"
  );
}

/**
 * Is `value` an {@link IPCClientRequest}? Recognized by its `type` naming a
 * {@link RequestType} member, which is what dispatch turns on. The fields that
 * request type goes on to require are the handler's to check.
 */
export function isIPCClientRequest(value: unknown): value is IPCClientRequest {
  return (
    isObjectNotArray(value) &&
    typeof value.type === "string" &&
    Object.values(RequestType).includes(
      value.type as RequestType,
    )
  );
}

/**
 * Is `value` an {@link IPCClientMessage}? The request envelope: a numeric
 * `msgId` wrapping something {@link isIPCClientRequest} accepts. Carries that
 * guard's bound with it -- the request is routable, not vetted.
 */
export function isIPCClientMessage(value: unknown): value is IPCClientMessage {
  return (
    isObjectNotArray(value) &&
    typeof value.msgId === "number" &&
    isIPCClientRequest(value.data)
  );
}

/**
 * Is `value` an {@link IPCClientNotification}? These carry no `msgId` and get
 * no response, so the `type` naming a {@link ClientNotificationType} member is
 * the whole of what distinguishes one.
 */
export function isIPCClientNotification(
  value: unknown,
): value is IPCClientNotification {
  return (
    isObjectNotArray(value) &&
    typeof value.type === "string" &&
    Object.values(ClientNotificationType).includes(
      value.type as ClientNotificationType,
    )
  );
}

/**
 * Is `value` anything the worker sends the connection -- a response or a
 * notification? The transport's own traffic is not included: a ready or
 * worker-console notification is handled before dispatch reaches here.
 */
export function isIPCRemoteMessage(
  value: unknown,
): value is IPCRemoteMessage {
  return isIPCRemoteResponse(value) || isIPCRemoteNotification(value);
}

/**
 * Is `value` an {@link IPCRemoteResponse}? A numeric `msgId` identifies one,
 * and a present `error` must be a string. A bare `{ msgId }` therefore
 * qualifies, that being how the worker acks a request whose handler returned
 * nothing. The `data` a successful response carries is not examined.
 */
export function isIPCRemoteResponse(
  value: unknown,
): value is IPCRemoteResponse {
  return (
    isObjectNotArray(value) &&
    typeof value.msgId === "number" &&
    ("error" in value ? typeof value.error === "string" : true)
  );
}

/**
 * Is `value` an {@link IPCRemoteNotification}? The disjunction of the
 * per-notification guards below admits exactly what one of them admits and
 * adds nothing of its own.
 */
export function isIPCRemoteNotification(
  value: unknown,
): value is IPCRemoteNotification {
  return isTelemetryNotification(value) || isCellUpdateNotification(value) ||
    isConsoleNotification(value) ||
    isNavigateRequestNotification(value) || isErrorNotification(value) ||
    isVDomBatchNotification(value) || isPendingWritesNotification(value) ||
    isOperationUpdateNotification(value) ||
    isEventNeedsAttentionNotification(value) ||
    isSpaceAccessLostNotification(value) ||
    isEventIntentOutcomeNotification(value);
}

/**
 * Is `value` an {@link OperationUpdateNotification}? The field is checked as
 * an object; its operation payload remains the codec consumer's concern.
 */
export function isOperationUpdateNotification(
  value: unknown,
): value is OperationUpdateNotification {
  return isObjectNotArray(value) &&
    value.type === NotificationType.OperationUpdate &&
    typeof value.subscriptionId === "string" &&
    isObjectNotArray(value.field);
}

/**
 * Is `value` a {@link CellUpdateNotification}? Requires `value` to be
 * *present* rather than of any particular shape, since `undefined` is a value
 * a cell can hold and the absent case has to stay distinguishable from it.
 * `cell` is tested with `typeof`, which `null` passes, so a `null` cell gets
 * through here and fails further in.
 */
export function isCellUpdateNotification(
  value: unknown,
): value is CellUpdateNotification {
  return (
    isObjectNotArray(value) &&
    value.type === NotificationType.CellUpdate &&
    typeof value.cell === "object" &&
    "value" in value
  );
}

/**
 * Is `value` a {@link ConsoleNotification}? Checks `method` is a string and
 * `args` an array; what the arguments themselves are is the decoder's
 * question, not this one's.
 */
export function isConsoleNotification(
  value: unknown,
): value is ConsoleNotification {
  return (
    isObjectNotArray(value) &&
    value.type === NotificationType.ConsoleMessage &&
    typeof value.method === "string" &&
    Array.isArray(value.args)
  );
}

/**
 * Is `value` a {@link NavigateRequestNotification}? `targetCellRef` is checked
 * for being an object rather than through {@link isCellRef}, so a malformed
 * target reaches the client and fails there instead.
 */
export function isNavigateRequestNotification(
  value: unknown,
): value is NavigateRequestNotification {
  return (
    isObjectNotArray(value) &&
    value.type === NotificationType.NavigateRequest &&
    isObjectNotArray(value.targetCellRef)
  );
}

/**
 * Is `value` an {@link ErrorNotification}? Only `message` is required; the
 * context fields an error may carry -- its piece, space, pattern, and stack --
 * are all optional and unchecked.
 */
export function isErrorNotification(
  value: unknown,
): value is ErrorNotification {
  return (
    isObjectNotArray(value) &&
    value.type === NotificationType.ErrorReport &&
    typeof value.message === "string"
  );
}

/** Recognizes a payload-free event admission refusal. */
export function isEventIntentOutcomeNotification(
  value: unknown,
): value is EventIntentOutcomeNotification {
  return isObjectNotArray(value) &&
    value.type === NotificationType.EventIntentOutcome && isDID(value.space) &&
    typeof value.eventId === "string" && value.eventId.length > 0 &&
    value.kind === "refused" && value.reason === "admission-refused";
}

/** Recognizes a space-scoped authoritative access-loss notification. */
export function isSpaceAccessLostNotification(
  value: unknown,
): value is SpaceAccessLostNotification {
  return isObjectNotArray(value) &&
    value.type === NotificationType.SpaceAccessLost && isDID(value.space);
}

/**
 * Is `value` a {@link TelemetryNotification}? Which marker it is, is a
 * discrimination the telemetry consumer makes rather than this one. The
 * `marker` is tested with `typeof`, which `null` passes, so a `null` marker
 * gets through here.
 */
export function isTelemetryNotification(
  value: unknown,
): value is TelemetryNotification {
  return (
    isObjectNotArray(value) &&
    value.type === NotificationType.Telemetry &&
    typeof value.marker === "object"
  );
}

/**
 * Is `value` a {@link PendingWritesNotification}? `pending` must be a boolean,
 * which is the whole of what this notification carries.
 */
export function isPendingWritesNotification(
  value: unknown,
): value is PendingWritesNotification {
  return (
    isObjectNotArray(value) &&
    value.type === NotificationType.PendingWritesChanged &&
    typeof value.pending === "boolean"
  );
}

/** Is a complete terminal event-delivery notice from the worker. */
export function isEventNeedsAttentionNotification(
  value: unknown,
): value is EventNeedsAttentionNotification {
  return (
    isObjectNotArray(value) &&
    value.type === NotificationType.EventNeedsAttention &&
    typeof value.space === "string" &&
    typeof value.eventId === "string" &&
    typeof value.seq === "number" &&
    typeof value.sidecarId === "string" &&
    typeof value.reason === "string" &&
    isObjectNotArray(value.attention)
  );
}

/**
 * Is `value` a {@link VDomBatchNotification}? Checks `batchId` is a number and
 * `ops` an array, and looks inside neither `ops` nor `rootId`. A batch passing
 * this can still carry an operation the applicator rejects.
 */
export function isVDomBatchNotification(
  value: unknown,
): value is VDomBatchNotification {
  return (
    isObjectNotArray(value) &&
    value.type === NotificationType.VDomBatch &&
    typeof value.batchId === "number" &&
    Array.isArray(value.ops)
  );
}

/**
 * Is `value` an {@link AttachPortNotification}? What it recognizes is the
 * marker alone -- the port the marker is about travels beside the message, in
 * the transfer list, so nothing here can look at it.
 */
export function isAttachPortNotification(
  value: unknown,
): value is AttachPortNotification {
  return (
    isObjectNotArray(value) &&
    value.type === ClientTransportNotificationType.AttachPort
  );
}

/**
 * Is `value` a {@link WorkerReadyNotification}? This is the post the transport
 * settles `ready()` on, and the only message it treats that way.
 */
export function isWorkerReadyNotification(
  value: unknown,
): value is WorkerReadyNotification {
  return (
    isObjectNotArray(value) &&
    value.type === TransportNotificationType.WorkerReady
  );
}

/**
 * Is `value` a {@link WorkerConsoleNotification}? A `level` outside
 * {@link WORKER_CONSOLE_LEVELS} is not one, which bounds what this recognizes
 * to what the worker's console bridge produces: the bridge posts from that
 * same roster, so nothing it sends is excluded here.
 */
export function isWorkerConsoleNotification(
  value: unknown,
): value is WorkerConsoleNotification {
  return (
    isObjectNotArray(value) &&
    value.type === TransportNotificationType.WorkerConsole &&
    WORKER_CONSOLE_LEVELS.includes(value.level as WorkerConsoleLevel) &&
    typeof value.text === "string"
  );
}
