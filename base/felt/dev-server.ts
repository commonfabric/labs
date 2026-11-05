import { join } from "@std/path/join";
import { serveDir } from "@std/http/file-server";
import { isRedirectStatus } from "@std/http/status";

const DEV_SOCKET = "DEV_SOCKET.js";

/**
 * Whether `response` takes the headers this server adds. A redirect from
 * `serveDir` does not: `Response.redirect()` makes its headers immutable, and
 * a redirect to the same file with a trailing slash stays true across builds.
 * Nor does a websocket upgrade, which carries nothing to cache. A 304 does:
 * `isRedirectStatus()` counts it, but it is not a redirect, and it is what
 * refreshes the policy of a copy a browser already holds.
 */
const takesAddedHeaders = (response: Response): boolean =>
  response.status === 304 ||
  (!isRedirectStatus(response.status) && response.status !== 101);

export class DevServer {
  #server: Deno.HttpServer<Deno.NetAddr>;
  #outDir: string;
  #sockets: WebSocket[] = [];
  #html: string;
  #socketScript: string;
  #useReloadSocket: boolean;
  #redirectToIndex?: RegExp;
  #staticDirs: Array<{ from: string; to: string }>;

  constructor(
    {
      useReloadSocket,
      outDir,
      port,
      hostname,
      redirectToIndex,
      staticDirs = [],
    }: {
      useReloadSocket: boolean;
      port: number;
      hostname: string;
      outDir: string;
      redirectToIndex?: RegExp;
      staticDirs?: Array<{ from: string; to: string }>;
    },
  ) {
    this.#useReloadSocket = useReloadSocket;
    this.#outDir = outDir;
    this.#redirectToIndex = redirectToIndex;
    this.#staticDirs = staticDirs;
    this.#html = this.#getHtml({ useReloadSocket, outDir });
    this.#server = Deno.serve(
      {
        port,
        hostname,
        onListen(addr) {
          console.log(
            `Dev server listening on http://${addr.hostname}:${addr.port}`,
          );
        },
      },
      this.#onRequest.bind(this),
    );
    this.#socketScript = this.#getSocketScript({
      hostname,
      port: this.#server.addr.port,
    });
  }

  /** The address the server listens on, with the port it bound. */
  get addr(): Deno.NetAddr {
    return this.#server.addr;
  }

  reload() {
    for (const socket of this.#sockets) {
      socket.send("reload");
    }
  }

  /** Closes the reload sockets and stops the server. */
  async shutdown(): Promise<void> {
    for (const socket of this.#sockets) {
      socket.close();
    }
    await this.#server.shutdown();
  }

  async #onRequest(req: Request): Promise<Response> {
    const response = await this.#respond(req);
    // A build rewrites the served files in place under the same URLs, so a
    // browser must check back before reusing a copy, or it runs code the
    // server no longer serves. The ETag and Last-Modified that `serveDir`
    // gives each file make that check a 304 when nothing changed.
    if (takesAddedHeaders(response)) {
      response.headers.set("Cache-Control", "no-cache");
    }
    return response;
  }

  async #respond(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.headers.get("upgrade") === "websocket") {
      return this.#upgradeWebSocket(req);
    }

    if (this.#useReloadSocket && url.pathname === `/${DEV_SOCKET}`) {
      return new Response(this.#socketScript, {
        status: 200,
        headers: { "Content-Type": "text/javascript" },
      });
    }

    if (
      url.pathname === "/" || url.pathname === "/index.html" ||
      (this.#redirectToIndex && this.#redirectToIndex?.test(url.pathname))
    ) {
      return new Response(this.#html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }

    // Check static directories
    for (const { from, to } of this.#staticDirs) {
      if (url.pathname.startsWith(to)) {
        // Handle OPTIONS requests for CORS
        if (req.method === "OPTIONS") {
          return new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, OPTIONS, HEAD",
              "Access-Control-Allow-Headers": "*",
            },
          });
        }

        // Create a new request with the path adjusted to remove the URL prefix
        const relativePath = url.pathname.slice(to.length);
        const adjustedUrl = new URL(req.url);
        adjustedUrl.pathname = relativePath || "/";
        const adjustedReq = new Request(adjustedUrl, req);

        const response = await serveDir(adjustedReq, {
          fsRoot: from,
          quiet: true,
        });

        if (takesAddedHeaders(response)) {
          response.headers.set("Access-Control-Allow-Origin", "*");
          response.headers.set(
            "Access-Control-Allow-Methods",
            "GET, OPTIONS, HEAD",
          );
          response.headers.set("Access-Control-Allow-Headers", "*");
        }

        return response;
      }
    }

    return serveDir(req, {
      fsRoot: this.#outDir,
      quiet: true,
    });
  }

  #upgradeWebSocket(req: Request): Response {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.addEventListener("open", () => {
      this.#sockets.push(socket);
    });
    socket.addEventListener("close", () => {
      const index = this.#sockets.findIndex((s) => s === socket);
      if (index >= 0) {
        this.#sockets.splice(index, 1);
      }
    });
    return response;
  }

  #getHtml(
    { useReloadSocket, outDir }: { useReloadSocket?: boolean; outDir: string },
  ): string {
    const html = Deno.readTextFileSync(join(outDir, "index.html"));
    return useReloadSocket
      ? html.replace(
        "</body>",
        `<script src="/${DEV_SOCKET}" type="module"></script>\n</body>`,
      )
      : html;
  }

  #getSocketScript(
    { hostname, port }: { hostname: string; port: number },
  ): string {
    let script = "";
    script += devSocketClient.toString();
    script += `\ndevSocketClient({ port: ${port}, hostname: "${hostname}" });`;
    return script;
  }
}

// This function gets serialized and served as `/${DEV_SOCKET}` in the client
function devSocketClient(
  { hostname, port }: { hostname: string; port: number },
) {
  const socket = new WebSocket(`ws://${hostname}:${port}`);
  socket.addEventListener("open", (_) => {
    socket.addEventListener("message", (event) => {
      if (event.data === "reload") {
        globalThis.location.reload();
      }
    });
  });
}
