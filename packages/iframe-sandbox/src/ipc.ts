// Types used by the `common-iframe-sandbox` IPC.

import type { FabricValue } from "@commonfabric/data-model";
import { isObjectOrArray } from "@commonfabric/utils/types";

// Diagram of the messages between the Host environment, the intermediary outer
// frame, and the guest in the inner frame.
//
// ┌──────────────┐        ┌───────────────┐        ┌───────────────┐
// │     Host     │        │  Outer frame  │        │     Guest     │
// └───────┬──────┘        └───────┬───────┘        └───────┬───────┘
//         │                       │                        │
//         │◄────────READY─────────┤                        │
//         │                       │                        │
//         ├─────LOAD-DOCUMENT────►│                        │
//         │                       ├────────srcdoc─────────►│
//         │◄─────────LOAD─────────┤                        │
//         │                       │                        │
//         ├──────────────────ORDERED──────────────────────►│
//         ├──────────────────PORT (transferred)───────────►│
//         │◄──────FLUSH───────────┤◄───────(unread)────────┤
//         │◄═════════════════════ port ═══════════════════►│
//         │                       │                        │
//         │◄──────ERROR───────────┤◄───────(unread)────────┤
//         │                       │                        │
//         │◄───PORT-REQUEST───────┤◄───────(unread)────────┤
//         ├──────────────────PORT (transferred)───────────►│
//
// The host and the guest hold the two ends of a `MessagePort` and every
// capability request, response, and event crosses on it. The outer frame
// carries the CSP and loads documents; it relays nothing that protocol says.
//
// The one thing it does pass along is whatever the guest posts to it, which it
// forwards without reading. A guest has a port for everything it means to say,
// so a message arriving by that route is about the port itself: an alarm from
// a guest that could not use it, a request from a guest that has none, or the
// flush marker below. It is not a second way to talk.
//
// The port goes out on `LOAD`, and the guest need not have started
// listening by the time its document has loaded: a guest can await anything
// it likes before it connects. A guest that starts listening only after its
// document loaded may therefore have missed the port, and posts a
// `PORT-REQUEST` up the parent chain. A host whose guest has loaded answers
// it as it answers a `LOAD`, with a fresh port; one still loading a document
// ignores it, since the `LOAD` still to come brings the listening guest a
// port.
//
// The relayed route and the port are separate channels, and nothing orders one
// against the other. The `ORDERED`/`FLUSH` exchange is the rendezvous that
// still puts what crossed before the port ahead of what crosses on it: the
// host posts `ORDERED` ahead of the port to say it answers flush markers, and
// a guest that heard it posts a `FLUSH` marker up the parent chain on taking
// the port -- behind everything it posted there before -- and holds its port
// traffic until the marker's acknowledgement comes back over the port. The
// host acknowledges a marker only after handling everything the relay carried
// ahead of it, so by the time any port request lands, every parent post the
// guest made before taking its port has been handled.
//
// A guest that never heard `ORDERED` sends unordered rather than waiting,
// which is what lets a guest and a host of different vintages pair up. What
// answers a marker is the element's live set of sessions, so a guest whose
// marker arrives after the element let go of its session holds its traffic
// from then on. That guest is one the element has already stopped listening
// to, on a port it has already closed.

/**
 * Sent alongside the transferred port, so a guest recognizes the handoff by
 * what the message says rather than by having to treat every arriving message
 * as a candidate.
 */
export const GUEST_PORT_HANDOFF = "common-iframe-sandbox:port";

/**
 * Posted to the guest ahead of `GUEST_PORT_HANDOFF` to say the host answers
 * flush markers. A guest that heard this before its handoff holds its port
 * traffic behind the marker exchange; one that did not sends unordered, so
 * neither side of a mixed pairing waits on an answer that cannot come.
 */
export const GUEST_PORT_ORDERED = "common-iframe-sandbox:ordered";

/** Length in bytes of the random part of a flush marker's nonce. */
const FLUSH_NONCE_BYTES = 8;

/**
 * Returns a nonce for a flush marker. It has to be unique among the markers
 * one host element hears between teardowns, and `crypto.getRandomValues()` is
 * available to a guest whether or not its document is a secure context.
 */
export function flushNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(FLUSH_NONCE_BYTES));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export enum IPCHostMessageType {
  // Host instructing the outer frame to load a new document.
  LoadDocument = "load-document",
}

/** A message from the host to the outer frame. */
export type IPCHostMessage = {
  type: IPCHostMessageType.LoadDocument;
  data: string;
};

