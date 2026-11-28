import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";

import {
  collectRecords,
  gather,
  headCommitOfEvent,
  parseGatherArgs,
  runGatherCommand,
} from "./test-records-gather.ts";
import {
  createRunSpool,
  FragmentWriter,
  type HeldSpool,
  parseRecordLine,
  RECORD_SCHEMA_VERSION,
  RECORDS_DIR_VARIABLE,
  type RegisteredLine,
  type ResultLine,
  ResultsWriter,
} from "@commonfabric/test-support/records";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

/** Writes `lines` into the spool `dir`, as one test file's module does. */
function writeResults(
  dir: string,
  lines: readonly (RegisteredLine | ResultLine)[],
): void {
  const writer = ResultsWriter.openForRun((name) =>
    name === RECORDS_DIR_VARIABLE ? dir : undefined
  )!;
  for (const line of lines) writer.write(line);
  writer.close();
}

/**
 * Writes one record, for the `fmt` gate, into a new spool under `dir` and
 * returns the spool.
 */
async function spoolOneRecord(dir: string): Promise<string> {
  const spool = join(dir, "spool");
  await Deno.mkdir(spool);
  const writer = FragmentWriter.open(spool);
  writer?.append({
    line: "record",
    test: { k: "gate", s: "repo", n: "fmt" },
    outcome: "pass",
    durationMs: 3,
  });
  writer?.close();
  return spool;
}

/** One results line for `name` in `runtime/bakery/oven.test.ts`. */
function result(
  name: string[],
  fields: Partial<ResultLine> = {},
): ResultLine {
  return {
    line: "result",
    file: "runtime/bakery/oven.test.ts",
    name,
    outcome: "pass",
    durationMs: 1000,
    ...fields,
  };
}

