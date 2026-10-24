/**
 * Private Mode A toolshed endpoints. The authenticated router link carries
 * proof control; single-use ticketed sockets carry one client's Memory data.
 */

// deno-lint-ignore no-external-import -- The diagnostics' event-loop markers use Node's immediate queue.
import { clearImmediate, setImmediate } from "node:timers";
// deno-lint-ignore no-external-import -- The runtime's native gzip compresses outgoing bodies.
import { gzipSync } from "node:zlib";

// @ts-types="@types/ws"
import WebSocket from "ws";

import { sha256 } from "@commonfabric/content-hash";
import {
  type FabricPlainObject,
  type FabricValue,
  isFabricPlainObject,
} from "@commonfabric/data-model";
import { type Identity, isCanonicalEd25519DID } from "@commonfabric/identity";
import { isPlainObject } from "@commonfabric/utils/types";

import {
  encodeMemoryBoundary,
  parseMemoryProtocolFlags,
  type ServerMessage,
} from "../v2.ts";
import type { MemoryCompressionControlMessage } from "./message-compression.ts";
import {
  compressRoutedPayload,
  decodeRoutedFrameAsync,
  parseRoutedJson,
  ROUTED_DEFAULT_SLOT_LIMIT,
  ROUTED_HOLDINGS_LIMIT,
  ROUTED_QUEUE_LIMIT,
  ROUTED_RAW_LIMIT,
  routedDeclaredExpansion,
  routedFlags,
  routedIdentifier,
  routedObject,
} from "./routed-parser.ts";
import {
  equalRoutedBytes,
  readRoutedBase64,
  readRoutedHex,
  readRoutedProof,
  requireRouted,
  routedHex,
  type RoutedProof,
  RoutedReader,
  type RoutedStatement,
  RoutedWriter,
  verifyRoutedProof,
  verifyRoutedRecord,
} from "./routed-wire.ts";
import type { RoutedEpochStore } from "./routed-epochs.ts";
import {
  decodeRouterHeader,
  decodeRouterRecord,
  ROUTER_MAX_REQUEST_ORDINAL,
  ROUTER_PROTOCOL_VERSION,
  ROUTER_REQUEST_WINDOW,
  RouterAssembler,
  routerRoute,
  RouterSender,
  type RouterSenderEvent,
  type RouterSenderSnapshot,
} from "./router-protocol.ts";
import type { Server } from "./server.ts";

type Backend = ReturnType<Server["connectRouted"]>;

/** Payload-free progress of one private control request. */
interface ControlProgress {
  /** Link-local sequence. */
  sequence: number;

  /** Control operation number. */
  opcode: number;

  /** Context identifier, when its control envelope contains one. */
  context?: string;

  /** Receipt time for correlation with remote journals. */
  receivedWallMs: number;

  /** Receipt on the monotonic clock used for durations. */
  receivedAt: number;

  /** Start of the serialized chain entry. */
  startedAt?: number;

  /** Completion of the handler, including a refused operation. */
  handledAt?: number;

  /** Submission of the response to the socket. */
  writeStartedAt?: number;

  /** Successful or failed write callback time. */
  writtenAt?: number;

  /** Whether this operation has stopped retaining diagnostic episode credit. */
  finished?: boolean;

  /** Whether the response write or control envelope failed. */
  failed?: boolean;
}

/** Bounded control timing, independent of control execution and socket cleanup. */
export class RoutedControlDiagnostics {
  #history: ControlProgress[] = [];
  #active = 0;
  #closed = false;
  #turn: ReturnType<typeof setImmediate> | undefined;
  #opportunity:
    | { scheduledAt: number; executedAt?: number; delayMs?: number }
    | undefined;
  #emit: (record: Record<string, unknown>) => void;
  #now: () => number;
  #wall: () => number;

  /** Constructs an instance with clocks and a bounded metadata sink. */
  constructor(
    emit: (record: Record<string, unknown>) => void,
    now = () => performance.now(),
    wall = () => Date.now(),
  ) {
    this.#emit = emit;
    this.#now = now;
    this.#wall = wall;
  }

  /** Pending event-loop marker, for testing actual cancellation. */
  get accessForTestingOnly(): {
    readonly turn: ReturnType<typeof setImmediate> | undefined;
  } {
    return { turn: this.#turn };
  }

  /** Records receipt without retaining the frame or its proof. */
  receive(sequence: number, opcode: number, context?: string): ControlProgress {
    const entry: ControlProgress = {
      sequence,
      opcode,
      ...(context === undefined ? {} : { context }),
      receivedWallMs: this.#wall(),
      receivedAt: this.#now(),
    };
    if (this.#closed) return entry;
    this.#history.push(entry);
    if (this.#history.length > 16) this.#history.shift();
    if (this.#active++ === 0) {
      const opportunity = { scheduledAt: this.#now() };
      this.#opportunity = opportunity;
      this.#turn = setImmediate(() => {
        this.#turn = undefined;
        if (this.#closed) return;
        const executedAt = this.#now();
        this.#opportunity = {
          ...opportunity,
          executedAt,
          delayMs: executedAt - opportunity.scheduledAt,
        };
      });
    }
    return entry;
  }

  /** Records chain entry and reports a slow queue delay. */
  start(entry: ControlProgress | undefined): void {
    if (entry === undefined || this.#closed) return;
    entry.startedAt = this.#now();
    this.#slow(entry, "queue", entry.startedAt - entry.receivedAt);
  }

  /** Records handler completion and reports a slow handler. */
  handled(entry: ControlProgress | undefined): void {
    if (entry === undefined || this.#closed) return;
    entry.handledAt = this.#now();
    this.#slow(
      entry,
      "handle",
      entry.handledAt - (entry.startedAt ?? entry.receivedAt),
    );
  }

  /** Records submission without changing the response's transport ordering. */
  writing(entry: ControlProgress | undefined): void {
    if (entry !== undefined && !this.#closed) {
      entry.writeStartedAt = this.#now();
    }
  }

  /** Records the socket callback or a failed control entry, once. */
  finish(entry: ControlProgress | undefined, failed = false): void {
    if (entry === undefined || entry.finished || this.#closed) return;
    if (entry.writeStartedAt !== undefined) entry.writtenAt = this.#now();
    entry.finished = true;
    entry.failed = failed;
    if (entry.writeStartedAt !== undefined && entry.writtenAt !== undefined) {
      this.#slow(entry, "write", entry.writtenAt - entry.writeStartedAt);
    }
    if (--this.#active === 0 && this.#turn !== undefined) {
      clearImmediate(this.#turn);
      this.#turn = undefined;
    }
  }

  /** Returns a write observer retaining only bounded progress metadata. */
  completion(
    entry: ControlProgress | undefined,
  ): (error?: Error | null) => void {
    return (error) => this.finish(entry, error != null);
  }

  /** Emits the bounded history and cancels its event-loop marker at local close. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#turn !== undefined) clearImmediate(this.#turn);
    this.#turn = undefined;
    this.#report({
      event: "routed-control-progress",
      phase: "close",
      at: this.#now(),
      wallMs: this.#wall(),
      active: this.#active,
      history: this.#history.map((entry) => ({ ...entry })),
    });
    this.#active = 0;
  }

  /** Emits only threshold-crossing phase completions. */
  #slow(entry: ControlProgress, phase: string, elapsedMs: number): void {
    if (elapsedMs > 500) {
      this.#report({
        event: "routed-control-progress",
        phase,
        elapsedMs,
        entry: { ...entry },
        history: this.#history.map((item) => ({ ...item })),
      });
    }
  }

  /** Keeps a failing diagnostic sink from changing control or cleanup behavior. */
  #report(record: Record<string, unknown>): void {
    try {
      this.#emit({
        ...record,
        opportunity: this.#opportunity === undefined
          ? undefined
          : { ...this.#opportunity },
      });
    } catch { /* Diagnostic sinks cannot interrupt cleanup. */ }
  }
}

/** Socket-owned work, independent of the closing handshake's completion. */
type DataSocketLifecycle = {
  /** Releases a dispatch held at the high mark and the incomplete input reservation. */
  cancel(): void;

  /** Input bytes reserved by assembly and queued or active requests. */
  readonly pendingBytes: number;

  /** Reserved bytes belonging to the incomplete logical input body. */
  readonly assemblingBytes: number;

  /** Expanded UTF-8 bytes of the bodies being decoded or in their turns. */
  readonly expandedBytes: number;

  /** Logical output bytes retained by the sender. */
  readonly outputBytes: number;

  /**
   * Whether retained output reached the high mark and has not yet fallen
   * below the low mark, holding reads of new requests and their dispatch.
   */
  readonly outputPaused: boolean;

  /** Completion of all requests queued at the time of the read. */
  readonly settled: Promise<void>;
};

/** Cleanup attached only to this module's routed data sockets; keys are weak. */
const dataSocketLifecycles = new WeakMap<WebSocket, DataSocketLifecycle>();

/** Control markers canceled at local closure, before the transport closes. */
const controlSocketDiagnostics = new WeakMap<
  WebSocket,
  RoutedControlDiagnostics
>();
type Grant = { statement: RoutedStatement; digest: string };
/** One session's quota use: its watch IDs and views, and its holdings. */
type Usage = { principal: string; count: number; holdings: number };
/** Sessions, watches and holdings summed over the sessions of a scope. */
type Totals = { sessions: number; watches: number; holdings: number };
const NO_USAGE: Readonly<Totals> = { sessions: 0, watches: 0, holdings: 0 };

/**
 * The runtime's native gzip at level 1 for outgoing bodies, about nine times
 * faster than the JavaScript default on the thread that serves every socket.
 */
const nativeGzip = (bytes: Uint8Array): Uint8Array =>
  gzipSync(bytes, { level: 1 });

/** Authorized session identity and the quota mirrors its enabled limits need. */
type RoutedSession = {
  /** Space whose backend owns the session. */
  space: string;

  /** Principal whose grant authorized the session. */
  principal: string;

  /** Watch IDs, present only when a watch quota needs them. */
  watches?: Set<string>;

  /** Declared holdings count, present only when a holdings quota needs it. */
  holdings?: number;

  /** View count, present only when a view or aggregate watch quota needs it. */
  views?: number;
};

/** Fixed audit categories; no socket or backend error text is retained. */
type CloseReason =
  | "router-revoked"
  | "ownership-fenced"
  | "host-close"
  | "control-context-close"
  | "proof-denied"
  | "control-link-replaced"
  | "control-peer-close"
  | "control-socket-error"
  | "control-frame-invalid"
  | "control-queue-limit"
  | "control-protocol"
  | "data-peer-close"
  | "data-socket-error"
  | "data-queue-limit"
  | "data-protocol"
  | "duplicate-request"
  | "request-cap"
  | "backend-failure"
  | "output-limit"
  | "socket-send-failure";

/** Output admission operands captured before the failing socket closes. */
type OutputLimit = {
  /** Encoded payload bytes in the attempted send. */
  readonly frameBytes: number;

  /** Larger of socket-buffered and retained logical bytes at admission. */
  readonly bufferedBytes: number;

  /**
   * The bound that refused the send: `ROUTED_RAW_LIMIT` for a message too
   * large to send alone, else `limits.outputBytesPerSocket`, the bound on the
   * larger queue measurement plus the attempted payload bytes.
   */
  readonly limitBytes: number;

  /** Private socket whose output exceeded the bound. */
  readonly endpoint: "data" | "control";

  /**
   * `single-message` when the message exceeds `ROUTED_RAW_LIMIT`, which no
   * socket may send; `queued-output` when it would fit alone but not behind
   * the output the socket already retains.
   */
  readonly classification: "single-message" | "queued-output";

  /** Structured message kind, when the sender has a Memory message. */
  readonly messageType?: ServerMessage["type"] | "memory.compression";

  /** Bounded private data-output history, captured before close clears state. */
  readonly diagnostics?: RoutedOutputSnapshot;
};

/** Bounded envelope identifiers; no application payload or error text. */
type OutputSource = {
  /** Relationship between the outgoing message and the dispatched request. */
  readonly kind: "request" | "push" | "unattributed-response";

  /** Outgoing Memory message kind. */
  readonly messageType: string;

  /** Originating request kind when its identifier matches the active dispatch. */
  readonly requestType?: string;

  /** Envelope identifiers, each truncated to 256 characters. */
  readonly requestId?: string;

  /** Routed space identifier, truncated to 256 characters. */
  readonly space?: string;

  /** Routed session identifier, truncated to 256 characters. */
  readonly sessionId?: string;
};

