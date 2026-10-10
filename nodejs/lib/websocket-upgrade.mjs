// `Deno.upgradeWebSocket()` for the port's `Deno.serve()` (over `node:http`),
// using the `ws` package for the protocol.
//
// Deno hands the request handler a `WebSocket` synchronously, in the
// `CONNECTING` state, plus a response to return; the socket opens once that
// response goes out. Here, `Deno.serve()` sends a request that asks for an
// upgrade to its handler like any other; `upgradeWebSocket(request)` records
// a pending upgrade against that request object and returns a `WebSocket`
// stand-in; when the handler returns, `Deno.serve()` completes the handshake
// with `ws` and attaches the real socket to the stand-in. The pending upgrade
// is keyed by request rather than by response, so middleware that rebuilds
// the response does not lose it (and undici refuses to construct a `101`
// response at all).

import { WebSocketServer } from "ws";

/** `Request` (as given to the handler) -> its pending upgrade. */
const pendingUpgrades = new WeakMap();

/** `Request` -> the raw `node:http` upgrade (`req`, `socket`, `head`). */
const rawUpgrades = new WeakMap();

const wss = new WebSocketServer({ noServer: true });

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/**
 * The `WebSocket` the handler holds: the standard interface, backed by a
 * `ws` socket once the handshake completes. Calls to `send()` before then
 * throw, as on a `CONNECTING` web socket.
 */
class UpgradedWebSocket extends EventTarget {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSING = CLOSING;
  static CLOSED = CLOSED;

  #ws = null;
  #readyState = CONNECTING;
  #pendingClose = null;

  binaryType = "blob";
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;

  constructor(url, protocol) {
    super();
    this.url = url;
    this.protocol = protocol;
    this.extensions = "";
  }

  get readyState() {
    return this.#readyState;
  }

  get bufferedAmount() {
    return this.#ws?.bufferedAmount ?? 0;
  }

  #fire(event) {
    const handler = this[`on${event.type}`];
    if (typeof handler === "function") handler.call(this, event);
    this.dispatchEvent(event);
  }

  /** Attaches the `ws` socket from the completed handshake. */
  attach(ws) {
    this.#ws = ws;
    ws.binaryType = "nodebuffer";
    ws.on("message", (data, isBinary) => {
      let payload;
      if (!isBinary) {
        payload = data.toString("utf8");
      } else {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : data;
        const copy = new Uint8Array(bytes).buffer;
        payload = this.binaryType === "arraybuffer" ? copy : new Blob([copy]);
      }
      this.#fire(new MessageEvent("message", { data: payload }));
    });
    ws.on("close", (code, reason) => {
      this.#readyState = CLOSED;
      const event = new Event("close");
      Object.assign(event, {
        code,
        reason: reason.toString("utf8"),
        wasClean: code !== 1006,
      });
      this.#fire(event);
    });
    ws.on("error", (error) => {
      const event = new Event("error");
      Object.assign(event, { error, message: error.message });
      this.#fire(event);
    });
    this.#readyState = OPEN;
    this.#fire(new Event("open"));
    if (this.#pendingClose) this.close(...this.#pendingClose);
  }

  /** Fails a socket whose handshake never completed. */
  abort() {
    if (this.#readyState === CLOSED) return;
    this.#readyState = CLOSED;
    this.#fire(new Event("error"));
    const event = new Event("close");
    Object.assign(event, { code: 1006, reason: "", wasClean: false });
    this.#fire(event);
  }

  send(data) {
    if (this.#readyState === CONNECTING) {
      throw new DOMException("WebSocket is not open", "InvalidStateError");
    }
    if (this.#readyState !== OPEN) return;
    if (data instanceof Blob) {
      data.arrayBuffer().then((buffer) => this.#ws.send(buffer));
    } else {
      this.#ws.send(data);
    }
  }

  close(code, reason) {
    if (this.#readyState === CLOSING || this.#readyState === CLOSED) return;
    if (this.#readyState === CONNECTING) {
      this.#pendingClose = [code, reason];
      return;
    }
    this.#readyState = CLOSING;
    this.#ws.close(code, reason);
  }
}

/** Remembers the raw upgrade behind `request`, for `upgradeWebSocket()`. */
export function registerUpgradeRequest(request, req, socket, head) {
  rawUpgrades.set(request, { req, socket, head });
}

/** `Deno.upgradeWebSocket(request, options)`. */
export function upgradeWebSocket(request, options = {}) {
  if (!rawUpgrades.has(request)) {
    throw new TypeError(
      "upgradeWebSocket: the request is not a WebSocket upgrade from Deno.serve()",
    );
  }
  if (pendingUpgrades.has(request)) {
    throw new TypeError("upgradeWebSocket: the request was already upgraded");
  }
  const socket = new UpgradedWebSocket(request.url, options.protocol ?? "");
  pendingUpgrades.set(request, { socket, options });
  const response = new Response(null, {
    status: 200,
    headers: { "x-node-port-upgrade": "pending" },
  });
  return { socket, response };
}

/** Writes a plain HTTP response to a raw socket whose upgrade was refused. */
async function writeRawResponse(socket, response) {
  const body = new Uint8Array(await response.arrayBuffer());
  const lines = [`HTTP/1.1 ${response.status} ${response.statusText}`];
  for (const [k, v] of response.headers) {
    if (k !== "content-length" && k !== "transfer-encoding") {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push(`content-length: ${body.length}`, "connection: close", "", "");
  socket.end(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
}

/**
 * Finishes the `node:http` `upgrade` event for `request`, given the
 * handler's `response`: completes the WebSocket handshake when the handler
 * called `upgradeWebSocket()`, and otherwise sends `response` and closes.
 */
export async function completeUpgrade(request, response) {
  const raw = rawUpgrades.get(request);
  const pending = pendingUpgrades.get(request);
  if (!pending) {
    await writeRawResponse(raw.socket, response);
    return;
  }
  const { socket, options } = pending;
  if (options.protocol) {
    wss.once("headers", (headers) => {
      headers.push(`Sec-WebSocket-Protocol: ${options.protocol}`);
    });
  }
  try {
    wss.handleUpgrade(raw.req, raw.socket, raw.head, (ws) => socket.attach(ws));
  } catch (e) {
    socket.abort();
    throw e;
  }
}

/**
 * Routes `server`'s `upgrade` events through `handler`, as `Deno.serve()`
 * does: `makeRequest(req)` builds the handler's `Request`.
 */
export function serveUpgrades(server, makeRequest, handler) {
  server.on("upgrade", async (req, socket, head) => {
    const request = makeRequest(req);
    registerUpgradeRequest(request, req, socket, head);
    try {
      const response = await handler(request, {
        remoteAddr: {
          transport: "tcp",
          hostname: req.socket.remoteAddress,
          port: req.socket.remotePort,
        },
        completed: new Promise((resolve) => socket.on("close", resolve)),
      });
      await completeUpgrade(request, response);
    } catch (e) {
      pendingUpgrades.get(request)?.socket.abort();
      socket.destroy(e);
    }
  });
}
