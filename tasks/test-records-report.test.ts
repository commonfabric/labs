import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  aggregate,
  churnFamilies,
  collisions,
  formatIdentity,
  identityKey,
  overSixtySeconds,
  parseReportArgs,
  recentDatePrefixes,
  runReport,
} from "./test-records-report.ts";
import {
  AliasResolver,
  type RunContext,
  type StoredReport,
  type TestRecord,
} from "@commonfabric/test-support/records";

function record(
  n: string,
  outcome: "pass" | "fail",
  durationMs: number,
): TestRecord {
  return {
    line: "record",
    test: { k: "unit", s: "bakery", n },
    outcome,
    durationMs,
  };
}

function report(objectName: string, records: TestRecord[]): StoredReport {
  return {
    objectName,
    context: undefined,
    records,
    reports: [{ context: undefined, records }],
  };
}

function contextOn(startedAt: string): RunContext {
  return {
    schema: 1,
    line: "context",
    reportId: "01REPORTTEST000000000000",
    repo: "commonfabric/labs",
    commit: "c".repeat(40),
    dirty: false,
    env: "local",
    os: "linux",
    arch: "x86_64",
    denoVersion: "2.9.4",
    startedAt,
  };
}

/**
 * Runs `body` with `console.log`, `console.warn` and `console.error`
 * captured, returning what each received alongside the body's result.
 */