/** One fixed-size output observation, retained in a sixteen-entry history. */
type OutputSample = {
  /** Monotonic observation time in milliseconds. */
  readonly at: number;

  /** Transition responsible for the observation. */
  readonly event: RouterSenderEvent | "high-water" | "recovered" | "event-loop";

  /** Socket bytes, separate from the sender's logical accounting. */
  readonly socketBytes: number;

  /** Sender counters and ages at the transition. */
  readonly sender: RouterSenderSnapshot;

  /** Source of an enqueue, absent on transport-only transitions. */
  readonly source?: OutputSource;
};

/** Data-output operands and event-loop evidence belonging to one refusal. */
type RoutedOutputSnapshot = {
  /** Socket bytes at refusal, before close mutates its accounting. */
  readonly socketBytes: number;

  /** Logical queue state and lifetime completion counters. */
  readonly sender: RouterSenderSnapshot;

  /** Source of the refused message. */
  readonly attemptedSource: OutputSource;

  /** Current high-water episode's single event-loop opportunity marker. */
  readonly eventLoop: {
    /** Elapsed time since retained output first crossed half the limit. */
    readonly ageMs: number;

    /** Whether the scheduled immediate ran before this snapshot. */
    readonly executed: boolean;

    /** Delay until execution, or null while the immediate is pending. */
    readonly executedAfterMs: number | null;
  } | null;

  /** Most recent sixteen transitions; all entries contain only bounded metadata. */
  readonly history: readonly OutputSample[];

  /** Failure-only canonical sizes of bounded result and sync projections. */
  readonly messageSizes?: OutputSizeBreakdown;
};

/** One size measurement; identifiers and paths contain at most 256 characters. */
type OutputSizeEntry = {
  /** Structured field path, never a document's value. */
  readonly path: string;

  /** Standalone canonical encoding size, including its format prefix. */
  readonly encodedBytes: number;

  /** Document ID when measuring an upsert's document. */
  readonly id?: string;
};

/** Bounded failure-only size attribution, with explicit incomplete-scan markers. */
type OutputSizeBreakdown = {
  /** Whether measurement ran, or was skipped to bound work or preserve failure. */
  readonly status: "measured" | "frame-too-large" | "unavailable";

  /** Up to eight largest measured entries in each category. */
  readonly fields?: readonly OutputSizeEntry[];

  /** Largest measured sync documents, without their values. */
  readonly documents?: readonly OutputSizeEntry[];

  /** Largest measured schema-table entries, without their schemas. */
  readonly schemas?: readonly OutputSizeEntry[];

  /** Number of result fields, upserts and table entries inspected. */
  readonly scannedEntries?: number;

  /** Whether the entry or encoded-byte work budget ended a scan early. */
  readonly truncated?: boolean;
};

/**
 * Measures disjoint result fields and sync contributions only after refusal.
 * Each category retains eight entries. Frames above the raw limit are skipped;
 * at most `min(frameSlots ?? 256, 256)` entries and two raw limits of encoded
 * bytes are processed. A final encode can add at most one frame's worth of work.
 * Standalone encodings include their own format prefix, so these are not additive
 * wire sizes.
 */
function outputSizeBreakdown(
  message: ServerMessage | MemoryCompressionControlMessage,
  frameBytes: number,
  frameSlots: number | null,
): OutputSizeBreakdown {
  if (frameBytes > ROUTED_RAW_LIMIT) return { status: "frame-too-large" };
  try {
    const fields: OutputSizeEntry[] = [];
    const documents: OutputSizeEntry[] = [];
    const schemas: OutputSizeEntry[] = [];
    let scannedEntries = 0;
    let encodedBytes = 0;
    let truncated = false;
    const entryLimit = Math.min(frameSlots ?? 256, 256);

    /** Checks the remaining measurement budget and marks an incomplete scan. */
    const available = (): boolean => {
      const result = scannedEntries < entryLimit &&
        encodedBytes < 2 * ROUTED_RAW_LIMIT;
      if (!result) truncated = true;
      return result;
    };

    /** Retains only the largest eight independent canonical measurements. */
    const measure = (
      entries: OutputSizeEntry[],
      path: string,
      value: FabricValue,
      id?: string,
    ): void => {
      const size = new TextEncoder().encode(encodeMemoryBoundary(value)).length;
      encodedBytes += size;
      entries.push({
        path: path.slice(0, 256),
        encodedBytes: size,
        ...(id === undefined ? {} : { id: id.slice(0, 256) }),
      });
      entries.sort((a, b) => b.encodedBytes - a.encodedBytes);
      if (entries.length > 8) entries.pop();
    };
    const result = message.type === "response"
      ? message.ok
      : message.type === "session/effect"
      ? message.effect
      : undefined;
    const path = message.type === "response" ? "ok" : "effect";
    if (!isFabricPlainObject(result)) {
      if (result !== undefined) {
        scannedEntries++;
        measure(fields, path, result);
      }
      return {
        status: "measured",
        fields,
        documents,
        schemas,
        scannedEntries,
        truncated,
      };
    }
    const record: FabricPlainObject = result;
    for (const key in record) {
      if (!Object.hasOwn(record, key)) continue;
      if (!available()) break;
      scannedEntries++;
      measure(fields, `${path}.${key}`, record[key]);
    }
    const sync = message.type === "session/effect" ? record : record.sync;
    const syncPath = message.type === "session/effect" ? path : `${path}.sync`;
    if (isFabricPlainObject(sync)) {
      if (Array.isArray(sync.upserts)) {
        for (let i = 0; i < sync.upserts.length; i++) {
          if (!available()) break;
          scannedEntries++;
          const upsert = sync.upserts[i];
          if (isFabricPlainObject(upsert) && upsert.doc !== undefined) {
            measure(
              documents,
              `${syncPath}.upserts.${i}.doc`,
              upsert.doc,
              typeof upsert.id === "string" ? upsert.id : undefined,
            );
          }
        }
      }
      if (isFabricPlainObject(sync.schemaTable)) {
        for (const key in sync.schemaTable) {
          if (!Object.hasOwn(sync.schemaTable, key)) continue;
          if (!available()) break;
          scannedEntries++;
          measure(
            schemas,
            `${syncPath}.schemaTable.${key}`,
            sync.schemaTable[key],
          );
        }
      }
    }
    return {
      status: "measured",
      fields,
      documents,
      schemas,
      scannedEntries,
      truncated,
    };
  } catch {
    // Diagnostics must preserve the transport's original refusal even when a
    // structured value cannot be independently encoded.
    return { status: "unavailable" };
  }
}

/** Records queue growth and callbacks without changing transport scheduling. */
class RoutedOutputDiagnostics {
  #sender: RouterSender;
  #socketBytes: () => number;
  #history: OutputSample[] = [];
  #episode: { startedAt: number; executedAt?: number } | undefined;
  #immediate: ReturnType<typeof setImmediate> | undefined;

  /** Constructs an instance observing one private data socket's output. */
  constructor(sender: RouterSender, socketBytes: () => number) {
    this.#sender = sender;
    this.#socketBytes = socketBytes;
  }

  /** Records enqueues and high-water progress, with hysteresis at one quarter. */
  observe(event: RouterSenderEvent, source?: OutputSource): void {
    if (event === "close") {
      this.#cancel();
      return;
    }
    const bytes = this.#sender.bufferedBytes;
    if (this.#episode === undefined && bytes >= ROUTED_QUEUE_LIMIT / 2) {
      const episode = { startedAt: performance.now(), executedAt: undefined };
      this.#episode = episode;
      this.#record("high-water");
      this.#immediate = setImmediate(() => {
        this.#immediate = undefined;
        if (this.#episode !== episode) return;
        this.#episode.executedAt = performance.now();
        this.#record("event-loop");
      });
      this.#immediate.unref();
    }
    if (event === "enqueue" || this.#episode !== undefined) {
      this.#record(event, source);
    }
    if (this.#episode !== undefined && bytes <= ROUTED_QUEUE_LIMIT / 4) {
      this.#record("recovered");
      this.#cancel();
    }
  }

  /** Returns a detached, bounded snapshot before a refusal closes the socket. */
  snapshot(attemptedSource: OutputSource): RoutedOutputSnapshot {
    const episode = this.#episode;
    return {
      socketBytes: this.#socketBytes(),
      sender: this.#sender.snapshot(),
      attemptedSource,
      eventLoop: episode === undefined ? null : {
        ageMs: performance.now() - episode.startedAt,
        executed: episode.executedAt !== undefined,
        executedAfterMs: episode.executedAt === undefined
          ? null
          : episode.executedAt - episode.startedAt,
      },
      history: this.#history.slice(),
    };
  }

  /** Records one immutable observation, evicting the oldest at capacity. */
  #record(event: OutputSample["event"], source?: OutputSource): void {
    if (this.#history.length === 16) this.#history.shift();
    this.#history.push({
      at: performance.now(),
      event,
      socketBytes: this.#socketBytes(),
      sender: this.#sender.snapshot(),
      ...(source === undefined ? {} : { source }),
    });
  }

  /** Cancels the episode's marker on recovery or socket close. */
  #cancel(): void {
    if (this.#immediate !== undefined) clearImmediate(this.#immediate);
    this.#immediate = undefined;
    this.#episode = undefined;
  }
}

/** Projects bounded routing fields from an already decoded envelope. */
function outputSource(
  route: Record<string, unknown>,
  request?: Record<string, unknown>,
): OutputSource {
  const matched = route.type === "response" && request !== undefined &&
    route.requestId === request.requestId;
  const origin = matched ? request : route;
  const fields: { requestId?: string; space?: string; sessionId?: string } = {};
  for (const key of ["requestId", "space", "sessionId"] as const) {
    if (typeof origin[key] === "string") {
      fields[key] = origin[key].slice(0, 256);
    }
  }
  return {
    kind: matched
      ? "request"
      : route.type === "response"
      ? "unattributed-response"
      : "push",
    messageType: typeof route.type === "string" ? route.type.slice(0, 64) : "",
    ...(matched && typeof request.type === "string"
      ? { requestType: request.type.slice(0, 64) }
      : {}),
    ...fields,
  };
}

type Context = {
  id: Uint8Array;
  /** `id` in hex, as the link names it. */
  idHex: string;
  flags: Uint8Array;
  spaces: Map<string, number>;
  /** Usage by session, and by each open in flight; see `#setUsage`. */
  usage: Map<string, Usage>;
  totals: Totals;
  /** Authorized sessions on the active data socket. */
  sessions?: Map<string, RoutedSession>;
  grants: Map<string, Grant>;
  released: Set<string>;
  /**
   * Unexpired statements this context accepted, by principal and challenge.
   * A released principal's are marked, and cannot admit it again.
   */
  accepted: Map<string, Accepted>;
  /** IDs of the unredeemed tickets issued for it. */
  tickets: Set<string>;
  backend?: Backend;
  socket?: WebSocket;
  closed: boolean;
  closeReason?: CloseReason;

  /** Output operands belonging to the first failure on the active socket. */
  outputLimit?: OutputLimit;
};
type Accepted = {
  principal: string;
  digest: string;
  exp: number;
  released: boolean;
};

/**
 * Capacity a toolshed admits from routers, from its Mode A policy config.
 * A context is one client connection's use of this toolshed through one
 * router; "router" counts everything one router link carries, and
 * "toolshed" everything this toolshed admits from every router. Watches and
 * holdings are summed over sessions. Each quota accepts `null` to disable
 * it independently, including the frame's JSON value count.
 */
export interface RoutedHostLimits {
  /** Client contexts on one router link; at least the router's workers. */
  contextsPerLink: number | null;
  /**
   * Private sockets from every router: links, data sockets and handshakes.
   */
  sockets: number | null;
  /** Tickets issued and neither redeemed nor expired, from every router. */
  tickets: number | null;
  /** Principals authenticated in one context at once, as the router's own. */
  principalsPerContext: number | null;
  /**
   * Principals one context remembers. Unreleased principals remain for the
   * context's lifetime; released principals remain until their statements
   * expire. Creating a space proves its key here, so this also bounds the
   * creation keys awaiting release or expiry on one connection.
   */
  principalHistoryPerContext: number | null;
  /**
   * Unexpired client proofs one context holds: at least one for each
   * remembered principal and a renewal for each active one.
   */
  proofsPerContext: number | null;
  /**
   * Requests one context has unanswered on its data socket: at least the
   * router's per-connection requests in flight, which may all go to one
   * toolshed.
   */
  requestsPerContext: number | null;

  /** Distinct spaces authorized over a context's lifetime. */
  spacesPerContext: number | null;

