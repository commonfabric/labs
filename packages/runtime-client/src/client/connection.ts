import { debugStr } from "@commonfabric/data-model";
import { defer, type Deferred } from "@commonfabric/utils/defer";
import { getLogger } from "@commonfabric/utils/logger";
import { unrefTimer } from "@commonfabric/utils/sleep";
import {
  CellRef,
  CellUpdateNotification,
  ClientNotificationType,
  CommandRequest,
  CommandResponse,
  Commands,
  ConsoleMessage,
  ErrorNotification,
  EventIntentOutcomeNotification,
  EventNeedsAttentionNotification,
  InitializationData,
  IPCClientNotification,
  IPCRemoteMessage,
  isCellUpdateNotification,
  isConsoleNotification,
  isErrorNotification,
  isEventIntentOutcomeNotification,
  isEventNeedsAttentionNotification,
  isIPCRemoteNotification,
  isIPCRemoteResponse,
  isNavigateRequestNotification,
  isOperationUpdateNotification,
  isPendingWritesNotification,
  isSpaceAccessLostNotification,
  isTelemetryNotification,
  isVDomBatchNotification,
  NavigateRequestNotification,
  NotificationType,
  OperationUpdateNotification,
  PendingWritesNotification,
  RequestType,
  type RuntimeSecurityContext,
  SerializedDomEvent,
  SpaceAccessLostNotification,
  TelemetryNotification,
  VDomBatchNotification,
  VDomMountResponse,
} from "@/protocol/mod.ts";
import { assertNoKeyMaterial } from "@/shared/key-material.ts";
import { RuntimeTransport } from "./transport.ts";
import { EventEmitter } from "./emitter.ts";
import { $onCellUpdate, CellHandle } from "@/cell-handle.ts";
import { cellRefToKey } from "@/shared/utils.ts";

const ipcLogger = getLogger("runtime-client");

const DEBUG_IPC = false;

interface PendingRequest<T = unknown> {
  msgId: number;
  type: RequestType;
  startTime: number;
  deferred: Deferred<T, Error>;
  // Listener that settles this request if the connection is disposed while it
  // is still in flight. Removed when the request settles normally. Absent for
  // the Dispose request, which must outlive the abort.
  onAbort?: () => void;
}

/**
 * One in-flight request: sent to the worker, no response yet. `ageMs` is how
 * long it has been outstanding. A request that sits here far beyond the norm
 * names the layer a stalled caller is blocked on (worker starvation, a lost
 * response, or a handler that never returns).
 */
export type PendingRequestDiagnostic = {
  msgId: number;
  type: RequestType;
  ageMs: number;
};

/** Terminal disposition of a request, including waits ended without a reply. */
export type RequestOutcome =
  | "success"
  | "error"
  | "cancelled"
  | "send-error";

/**
 * One entry of the bounded boot-window request timeline: when the request was
 * sent and when its wait ended, as offsets (ms) from the connection's
 * construction. Aggregate stats say a request was slow; this timeline says
 * WHEN it was slow and what else was in flight — the ordering evidence the
 * per-type histograms cannot carry. Only the first `REQUEST_TIMELINE_CAP`
 * requests are recorded, which covers a page boot.
 */
export type RequestTimelineEntry = {
  msgId: number;
  type: RequestType;
  sentAtMs: number;
  doneAtMs?: number;
  error?: boolean;
  outcome?: RequestOutcome;
};

const REQUEST_TIMELINE_CAP = 96;

// Sampling period for the event-loop lag probe. Each tick records how far
// beyond schedule the timer fired — a direct measure of how long this
// thread's event loop was unable to run macrotasks (long synchronous work,
// GC, or CPU starvation). The histogram lands in the same timing stats the
// load summaries read, so a wedged stretch shows up as a large `max`.
const LOOP_LAG_SAMPLE_MS = 100;

type SubscriptionCounterName =
  | "localSubscribes"
  | "localUnsubscribes"
  | "backendSubscribes"
  | "backendUnsubscribes";

type SubscriptionCounterTotals = Record<SubscriptionCounterName, number>;

