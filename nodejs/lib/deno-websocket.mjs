// `Deno.upgradeWebSocket()` for this port's `Deno.serve()` (over `node:http`),
// with the `ws` package doing the protocol work.
//
// A request carrying `Upgrade: websocket` arrives through the HTTP server's
// `upgrade` event. Its handler calls `Deno.upgradeWebSocket(request)`, which
// returns a server-side socket (not yet open) and a response to return; when
// the handler returns that response, the connection is upgraded and the socket
// opens. The socket presents the Web `WebSocket` interface, as Deno's does.

import { WebSocketServer } from "ws";

/** The Node upgrade (`req`, `socket`, `head`) behind each upgradable request. */
const upgradeInfo = new WeakMap();

/** The socket each `upgradeWebSocket()` response upgrades to. */
const socketsByResponse = new WeakMap();

const wss = new WebSocketServer({ noServer: true });

class ServerWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  CONNECTING = 0;
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;

  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  readyState = 0;
  protocol = "";
  extensions = "";
  url;

  #ws = null;
  #binaryType = "blob";

  constructor(url) {
    super();
    this.url = url;
  }

  get binaryType() {
    return this.#binaryType;
  }

  set binaryType(value) {
    if (value === "blob" || value === "arraybuffer") this.#binaryType = value;
  }

  get bufferedAmount() {
    return this.#ws?.bufferedAmount ?? 0;
  }

  #fire(event) {
    this.dispatchEvent(event);
    const handler = this[`on${event.type}`];
    if (typeof handler === "function") handler.call(this, event);
  }

  /** Connects this socket to the upgraded `ws` connection. */
  attach(ws) {
    this.#ws = ws;
    if (this.readyState !== ServerWebSocket.CONNECTING) {
      ws.terminate();
      return;
    }
    ws.on("message", (data, isBinary) => {
      let payload;
      if (!isBinary) {
        payload = data.toString("utf8");
      } else {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : data;
        const copy = new Uint8Array(bytes).buffer;
        payload = this.#binaryType === "arraybuffer" ? copy : new Blob([copy]);
      }
      this.#fire(new MessageEvent("message", { data: payload }));
    });
    ws.on("close", (code, reason) => {
      this.readyState = ServerWebSocket.CLOSED;
      this.#fire(
        new CloseEvent("close", {
          code,
          reason: reason.toString("utf8"),
          wasClean: true,
        }),
      );
    });
    ws.on("error", (error) => {
      this.#fire(new ErrorEvent("error", { error, message: error.message }));
    });
    this.readyState = ServerWebSocket.OPEN;
    this.#fire(new Event("open"));
  }

  send(data) {
    if (this.readyState !== ServerWebSocket.OPEN) {
      throw new DOMException("The WebSocket is not open", "InvalidStateError");
    }
    if (data instanceof Blob) {
      data.arrayBuffer().then((buffer) => this.#ws.send(buffer));
    } else {
      this.#ws.send(data);
    }
  }

  close(code, reason) {
    if (this.readyState >= ServerWebSocket.CLOSING) return;
    this.readyState = ServerWebSocket.CLOSING;
    if (this.#ws) this.#ws.close(code, reason);
  }
}

/** `Deno.upgradeWebSocket()`. */
export function upgradeWebSocket(request, _options) {
  const info = upgradeInfo.get(request);
  if (
    !info || request.headers.get("upgrade")?.toLowerCase() !== "websocket"
  ) {
    throw new TypeError(
      "Invalid Header: 'upgrade' header must contain 'websocket'",
    );
  }
  const socket = new ServerWebSocket(request.url.replace(/^http/, "ws"));
  const response = new Response(null, { status: 200 });
  socketsByResponse.set(response, socket);
  return { socket, response };
}

/** Writes a plain (non-upgrade) response to a raw socket and ends it. */
async function writeRawResponse(sock, response) {
  const body = new Uint8Array(await response.arrayBuffer());
  const lines = [`HTTP/1.1 ${response.status} ${response.statusText}`];
  for (const [k, v] of response.headers) lines.push(`${k}: ${v}`);
  lines.push(`content-length: ${body.length}`, "connection: close", "", "");
  sock.end(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
}

/**
 * Handles `upgrade` events on `server`: makes a `Request` of each (through
 * `toRequest(req, abort)`), passes it to `handler` with `infoFor(req)`, and
 * upgrades the connection if the handler returns an `upgradeWebSocket()`
 * response.
 */
export function attachWebSocketUpgrade(server, toRequest, handler, infoFor) {
  server.on("upgrade", async (req, sock, head) => {
    const abort = new AbortController();
    sock.on("close", () => abort.abort());
    const request = toRequest(req, abort);
    upgradeInfo.set(request, { req, sock, head });
    let response;
    try {
      response = await handler(request, infoFor(req));
    } catch {
      response = new Response("Internal Server Error", { status: 500 });
    }
    const socket = socketsByResponse.get(response);
    if (socket) {
      wss.handleUpgrade(req, sock, head, (ws) => socket.attach(ws));
    } else {
      await writeRawResponse(sock, response);
    }
  });
}
