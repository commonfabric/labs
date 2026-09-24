import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path/join";
import { DevServer } from "./dev-server.ts";

describe("dev-server", () => {
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

  it("marks the page and the reload script as needing revalidation", async () => {
    for (const path of ["/", "/DEV_SOCKET.js"]) {
      const response = await fetch(`${base}${path}`);
      await response.body?.cancel();

      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
    }
  });

  it("answers a revalidation of an unchanged file with 304", async () => {
    const first = await fetch(`${base}/scripts/index.js`);
    await first.body?.cancel();
    const etag = first.headers.get("ETag");
    expect(etag).not.toBeNull();

    const second = await fetch(`${base}/scripts/index.js`, {
      headers: { "If-None-Match": etag! },
    });
    await second.body?.cancel();

    expect(second.status).toBe(304);
  });
});
