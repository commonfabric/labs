import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";

import {
  openSharedCompileCache,
  SHARED_COMPILE_CACHE_RETENTION_MS,
} from "../src/compilation-cache/shared-compile-cache.deno.ts";
import { CompileTurns } from "../src/harness/compile-interleave.ts";

const VERSION = "test-runtime-version";

/** A module as a compile puts it. */
const moduleNamed = (identity: string) => ({
  identity,
  js: `export const name = ${JSON.stringify(identity)};`,
});

/**
 * Another process on the cache at `dir`, running
 * `fixtures/shared-compile-cache-process.ts` with `args`.
 */
function otherProcess(dir: string, ...args: string[]) {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-check",
      "--allow-read",
      "--allow-write",
      fromFileUrl(
        new URL("./fixtures/shared-compile-cache-process.ts", import.meta.url),
      ),
      dir,
      ...args,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const lines = child.stdout.pipeThrough(new TextDecoderStream())
    .values();
  return {
    child,
    /** Resolves with the next line the process prints. */
    async nextLine(): Promise<string> {
      let text = "";
      while (!text.includes("\n")) {
        const { value, done } = await lines.next();
        if (done) throw new Error(`the process ended after ${text}`);
        text += value;
      }
      return text.trim();
    },
  };
}

describe("openSharedCompileCache()", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "shared-compile-cache-" });
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  describe("moduleByteCache", () => {
    it("serves a module another realm's cache put", () => {
      const putting = openSharedCompileCache(dir).moduleByteCache;
      const reading = openSharedCompileCache(dir).moduleByteCache;
      putting.putAll(VERSION, [moduleNamed("a"), moduleNamed("b")]);

      const set = reading.getCompleteSet(VERSION, ["a", "b"]);

      expect(set?.get("a")?.js).toBe(moduleNamed("a").js);
      expect(set?.get("b")?.js).toBe(moduleNamed("b").js);
    });

    it("misses a module put under another runtime version", () => {
      openSharedCompileCache(dir).moduleByteCache.putAll(VERSION, [
        moduleNamed("a"),
      ]);
      const reading = openSharedCompileCache(dir).moduleByteCache;

      expect(reading.getCompleteSet(`${VERSION}-next`, ["a"])).toBeUndefined();
      expect(reading.getCompleteSet(VERSION, ["a"])).toBeDefined();
    });

    it("misses a set it holds only part of", () => {
      openSharedCompileCache(dir).moduleByteCache.putAll(VERSION, [
        moduleNamed("a"),
      ]);
      const reading = openSharedCompileCache(dir).moduleByteCache;

      expect(reading.getCompleteSet(VERSION, ["a", "b"])).toBeUndefined();
    });

    it("leaves every module whole when processes put the same modules at once", async () => {
      const writers = Array.from(
        { length: 4 },
        () => otherProcess(dir, "put", VERSION, "200"),
      );
      for (const writer of writers) {
        expect(await writer.nextLine()).toBe("put");
        expect((await writer.child.status).success).toBe(true);
      }
      const reading = openSharedCompileCache(dir).moduleByteCache;
      const identities = Array.from(
        { length: 200 },
        (_, index) => `module-${index}`,
      );

      const set = reading.getCompleteSet(VERSION, identities);

      expect(set?.size).toBe(200);
      expect(set?.get("module-7")?.js).toBe(
        "export const value = 7;".repeat(64),
      );
      const leftovers: string[] = [];
      for (const version of Deno.readDirSync(join(dir, "modules"))) {
        for (
          const entry of Deno.readDirSync(join(dir, "modules", version.name))
        ) {
          if (!entry.name.endsWith(".json")) leftovers.push(entry.name);
        }
      }
      expect(leftovers).toEqual([]);
    });

    it("throws for a module file that does not parse, rather than missing", () => {
      const putting = openSharedCompileCache(dir).moduleByteCache;
      putting.putAll(VERSION, [moduleNamed("a")]);
      const [version] = [...Deno.readDirSync(join(dir, "modules"))];
      const [file] = [
        ...Deno.readDirSync(join(dir, "modules", version.name)),
      ];
      Deno.writeTextFileSync(
        join(dir, "modules", version.name, file.name),
        "{ not json",
      );
      const reading = openSharedCompileCache(dir).moduleByteCache;

      expect(() => reading.getCompleteSet(VERSION, ["a"])).toThrow(
        SyntaxError,
      );
    });
  });

  describe("compileClaims", () => {
    it("makes a turn wait for another process's turn for the same key to end", async () => {
      const holder = otherProcess(dir, "claim", "key");
      expect(await holder.nextLine()).toBe("held");
      const { compileClaims } = openSharedCompileCache(dir);

      const taking = compileClaims.take("key");
      // The holder writes `ended` before it ends its turn, so a turn that
      // waited for it finds the file.
      const writer = holder.child.stdin.getWriter();
      await writer.write(new TextEncoder().encode("end\n"));
      const endTurn = await taking;

      expect(Deno.statSync(join(dir, "ended")).isFile).toBe(true);
      endTurn();
      await writer.close();
      expect((await holder.child.status).success).toBe(true);
    });

    it("takes a turn another process held once that process is killed", async () => {
      const holder = otherProcess(dir, "claim", "key");
      expect(await holder.nextLine()).toBe("held");
      const { compileClaims } = openSharedCompileCache(dir);

      const taking = compileClaims.take("key");
      holder.child.kill("SIGKILL");
      await holder.child.status;
      const endTurn = await taking;

      expect(() => Deno.statSync(join(dir, "ended"))).toThrow(
        Deno.errors.NotFound,
      );
      endTurn();
      await holder.child.stdin.close();
    });

    it("does not make a turn wait for another process's turn for another key", async () => {
      const holder = otherProcess(dir, "claim", "key");
      expect(await holder.nextLine()).toBe("held");
      const { compileClaims } = openSharedCompileCache(dir);

      const endTurn = await compileClaims.take("other key");

      endTurn();
      holder.child.kill("SIGKILL");
      await holder.child.status;
      await holder.child.stdin.close();
    });
  });

  describe("pruning", () => {
    it("removes the versions and claims nothing used within the retention, and keeps the rest", () => {
      const now = new Date();
      const stale = new Date(
        now.getTime() - SHARED_COMPILE_CACHE_RETENTION_MS - 1,
      );
      const { moduleByteCache } = openSharedCompileCache(dir);
      // Opened ahead of the backdating, which its own opening would prune.
      const reading = openSharedCompileCache(dir).moduleByteCache;
      moduleByteCache.putAll("old", [moduleNamed("a")]);
      moduleByteCache.putAll("current", [moduleNamed("a")]);
      for (const version of Deno.readDirSync(join(dir, "modules"))) {
        Deno.utimeSync(join(dir, "modules", version.name), stale, stale);
      }
      Deno.writeTextFileSync(join(dir, "claims", "stale.lock"), "");
      Deno.utimeSync(join(dir, "claims", "stale.lock"), stale, stale);
      Deno.writeTextFileSync(join(dir, "claims", "fresh.lock"), "");
      // Another realm's first read of a version marks it used.
      expect(reading.getCompleteSet("current", ["a"])).toBeDefined();

      const reopened = openSharedCompileCache(dir, now).moduleByteCache;

      expect(reopened.getCompleteSet("current", ["a"])).toBeDefined();
      expect(reopened.getCompleteSet("old", ["a"])).toBeUndefined();
      const claims = [...Deno.readDirSync(join(dir, "claims"))].map((entry) =>
        entry.name
      );
      expect(claims).toEqual(["fresh.lock"]);
    });
  });
});

describe("CompileTurns", () => {
  it("starts a second turn for a key only once the first ends", async () => {
    const turns = new CompileTurns();
    const endFirst = await turns.take("key");
    let secondStarted = false;
    const second = turns.take("key").then((end) => {
      secondStarted = true;
      return end;
    });

    // Taken after the second, and for another key, so it waits for nothing:
    // a second turn that did not wait would have started by now.
    (await turns.take("other key"))();
    expect(secondStarted).toBe(false);
    endFirst();
    (await second)();

    expect(secondStarted).toBe(true);
  });

  it("starts a turn for a key whose earlier turns all ended at once", async () => {
    const turns = new CompileTurns();
    (await turns.take("key"))();

    const end = await turns.take("key");

    end();
  });
});