  /** Simultaneous sessions and session-open reservations in one context. */
  sessionsPerContext: number | null;
  sessionsPerRouter: number | null;
  sessionsPerToolshed: number | null;
  sessionsPerPrincipal: number | null;
  watchesPerContext: number | null;
  watchesPerRouter: number | null;
  watchesPerToolshed: number | null;
  watchesPerPrincipal: number | null;
  /**
   * Watch IDs one session may hold; its views are counted separately. A
   * watch mutation that would leave a session with more is refused for
   * good. A client restores a session by sending its whole watch set in one
   * `session.watch.set`, so this is sized together with `frameSlots`: that
   * many watches must fit one frame. Must equal the router's
   * `max_watches_per_session` (a check for the infra preflight, as for
   * `frameSlots`).
   */
  watchesPerSession: number | null;

  /** Views one session may hold, separately from its watch IDs. */
  viewsPerSession: number | null;

  /** Holdings entries one request may declare for its session. */
  holdingsPerSession: number | null;

  holdingsPerContext: number | null;
  holdingsPerRouter: number | null;
  holdingsPerToolshed: number | null;
  holdingsPerPrincipal: number | null;
  /**
   * JSON values in one frame a data socket receives, counted as the router
   * counts them: one per value, keys free. A frame over it closes the
   * socket. Must equal the router's `max_frame_slots` (a check for the infra
   * preflight). The router advertises it as `routerFrameSlots` in `hello.ok`
   * so clients apply the deployment's cap. `null` disables value counting;
   * byte, nesting and unambiguous-JSON checks remain active.
   */
  frameSlots: number | null;
  /**
   * Bytes of output one private socket may hold queued: the larger of its
   * retained logical bodies and its unflushed socket bytes, plus the message
   * being sent. A message sent while nothing is queued is admitted up to
   * `ROUTED_RAW_LIMIT` (8 MiB) regardless, since the router forwards a
   * response of that size and the SDK accepts it; this bound decides what
   * may queue behind other output. Retained output at half this bound pauses
   * reads of new requests and their dispatch, released when retained output
   * falls below a quarter of it, so a slow reader is back-pressured before a
   * response can exceed the bound; a message that would take retained output
   * past the bound is still refused as `queued-output`. `null` disables the
   * queued-output bound and leaves the 8 MiB ceiling in its place for the
   * marks; the ceiling on one message always holds. At most `ROUTED_RAW_LIMIT`.
   */
  outputBytesPerSocket: number | null;
}

/** Numeric defaults for every quota and structural frame bound. */
type RoutedHostDefaults = Readonly<Record<keyof RoutedHostLimits, number>>;

/**
 * Sized for the proof of concept and a second router. Per-context limits
 * equal the router's per-connection ones, so a toolshed never refuses what
 * its router admitted to one connection. The router README's capacity
 * section has the load model, which inputs are measured and which assumed,
 * and how to size for other loads and router counts.
 */
export const DEFAULT_ROUTED_HOST_LIMITS: RoutedHostDefaults = {
  contextsPerLink: 512,
  sockets: 2048,
  tickets: 2048,
  principalsPerContext: 16,
  principalHistoryPerContext: 128,
  proofsPerContext: 160,
  requestsPerContext: 1024,
  spacesPerContext: 1200,
  sessionsPerContext: 1200,
  sessionsPerRouter: 8192,
  sessionsPerToolshed: 16384,
  sessionsPerPrincipal: 2400,
  watchesPerContext: 40960,
  watchesPerRouter: 262144,
  watchesPerToolshed: 524288,
  watchesPerPrincipal: 81920,
  // Size this count against the workload's complete restore frame, including
  // selectors, views and holdings; watch count alone does not bound its size.
  watchesPerSession: 2048,
  viewsPerSession: 64,
  holdingsPerSession: ROUTED_HOLDINGS_LIMIT,
  holdingsPerContext: 327680,
  holdingsPerRouter: 2097152,
  holdingsPerToolshed: 4194304,
  holdingsPerPrincipal: 655360,
  frameSlots: ROUTED_DEFAULT_SLOT_LIMIT,
  outputBytesPerSocket: ROUTED_QUEUE_LIMIT,
};

/**
 * Applies partial overrides to the defaults. Quotas accept `null` to disable
 * enforcement; enabled values must be positive safe integers. Enabled
 * per-context, per-router and per-toolshed limits nest, one session's
 * watch IDs fit its context's, a context's proofs cover its principal
 * history and a renewal for each active principal, and a link's contexts
 * can each hold a ticket. {@link routedHostLimitsFor}
 * checks the limits that depend on how many routers a toolshed admits.
 *
 * Comparisons involving a disabled quota are skipped, allowing an enabled
 * aggregate to bound a scope whose own quota is disabled.
 *
 * @throws If overrides are malformed or enabled limits are out of order.
 */
export function routedHostLimits(
  overrides: unknown = {},
): RoutedHostLimits {
  if (!isPlainObject(overrides)) throw new Error("invalid routed limits");
  const limits: RoutedHostLimits = { ...DEFAULT_ROUTED_HOST_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!isLimitKey(key)) requireLimit(false, key);
    else if (value === null) limits[key] = null;
    else if (
      typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ) limits[key] = value;
    else requireLimit(false, key);
  }
  for (const kind of ["sessions", "watches", "holdings"] as const) {
    const context = limits[`${kind}PerContext`],
      router = limits[`${kind}PerRouter`],
      toolshed = limits[`${kind}PerToolshed`],
      principal = limits[`${kind}PerPrincipal`];
    requireLimit(nestedLimit(context, router), `${kind}PerContext`);
    requireLimit(nestedLimit(router, toolshed), `${kind}PerRouter`);
    requireLimit(nestedLimit(principal, toolshed), `${kind}PerPrincipal`);
  }
  requireLimit(
    nestedLimit(limits.watchesPerSession, limits.watchesPerContext),
    "watchesPerSession",
  );
  requireLimit(
    nestedLimit(limits.principalsPerContext, limits.principalHistoryPerContext),
    "principalsPerContext",
  );
  requireLimit(
    limits.principalHistoryPerContext === null ||
      limits.principalsPerContext === null ||
      nestedLimit(
        limits.principalHistoryPerContext + limits.principalsPerContext,
        limits.proofsPerContext,
      ),
    "proofsPerContext",
  );
  requireLimit(nestedLimit(limits.contextsPerLink, limits.tickets), "tickets");
  requireLimit(
    nestedLimit(limits.outputBytesPerSocket, ROUTED_RAW_LIMIT),
    "outputBytesPerSocket",
  );
  return limits;
}

/**
 * {@link routedHostLimits} for a toolshed that admits `routers` routers:
 * every router's contexts at once fit the sockets, with each link's own, and
 * the tickets.
 *
 * @throws As {@link routedHostLimits}, or if the limits do not fit `routers`.
 */
export function routedHostLimitsFor(
  overrides: unknown,
  routers: number,
): RoutedHostLimits {
  const limits = routedHostLimits(overrides);
  requireLimit(Number.isSafeInteger(routers) && routers > 0, "routers");
  requireLimit(
    limits.contextsPerLink === null ||
      nestedLimit(routers * (limits.contextsPerLink + 1), limits.sockets),
    "sockets",
  );
  requireLimit(
    limits.contextsPerLink === null ||
      nestedLimit(routers * limits.contextsPerLink, limits.tickets),
    "tickets",
  );
  return limits;
}

/** Whether `key` names a supported limit. */
function isLimitKey(key: string): key is keyof RoutedHostLimits {
  return Object.hasOwn(DEFAULT_ROUTED_HOST_LIMITS, key);
}

/** Whether two enabled limits are in scope order. */
function nestedLimit(inner: number | null, outer: number | null): boolean {
  return inner === null || outer === null || inner <= outer;
}

/** Whether usage exceeds an enabled quota. */
function exceedsLimit(usage: number, limit: number | null): boolean {
  return limit !== null && usage > limit;
}

/** Throws a configuration error naming the limit that failed. */
function requireLimit(ok: boolean, field: string): void {
  if (!ok) throw new Error(`invalid routed limit: ${field}`);
}

/** Why the toolshed answered one request with a denial. */
type RefusalReason =
  | "session-limit"
  | "watch-limit"
  | "holdings-limit"
  | "frame-limit"
  | "session-not-held"
  | "principal-expired"
  | "principal-not-held";
/** Refusals that pass on their own, so the client holds the session. */
const RETRIABLE_REFUSALS: ReadonlySet<RefusalReason> = new Set([
  "session-limit",
  "watch-limit",
  "holdings-limit",
  "principal-expired",
]);

/**
 * A request refused on its own: answered, not a closed socket. A capacity
 * refusal, or one for a grant that expired in flight, is marked retriable;
 * one past a bound on what one session holds (`frame-limit`), or for a
 * session or principal the context no longer holds, is final.
 */
class RoutedRequestRefusal extends Error {
  constructor(readonly reason: RefusalReason) {
    super(`Routed memory ${reason}`);
  }
  get retriable(): boolean {
    return RETRIABLE_REFUSALS.has(this.reason);
  }
}

/** Why the toolshed refused a proof, which closes its context. */
type ProofRefusalReason =
  | "proof-limit"
  | "principal-limit"
  | "principal-history-limit";
class RoutedProofRefusal extends Error {
  constructor(readonly reason: ProofRefusalReason) {
    super(`Routed memory ${reason}`);
  }
}

type Link = {
  router: string;
  epoch: Uint8Array;
  /** `epoch` in hex, as the ledger names it. */
  epochHex: string;
  peer: string;
  socket: WebSocket;
  contexts: Map<string, Context>;
  /**
   * The live context holding each accepted statement, keyed as `accepted`
   * is: a statement serves one live context at a time. A context's entries
   * leave with it, and none outlive the link or a restart.
   */
  claims: Map<string, Context>;
  sequence: number;
  /** Payload-free control timing, canceled when the link starts closing. */
  progress: RoutedControlDiagnostics;
  closed: boolean;
  closeReason?: CloseReason;

  /** Output operands belonging to the first failure on the control socket. */
  outputLimit?: OutputLimit;
};
type Ticket = {
  id: string;
  context: Context;
  link: Link;
  expires: number;
};

/** Private listener policy, independent of toolshed HTTP or service grants. */
export interface RoutedHostOptions {
  server: Server;
  identity: Identity;
  deployment: string;
  /** Exact router identities and their network source addresses. */
  routers: ReadonlyMap<string, ReadonlySet<string>>;
  /** Synchronous authoritative ownership epoch, absent for unowned spaces. */
  ownership: (space: string) => number | undefined;
  /** Unix seconds; tests can drive the same verifier deterministically. */
  now?: () => number;
  /** Durable link epochs and router revocations, kept across restart. */
  epochs: RoutedEpochStore;
  /** Capacity, over {@link DEFAULT_ROUTED_HOST_LIMITS}. */
  limits?: Partial<RoutedHostLimits>;
}

/** Toolshed authority for authenticated router links and their Mode A tickets. */
export class RoutedMemoryHost {
  #options: RoutedHostOptions;
  #limits: RoutedHostLimits;
  /** Aggregate families with at least one enabled scope. */
  #countedKinds: (keyof Totals)[];
  #trackWatchIds: boolean;
  #trackViews: boolean;
  #trackHoldings: boolean;
  #links = new Map<string, Link>();
  /**
   * Tickets issued and not yet redeemed, oldest first; each expires 15 s
   * after issue. A ticket is removed when a data socket redeems it, when
   * its context closes, and by `#pruneTickets` once it has expired, so a
   * lookup still checks `expires`.
   */
  #tickets = new Map<string, Ticket>();
  #sockets = new Set<WebSocket>();

  #closed = false;
  #revoked = new Set<string>();
  /** Session usage per router, per principal and in all; see `#setUsage`. */
  #routerTotals = new Map<string, Totals>();
  #principalTotals = new Map<string, Totals>();
  #toolshedTotals: Totals = { ...NO_USAGE };

