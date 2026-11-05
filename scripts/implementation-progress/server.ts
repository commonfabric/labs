/** Serves the local implementation dashboard and pushes file-change notices. */

const root = new URL("./", import.meta.url);
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();
const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/status.json", ["status.json", "application/json"]],
  ["/demo.json", ["demo.json", "application/json"]],
  ["/74-votes.png", ["74-votes.png", "image/png"]],
  ["/296-votes.png", ["296-votes.png", "image/png"]],
  ["/1184-votes.png", ["1184-votes.png", "image/png"]],
  ["/mapped-cross-space.png", ["mapped-cross-space.png", "image/png"]],
  ["/mapped-cross-space-cold.png", [
    "mapped-cross-space-cold.png",
    "image/png",
  ]],
  ["/mapped-cross-space-removed.png", [
    "mapped-cross-space-removed.png",
    "image/png",
  ]],
]);
const watcher = Deno.watchFs(import.meta.dirname!);
const server = Deno.serve(
  { hostname: "127.0.0.1", port: 7155 },
  async (request) => {
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }
    const path = new URL(request.url).pathname;
    if (path === "/events") {
      let controller: ReadableStreamDefaultController<Uint8Array>;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(next) {
            controller = next;
            clients.add(next);
            next.enqueue(encoder.encode("data: connected\n\n"));
          },
          cancel() {
            clients.delete(controller);
          },
        }),
        {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          },
        },
      );
    }
    const file = files.get(path);
    if (file === undefined) return new Response("Not found", { status: 404 });
    return new Response(await Deno.readFile(new URL(file[0], root)), {
      headers: {
        "content-type": `${file[1]}; charset=utf-8`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },
);
try {
  for await (const event of watcher) {
    if (event.kind === "access") continue;
    for (const client of clients) {
      client.enqueue(encoder.encode("data: changed\n\n"));
    }
  }
} finally {
  watcher.close();
  for (const client of clients) client.close();
  await server.shutdown();
}