export type CellSubscriptionDiagnostics = SubscriptionCounterTotals & {
  key: string;
  activeInstances: number;
};

export type SubscriptionDiagnostics = {
  totals: SubscriptionCounterTotals & { activeInstances: number };
  cells: Record<string, CellSubscriptionDiagnostics>;
};

export type RuntimeConnectionEvents = {
  console: [ConsoleMessage];
  navigaterequest: [NavigateRequestNotification];
  error: [ErrorNotification];
  spaceaccesslost: [SpaceAccessLostNotification];
  telemetry: [TelemetryNotification];
  vdombatch: [VDomBatchNotification];
  pendingwriteschange: [PendingWritesNotification];
  operationupdate: [OperationUpdateNotification];
  eventneedsattention: [EventNeedsAttentionNotification];
  eventintentoutcome: [EventIntentOutcomeNotification];
};

export interface InitializedRuntimeConnection extends RuntimeConnection {}

/**
 * A scoped VDOM capability obtained from `RuntimeConnection.attachVDom`. Holding
 * one means a teardown has been registered, so the consumer is guaranteed to be
 * torn down on disposal. The bare connection exposes no VDOM IPC directly, so a
 * consumer cannot acquire VDOM capability without registering how it stops.
 */
export interface VDomConnection {
  /** The connection's lifetime signal; aborts on disposal. */
  readonly signal: AbortSignal;

  mount(
    mountId: number,
    cellRef: CellRef,
  ): Promise<VDomMountResponse>;
  unmount(mountId: number): Promise<void>;
  sendEvent(
    mountId: number,
    handlerId: number,
    event: SerializedDomEvent,
    nodeId: number,
  ): void;
  ackBatch(mountId: number, batchId: number): void;
  onBatch(handler: (notification: VDomBatchNotification) => void): void;
  offBatch(handler: (notification: VDomBatchNotification) => void): void;

  /** Unregister the teardown — call when ending normally, not via disposal. */
  detach(): void;
}

export class RuntimeConnection extends EventEmitter<RuntimeConnectionEvents> {
  #pendingRequests = new Map<number, PendingRequest>();
  #nextMsgId = 0;
  #initialized = false;

  /**
   * The connection's lifetime. `dispose()` aborts it; every consumer registers
   * its teardown against this signal and every in-flight request settles
   * through it, so there is no disposed state to special-case beyond
   * `signal.aborted`.
   */
  #lifetime = new AbortController();

  #transport: RuntimeTransport;
  #subscribed = new Map<string, Set<CellHandle>>();
  #subscriptionDiagnostics = new Map<string, SubscriptionCounterTotals>();
  #constructedAt = performance.now();
  #requestTimeline: RequestTimelineEntry[] = [];
  #timelineByMsgId = new Map<number, RequestTimelineEntry>();
  #loopLagTimer: ReturnType<typeof setInterval> | undefined;

