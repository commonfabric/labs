/**
 * Serves the stream-lifetime harness: bundles `harness.ts` for the browser,
 * serves the page, echoes WebSocket frames at `/echo`, prints every line the
 * page posts to `/log`, and forwards a run request posted to `/run` to every
 * open page over `/control`, so a shell beside the browser can drive and
 * follow runs in one long-lived page without touching the browser.
 *
 *     deno run --allow-read --allow-write --allow-net --allow-env \
 *       --allow-run="$(deno eval "console.log(Deno.execPath())")" \
 *       packages/memory/scripts/stream-leak-harness/serve.ts
 *
 * Then open `http://localhost:8765/?mode=module-roundtrip&autostart=1`, or
 * open the page and post runs:
 *
 *     curl -d '{"mode":"module-roundtrip","iterations":2000}' localhost:8765/run
 *     curl -d '{"command":"reload"}' localhost:8765/run
 */

import { fromFileUrl } from "@std/path";

const port = Number(Deno.args[0] ?? "8765");
const directory = new URL("./", import.meta.url);
const bundleDirectory = await Deno.makeTempDir({ prefix: "stream-harness-" });
const bundlePath = `${bundleDirectory}/harness.js`;

const bundle = await new Deno.Command(Deno.execPath(), {
  args: [
    "bundle",
    "--platform=browser",
    "--output",
    bundlePath,
    fromFileUrl(new URL("harness.ts", directory)),
  ],
  stdout: "inherit",
  stderr: "inherit",
}).output();
if (!bundle.success) throw new Error("bundling harness.ts failed");

const html = await Deno.readTextFile(new URL("index.html", directory));
const script = await Deno.readTextFile(bundlePath);

const pages = new Set<WebSocket>();
const bodies = new Map<string, Uint8Array<ArrayBuffer>>();

/** Returns `count` bytes of compressible body, gzip-encoded when asked. */
async function bytesBody(
  count: number,
  gzip: boolean,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = `${count}:${gzip}`;
  let body = bodies.get(key);
  if (!body) {
    const plain = new TextEncoder().encode("fetched body bytes ".repeat(count));
    body = plain.slice(0, count);
    if (gzip) {
      body = new Uint8Array(
        await new Response(
          new Blob([body]).stream().pipeThrough(new CompressionStream("gzip")),
        ).arrayBuffer(),
      );
    }
    bodies.set(key, body);
  }
  return body;
}

Deno.serve({ port }, (request) => {
  const { pathname } = new URL(request.url);
  if (pathname === "/bytes") {
    const { searchParams } = new URL(request.url);
    const gzip = searchParams.get("gzip") === "1";
    return bytesBody(Number(searchParams.get("count") ?? "102400"), gzip).then(
      (body) =>
        new Response(body, {
          headers: {
            "content-type": "application/octet-stream",
            "cache-control": "no-store",
            ...(gzip ? { "content-encoding": "identity" } : {}),
          },
        }),
    );
  }
  if (pathname === "/slow") {
    const { searchParams } = new URL(request.url);
    const chunks = Number(searchParams.get("chunks") ?? "4");
    const delayMs = Number(searchParams.get("delayMs") ?? "5");
    const closeDelayMs = Number(searchParams.get("closeDelayMs") ?? "0");
    const pause = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < chunks; i++) {
          await pause(delayMs);
          controller.enqueue(new TextEncoder().encode(`{"chunk":${i}}\n`));
        }
        // A delay of zero ends the body in the same turn as its last chunk.
        if (closeDelayMs > 0) await pause(closeDelayMs);
        controller.close();
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/plain", "cache-control": "no-store" },
    });
  }
  if (pathname === "/control") {
    const { socket, response } = Deno.upgradeWebSocket(request, {
      idleTimeout: 0,
    });
    socket.onopen = () => pages.add(socket);
    socket.onclose = () => pages.delete(socket);
    return response;
  }
  if (pathname === "/run" && request.method === "POST") {
    return request.text().then((body) => {
      for (const page of pages) page.send(body);
      return new Response(`${pages.size} page(s)\n`);
    });
  }
  if (pathname === "/echo") {
    const { socket, response } = Deno.upgradeWebSocket(request, {
      idleTimeout: 0,
    });
    socket.onmessage = (event) => socket.send(event.data);
    return response;
  }
  if (pathname === "/log" && request.method === "POST") {
    return request.text().then((line) => {
      console.log(line);
      return new Response(null, { status: 204 });
    });
  }
  if (pathname === "/harness.js") {
    return new Response(script, {
      headers: {
        "content-type": "text/javascript",
        "cache-control": "no-store",
      },
    });
  }
  return new Response(html, {
    headers: { "content-type": "text/html", "cache-control": "no-store" },
  });
});