async function captureConsole<T>(
  body: () => Promise<T>,
): Promise<{ result: T; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.warn = (...args) => err.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  try {
    return { result: await body(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

describe("test-records-report", () => {
  describe("aggregate()", () => {
    it("returns runs, failures, and the worst duration per identity", () => {
      const byIdentity = aggregate([
        report("a", [record("glaze", "pass", 10), record("glaze", "fail", 90)]),
        report("b", [record("glaze", "pass", 5)]),
      ]);
      const entry = byIdentity.get(identityKey({
        k: "unit",
        s: "bakery",
        n: "glaze",
      }));
      expect(entry).toEqual({
        key: '["unit","bakery","glaze"]',
        runs: 3,
        failures: 1,
        skips: 0,
        maxDurationMs: 10,
      });
    });

    it("takes the duration from passing records alone", () => {
      // A failure ended by a wait's safety net reports that net's bound,
      // so a duration read from one describes the net rather than the
      // test.

      const byIdentity = aggregate([
        report("a", [
          record("glaze", "fail", 300_000),
          record("glaze", "pass", 40),
        ]),
      ]);
      const entry = byIdentity.get(identityKey({
        k: "unit",
        s: "bakery",
        n: "glaze",
      }));
      expect(entry).toEqual({
        key: '["unit","bakery","glaze"]',
        runs: 2,
        failures: 1,
        skips: 0,
        maxDurationMs: 40,
      });
      expect(overSixtySeconds(byIdentity)).toEqual([]);
    });

    it("leaves out a lane's measurements of itself", () => {
      // A lane's own measurements are not test surfaces: nothing
      // enumerates them and no lane can be asked to run one. Only the
      // first of the three a lane writes per batch is a duration of one
      // thing — the second sums what every test in the batch took, and
      // the third counts the units it opened — so an aggregate that took
      // them would report the worst duration of something that never
      // ran.
      const byIdentity = aggregate([
        report("a", [
          record("glaze", "pass", 10),
          {
            line: "record",
            test: { k: "gate", s: "ci", n: "ci-lane batch runner-unit" },
            outcome: "pass",
            durationMs: 252_500,
          },
          {
            line: "record",
            test: {
              k: "gate",
              s: "ci",
              n: "ci-lane ran batch runner-unit",
            },
            outcome: "pass",
            durationMs: 60_600,
          },
          {
            line: "record",
            test: { k: "gate", s: "ci", n: "ci-lane units batch runner-unit" },
            outcome: "pass",
            durationMs: 338,
          },
        ]),
      ]);
      expect([...byIdentity.keys()]).toEqual(['["unit","bakery","glaze"]']);
    });

    it("joins a renamed test's history under its current name", () => {
      const resolver = new AliasResolver([{
        date: "2026-08-15",
        from: { k: "unit", s: "bakery", n: "old name" },
        to: { k: "unit", s: "bakery", n: "new name" },
      }]);
      const before = report("a", [record("old name", "pass", 5)]);
      before.context = contextOn("2026-08-10T00:00:00.000Z");
      const after = report("b", [record("new name", "fail", 7)]);
      after.context = contextOn("2026-08-16T00:00:00.000Z");
      const byIdentity = aggregate([before, after], resolver);
      const entry = byIdentity.get(identityKey({
        k: "unit",
        s: "bakery",
        n: "new name",
      }));
      expect(entry?.runs).toBe(2);
      expect(byIdentity.size).toBe(1);
    });

    it("separates a non-default variant from the default history", () => {
      const unmarked = record("glaze", "pass", 10);
      const marked: TestRecord = {
        ...unmarked,
        test: { ...unmarked.test, v: "wood-fired" },
      };
      const byIdentity = aggregate([report("a", [unmarked, marked])]);
      expect([...byIdentity.keys()]).toEqual([
        '["unit","bakery","glaze"]',
        '["unit","bakery","glaze","wood-fired"]',
      ]);
      expect(formatIdentity([...byIdentity.keys()][1]!)).toBe(
        "[unit] bakery: glaze (variant: wood-fired)",
      );
    });
  });

  describe("collisions()", () => {
    it("returns identities reported twice within one object", () => {
      const found = collisions([
        report("a", [record("same", "pass", 1), record("same", "pass", 2)]),
        report("b", [record("same", "pass", 3)]),
      ]);
      expect(found).toEqual([
        { objectName: "a", key: '["unit","bakery","same"]', count: 2 },
      ]);
    });
  });

  describe("churnFamilies()", () => {
    it("returns families of one-run identities with digits collapsed", () => {
      const byIdentity = aggregate([
        report("a", [
          record("case #1", "pass", 1),
          record("case #2", "pass", 1),
          record("case #3", "pass", 1),
          record("stable name", "pass", 1),
        ]),
        report("b", [record("stable name", "pass", 1)]),
      ]);
      expect(churnFamilies(byIdentity, 2)).toEqual([
        { family: '["unit","bakery","case ##"]', members: 3 },
      ]);
    });

    it("returns nothing for a single-run window", () => {
      const byIdentity = aggregate([
        report("a", [record("case #1", "pass", 1)]),
      ]);
      expect(churnFamilies(byIdentity, 1)).toEqual([]);
    });
  });

  describe("overSixtySeconds()", () => {
    it("returns identities whose worst duration crossed the rule", () => {
      const byIdentity = aggregate([
        report("a", [
          record("slow", "pass", 61_000),
          record("fast", "pass", 100),
        ]),
      ]);
      const slow = overSixtySeconds(byIdentity);
      expect(slow.length).toBe(1);
      expect(slow[0]?.key).toBe('["unit","bakery","slow"]');
    });
  });

  describe("recentDatePrefixes()", () => {
    it("returns the window's partitions, newest first", () => {
      const now = Date.parse("2026-08-18T12:00:00Z");
      expect(recentDatePrefixes(3, now)).toEqual([
        "2026/08/18",
        "2026/08/17",
        "2026/08/16",
      ]);
    });
  });

  describe("runReport()", () => {
    const NOW = Date.parse("2026-08-18T12:00:00Z");

    // The day's listing over the named objects, each served with the body
    // given for it. A name mapped to `undefined` is listed and then fails
    // to read, which is the transient network failure a whole-day read
    // meets among its tens of thousands of requests.
    function reportFetch(
      bodies: Record<string, string | undefined>,
    ): typeof fetch {
      return ((input: URL | RequestInfo) => {
        const url = String(input);
        if (url.includes("/storage/v1/")) {
          const prefix = new URL(url).searchParams.get("prefix")!;
          const items = prefix.includes("2026/08/18/")
            ? Object.keys(bodies).map((name) => ({ name }))
            : [];
          return Promise.resolve(
            new Response(JSON.stringify({ items }), { status: 200 }),
          );
        }
        const name = Object.keys(bodies).find((candidate) =>
          url.endsWith(candidate)
        );
        const body = name === undefined ? undefined : bodies[name];
        return Promise.resolve(
          body === undefined
            ? new Response("", { status: 503 })
            : new Response(body, { status: 200 }),
        );
      }) as typeof fetch;
    }

    function ciBody(
      fork: boolean,
      records: ReturnType<typeof record>[],
    ): string {
      const context = {
        ...contextOn("2026-08-18T01:00:00.000Z"),
        env: "ci" as const,
        ci: {
          workflowRunId: fork ? "2" : "1",
          runAttempt: 1,
          workflow: "CI",
          job: "Test",
          fork,
        },
      };
      return JSON.stringify(context) + "\n" +
        records.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    }

    it("fails the gate for an over-sixty-seconds record from a fork run", async () => {
      // See `docs/specs/test-records.md`, "Trust boundaries for consumers",
      // for what the store's member gate leaves the fork flag meaning.

      const { result: status } = await captureConsole(() =>
        runReport({
          days: 1,
          gate: true,
          bucket: "b",
          prefix: "p",
          now: NOW,
          fetchImpl: reportFetch({
            "same-repository.ndjson": ciBody(false, [
              record("fast", "pass", 5),
            ]),
            "forked.ndjson": ciBody(true, [record("slow", "pass", 90_000)]),
          }),
        })
      );
      expect(status).toBe(1);
    });

    it("fails the gate for an over-sixty-seconds record", async () => {
      const { result: status } = await captureConsole(() =>
        runReport({
          days: 1,
          gate: true,
          bucket: "b",
          prefix: "p",
          now: NOW,
          fetchImpl: reportFetch({
            "same-repository.ndjson": ciBody(false, [
              record("slow", "pass", 61_000),
            ]),
          }),
        })
      );
      expect(status).toBe(1);
    });

    it("reports without failing when the gate is off", async () => {
      const { result: status } = await captureConsole(() =>
        runReport({
          days: 1,
          gate: false,
          bucket: "b",
          prefix: "p",
          now: NOW,
          fetchImpl: reportFetch({
            "same-repository.ndjson": ciBody(false, [
              record("slow", "pass", 61_000),
            ]),
          }),
        })
      );
      expect(status).toBe(0);
    });

    it("lists the collisions and the high-churn families it found", async () => {
      const { out } = await captureConsole(() =>
        runReport({
          days: 1,
          gate: false,
          bucket: "b",
          prefix: "p",
          now: NOW,
          fetchImpl: reportFetch({
            "first.ndjson": ciBody(false, [
              record("same", "pass", 1),
              record("same", "pass", 2),
              record("case #1", "pass", 1),
              record("case #2", "pass", 1),
              record("case #3", "pass", 1),
              record("stable", "pass", 1),
            ]),
            "second.ndjson": ciBody(true, [record("stable", "pass", 1)]),
          }),
        })
      );
      expect(out).toContain("Collisions (1):");
      expect(out).toContain("2x [unit] bakery: same in first.ndjson");
      expect(out).toContain("High-churn identity families (1):");
      expect(out).toContain('3 one-run members: ["unit","bakery","case ##"]');
    });

    it("reports over the objects it read when one of them cannot be read", async () => {
      const { result: status, out, err } = await captureConsole(() =>
        runReport({
          days: 1,
          gate: false,
          bucket: "b",
          prefix: "p",
          now: NOW,
          fetchImpl: reportFetch({
            "first.ndjson": ciBody(false, [record("slow", "pass", 61_000)]),
            "second.ndjson": undefined,
          }),
        })
      );
      expect(status).toBe(0);
      expect(err).toContain("leaving `second.ndjson` out");
      expect(out).toContain("2 object(s) under p in the last 1 day(s).");
      expect(out).toContain("1 object(s) read, 1 could not be read.");
      expect(out).toContain("Every figure below is over the objects that");
      expect(out).toContain("Over sixty seconds (1):");
      expect(out).toContain("[unit] bakery: slow");
    });

    it("names fifty of the objects it could not read and no more", async () => {
      const bodies: Record<string, string | undefined> = {
        "readable.ndjson": ciBody(false, [record("fast", "pass", 5)]),
      };
      for (let at = 0; at < 60; at++) {
        bodies[`broken-${String(at).padStart(2, "0")}.ndjson`] = undefined;
      }
      const { out, err } = await captureConsole(() =>
        runReport({
          days: 1,
          gate: false,
          bucket: "b",
          prefix: "p",
          now: NOW,
          fetchImpl: reportFetch(bodies),
        })
      );
      const named = err.split("\n").filter((line) =>
        line.startsWith("leaving")
      );
      expect(named.length).toBe(50);
      expect(err).toContain(
        "objects left out past the first 50 are not named.",
      );
      expect(out).toContain("1 object(s) read, 60 could not be read.");
    });

    it("exits 3 for a window it could not read in full", async () => {
      const { result: status, err } = await captureConsole(() =>
        runReport({
          days: 1,
          gate: true,
          bucket: "b",
          prefix: "p",
          now: NOW,
          fetchImpl: reportFetch({
            "first.ndjson": ciBody(false, [record("fast", "pass", 5)]),
            "second.ndjson": undefined,
          }),
        })
      );
      expect(status).toBe(3);
      expect(err).toContain("the ratchet could not check it");
      expect(err).not.toContain("exceed the sixty-second rule");
    });

    it("exits 1 for a test over the rule even in a window read in part", async () => {
      const { result: status, err } = await captureConsole(() =>
        runReport({
          days: 1,
          gate: true,
          bucket: "b",
          prefix: "p",
          now: NOW,
          fetchImpl: reportFetch({
            "first.ndjson": ciBody(false, [record("slow", "pass", 61_000)]),
            "second.ndjson": undefined,
          }),
        })
      );
      expect(status).toBe(1);
      expect(err).toContain("exceed the sixty-second rule");
      expect(err).toContain("the ratchet could not check it");
    });

    it("exits 3 for a day it could not list", async () => {
      const { result: status, out, err } = await captureConsole(() =>
        runReport({
          days: 1,
          gate: true,
          bucket: "b",
          prefix: "p",
          now: NOW,
          fetchImpl: (() =>
            Promise.resolve(
              new Response("", { status: 503 }),
            )) as typeof fetch,
        })
      );
      expect(status).toBe(3);
      expect(err).toContain("listing `2026/08/18` failed");
      expect(out).toContain("1 day(s) could not be listed");
      expect(err).toContain("the ratchet could not check it");
    });
  });

  describe("parseReportArgs()", () => {
    it("returns the defaults and the given flags", () => {
      expect(parseReportArgs([])).toEqual({ days: 7, gate: false });
      expect(parseReportArgs(["--gate", "--days", "30"]))
        .toEqual({ days: 30, gate: true });
    });

    it("returns undefined for malformed command lines", () => {
      expect(parseReportArgs(["--days", "-1"])).toBeUndefined();
      expect(parseReportArgs(["--mystery"])).toBeUndefined();
    });
  });
});