describe("test-records-gather", () => {
  describe("headCommitOfEvent()", () => {
    it("returns the pull request head sha", () => {
      expect(
        headCommitOfEvent({ pull_request: { head: { sha: "abc123" } } }),
      ).toBe("abc123");
    });

    it("returns undefined for a push payload", () => {
      expect(headCommitOfEvent({ pusher: {} })).toBeUndefined();
    });

    it("returns undefined for a payload that is not an object", () => {
      expect(headCommitOfEvent(null)).toBeUndefined();
      expect(headCommitOfEvent("pull_request")).toBeUndefined();
    });

    it("returns undefined for a pull request that names no head", () => {
      expect(headCommitOfEvent({ pull_request: { number: 1 } }))
        .toBeUndefined();
    });
  });

  describe("gather()", () => {
    let dir: string;
    let held: HeldSpool | undefined;

    beforeEach(async () => {
      dir = await Deno.makeTempDir({ prefix: "test-records-gather-" });
      held = undefined;
    });

    afterEach(async () => {
      held?.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    });

    it("writes job facts and the records of the spool", async () => {
      const spoolRoot = join(dir, "spool");
      held = await createRunSpool(spoolRoot, {
        schema: RECORD_SCHEMA_VERSION,
        line: "context",
        reportId: "01GATHERTEST000000000000",
        repo: "commonfabric/labs",
        commit: "c".repeat(40),
        dirty: false,
        env: "ci",
        os: "linux",
        arch: "x86_64",
        denoVersion: "2.9.4",
        startedAt: "2026-08-17T21:00:00.000Z",
      });
      const writer = FragmentWriter.open(held.dir);
      writer?.append({
        line: "record",
        test: { k: "gate", s: "repo", n: "check-docs" },
        outcome: "pass",
        durationMs: 1500,
      });
      writer?.close();

      const out = join(dir, "out");
      await gather({
        out,
        job: "Test (3/8)",
        shard: "3/8",
        variant: "wood-fired",
        spoolDir: held.dir,
      });

      const facts = JSON.parse(
        await Deno.readTextFile(join(out, "job.json")),
      );
      expect(facts.job).toBe("Test (3/8)");
      expect(facts.shard).toBe("3/8");
      expect(facts.denoVersion).toBe(Deno.version.deno);
      expect(Number.isSafeInteger(facts.shuffleSeed)).toBe(true);

      const lines = (await Deno.readTextFile(join(out, "records.ndjson")))
        .trimEnd().split("\n");
      expect(lines.map((line) => parseRecordLine(line))).toEqual([{
        line: "record",
        test: { k: "gate", s: "repo", n: "check-docs", v: "wood-fired" },
        outcome: "pass",
        durationMs: 1500,
      }]);
    });

    it("writes an empty records file when there is nothing to gather", async () => {
      const out = join(dir, "out");
      await gather({ out, job: "Check" });
      expect(await Deno.readTextFile(join(out, "records.ndjson"))).toBe("");
      const facts = JSON.parse(
        await Deno.readTextFile(join(out, "job.json")),
      );
      expect(facts.job).toBe("Check");
    });

    it("rejects an empty variant from a direct caller", async () => {
      await expect(
        gather({ out: join(dir, "out"), job: "Check", variant: "" }),
      ).rejects.toThrow("a declared variant must not be empty");
    });

    it("records the commit, branch, and pull request head from the environment", async () => {
      const out = join(dir, "out");
      const eventPath = join(dir, "event.json");
      await Deno.writeTextFile(
        eventPath,
        JSON.stringify({ pull_request: { head: { sha: "f".repeat(40) } } }),
      );
      await gather({
        out,
        job: "Check",
        env: (name) => {
          if (name === "GITHUB_SHA") return "a".repeat(40);
          if (name === "GITHUB_HEAD_REF") return "feature-branch";
          if (name === "GITHUB_EVENT_PATH") return eventPath;
          if (name === "CF_TEST_SHUFFLE_SEED") return "7";
          return undefined;
        },
      });
      const facts = JSON.parse(
        await Deno.readTextFile(join(out, "job.json")),
      );
      expect(facts.commit).toBe("a".repeat(40));
      expect(facts.branch).toBe("feature-branch");
      expect(facts.headCommit).toBe("f".repeat(40));
      // The seed a job's runners shuffled by, which an override the job
      // set decides.
      expect(facts.shuffleSeed).toBe(7);
    });

    it("records no head commit where the event payload is not JSON", async () => {
      // The payload is context the job may lack, so a payload this cannot
      // read costs the one fact it would have given and nothing else.

      const out = join(dir, "out");
      const eventPath = join(dir, "event.json");
      await Deno.writeTextFile(eventPath, "{not json");
      await gather({
        out,
        job: "Check",
        env: (name) => {
          if (name === "GITHUB_SHA") return "a".repeat(40);
          if (name === "GITHUB_EVENT_PATH") return eventPath;
          return undefined;
        },
      });
      const facts = JSON.parse(
        await Deno.readTextFile(join(out, "job.json")),
      );
      expect(facts.commit).toBe("a".repeat(40));
      expect(facts.headCommit).toBeUndefined();
    });
  });

  describe("collectRecords()", () => {
    it("returns every record of a spool holding half a million", async () => {
      // A spool holds a record for every test its job ran, and a job can
      // run more tests than one call takes as arguments.
      const dir = await Deno.makeTempDir({ prefix: "test-records-gather-" });
      const count = 500_000;
      try {
        const writer = FragmentWriter.open(dir);
        for (let at = 0; at < count; at++) {
          writer?.append({
            line: "record",
            test: { k: "unit", s: "cli", n: `bakes ${at}` },
            outcome: "pass",
            durationMs: 1,
          });
        }
        writer?.close();
        const { records } = await collectRecords({ spoolDir: dir });
        expect(records.length).toBe(count);
        expect(records.at(-1)?.test.n).toBe(`bakes ${count - 1}`);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    describe("reading the results its tests wrote", () => {
      let dir: string;

      // An outermost group holding a test that passes and one that fails,
      // which finishes last, as a group does.
      beforeEach(async () => {
        dir = await Deno.makeTempDir({ prefix: "test-records-gather-" });
        writeResults(dir, [
          {
            line: "registered",
            file: "runtime/bakery/oven.test.ts",
            names: [["oven"], ["oven", "bakes"], ["oven", "burns"]],
          },
          result(["oven", "bakes"], { durationMs: 1500 }),
          result(["oven", "burns"], {
            outcome: "fail",
            failure: "Error: smoke",
          }),
          result(["oven"], { durationMs: 5000, container: true }),
        ]);
      });

      afterEach(async () => {
        await Deno.remove(dir, { recursive: true });
      });

      it("returns a record for each test, under the kind and scope it is given", async () => {
        const { records } = await collectRecords({
          spoolDir: dir,
          results: { kind: "integration", scope: "bakery" },
        });
        expect(records).toEqual([
          {
            line: "record",
            test: { k: "integration", s: "bakery", n: "oven > bakes" },
            outcome: "pass",
            durationMs: 1500,
            file: "runtime/bakery/oven.test.ts",
          },
          {
            line: "record",
            test: { k: "integration", s: "bakery", n: "oven > burns" },
            outcome: "fail",
            durationMs: 1000,
            file: "runtime/bakery/oven.test.ts",
          },
        ]);
      });

      it("returns no record from the results where it is given no kind and scope", async () => {
        const collected = await collectRecords({ spoolDir: dir });
        expect(collected.records).toEqual([]);
        expect(collected.hooks).toEqual([]);
      });

      it("returns a passing group as a record only where the caller knows it", async () => {
        const named = async (known: boolean) =>
          (await collectRecords({
            spoolDir: dir,
            results: { kind: "unit", scope: "bakery" },
            known: (test) => known && test.n === "oven",
          })).records.map((record) => [record.test.n, record.durationMs]);
        // The group takes what it spent outside the tests inside it.
        expect(await named(true)).toEqual([
          ["oven > bakes", 1500],
          ["oven > burns", 1000],
          ["oven", 2500],
        ]);
        expect(await named(false)).toEqual([
          ["oven > bakes", 1500],
          ["oven > burns", 1000],
        ]);
      });

      it("returns what each outermost group's hooks took, in the declared variant", async () => {
        const { records, hooks } = await collectRecords({
          spoolDir: dir,
          results: { kind: "integration", scope: "bakery" },
          variant: "wood-fired",
        });
        expect(records.map((record) => record.test.v)).toEqual([
          "wood-fired",
          "wood-fired",
        ]);
        expect(hooks).toEqual([{
          line: "record",
          test: { k: "integration", s: "bakery", n: "oven", v: "wood-fired" },
          outcome: "pass",
          durationMs: 2500,
          file: "runtime/bakery/oven.test.ts",
        }]);
      });

      it("returns the message each failing record's test threw, in the declared variant", async () => {
        const { records, failures } = await collectRecords({
          spoolDir: dir,
          results: { kind: "unit", scope: "bakery" },
          variant: "wood-fired",
        });
        const burns = records.find((record) =>
          record.test.n === "oven > burns"
        )!;
        expect(burns.test.v).toBe("wood-fired");
        expect([...failures]).toEqual([[burns, "Error: smoke"]]);
      });

      it("warns about a results line it cannot read, and returns the rest", async () => {
        await Deno.writeTextFile(
          join(dir, "results-torn.ndjson"),
          "not a line\n" + JSON.stringify(result(["proofs"])) + "\n",
        );
        const warned: string[] = [];
        const warn = console.warn;
        console.warn = (line: string) => warned.push(line);
        try {
          const { records } = await collectRecords({
            spoolDir: dir,
            results: { kind: "unit", scope: "bakery" },
          });
          expect(records.map((record) => record.test.n)).toContain("proofs");
        } finally {
          console.warn = warn;
        }
        expect(warned).toEqual([
          "test records: dropped a line no reader accepts in results-torn.ndjson",
        ]);
      });
    });
  });

  describe("runGatherCommand()", () => {
    let dir: string;
    let errors: string[];
    let warnings: string[];
    const error = console.error;
    const warn = console.warn;

    beforeEach(async () => {
      dir = await Deno.makeTempDir({ prefix: "test-records-gather-cli-" });
      errors = [];
      warnings = [];
      console.error = (line: string) => errors.push(line);
      console.warn = (line: string) => warnings.push(line);
    });

    afterEach(async () => {
      console.error = error;
      console.warn = warn;
      await Deno.remove(dir, { recursive: true });
    });

    it("gathers the spool and the facts its environment names into the output directory", async () => {
      const variables: Record<string, string> = {
        [RECORDS_DIR_VARIABLE]: await spoolOneRecord(dir),
        GITHUB_SHA: "abc123",
      };
      const out = join(dir, "artifact");
      const code = await runGatherCommand(
        ["--out", out, "--job", "Probe", "--shard", "2/4"],
        (name) => variables[name],
      );
      expect(code).toBe(0);
      const facts = JSON.parse(await Deno.readTextFile(join(out, "job.json")));
      expect(facts.job).toBe("Probe");
      expect(facts.shard).toBe("2/4");
      expect(facts.commit).toBe("abc123");
      const lines = (await Deno.readTextFile(join(out, "records.ndjson")))
        .trimEnd().split("\n");
      expect(lines.map((line) => parseRecordLine(line)?.test.n)).toEqual([
        "fmt",
      ]);
      expect(errors).toEqual([]);
    });

    it("gathers no records when its environment names no spool", async () => {
      const out = join(dir, "artifact");
      const code = await runGatherCommand(
        ["--out", out, "--job", "Probe"],
        (name) => name === RECORDS_DIR_VARIABLE ? "" : undefined,
      );
      expect(code).toBe(0);
      const facts = JSON.parse(await Deno.readTextFile(join(out, "job.json")));
      expect(facts.job).toBe("Probe");
      expect(facts.commit).toBeUndefined();
      expect(await Deno.readTextFile(join(out, "records.ndjson"))).toBe("");
      expect(errors).toEqual([]);
    });

    it("returns 2 and prints the usage for a command line that names no output directory", async () => {
      expect(await runGatherCommand(["--job", "Probe"], () => undefined))
        .toBe(2);
      expect(errors).toEqual([
        "usage: test-records-gather.ts --out <dir> --job <name> " +
        "[--shard <label>] [--variant <name>]",
      ]);
    });

    it("returns 0 and warns when gathering fails", async () => {
      // An output directory under a regular file cannot be created.

      const file = join(dir, "file");
      await Deno.writeTextFile(file, "");
      const code = await runGatherCommand(
        ["--out", join(file, "artifact"), "--job", "Probe"],
        () => undefined,
      );
      expect(code).toBe(0);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/^test records: gathering failed: /);
    });
  });

  describe("as a program", () => {
    // The ship step runs the script with the permissions below and reads only
    // its exit status and the artifact it writes.

    /** Runs the script with `args`, naming `spool` as the spool to gather. */
    async function runScript(
      args: string[],
      spool: string,
    ): Promise<Deno.CommandOutput> {
      const root = fromFileUrl(new URL("..", import.meta.url));
      return await runDenoCommandWithTemporaryLock({
        root,
        args: (lockPath) => [
          "run",
          "--config",
          join(root, "deno.jsonc"),
          "--lock",
          lockPath,
          "--allow-read",
          "--allow-write",
          "--allow-env",
          "--allow-run=git",
          join(root, "tasks/test-records-gather.ts"),
          ...args,
        ],
        env: { [RECORDS_DIR_VARIABLE]: spool },
      });
    }

    let dir: string;

    beforeEach(async () => {
      dir = await Deno.makeTempDir({ prefix: "test-records-gather-program-" });
    });

    afterEach(async () => {
      await Deno.remove(dir, { recursive: true });
    });

    it("exits 0 and gathers the spool its environment names", async () => {
      const spool = await spoolOneRecord(dir);
      const out = join(dir, "artifact");
      const { code } = await runScript(["--out", out, "--job", "Probe"], spool);
      expect(code).toBe(0);
      const lines = (await Deno.readTextFile(join(out, "records.ndjson")))
        .trimEnd().split("\n");
      expect(lines.map((line) => parseRecordLine(line)?.test.n)).toEqual([
        "fmt",
      ]);
    });

    it("exits 2 and writes nothing for a command line that names no job", async () => {
      const out = join(dir, "artifact");
      const { code, stderr } = await runScript(["--out", out], dir);
      expect(code).toBe(2);
      expect(new TextDecoder().decode(stderr)).toContain(
        "usage: test-records-gather.ts",
      );
      await expect(Deno.stat(out)).rejects.toThrow(Deno.errors.NotFound);
    });
  });

  describe("parseGatherArgs()", () => {
    it("returns the options of a full command line", () => {
      const options = parseGatherArgs([
        "--out",
        "artifact",
        "--job",
        "Test (3/8)",
        "--shard",
        "3/8",
        "--variant",
        "wood-fired",
      ]);
      expect(options?.out).toBe("artifact");
      expect(options?.job).toBe("Test (3/8)");
      expect(options?.shard).toBe("3/8");
      expect(options?.variant).toBe("wood-fired");
    });

    it("returns undefined for unknown flags and missing values", () => {
      expect(parseGatherArgs(["--out"])).toBeUndefined();
      expect(parseGatherArgs(["--mystery", "x"])).toBeUndefined();
      expect(parseGatherArgs(["--out", "artifact"])).toBeUndefined();
      expect(
        parseGatherArgs([
          "--out",
          "artifact",
          "--job",
          "Check",
          "--variant",
          "",
        ]),
      ).toBeUndefined();
    });
  });
});