  /**
   * Requires enforced ACLs, explicit ACL documents (a space with no history
   * admits only its own DID, to write its genesis) and an engine-turn fence.
   */
  constructor(options: RoutedHostOptions) {
    requireRouted(
      options.server.options.acl?.mode === "enforce" &&
        options.server.options.ownsSpace !== undefined &&
        options.server.options.requireExplicitAcl === true,
    );
    requireRouted(
      options.deployment.length > 0 && options.deployment.length <= 256 &&
        options.routers.size <= 16,
    );
    for (const [router, peers] of options.routers) {
      requireRouted(
        isCanonicalEd25519DID(router) && peers.size > 0 && peers.size <= 4,
      );
      requireRouted(
        !options.server.options.acl?.serviceDids?.includes(router) &&
          !options.server.options.acl?.delegatingDids?.includes(router),
      );
    }
    this.#limits = routedHostLimitsFor(
      options.limits === undefined ? {} : options.limits,
      options.routers.size,
    );
    this.#countedKinds = (["sessions", "watches", "holdings"] as const)
      .filter((kind) =>
        (["Context", "Router", "Toolshed", "Principal"] as const).some(
          (scope) => this.#limits[`${kind}Per${scope}`] !== null,
        )
      );
    const countWatches = this.#countedKinds.includes("watches");
    this.#trackWatchIds = countWatches ||
      this.#limits.watchesPerSession !== null;
    this.#trackViews = countWatches || this.#limits.viewsPerSession !== null;
    this.#trackHoldings = this.#countedKinds.includes("holdings") ||
      this.#limits.holdingsPerSession !== null;
    this.#options = options;
  }

  /** Quota accounting and socket-owned work for checking cleanup and output holds. */
  get accessForTestingOnly(): {
    readonly routerTotals: ReadonlyMap<string, Totals>;
    readonly principalTotals: ReadonlyMap<string, Totals>;
    readonly toolshedTotals: Readonly<Totals>;
    readonly usageEntries: number;
    readonly watchMirrors: number;
    readonly mirroredWatchIds: number;
    readonly viewMirrors: number;
    readonly holdingMirrors: number;

    /** Live work owned by one of this host's admitted data sockets. */
    dataSocket(
      socket: WebSocket,
    ): Omit<DataSocketLifecycle, "cancel"> | undefined;
  } {
    let watchMirrors = 0,
      mirroredWatchIds = 0,
      viewMirrors = 0,
      holdingMirrors = 0;
    for (const link of this.#links.values()) {
      for (const context of link.contexts.values()) {
        for (const session of context.sessions?.values() ?? []) {
          if (session.watches !== undefined) {
            watchMirrors++;
            mirroredWatchIds += session.watches.size;
          }
          if (session.views !== undefined) viewMirrors++;
          if (session.holdings !== undefined) holdingMirrors++;
        }
      }
    }
    return {
      dataSocket: (socket) =>
        this.#sockets.has(socket)
          ? dataSocketLifecycles.get(socket)
          : undefined,
      routerTotals: this.#routerTotals,
      principalTotals: this.#principalTotals,
      toolshedTotals: this.#toolshedTotals,
      watchMirrors,
      mirroredWatchIds,
      viewMirrors,
      holdingMirrors,
      usageEntries: [...this.#links.values()].reduce(
        (count, link) =>
          count + [...link.contexts.values()].reduce(
            (count, context) => count + context.usage.size,
            0,
          ),
        0,
      ),
    };
  }

  /** Ends one router's links, tickets, contexts and sessions. */
  revokeRouter(router: string): void {
    this.#revoked.add(router);
    const link = this.#links.get(router);
    if (link !== undefined) this.#closeLink(link, "router-revoked");
    try {
      this.#options.epochs.revoke(router);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Revokes contexts whose ownership has been withdrawn or advanced. */
  fenceOwnership(): void {
    for (const link of this.#links.values()) {
      for (const context of [...link.contexts.values()]) {
        if (
          [...context.spaces].some(([space, epoch]) =>
            this.#options.ownership(space) !== epoch
          )
        ) this.#closeContext(link, context, "ownership-fenced");
      }
    }
  }

  /** Closes the private host and every socket it admitted or is negotiating. */
  close(): void {
    this.#closed = true;
    for (const link of [...this.#links.values()]) {
      this.#closeLink(link, "host-close");
    }
    for (const socket of this.#sockets) safeClose(socket);
    this.#sockets.clear();
  }

  /** Whether a network peer may enter the bounded private handshake. */
  acceptsPeer(peer: string): boolean {
    return !this.#closed &&
      !exceedsLimit(this.#sockets.size + 1, this.#limits.sockets) &&
      [...this.#options.routers].some(([router, peers]) =>
        !this.#revoked.has(router) && !this.#options.epochs.revoked(router) &&
        peers.has(peer)
      );
  }

  /** Admits a socket framed by the private listener, never Deno's fragment collector. */
  accept(socket: WebSocket, endpoint: string, peer: string): void {
    if (
      !this.acceptsPeer(peer) ||
      !["/memory/router-link", "/memory/router-data"].includes(endpoint)
    ) {
      safeClose(socket);
      return;
    }
    socket.binaryType = "arraybuffer";
    this.#sockets.add(socket);
    socket.addEventListener("close", () => this.#sockets.delete(socket), {
      once: true,
    });
    if (endpoint === "/memory/router-link") this.#attachLink(socket, peer);
    else this.#attachData(socket, peer);
  }

  #audit(
    link: Link,
    context: Context,
    verdict: string,
    space?: string,
    reason?: string,
    outputLimit?: OutputLimit,
  ): void {
    console.info(
      JSON.stringify({
        event: "routed-memory-verdict",
        router: link.router,
        context: context.idHex,
        toolshed: this.#options.identity.did(),
        space,
        verdict,
        reason,
        outputLimit,
      }),
    );
  }

  #now(): number {
    return this.#options.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /**
   * Drops tickets that expired unredeemed. A closed context's tickets leave
   * with it, and a closed link closes its contexts.
   */
  #pruneTickets(): void {
    const now = this.#now();
    for (const [id, ticket] of this.#tickets) {
      if (ticket.expires > now) break;
      this.#tickets.delete(id);
      ticket.context.tickets.delete(id);
    }
  }

  /** Closes one context and drops the statements it accepted. */
  #closeContext(
    link: Link,
    context: Context,
    reason: CloseReason,
    outputLimit?: OutputLimit,
  ): void {
    if (context.closed) return;
    context.closed = true;
    this.#audit(
      link,
      context,
      "context-closed",
      undefined,
      context.closeReason ?? reason,
      context.closeReason === undefined ? outputLimit : context.outputLimit,
    );
    context.backend?.close();
    context.sessions?.clear();
    if (context.socket !== undefined) safeClose(context.socket);
    this.#clearUsage(link, context);
    context.grants.clear();
    for (const key of context.accepted.keys()) link.claims.delete(key);
    context.accepted.clear();
    link.contexts.delete(context.idHex);
    for (const id of context.tickets) this.#tickets.delete(id);
    context.tickets.clear();
  }

  #closeLink(link: Link, reason: CloseReason): void {
    if (link.closed) return;
    link.closed = true;
    link.progress.close();
    for (const context of [...link.contexts.values()]) {
      this.#closeContext(
        link,
        context,
        link.closeReason ?? reason,
        link.outputLimit,
      );
    }
    try {
      this.#options.epochs.retire(
        link.router,
        link.epochHex,
        this.#now(),
      );
    } catch {
      // The ledger latches unhealthy, so later admissions fail closed.
    }
    safeClose(link.socket);
    if (this.#links.get(link.router) === link) this.#links.delete(link.router);
  }

  #attachLink(socket: WebSocket, peer: string): void {
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const issued = this.#now();
    let link: Link | undefined;
    // Cleanup callbacks can follow a local failure on the same socket.
    let closeReason: CloseReason | undefined;
    let outputLimit: OutputLimit | undefined;
    const rememberClose = (reason: CloseReason, output?: OutputLimit): void => {
      if (closeReason === undefined) {
        closeReason = reason;
        outputLimit = output;
      }
      if (link !== undefined && link.closeReason === undefined) {
        link.closeReason = closeReason;
        link.outputLimit = outputLimit;
      }
    };
    let pendingBytes = 0;
    let pending = 0;
    let chain = Promise.resolve();
    const progress = new RoutedControlDiagnostics((record) => {
      console.info(
        JSON.stringify({
          ...record,
          router: link?.router,
          epoch: link?.epochHex,
          toolshed: this.#options.identity.did(),
        }),
      );
    });
    controlSocketDiagnostics.set(socket, progress);
    const deadline = setTimeout(() => safeClose(socket), 5000);
    queueMicrotask(() => {
      void new RoutedWriter("rph1").text(this.#options.identity.did()).fixed(
        nonce,
      ).time(issued)
        .blob(
          routedFlags({
            ...this.#options.server.memoryProtocolFlags(),
            connectionAuth: true,
            routedAuthV1: true,
            routedCompressionV1: true,
            routerEncodingNegotiation: true,
            routerRequestCredit: true,
          }, false),
        )
        .sign(this.#options.identity).then((bytes) =>
          sendBounded(
            socket,
            bytes,
            this.#limits.outputBytesPerSocket,
            rememberClose,
            "control",
          )
        ).catch(() => safeClose(socket));
    });
    socket.addEventListener("close", () => {
      clearTimeout(deadline);
      progress.close();
      controlSocketDiagnostics.delete(socket);
      if (link !== undefined) {
        this.#closeLink(link, closeReason ?? "control-peer-close");
      }
    }, { once: true });
    socket.addEventListener("error", () => {
      rememberClose("control-socket-error");
    }, { once: true });
    socket.addEventListener("message", (event: { data: unknown }) => {
      if (
        !(event.data instanceof ArrayBuffer) || event.data.byteLength > 4096 ||
        ++pending > 32 || (pendingBytes += event.data.byteLength) > 128 * 1024
      ) {
        rememberClose(
          !(event.data instanceof ArrayBuffer) || event.data.byteLength > 4096
            ? "control-frame-invalid"
            : "control-queue-limit",
        );
        safeClose(socket);
        return;
      }
      const bytes = new Uint8Array(event.data);
      let entry: ControlProgress | undefined;
      // Parse only the bounded control envelope; malformed input is still
      // rejected by the serialized handler, not by the diagnostic path.
      try {
        const envelope = new RoutedReader(bytes, "mlq1");
        const sequence = envelope.time();
        const opcode = envelope.fixed(1)[0];
        const payload = envelope.blob();
        let context: string | undefined;
        if (opcode === 3 && payload.length === 16) context = routedHex(payload);
        else if (opcode === 2) {
          context = this.#tickets.get(
            routedHex(new RoutedReader(payload, "map1").fixed(32)),
          )?.context.idHex;
        } else {
          const domains: Record<number, string> = {
            1: "mat1",
            4: "mrl1",
            5: "mas1",
            6: "mvp1",
          };
          const domain = domains[opcode];
          if (domain !== undefined) {
            context = routedHex(new RoutedReader(payload, domain).fixed(16));
          }
        }
        entry = progress.receive(sequence, opcode, context);
      } catch { /* Timing extraction carries no authority. */ }
      chain = chain.then(async () => {
        progress.start(entry);
        requireRouted(socket.readyState === WebSocket.OPEN && !this.#closed);
        if (link === undefined) {
          const r = new RoutedReader(bytes.slice(0, -64), "rpc1");
          requireRouted(r.text() === this.#options.deployment);
          const router = r.text();
          requireRouted(
            !this.#revoked.has(router) &&
              this.#options.routers.get(router)?.has(peer),
          );
          requireRouted(r.text() === this.#options.identity.did());
          const epoch = r.fixed(16);
          requireRouted(
            equalRoutedBytes(r.fixed(32), nonce) && this.#now() < issued + 60,
          );
          requireRouted(r.fixed(1)[0] === 1);
          r.end();
          await verifyRoutedRecord(bytes, router);
          requireRouted(
            socket.readyState === WebSocket.OPEN &&
              !this.#revoked.has(router) &&
              this.#options.routers.get(router)?.has(peer),
          );
          requireRouted(!this.#options.epochs.revoked(router));
          this.#options.epochs.consume(router, routedHex(epoch));
          const prior = this.#links.get(router);
          if (prior !== undefined) {
            this.#closeLink(prior, "control-link-replaced");
          }
          link = {
            router,
            epoch,
            epochHex: routedHex(epoch),
            peer,
            socket,
            contexts: new Map(),
            claims: new Map(),
            sequence: 0,
            progress,
            closed: false,
          };
          this.#links.set(router, link);
          clearTimeout(deadline);
          sendBounded(
            socket,
            new TextEncoder().encode("rpo1"),
            this.#limits.outputBytesPerSocket,
            rememberClose,
            "control",
          );
        } else {
          const r = new RoutedReader(bytes, "mlq1");
          const sequence = r.time();
          requireRouted(sequence === link.sequence + 1 && !link.closed);
          link.sequence = sequence;
          const op = r.fixed(1)[0];
          const payload = r.blob();
          r.end();
          let result: Uint8Array;
          let status = 0;
          try {
            result = await this.#control(link, op, payload);
          } catch {
            status = 1;
            result = new Uint8Array();
          }
          progress.handled(entry);
          requireRouted(!link.closed);
          progress.writing(entry);
          sendBounded(
            socket,
            new RoutedWriter("mls1").time(sequence).fixed(
              new Uint8Array([status]),
            ).blob(result).bytes,
            this.#limits.outputBytesPerSocket,
            rememberClose,
            "control",
            undefined,
            progress.completion(entry),
          );
        }
      }).catch(() => {
        progress.finish(entry, true);
        rememberClose("control-protocol");
        if (link !== undefined) this.#closeLink(link, closeReason!);
        else safeClose(socket);
      }).finally(() => {
        pending--;
        pendingBytes -= bytes.length;
      });
    });
  }

  async #control(
    link: Link,
    op: number,
    payload: Uint8Array,
  ): Promise<Uint8Array> {
    this.#pruneTickets();
    requireRouted(
      !link.closed && !this.#revoked.has(link.router) &&
        this.#options.routers.get(link.router)?.has(link.peer),
    );
    if (op === 3) {
      requireRouted(payload.length === 16);
      const context = link.contexts.get(routedHex(payload));
      if (context !== undefined) {
        this.#closeContext(link, context, "control-context-close");
      }
      return new Uint8Array();
    }
    if (op === 1) {
      const r = new RoutedReader(payload, "mat1");
      const id = r.fixed(16);
      const flags = r.blob();
      const parsed = parseRoutedJson(
        new TextDecoder("utf-8", { fatal: true }).decode(flags),
        ROUTED_DEFAULT_SLOT_LIMIT,
      );
      requireRouted(equalRoutedBytes(routedFlags(parsed), flags));
      const space = r.text();
      const epoch = r.time();
      r.end();
      requireRouted(
        isCanonicalEd25519DID(space) && epoch > 0 &&
          this.#options.ownership(space) === epoch,
      );
      let context = link.contexts.get(routedHex(id));
      if (context === undefined) {
        requireRouted(
          !exceedsLimit(link.contexts.size + 1, this.#limits.contextsPerLink),
        );
        context = {
          id,
          idHex: routedHex(id),
          flags,
          spaces: new Map(),
          usage: new Map(),
          totals: { ...NO_USAGE },
          grants: new Map(),
          released: new Set(),
          accepted: new Map(),
          tickets: new Set(),
          closed: false,
        };
        link.contexts.set(routedHex(id), context);
      }
      requireRouted(
        !context.closed && equalRoutedBytes(context.flags, flags) &&
          (context.spaces.has(space) ||
            !exceedsLimit(
              context.spaces.size + 1,
              this.#limits.spacesPerContext,
            )),
      );
      requireRouted(
        !context.spaces.has(space) || context.spaces.get(space) === epoch,
      );
      context.spaces.set(space, epoch);
      requireRouted(
        !exceedsLimit(this.#tickets.size + 1, this.#limits.tickets),
      );
      const ticketBytes = crypto.getRandomValues(new Uint8Array(32));
      const ticketId = routedHex(ticketBytes);
      this.#tickets.set(ticketId, {
        id: ticketId,
        context,
        link,
        expires: this.#now() + 15,
      });
      context.tickets.add(ticketId);
      return ticketBytes;
    }
    if (op === 6) {
      const r = new RoutedReader(payload, "mvp1");
      const id = r.fixed(16);
      const flags = r.blob();
      requireRouted(
        equalRoutedBytes(
          routedFlags(
            parseRoutedJson(
              new TextDecoder("utf-8", { fatal: true }).decode(flags),
              ROUTED_DEFAULT_SLOT_LIMIT,
            ),
          ),
          flags,
        ),
      );
      const proof = readRoutedProof(r.blob());
      r.end();
      let context = link.contexts.get(routedHex(id));
      if (context === undefined) {
        requireRouted(
          !exceedsLimit(link.contexts.size + 1, this.#limits.contextsPerLink),
        );
        context = {
          id,
          idHex: routedHex(id),
          flags,
          spaces: new Map(),
          usage: new Map(),
          totals: { ...NO_USAGE },
          grants: new Map(),
          released: new Set(),
          accepted: new Map(),
          tickets: new Set(),
          closed: false,
        };
        link.contexts.set(routedHex(id), context);
      }
      requireRouted(equalRoutedBytes(context.flags, flags));
      await this.#admitProof(link, context, proof);
      return new Uint8Array();
    }
    if (op === 2) {
      const r = new RoutedReader(payload, "map1");
      const ticket = this.#tickets.get(routedHex(r.fixed(32)));
      const proof = readRoutedProof(r.blob());
      r.end();
      // A redeemed ticket is no longer in `#tickets`, so it admits no proof.
      requireRouted(
        ticket !== undefined && ticket.link === link &&
          !ticket.context.closed && ticket.expires > this.#now(),
      );
      const context = ticket.context;
      await this.#admitProof(link, context, proof);
      return new Uint8Array();
    }
    const r = new RoutedReader(payload, op === 4 ? "mrl1" : "mas1");
    const context = link.contexts.get(routedHex(r.fixed(16)));
    requireRouted(context !== undefined && !context.closed);
    if (op === 4) {
      const principal = r.text();
      r.end();
      requireRouted(isCanonicalEd25519DID(principal));
      if (!context.grants.has(principal) || context.released.has(principal)) {
        return new Uint8Array();
      }
      for (const accepted of context.accepted.values()) {
        if (accepted.principal === principal) accepted.released = true;
      }
      context.released.add(principal);
      context.backend?.releasePrincipal(principal);
    } else {
      requireRouted(op === 5);
      const space = r.text();
      const epoch = r.time();
      r.end();
      requireRouted(
        isCanonicalEd25519DID(space) && epoch > 0 &&
          this.#options.ownership(space) === epoch &&
          (context.spaces.has(space) ||
            !exceedsLimit(
              context.spaces.size + 1,
              this.#limits.spacesPerContext,
            )),
      );
      requireRouted(
        !context.spaces.has(space) || context.spaces.get(space) === epoch,
      );
      context.spaces.set(space, epoch);
    }
    return new Uint8Array();
  }

  async #admitProof(
    link: Link,
    context: Context,
    proof: RoutedProof,
  ): Promise<void> {
    try {
      const statement = await verifyRoutedProof(proof, {
        router: link.router,
        deployment: this.#options.deployment,
        epoch: link.epoch,
        context: context.id,
        now: this.#now(),
      });
      requireRouted(
        !link.closed && !context.closed && statement.exp > this.#now() &&
          !this.#options.routers.has(statement.principal) &&
          this.#options.epochs.healthy,
      );
      const now = this.#now();
      const digest = routedHex(sha256(proof.statement));
      const key = `${statement.principal}:${routedHex(statement.challenge)}`;
      // A statement serves one live context; once that context closes,
      // another may present it until it expires.
      const owner = link.claims.get(key);
      requireRouted(owner === undefined || owner === context);
      const prior = context.accepted.get(key);
      requireRouted(
        prior === undefined || prior.digest === digest && !prior.released,
      );
      for (const [key, accepted] of context.accepted) {
        if (accepted.exp > now) continue;
        context.accepted.delete(key);
        link.claims.delete(key);
      }
      // A released principal whose statement has expired admits nothing
      // more, so the history forgets it, as the router's does; creating a
      // space releases its key once its genesis commits.
      for (const [principal, grant] of context.grants) {
        if (grant.statement.exp <= now && context.released.has(principal)) {
          context.grants.delete(principal);
          context.released.delete(principal);
        }
      }
      const held = (principal: string) =>
        (context.grants.get(principal)?.statement.exp ?? 0) > now &&
        !context.released.has(principal);
      if (
        prior === undefined &&
        exceedsLimit(context.accepted.size + 1, this.#limits.proofsPerContext)
      ) throw new RoutedProofRefusal("proof-limit");
      if (
        this.#limits.principalsPerContext !== null &&
        !held(statement.principal) &&
        exceedsLimit(
          [...context.grants.keys()].filter(held).length + 1,
          this.#limits.principalsPerContext,
        )
      ) throw new RoutedProofRefusal("principal-limit");
      if (
        !context.grants.has(statement.principal) &&
        exceedsLimit(
          context.grants.size + 1,
          this.#limits.principalHistoryPerContext,
        )
      ) throw new RoutedProofRefusal("principal-history-limit");
      context.accepted.set(key, {
        principal: statement.principal,
        digest,
        exp: statement.exp,
        released: false,
      });
      link.claims.set(key, context);
      context.grants.set(statement.principal, { statement, digest });
      this.#audit(link, context, "proof-accepted");
      context.released.delete(statement.principal);
      context.backend?.admitRoutedPrincipal(statement.principal, statement.exp);
    } catch (error) {
      this.#audit(
        link,
        context,
        "proof-denied",
        undefined,
        error instanceof RoutedProofRefusal ? error.reason : undefined,
      );
      this.#closeContext(link, context, "proof-denied");
      if (!this.#options.epochs.healthy) this.close();
      throw error;
    }
  }

  /**
   * Sets one session's usage in its context, or removes it when `usage` is
   * undefined, and moves every total it counts toward by the difference, so
   * a capacity check reads totals instead of summing sessions.
   */
  #setUsage(
    link: Link,
    context: Context,
    key: string,
    usage: Usage | undefined,
  ): void {
    if (this.#countedKinds.length === 0) return;
    const prior = context.usage.get(key);
    if (prior !== undefined) this.#count(link.router, context, prior, -1);
    if (usage === undefined) context.usage.delete(key);
    else {
      context.usage.set(key, usage);
      this.#count(link.router, context, usage, 1);
    }
  }

  #count(router: string, context: Context, usage: Usage, sign: 1 | -1) {
    const add = (totals: Totals) => {
      for (const kind of this.#countedKinds) {
        totals[kind] += sign *
          (kind === "sessions"
            ? 1
            : kind === "watches"
            ? usage.count
            : usage.holdings);
      }
    };
    add(context.totals);
    add(this.#toolshedTotals);
    for (
      const [totals, key] of [
        [this.#routerTotals, router],
        [this.#principalTotals, usage.principal],
      ] as const
    ) {
      let scope = totals.get(key);
      if (scope === undefined) totals.set(key, scope = { ...NO_USAGE });
      add(scope);
      if (this.#countedKinds.every((kind) => scope[kind] === 0)) {
        totals.delete(key);
      }
    }
  }

  #clearUsage(link: Link, context: Context): void {
    for (const key of [...context.usage.keys()]) {
      this.#setUsage(link, context, key, undefined);
    }
  }

  /**
   * The capacity limit that `principal`'s change to `context` passed, if
   * any: sessions, watches or holdings, per context, router link, toolshed
   * or principal. Only that principal's totals moved, so only its own are
   * read.
   */
  #overCapacity(
    link: Link,
    context: Context,
    principal: string,
  ): RefusalReason | undefined {
    if (this.#countedKinds.length === 0) return undefined;
    const l = this.#limits;
    const scopes: [Totals, "Context" | "Router" | "Toolshed" | "Principal"][] =
      [
        [context.totals, "Context"],
        [this.#routerTotals.get(link.router) ?? NO_USAGE, "Router"],
        [this.#toolshedTotals, "Toolshed"],
        [this.#principalTotals.get(principal) ?? NO_USAGE, "Principal"],
      ];
    for (
      const [kind, reason] of [
        ["sessions", "session-limit"],
        ["watches", "watch-limit"],
        ["holdings", "holdings-limit"],
      ] as const
    ) {
      for (const [totals, scope] of scopes) {
        if (exceedsLimit(totals[kind], l[`${kind}Per${scope}`])) return reason;
      }
    }
    return undefined;
  }

  #attachData(socket: WebSocket, peer: string): void {
    const countUsage = this.#countedKinds.length > 0;
    const countWatches = this.#countedKinds.includes("watches");
    const countHoldings = this.#countedKinds.includes("holdings");
    let ticket: Ticket | undefined;
    let backend: Backend | undefined;
    let compression = false;
    // Whether bodies sent on this socket are compressed: on once compression
    // is negotiated, and changed by a `memory.compression` control as the
    // direct server's is.
    let sendCompression = false;
    let negotiatedMemoryFlags: Record<string, unknown> | undefined;
    let failed = false;
    let closeReason: CloseReason | undefined;
    let outputLimit: OutputLimit | undefined;
    const rememberClose = (reason: CloseReason, output?: OutputLimit): void => {
      if (closeReason === undefined) {
        closeReason = reason;
        outputLimit = output;
      }
      if (
        ticket !== undefined && ticket.context.socket === socket &&
        ticket.context.closeReason === undefined
      ) {
        ticket.context.closeReason = closeReason;
        ticket.context.outputLimit = outputLimit;
      }
    };
    let pendingBytes = 0;
    let assemblingBytes = 0;
    // The request credit counts bodies as sent, and a compressed one may
    // expand 32 times. The bodies being decoded or waiting in the connection
    // for their turns are held expanded, so the chain charges each body's
    // expanded size before decoding it and keeps the total within the same
    // input budget.
    let expandedBytes = 0;
    let expandedRoom: PromiseWithResolvers<boolean> | undefined;
    // Request credit granted to the router and not yet spent. The router
    // holds this less what the sender has not yet written.
    let credit = 0;
    let lastRequestOrdinal = 0;
    const pending = new Set<string>();
    const sessions = new Map<string, RoutedSession>();
    const opens = new Map<
      string,
      {
        space: string;
        principal: string;
        holdings?: number;
        reservation?: string;
        priorReservation?: {
          principal: string;
          count: number;
          holdings: number;
        };
      }
    >();
    const mutations =
      this.#trackWatchIds || this.#trackHoldings || this.#trackViews
        ? new Map<string, {
          key: string;
          session: RoutedSession;
          watches?: Set<string>;
          holdings?: number;
          views?: number;
          prior?: { principal: string; count: number; holdings: number };
        }>()
        : undefined;
    const closes = new Map<string, string>();
    // By session, a promise that settles when the turn of the session's last
    // dispatched watch mutation, resumption or close ends; see `accountingKey`.
    const accounting = new Map<string, Promise<void>>();
    let chain = Promise.resolve();
    // Retained output pauses reads of new requests and their dispatch at the
    // high mark, half the socket's queued-output bound (half the 8 MiB message
    // ceiling when that bound is disabled), and releases both below the low
    // mark, a quarter of it. A slow but live reader is back-pressured first;
    // the bound's `queued-output` refusal is reached only by a message that
    // would take retained output past the bound itself.
    const outputHighMark =
      (this.#limits.outputBytesPerSocket ?? ROUTED_RAW_LIMIT) / 2;
    const outputLowMark = outputHighMark / 2;
    let outputPaused = false;
    let outputResumed: PromiseWithResolvers<boolean> | undefined;

    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const issued = this.#now();
    queueMicrotask(() => {
      void new RoutedWriter("rdh1").text(this.#options.identity.did()).fixed(
        nonce,
      ).time(issued)
        .sign(this.#options.identity).then((bytes) =>
          sendBounded(
            socket,
            bytes,
            this.#limits.outputBytesPerSocket,
            rememberClose,
            "data",
          )
        ).catch(() => safeClose(socket));
    });
    const deadline = setTimeout(() => safeClose(socket), 5000);

    /** Cancels socket-owned work even while the transport remains `CLOSING`. */
    const cancel = (): void => {
      if (failed) return;
      failed = true;
      clearTimeout(deadline);
      outputPaused = false;
      outputResumed?.resolve(false);
      outputResumed = undefined;
      expandedRoom?.resolve(false);
      expandedRoom = undefined;
      incoming.close();
      // Completed frames release their own reservations in the chain finalizer.
      // Only the incomplete body's reservation still belongs to the assembler.
      pendingBytes -= assemblingBytes;
      assemblingBytes = 0;
      outgoing.close();
    };

    const fail = (reason: CloseReason) => {
      rememberClose(reason);
      cancel();
      if (ticket !== undefined && ticket.context.socket === socket) {
        this.#closeContext(ticket.link, ticket.context, closeReason!);
      } else {
        backend?.close();
        safeClose(socket);
      }
    };
    const incoming = new RouterAssembler((bytes) => {
      if (pendingBytes + bytes > ROUTED_QUEUE_LIMIT) {
        fail("data-queue-limit");
        requireRouted(false);
      }
      pendingBytes += bytes;
      assemblingBytes = bytes;
    });
    // Dispatch starts in socket order through `chain`, which checks and
    // reserves each request before handing its body to the Memory connection.
    // The connection orders turns per space itself (04-protocol.md section
    // 4.11.2), so the hand-off does not wait for a turn to end. The routes of
    // the requests whose turns are open attribute their responses; unsolicited
    // pushes carry their own routing fields.
    const dispatchRoutes = new Map<string, Record<string, unknown>>();
    // The turns handed to the connection and not yet ended, for `settled`.
    const openTurns = new Set<Promise<void>>();
    let enqueueSource: OutputSource | undefined;
    const outgoing = new RouterSender(
      (record, done) => socket.send(record, done),
      () => fail("socket-send-failure"),
      this.#limits.outputBytesPerSocket,
      {
        observe: (event) => {
          diagnostics.observe(
            event,
            event === "enqueue" ? enqueueSource : undefined,
          );
          if (event === "enqueue" || event === "complete") {
            updateOutputFlow();
            updateReadFlow();
          }
        },
      },
    );
    const diagnostics = new RoutedOutputDiagnostics(
      outgoing,
      () => socket.bufferedAmount,
    );
    let readsPaused = false;

    /** Latches the watermark state from the sender's retained bytes. */
    const updateOutputFlow = (): void => {
      const bytes = outgoing.bufferedBytes;
      if (!outputPaused && bytes >= outputHighMark) {
        outputPaused = true;
      } else if (outputPaused && bytes < outputLowMark) {
        outputPaused = false;
        outputResumed?.resolve(true);
        outputResumed = undefined;
      }
    };

    /** Holds the request chain while retained output is at the high mark. */
    const awaitOutputCapacity = async (): Promise<void> => {
      while (!failed && outputPaused) {
        outputResumed ??= Promise.withResolvers<boolean>();
        requireRouted(await outputResumed.promise);
      }
    };

    /** Holds the request chain until a body of `bytes` expanded fits the budget. */
    const awaitExpandedRoom = async (bytes: number): Promise<void> => {
      while (
        !failed && expandedBytes > 0 &&
        expandedBytes + bytes > ROUTED_QUEUE_LIMIT
      ) {
        expandedRoom ??= Promise.withResolvers<boolean>();
        requireRouted(await expandedRoom.promise);
      }
    };

    /** Returns request credit to the router. */
    const grantCredit = (bytes: number): void => {
      credit += bytes;
      outgoing.sendCredit(bytes);
    };

    /** Pauses at body boundaries while retained output holds request dispatch. */
    const updateReadFlow = (): void => {
      if (failed || socket.readyState !== WebSocket.OPEN) return;
      // Output at the high mark stops the next request until it falls below
      // the low mark. Finish an admitted input body before pausing, including
      // buffered records delivered by ws after pause. Its reservation still
      // obeys the hard cap.
      const pause = outputPaused && !incoming.receiving;
      if (pause === readsPaused) return;
      readsPaused = pause;
      if (pause) socket.pause();
      else socket.resume();
    };

    dataSocketLifecycles.set(socket, {
      cancel,
      get pendingBytes() {
        return pendingBytes;
      },
      get assemblingBytes() {
        return assemblingBytes;
      },
      get expandedBytes() {
        return expandedBytes;
      },
      get outputBytes() {
        return outgoing.bufferedBytes;
      },
      get outputPaused() {
        return outputPaused;
      },
      get settled() {
        // Every dispatch started and every open turn ended.
        return chain.then(() => Promise.all(openTurns)).then(
          () => undefined,
          () => undefined,
        );
      },
    });

    socket.addEventListener("close", () => {
      fail("data-peer-close");
      dataSocketLifecycles.delete(socket);
    }, { once: true });
    socket.addEventListener("error", () => {
      fail("data-socket-error");
    }, { once: true });
    const send = (
      message: ServerMessage | MemoryCompressionControlMessage,
    ): void => {
      if (
        failed || socket.readyState !== WebSocket.OPEN ||
        ticket?.context.closed ||
        ticket?.link.closed
      ) return;
      if (message.type === "hello.ok") {
        message.flags.connectionAuth = true;
        message.flags.routedAuthV1 = true;
        message.flags.routedCompressionV1 = true;
        sendBounded(
          socket,
          JSON.stringify({
            type: "router.ready",
            version: ROUTER_PROTOCOL_VERSION,
            memoryFlags: message.flags,
            routerEncodingNegotiation: true,
            routerRequestCredit: true,
            negotiatedMemoryFlags,
          }),
          this.#limits.outputBytesPerSocket,
          rememberClose,
          "data",
        );
        // The socket is ready: the router may now send requests within the
        // whole input budget, and gets each request's bytes back as its turn
        // ends.
        grantCredit(ROUTER_REQUEST_WINDOW);
        return;
      }
      const route = routerRoute(message);
      const source = outputSource(
        route,
        typeof route.requestId === "string"
          ? dispatchRoutes.get(route.requestId)
          : undefined,
      );
      if (message.type === "response") {
        pending.delete(message.requestId);
        const mutation = mutations?.get(message.requestId);
        mutations?.delete(message.requestId);
        if (mutation !== undefined) {
          if (!sessions.has(mutation.key)) {
            this.#setUsage(
              ticket!.link,
              ticket!.context,
              mutation.key,
              undefined,
            );
          } else if (message.error !== undefined) {
            this.#setUsage(
              ticket!.link,
              ticket!.context,
              mutation.key,
              mutation.prior,
            );
          } else {
            if (this.#trackWatchIds) {
              mutation.session.watches = mutation.watches;
            }
            if (this.#trackHoldings) {
              mutation.session.holdings = mutation.holdings;
            }
            if (this.#trackViews) mutation.session.views = mutation.views;
          }
        }
        const closed = closes.get(message.requestId);
        closes.delete(message.requestId);
        if (closed !== undefined && message.error === undefined) {
          sessions.delete(closed);
          this.#setUsage(ticket!.link, ticket!.context, closed, undefined);
        }
        const open = opens.get(message.requestId);
        if (open !== undefined) {
          this.#audit(
            ticket!.link,
            ticket!.context,
            message.error === undefined ? "session-admitted" : "session-denied",
            open.space,
          );
        }
        opens.delete(message.requestId);
        if (open?.reservation !== undefined) {
          this.#setUsage(
            ticket!.link,
            ticket!.context,
            open.reservation,
            message.error !== undefined && sessions.has(open.reservation)
              ? open.priorReservation
              : undefined,
          );
        }
        if (
          open !== undefined && isPlainObject(message.ok) &&
          typeof message.ok.sessionId === "string"
        ) {
          const key = `${open.space} ${message.ok.sessionId}`;
          const prior = sessions.get(key);
          sessions.set(key, {
            space: open.space,
            principal: open.principal,
            ...(this.#trackWatchIds
              ? { watches: prior?.watches ?? new Set<string>() }
              : {}),
            ...(this.#trackHoldings ? { holdings: open.holdings } : {}),
            ...(this.#trackViews ? { views: prior?.views ?? 0 } : {}),
          });
          if (countUsage) {
            this.#setUsage(ticket!.link, ticket!.context, key, {
              principal: open.principal,
              count: countWatches
                ? (prior?.watches?.size ?? 0) + (prior?.views ?? 0)
                : 0,
              holdings: countHoldings ? open.holdings ?? 0 : 0,
            });
          }
        }
      }
      if (message.type === "session/revoked") {
        const key = `${message.space} ${message.sessionId}`;
        sessions.delete(key);
        this.#setUsage(ticket!.link, ticket!.context, key, undefined);
      }
      const payload = encodeMemoryBoundary(message);
      const bytes = new TextEncoder().encode(payload);
      // A client that negotiated `messageCompressionV1` and
      // `routedCompressionV1` receives each message of 1 KiB or more that gzip
      // makes smaller as the routed compression envelope, which the router
      // forwards as an opaque binary body. The output bounds apply to what goes
      // on the socket.
      const frame = sendCompression
        ? compressRoutedPayload(
          payload,
          bytes,
          "space" in message && typeof message.space === "string"
            ? message.space
            : undefined,
          nativeGzip,
        )
        : payload;
      const size = typeof frame === "string" ? bytes.length : frame.length;
      checkOutput(
        socket,
        size,
        Math.max(socket.bufferedAmount, outgoing.bufferedBytes),
        this.#limits.outputBytesPerSocket,
        rememberClose,
        "data",
        message.type,
        () => ({
          ...diagnostics.snapshot(source),
          messageSizes: outputSizeBreakdown(
            message,
            bytes.length,
            this.#limits.frameSlots,
          ),
        }),
      );
      enqueueSource = source;
      try {
        outgoing.send(route, frame);
      } finally {
        enqueueSource = undefined;
      }
    };
    socket.addEventListener("message", (event: { data: unknown }) => {
      if (failed || socket.readyState !== WebSocket.OPEN) return;
      let frame: string | Uint8Array | undefined =
        typeof event.data === "string"
          ? event.data
          : event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : undefined;
      let route: Record<string, unknown> | undefined;
      let reservedBytes: number | undefined;
      if (ticket !== undefined) {
        try {
          requireRouted(frame instanceof Uint8Array);
          if (decodeRouterRecord(frame).kind === 0) {
            requireRouted(!incoming.receiving);
            const header = decodeRouterHeader(frame);
            requireRouted(
              header.requestOrdinal !== undefined &&
                lastRequestOrdinal < ROUTER_MAX_REQUEST_ORDINAL &&
                header.requestOrdinal === lastRequestOrdinal + 1,
            );
            if (header.bytes > ROUTED_QUEUE_LIMIT) {
              fail("data-queue-limit");
              return;
            }
            // The router sends a header only within the credit it has
            // received. One past it comes from a broken router; accepting it
            // would return more credit than the window when its turn ends.
            if (header.bytes > credit - outgoing.unsentCredit) {
              fail("data-queue-limit");
              return;
            }
            credit -= header.bytes;
            lastRequestOrdinal = header.requestOrdinal;
            incoming.receive(frame);
            updateReadFlow();
            return;
          }
          requireRouted(incoming.receiving);
          const complete = incoming.receive(frame);
          if (complete !== undefined) assemblingBytes = 0;
          updateReadFlow();
          if (complete === undefined) return;
          frame = complete.payload;
          route = complete.header.route;
          reservedBytes = complete.header.bytes;
        } catch {
          fail("data-protocol");
          return;
        }
      }
      if (
        frame === undefined ||
        (route === undefined
            ? pendingBytes += typeof frame === "string"
              ? new TextEncoder().encode(frame).length
              : frame.length
            : pendingBytes) > ROUTED_QUEUE_LIMIT
      ) {
        fail(frame === undefined ? "data-protocol" : "data-queue-limit");
        return;
      }
      const frameBytes = reservedBytes ??
        (typeof frame === "string"
          ? new TextEncoder().encode(frame).length
          : frame.length);
      // The request this frame carries, once its identifier is checked, so a
      // refusal at a capacity limit can answer it.
      let refusedRequest: string | undefined;
      // Its route as dispatched, so the release removes only its own: the
      // router lets a client reuse an answered ID while this turn is open.
      let dispatchedRoute: Record<string, unknown> | undefined;
      // Whether the body reached the connection: its turn then owns the
      // frame's reservation and releases it when the turn ends.
      let handedOver = false;
      // The expanded size this body has charged, once the chain reaches it.
      let expanded = 0;
      // Lets the session's next watch mutation or resumption be dispatched.
      let settleAccounting: (() => void) | undefined;
      const release = (): void => {
        settleAccounting?.();
        if (
          refusedRequest !== undefined &&
          dispatchRoutes.get(refusedRequest) === dispatchedRoute
        ) dispatchRoutes.delete(refusedRequest);
        pendingBytes -= frameBytes;
        if (expanded > 0) {
          expandedBytes -= expanded;
          expandedRoom?.resolve(true);
          expandedRoom = undefined;
        }
        // A request's turn has ended: its declared bytes go back to the router
        // as credit for the next requests.
        if (reservedBytes !== undefined && !failed) grantCredit(reservedBytes);
        updateReadFlow();
      };
      chain = chain.then(async () => {
        if (failed) return;
        if (ticket !== undefined) {
          const size = typeof frame === "string"
            ? frameBytes
            : routedDeclaredExpansion(frame, compression);
          // A body that alone expands past the budget is refused, as one
          // sent past it is: a routed request is at most 4 MiB expanded.
          if (size > ROUTED_QUEUE_LIMIT) return fail("data-queue-limit");
          if (expandedBytes > 0 && expandedBytes + size > ROUTED_QUEUE_LIMIT) {
            await awaitExpandedRoom(size);
          }
          expanded = size;
          expandedBytes += size;
        }
        // Only the active chain entry waits. Queued frames retain their input
        // reservation, and unsolicited pushes retain hard output admission.
        if (outputPaused) await awaitOutputCapacity();
        requireRouted(
          !failed && socket.readyState === WebSocket.OPEN && !this.#closed,
        );
        const parsed = ticket === undefined
          ? {
            body: routedObject(
              // Two independently bounded 2 KiB descriptors plus hello fields.
              parseRoutedJson(
                typeof frame === "string" ? frame : "",
                2 * 2048 + 16,
              ),
            ),
            payload: "",
            space: undefined,
          }
          : await decodeRoutedFrameAsync(
            frame,
            compression,
            this.#limits.frameSlots,
            this.#limits.holdingsPerSession,
          );
        const body = parsed.body;
        if (ticket === undefined) {
          requireRouted(
            typeof frame === "string" && body.type === "router.hello" &&
              body.version === ROUTER_PROTOCOL_VERSION &&
              body.routerRequestCredit === true &&
              Object.keys(body).every((key) =>
                [
                  "type",
                  "version",
                  "memoryFlags",
                  "negotiatedMemoryFlags",
                  "routerRequestCredit",
                  "routerTicket",
                  "routerBinding",
                ]
                  .includes(key)
              ),
          );
          const id = routedHex(readRoutedHex(body.routerTicket, 32));
          const selected = this.#tickets.get(id);
          // Check the live ticket before signature verification, then recheck
          // after its await and atomically consume it against this socket nonce.
          requireRouted(
            selected !== undefined &&
              selected.expires > this.#now() && !selected.link.closed &&
              !selected.context.closed && selected.link.peer === peer,
          );
          requireRouted(
            equalRoutedBytes(
              routedFlags(body.memoryFlags),
              selected.context.flags,
            ),
          );
          const supported = () => ({
            ...this.#options.server.memoryProtocolFlags(),
            connectionAuth: true,
            routedAuthV1: true,
            routedCompressionV1: true,
          });
          const encodingBytes = validatedRoutedEncodingFlags(
            body.negotiatedMemoryFlags,
            body.memoryFlags,
            supported(),
            ["routerEncodingNegotiation", "routerRequestCredit"],
          );
          const binding = new RoutedReader(
            await verifyRoutedRecord(
              readRoutedBase64(body.routerBinding),
              selected.link.router,
            ),
            "rdb1",
          );
          requireRouted(
            binding.text() === selected.link.router &&
              binding.text() === this.#options.deployment &&
              binding.text() === this.#options.identity.did(),
          );
          requireRouted(
            equalRoutedBytes(binding.fixed(16), selected.link.epoch) &&
              equalRoutedBytes(binding.fixed(16), selected.context.id),
          );
          requireRouted(
            routedHex(binding.fixed(32)) === selected.id &&
              equalRoutedBytes(binding.fixed(32), nonce) &&
              binding.time() === issued,
          );
          requireRouted(
            equalRoutedBytes(binding.fixed(32), sha256(selected.context.flags)),
          );
          requireRouted(
            equalRoutedBytes(binding.fixed(32), sha256(encodingBytes)),
          );
          binding.end();
          // Signature verification yields. Recheck the exact live ticket and
          // atomically consume it only after binding it to this socket's nonce.
          // Another socket may have redeemed it meanwhile, which removed it.
          requireRouted(
            !failed && socket.readyState === WebSocket.OPEN &&
              this.#tickets.get(id) === selected &&
              selected.expires > this.#now() &&
              this.#now() < issued + 15 && !selected.link.closed &&
              !selected.context.closed &&
              !this.#revoked.has(selected.link.router),
          );
          // Endpoint capabilities can change while signature verification yields.
          validatedRoutedEncodingFlags(
            body.negotiatedMemoryFlags,
            body.memoryFlags,
            supported(),
            ["routerEncodingNegotiation", "routerRequestCredit"],
          );
          negotiatedMemoryFlags = routedObject(body.negotiatedMemoryFlags);
          // A redeemed ticket is dropped here: a context redeems one for
          // every data socket it opens, so tickets kept longer would count
          // against `limits.tickets`.
          this.#tickets.delete(id);
          selected.context.tickets.delete(id);
          ticket = selected;
          clearTimeout(deadline);
          const context = selected.context;
          const prior = context.socket;
          context.backend?.close();
          this.#clearUsage(selected.link, context);
          context.socket = socket;
          // The replacement socket has its own failure history.
          context.closeReason = undefined;
          context.outputLimit = undefined;
          context.sessions = sessions;
          backend = this.#options.server.connectRouted(
            send,
            (space) =>
              !context.closed && !selected.link.closed &&
              context.spaces.has(space) &&
              context.spaces.get(space) === this.#options.ownership(space),
          );
          context.backend = backend;
          if (prior !== undefined && prior !== socket) {
            safeClose(prior);
          }
          for (const [principal, grant] of context.grants) {
            if (grant.statement.exp > this.#now()) {
              backend.admitRoutedPrincipal(principal, grant.statement.exp);
              if (context.released.has(principal)) {
                backend.releasePrincipal(principal);
              }
            }
          }
          // Bodies are compressed end to end only for a client that offered
          // `routedCompressionV1`: an older SDK takes binary frames on a
          // credited connection for router credit.
          compression = negotiatedMemoryFlags.messageCompressionV1 === true &&
            negotiatedMemoryFlags.routedCompressionV1 === true;
          sendCompression = compression;
          const hello = {
            type: "hello",
            protocol: "memory",
            flags: negotiatedMemoryFlags,
          };
          try {
            await backend.receive(`fvj1:${JSON.stringify(hello)}`);
          } catch (error) {
            rememberClose("backend-failure");
            throw error;
          }
          return;
        }
        requireRouted(
          !failed && socket.readyState === WebSocket.OPEN &&
            backend !== undefined && ticket.context.socket === socket &&
            !ticket.link.closed && !ticket.context.closed,
        );
        requireRouted(
          JSON.stringify(routerRoute(body)) ===
            JSON.stringify(routerRoute(route)),
        );
        requireRouted(
          ![
            "routerTicket",
            "routerBinding",
            "forwarded",
            "contextId",
            "upstream",
            "host",
            "authorization",
            "invocation",
            "actingAs",
            "statement",
          ].some((key) => body[key] !== undefined),
        );
        if (body.type === "memory.compression") {
          // The router answers this control itself, for every toolshed on the
          // connection; a router that forwards it changes this socket's send
          // mode, and the reply states the mode now in force.
          requireRouted(typeof body.enabled === "boolean");
          routedIdentifier(body.requestId);
          sendCompression = compression && body.enabled;
          send({
            type: "memory.compression",
            requestId: body.requestId,
            enabled: sendCompression,
          });
          return;
        }
        requireRouted(
          parsed.space !== undefined &&
            ticket.context.spaces.has(parsed.space) &&
            ticket.context.spaces.get(parsed.space) ===
              this.#options.ownership(parsed.space),
        );
        routedIdentifier(body.requestId);
        if (
          pending.has(body.requestId) ||
          exceedsLimit(pending.size + 1, this.#limits.requestsPerContext)
        ) {
          rememberClose(
            pending.has(body.requestId) ? "duplicate-request" : "request-cap",
          );
          requireRouted(false);
        }
        pending.add(body.requestId);
        dispatchedRoute = routerRoute(body);
        dispatchRoutes.set(body.requestId, dispatchedRoute);
        refusedRequest = body.requestId;
        // While quota mirrors are kept, a session's watch mutations,
        // resumptions and close are dispatched one at a time, each once the
        // turn of the one before it has ended: each reads or changes the
        // session's mirrors, which change only when that one is answered. The
        // router holds a session's requests behind its unanswered watch
        // mutation, but holds neither a resumption behind a watch mutation nor
        // the reverse, so this waits rarely. While it waits, this socket's
        // later requests wait with it, in order. Only the chain's head waits,
        // so one request at most is waiting for a key.
        const key = mutations === undefined
          ? undefined
          : accountingKey(body, parsed.space);
        if (key !== undefined) {
          while (accounting.has(key)) {
            await accounting.get(key);
            // The earlier request's answer may have filled the output.
            if (outputPaused) await awaitOutputCapacity();
            requireRouted(
              !failed && socket.readyState === WebSocket.OPEN &&
                !ticket.link.closed && !ticket.context.closed,
            );
          }
          const settled = Promise.withResolvers<void>();
          accounting.set(key, settled.promise);
          settleAccounting = () => {
            if (accounting.get(key) === settled.promise) accounting.delete(key);
            settled.resolve();
          };
        }
        if (body.type === "session.open") {
          requireRouted(typeof body.principal === "string");
          // The router forwards an open only for a principal it holds, so
          // one this context no longer holds crossed a release or an expiry
          // on the way. An expired grant passes once the router has the
          // client sign again; a released or unknown principal does not.
          const grant = ticket.context.grants.get(body.principal);
          if (
            grant === undefined || ticket.context.released.has(body.principal)
          ) throw new RoutedRequestRefusal("principal-not-held");
          if (grant.statement.exp <= this.#now()) {
            throw new RoutedRequestRefusal("principal-expired");
          }
          const session = routedObject(body.session);
          requireRouted(session.actingAs === undefined);
          if (
            exceedsLimit(
              sessions.size + opens.size + 1,
              this.#limits.sessionsPerContext,
            )
          ) {
            throw new RoutedRequestRefusal("session-limit");
          }
          const priorKey = typeof session.sessionId === "string"
            ? `${parsed.space} ${session.sessionId}`
            : undefined;
          const prior = priorKey === undefined
            ? undefined
            : sessions.get(priorKey);
          requireRouted(
            prior === undefined || prior.principal === body.principal,
          );
          const holdings = body.holdings === undefined
            ? prior?.holdings ?? 0
            : routedListLength(body.holdings);
          const reservation = countUsage
            ? prior === undefined ? `pending ${body.requestId}` : priorKey!
            : undefined;
          // Registered first, so a refusal's answer undoes the reservation.
          opens.set(body.requestId, {
            space: parsed.space,
            principal: body.principal,
            ...(this.#trackHoldings ? { holdings } : {}),
            ...(reservation === undefined ? {} : {
              reservation,
              priorReservation: ticket.context.usage.get(reservation),
            }),
          });
          if (reservation !== undefined) {
            this.#setUsage(ticket.link, ticket.context, reservation, {
              principal: body.principal,
              count: countWatches
                ? (prior?.watches?.size ?? 0) + (prior?.views ?? 0)
                : 0,
              holdings: countHoldings ? holdings : 0,
            });
          }
          const over = this.#overCapacity(
            ticket.link,
            ticket.context,
            body.principal,
          );
          if (over !== undefined) throw new RoutedRequestRefusal(over);
        } else {
          routedIdentifier(body.sessionId);
          const session = sessions.get(`${parsed.space} ${body.sessionId}`);
          // A session revoked after the router forwarded this request, as
          // the creating session is once its genesis ACL commits: the
          // revocation notice is already on its way to the router, which
          // then denies the session's requests itself, so this one is
          // denied as the router would deny it.
          if (session === undefined) {
            throw new RoutedRequestRefusal("session-not-held");
          }
          requireRouted(session.space === parsed.space);
          if (
            body.type === "session.watch.set" ||
            body.type === "session.watch.add" ||
            body.type === "session.watch.remove"
          ) {
            const listed = body.type === "session.watch.remove"
              ? body.watchIds
              : body.watches;
            requireRouted(Array.isArray(listed));
            // Mirrored only while a watch quota needs the IDs; see
            // `#trackWatchIds`.
            const watches = this.#trackWatchIds
              ? body.type === "session.watch.set"
                ? new Set<string>()
                : new Set(session.watches)
              : undefined;
            for (const watch of listed) {
              const id = body.type === "session.watch.remove"
                ? watch
                : routedObject(watch).id;
              routedIdentifier(id);
              if (body.type === "session.watch.remove") watches?.delete(id);
              else watches?.add(id);
            }
            const key = `${parsed.space} ${body.sessionId}`;
            // Only a `session.watch.set` replaces a session's holdings and
            // views. The Memory server reads `watches` alone from an add,
            // and `watchIds` alone from a removal, so holdings or views named
            // on either change nothing the session holds, and counting them
            // would put the session's usage below what the server keeps for
            // it. On every request they must still be lists.
            const named = (field: unknown, held: number): number => {
              if (field === undefined) return held;
              const length = routedListLength(field);
              return body.type === "session.watch.set" ? length : held;
            };
            const holdings = named(body.holdings, session.holdings ?? 0);
            const views = named(body.views, session.views ?? 0);
            // Bounds on what one session holds, refused for good: the watch
            // IDs by `limits.watchesPerSession`, the views by
            // `limits.viewsPerSession`.
            // The request is well formed, and for a `session.watch.add`
            // whether it fits depends on the IDs the session already holds,
            // so it is answered and the socket stays open, as the router
            // answers it; a `session.watch.set` that names more IDs than a
            // session may hold is answered the same way.
            if (
              exceedsLimit(
                watches?.size ?? 0,
                this.#limits.watchesPerSession,
              ) ||
              exceedsLimit(views, this.#limits.viewsPerSession)
            ) {
              throw new RoutedRequestRefusal("frame-limit");
            }
            // Registered first, so a refusal's answer undoes the reservation.
            mutations?.set(body.requestId, {
              key,
              session,
              ...(this.#trackWatchIds ? { watches } : {}),
              ...(this.#trackHoldings ? { holdings } : {}),
              ...(this.#trackViews ? { views } : {}),
              prior: ticket.context.usage.get(key),
            });
            if (countWatches || countHoldings) {
              this.#setUsage(ticket.link, ticket.context, key, {
                principal: session.principal,
                count: countWatches ? (watches?.size ?? 0) + views : 0,
                holdings: countHoldings ? holdings : 0,
              });
            }
            const over = this.#overCapacity(
              ticket.link,
              ticket.context,
              session.principal,
            );
            if (over !== undefined) throw new RoutedRequestRefusal(over);
          }
        }
        // Retain the frame's queue budget until its protected Memory turn ends.
        // Control-link revocation can still close/fence that turn independently.
        if (
          body.type === "session.close" && typeof body.sessionId === "string"
        ) {
          const key = `${parsed.space} ${body.sessionId}`;
          closes.set(body.requestId, key);
        }
        // Hand the body over without waiting for its turn to end. The frames
        // that queue in the connection let the server's subscription refresh
        // wait until no frame is pending and evaluate one pass for many
        // commits (04-protocol.md section 4.11.2); a hand-off that waited kept
        // that queue empty, so every commit ran its own refresh pass and the
        // socket carried one request at a time. The reservation, the route and
        // the request credit the router gets back wait for the turn.
        handedOver = true;
        const turn: Promise<void> = backend.receive(parsed.payload).catch(
          () => {
            if (failed) return;
            rememberClose("backend-failure");
            fail("data-protocol");
          },
        ).finally(() => {
          openTurns.delete(turn);
          release();
        });
        openTurns.add(turn);
      }).catch(async (error) => {
        if (failed) return;
        if (!(error instanceof RoutedRequestRefusal)) {
          return fail("data-protocol");
        }
        // One refused request is denied; the socket and its other sessions
        // go on, and the answer undoes any reservation.
        const requestId = refusedRequest;
        if (requestId === undefined || ticket === undefined) {
          return fail("data-protocol");
        }
        this.#audit(
          ticket.link,
          ticket.context,
          "request-refused",
          undefined,
          error.reason,
        );
        try {
          if (outputPaused) await awaitOutputCapacity();
          requireRouted(!failed && socket.readyState === WebSocket.OPEN);
          send({
            type: "response",
            requestId,
            error: {
              name: "AuthorizationError",
              message: "Routed memory request denied",
              ...(error.retriable ? { retriable: true } : {}),
            },
          } as ServerMessage);
        } catch {
          fail("socket-send-failure");
        }
      }).finally(() => {
        if (!handedOver) release();
      });
    });
  }
}

