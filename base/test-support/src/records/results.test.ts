import { expect } from "@std/expect";
import { join } from "@std/path";
import { stub } from "@std/testing/mock";
import { describe, it } from "@commonfabric/test-support/test";
import {
  parseResultsLine,
  readRegistered,
  readResults,
  type RegisteredLine,
  type ResultLine,
  ResultsWriter,
} from "./results.ts";

const FILE = "base/bakery/test/oven.test.ts";

function result(
  name: string[],
  outcome: ResultLine["outcome"],
  durationMs: number,
  extra: Partial<ResultLine> = {},
): ResultLine {
  return { line: "result", file: FILE, name, outcome, durationMs, ...extra };
}

/** A spool holding `lines` in one results file, and `extra` as named files. */
async function spoolOf(
  lines: readonly (RegisteredLine | ResultLine | string)[],
  extra: Record<string, string> = {},
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "results-test-" });
  await Deno.writeTextFile(
    join(dir, "results-01.ndjson"),
    lines.map((line) => typeof line === "string" ? line : JSON.stringify(line))
      .join("\n") + "\n",
  );
  for (const [name, text] of Object.entries(extra)) {
    await Deno.writeTextFile(join(dir, name), text);
  }
  return dir;
}

describe("results", () => {
  describe("parseResultsLine()", () => {
    it("returns a registered line and a result line as written", () => {
      const registered: RegisteredLine = {
        line: "registered",
        file: FILE,
        names: [["oven"], ["oven", "heats"]],
      };
      const failed = result(["oven", "heats"], "fail", 3, {
        failure: "Error: cold",
      });
      expect(parseResultsLine(JSON.stringify(registered))).toEqual(registered);
      expect(parseResultsLine(JSON.stringify(failed))).toEqual(failed);
    });

    it("returns undefined for anything that is not a results line", () => {
      for (
        const text of [
          "not json",
          "[]",
          JSON.stringify({ line: "record", file: FILE }),
          JSON.stringify({ ...result(["a"], "pass", 1), file: "/abs.ts" }),
          JSON.stringify({ ...result(["a"], "pass", 1), file: "../out.ts" }),
          JSON.stringify({ ...result(["a"], "pass", 1), name: [] }),
          JSON.stringify({ ...result(["a"], "pass", 1), name: [1] }),
          JSON.stringify({ ...result(["a"], "pass", 1), outcome: "ok" }),
          JSON.stringify({ ...result(["a"], "pass", 1), durationMs: -1 }),
          JSON.stringify({ ...result(["a"], "pass", 1), container: false }),
          JSON.stringify({ ...result(["a"], "pass", 1), failure: 3 }),
          JSON.stringify({ line: "registered", file: FILE, names: [[]] }),
          JSON.stringify({ line: "registered", file: FILE, names: "a" }),
        ]
      ) {
        expect(parseResultsLine(text)).toBeUndefined();
      }
    });
  });

  describe("readResults()", () => {
    it("records every test, under the kind and scope given, with its file", async () => {
      const dir = await spoolOf([
        result(["oven", "heats"], "pass", 4),
        result(["oven", "cools"], "skip", 0),
      ]);
      try {
        const { records } = await readResults(dir, {
          kind: "unit",
          scope: "bakery",
        });
        expect(records).toEqual([
          {
            line: "record",
            test: { k: "unit", s: "bakery", n: "oven > heats" },
            outcome: "pass",
            durationMs: 4,
            file: FILE,
          },
          {
            line: "record",
            test: { k: "unit", s: "bakery", n: "oven > cools" },
            outcome: "skip",
            durationMs: 0,
            file: FILE,
          },
        ]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("records a group that failed on its own, with the time outside what it holds", async () => {
      const dir = await spoolOf([
        result(["oven", "heats"], "pass", 4),
        result(["oven"], "fail", 10, { container: true, failure: "hook" }),
        result(["pantry", "stocks"], "fail", 2, { failure: "empty" }),
        result(["pantry"], "pass", 5, { container: true }),
      ]);
      try {
        const { records, failures } = await readResults(dir, {
          kind: "unit",
          scope: "bakery",
        });
        expect(records.map((record) => [record.test.n, record.durationMs]))
          .toEqual([["oven > heats", 4], ["oven", 6], ["pantry > stocks", 2]]);
        expect([...failures].map(([record, message]) => [
          record.test.n,
          message,
        ])).toEqual([["oven", "hook"], ["pantry > stocks", "empty"]]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("records a passing group only where the caller knows it", async () => {
      const dir = await spoolOf([
        result(["oven", "heats"], "pass", 4),
        result(["oven"], "pass", 10, { container: true }),
        result(["pantry"], "pass", 5, { container: true }),
      ]);
      try {
        const { records } = await readResults(dir, {
          kind: "unit",
          scope: "bakery",
          known: (test, file) => test.n === "oven" && file === FILE,
        });
        expect(records.map((record) => record.test.n)).toEqual([
          "oven > heats",
          "oven",
        ]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("measures each outermost group's hooks as what no record holds", async () => {
      const dir = await spoolOf([
        result(["oven", "racks", "slides"], "pass", 3),
        result(["oven", "racks"], "pass", 5, { container: true }),
        result(["oven", "heats"], "pass", 4),
        result(["oven"], "pass", 20, { container: true }),
        result(["toaster"], "pass", 2),
      ]);
      try {
        const { hooks } = await readResults(dir, {
          kind: "unit",
          scope: "bakery",
        });
        // 20 less the 3 and 4 the two tests hold: the inner group's 2 is
        // hook time as well.
        expect(hooks).toEqual([{
          line: "record",
          test: { k: "unit", s: "bakery", n: "oven" },
          outcome: "pass",
          durationMs: 13,
          file: FILE,
        }]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("drops a torn final line and a line it cannot read, and says so", async () => {
      const dir = await Deno.makeTempDir({ prefix: "results-test-" });
      try {
        await Deno.writeTextFile(
          join(dir, "results-01.ndjson"),
          `${JSON.stringify(result(["oven"], "pass", 1))}\nnonsense\n{"line"`,
        );
        await Deno.writeTextFile(join(dir, "fragment-01.ndjson"), "ignored\n");
        const { records, warnings } = await readResults(dir, {
          kind: "unit",
          scope: "bakery",
        });
        expect(records.map((record) => record.test.n)).toEqual(["oven"]);
        expect(warnings).toEqual([
          "dropped a torn final line in results-01.ndjson",
          "dropped a line no reader accepts in results-01.ndjson",
        ]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("takes the last line a process wrote for a file's own group", async () => {
      // The test module writes the group as failed before the file's
      // teardown, and again once it has finished.
      const dir = await spoolOf([
        result([FILE], "fail", 1, { container: true, failure: "pending" }),
        result([FILE], "pass", 3, { container: true }),
      ]);
      try {
        const { records, hooks, warnings } = await readResults(dir, {
          kind: "unit",
          scope: "bakery",
        });
        // A passing group is no record, and its time is its hooks'.
        expect(records).toEqual([]);
        expect(hooks.map((record) => [record.outcome, record.durationMs]))
          .toEqual([["pass", 3]]);
        expect(warnings).toEqual([]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("measures each process's hooks from that process's own lines", async () => {
      // Two packages' tasks may run one file, each in a process of its own.
      const dir = await spoolOf([
        result(["oven"], "pass", 10, { container: true }),
        result(["oven", "heats"], "pass", 4),
      ], {
        "results-02.ndjson": [
          result(["oven"], "pass", 7, { container: true }),
          result(["oven", "heats"], "pass", 5),
        ].map((line) => JSON.stringify(line)).join("\n") + "\n",
      });
      try {
        const { hooks } = await readResults(dir, {
          kind: "unit",
          scope: "bakery",
        });
        expect(hooks.map((record) => record.durationMs)).toEqual([6, 2]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("keeps the first of two lines a process wrote for one test, and says so", async () => {
      const dir = await spoolOf([
        result(["oven", "heats"], "pass", 4),
        result(["oven", "heats"], "fail", 5),
      ]);
      try {
        const { records, warnings } = await readResults(dir, {
          kind: "unit",
          scope: "bakery",
        });
        expect(records.map((record) => record.outcome)).toEqual(["pass"]);
        expect(warnings).toEqual([
          "dropped a second result for oven > heats in results-01.ndjson",
        ]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("reads a spool that does not exist as holding nothing", async () => {
      const dir = await Deno.makeTempDir({ prefix: "results-test-" });
      await Deno.remove(dir);
      expect(await readResults(dir, { kind: "unit", scope: "bakery" }))
        .toEqual({
          records: [],
          listed: [],
          hooks: [],
          failures: new Map(),
          warnings: [],
        });
      expect(await readRegistered(dir)).toEqual(new Map());
    });
  });

  describe("readRegistered()", () => {
    it("returns every name each file registered, joined", async () => {
      const dir = await spoolOf([
        { line: "registered", file: FILE, names: [["oven"], ["oven", "a"]] },
        { line: "registered", file: "b.test.ts", names: [["toaster"]] },
        result(["oven", "a"], "pass", 1),
      ]);
      try {
        expect(await readRegistered(dir)).toEqual(
          new Map([
            [FILE, new Set(["oven", "oven > a"])],
            ["b.test.ts", new Set(["toaster"])],
          ]),
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("ResultsWriter", () => {
    it("writes nothing where the run does not record", () => {
      expect(ResultsWriter.openForRun(() => undefined)).toBeUndefined();
      expect(ResultsWriter.openForRun(() => "")).toBeUndefined();
    });

    it("appends lines a reader reads back", async () => {
      const dir = await Deno.makeTempDir({ prefix: "results-test-" });
      try {
        const writer = ResultsWriter.openForRun(() => dir);
        expect(writer).toBeDefined();
        writer!.write(result(["oven"], "pass", 1));
        writer!.close();
        writer!.write(result(["toaster"], "pass", 1));
        const { records } = await readResults(dir, {
          kind: "unit",
          scope: "bakery",
        });
        expect(records.map((record) => record.test.n)).toEqual(["oven"]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("stops writing after a write fails, and warns", () => {
      const warnings: unknown[] = [];
      using _warn = stub(console, "warn", (message: unknown) => {
        warnings.push(message);
      });
      let writes = 0;
      let closed = false;
      const writer = ResultsWriter.accessForTestingOnly.create({
        writeSync: () => {
          writes++;
          throw new Error("disk full");
        },
        close: () => {
          closed = true;
        },
      });
      writer.write(result(["oven"], "pass", 1));
      writer.write(result(["toaster"], "pass", 1));
      expect(writes).toBe(1);
      expect(closed).toBe(true);
      expect(warnings).toEqual([
        expect.stringContaining("cannot write a result: Error: disk full"),
      ]);
    });
  });
});
