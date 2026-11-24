import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { ActionReadReport } from "../lib/action-read-report.ts";

describe("action-read-report", () => {
  it("includes every run in totals when the displayed rows are limited", () => {
    const report = new ActionReadReport();
    for (let i = 0; i < 14; i++) {
      report.record({
        type: "scheduler.run.complete",
        actionId: `card-${i}`,
        durationMs: 1,
        reads: {
          proxyAccesses: 20,
          linkResolutions: 3,
          distinctDocuments: 2,
          registeredDependencies: 4,
        },
      });
    }
    const lines = report.format("update", 1);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("14 runs, 280 accesses, 42 link hops");
    expect(lines[0]).toContain(
      "28 documents/run summed, 56 dependencies/run summed",
    );
  });

  it("sorts by accesses and retains the largest individual run", () => {
    const report = new ActionReadReport();
    for (const accesses of [10, 40]) {
      report.record({
        type: "scheduler.run.complete",
        actionId: "tally",
        src: "cf:module/example/donuts.tsx:12:3",
        durationMs: 1,
        reads: {
          proxyAccesses: accesses,
          linkResolutions: 1,
          distinctDocuments: 1,
          registeredDependencies: 2,
        },
      });
    }
    for (let i = 0; i < 3; i++) {
      report.record({
        type: "scheduler.run.complete",
        actionId: "builtin",
        actionInfo: { moduleName: "map" },
        durationMs: 1,
        reads: {
          proxyAccesses: 1,
          linkResolutions: 0,
          distinctDocuments: 1,
          registeredDependencies: 1,
        },
      });
    }
    const lines = report.format("update", 10);
    expect(lines[2].trim().replaceAll(/\s+/g, " ")).toContain(
      "2 50 40 2 2 4 cf:module/example/donuts.tsx:12:3",
    );
    expect(lines[3].trim().replaceAll(/\s+/g, " ")).toContain(
      "3 3 1 0 3 3 map",
    );
    report.clear();
    expect(report.format("next update", 10)[0]).toContain("0 runs, 0 accesses");
  });

  it("ranks combined authored-source work above a larger individual action", () => {
    const report = new ActionReadReport();
    for (let i = 0; i < 14; i++) {
      report.record({
        type: "scheduler.run.complete",
        actionId: `card-${i}`,
        src: "cf:module/example/card.tsx:10:2",
        durationMs: 1,
        reads: {
          proxyAccesses: 20,
          linkResolutions: 3,
          distinctDocuments: 2,
          registeredDependencies: 4,
        },
      });
    }
    report.record({
      type: "scheduler.run.complete",
      actionId: "tally",
      src: "cf:module/example/tally.tsx:20:2",
      durationMs: 1,
      reads: {
        proxyAccesses: 100,
        linkResolutions: 1,
        distinctDocuments: 1,
        registeredDependencies: 1,
      },
    });
    const lines = report.format("update", 1);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("15 runs, 380 accesses, 43 link hops");
    expect(lines[2].trim().replaceAll(/\s+/g, " ")).toBe(
      "14 280 20 42 28 56 cf:module/example/card.tsx:10:2",
    );
  });

  it("ignores unmeasured completions and run-start events", () => {
    const report = new ActionReadReport();
    report.record({ type: "scheduler.run", actionId: "unmeasured" });
    report.record({
      type: "scheduler.run.complete",
      actionId: "unmeasured",
      durationMs: 1,
    });
    expect(report.format("initialization", 10)[0]).toContain(
      "0 runs, 0 accesses",
    );
  });
});