export enum IPCGuestMessageType {
  // Outer frame alerting the host that it is ready.
  Ready = "ready",
  // Outer frame's inner document has loaded, so there is a guest to hand a
  // port to.
  Load = "load",
  // An error in the outer frame itself.
  OuterError = "outer-error",
  // An error the guest raised outside its port.
  GuestError = "guest-error",
}

/** A message from the outer frame to the host. */
export type IPCGuestMessage =
  | { type: IPCGuestMessageType.Ready }
  | { type: IPCGuestMessageType.Load }
  | { type: IPCGuestMessageType.OuterError; data: unknown }
  | { type: IPCGuestMessageType.GuestError; data: unknown };

export function isIPCGuestMessage(
  message: unknown,
): message is IPCGuestMessage {
  if (
    !isObjectOrArray(message) || !("type" in message)
  ) {
    return false;
  }
  switch (message.type) {
    case IPCGuestMessageType.Ready:
    case IPCGuestMessageType.Load: {
      return true;
    }
    case IPCGuestMessageType.OuterError:
    case IPCGuestMessageType.GuestError: {
      return "data" in message && message.data != null;
    }
  }
  return false;
}

export type GuestError = {
  description: string;
  source: string;
  lineno: number;
  colno: number;
  stacktrace: string;
};

export function isGuestError(e: object): e is GuestError {
  return isObjectOrArray(e) &&
    "description" in e && typeof e.description === "string" &&
    "source" in e && typeof e.source === "string" &&
    "lineno" in e && typeof e.lineno === "number" &&
    "colno" in e && typeof e.colno === "number" &&
    "stacktrace" in e && typeof e.stacktrace === "string";
}

export const BRIDGE_PROTOCOL = "common-fabric-bridge";

/**
 * Exact encoding revision. An additive operation stays within this revision
 * only when a current guest negotiates it through describe() before sending
 * it, so an older host can reject the unsupported capability without hanging.
 * The flush exchange is negotiated the same way through `GUEST_PORT_ORDERED`:
 * a guest waits on an acknowledgement only from a host that announced it
 * sends one.
 */
export const BRIDGE_VERSION = 2;

export type BridgeError = {
  code: string;
  message: string;
  resource?: string;
};

export type BridgeResourceDescriptor = {
  name: string;
  kind: "cell" | "stream" | "sqlite" | "service";
  operations: string[];
  methods: string[];
  schema?: FabricValue;
  description?: string;
};

export type BridgeManifest = {
  protocol: typeof BRIDGE_PROTOCOL;
  version: typeof BRIDGE_VERSION;
  resources: BridgeResourceDescriptor[];
};

export type BridgeOperation =
  | "describe"
  | "disconnect"
  | "pull"
  | "initialize"
  | "set"
  | "push"
  | "resolve"
  | "call"
  | "sink"
  | "unsink";

/** A path beneath a granted or previously resolved cell capability. */
export type BridgeCellPath = Array<string | number>;

/** Stable identity metadata returned with an opaque resolved capability. */
export type BridgeCellIdentity = {
  /** Stored document ID, shared by every instance of a scoped Cell. */
  id: string;

  /** Opaque identity for this space-, user-, or session-scoped instance. */
  instanceId?: string;

  /** Space holding the Cell. */
  space?: string;

  /** Scope which selects the Cell instance. */
  scope?: "space" | "user" | "session";

  /** Path within the stored document. */
  path: BridgeCellPath;
};

/** Guest-visible descriptor for a host-minted stable cell capability. */
export type BridgeResolvedCell = {
  handle: string;
  hasValue: true;

  /** Operations the host authorizes on this resolved capability. */
  operations?: string[];

  identity?: BridgeCellIdentity;
  value?: FabricValue;
};

export type BridgeRequest = {
  protocol: typeof BRIDGE_PROTOCOL;
  version: typeof BRIDGE_VERSION;
  type: "request";
  id: number;
  operation: BridgeOperation;
  resource?: string;
  handle?: string;
  path?: BridgeCellPath;
  method?: string;
  subscription?: string;
  value?: FabricValue;
  values?: FabricValue[];
};

export type BridgeResponse = {
  protocol: typeof BRIDGE_PROTOCOL;
  version: typeof BRIDGE_VERSION;
  type: "response";
  id: number;
  ok: true;
  value?: FabricValue;
} | {
  protocol: typeof BRIDGE_PROTOCOL;
  version: typeof BRIDGE_VERSION;
  type: "response";
  id: number;
  ok: false;
  error: BridgeError;
};

/**
 * One delivery to a subscription: a value, or the error that stands in its
 * place, such as a refusal of the read (`read-refused`), which the guest
 * hears as an error of its subscription and never as an empty value.
 */