/**
 * The session whose quota mirrors `body` reads or changes: a watch
 * mutation's or a close's, or the one a `session.open` resumes. Undefined for
 * any other request, and for an open that starts a new session.
 */
function accountingKey(
  body: Record<string, unknown>,
  space: string,
): string | undefined {
  if (
    body.type === "session.watch.set" || body.type === "session.watch.add" ||
    body.type === "session.watch.remove" || body.type === "session.close"
  ) {
    return typeof body.sessionId === "string"
      ? `${space} ${body.sessionId}`
      : undefined;
  }
  if (body.type !== "session.open" || !isPlainObject(body.session)) {
    return undefined;
  }
  return typeof body.session.sessionId === "string"
    ? `${space} ${body.session.sessionId}`
    : undefined;
}

/**
 * The number of entries in a request's `holdings` or `views`, which must be
 * a JSON list, as the SDK sends and the router requires; anything else is
 * malformed. A record cannot be counted by its members instead: the frame
 * parser admits one under `holdings`, and the Memory server decodes a
 * record tagged `/quote` into the list it wraps, of any length.
 */
function routedListLength(list: unknown): number {
  requireRouted(Array.isArray(list));
  return list.length;
}

/**
 * Validates effective encoding capabilities against the original client and
 * current endpoint, returning canonical bytes for their separate signed hash.
 * The router authenticates the public snapshot; this check enforces its local
 * bounds. Private capability names and `serverExecution` must be absent.
 *
 * @throws If a descriptor is malformed, exceeds its bounds, changes the wire
 * mode, omits routed authentication, or enables an unsupported capability.
 */
