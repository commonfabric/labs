/**
 * The clients of one worker's runtime, and the message loop each of them is
 * served by.
 *
 * A worker runs exactly one runtime. The first client to arrive stands it up;
 * every later client attaches to the one already running, over a duplex of its
 * own. What a client owns is namespaced by the client -- its subscriptions,
 * its mounts, what its departure takes down -- and what governs it is not: the
 * runtime's security context is settled at initialization, and an attach
 * asserting a different one is refused rather than merged.
 *
 * How a duplex reaches this worker is deliberately not this module's business.
 * {@link RuntimeClients.attach} takes anything shaped like a `MessagePort`, so
 * a port carried by a page's opener, one relayed by a native shell, and one a
 * test builds from a `MessageChannel` are the same thing here.
 */

import { debugStr } from "@commonfabric/data-model";
import { fabricFromRealmValue } from "@commonfabric/data-model/codecs";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { isDID } from "@commonfabric/identity";
import { CompilerStackLoadError } from "@commonfabric/runner";
import {
  type InitializationData,
  type IPCClientMessage,
  type IPCRemotePost,
  type IPCRemoteResponse,
  isAttachPortNotification,
  isIPCClientMessage,
  isIPCClientNotification,
  NotificationType,
  RequestType,
  RuntimeErrorCode,
} from "@/protocol/mod.ts";
import { RuntimeProcessor } from "@/backends/mod.ts";
import { assertNoKeyMaterial } from "@/shared/key-material.ts";
import type { MessagePortLike } from "@/shared/message-port-like.ts";
import { describeFailure } from "@/shared/utils.ts";
import { postThrough } from "./post-to-client.ts";
import {
  type ClientId,
  OWNER_CLIENT_ID,
  ownerClient,
  type WorkerClient,
} from "./worker-client.ts";

// Count-only ledger of request traffic as seen by the worker: one
// `received/<type>` per request that reached this message handler and one
// `responded/<type>` (or `responded-error/<type>`) per reply posted back.
// Counts increment even while the logger is disabled and the lazy args are
// never evaluated, so this costs ~nothing per request. Read back through
// `getLoggerCounts()`, and paired with the main thread's pending-request
// table it classifies a stuck request: absent from `received` means delivery
// starved; received without a matching `responded` means the handler never
// returned; both present means the response was lost in transit.
const ipcLogger = getLogger("runtime-worker.ipc", { enabled: false });

// Worker-side request decomposition, recorded into timing stats (they record
// even while the logger is disabled) under a `runner.`-prefixed logger so the
// integration-test load summaries pick them up:
//   runner.ipc/delivery/<type> — postMessage send → this handler running,
//     i.e. how long the request sat in the worker's macrotask queue. Uses the
//     envelope's `sentEpochMs` (timeOrigin-based, comparable across threads).
//   runner.ipc/handle/<type>   — handleRequest start → settled.
// A slow client round-trip decomposes as delivery (worker starved) vs handle
// (handler awaited something slow) vs the residue (response return path).
const ipcTimingLogger = getLogger("runner.ipc", { enabled: false });

export interface RuntimeClientsOptions {
  /**
   * Turns the worker's console forwarding on and off. It patches the worker's
   * own `console`, which is the worker entry's to own, so it arrives from
   * there rather than being done here.
   */
  setConsoleBridge: (enabled: boolean) => void;

  /**
   * The client that owns the worker. Defaults to the one speaking over the
   * worker's own global, which is what a real worker has.
   */
  owner?: WorkerClient;

  /**
   * Stands the runtime up. Resolved at call time rather than captured, so a
   * caller substituting {@link RuntimeProcessor.initialize} still reaches its
   * substitute.
   */
  initializeRuntime?: (
    data: InitializationData,
    clients: () => Iterable<WorkerClient>,
  ) => Promise<RuntimeProcessor>;
}

/** One connected client, its channel, and whether its attach is settled. */
type RegisteredClient = {
  client: WorkerClient;
  duplex: MessagePortLike;
  listener: (event: MessageEvent) => void;
  attached: boolean;
};

export class RuntimeClients {
  #runtime: RuntimeProcessor | undefined;
  #initialization: Promise<RuntimeProcessor> | undefined;
  #attachedClients = new Map<ClientId, RegisteredClient>();
  #nextClientId: ClientId = OWNER_CLIENT_ID + 1;

