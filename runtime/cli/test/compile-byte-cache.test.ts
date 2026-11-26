/**
 * The compile cache the connections `cf` opens compile through: where it
 * lives, that one process holds one per directory, and that a later process
 * reuses what an earlier one compiled and compiles what changed.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";

import { Identity } from "@commonfabric/identity";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import {
  ConnectionCompileCache,
  connectionCompileCache,
  connectionCompileCacheDir,
} from "../lib/compile-byte-cache.ts";

/** An environment that holds `values` and nothing else. */
function environment(
  values: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => values[name];
}

/** A one-module program whose pattern returns `label`. */
function programLabeled(label: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        `export default pattern(() => ({ [NAME]: ${JSON.stringify(label)} }));`,
      ].join("\n"),
    }],
  };
}

describe("compile-byte-cache", () => {
  describe("connectionCompileCacheDir()", () => {
    it("returns the directory under XDG_CACHE_HOME when it is set", () => {
      expect(
        connectionCompileCacheDir(
          environment({ XDG_CACHE_HOME: "/xdg", HOME: "/home/someone" }),
        ),
      ).toBe(join("/xdg", "common-fabric", "compiled-modules"));
    });

    it("returns undefined when the environment names no home directory", () => {
      expect(connectionCompileCacheDir(environment({ HOME: "" })))
        .toBeUndefined();
    });
  });

  describe("ConnectionCompileCache", () => {
    let dirs: string[];

    beforeEach(() => {
      dirs = [];
    });

    afterEach(async () => {
      for (const dir of dirs) await Deno.remove(dir, { recursive: true });
    });

    /** A new directory, removed after the test. */
    async function scratch(): Promise<string> {
      const dir = await Deno.makeTempDir({ prefix: "cf-compile-cache-test-" });
      dirs.push(dir);
      return dir;
    }

    /** Whether `path` names anything. */
    async function exists(path: string): Promise<boolean> {
      try {
        await Deno.lstat(path);
        return true;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      }
    }

    /** Puts one module through `cache` and reads it back. */
    function roundTrip(cache: ConnectionCompileCache): string | undefined {
      cache.putAll("version", [{ identity: "module", js: "compiled" }]);
      return cache.getCompleteSet("version", ["module"])?.get("module")?.js;
    }

    it("creates its directory only when a compile first asks it for something", async () => {
      const dir = join(await scratch(), "compiled-modules");
      const cache = new ConnectionCompileCache(dir);
      expect(await exists(dir)).toBe(false);

      expect(cache.getCompleteSet("version", ["module"])).toBeUndefined();

      expect(await exists(join(dir, "modules"))).toBe(true);
    });

    it("serves what another cache over its directory put", async () => {
      const dir = join(await scratch(), "compiled-modules");
      roundTrip(new ConnectionCompileCache(dir));

      expect(
        new ConnectionCompileCache(dir).getCompleteSet("version", ["module"])
          ?.get("module")?.js,
      ).toBe("compiled");
    });

    it("keeps modules in memory, and reports why, when its directory cannot be created", async () => {
      const blocker = join(await scratch(), "a-file");
      await Deno.writeTextFile(blocker, "");
      const dir = join(blocker, "compiled-modules");
      const reports: string[] = [];
      const cache = new ConnectionCompileCache(
        dir,
        (message) => reports.push(message),
      );

      expect(roundTrip(cache)).toBe("compiled");

      expect(reports).toHaveLength(1);
      expect(reports[0]).toContain(`${dir} failed`);
      (await cache.take("modules"))();
    });

    it("keeps modules in memory from then on, and reports why once, when locking in its directory fails", async () => {
      const dir = join(await scratch(), "compiled-modules");
      const reports: string[] = [];
      const cache = new ConnectionCompileCache(
        dir,
        (message) => reports.push(message),
      );
      expect(cache.getCompleteSet("version", ["module"])).toBeUndefined();
      await Deno.remove(join(dir, "claims"), { recursive: true });
      await Deno.writeTextFile(join(dir, "claims"), "");

      (await cache.take("modules"))();

      expect(reports).toHaveLength(1);
      expect(reports[0]).toContain(`${dir} failed`);
      expect(roundTrip(cache)).toBe("compiled");
      (await cache.take("modules"))();
      expect(reports).toHaveLength(1);
    });

    it("keeps modules in memory from then on, and reports why, when reading its directory fails", async () => {
      const dir = join(await scratch(), "compiled-modules");
      roundTrip(new ConnectionCompileCache(dir));
      for await (const version of Deno.readDir(join(dir, "modules"))) {
        for await (
          const file of Deno.readDir(join(dir, "modules", version.name))
        ) {
          const path = join(dir, "modules", version.name, file.name);
          await Deno.remove(path);
          await Deno.mkdir(path);
        }
      }
      const reports: string[] = [];
      const cache = new ConnectionCompileCache(
        dir,
        (message) => reports.push(message),
      );

      expect(cache.getCompleteSet("version", ["module"])).toBeUndefined();

      expect(reports).toHaveLength(1);
      expect(reports[0]).toContain(`${dir} failed`);
      expect(roundTrip(cache)).toBe("compiled");
    });

    it("reports once when two turns fail together", async () => {
      const dir = join(await scratch(), "compiled-modules");
      const reports: string[] = [];
      const cache = new ConnectionCompileCache(
        dir,
        (message) => reports.push(message),
      );
      expect(cache.getCompleteSet("version", ["module"])).toBeUndefined();
      await Deno.remove(join(dir, "claims"), { recursive: true });
      await Deno.writeTextFile(join(dir, "claims"), "");

      const turns = await Promise.all([
        cache.take("modules"),
        cache.take("other modules"),
      ]);

      for (const endTurn of turns) endTurn();
      expect(reports).toHaveLength(1);
    });

    it("makes a turn wait for one its process holds for the same modules when the directory fails between them", async () => {
      const dir = join(await scratch(), "compiled-modules");
      const reports: string[] = [];
      const cache = new ConnectionCompileCache(
        dir,
        (message) => reports.push(message),
      );
      const endFirst = await cache.take("modules");
      await Deno.remove(join(dir, "claims"), { recursive: true });
      await Deno.writeTextFile(join(dir, "claims"), "");
      (await cache.take("other modules"))();
      expect(reports).toHaveLength(1);
      let secondStarted = false;
      const secondTurn = cache.take("modules").then((end) => {
        secondStarted = true;
        return end;
      });

      (await cache.take("yet other modules"))();
      expect(secondStarted).toBe(false);

      endFirst();
      (await secondTurn)();
      expect(secondStarted).toBe(true);
      expect(reports).toHaveLength(1);
    });

    it("ends a turn whose report of a failure throws, so that the next turn for the same modules starts", async () => {
      const blocker = join(await scratch(), "a-file");
      await Deno.writeTextFile(blocker, "");
      const cache = new ConnectionCompileCache(
        join(blocker, "compiled-modules"),
        () => {
          throw new Error("the report could not be written");
        },
      );

      await expect(cache.take("modules")).rejects.toThrow(
        "the report could not be written",
      );

      (await cache.take("modules"))();
    });

    it("makes a turn for modules wait for another process's turn for them, and no other", async () => {
      const dir = join(await scratch(), "compiled-modules");
      const first = new ConnectionCompileCache(dir);
      const later = new ConnectionCompileCache(dir);
      const endFirst = await first.take("modules");
      let laterStarted = false;
      const laterTurn = later.take("modules").then((end) => {
        laterStarted = true;
        return end;
      });

      (await later.take("other modules"))();
      expect(laterStarted).toBe(false);

      endFirst();
      (await laterTurn)();
      expect(laterStarted).toBe(true);
    });

    it("takes turns within itself, and with no other cache, when it has no directory", async () => {
      const cache = new ConnectionCompileCache(undefined);
      const other = new ConnectionCompileCache(undefined);
      const endFirst = await cache.take("modules");
      let secondStarted = false;
      const second = cache.take("modules").then((end) => {
        secondStarted = true;
        return end;
      });

      (await other.take("modules"))();
      expect(secondStarted).toBe(false);

      endFirst();
      (await second)();
      expect(secondStarted).toBe(true);
    });

    it("reports nothing when its directory opens", async () => {
      const reports: string[] = [];
      const cache = new ConnectionCompileCache(
        join(await scratch(), "compiled-modules"),
        (message) => reports.push(message),
      );

      expect(roundTrip(cache)).toBe("compiled");

      expect(reports).toEqual([]);
      (await cache.take("modules"))();
    });

    it("is the same cache each time connectionCompileCache() is asked for one directory, and another for another", async () => {
      const first = environment({ XDG_CACHE_HOME: await scratch() });
      const second = environment({ XDG_CACHE_HOME: await scratch() });

      const cache = connectionCompileCache(first);

      expect(connectionCompileCache(first)).toBe(cache);
      expect(connectionCompileCache(second)).not.toBe(cache);
    });
  });

  describe("compiles through a cache that a later process opens", () => {
    let dir: string;
    let signer: Identity;
    let runtimes: Runtime[];
    let storageManagers: ReturnType<typeof StorageManager.emulate>[];

    beforeEach(async () => {
      dir = await Deno.makeTempDir({ prefix: "cf-compile-cache-" });
      signer = await Identity.fromPassphrase("cf connection compile cache");
      runtimes = [];
      storageManagers = [];
    });

    afterEach(async () => {
      for (const runtime of runtimes) await runtime.dispose();
      for (const manager of storageManagers) await manager.close();
      await Deno.remove(dir, { recursive: true });
    });

    /**
     * A runtime over a store of its own, holding a cache of its own over
     * `dir`, as a connection of a separate `cf` process does.
     */
    function connection(): Runtime {
      const storageManager = StorageManager.emulate({ as: signer });
      storageManagers.push(storageManager);
      const cache = new ConnectionCompileCache(dir);
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        moduleByteCache: cache,
        compileTurns: cache,
      });
      runtimes.push(runtime);
      return runtime;
    }

    /** Compiles `program` into `runtime`'s space, as a deploy does. */
    async function deploy(
      runtime: Runtime,
      program: RuntimeProgram,
    ): Promise<void> {
      await runtime.patternManager.compilePattern(program, {
        space: signer.did(),
      });
    }

    it("compiles source an earlier process compiled not at all, and changed source again", async () => {
      await deploy(connection(), programLabeled("unchanged"));
      const later = connection();

      await deploy(later, programLabeled("unchanged"));
      expect(later.patternManager.getCompileCacheStats())
        .toEqual({ hits: 1, misses: 0, byIdentityHits: 0 });

      await deploy(later, programLabeled("changed"));
      expect(later.patternManager.getCompileCacheStats())
        .toEqual({ hits: 1, misses: 1, byIdentityHits: 0 });
    });
  });
});