export function validatedRoutedEncodingFlags(
  effective: unknown,
  original: unknown,
  supported: unknown,
  privateCapabilities: readonly string[],
): Uint8Array {
  const bytes = routedFlags(effective);
  // The backend must accept known capability types before the live connection
  // is replaced. Parsing is validation only: the signed descriptor keeps its
  // unknown fields, omissions, and array order.
  requireRouted(parseMemoryProtocolFlags(effective) !== null);
  routedFlags(original);
  routedFlags(supported);
  const selected = routedObject(effective);
  const client = routedObject(original);
  const endpoint = routedObject(supported);
  requireRouted(
    (client.modernCellRep === undefined ||
      typeof client.modernCellRep === "boolean") &&
      (endpoint.modernCellRep === undefined ||
        typeof endpoint.modernCellRep === "boolean") &&
      (selected.modernCellRep === true) === (client.modernCellRep === true) &&
      (selected.modernCellRep === true) === (endpoint.modernCellRep === true) &&
      !Object.hasOwn(selected, "serverExecution") &&
      privateCapabilities.every((key) => !Object.hasOwn(selected, key)),
  );
  for (const [key, value] of Object.entries(selected)) {
    // A false boolean or empty set enables nothing, even when an older peer
    // has no entry or a different value kind for the capability.
    for (const descriptor of [client, endpoint]) {
      const available = Object.hasOwn(descriptor, key)
        ? descriptor[key]
        : undefined;
      if (Array.isArray(value)) {
        requireRouted(
          value.length === 0 ||
            Array.isArray(available) &&
              value.every((member) => available.includes(member)),
        );
      } else {
        requireRouted(
          value === false || available === true,
        );
      }
    }
  }
  return bytes;
}

