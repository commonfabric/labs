import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  collectRecords,
  gather,
  headCommitOfEvent,
  parseGatherArgs,
  parseJUnitSpec,
  runGatherCommand,
} from "./test-records-gather.ts";
import {
  createRunSpool,
  FragmentWriter,
  type HeldSpool,
  parseRecordLine,
  RECORD_SCHEMA_VERSION,
} from "@commonfabric/test-support/records";

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="suite" tests="1" failures="0">
    <testcase name="alpha" classname="test/alpha.test.ts" time="0.250"/>
  </testsuite>
</testsuites>`;

describe("test-records-gather", () => {
  describe("parseJUnitSpec()", () => {
    it("returns the four fields of a full specification", () => {
      expect(
        parseJUnitSpec(
          "kind=unit,scope=cli,prefix=runtime/cli,glob=out/*.xml",
        ),
      ).toEqual({
        kind: "unit",
        scope: "cli",
        prefix: "runtime/cli",
        glob: "out/*.xml",
      });
    });

    it("returns a spec without the optional prefix", () => {
      expect(parseJUnitSpec("kind=pattern,scope=patterns,glob=x.xml"))
        .toEqual({ kind: "pattern", scope: "patterns", glob: "x.xml" });
    });

    it("throws when a required field is missing", () => {
      expect(() => parseJUnitSpec("kind=unit,glob=x.xml")).toThrow();
    });
  });

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

    it("writes job facts and the records of spool and JUnit inputs", async () => {
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
      await Deno.writeTextFile(join(dir, "results.xml"), JUNIT);

      const out = join(dir, "out");
      await gather({
        out,
        job: "Test (3/8)",
        shard: "3/8",
        variant: "wood-fired",
        junit: [{
          kind: "unit",
          scope: "cli",
          prefix: "runtime/cli",
          glob: join(dir, "*.xml"),
        }],
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
      expect(lines.length).toBe(2);
      const records = lines.map((line) => parseRecordLine(line));
      expect(records[0]?.test.n).toBe("check-docs");
      expect(records[0]?.test.v).toBe("wood-fired");
      expect(records[1]).toEqual({
        line: "record",
        test: {
          k: "unit",
          s: "cli",
          n: "alpha",
          v: "wood-fired",
        },
        outcome: "pass",
        durationMs: 250,
        file: "runtime/cli/test/alpha.test.ts",
      });
    });

    it("writes an empty records file when there is nothing to gather", async () => {
      const out = join(dir, "out");
      await gather({ out, job: "Check", junit: [] });
      expect(await Deno.readTextFile(join(out, "records.ndjson"))).toBe("");
      const facts = JSON.parse(
        await Deno.readTextFile(join(out, "job.json")),
      );
      expect(facts.job).toBe("Check");
    });

    it("rejects an empty variant from a direct caller", async () => {
      await expect(
        gather({ out: join(dir, "out"), job: "Check", variant: "", junit: [] }),
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
        junit: [],
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
        junit: [],
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

    it("ingests the files a JUnit glob matches and skips its directories", async () => {
      await Deno.writeTextFile(join(dir, "a-good.xml"), JUNIT);
      await Deno.mkdir(join(dir, "b-directory.xml"));
      const warned: string[] = [];
      const warn = console.warn;
      console.warn = (line: string) => warned.push(line);
      const out = join(dir, "out");
      try {
        await gather({
          out,
          job: "Check",
          junit: [{ kind: "unit", scope: "cli", glob: join(dir, "*.xml") }],
        });
      } finally {
        console.warn = warn;
      }
      expect(warned).toEqual([]);
      const lines = (await Deno.readTextFile(join(out, "records.ndjson")))
        .trimEnd().split("\n");
      expect(lines.length).toBe(1);
    });

    it("warns about a JUnit glob that matched nothing, and still writes", async () => {
      const glob = join(dir, "reports", "*.xml");
      const warned: string[] = [];
      const warn = console.warn;
      console.warn = (line: string) => warned.push(line);
      const out = join(dir, "out");
      try {
        await gather({
          out,
          job: "Check",
          junit: [{ kind: "unit", scope: "cli", glob }],
        });
      } finally {
        console.warn = warn;
      }
      expect(warned).toEqual([
        `test records: no JUnit files matched ${glob}`,
      ]);
      expect(await Deno.readTextFile(join(out, "records.ndjson"))).toBe("");
    });

    it("keeps ingesting after one unreadable JUnit file", async () => {
      await Deno.writeTextFile(join(dir, "a-bad.xml"), "<testsuite name=");
      await Deno.writeTextFile(join(dir, "b-good.xml"), JUNIT);
      const out = join(dir, "out");
      await gather({
        out,
        job: "Check",
        junit: [{ kind: "unit", scope: "cli", glob: join(dir, "*.xml") }],
      });
      const lines = (await Deno.readTextFile(join(out, "records.ndjson")))
        .trimEnd().split("\n");
      expect(lines.length).toBe(1);
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
        const { records } = await collectRecords({ spoolDir: dir, junit: [] });
        expect(records.length).toBe(count);
        expect(records.at(-1)?.test.n).toBe(`bakes ${count - 1}`);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("warns about a JUnit glob it cannot expand, and returns the rest", async () => {
      const glob = "**/[z-a].xml";
      const warned: string[] = [];
      const warn = console.warn;
      console.warn = (line: string) => warned.push(line);
      try {
        const collected = await collectRecords({
          junit: [{ kind: "unit", scope: "cli", glob }],
        });
        expect(collected.records).toEqual([]);
      } finally {
        console.warn = warn;
      }
      expect(warned.length).toBe(2);
      expect(warned[0]).toMatch(
        /^test records: expanding \*\*\/\[z-a\]\.xml failed: SyntaxError/,
      );
      expect(warned[1]).toBe(`test records: no JUnit files matched ${glob}`);
    });

    it("returns what each outermost describe's hooks took, in the declared variant", async () => {
      const dir = await Deno.makeTempDir({ prefix: "test-records-gather-" });
      try {
        await Deno.writeTextFile(
          join(dir, "results.xml"),
          `<testsuites>
  <testsuite name="./oven.test.ts">
    <testcase name="oven" classname="./oven.test.ts" time="5.000"/>
  </testsuite>
  <testsuite name="ext:cli/40_test.js">
    <testcase name="oven &gt; bakes" classname="ext:cli/40_test.js" time="1.500"/>
  </testsuite>
