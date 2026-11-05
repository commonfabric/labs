import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  evaluateReadBudget,
  parseReadBudgets,
  readBudgetForStep,
  ReadBudgetMeasurement,
} from "../lib/read-budgets.ts";

describe("read-budgets", () => {
  it("separates many cheap runs from one expensive run without double counting", () => {
    const measured = new ReadBudgetMeasurement();
    for (const accesses of [2, 2, 2]) {
      measured.record({
        type: "scheduler.run.complete",
        actionId: "cheap",
        durationMs: 0,
        reads: {
          proxyAccesses: accesses,
          linkResolutions: 0,
          distinctDocuments: 1,
          registeredDependencies: 1,
        },
      });
      measured.record({
        type: "scheduler.read-attempt",
        kind: "reactive",
        actionId: "cheap",
        reads: { proxyAccesses: accesses + 1, linkResolutions: 0 },
      });
    }
    expect(measured.total).toBe(9);
    expect(measured.perRun).toBe(2);
    expect(evaluateReadBudget({ total: 8, perRun: 2 }, measured)).toEqual([{
      kind: "total",
      limit: 8,
      actual: 9,
    }]);
    expect(measured.contributors("total")).toEqual(["9 accesses — cheap"]);
    measured.clear();
    expect(measured.total).toBe(0);
    expect(measured.contributors("total")).toEqual([]);
    measured.record({
      type: "scheduler.run.complete",
      actionId: "expensive",
      durationMs: 0,
      reads: {
        proxyAccesses: 5,
        linkResolutions: 0,
        distinctDocuments: 1,
        registeredDependencies: 1,
      },
    });
    measured.record({
      type: "scheduler.read-attempt",
      kind: "reactive",
      actionId: "expensive",
      reads: { proxyAccesses: 5, linkResolutions: 0 },
    });
    expect(evaluateReadBudget({ total: 8, perRun: 2 }, measured)).toEqual([{
      kind: "perRun",
      limit: 2,
      actual: 5,
    }]);
  });
  it("groups fan-out contributors by authored source before truncating diagnostics", () => {
    const measured = new ReadBudgetMeasurement();
    for (let i = 0; i < 6; i++) {
      const actionId = `row-${i}`;
      measured.record({
        type: "scheduler.read-attempt",
        kind: "reactive",
        actionId,
        reads: { proxyAccesses: 3, linkResolutions: 0 },
      });
      measured.record({
        type: "scheduler.run.complete",
        actionId,
        src: "poll.tsx:10:5",
        durationMs: 0,
        reads: {
          proxyAccesses: 2,
          linkResolutions: 0,
          distinctDocuments: 1,
          registeredDependencies: 1,
        },
      });
    }
    expect(measured.total).toBe(18);
    expect(measured.perRun).toBe(2);
    expect(measured.contributors("total", 1)).toEqual([
      "18 accesses — poll.tsx:10:5",
    ]);
    expect(measured.contributors("perRun", 1)).toEqual([
      "2 accesses — poll.tsx:10:5",
    ]);
  });

  it("keeps an action named preflight separate from anonymous preflight attempts", () => {
    const measured = new ReadBudgetMeasurement();
    measured.record({
      type: "scheduler.read-attempt",
      kind: "preflight",
      reads: { proxyAccesses: 7, linkResolutions: 0 },
    });
    measured.record({
      type: "scheduler.read-attempt",
      kind: "reactive",
      actionId: "preflight",
      reads: { proxyAccesses: 3, linkResolutions: 0 },
    });
    measured.record({
      type: "scheduler.run.complete",
      actionId: "preflight",
      src: "poll.tsx:10:5",
      durationMs: 0,
      reads: {
        proxyAccesses: 2,
        linkResolutions: 0,
        distinctDocuments: 1,
        registeredDependencies: 1,
      },
    });
    expect(measured.total).toBe(10);
    expect(measured.contributors("total")).toEqual([
      "7 accesses — preflight: preflight",
      "3 accesses — poll.tsx:10:5",
    ]);
    expect(measured.contributors("perRun")).toEqual([
      "2 accesses — poll.tsx:10:5",
    ]);
  });

  it("distinguishes no opt-in from an empty declaration", () => {
    expect(parseReadBudgets(undefined)).toBeUndefined();
    expect(parseReadBudgets({})).toEqual({});
  });

  it("keeps initialization and step limits separate and accepts zero", () => {
    expect(parseReadBudgets({
      initialization: { total: 100, perRun: 30 },
      steps: { total: 0 },
    })).toEqual({
      initialization: { total: 100, perRun: 30 },
      steps: { total: 0 },
    });
  });

  it("rejects misspelled fields and non-object declarations", () => {
    for (const value of [null, true, 10, "10", []]) {
      expect(() => parseReadBudgets(value)).toThrow("must be an object");
    }
    expect(() => parseReadBudgets({ step: {} })).toThrow("readBudgets.step");
    expect(() => parseReadBudgets({ steps: { totals: 1 } })).toThrow(
      "readBudgets.steps.totals",
    );
  });

  it("rejects values that cannot be exact nonnegative access counts", () => {
    for (
      const value of [
        -1,
        0.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        "2",
        null,
      ]
    ) {
      expect(() => parseReadBudgets({ steps: { total: value } })).toThrow(
        "readBudgets.steps.total",
      );
    }
  });

  it("requires opt-in for overrides and replaces rather than merges limits", () => {
    expect(() => readBudgetForStep(undefined, {}, 3)).toThrow(
      "Step 3 declares `readBudget` without",
    );
    const budgets = parseReadBudgets({ steps: { total: 10, perRun: 4 } });
    expect(readBudgetForStep(budgets, undefined, 3)).toEqual({
      total: 10,
      perRun: 4,
    });
    expect(readBudgetForStep(budgets, { total: 20 }, 3)).toEqual({ total: 20 });
    expect(readBudgetForStep(budgets, {}, 3)).toEqual({});
    expect(() => readBudgetForStep(budgets, { perRun: -1 }, 3)).toThrow(
      "step 3.readBudget.perRun",
    );
  });

  it("passes exact limits and identifies each one-over excess", () => {
    const budget = { total: 10, perRun: 4 };
    expect(evaluateReadBudget(budget, { total: 10, perRun: 4 })).toEqual([]);
    expect(evaluateReadBudget(budget, { total: 11, perRun: 5 })).toEqual([
      { kind: "total", limit: 10, actual: 11 },
      { kind: "perRun", limit: 4, actual: 5 },
    ]);
    expect(evaluateReadBudget({ total: 0 }, { total: 1, perRun: 1 })).toEqual([
      { kind: "total", limit: 0, actual: 1 },
    ]);
  });

  it("distinguishes one expensive run from fan-out of individually cheap runs", () => {
    const budget = { total: 100, perRun: 20 };
    expect(evaluateReadBudget(budget, { total: 21, perRun: 21 })).toEqual([
      { kind: "perRun", limit: 20, actual: 21 },
    ]);
    expect(evaluateReadBudget(budget, { total: 101, perRun: 10 })).toEqual([
      { kind: "total", limit: 100, actual: 101 },
    ]);
    expect(evaluateReadBudget(undefined, { total: 101, perRun: 101 })).toEqual(
      [],
    );
  });
});
