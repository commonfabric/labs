/**
 * A client transport onto an in-process server that records what the client
 * sent and can drop its connection, for tests of what a client puts on the
 * wire and of how it restores a connection.
 */

import type { FabricPlainObject } from "@commonfabric/api";

import { decodeMemoryBoundary, encodeMemoryBoundary } from "../../v2.ts";
import type { Transport } from "../../v2/client.ts";
import type { Server } from "../../v2/server.ts";

/**
 * A transport that opens a connection to `server` on the first frame sent
 * after it was constructed or dropped.
 */
export class ServerTransport implements Transport {
  #sent: FabricPlainObject[] = [];
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<Server["connect"]> | null = null;

  readonly #server: Server;

  /** Constructs an instance which connects to `server`. */
  constructor(server: Server) {
    this.#server = server;
  }

  /** Every message the client sent, oldest first. */
  get sent(): readonly FabricPlainObject[] {
    return this.#sent;
  }

  /** The `type` of every message the client sent, oldest first. */
  get sentTypes(): string[] {
    return this.#sent.map((message) => String(message.type));
  }

  /** Forgets the messages recorded so far. */
  clearSent(): void {
    this.#sent = [];
  }

  /** Closes the connection the way a lost socket does. */
  drop(): void {
    this.#connection?.close();
    this.#connection = null;
    this.#closeReceiver(new Error("disconnect"));
  }

  /** @inheritDoc */
  async send(payload: string): Promise<void> {
    this.#sent.push(decodeMemoryBoundary(payload) as FabricPlainObject);
    this.#connection ??= this.#server.connect((message) => {
      this.#receiver(encodeMemoryBoundary(message));
    });
    await this.#connection.receive(payload);
  }

  /** @inheritDoc */
  close(): Promise<void> {
    this.#connection?.close();
    this.#connection = null;
    return Promise.resolve();
  }

  /** @inheritDoc */
  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  /** @inheritDoc */
  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }
}
