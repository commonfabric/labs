import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";

import {
  type ErrorNotification,
  type IPCClientMessage,
  type IPCClientNotification,
  type IPCRemoteMessage,
  type IPCRemotePost,
  NotificationType,
} from "@/protocol/mod.ts";
import { EventEmitter } from "@/client/emitter.ts";
import {
  RuntimeTransport,
  RuntimeTransportEvents,
} from "@/client/transport.ts";
import type { MessagePortLike } from "@/shared/message-port-like.ts";
import { describeFailure } from "@/shared/utils.ts";

export interface MessagePortRuntimeTransportOptions {
  /** The duplex the worker is reached over. */
  port: MessagePortLike;
}

/**
 * A connection to a runtime already running in someone else's worker, reached
 * over a port that worker has been handed.
 *
 * The difference from the dedicated-worker transport is what it does not do.
 * It spawns nothing, so there is no worker URL and no readiness to wait for:
 * the far end is a runtime already serving another document, and a port only
 * exists because that document's page handed one over. Nor does it terminate
 * anything on disposal -- it drops its own end of the channel, and the runtime
 * outlives it.
 */
export class MessagePortRuntimeTransport
  extends EventEmitter<RuntimeTransportEvents>
  implements RuntimeTransport {
  #disposed = false;
  readonly #port: MessagePortLike;

  constructor(options: MessagePortRuntimeTransportOptions) {
    super();
    this.#port = options.port;
    this.#port.addEventListener("message", this.#handleMessage);
    // A port queues what is sent to it until it is started, so the listener
    // above is in place before the first message can be delivered.
    this.#port.start?.();
  }

  /** @inheritDoc */
  send(data: IPCClientMessage | IPCClientNotification): void {
    // Encoded exactly as the dedicated-worker transport encodes it, that
    // being what the worker's message loop decodes. The narrowing the encoding
    // imposes on the value model is stated there.
    this.#port.postMessage(realmFromFabricValue(data));
  }

  /** @inheritDoc */
  dispose(): Promise<void> {
    this.#disposed = true;
    this.removeAllListeners();
    this.#port.close?.();
    return Promise.resolve();
  }

  async [Symbol.asyncDispose]() {
    await this.dispose();
  }

  /**
   * Handles one message from the worker. What a decode returns is deep-frozen,
   * so a consumer of a response or a notification reads it rather than
   * reshaping it in place.
   */
  #handleMessage = (event: MessageEvent): void => {
    if (this.#disposed) return;

    let data: IPCRemotePost;

    try {
      data = fabricFromRealmValue(event.data) as IPCRemotePost;
    } catch (error) {
      // Defense in depth. Everything the worker posts is the result of a
      // successful encode, so nothing undecodable should arrive. When one
      // does, losing the message loudly beats an exception leaving this
      // listener, which would take the connection's whole dispatch with it.
      this.emit("message", {
        type: NotificationType.ErrorReport,
        message: `Undecodable message from the worker: ${
          describeFailure(error)
        }`,
      } as ErrorNotification);
      return;
    }

    this.emit("message", data as IPCRemoteMessage);
  };
}
