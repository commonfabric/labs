import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import { getLogger } from "@commonfabric/logger";
import { ProcessModuleByteCache } from "@commonfabric/test-support/compile-byte-cache";

import {
  DiskModuleByteCache,
  FileCompileClaims,
  openSharedCompileCache,
  SHARED_COMPILE_CACHE_RETENTION_MS,
  USE_MARK_INTERVAL_MS,
} from "../src/compilation-cache/shared-compile-cache.deno.ts";
import { CompileTurns } from "../src/harness/compile-interleave.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

const VERSION = "test-runtime-version";

/** How many times the cache has logged `key` as an error. */
const errorsLogged = (key: string): number =>
  getLogger("shared-compile-cache").countsByKey[key]?.error ?? 0;

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

/** The one entry of the directory at `path`, as a path. */
const onlyEntryOf = (path: string): string => {
  const entries = [...Deno.readDirSync(path)];
  expect(entries).toHaveLength(1);
  return join(path, entries[0].name);
};

/** Whether some open file holds the lock on the claim file at `path`. */
const isClaimHeld = (path: string): boolean => {
  const file = Deno.openSync(path, { read: true, write: true });
  try {
    return !file.tryLockSync(true);
  } finally {
    file.close();
  }
};

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

    for (
      const [what, contents] of [
        ["cut short", '{"key":"'],
        ["empty", ""],
        ["of another module", JSON.stringify({ key: "other", js: "0" })],
      ]
    ) {
      it(`misses a module whose file is ${what}, and serves it once it is put again`, () => {
        openSharedCompileCache(dir).moduleByteCache.putAll(VERSION, [
          moduleNamed("a"),
        ]);
        const file = onlyEntryOf(onlyEntryOf(join(dir, "modules")));
        Deno.writeTextFileSync(file, contents);

        expect(
          openSharedCompileCache(dir).moduleByteCache.getCompleteSet(VERSION, [
            "a",
          ]),
        ).toBeUndefined();
        // The compile that follows a miss puts the module, from a realm that
        // does not hold it.
        openSharedCompileCache(dir).moduleByteCache.putAll(VERSION, [
          moduleNamed("a"),
        ]);

        expect(
          openSharedCompileCache(dir).moduleByteCache.getCompleteSet(VERSION, [
            "a",
          ])?.get("a")?.js,
        ).toBe(moduleNamed("a").js);
      });
    }

    it("throws for a module file that cannot be read, rather than missing", () => {
      openSharedCompileCache(dir).moduleByteCache.putAll(VERSION, [
        moduleNamed("a"),
      ]);
      const file = onlyEntryOf(onlyEntryOf(join(dir, "modules")));
      Deno.removeSync(file);
      Deno.mkdirSync(file);
      const reading = openSharedCompileCache(dir).moduleByteCache;

      expect(() => reading.getCompleteSet(VERSION, ["a"])).toThrow();
    });

    it("keeps the modules it is put, and throws nothing, when their files cannot be written", () => {
      const { moduleByteCache } = openSharedCompileCache(dir);
      // A file where the version trees go, so no tree can be made.
      Deno.removeSync(join(dir, "modules"), { recursive: true });
      Deno.writeTextFileSync(join(dir, "modules"), "");
      const writesFailed = errorsLogged("shared-compile-cache-write-failed");
      const marksFailed = errorsLogged("shared-compile-cache-mark-failed");

      moduleByteCache.putAll(VERSION, [moduleNamed("a")]);

      expect(moduleByteCache.getCompleteSet(VERSION, ["a"])?.get("a")?.js)
        .toBe(moduleNamed("a").js);
      expect(errorsLogged("shared-compile-cache-write-failed")).toBe(
        writesFailed + 1,
      );
      // The tree cannot be marked, since its path runs through a file.
      expect(errorsLogged("shared-compile-cache-mark-failed")).toBe(
        marksFailed + 1,
      );
      Deno.removeSync(join(dir, "modules"));
    });

    it("serves the modules it holds, marking nothing and logging nothing, once their version tree is removed", () => {
      const { moduleByteCache } = openSharedCompileCache(dir);
      moduleByteCache.putAll(VERSION, [moduleNamed("a")]);
      // As another process's opening of the cache prunes it.
      Deno.removeSync(onlyEntryOf(join(dir, "modules")), { recursive: true });
      const marksFailed = errorsLogged("shared-compile-cache-mark-failed");

      expect(moduleByteCache.getCompleteSet(VERSION, ["a"])?.get("a")?.js)
        .toBe(moduleNamed("a").js);
      expect([...Deno.readDirSync(join(dir, "modules"))]).toEqual([]);
      expect(errorsLogged("shared-compile-cache-mark-failed")).toBe(
        marksFailed,
      );
    });

    it("writes no file for a module larger than its memory cache holds", () => {
      const large = { identity: "large", js: "x".repeat(64) };
      const small = { identity: "small", js: "y" };
      const putting = new DiskModuleByteCache(dir, {
        memory: new ProcessModuleByteCache(small.js.length),
      });

      putting.putAll(VERSION, [large, small]);

      expect([...Deno.readDirSync(onlyEntryOf(join(dir, "modules")))])
        .toHaveLength(1);
      const reading = openSharedCompileCache(dir).moduleByteCache;
      expect(reading.getCompleteSet(VERSION, ["small"])?.get("small")?.js)
        .toBe(small.js);
      expect(reading.getCompleteSet(VERSION, ["large"])).toBeUndefined();
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

      expect(isClaimHeld(onlyEntryOf(join(dir, "claims")))).toBe(true);
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

    it("holds the claim file a later turn will open, when the one it opened was removed before it took the lock", async () => {
      Deno.mkdirSync(join(dir, "claims"), { recursive: true });
      let opens = 0;
      const claims = new FileCompileClaims(dir, async (path, options) => {
        const file = await Deno.open(path, options);
        opens += 1;
        // As a cache opening does between this open and the lock, for a claim
        // nothing held.
        if (opens === 1) Deno.removeSync(path);
        return file;
      });

      const endTurn = await claims.take("key");

      expect(opens).toBe(2);
      const path = onlyEntryOf(join(dir, "claims"));
      expect(isClaimHeld(path)).toBe(true);
      endTurn();
      expect(isClaimHeld(path)).toBe(false);
    });

    it("rejects a turn whose claim file cannot be opened, and ends the turn", async () => {
      const { compileClaims } = openSharedCompileCache(dir);
      // A file where the claim files go, so none can be opened.
      Deno.removeSync(join(dir, "claims"), { recursive: true });
      Deno.writeTextFileSync(join(dir, "claims"), "");

      await expect(compileClaims.take("key")).rejects.toThrow(
        Deno.errors.NotADirectory,
      );

      Deno.removeSync(join(dir, "claims"));
      Deno.mkdirSync(join(dir, "claims"));
      // A turn the rejected one left standing would hold this one back.
      const endTurn = await compileClaims.take("key");
      expect(isClaimHeld(onlyEntryOf(join(dir, "claims")))).toBe(true);
      endTurn();
    });

    it("rejects a turn that cannot tell whether the file it locked is its claim file, releasing the lock", async () => {
      const locked = join(dir, "locked.lock");
      const claims = new FileCompileClaims(
        dir,
        (_path, options) => Deno.open(locked, options),
      );
      // A file where the claim files go, so no claim file can be looked up.
      Deno.writeTextFileSync(join(dir, "claims"), "");

      await expect(claims.take("key")).rejects.toThrow(
        Deno.errors.NotADirectory,
      );

      expect(isClaimHeld(locked)).toBe(false);
      Deno.removeSync(join(dir, "claims"));
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

      const reopened = openSharedCompileCache(dir, () => now).moduleByteCache;

      expect(reopened.getCompleteSet("current", ["a"])).toBeDefined();
      expect(reopened.getCompleteSet("old", ["a"])).toBeUndefined();
      const claims = [...Deno.readDirSync(join(dir, "claims"))].map((entry) =>
        entry.name
      );
      expect(claims).toEqual(["fresh.lock"]);
    });

    it("marks a version a realm goes on reading as used again, a day after it last did", () => {
      const start = new Date("2026-01-01T00:00:00Z");
      let now = start;
      openSharedCompileCache(dir).moduleByteCache.putAll(VERSION, [
        moduleNamed("a"),
      ]);
      const version = onlyEntryOf(join(dir, "modules"));
      const reading = openSharedCompileCache(dir, () => now).moduleByteCache;
      const markedAt = () => Deno.statSync(version).mtime?.getTime();

      expect(reading.getCompleteSet(VERSION, ["a"])).toBeDefined();
      expect(markedAt()).toBe(start.getTime());

      // The later reads are served from this realm's memory.
      now = new Date(start.getTime() + USE_MARK_INTERVAL_MS - 1);
      expect(reading.getCompleteSet(VERSION, ["a"])).toBeDefined();
      expect(markedAt()).toBe(start.getTime());

      now = new Date(start.getTime() + USE_MARK_INTERVAL_MS);
      expect(reading.getCompleteSet(VERSION, ["a"])).toBeDefined();
      expect(markedAt()).toBe(now.getTime());
    });

    it("keeps a claim a process holds, however long ago it was taken", async () => {
      const holder = otherProcess(dir, "claim", "key");
      expect(await holder.nextLine()).toBe("held");
      const claim = onlyEntryOf(join(dir, "claims"));
      const stale = new Date(
        Date.now() - SHARED_COMPILE_CACHE_RETENTION_MS * 2,
      );
      Deno.utimeSync(claim, stale, stale);

      const { compileClaims } = openSharedCompileCache(dir);

      expect(isClaimHeld(claim)).toBe(true);
      // A turn for the key still waits for the holder's to end.
      const taking = compileClaims.take("key");
      const writer = holder.child.stdin.getWriter();
      await writer.write(new TextEncoder().encode("end\n"));
      const endTurn = await taking;
      expect(Deno.statSync(join(dir, "ended")).isFile).toBe(true);
      endTurn();
      await writer.close();
      expect((await holder.child.status).success).toBe(true);
    });

    it("keeps a claim taken since the retention began", async () => {
      const { compileClaims } = openSharedCompileCache(dir);
      (await compileClaims.take("key"))();
      const claim = onlyEntryOf(join(dir, "claims"));
      const stale = new Date(
        Date.now() - SHARED_COMPILE_CACHE_RETENTION_MS * 2,
      );
      Deno.utimeSync(claim, stale, stale);

      (await compileClaims.take("key"))();
      openSharedCompileCache(dir);

      expect(onlyEntryOf(join(dir, "claims"))).toBe(claim);
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
