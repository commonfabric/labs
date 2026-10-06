/** A private TLS listener with bounded WebSocket fragmentation before decoding. */

// deno-lint-ignore no-external-import -- Deno types this TLS builtin by its node: specifier.
import { createServer } from "node:https";
// @ts-types="@types/ws"
import { WebSocketServer } from "ws";

import type { RoutedMemoryHost } from "./routed-host.ts";
import { ROUTED_RAW_LIMIT } from "./routed-parser.ts";

/** Tracked private endpoint settings; key bytes come from managed credentials. */
export interface RoutedListenerOptions {
  hostname: string;
  port: number;
  certificate: string;
  key: string;
  host: RoutedMemoryHost;
}

/** Starts only the authenticated link and ticketed Memory data endpoints. */
export async function listenRoutedMemory(
  options: RoutedListenerOptions,
): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer({
    cert: options.certificate,
    key: options.key,
    minVersion: "TLSv1.3",
    maxHeaderSize: 16 * 1024,
    requestTimeout: 5000,
    headersTimeout: 5000,
    handshakeTimeout: 5000,
  }, (_request, response) => {
    response.writeHead(404);
    response.end();
  });
  server.maxConnections = 512;
  const framingOptions = {
    noServer: true,
    maxPayload: ROUTED_RAW_LIMIT,
    maxFragments: 512,
    perMessageDeflate: false,
    clientTracking: true,
  };
  const sockets = new WebSocketServer(framingOptions);
  const linkFramingOptions = {
    ...framingOptions,
    maxPayload: 4096,
    maxFragments: 64,
  };
  const links = new WebSocketServer(linkFramingOptions);
  server.on("connection", (socket) => {
    if (!options.host.acceptsPeer(socket.remoteAddress ?? "")) socket.destroy();
  });
  server.on("upgrade", (request, socket, head) => {
    const path = request.url;
    const names = request.rawHeaders.filter((_value, index) => index % 2 === 0)
      .map((name) => name.toLowerCase());
    if (
      request.method !== "GET" ||
      (path !== "/memory/router-link" && path !== "/memory/router-data") ||
      names.length !== new Set(names).size ||
      request.headers.origin !== undefined ||
      request.headers["sec-websocket-extensions"] !== undefined ||
      request.headers["sec-websocket-protocol"] !== undefined ||
      !options.host.acceptsPeer(request.socket.remoteAddress ?? "")
    ) {
      socket.destroy();
      return;
    }
    const framing = path === "/memory/router-link" ? links : sockets;
    framing.handleUpgrade(request, socket, head, (websocket) => {
      websocket.on("error", () => websocket.terminate());
      options.host.accept(websocket, path, request.socket.remoteAddress ?? "");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Private memory listener failed");
  }
  return {
    port: address.port,
    close: async () => {
      options.host.close();
      for (const socket of sockets.clients) socket.terminate();
      for (const socket of links.clients) socket.terminate();
      sockets.close();
      links.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    },
  };
}
