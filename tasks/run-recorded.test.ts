import { expect } from "@std/expect";
import { join } from "@std/path";

import { readSpool } from "@commonfabric/test-support/records";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { runRecorded, type Spawn, spawnInherited } from "./run-recorded.ts";

/** A spawner that records what it was asked to start and ends as told. */
function fakeSpawn(
  status: Deno.CommandStatus,
  started: Parameters<Spawn>[] = [],
): Spawn {
  return (...call) => {
    started.push(call);
    return Promise.resolve(status);
  };
}

const PASSED: Deno.CommandStatus = { success: true, code: 0, signal: null };

describe("run-recorded", () => {
  let dir: string;
  let spoolDir: string;
  let errors: string[];
  const error = console.error;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "run-recorded-" });
    spoolDir = join(dir, "spool");
    errors = [];
    console.error = (line: string) => errors.push(line);
  });

  afterEach(async () => {
    console.error = error;
    await Deno.remove(dir, { recursive: true });
  });

  /** An environment joining the run spooled at `spoolDir`. */
  const joined = (extra: Record<string, string> = {}) => (name: string) =>
    name === "CF_TEST_RECORDS_DIR" ? spoolDir : extra[name];

  describe("runRecorded()", () => {
    it("runs the command where the caller stood and records a pass", async () => {
      const started: Parameters<Spawn>[] = [];
      const code = await runRecorded(
        ["gate", "repo", "probe-pass", "--", "probe", "--flag", "value"],
        joined({ INIT_CWD: "/caller/stood/here" }),
        fakeSpawn(PASSED, started),
      );
      expect(code).toBe(0);
      expect(started).toEqual([
        ["probe", ["--flag", "value"], "/caller/stood/here", {}],
      ]);
      const spool = await readSpool(spoolDir);
      expect(spool.records).toEqual([{
        line: "record",
        test: { k: "gate", s: "repo", n: "probe-pass" },
        outcome: "pass",
        durationMs: spool.records[0]!.durationMs,
      }]);
      expect(errors).toEqual([]);
    });

    it("runs the command in its own working directory when no caller directory is named", async () => {
      const started: Parameters<Spawn>[] = [];
      await runRecorded(
        ["gate", "repo", "probe", "--", "probe"],
        joined({ INIT_CWD: "" }),
        fakeSpawn(PASSED, started),
      );
      expect(started[0]![2]).toBe(Deno.cwd());
    });

    it("returns the command's exit code and records a fail", async () => {
      const code = await runRecorded(
        ["gate", "repo", "probe-fail", "--", "probe"],
        joined(),
        fakeSpawn({ success: false, code: 3, signal: null }),
      );
      expect(code).toBe(3);
      const spool = await readSpool(spoolDir);
      expect(spool.records.map((record) => record.outcome)).toEqual(["fail"]);
    });

    it("reports the signal that terminated the command", async () => {
      const code = await runRecorded(
        ["gate", "repo", "probe-signal", "--", "/bin/sh"],
        joined(),
        fakeSpawn({ success: false, code: 143, signal: "SIGTERM" }),
      );
      expect(code).toBe(143);
      expect(errors).toEqual([
        "run-recorded: `/bin/sh` terminated by `SIGTERM`.",
      ]);
      const spool = await readSpool(spoolDir);
      expect(spool.records.map((record) => record.outcome)).toEqual(["fail"]);
    });

    it("returns 127 and records a fail for a command that cannot start", async () => {
      const code = await runRecorded(
        ["gate", "repo", "probe-missing", "--", "/no/such/binary"],
        joined(),
        () => Promise.reject(new Deno.errors.NotFound("no such binary")),
      );
      expect(code).toBe(127);
      expect(errors).toEqual([
        "run-recorded: cannot run /no/such/binary: NotFound: no such binary",
      ]);
      const spool = await readSpool(spoolDir);
      expect(spool.records.map((record) => record.outcome)).toEqual(["fail"]);
    });

    it("runs the command and records nothing with recording off", async () => {
      const started: Parameters<Spawn>[] = [];
      const code = await runRecorded(
        ["gate", "repo", "probe", "--", "probe"],
        () => undefined,
        fakeSpawn(PASSED, started),
      );
      expect(code).toBe(0);
      expect(started.length).toBe(1);
      expect((await readSpool(spoolDir)).records).toEqual([]);
    });

    for (
      const [what, args] of [
        ["an empty identity component", ["gate", "", "probe", "--", "probe"]],
        ["a missing name", ["gate", "repo"]],
        ["no separator", ["gate", "repo", "probe", "probe"]],
        ["no command", ["gate", "repo", "probe", "--"]],
      ] as const
    ) {
      it(`returns 2, prints the usage, and runs nothing for ${what}`, async () => {
        const started: Parameters<Spawn>[] = [];
        const code = await runRecorded(
          args,
          joined(),
          fakeSpawn(PASSED, started),
        );
        expect(code).toBe(2);
        expect(errors).toEqual([
          "usage: deno task run-recorded <kind> <scope> <name> -- <command...>",
        ]);
        expect(started).toEqual([]);
        expect((await readSpool(spoolDir)).records).toEqual([]);
      });
    }
  });

  describe("spawnInherited()", () => {
    it("resolves to the exit code of the command it started", async () => {
      const status = await spawnInherited(
        Deno.execPath(),
        ["eval", "Deno.exit(Deno.env.get('PROBE') === 'set' ? 3 : 4)"],
        dir,
        { PROBE: "set" },
      );
      expect(status.code).toBe(3);
      expect(status.signal).toBeNull();
    });

    it("rejects for a command that does not exist", async () => {
      await expect(spawnInherited("/no/such/binary", [], dir, {})).rejects
        .toThrow(Deno.errors.NotFound);
    });
  });
});