  constructor(transport: RuntimeTransport) {
    super();
    this.#transport = transport;
    this.#transport.on("message", this.#handleMessage);
    // Main-thread event-loop lag probe: records into the "runtime-client"
    // timing stats as `loop/mainLag`, next to the `ipc/*` round-trips it
    // contextualizes. A slow round-trip with a quiet mainLag histogram is
    // worker-side; a matching mainLag spike says this thread starved the
    // response handling itself.
    let expected = performance.now() + LOOP_LAG_SAMPLE_MS;
    // Unref'd so a connection constructed without a matching dispose() (unit
    // tests exercising notification handling, or an initialize that fails
    // before the client owns the connection) does not leak this interval or
    // trip Deno's op-leak sanitizer. In the browser it runs until dispose,
    // which clears it below.
    this.#loopLagTimer = unrefTimer(setInterval(() => {
      const now = performance.now();
      const lag = now - expected;
      if (lag > 0) ipcLogger.time(expected, now, "loop", "mainLag");
      expected = now + LOOP_LAG_SAMPLE_MS;
    }, LOOP_LAG_SAMPLE_MS));
    this.#lifetime.signal.addEventListener("abort", () => {
      if (this.#loopLagTimer !== undefined) {
        clearInterval(this.#loopLagTimer);
        this.#loopLagTimer = undefined;
      }
    }, { once: true });
  }

  /**
   * The connection's lifetime signal. It aborts when the connection is
   * disposed. Consumers observe it to stop work and to recognize that a
   * disposal-raced operation was cancelled rather than failed.
   */
  get signal(): AbortSignal {
    return this.#lifetime.signal;
  }

  /**
   * Register a teardown to run synchronously when the connection is disposed,
   * before the transport is torn down. If the connection is already disposed
   * the teardown runs immediately. Returns an unregister function so a consumer
   * that ends on its own detaches itself.
   */
  onDispose(teardown: () => void): () => void {
    const signal = this.#lifetime.signal;
    if (signal.aborted) {
      teardown();
      return () => {};
    }
    signal.addEventListener("abort", teardown, { once: true });
    return () => signal.removeEventListener("abort", teardown);
  }

  async initialize(
    data: InitializationData,
  ): Promise<InitializedRuntimeConnection> {
    await this.request<RequestType.Initialize>({
      type: RequestType.Initialize,
      data,
    });
    this.#initialized = true;
    return this as InitializedRuntimeConnection;
  }

  /**
   * Joins the runtime already running behind this transport, asserting the
   * security context it is believed to run under.
   *
   * @throws If the context holds key material, if the runtime refuses the
   *   assertion, or if no runtime is running behind the transport to join.
   */
  async attach(
    context: RuntimeSecurityContext,
  ): Promise<InitializedRuntimeConnection> {
    // The last thing before the frame reaches a transport, which is why the
    // invariant is enforced here and not only in `RuntimeClient.attach`: this
    // class is exported, so a caller can hold one directly, and a context
    // read through getters between that check and this send is not the one
    // that was checked. `key-material.ts` states what is being kept out and
    // why the platform is not left to decide it.
    assertNoKeyMaterial(context);
    await this.request<RequestType.Attach>({
      type: RequestType.Attach,
      data: context,
    });
    this.#initialized = true;
    return this as InitializedRuntimeConnection;
  }

  request<
    T extends keyof Commands,
  >(
    data: CommandRequest<T>,
  ): Promise<CommandResponse<T>> {
    // Initialize and Attach are the two requests that make a connection
    // usable, so each is the one thing an unusable connection may send.
    if (
      !this.#initialized && data.type !== RequestType.Initialize &&
      data.type !== RequestType.Attach
    ) {
      throw new Error("RuntimeConnection is uninitialized.");
    }
    const signal = this.#lifetime.signal;
    if (signal.aborted && data.type !== RequestType.Dispose) {
      // The connection is disposed; consumers should already be torn down, so
      // reaching here means a caller outlived its scope. Settle as cancellation
      // (the standard abort reason) rather than sending into a dead transport.
      return Promise.reject(signal.reason);
    }
    const msgId = this.#nextMsgId++;
    // `sentEpochMs` rides the envelope so the worker can compute delivery
    // delay across the thread boundary (performance.now() origins differ per
    // context; timeOrigin+now is comparable). Optional: older workers ignore
    // it, the guard tolerates extra fields.
    const message = {
      msgId,
      data,
      sentEpochMs: performance.timeOrigin + performance.now(),
    };

    const deferred = defer<CommandResponse<T>, Error>();

    const pending: PendingRequest<CommandResponse<T>> = {
      msgId,
      type: data.type,
      startTime: performance.now(),
      deferred,
    };

    // The Dispose request is the one operation that must outlive the abort, so
    // it is not cancelled by it. Every other in-flight request is settled as
    // cancellation when the connection is disposed.
    if (data.type !== RequestType.Dispose) {
      const onAbort = () => {
        this.#settle(msgId, "cancelled");
        deferred.reject(signal.reason);
      };
      pending.onAbort = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
    }

    this.#pendingRequests.set(msgId, pending as PendingRequest);
    if (this.#requestTimeline.length < REQUEST_TIMELINE_CAP) {
      const entry: RequestTimelineEntry = {
        msgId,
        type: data.type,
        sentAtMs: Math.round(pending.startTime - this.#constructedAt),
      };
      this.#requestTimeline.push(entry);
      this.#timelineByMsgId.set(msgId, entry);
    }
    if (DEBUG_IPC) {
      console.log(
        `[IPC(\x1B[1m${message.msgId}\x1B[0m)\x1B[96m=>\x1B[0m]`,
        message.data,
      );
    }
    // The bookkeeping above -- the abort hook and the pending entry -- is
    // registered on the promise below being returned to someone who will hold
    // it until a reply settles it. A synchronous throw from `send()` means no
    // reply is coming and the promise is never returned, so that bookkeeping
    // would outlive its only holder and reject it into nobody at disposal, as
    // an unhandled rejection. `send()` can throw two ways here -- the
    // envelope's encode refuses a value that has none, and `postMessage()`
    // refuses one structured cloning cannot carry -- and `T` is unconstrained,
    // so an ordinary bad value reaches both.
    //
    // `#settle()` clears both, and deliberately does not settle the deferred:
    // an unsettled promise nobody holds is collected, where a rejected one is
    // reported. The caller learns of the failure by the throw rather than
    // through the promise it never received.
    try {
      this.#transport.send(message);
    } catch (error) {
      this.#settle(msgId, "send-error");
      throw error;
    }

    return deferred.promise;
  }

  /**
   * Records a terminal wait and releases its abort listener. Returns the
   * entry so the caller can settle its deferred.
   */
  #settle(msgId: number, outcome: RequestOutcome): PendingRequest | undefined {
    const pending = this.#pendingRequests.get(msgId);
    if (!pending) return undefined;
    if (pending.onAbort) {
      this.#lifetime.signal.removeEventListener("abort", pending.onAbort);
    }
    this.#pendingRequests.delete(msgId);
    const now = performance.now();
    ipcLogger.time(pending.startTime, now, "ipc", pending.type);
    ipcLogger.time(
      pending.startTime,
      now,
      "ipc-outcome",
      outcome,
      pending.type,
    );
    const timeline = this.#timelineByMsgId.get(msgId);
    if (timeline) {
      timeline.doneAtMs = Math.round(now - this.#constructedAt);
      timeline.outcome = outcome;
      if (outcome !== "success") timeline.error = true;
      this.#timelineByMsgId.delete(msgId);
    }
    return pending;
  }

  async subscribe(
    cell: CellHandle<any>,
  ): Promise<void> {
    const key = cellRefToKey(cell.ref());
    let instances = this.#subscribed.get(key);
    if (instances) {
      if (!instances.has(cell)) {
        this.#recordSubscriptionDiagnostic(key, "localSubscribes");
        instances.add(cell);
        // Copy the cached value (and label) from an existing subscriber to the
        // new one so late subscribers get the initial value.
        const existingInstance = instances.values().next().value;
        if (existingInstance) {
          const cachedValue = existingInstance.get();
          if (cachedValue !== undefined) {
            cell[$onCellUpdate](cachedValue, {
              cfcLabel: existingInstance.cfcLabel,
            });
          }
        }
      }
      return;
    }
    this.#recordSubscriptionDiagnostic(key, "localSubscribes");
    instances = new Set([cell]);
    this.#subscribed.set(key, instances);
    this.#recordSubscriptionDiagnostic(key, "backendSubscribes");
    const _ = await this.request<RequestType.CellSubscribe>({
      type: RequestType.CellSubscribe,
      cell: cell.ref(),
      // First subscriber to a ref key decides label delivery for that backend
      // subscription (the worker dedups by ref key too). Label-displaying
      // callers create dedicated handles, so they are that first subscriber.
      ...(cell.wantsCfcLabel ? { includeCfcLabel: true } : {}),
    }).catch((error) => {
      if (!this.#lifetime.signal.aborted) {
        console.error("[RuntimeClient] Subscription failed:", error);
      }
      this.#subscribed.delete(key);
    });
    return;
  }

  async unsubscribe(
    cell: CellHandle<any>,
  ): Promise<void> {
    const key = cellRefToKey(cell.ref());
    const instances = this.#subscribed.get(key);
    if (!instances || !instances.has(cell)) {
      return;
    }
    this.#recordSubscriptionDiagnostic(key, "localUnsubscribes");
    instances.delete(cell);
    if (instances.size > 0) {
      return;
    }
    this.#subscribed.delete(key);
    // After disposal the worker tears down every subscription wholesale, so a
    // per-cell unsubscribe would be redundant.
    if (this.#lifetime.signal.aborted) return;
    this.#recordSubscriptionDiagnostic(key, "backendUnsubscribes");
    const _ = await this.request<RequestType.CellUnsubscribe>({
      type: RequestType.CellUnsubscribe,
      cell: cell.ref(),
    }).catch((error) => {
      if (!this.#lifetime.signal.aborted) {
        console.error("[RuntimeClient] Unsubscription failed:", error);
      }
    });
    return;
  }

  async dispose(): Promise<void> {
    if (this.#lifetime.signal.aborted) return;
    // Abort synchronously first. This runs every registered consumer teardown
    // (renderers detach listeners and drop DOM, subscriptions stop) and settles
    // every in-flight request as cancellation, so nothing issues or awaits a
    // request after this point — before the transport is touched.
    this.#lifetime.abort();

    // One coarse "dispose everything" message replaces per-consumer teardown
    // round-trips. The Dispose request is exempt from the abort above, so it
    // still reaches the worker, which flushes pending storage writes before
    // replying. We wait for that confirmation, so the flush is durable before
    // the transport is torn down. A worker that has not replied holds the
    // teardown here, and the transport stands until it does. That hold lasts
    // as long as the document does: a dedicated worker is terminated with the
    // document that owns it.
    await this.request<RequestType.Dispose>({ type: RequestType.Dispose })
      .catch(() => {
        // A worker-side error reply still lets teardown proceed.
      });
    await this.#transport.dispose();
  }

  async [Symbol.asyncDispose]() {
    await this.dispose();
  }

  /**
   * Snapshot of every request sent to the worker whose response has not yet
   * arrived and whose abort has not fired. Main-thread state only —
   * safe to call even when the worker is wedged, which is exactly when it is
   * most useful: a probe reading this from a stuck page sees which request
   * types are stalled and for how long.
   */
  getPendingRequestDiagnostics(): PendingRequestDiagnostic[] {
    const now = performance.now();
    return [...this.#pendingRequests.values()]
      .map((pending) => ({
        msgId: pending.msgId,
        type: pending.type,
        ageMs: Math.round(now - pending.startTime),
      }))
      .sort((a, b) => b.ageMs - a.ageMs);
  }

  /**
   * The bounded send/settle timeline of the first requests on this
   * connection (see RequestTimelineEntry). Entries without `doneAtMs` were
   * still pending when read; terminal entries include their outcome.
   */
  getRequestTimelineDiagnostics(): RequestTimelineEntry[] {
    // Copy so a caller cannot mutate the ledger, and late responses cannot
    // mutate what a caller already captured.
    return this.#requestTimeline.map((entry) => ({ ...entry }));
  }

  getSubscriptionDiagnostics(): SubscriptionDiagnostics {
    const keys = new Set<string>([
      ...this.#subscriptionDiagnostics.keys(),
      ...this.#subscribed.keys(),
    ]);
    const totals: SubscriptionDiagnostics["totals"] = {
      localSubscribes: 0,
      localUnsubscribes: 0,
      backendSubscribes: 0,
      backendUnsubscribes: 0,
      activeInstances: 0,
    };
    const cells: Record<string, CellSubscriptionDiagnostics> = {};

    for (const key of [...keys].sort()) {
      const counts = this.#subscriptionDiagnostics.get(key) ??
        this.#emptySubscriptionCounters();
      const activeInstances = this.#subscribed.get(key)?.size ?? 0;
      const entry: CellSubscriptionDiagnostics = {
        key,
        ...counts,
        activeInstances,
      };
      cells[key] = entry;
      totals.localSubscribes += entry.localSubscribes;
      totals.localUnsubscribes += entry.localUnsubscribes;
      totals.backendSubscribes += entry.backendSubscribes;
      totals.backendUnsubscribes += entry.backendUnsubscribes;
      totals.activeInstances += entry.activeInstances;
    }

    return { totals, cells };
  }

  resetSubscriptionDiagnostics(): void {
    this.#subscriptionDiagnostics.clear();
  }

  #handleMessage = (message: IPCRemoteMessage): void => {
    // Once dead (disposed), the connection ignores incoming messages without
    // warning: notifications are dropped here, stray/late messages are dropped
    // below. The one exception is a reply to a still-pending request — the
    // Dispose confirmation we are waiting on — which settles normally.
    const dead = this.#lifetime.signal.aborted;
    if (isIPCRemoteNotification(message)) {
      if (dead) return;
      if (isTelemetryNotification(message)) {
        this.emit("telemetry", message);
        // Do not log telemetry events when DEBUG_IPC is enabled
        return;
      }
      if (DEBUG_IPC) {
        console.log(`[IPC\x1B[92m<=\x1B[0m]`, message);
      }
      if (isCellUpdateNotification(message)) {
        this.#handleCellUpdate(message);
      } else if (isConsoleNotification(message)) {
        this.emit("console", message);
      } else if (isNavigateRequestNotification(message)) {
        this.emit("navigaterequest", message);
      } else if (isErrorNotification(message)) {
        this.emit("error", message);
      } else if (isEventIntentOutcomeNotification(message)) {
        this.emit("eventintentoutcome", message);
      } else if (isSpaceAccessLostNotification(message)) {
        this.emit("spaceaccesslost", message);
      } else if (isVDomBatchNotification(message)) {
        this.emit("vdombatch", message);
      } else if (isPendingWritesNotification(message)) {
        this.emit("pendingwriteschange", message);
      } else if (isOperationUpdateNotification(message)) {
        this.emit("operationupdate", message);
      } else if (isEventNeedsAttentionNotification(message)) {
        this.emit("eventneedsattention", message);
      } else {
        console.warn(
          debugStr`Unknown notification: $quote,long${message}`,
        );
      }
      return;
    }

    if (!isIPCRemoteResponse(message)) {
      if (!dead) console.warn("[RuntimeClient] Invalid response:", message);
      return;
    }
    const { msgId } = message;
    const pending = this.#settle(
      msgId,
      "error" in message && message.error ? "error" : "success",
    );
    if (!pending) {
      // A late response for a request we already settled. Expected after
      // disposal cancelled its in-flight requests; surprising otherwise.
      if (!dead) {
        console.warn(
          `[RuntimeClient] Response for unknown request: ${msgId}`,
        );
      }
      return;
    }

    if ("error" in message && message.error) {
      if (DEBUG_IPC) {
        console.log(
          `[IPC(\x1B[1m${msgId}\x1B[0m)\x1B[91m<=\x1B[0m]`,
          message.error,
        );
      }
      const error = new Error(message.error) as Error & { code?: string };
      if (message.code) {
        error.code = message.code;
        // A coded request failure is also a host-level lifecycle signal. The
        // caller still receives the rejected request, while RuntimeInternals
        // can replace a worker whose module map cannot recover in place.
        this.emit("error", {
          type: NotificationType.ErrorReport,
          message: message.error,
          code: message.code,
        });
      }
      pending.deferred.reject(error);
    } else {
      const data = "data" in message ? message.data : undefined;
      if (DEBUG_IPC) {
        console.log(
          `[IPC(\x1B[1m${msgId}\x1B[0m)\x1B[92m<=\x1B[0m]`,
          data,
        );
      }
      pending.deferred.resolve(data);
    }
  };

  #handleCellUpdate(message: CellUpdateNotification): void {
    const { cell: cellRef, value } = message;
    if (value === undefined) {
      // A value can be reported as `undefined` only when there's been a
      // conflict, and will be followed by the settled value. Ignore
      // `undefined` callbacks here.
      return;
    }

    // Field presence (not value) signals a label-aware notification, so a
    // label of `undefined` is still delivered and a value-only update never
    // touches the cached label.
    const labelUpdate = "cfcLabel" in message
      ? { cfcLabel: message.cfcLabel }
      : undefined;

    const subscribed = this.#subscribed.get(cellRefToKey(cellRef));
    if (subscribed && subscribed.size > 0) {
      for (const instance of subscribed) {
        instance[$onCellUpdate](value, labelUpdate);
      }
    }
  }

  #recordSubscriptionDiagnostic(
    key: string,
    counter: SubscriptionCounterName,
  ): void {
    const counts = this.#subscriptionDiagnostics.get(key) ??
      this.#emptySubscriptionCounters();
    counts[counter]++;
    this.#subscriptionDiagnostics.set(key, counts);
  }

  #emptySubscriptionCounters(): SubscriptionCounterTotals {
    return {
      localSubscribes: 0,
      localUnsubscribes: 0,
      backendSubscribes: 0,
      backendUnsubscribes: 0,
    };
  }

  /**
   * Send a one-way notification to the worker. Unlike `request`, this carries
   * no msgId, registers no pending entry, and the worker sends no response.
   *
   * Notifications come only from owned consumers (the renderer), which are torn
   * down synchronously on disposal — their listeners are detached before the
   * transport goes away. So unlike `request` (whose unowned one-shot callers can
   * legitimately race disposal and are tolerated), a notification after disposal
   * means a sender outlived its teardown. That is a contract violation, thrown
   * loudly rather than silently dropped.
   */
  #notify(notification: IPCClientNotification): void {
    if (this.#lifetime.signal.aborted) {
      throw new Error(
        `RuntimeConnection: ${notification.type} sent after disposal`,
      );
    }
    if (DEBUG_IPC) {
      console.log(`[IPC\x1B[96m=>\x1B[0m]`, notification);
    }
    this.#transport.send(notification);
  }

  /**
   * Attach a VDOM consumer (the renderer). The teardown is a required argument:
   * it runs synchronously when the connection is disposed, so a consumer cannot
   * hold VDOM capability without also declaring how it is torn down. All VDOM
   * IPC — mounting, events, acks, and the batch subscription — is reachable only
   * through the returned session, never the bare connection. That is what lets
   * #notify assert: every sender is, by construction, registered for teardown.
   */
  attachVDom(onDispose: () => void): VDomConnection {
    const unregister = this.onDispose(onDispose);
    const signal = this.#lifetime.signal;
    return {
      signal,
      mount: (mountId, cellRef) => this.#mountVDom(mountId, cellRef),
      unmount: (mountId) => this.#unmountVDom(mountId),
      sendEvent: (mountId, handlerId, event, nodeId) =>
        this.#notify({
          type: ClientNotificationType.VDomEvent,
          mountId,
          handlerId,
          event,
          nodeId,
        }),
      ackBatch: (mountId, batchId) =>
        this.#notify({
          type: ClientNotificationType.VDomBatchApplied,
          mountId,
          batchId,
        }),
      onBatch: (handler) => {
        this.on("vdombatch", handler);
      },
      offBatch: (handler) => {
        this.off("vdombatch", handler);
      },
      detach: unregister,
    };
  }

  async #mountVDom(
    mountId: number,
    cellRef: CellRef,
  ): Promise<VDomMountResponse> {
    try {
      const response = await this.request<RequestType.VDomMount>({
        type: RequestType.VDomMount,
        mountId,
        cell: cellRef,
      });
      return response!;
    } catch (error) {
      // Registration can remain pending in the worker after this request
      // fails. Cancel by its original id before the renderer drops that id.
      void this.#unmountVDom(mountId).catch((cleanupError) => {
        if (!this.#lifetime.signal.aborted) {
          console.error("[RuntimeClient] Mount cleanup failed:", cleanupError);
        }
      });
      throw error;
    }
  }

  async #unmountVDom(mountId: number): Promise<void> {
    // After disposal the worker tears down every mount wholesale, so a
    // per-mount unmount would be redundant.
    if (this.#lifetime.signal.aborted) return;
    await this.request<RequestType.VDomUnmount>({
      type: RequestType.VDomUnmount,
      mountId,
    });
  }
}
