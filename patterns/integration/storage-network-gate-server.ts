/** Runs a local storage relay with an explicit browser-test outage control port. */

import { StorageNetworkGate } from "./storage-network-gate.ts";

if (import.meta.main) {
  const [target, relayPort, controlPort] = Deno.args;
  const ports = [relayPort, controlPort].map(Number);
  if (
    !target || !URL.canParse(target) || Deno.args.length !== 3 ||
    ports[0] === ports[1] ||
    ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    throw new Error(
      "Usage: storage-network-gate-server.ts <local-api-url> <relay-port> <control-port>",
    );
  }
  const apiUrl = new URL(target);
  if (
    !["http:", "https:"].includes(apiUrl.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(apiUrl.hostname)
  ) {
    throw new Error(
      "The browser outage relay requires a loopback HTTP(S) test server",
    );
  }
  const gate = new StorageNetworkGate(apiUrl, ports[0]);
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);
  try {
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: ports[1],
      signal: shutdown.signal,
      onListen: () =>
        console.log(JSON.stringify({
          apiUrl: apiUrl.href,
          relayUrl: gate.url.href,
          controlUrl: `http://127.0.0.1:${ports[1]}/`,
        })),
    }, async (request) => {
      if (request.method !== "POST") {
        return new Response("POST required", { status: 405 });
      }
      const action = new URL(request.url).pathname;
      if (action === "/pause") {
        const closedSockets = gate.socketCount;
        await gate.pause();
        return Response.json({ closedSockets });
      }
      if (action === "/resume") {
        gate.resume();
        return Response.json({ resumed: true });
      }
      return new Response("Unknown relay action", { status: 404 });
    });
    await server.finished;
  } finally {
    Deno.removeSignalListener("SIGINT", stop);
    Deno.removeSignalListener("SIGTERM", stop);
    await gate.close();
  }
}
