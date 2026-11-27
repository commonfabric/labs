/**
 * A WebSocket client that speaks the protocol itself over a TCP connection:
 * the opening handshake, and unfragmented text and close frames. Unlike
 * Deno's `WebSocket`, it says when the server has ended the connection, which
 * a server does only once it has finished with the socket, so a test can wait
 * for the server to have taken in a close.
 */

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** What a frame's first byte says it carries. */
const TEXT = 0x1;
const CLOSE = 0x8;

/** A frame the server sent. */
export interface Frame {
  readonly opcode: number;
  readonly text: string;
}

/** The client end of a WebSocket. */
export class RawWebSocket {
  #connection: Deno.Conn;
  #buffered = new Uint8Array(0);

  /** Constructs an instance that speaks over `connection`, already upgraded. */
  constructor(connection: Deno.Conn) {
    this.#connection = connection;
  }

  /**
   * Asks the server on `port` of this machine to upgrade a request for
   * `target` to a WebSocket, and returns the client and the status the server
   * answered with, 101 when it upgraded.
   */
  static async open(port: number, target: string): Promise<{ socket: RawWebSocket; status: number }> {
    const socket = new RawWebSocket(await Deno.connect({ hostname: "127.0.0.1", port }));
    await socket.#write(ENCODER.encode(
      `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    ));
    // The status line and headers are ASCII, so a character of them is a byte.
    let end = -1;
    while ((end = DECODER.decode(socket.#buffered).indexOf("\r\n\r\n")) === -1) {
      if (!await socket.#fill()) throw new Error("the server ended the connection before it answered");
    }
    const head = DECODER.decode(await socket.#takeAll(end + 4));
    return { socket, status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0) };
  }

  /** Resolves with the next frame the server sends, or `undefined` once it has ended the connection. */
  async receive(): Promise<Frame | undefined> {
    const start = await this.#take(2);
    if (start === undefined) return undefined;
    let length = start[1] & 0x7f;
    if (length === 126) length = new DataView((await this.#takeAll(2)).buffer).getUint16(0);
    else if (length === 127) length = Number(new DataView((await this.#takeAll(8)).buffer).getBigUint64(0));
    return { opcode: start[0] & 0x0f, text: DECODER.decode(await this.#takeAll(length)) };
  }

  /** Sends `text` as a text frame. */
  send(text: string): Promise<void> {
    return this.#send(TEXT, ENCODER.encode(text));
  }

  /**
   * Starts the closing handshake, and resolves once the server has ended the
   * connection, with the text of each text frame it sent before.
   */
  async close(): Promise<string[]> {
    await this.#send(CLOSE, new Uint8Array(0));
    const texts: string[] = [];
    for (let frame = await this.receive(); frame !== undefined; frame = await this.receive()) {
      if (frame.opcode === TEXT) texts.push(frame.text);
    }
    this.#connection.close();
    return texts;
  }

  /** Helper for the methods that send, which sends a frame masked, as a client's must be. */
  #send(opcode: number, payload: Uint8Array): Promise<void> {
    const extended = payload.length < 126 ? 0 : 2;
    const frame = new Uint8Array(2 + extended + 4 + payload.length);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | (extended ? 126 : payload.length);
    if (extended) new DataView(frame.buffer).setUint16(2, payload.length);
    const mask = crypto.getRandomValues(new Uint8Array(4));
    frame.set(mask, 2 + extended);
    for (let i = 0; i < payload.length; i++) frame[6 + extended + i] = payload[i] ^ mask[i % 4];
    return this.#write(frame);
  }

  /** Helper for the methods that read, which returns the next `count` bytes, or `undefined` at the end. */
  async #take(count: number): Promise<Uint8Array | undefined> {
    while (this.#buffered.length < count) {
      if (!await this.#fill()) return undefined;
    }
    const taken = this.#buffered.slice(0, count);
    this.#buffered = this.#buffered.slice(count);
    return taken;
  }

  /** Helper for the methods that read, which returns the next `count` bytes. */
  async #takeAll(count: number): Promise<Uint8Array> {
    const taken = await this.#take(count);
    if (taken === undefined) throw new Error("the server ended the connection within a frame");
    return taken;
  }

  /** Helper for the methods that read, which reads what has arrived, and returns whether anything had. */
  async #fill(): Promise<boolean> {
    const chunk = new Uint8Array(64 * 1024);
    const read = await this.#connection.read(chunk);
    if (read === null) return false;
    const buffered = new Uint8Array(this.#buffered.length + read);
    buffered.set(this.#buffered);
    buffered.set(chunk.subarray(0, read), this.#buffered.length);
    this.#buffered = buffered;
    return true;
  }

  /** Helper for the methods that send, which writes all of `bytes`. */
  async #write(bytes: Uint8Array): Promise<void> {
    for (let written = 0; written < bytes.length;) {
      written += await this.#connection.write(bytes.subarray(written));
    }
  }
}