export type BridgeEvent = {
  protocol: typeof BRIDGE_PROTOCOL;
  version: typeof BRIDGE_VERSION;
  type: "event";
  subscription: string;
  value?: FabricValue;
  error?: BridgeError;
};

/**
 * Acknowledges a flush marker, echoing its nonce. Sent over the port once the
 * host has handled everything the parent-chain relay carried ahead of the
 * marker; the guest holding that nonce releases its port traffic on it.
 */
export type BridgeFlushAck = {
  protocol: typeof BRIDGE_PROTOCOL;
  version: typeof BRIDGE_VERSION;
  type: "flush";
  nonce: string;
};

export type BridgeHostMessage = BridgeResponse | BridgeEvent | BridgeFlushAck;

const hasBridgeHeader = (
  message: unknown,
): message is Record<string, unknown> =>
  isObjectOrArray(message) &&
  (message as Record<string, unknown>).protocol === BRIDGE_PROTOCOL &&
  (message as Record<string, unknown>).version === BRIDGE_VERSION;

export function isBridgeRequest(message: unknown): message is BridgeRequest {
  if (!hasBridgeHeader(message)) return false;
  if (
    message.type !== "request" || !Number.isSafeInteger(message.id) ||
    typeof message.operation !== "string"
  ) return false;
  switch (message.operation) {
    case "describe":
    case "disconnect":
      return true;
    case "pull":
    case "set":
    case "resolve":
      return hasCellTarget(message) && hasCellPath(message);
    case "initialize":
      return hasCellTarget(message) && hasCellPath(message) &&
        Object.hasOwn(message, "value") && message.value !== undefined;
    case "push":
      return hasCellTarget(message) && hasCellPath(message) &&
        Array.isArray(message.values);
    case "call":
      return typeof message.resource === "string" &&
        typeof message.method === "string";
    case "sink":
    case "unsink":
      return hasCellTarget(message) &&
        hasCellPath(message) && typeof message.subscription === "string";
    default:
      return false;
  }
}

function hasCellTarget(message: Record<string, unknown>): boolean {
  return (typeof message.resource === "string") !==
    (typeof message.handle === "string");
}

function hasCellPath(message: Record<string, unknown>): boolean {
  return message.path === undefined ||
    Array.isArray(message.path) &&
      message.path.every((part) =>
        typeof part === "string" ||
        typeof part === "number" && Number.isSafeInteger(part)
      );
}

export function isBridgeHostMessage(
  message: unknown,
): message is BridgeHostMessage {
  if (!hasBridgeHeader(message)) return false;
  if (message.type === "event") {
    return typeof message.subscription === "string" &&
      (message.error === undefined || isBridgeError(message.error));
  }
  if (message.type === "flush") {
    return typeof message.nonce === "string";
  }
  if (
    message.type !== "response" || !Number.isSafeInteger(message.id) ||
    typeof message.ok !== "boolean"
  ) return false;
  if (message.ok) return true;
  return isBridgeError(message.error);
}

/** Whether `error` has a bridge error's shape. */
function isBridgeError(error: unknown): error is BridgeError {
  return isObjectOrArray(error) &&
    typeof (error as BridgeError).code === "string" &&
    typeof (error as BridgeError).message === "string" &&
    (!("resource" in error) ||
      typeof (error as BridgeError).resource === "string");
}

export type GuestAlarm = { type: "error"; data: GuestError };

export function isGuestAlarm(message: unknown): message is GuestAlarm {
  return isObjectOrArray(message) &&
    (message as { type?: unknown }).type === "error" &&
    "data" in message && isGuestError(message.data as object);
}

/**
 * Flush marker a guest posts up the parent chain on taking its port, behind
 * everything it posted there before. The nonce is the guest's own token: the
 * acknowledgement echoes it, and only the guest that minted it acts on the
 * echo, so an acknowledgement broadcast wider than one session -- or answering
 * an earlier document's marker -- releases nobody else's traffic.
 */
export type GuestFlush = { type: "flush"; nonce: string };

export function isGuestFlush(message: unknown): message is GuestFlush {
  return isObjectOrArray(message) &&
    (message as { type?: unknown }).type === "flush" &&
    typeof (message as { nonce?: unknown }).nonce === "string";
}

/**
 * Request a guest posts up the parent chain for a port, when it starts
 * listening for one only after its document has finished loading. The host
 * hands a port over on the load report, which the guest may then have
 * missed, so the host answers this with another.
 */
export type GuestPortRequest = { type: "port-request" };

export function isGuestPortRequest(
  message: unknown,
): message is GuestPortRequest {
  return isObjectOrArray(message) && "type" in message &&
    message.type === "port-request";
}