</testsuites>`,
        );
        const { records, hooks } = await collectRecords({
          junit: [{
            kind: "integration",
            scope: "bakery",
            prefix: "runtime/bakery",
            glob: join(dir, "*.xml"),
          }],
          variant: "wood-fired",
        });
        expect(records.map((record) => record.test.n)).toEqual([
          "oven > bakes",
        ]);
        expect(hooks).toEqual([{
          line: "record",
          test: { k: "integration", s: "bakery", n: "oven", v: "wood-fired" },
          outcome: "pass",
          durationMs: 3500,
          file: "runtime/bakery/oven.test.ts",
        }]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("returns the message each failing record failed with, in the declared variant", async () => {
      const dir = await Deno.makeTempDir({ prefix: "test-records-gather-" });
      try {
        await Deno.writeTextFile(
          join(dir, "results.xml"),
          `<testsuites>
  <testsuite name="./oven.test.ts">
    <testcase name="bakes" classname="./oven.test.ts" time="1.000"/>
    <testcase name="burns" classname="./oven.test.ts" time="1.000">
      <failure message="Uncaught Error: smoke">stack</failure>
    </testcase>
  </testsuite>
</testsuites>`,
        );
        const { records, failures } = await collectRecords({
          junit: [{
            kind: "unit",
            scope: "bakery",
            glob: join(dir, "*.xml"),
          }],
          variant: "wood-fired",
        });
        const burns = records.find((record) => record.test.n === "burns")!;
        expect(burns.test.v).toBe("wood-fired");
        expect([...failures]).toEqual([[burns, "Uncaught Error: smoke"]]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
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

    it("gathers the spool it is given into the output directory", async () => {
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
      const out = join(dir, "artifact");
      const code = await runGatherCommand(
        ["--out", out, "--job", "Probe", "--shard", "2/4"],
        spool,
      );
      expect(code).toBe(0);
      const facts = JSON.parse(await Deno.readTextFile(join(out, "job.json")));
      expect(facts.job).toBe("Probe");
      expect(facts.shard).toBe("2/4");
      const lines = (await Deno.readTextFile(join(out, "records.ndjson")))
        .trimEnd().split("\n");
      expect(lines.map((line) => parseRecordLine(line)?.test.n)).toEqual([
        "fmt",
      ]);
      expect(errors).toEqual([]);
    });

    it("returns 2 and prints the usage for a command line that names no output directory", async () => {
      expect(await runGatherCommand(["--job", "Probe"], undefined)).toBe(2);
      expect(errors).toEqual([
        "usage: test-records-gather.ts --out <dir> --job <name> " +
        "[--shard <label>] [--variant <name>] [--junit <spec>]...",
      ]);
    });

    it("returns 0 and warns when gathering fails", async () => {
      // An output directory under a regular file cannot be created.

      const file = join(dir, "file");
      await Deno.writeTextFile(file, "");
      const code = await runGatherCommand(
        ["--out", join(file, "artifact"), "--job", "Probe"],
        undefined,
      );
      expect(code).toBe(0);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/^test records: gathering failed: /);
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
        "--junit",
        "kind=unit,scope=cli,glob=*.xml",
      ]);
      expect(options?.out).toBe("artifact");
      expect(options?.job).toBe("Test (3/8)");
      expect(options?.shard).toBe("3/8");
      expect(options?.variant).toBe("wood-fired");
      expect(options?.junit.length).toBe(1);
    });

    it("skips a malformed junit specification and keeps the rest", () => {
      const options = parseGatherArgs([
        "--out",
        "artifact",
        "--job",
        "Check",
        "--junit",
        "not a spec",
        "--junit",
        "kind=unit,scope=cli,glob=*.xml",
      ]);
      expect(options?.junit.length).toBe(1);
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