/** Starts closure and permits a paused socket to receive the peer's reply. */
function safeClose(socket: WebSocket): void {
  dataSocketLifecycles.get(socket)?.cancel();
  controlSocketDiagnostics.get(socket)?.close();
  try {
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close(1008, "Routed memory connection ended");
    }
    // A paused reader must receive the peer's closing handshake. Request
    // dispatch is fenced by the socket's `CLOSING` state.
    if (socket.readyState === WebSocket.CLOSING && socket.isPaused) {
      socket.resume();
    }
  } catch { /* A concurrent transport close already ended the socket. */ }
}

/** Marks output failures before closing, so close callbacks retain the cause. */
function sendBounded(
  socket: WebSocket,
  bytes: string | Uint8Array,
  queueLimit: number | null,
  rememberClose: (reason: CloseReason, output?: OutputLimit) => void,
  endpoint: OutputLimit["endpoint"],
  messageType?: OutputLimit["messageType"],
  /** Optional diagnostic observer; response dispatch remains synchronous. */
  completed?: (error?: Error | null) => void,
): void {
  const size = typeof bytes === "string"
    ? new TextEncoder().encode(bytes).length
    : bytes.length;
  checkOutput(
    socket,
    size,
    socket.bufferedAmount,
    queueLimit,
    rememberClose,
    endpoint,
    messageType,
  );
  try {
    socket.send(bytes instanceof Uint8Array ? bytes.slice() : bytes, completed);
  } catch (error) {
    rememberClose("socket-send-failure");
    throw error;
  }
}

