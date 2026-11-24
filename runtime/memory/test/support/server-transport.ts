/**
 * A client transport onto an in-process server that records what the client
 * sent, can drop its connection, and can take its host down, for tests of
 * what a client puts on the wire and of how it restores a connection.
 */

import type { FabricPlainObject } from "@commonfabric/api";

import { decodeMemoryBoundary, encodeMemoryBoundary } from "../../v2.ts";
import { connectionError, type Transport } from "../../v2/client.ts";
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
  #down = false;
  #refused: PromiseWithResolvers<void> | null = null;
  #closes = 0;

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

  /** How many times the client has closed this transport. */
  get closes(): number {
    return this.#closes;
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

  /**
   * Takes the host down: the connection drops the way a lost socket does, and
   * every frame sent from then until `hostUp()` is refused, as a connection
   * that cannot be opened.
   */
  hostDown(): void {
    this.#down = true;
    this.drop();
  }

  /** Brings the host back: the next frame sent opens a connection. */
  hostUp(): void {
    this.#down = false;
  }

  /**
   * Resolves the next time a frame is refused because the host is down, which
   * is the client trying the host again and finding it gone.
   */
  whenRefused(): Promise<void> {
    this.#refused ??= Promise.withResolvers<void>();
    return this.#refused.promise;
  }

  /** @inheritDoc */
  async send(payload: string): Promise<void> {
    if (this.#down) {
      const refused = this.#refused;
      this.#refused = null;
      refused?.resolve();
      throw connectionError("test host is down");
    }
    this.#sent.push(decodeMemoryBoundary(payload) as FabricPlainObject);
    this.#connection ??= this.#server.connect((message) => {
      this.#receiver(encodeMemoryBoundary(message));
    });
    await this.#connection.receive(payload);
  }

  /** @inheritDoc */
  close(): Promise<void> {
    this.#closes++;
    this.#connection?.close();
    this.#connection = null;
    return Promise.resolve();
  }

  /** @inheritDoc */
  reset(): void {
    this.#connection?.close();
    this.#connection = null;
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
