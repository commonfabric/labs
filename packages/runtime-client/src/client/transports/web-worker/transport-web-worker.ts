import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { defer } from "@commonfabric/utils/defer";
import { isDeno } from "@commonfabric/utils/env";
import { terminateWorker } from "@commonfabric/utils/worker-lifetime";
import {
  ClientTransportNotificationType,
  ErrorNotification,
  IPCClientMessage,
  IPCClientNotification,
  IPCRemoteMessage,
  IPCRemotePost,
  isWorkerConsoleNotification,
  isWorkerReadyNotification,
  NotificationType,
} from "@/protocol/mod.ts";
import {
  RuntimeTransport,
  RuntimeTransportEvents,
} from "@/client/transport.ts";
import { EventEmitter } from "@/client/emitter.ts";
import { describeFailure } from "@/shared/utils.ts";

export interface WebWorkerRuntimeTransportOptions {
  // URL to hosted `backends/web-worker/index.ts`
  workerUrl?: URL;
}

export class WebWorkerRuntimeTransport
  extends EventEmitter<RuntimeTransportEvents>
  implements RuntimeTransport {
  #ready = false;
  #readyPromise = defer<void>();
  #lifetimeLock: string | undefined;
  #worker: Worker;
  constructor(options: WebWorkerRuntimeTransportOptions = {}) {
    super();
    const workerUrl = options.workerUrl ??
      (isDeno()
        ? new URL("../../../backends/web-worker/index.ts", import.meta.url)
        : undefined);
    if (!workerUrl) {
      throw new Error(
        "RuntimeClient `workerUrl` must be explicitly defined in non-Deno environments.",
      );
    }
    this.#worker = new Worker(
      workerUrl,
      {
        type: "module",
        name: "runtime-worker",
      },
    );
    this.#worker.addEventListener("message", this.#handleMessage);
    this.#worker.addEventListener("error", this.#handleError);
  }

  /**
   * The worker message handler, which a test drives directly to deliver a
   * message by hand.
   */
  get accessForTestingOnly(): {
    readonly handleMessage: (event: MessageEvent) => void;
  } {
    return { handleMessage: this.#handleMessage };
  }

  /** @inheritDoc */
  send(data: IPCClientMessage | IPCClientNotification): void {
    // The encoding is a tree walk and what it produces is a tree, which is
    // narrower than the value model in two ways worth knowing. A cycle is
    // refused outright. A subtree that needs encoding and is reachable by two
    // paths arrives as two values rather than as one reached twice; a subtree
    // that needs no encoding keeps its sharing.
    //
    // The walks that feed the common paths already rewrite both, so neither
    // reaches here from them: `convertCellsToLinks()` turns a cycle into a
    // back-link before a prop arrives, and `CellHandle.serialize()` rebuilds a
    // record rather than aliasing it. What is exposed is a value handed to the
    // connection without passing through one of those, of which
    // `PieceCreateRequest.argument` is the field to know about.
    this.#worker.postMessage(realmFromFabricValue(data));
  }

  /**
   * Hands the worker a duplex for a further document to reach the runtime
   * over, and gives up this page's end of it.
   *
   * Only the page holding this transport can do so: it spawned the worker, and
   * who else may speak to the runtime is its decision. What the far end of
   * `port` does next is send an `Attach` asserting the security context it
   * believes the runtime runs under, which the runtime refuses if it is not
   * its own.
   *
   * The port travels the transfer list rather than the message beside it -- a
   * port is no `FabricValue` and has no encoding -- and is neutered here by
   * the transfer, so this page cannot go on speaking over it.
   */
  attachClientPort(port: MessagePort): void {
    this.#worker.postMessage(
      realmFromFabricValue({
        type: ClientTransportNotificationType.AttachPort,
      }),
      [port],
    );
  }

  /**
   * Terminates the worker, and settles once its runtime has been torn down,
   * as `terminateWorker()` from `@commonfabric/utils/worker-lifetime` does. A
   * worker that never reported ready, or whose ready notification named no
   * lock, is not waited for.
   */
  async dispose(): Promise<void> {
    this.removeAllListeners();
    await terminateWorker(this.#worker, this.#lifetimeLock);
  }

  async [Symbol.asyncDispose]() {
    await this.dispose();
  }

  ready(): Promise<void> {
    return this.#readyPromise.promise;
  }

  /**
   * Constructs a transport, and resolves it once its worker reports ready.
   *
   * @throws If readiness fails. The transport is disposed of before the throw,
   *   so no worker is left running.
   */
  static async connect(
    options: WebWorkerRuntimeTransportOptions = {},
  ): Promise<WebWorkerRuntimeTransport> {
    const transport = new WebWorkerRuntimeTransport(options);

    try {
      await transport.ready();
    } catch (error) {
      // The caller never receives a transport on this path, so the disposal is
      // this method's to do -- `terminate()` lives only in `dispose()`, and
      // nothing else is left holding the worker. Both ways readiness can fail
      // land here: a worker error before ready, and a message the decode
      // refuses before ready.
      await transport.dispose();
      throw error;
    }

    return transport;
  }

  /**
   * Handles one message from the worker. What a decode returns is deep-frozen,
   * so a consumer of a response or a notification reads it rather than
   * reshaping it in place.
   */
  #handleMessage = (event: MessageEvent): void => {
    let data: IPCRemotePost;

    try {
      data = fabricFromRealmValue(event.data) as IPCRemotePost;
    } catch (error) {
      // Defense in depth. Everything the worker posts is the result of a
      // successful encode -- `postToClient()` substitutes a strings-only
      // stand-in for a message the encoding refused, rather than posting the
      // refusal -- so nothing undecodable should arrive. That is the ideal,
      // and it may not always hold. When it does not, losing one message
      // loudly beats an exception leaving this listener, which would take the
      // connection's whole dispatch with it.
      //
      // Before the worker has reported ready, though, there is no dispatch to
      // protect and no one listening for the report: what a failure costs
      // there is `ready()` never settling, and a caller waiting on a promise
      // that will not resolve has no way back. So the failure lands where
      // `#handleError()` puts a pre-ready one, on the promise itself.
      if (!this.#ready) {
        this.#readyPromise.reject(
          new Error(
            `Undecodable message from the worker: ${describeFailure(error)}`,
          ),
        );
        return;
      }

      this.emit("message", {
        type: NotificationType.ErrorReport,
        message: `Undecodable message from the worker: ${
          describeFailure(error)
        }`,
      } as ErrorNotification);
      return;
    }

    // Worker-side console output forwarded by the bridge in
    // `backends/web-worker/index.ts` (opt-in). Re-emit it on the page
    // console so it reaches devtools and integration-test console capture,
    // then stop: it is this transport's traffic, not the connection's.
    if (isWorkerConsoleNotification(data)) {
      console[data.level](`[worker] ${data.text}`);
      return;
    }

    if (!this.#ready && isWorkerReadyNotification(data)) {
      this.#ready = true;
      this.#lifetimeLock = data.lifetimeLock;
      this.#readyPromise.resolve();
      return;
    }

    // The two above are this transport's own traffic and have returned, so
    // what is left is the connection's.
    this.emit("message", data as IPCRemoteMessage);
  };

  /**
   * Handles a worker error: before the worker is ready it fails the ready
   * promise, and after that it is emitted as an error notification.
   */
  #handleError = (event: ErrorEvent): void => {
    event.preventDefault();

    const error = new Error(
      typeof event.error?.message === "string"
        ? event.error.message
        : event.message || "Web worker failed before initialization",
    );
    if (typeof event.error?.name === "string") {
      error.name = event.error.name;
    }
    if (typeof event.error?.stack === "string") {
      error.stack = event.error.stack;
    }

    if (!this.#ready) {
      this.#readyPromise.reject(error);
      return;
    }

    this.emit("message", {
      type: NotificationType.ErrorReport,
      message: `${error}`,
      stackTrace: error.stack,
    } as ErrorNotification);
  };
}