  readonly #owner: WorkerClient;
  readonly #setConsoleBridge: (enabled: boolean) => void;
  readonly #initializeRuntime: (
    data: InitializationData,
    clients: () => Iterable<WorkerClient>,
  ) => Promise<RuntimeProcessor>;

  constructor(options: RuntimeClientsOptions) {
    this.#owner = options.owner ?? ownerClient;
    this.#setConsoleBridge = options.setConsoleBridge;
    this.#initializeRuntime = options.initializeRuntime ??
      ((data, clients) => RuntimeProcessor.initialize(data, clients));
  }

  /** The client that owns the worker and initializes its runtime. */
  get owner(): WorkerClient {
    return this.#owner;
  }

  /**
   * Serves a further client over `duplex`, returning the client it becomes.
   * The client is registered but not yet attached: until its
   * {@link RequestType.Attach} is accepted it may ask for nothing else.
   */
  attach(duplex: MessagePortLike): WorkerClient {
    const id = this.#nextClientId++;
    const client: WorkerClient = {
      id,
      post: (message) =>
        postThrough((encoded) => duplex.postMessage(encoded), message),
    };
    const listener = (event: MessageEvent) => {
      void this.handleMessage(client, event);
    };
    this.#attachedClients.set(id, {
      client,
      duplex,
      listener,
      attached: false,
    });
    duplex.addEventListener("message", listener);
    duplex.start?.();
    return client;
  }

  /** How many clients this worker is serving besides its owner. */
  get attachedClientCount(): number {
    return this.#attachedClients.size;
  }

  /**
   * Forgets a client and lets go of its channel.
   *
   * Both ways a client ends here -- refused, or departed -- end the same way,
   * and both have to end: a page that reloads into a refusal would otherwise
   * leave a listener and a registration behind on every attempt, and a worker
   * that outlives many panes would accumulate one per pane. A retry mints a
   * fresh client through the owner, so nothing is lost by letting this one go.
   */
  #drop(id: ClientId): void {
    const registered = this.#attachedClients.get(id);
    if (!registered) return;
    this.#attachedClients.delete(id);
    registered.duplex.removeEventListener?.("message", registered.listener);
    registered.duplex.close?.();
  }

  /**
   * Handles one message that arrived on `client`'s duplex.
   *
   * Every failure below reports or replies rather than throwing: this runs
   * from a listener, where a throw surfaces as an unhandled rejection and
   * takes the worker's dispatch with it.
   */
  async handleMessage(
    client: WorkerClient,
    event: MessageEvent,
  ): Promise<void> {
    // Decoded whole, so what arrives is what was sent rather than whatever
    // structured cloning preserved of it. The encoding end is
    // `WebWorkerRuntimeTransport.send()`.
    //
    // What a decode returns is deep-frozen, so a handler owns what its request
    // carries and may cede it, but does not edit it -- which is what
    // `BaseRequest` states as one contract.
    //
    // Typed as a request rather than as the `FabricValue` a decode returns:
    // the guards below are what actually vet it, and every use here is behind
    // one of them or inside the `catch`, which wants the id of whatever
    // failed.
    let message: IPCClientMessage;

    try {
      message = fabricFromRealmValue(event.data) as IPCClientMessage;
    } catch (error) {
      // Defense in depth, as at the other end. Nothing undecodable should
      // reach here, and if something does there is no `msgId` to answer under
      // -- so this reports rather than replies, and the request it belonged to
      // is left to time out.
      client.post({
        type: NotificationType.ErrorReport,
        message: `Undecodable message from the client: ${
          describeFailure(error)
        }`,
      });
      return;
    }

    // A port handed over for a further client. It is the channel's own
    // traffic: the port rides the transfer list rather than the message, so it
    // is recognized before anything looks at the runtime.
    if (isAttachPortNotification(message)) {
      this.#handleAttachPort(client, event);
      return;
    }

    // One-way notifications carry no msgId and get no response. Drop them once
    // the worker is gone or disposed; in teardown the main thread may still be
    // flushing fire-and-forget signals. Dropped too from a client whose attach
    // is not settled -- a notification cannot be refused, so the only refusal
    // available is not to act on it.
    if (isIPCClientNotification(message)) {
      try {
        if (
          this.#isSpeaking(client) && this.#runtime &&
          !this.#runtime.isDisposed()
        ) {
          this.#runtime.handleNotification(message, client);
        }
      } catch (error) {
        console.error("[RuntimeWorker] Notification error:", error);
      }
      return;
    }

    try {
      if (!isIPCClientMessage(message)) {
        // Rendered by `value-debug` rather than `JSON.stringify`, which is
        // wrong for exactly what the decode above admits: it throws on a
        // `bigint` anywhere in the tree -- replacing this report with one that
        // names nothing -- and renders a `FabricPrimitive` as `{}`.
        throw new Error(
          debugStr`Invalid IPC request: $quote,long${message}`,
        );
      }
      const { msgId, data: request } = message;
      ipcLogger.debug(`received/${request.type}`, () => []);
      const receivedAt = performance.now();
      const sentEpochMs = (message as { sentEpochMs?: number }).sentEpochMs;
      if (typeof sentEpochMs === "number") {
        const deliveryMs = performance.timeOrigin + receivedAt - sentEpochMs;
        if (deliveryMs > 0) {
          ipcTimingLogger.time(
            receivedAt - deliveryMs,
            receivedAt,
            "delivery",
            request.type,
          );
        }
      }

      if (request.type === RequestType.Initialize) {
        if (client.id !== this.#owner.id) {
          throw new Error(
            "Only the client that owns the worker may initialize its runtime.",
          );
        }
        if (this.#initialization) {
          throw new Error("Initialization of WorkerRuntime already attempted.");
        }
        this.#setConsoleBridge(request.data.forwardWorkerConsole === true);
        this.#initialization = this.#initializeRuntime(request.data, () => [
          this.#owner,
          ...[...this.#attachedClients.values()]
            .filter(({ attached }) => attached)
            .map(({ client }) => client),
        ]);
        this.#runtime = await this.#initialization;
        this.#reply({ msgId: message.msgId }, request.type, client);
        return;
      }

      if (request.type === RequestType.Attach) {
        if (client.id === this.#owner.id) {
          throw new Error(
            "The client that owns the worker initializes its runtime rather " +
              "than attaching to it.",
          );
        }
        // A page may transfer a port and let the document at its far end
        // attach while the runtime is still standing up, so an attach waits
        // for an initialization already under way rather than reading the
        // runtime that is not there yet. A failed initialization settles this
        // and leaves no runtime, which the check below then refuses -- the
        // wait cannot turn a failure into an attach.
        if (this.#initialization) {
          await this.#initialization.catch(() => undefined);
        }
        // An attach joins a runtime; it never stands one up. Answered with
        // the same words an ordinary request gets before initialization,
        // because it is the same fact about the worker.
        if (!this.#runtime) {
          throw new Error("WorkerRuntime not initialized.");
        }
        // A disposed runtime is the one thing worse than no runtime: a client
        // that joined one would hold a live-looking connection to something
        // that answers nothing, and learn of it only by waiting forever.
        if (this.#runtime.isDisposed()) {
          throw new Error(
            "WorkerRuntime has been disposed; there is no runtime to attach " +
              "to.",
          );
        }
        assertNoKeyMaterial(request.data);
        // The acting principal is stated, never supplied. A frame naming it
        // as anything but a DID is either carrying a signer past the check
        // above or is not the frame it claims to be; both are refused here
        // rather than reaching a comparison that would simply find them
        // unequal and say something less useful.
        if (!isDID(request.data.identity)) {
          throw new Error(
            "Attach refused: the acting principal must be a DID, which is " +
              "stated rather than supplied.",
          );
        }
        this.#runtime.assertAttachable(request.data);
        const registered = this.#attachedClients.get(client.id);
        if (registered) registered.attached = true;
        this.#reply({ msgId }, request.type, client);
        return;
      }

      // A client that has departed is gone rather than wrong. Its channel is
      // dropped on the way out, so this is reached only by a message already
      // in flight -- and the owner's own post-disposal stragglers are acked
      // in silence, which is what this is.
      if (
        client.id !== this.#owner.id && !this.#attachedClients.has(client.id)
      ) {
        this.#reply({ msgId }, request.type, client);
        return;
      }

      // Toggling console forwarding is handled here, not in the
      // RuntimeProcessor, because the console patch lives in the worker entry.
      // It is independent of runtime initialization, so it is answered before
      // the init check. The owner's alone: what the bridge forwards goes to
      // the worker's own global, which is the owner's end of the IPC.
      if (request.type === RequestType.SetForwardWorkerConsole) {
        if (client.id !== this.#owner.id) {
          throw new Error(
            "Only the client that owns the worker may forward its console.",
          );
        }
        this.#setConsoleBridge(request.enabled);
        this.#reply({ msgId }, request.type, client);
        return;
      }

      if (!this.#isSpeaking(client)) {
        throw new Error("Client is not attached to the WorkerRuntime.");
      }

      if (!this.#runtime) {
        throw new Error("WorkerRuntime not initialized.");
      }
      const runtime = this.#runtime;
      if (runtime.isDisposed()) {
        // After disposal, silently ack any late-arriving requests.
        // Components may still be unsubscribing or finishing in-flight
        // operations during teardown — no point erroring on these.
        this.#reply({ msgId }, request.type, client);
        return;
      }

      // A `Dispose` from an attached client is that client leaving, not the
      // runtime ending: the runtime belongs to the worker, and the worker to
      // the owner. Only the owner's `Dispose` reaches the runtime's own.
      if (
        request.type === RequestType.Dispose && client.id !== this.#owner.id
      ) {
        runtime.disposeClient(client);
        this.#reply({ msgId }, request.type, client);
        this.#drop(client.id);
        return;
      }

      const handleStart = performance.now();
      let response;
      try {
        response = await runtime.handleRequest(request, client);
      } finally {
        // Record handling latency whether or not the request threw, so
        // error-heavy periods do not silently underreport it.
        ipcTimingLogger.time(handleStart, "handle", request.type);
      }
      const payload: IPCRemoteResponse = response !== undefined
        ? { msgId, data: response }
        : { msgId };
      this.#reply(payload, request.type, client);
    } catch (error) {
      console.error("[RuntimeWorker] Error:", error);
      const type = isIPCClientMessage(message) ? message.data.type : "invalid";
      ipcLogger.debug(`responded-error/${type}`, () => []);
      const code = error instanceof CompilerStackLoadError
        ? RuntimeErrorCode.CompilerStackLoadFailed
        : undefined;

      // A reply is addressed by `msgId`, and what reaches here need not have
      // one: the decode above admits every `FabricValue`, `undefined` and a
      // `bigint` among them, and `Invalid IPC request` is thrown precisely for
      // what is no message at all. Reading `msgId` off that would throw from
      // inside this `catch`, which is the one place a throw has nowhere to go
      // -- out of an async listener it surfaces as an unhandled rejection,
      // taking with it the report it was in the middle of making.
      const msgId = isObjectNotArray(message) &&
          typeof message.msgId === "number"
        ? message.msgId
        : undefined;
      if (msgId === undefined) {
        client.post({
          type: NotificationType.ErrorReport,
          message: `Malformed message from the client: ${
            describeFailure(error)
          }`,
        });
        return;
      }

      client.post({
        msgId,
        error: describeFailure(error),
        ...(code ? { code } : {}),
      });

      // A refused attach is terminal for this client: the reply has gone, and
      // what is let go of here is the registration and the channel. See
      // `#drop`.
      if (type === RequestType.Attach && client.id !== this.#owner.id) {
        this.#drop(client.id);
      }
    }
  }

  /**
   * May `client` ask the runtime for anything? The owner always may. A client
   * that arrived over a port may once its attach has been accepted, and not
   * before: until then the runtime has not agreed that this client is one of
   * its own.
   */
  #isSpeaking(client: WorkerClient): boolean {
    if (client.id === this.#owner.id) return true;
    return this.#attachedClients.get(client.id)?.attached === true;
  }

  /**
   * Takes the port transferred alongside an attach-port message and serves a
   * further client over it.
   *
   * Only the owner may hand one over. A client that arrived over a port does
   * not get to enlarge the family it joined -- the worker belongs to the page
   * that spawned it, and who else may speak to the runtime is that page's
   * decision.
   */
  #handleAttachPort(client: WorkerClient, event: MessageEvent): void {
    if (client.id !== this.#owner.id) {
      client.post({
        type: NotificationType.ErrorReport,
        message:
          "Only the client that owns the worker may hand it a client port.",
      });
      return;
    }
    const port = event.ports?.[0];
    if (!port) {
      client.post({
        type: NotificationType.ErrorReport,
        message: "An attach-port message arrived with no port to attach.",
      });
      return;
    }
    this.attach(port);
  }

  /**
   * Posts one reply and records it in the ledger by what actually went. An
   * encoding failure substitutes an error reply, and counting that as a
   * response would say the request succeeded.
   */
  #reply(
    payload: IPCRemoteResponse,
    type: RequestType,
    client: WorkerClient,
  ): void {
    const delivered = client.post(payload as IPCRemotePost);
    ipcLogger.debug(
      `${delivered ? "responded" : "responded-error"}/${type}`,
      () => [],
    );
  }
}
