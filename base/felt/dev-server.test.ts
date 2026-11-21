import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path/join";

import { DevServer, devSocketClient } from "./dev-server.ts";

/** Resolves with the next event of `type` that `target` dispatches. */
function nextEvent(target: EventTarget, type: string): Promise<Event> {
  return new Promise((resolve) =>
    target.addEventListener(type, resolve, { once: true })
  );
}

describe("DevServer", () => {
  let outDir: string;
  let server: DevServer;
  let base: string;

  beforeEach(async () => {
    outDir = await Deno.makeTempDir();
    await Deno.writeTextFile(
      join(outDir, "index.html"),
      "<html><body></body></html>",
    );
    await Deno.mkdir(join(outDir, "scripts"));
    await Deno.writeTextFile(join(outDir, "scripts", "index.js"), "1;\n");
    server = new DevServer({
      useReloadSocket: true,
      outDir,
      port: 0,
      hostname: "127.0.0.1",
    });
    base = `http://127.0.0.1:${server.addr.port}`;
  });

  afterEach(async () => {
    await server.shutdown();
    await Deno.remove(outDir, { recursive: true });
  });

  it("marks a built file as needing revalidation", async () => {
    const response = await fetch(`${base}/scripts/index.js`);
    await response.body?.cancel();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("marks the page as needing revalidation", async () => {
    const response = await fetch(`${base}/`);
    await response.body?.cancel();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("marks the reload script as needing revalidation", async () => {
    const response = await fetch(`${base}/DEV_SOCKET.js`);
    await response.body?.cancel();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("redirects a directory path to its trailing-slash form", async () => {
    const response = await fetch(`${base}/scripts`, { redirect: "manual" });
    await response.body?.cancel();

    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(`${base}/scripts/`);
  });

  it("serves the reload script that dials the port it bound", async () => {
    const response = await fetch(`${base}/DEV_SOCKET.js`);
    const script = await response.text();

    expect(script).toContain(`port: ${server.addr.port}`);
  });

  it("returns 304, marked for revalidation, for an unchanged file", async () => {
    const first = await fetch(`${base}/scripts/index.js`);
    await first.body?.cancel();
    const etag = first.headers.get("ETag");
    expect(etag).not.toBeNull();

    const second = await fetch(`${base}/scripts/index.js`, {
      headers: { "If-None-Match": etag! },
    });
    await second.body?.cancel();

    expect(second.status).toBe(304);
    expect(second.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("injects the reload script into the page", async () => {
    const response = await fetch(`${base}/`);

    expect(await response.text()).toBe(
      `<html><body><script src="/DEV_SOCKET.js" type="module"></script>\n` +
        `</body></html>`,
    );
  });

  it("closes a connected page's socket on shutdown", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.addr.port}`);
    const closed = nextEvent(socket, "close");
    await nextEvent(socket, "open");

    await server.shutdown();

    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  describe("devSocketClient()", () => {
    it("reloads the page when the server says to", async () => {
      const reloaded = Promise.withResolvers<void>();
      const socket = devSocketClient(
        { hostname: "127.0.0.1", port: server.addr.port },
        { reload: () => reloaded.resolve() },
      );
      const closed = nextEvent(socket, "close");
      await nextEvent(socket, "open");

      server.reload();

      await reloaded.promise;
      socket.close();
      await closed;
    });

    it("does not reload the page for any other message", async () => {
      let reloads = 0;
      const socket = devSocketClient(
        { hostname: "127.0.0.1", port: server.addr.port },
        { reload: () => reloads++ },
      );
      const closed = nextEvent(socket, "close");
      await nextEvent(socket, "open");

      socket.dispatchEvent(new MessageEvent("message", { data: "other" }));

      expect(reloads).toBe(0);
      socket.close();
      await closed;
    });
  });

  describe("with a static directory", () => {
    let staticDir: string;
    let staticServer: DevServer;
    let staticBase: string;

    beforeEach(async () => {
      staticDir = await Deno.makeTempDir();
      await Deno.writeTextFile(join(staticDir, "asset.txt"), "static asset");
      staticServer = new DevServer({
        useReloadSocket: false,
        outDir,
        port: 0,
        hostname: "127.0.0.1",
        staticDirs: [{ from: staticDir, to: "/static" }],
      });
      staticBase = `http://127.0.0.1:${staticServer.addr.port}`;
    });

    afterEach(async () => {
      await staticServer.shutdown();
      await Deno.remove(staticDir, { recursive: true });
    });

    it("serves a file under its URL prefix, open to every origin", async () => {
      const response = await fetch(`${staticBase}/static/asset.txt`);

      expect(await response.text()).toBe("static asset");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
    });

    it("answers a preflight request under its URL prefix", async () => {
      const response = await fetch(`${staticBase}/static/asset.txt`, {
        method: "OPTIONS",
      });
      await response.body?.cancel();

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, OPTIONS, HEAD",
      );
    });

    it("serves the output directory outside its URL prefix", async () => {
      const response = await fetch(`${staticBase}/scripts/index.js`);

      expect(await response.text()).toBe("1;\n");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("serves the page, without the reload script, when told not to reload", async () => {
      const response = await fetch(`${staticBase}/`);

      expect(await response.text()).toBe("<html><body></body></html>");
    });

    it("serves no reload script when told not to reload", async () => {
      const response = await fetch(`${staticBase}/DEV_SOCKET.js`);
      await response.body?.cancel();

      expect(response.status).toBe(404);
    });
  });
});
