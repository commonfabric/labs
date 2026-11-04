/** Relays a test client's storage traffic and holds reconnections during an outage. */

/** Owns a local relay whose paused requests wait for an explicit resume. */
export class StorageNetworkGate {
  #server: Deno.HttpServer<Deno.NetAddr>;
  #target: URL;
  #sockets = new Set<WebSocket>();
  #gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  #closed = false;

  /** Starts an ephemeral relay for the given storage server. */
  constructor(target: URL, port = 0) {
    this.#target = target;
    this.#server = Deno.serve(
      { hostname: "127.0.0.1", port, onListen: () => {} },
      (request) => this.#serve(request),
    );
  }

  /** The relay address supplied to one independent reader. */
  get url(): URL {
    return new URL(`http://127.0.0.1:${this.#server.addr.port}`);
  }

  /** Number of live relay socket endpoints, including both sides. */
  get socketCount(): number {
    return this.#sockets.size;
  }

  /** Closes current sockets and holds new requests until resume(). */
  async pause(): Promise<void> {
    if (this.#gate || this.#closed) throw new Error("Network gate is not open");
    this.#gate = Promise.withResolvers<void>();
    await Promise.all(
      [...this.#sockets].map((socket) => this.#closeSocket(socket)),
    );
  }

  /** Releases requests held by pause(). */
  resume(): void {
    const gate = this.#gate;
    this.#gate = undefined;
    gate?.resolve();
  }

  /** Releases pending requests and closes the relay and its sockets. */
  async close(): Promise<void> {
    this.#closed = true;
    this.resume();
    await Promise.all(
      [...this.#sockets].map((socket) => this.#closeSocket(socket)),
    );
    await this.#server.shutdown();
  }

  async #closeSocket(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
    });
    socket.close();
    await closed;
  }

  async #serve(request: Request): Promise<Response> {
    if (this.#gate) await this.#gate.promise;
    if (this.#closed) return new Response("Closed", { status: 503 });
    const incoming = new URL(request.url);
    const target = new URL(incoming.pathname + incoming.search, this.#target);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      const forwarded = new Request(target, request);
      forwarded.headers.delete("host");
      return await fetch(forwarded);
    }
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const upstream = new WebSocket(target);
    const { socket, response } = Deno.upgradeWebSocket(request);
    const opened = new Promise<void>((resolve, reject) => {
      upstream.addEventListener("open", () => resolve(), { once: true });
      upstream.addEventListener(
        "error",
        () => reject(new Error("Relay connection failed")),
        { once: true },
      );
    });
    for (const peer of [socket, upstream]) {
      this.#sockets.add(peer);
      peer.addEventListener("close", () => {
        this.#sockets.delete(peer);
        const other = peer === socket ? upstream : socket;
        if (
          other.readyState === WebSocket.CONNECTING ||
          other.readyState === WebSocket.OPEN
        ) other.close();
      }, { once: true });
    }
    socket.addEventListener("message", (event) => {
      void opened.then(() => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(event.data);
      }).catch(() => socket.close());
    });
    upstream.addEventListener("message", (event) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
    });
    void opened.catch(() => socket.close());
    return response;
  }
}
