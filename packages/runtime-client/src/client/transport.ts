import { EventEmitter } from "./emitter.ts";
import {
  type ErrorReport,
  IPCClientMessage,
  IPCClientNotification,
  IPCRemoteMessage,
} from "@/protocol/mod.ts";

/**
 * What a transport hands the connection: what the worker posted, or a report
 * of the transport's own failure, which no worker made and so no host-read
 * gate decided, in the host-side shape `ErrorReport`.
 */
export type RuntimeTransportEvents = {
  message: [IPCRemoteMessage | ErrorReport];
};

export interface RuntimeTransport extends EventEmitter<RuntimeTransportEvents> {
  /**
   * Delivers a message to the far end, which must receive it as a value it
   * owns outright -- unshared with the sender, and not becoming shared
   * afterwards. `BaseRequest` states what a handler is then entitled to assume.
   *
   * Structured cloning satisfies this, so a `postMessage` transport gets it for
   * nothing. A transport that would instead hand the same object to both ends
   * does not, and cannot be used as-is.
   *
   * What the far end receives is also frozen, the message reaching it through
   * a decode. Unsharedness is this method's requirement; immutability is the
   * decode's, and `BaseRequest` states both as one contract.
   */
  send(data: IPCClientMessage | IPCClientNotification): void;

  /**
   * Closes the transport and releases whatever it holds open. Settles once
   * the far end is gone, so a caller may stand a replacement up after
   * awaiting it. Messages sent afterwards are not delivered.
   */
  dispose(): Promise<void>;
}