/**
 * Checks output and records operands before terminating a full socket. A
 * message larger than `ROUTED_RAW_LIMIT` is refused on any socket: the router
 * accepts no larger response header and the SDK no larger frame. A smaller
 * message is admitted when the socket holds nothing (`bufferedBytes` is zero),
 * however large; otherwise `queueLimit`, when enabled, bounds the queued bytes
 * plus the message, so one socket's queue stays bounded while a response that
 * only fits alone (a whole-space sync) still goes out.
 */
function checkOutput(
  socket: WebSocket,
  size: number,
  bufferedBytes: number,
  queueLimit: number | null,
  rememberClose: (reason: CloseReason, output?: OutputLimit) => void,
  endpoint: OutputLimit["endpoint"],
  messageType?: OutputLimit["messageType"],
  diagnostics?: () => RoutedOutputSnapshot,
): void {
  const tooLarge = size > ROUTED_RAW_LIMIT;
  if (
    tooLarge ||
    (bufferedBytes > 0 && queueLimit !== null &&
      bufferedBytes + size > queueLimit)
  ) {
    // Socket accounting can change during close; keep this check's operands.
    rememberClose(
      "output-limit",
      Object.freeze({
        frameBytes: size,
        bufferedBytes,
        limitBytes: tooLarge ? ROUTED_RAW_LIMIT : queueLimit as number,
        endpoint,
        classification: tooLarge ? "single-message" : "queued-output",
        ...(messageType === undefined ? {} : { messageType }),
        ...(diagnostics === undefined ? {} : { diagnostics: diagnostics() }),
      }),
    );
    safeClose(socket);
    throw new Error("Routed memory output limit");
  }
}
