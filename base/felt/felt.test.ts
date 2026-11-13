import { stripAnsiCode } from "@std/fmt/colors";
import { expect } from "@std/expect";
import { join } from "@std/path/join";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { banner, felt } from "./felt.ts";
import { ResolvedConfig } from "./interface.ts";

/** Resolves with the next event of `type` that `target` dispatches. */
function nextEvent(target: EventTarget, type: string): Promise<Event> {
  return new Promise((resolve) =>
    target.addEventListener(type, resolve, { once: true })
  );
}

describe("felt", () => {
  describe("banner()", () => {
    const config = new ResolvedConfig({
      entries: [],
      outDir: "dist",
      hostname: "127.0.0.1",
      port: 5173,
    }, "/projects/a-project-directory-long-enough-to-widen-the-box");

    it("draws every line of the box at one width", () => {
      const lines = banner(config, true).map(stripAnsiCode);
      const box = lines.filter((line) => line !== "");

      expect(lines).toHaveLength(box.length + 2);
      for (const line of box) {
        expect(line.length).toBe(box[0]!.length);
      }
      expect(box[0]!.length).toBeGreaterThan(
        "  📂 Project:  /projects/a-project-directory-long-enough-to-widen-the-box"
          .length,
      );
    });

    it("names the server address and the project's directories", () => {
      const text = banner(config, false).map(stripAnsiCode).join("\n");

      expect(text).toContain("FrontEnd Lightweight Tooling 🚀 (v0.0.1)");
      expect(text).toContain("🌐 Server:   http://127.0.0.1:5173 ");
      expect(text).toContain(`📂 Project:  ${config.cwd} `);
      expect(text).toContain(`📁 Public:   ${config.publicDir} `);
    });

    it("names the watch directory only when watching", () => {
      const watching = banner(config, true).map(stripAnsiCode).join("\n");
      const notWatching = banner(config, false).map(stripAnsiCode).join("\n");

      expect(watching).toContain(`👀 Watch:    ${config.watchDir} `);
      expect(notWatching).not.toContain("Watch:");
    });
  });

  describe("felt()", () => {
    let root: string;
    let config: ResolvedConfig;

    beforeEach(async () => {
      root = await Deno.makeTempDir({ prefix: "felt-test-" });
      await Deno.mkdir(join(root, "public"));
      await Deno.writeTextFile(
        join(root, "public", "index.html"),
        "<html><body></body></html>",
      );
      await Deno.writeTextFile(join(root, "public", "extra.txt"), "extra");
      await Deno.mkdir(join(root, "assets"));
      await Deno.writeTextFile(join(root, "assets", "asset.txt"), "asset");
      await Deno.mkdir(join(root, "src"));
      await Deno.writeTextFile(
        join(root, "src", "main.ts"),
        `console.log("first");\n`,
      );
      config = new ResolvedConfig({
        entries: [{ in: "src/main.ts", out: "scripts/main" }],
        outDir: "dist",
        hostname: "127.0.0.1",
        port: 0,
        staticDirs: [{ from: "assets", to: "/assets" }],
      }, root);
    });

    afterEach(async () => {
      await Deno.remove(root, { recursive: true });
    });

    it("builds the project and its public files, starting no server, for build", async () => {
      const serving = await felt("build", config);

      expect(serving).toBeUndefined();
      expect(await Deno.readTextFile(join(root, "dist", "extra.txt")))
        .toBe("extra");
      expect(await Deno.readTextFile(join(root, "dist", "scripts", "main.js")))
        .toContain(`console.log("first")`);
    });

    it("serves the built project and its static directories, without the reload script, for serve", async () => {
      const serving = await felt("serve", config);
      const base = `http://127.0.0.1:${serving!.server.addr.port}`;
      try {
        const page = await fetch(`${base}/`);
        const script = await fetch(`${base}/scripts/main.js`);
        const asset = await fetch(`${base}/assets/asset.txt`);

        expect(await page.text()).toBe("<html><body></body></html>");
        expect(await script.text()).toContain(`console.log("first")`);
        expect(await asset.text()).toBe("asset");
      } finally {
        await serving!.server.shutdown();
      }
      await serving!.finished;
    });

    it("rebuilds and reloads the page on each change, until the changes end, for dev", async () => {
      const connected = Promise.withResolvers<void>();
      const ended = Promise.withResolvers<void>();
      const watched: string[] = [];
      const serving = await felt("dev", config, (dir) => {
        watched.push(dir);
        return (async function* () {
          await connected.promise;
          await Deno.writeTextFile(
            join(root, "src", "main.ts"),
            `console.log("second");\n`,
          );
          yield "change";
          await ended.promise;
        })();
      });
      const port = serving!.server.addr.port;
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      const message = nextEvent(socket, "message");
      const closed = nextEvent(socket, "close");
      try {
        await nextEvent(socket, "open");
        connected.resolve();

        expect(await message).toMatchObject({ data: "reload" });
        expect(watched).toEqual([join(root, "src")]);
        const page = await fetch(`http://127.0.0.1:${port}/`);
        expect(await page.text()).toContain(`src="/DEV_SOCKET.js"`);
        const script = await fetch(`http://127.0.0.1:${port}/scripts/main.js`);
        expect(await script.text()).toContain(`console.log("second")`);
      } finally {
        connected.resolve();
        ended.resolve();
      }
      await serving!.finished;
      await closed;
    });
  });
});
