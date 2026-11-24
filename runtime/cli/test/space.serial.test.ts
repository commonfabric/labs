/**
 * Runs `cf space compact` and `cf space reap` in-process through the parsed
 * command, with `console.log` replaced to read what they print, and runs
 * `runReap()` with a stand-in check.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ValidationError } from "@cliffy/command";
import { Database } from "@db/sqlite";
import { toFileUrl } from "@std/path";
import { close, open } from "@commonfabric/memory/v2/engine";
import { ReapRefused } from "@commonfabric/memory/v2/reap";
import { verifyReap } from "@commonfabric/state-inspector";

import { runReap, space } from "../commands/space.ts";
import { REAP_OWNER, REAP_SPACE, reapSpaceStore } from "./space-reap-store.ts";
import { exists } from "./utils.ts";

/** A store the engine opened and wrote nothing to. */
async function emptyStore(path: string): Promise<void> {
  close(await open({ url: toFileUrl(path) }));
}

/** An SQLite database holding none of a store's tables. */
function foreignDatabase(path: string): void {
  const db = new Database(path, { create: true });
  db.exec("CREATE TABLE unrelated (x INTEGER)");
  db.close();
}

describe("space", () => {
  let root: string;
  let printed: string[];
  const originalLog = console.log;

  /** Parses `args` as `cf space` arguments and runs the command. */
  const run = (args: string[]) => space.reset().throwErrors().parse(args);

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: "cf-space-serial-" });
    printed = [];
    console.log = (...args: unknown[]) => {
      printed.push(args.join(" "));
    };
  });

  afterEach(async () => {
    console.log = originalLog;
    await Deno.remove(root, { recursive: true });
  });

  describe("compact", () => {
    it("throws a `ValidationError` naming a store that is not there, for a run and for a verification", async () => {
      const missing = `${root}/missing.sqlite`;
      await expect(run(["compact", missing, "--documents", "of:"])).rejects
        .toThrow(new ValidationError(`no store at ${missing}`));
      const store = `${root}/store.sqlite`;
      await emptyStore(store);
      await expect(
        run(["compact", store, "--verify", "--against", missing]),
      ).rejects.toThrow(new ValidationError(`no store at ${missing}`));
      await expect(
        run(["compact", missing, "--verify", "--against", store]),
      ).rejects.toThrow(new ValidationError(`no store at ${missing}`));
    });

    it("throws a `ValidationError` for a `--scope` that is not a scope kind", async () => {
      const store = `${root}/store.sqlite`;
      await emptyStore(store);
      await expect(
        run(["compact", store, "--documents", "of:", "--scope", "global"]),
      ).rejects.toThrow(
        new ValidationError(
          "--scope takes space, user or session, not global",
        ),
      );
    });

    it("throws a `ValidationError` for a `--keep-payloads` that is not a number and a unit", async () => {
      const store = `${root}/store.sqlite`;
      await emptyStore(store);
      for (const keep of ["7w", "d", "1.5h"]) {
        await expect(
          run([
            "compact",
            store,
            "--documents",
            "of:",
            "--keep-payloads",
            keep,
          ]),
        ).rejects.toThrow(
          new ValidationError(
            `--keep-payloads takes a number and a unit (ms, s, m, h, d), not ${keep}`,
          ),
        );
      }
    });

    it("plans a store of the scope and window given, printing the plan", async () => {
      const store = `${root}/store.sqlite`;
      await reapSpaceStore(store, false);
      const db = new Database(store);
      db.exec(`UPDATE "commit" SET created_at = '2026-01-02 03:00:00'`);
      db.close();
      await run([
        "compact",
        store,
        "--documents",
        "of:",
        "--scope",
        "user",
        "--keep-payloads",
        "90m",
        "--dry-run",
      ]);
      const lines = printed.join("\n").split("\n");
      expect(lines).toContain("selection  of:  scope=user");
      expect(
        lines.find((line) => line.startsWith("payloads ")),
      ).toContain("(created after 2026-01-02 01:30:00)");
      expect(lines.at(-1)).toBe(
        "schema     current; a run would open this store without migrating it",
      );
    });

    it("passes on an error of a dry run's planner that is not about an option, as other than a `ValidationError`", async () => {
      const store = `${root}/foreign.sqlite`;
      foreignDatabase(store);
      const attempt = run([
        "compact",
        store,
        "--documents",
        "of:",
        "--dry-run",
      ]);
      await expect(attempt).rejects.toThrow();
      await expect(attempt).rejects.not.toBeInstanceOf(ValidationError);
    });

    it("throws a `ValidationError` for a store the run refuses, and passes on another error as it is", async () => {
      const legacy = `${root}/legacy.sqlite`;
      const db = new Database(legacy, { create: true });
      db.exec(`
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
      db.close();
      await expect(
        run([
          "compact",
          legacy,
          "--documents",
          "of:",
          "--out",
          `${root}/a.sqlite`,
        ]),
      ).rejects.toBeInstanceOf(ValidationError);

      const notSqlite = `${root}/not-sqlite.sqlite`;
      await Deno.writeTextFile(notSqlite, "not a database");
      const attempt = run([
        "compact",
        notSqlite,
        "--documents",
        "of:",
        "--out",
        `${root}/b.sqlite`,
      ]);
      await expect(attempt).rejects.toThrow();
      await expect(attempt).rejects.not.toBeInstanceOf(ValidationError);
    });

    it("throws a `ValidationError` for a result whose directory does not exist", async () => {
      const store = `${root}/store.sqlite`;
      await emptyStore(store);
      const out = `${root}/absent/result.sqlite`;
      await expect(
        run(["compact", store, "--documents", "of:", "--out", out]),
      ).rejects.toThrow(
        new ValidationError(`the directory of ${out} does not exist`),
      );
    });
  });

  describe("reap", () => {
    it("throws a `ValidationError` naming a store that is not there", async () => {
      const missing = `${root}/missing.sqlite`;
      await expect(run(["reap", missing, "--dry-run"])).rejects.toThrow(
        new ValidationError(`no store at ${missing}`),
      );
    });

    it("passes on an error reading the live directory as it is, other than a `ValidationError`", async () => {
      const store = `${root}/space.sqlite`;
      await reapSpaceStore(store, true);
      const attempt = run([
        "reap",
        store,
        "--dry-run",
        "--live",
        `${root}/absent/${REAP_SPACE}.sqlite`,
      ]);
      await expect(attempt).rejects.toBeInstanceOf(Deno.errors.NotFound);
      expect(printed).toEqual([]);
    });

    it("throws a `ValidationError` for a store that holds no deletion, writing no result, and passes on another error as it is", async () => {
      const store = `${root}/live.sqlite`;
      await emptyStore(store);
      const out = `${root}/live.reaped.sqlite`;
      await expect(run(["reap", store, "--out", out])).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(await exists(out)).toBe(false);

      const notSqlite = `${root}/not-sqlite.sqlite`;
      await Deno.writeTextFile(notSqlite, "not a database");
      const attempt = run(["reap", notSqlite]);
      await expect(attempt).rejects.toThrow();
      await expect(attempt).rejects.not.toBeInstanceOf(ValidationError);
    });
  });

  describe("runReap()", () => {
    // Each case runs the real reap and replaces only the check, which a
    // correct reap always passes. A failed check leaves `Deno.exitCode`, which
    // each case starts at 0 and restores afterwards.

    let savedExitCode: number;

    /** The files a run staged beside its result and left behind. */
    const stagedFiles = async (): Promise<string[]> =>
      (await Array.fromAsync(Deno.readDir(root)))
        .map((entry) => entry.name)
        .filter((name) => name.includes(".staging-"));

    beforeEach(() => {
      savedExitCode = Deno.exitCode;
      Deno.exitCode = 0;
    });

    afterEach(() => {
      Deno.exitCode = savedExitCode;
    });

    it("discards a result that fails its check, prints the plan and the failed check, and sets the exit status to 1", async () => {
      const store = `${root}/space.sqlite`;
      await reapSpaceStore(store, true);
      const out = `${root}/space.reaped.sqlite`;
      const failing: typeof verifyReap = (options) => {
        const verification = verifyReap(options);
        return {
          ...verification,
          ok: false,
          checks: [
            ...verification.checks,
            { name: "planted", passed: false, detail: "planted failure" },
          ],
        };
      };
      await runReap(store, { out }, failing);
      expect(Deno.exitCode).toBe(1);
      expect(await stagedFiles()).toEqual([]);
      expect(await exists(out)).toBe(false);
      const text = printed.join("\n");
      expect(text).toContain("planted failure");
      expect(text).toContain(
        `space      ${REAP_SPACE}, deleted by ${REAP_OWNER}`,
      );
      expect(text).not.toContain(`result     ${out} (`);
    });

    it("discards the staged file and throws a `ValidationError` when the check refuses the result", async () => {
      const store = `${root}/space.sqlite`;
      await reapSpaceStore(store, true);
      const out = `${root}/space.reaped.sqlite`;
      const refusing: typeof verifyReap = () => {
        throw new ReapRefused("the check refused the result");
      };
      await expect(runReap(store, { out }, refusing)).rejects.toThrow(
        new ValidationError("the check refused the result"),
      );
      expect(await stagedFiles()).toEqual([]);
      expect(await exists(out)).toBe(false);
      expect(Deno.exitCode).toBe(0);
      expect(printed).toEqual([]);
    });

    it("discards the staged file and passes on another error of the check as it is", async () => {
      const store = `${root}/space.sqlite`;
      await reapSpaceStore(store, true);
      const out = `${root}/space.reaped.sqlite`;
      const failure = new RangeError("the check broke");
      const breaking: typeof verifyReap = () => {
        throw failure;
      };
      await expect(runReap(store, { out }, breaking)).rejects.toBe(
        failure,
      );
      expect(await stagedFiles()).toEqual([]);
      expect(await exists(out)).toBe(false);
      expect(Deno.exitCode).toBe(0);
    });
  });
});
