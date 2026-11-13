import { assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import {
  CacheFile,
  dashboardCacheDirectory,
  dashboardCacheFile,
  replaceFile,
} from "./history-files.ts";

function environment(
  values: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => values[name];
}

Deno.test("dashboard cache files use fixed names in one configured directory", () => {
  const directory = "configured-dashboard-cache";
  const env = environment({
    DASHBOARD_CACHE_DIR: directory,
  });

  assertEquals(
    dashboardCacheDirectory(env),
    directory,
  );
  assertEquals(
    dashboardCacheFile("fabric-wall-discord-history.json", env),
    join(directory, "fabric-wall-discord-history.json"),
  );
  assertEquals(
    dashboardCacheFile("fabric-wall-ci-run-index.json", env),
    join(directory, "fabric-wall-ci-run-index.json"),
  );
  assertEquals(
    dashboardCacheFile("fabric-wall-benchmark-history.json", env),
    join(directory, "fabric-wall-benchmark-history.json"),
  );
  assertEquals(
    dashboardCacheFile("fabric-wall-github-rate-limit.json", env),
    join(directory, "fabric-wall-github-rate-limit.json"),
  );
  assertEquals(
    dashboardCacheFile(
      "fabric-wall-github-members-commonfabric-history.json",
      env,
    ),
    join(
      directory,
      "fabric-wall-github-members-commonfabric-history.json",
    ),
  );
});

Deno.test("dashboard cache files default to the temp directory", () => {
  const directory = "platform-temp";
  const env = environment({ TMPDIR: directory });
  assertEquals(dashboardCacheDirectory(env), directory);
  assertEquals(
    dashboardCacheFile("fabric-wall-ci-run-index.json", env),
    join(directory, "fabric-wall-ci-run-index.json"),
  );
});

Deno.test("dashboard cache files recognize Windows temp variables", () => {
  assertEquals(
    dashboardCacheDirectory(environment({ TEMP: "windows-temp" })),
    "windows-temp",
  );
  assertEquals(
    dashboardCacheDirectory(environment({ TMP: "windows-tmp" })),
    "windows-tmp",
  );
  assertEquals(
    dashboardCacheDirectory(environment({
      TMPDIR: "posix-temp",
      TEMP: "windows-temp",
      TMP: "windows-tmp",
    })),
    "posix-temp",
  );
  assertEquals(
    dashboardCacheDirectory(environment({})),
    Deno.build.os === "windows" ? "." : "/tmp",
  );
});

describe("history-files", () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await Deno.makeTempDir({ prefix: "history-files-" });
    path = join(directory, "cache.json");
  });

  afterEach(async () => {
    await Deno.remove(directory, { recursive: true });
  });

  /** The names in the directory, sorted. */
  async function names(): Promise<string[]> {
    const found: string[] = [];
    for await (const entry of Deno.readDir(directory)) found.push(entry.name);
    return found.sort();
  }

  const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

  describe("CacheFile", () => {
    describe("instance members", () => {
      describe("locked()", () => {
        it("returns what its body returns, once leftover temporary files are removed", async () => {
          await Deno.writeTextFile(join(directory, `cache.json.${ID}.tmp`), "");

          const seen = await new CacheFile(path).locked(names);

          expect(seen).toEqual(["cache.json.lock"]);
        });
      });

      describe("isUnchanged()", () => {
        it("returns `true` for the version it last wrote, and `false` once another instance replaces it", async () => {
          const file = new CacheFile(path);
          await file.write("text");

          expect(await file.isUnchanged()).toBe(true);

          await new CacheFile(path).write("text");

          expect(await file.isUnchanged()).toBe(false);
        });

        it("returns `true` for the version it last read", async () => {
          await new CacheFile(path).write("text");
          const file = new CacheFile<string>(path);

          expect(await file.isUnchanged()).toBe(false);

          await file.read(String);

          expect(await file.isUnchanged()).toBe(true);
        });

        it("returns `false` after a read whose decoding threw", async () => {
          await new CacheFile(path).write("text");
          const file = new CacheFile<string>(path);

          await expect(file.read(() => {
            throw new Error("undecodable");
          })).rejects.toThrow("undecodable");

          expect(await file.isUnchanged()).toBe(false);
        });

        it("returns `false` once the file is removed", async () => {
          const file = new CacheFile(path);
          await file.write("text");
          await Deno.remove(path);

          expect(await file.isUnchanged()).toBe(false);
        });
      });

      describe("read()", () => {
        it("returns what its decoder makes of the text written", async () => {
          await new CacheFile(path).write("text");

          expect(await new CacheFile<number>(path).read((text) => text.length))
            .toBe(4);
        });

        it("returns `undefined` when there is no file", async () => {
          expect(await new CacheFile<string>(path).read(String))
            .toBeUndefined();
        });

        it("rejects when the file cannot be opened for a reason other than its absence", async () => {
          await Deno.writeTextFile(path, "text");

          await expect(new CacheFile<string>(join(path, "child")).read(String))
            .rejects.toThrow(Deno.errors.NotADirectory);
        });

        it("returns the value given to `write()` without decoding, until another instance replaces the file", async () => {
          const file = new CacheFile<string>(path);
          await file.write("text", "given");
          const decoded: string[] = [];
          const decode = (text: string) => {
            decoded.push(text);
            return `decoded ${text}`;
          };

          expect(await file.read(decode)).toBe("given");
          expect(decoded).toEqual([]);

          await new CacheFile(path).write("other");

          expect(await file.read(decode)).toBe("decoded other");
          expect(await file.read(decode)).toBe("decoded other");
          expect(decoded).toEqual(["other"]);
        });

        it("decodes once for reads made together", async () => {
          await new CacheFile(path).write("text");
          const file = new CacheFile<string>(path);
          let decodes = 0;
          const decode = (text: string) => {
            decodes++;
            return text;
          };

          const values = await Promise.all([
            file.read(decode),
            file.read(decode),
            file.read(decode),
          ]);

          expect(values).toEqual(["text", "text", "text"]);
          expect(decodes).toBe(1);
        });
      });

      describe("removeLeftoverTemporaries()", () => {
        it("removes the temporary files written for the file, and nothing else", async () => {
          const kept = [
            "cache.json",
            "cache.json.lock",
            `cache.json.${ID}.reservation.lock`,
            "cache.json.notes.tmp",
            "cache.json.tmp",
            `cache.jsonl.${ID}.tmp`,
            `other.json.${ID}.tmp`,
          ];
          for (const name of [...kept, `cache.json.${ID}.tmp`]) {
            await Deno.writeTextFile(join(directory, name), "");
          }
          await Deno.writeTextFile(join(directory, `cache.json.tmp-${ID}`), "");

          await new CacheFile(path).removeLeftoverTemporaries();

          expect(await names()).toEqual(kept.sort());
        });

        it("removes nothing the second time it is called", async () => {
          const file = new CacheFile(path);
          await file.removeLeftoverTemporaries();
          await Deno.writeTextFile(join(directory, `cache.json.${ID}.tmp`), "");

          await file.removeLeftoverTemporaries();

          expect(await names()).toEqual([`cache.json.${ID}.tmp`]);
        });

        it("returns when the directory does not exist", async () => {
          await new CacheFile(join(directory, "absent", "cache.json"))
            .removeLeftoverTemporaries();

          expect(await names()).toEqual([]);
        });

        it("logs a temporary file it cannot remove, and returns", async () => {
          await Deno.writeTextFile(join(directory, `cache.json.${ID}.tmp`), "");
          const logged: string[] = [];
          const realError = console.error;
          const realRemove = Deno.remove;
          console.error = (...parts: unknown[]) =>
            void logged.push(parts.map(String).join(" "));
          Deno.remove = () =>
            Promise.reject(new Deno.errors.PermissionDenied("cannot remove"));
          try {
            await new CacheFile(path).removeLeftoverTemporaries();
          } finally {
            console.error = realError;
            Deno.remove = realRemove;
          }

          expect(logged).toHaveLength(1);
          expect(logged[0]).toContain(`cache.json.${ID}.tmp`);
          expect(logged[0]).toContain("cannot remove");
        });
      });

      describe("write()", () => {
        it("replaces the file, leaving no temporary file", async () => {
          await Deno.writeTextFile(path, "old");

          await new CacheFile(path).write("new");

          expect(await Deno.readTextFile(path)).toBe("new");
          expect(await names()).toEqual(["cache.json"]);
        });

        it("rejects, leaving no temporary file, when it cannot replace the file", async () => {
          await Deno.mkdir(join(path, "in-the-way"), { recursive: true });

          await expect(new CacheFile(path).write("new")).rejects.toThrow();

          expect(await names()).toEqual(["cache.json"]);
        });
      });
    });
  });

  describe("replaceFile()", () => {
    it("replaces the file with exactly the bytes given, leaving no temporary file", async () => {
      await Deno.writeTextFile(path, "old");
      const bytes = new Uint8Array([0, 0xff, 0xfe, 0x0a, 0x80]);

      const info = await replaceFile(path, bytes);

      expect(await Deno.readFile(path)).toEqual(bytes);
      expect(info.size).toBe(bytes.length);
      expect(info.ino).toBe((await Deno.stat(path)).ino);
      expect(await names()).toEqual(["cache.json"]);
    });
  });
});
