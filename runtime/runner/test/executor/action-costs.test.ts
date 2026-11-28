import { expect } from "@std/expect";
import {
  ACTION_COSTS_LISTED,
  ActionCostTable,
  type ActionRun,
  mergeActionCosts,
  SLOW_ACTION_LOG_MS,
  SLOW_ACTIONS_REMEMBERED,
} from "../../src/executor/action-costs.ts";
import type { ServingActionCost } from "../../src/executor/stats.ts";
import { RuntimeTelemetry } from "../../src/telemetry.ts";
import { captureLogs } from "../support/captured-logs.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** A run of the action `actionId` that took `durationMs`. */
const run = (
  actionId: string,
  durationMs: number,
  over: Partial<ActionRun> = {},
): ActionRun => ({
  type: "scheduler.run.complete",
  actionId,
  durationMs,
  ...over,
});

/** The cost of one run of `action` of `space` that took `ms`. */
const cost = (
  space: string,
  action: string,
  ms: number,
  over: Partial<ServingActionCost> = {},
): ServingActionCost => ({
  space,
  action,
  runs: 1,
  inputRuns: 0,
  totalMs: ms,
  longestMs: ms,
  lastMs: ms,
  ...over,
});

describe("action-costs", () => {
  describe("ActionCostTable", () => {
    describe("constructor()", () => {
      it("throws given a bound that is not a positive integer", () => {
        expect(() => new ActionCostTable({ tracked: 0 })).toThrow(RangeError);
        expect(() => new ActionCostTable({ tracked: 1.5 })).toThrow(RangeError);
        expect(() => new ActionCostTable({ tracked: 1 })).not.toThrow();
      });
    });

    describe("instance members", () => {
      describe("record()", () => {
        it("counts an action's runs, the runs an input change caused, and its total, longest and last times", () => {
          const table = new ActionCostTable();
          table.record("did:space", run("sum", 5));
          table.record("did:space", run("sum", 30, { inputDriven: true }));
          table.record("did:space", run("sum", 10, { inputDriven: false }));
          expect(table.costs().entries).toEqual([
            cost("did:space", "sum", 45, {
              runs: 3,
              inputRuns: 1,
              longestMs: 30,
              lastMs: 10,
            }),
          ]);
        });

        it("names the action's piece, pattern, module and authored site from its first run", () => {
          const table = new ActionCostTable();
          table.record(
            "did:space",
            run("sum", 5, {
              piece: "of:board",
              src: "cf:module/abc/main.tsx:4:7",
              actionInfo: { patternName: "Board", moduleName: "rows" },
            }),
          );
          expect(table.costs().entries).toEqual([
            cost("did:space", "sum", 5, {
              piece: "of:board",
              pattern: "Board",
              module: "rows",
              src: "cf:module/abc/main.tsx:4:7",
            }),
          ]);
        });

        it("keeps one action id of two spaces in two rows", () => {
          const table = new ActionCostTable();
          table.record("did:a", run("sum", 5));
          table.record("did:b", run("sum", 7));
          expect(
            table.costs().entries.map(({ space, totalMs }) => [space, totalMs]),
          ).toEqual([["did:b", 7], ["did:a", 5]]);
        });

        it("gives the row of the cheapest action to a run that alone took longer, once every row is taken", () => {
          const table = new ActionCostTable({ tracked: 2 });
          table.record("did:space", run("a", 5));
          table.record("did:space", run("b", 3));
          table.record("did:space", run("c", 4));
          const costs = table.costs();
          expect(costs.entries.map((entry) => entry.action)).toEqual([
            "a",
            "c",
          ]);
          expect(costs.dropped).toBe(1);
          expect(costs.droppedMs).toBe(3);
        });

        it("counts only in `droppedMs` a run that took no longer than the cheapest action, once every row is taken", () => {
          const table = new ActionCostTable({ tracked: 2 });
          table.record("did:space", run("a", 5));
          table.record("did:space", run("b", 3));
          table.record("did:space", run("c", 3));
          const costs = table.costs();
          expect(costs.entries.map((entry) => entry.action)).toEqual([
            "a",
            "b",
          ]);
          expect(costs.dropped).toBe(0);
          expect(costs.droppedMs).toBe(3);
        });

        it("logs an action's first run that reaches the slow threshold, and not its later ones", () => {
          using logs = captureLogs("action-costs");
          const table = new ActionCostTable();
          table.record("did:space", run("fast", SLOW_ACTION_LOG_MS - 1));
          table.record(
            "did:space",
            run("slow", SLOW_ACTION_LOG_MS, {
              piece: "of:board",
              src: "cf:module/abc/main.tsx:4:7",
              inputDriven: true,
            }),
          );
          table.record("did:space", run("slow", SLOW_ACTION_LOG_MS * 2));
          const lines = logs.textsOf("slow-action");
          expect(lines).toHaveLength(1);
          expect(lines[0]).not.toContain("`fast`");
          expect(lines[0]).toContain("`slow`");
          expect(lines[0]).toContain("`did:space`");
          expect(lines[0]).toContain("`of:board`");
          expect(lines[0]).toContain("`cf:module/abc/main.tsx:4:7`");
        });

        it("logs a slow action that holds no row once, however often it runs", () => {
          using logs = captureLogs("action-costs");
          const table = new ActionCostTable({ tracked: 1 });
          table.record("did:space", run("costly", SLOW_ACTION_LOG_MS * 10));
          table.record("did:space", run("slow", SLOW_ACTION_LOG_MS));
          table.record("did:space", run("slow", SLOW_ACTION_LOG_MS));
          expect(table.costs().entries.map((entry) => entry.action)).toEqual([
            "costly",
          ]);
          expect(
            logs.textsOf("slow-action").filter((line) =>
              line.includes("`slow`")
            ),
          ).toHaveLength(1);
        });

        it("logs a slow action again once more actions than it remembers have been logged since, and not before", () => {
          using logs = captureLogs("action-costs");
          const table = new ActionCostTable({ tracked: 1 });
          for (let i = 0; i <= SLOW_ACTIONS_REMEMBERED; i++) {
            table.record("did:space", run(`a${i}`, SLOW_ACTION_LOG_MS));
          }
          table.record("did:space", run("a1", SLOW_ACTION_LOG_MS));
          table.record("did:space", run("a0", SLOW_ACTION_LOG_MS));
          const lines = logs.textsOf("slow-action");
          expect(lines).toHaveLength(SLOW_ACTIONS_REMEMBERED + 2);
          expect(lines.at(-1)).toContain("`a0`");
        });
      });

      describe("costs()", () => {
        it("lists an action that cost more ahead of one that cost less, by total time", () => {
          const table = new ActionCostTable();
          for (let i = 0; i < 10; i++) {
            table.record("did:space", run("often", 1));
          }
          table.record("did:space", run("once", 4));
          table.record("did:space", run("slow", 25));
          expect(table.costs().entries.map((entry) => entry.action)).toEqual([
            "slow",
            "often",
            "once",
          ]);
        });

        it("returns every tracked action, past the bound the process lists", () => {
          const table = new ActionCostTable();
          for (let i = 0; i < ACTION_COSTS_LISTED + 1; i++) {
            table.record("did:space", run(`a${i}`, i + 1));
          }
          const costs = table.costs();
          expect(costs.entries).toHaveLength(ACTION_COSTS_LISTED + 1);
          expect(costs.dropped).toBe(0);
          expect(costs.droppedMs).toBe(0);
        });

        it("returns rows a later run does not change", () => {
          const table = new ActionCostTable();
          table.record("did:space", run("sum", 5));
          const before = table.costs();
          table.record("did:space", run("sum", 5));
          expect(before.entries[0].runs).toBe(1);
          expect(table.costs().entries[0].runs).toBe(2);
        });
      });

      describe("observe()", () => {
        it("counts the action runs the telemetry reports for the space, and no other marker", () => {
          const telemetry = new RuntimeTelemetry();
          const table = new ActionCostTable();
          table.observe("did:space", telemetry);
          telemetry.submit(run("sum", 5));
          telemetry.submit({ type: "scheduler.run", actionId: "sum" });
          expect(table.costs().entries).toEqual([cost("did:space", "sum", 5)]);
        });

        it("counts each run once when the same telemetry is observed again", () => {
          const telemetry = new RuntimeTelemetry();
          const table = new ActionCostTable();
          table.observe("did:space", telemetry);
          table.observe("did:space", telemetry);
          telemetry.submit(run("sum", 5));
          expect(table.costs().entries[0].runs).toBe(1);
        });

        it("ignores a `telemetry` event that carries no marker", () => {
          const telemetry = new RuntimeTelemetry();
          const table = new ActionCostTable();
          table.observe("did:space", telemetry);
          telemetry.dispatchEvent(new Event("telemetry"));
          telemetry.submit(run("sum", 5));
          expect(table.costs().entries).toEqual([cost("did:space", "sum", 5)]);
        });
      });
    });
  });

  describe("mergeActionCosts()", () => {
    it("takes the rows of one action of one space together, adding runs and times and keeping the longest run and the last row's last run", () => {
      const merged = mergeActionCosts({
        entries: [
          cost("did:space", "sum", 30, {
            runs: 2,
            inputRuns: 1,
            longestMs: 20,
            lastMs: 10,
            piece: "of:board",
          }),
          cost("did:space", "sum", 9, {
            runs: 3,
            inputRuns: 3,
            longestMs: 4,
            lastMs: 2,
          }),
        ],
        dropped: 1,
        droppedMs: 6,
      });
      expect(merged).toEqual({
        entries: [
          cost("did:space", "sum", 39, {
            runs: 5,
            inputRuns: 4,
            longestMs: 20,
            lastMs: 2,
            piece: "of:board",
          }),
        ],
        dropped: 1,
        droppedMs: 6,
      });
    });

    it("keeps one action id of two spaces apart, most expensive first", () => {
      const merged = mergeActionCosts({
        entries: [cost("did:a", "sum", 3), cost("did:b", "sum", 8)],
        dropped: 0,
        droppedMs: 0,
      });
      expect(merged.entries.map((entry) => entry.space)).toEqual([
        "did:b",
        "did:a",
      ]);
    });

    it("lists at most `ACTION_COSTS_LISTED` actions, counting the rest in `dropped` and `droppedMs`", () => {
      const entries = Array.from(
        { length: ACTION_COSTS_LISTED + 2 },
        (_, i) => cost("did:space", `a${i}`, i + 1),
      );
      const merged = mergeActionCosts({ entries, dropped: 0, droppedMs: 0 });
      expect(merged.entries).toHaveLength(ACTION_COSTS_LISTED);
      expect(merged.entries[0].totalMs).toBe(ACTION_COSTS_LISTED + 2);
      expect(merged.dropped).toBe(2);
      expect(merged.droppedMs).toBe(1 + 2);
    });
  });
});
