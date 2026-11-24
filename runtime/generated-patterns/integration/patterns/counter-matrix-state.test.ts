import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

const initialMatrix = [
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9],
];

export const counterMatrixStateScenario: PatternIntegrationScenario<
  { matrix?: number[][] }
> = {
  name: "counter maintains matrix state across row and column updates",
  module: new URL(
    "./counter-matrix-state.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithMatrixState",
  argument: { matrix: initialMatrix },
  steps: [
    {
      expect: [
        { path: "matrix", value: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] },
        { path: "matrixView", value: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] },
        { path: "dimensions", value: { rows: 3, columns: 3 } },
        { path: "rowTotals", value: [6, 15, 24] },
        { path: "columnTotals", value: [12, 15, 18] },
        { path: "total", value: 45 },
        { path: "rowSummary", value: "r0=6 | r1=15 | r2=24" },
        { path: "columnSummary", value: "c0=12 | c1=15 | c2=18" },
        {
          path: "label",
          value:
            "Rows r0=6 | r1=15 | r2=24 | Cols c0=12 | c1=15 | c2=18 | Total 45",
        },
      ],
    },
    {
      events: [{
        stream: "setCell",
        payload: { row: 1, column: 1, value: 11 },
      }],
      expect: [
        { path: "matrix", value: [[1, 2, 3], [4, 11, 6], [7, 8, 9]] },
        { path: "rowTotals", value: [6, 21, 24] },
        { path: "columnTotals", value: [12, 21, 18] },
        { path: "total", value: 51 },
        { path: "rowSummary", value: "r0=6 | r1=21 | r2=24" },
        { path: "columnSummary", value: "c0=12 | c1=21 | c2=18" },
        {
          path: "label",
          value:
            "Rows r0=6 | r1=21 | r2=24 | Cols c0=12 | c1=21 | c2=18 | Total 51",
        },
      ],
    },
    {
      events: [{
        stream: "setRow",
        payload: { row: 0, values: [2, 5, 1] },
      }],
      expect: [
        { path: "matrix", value: [[2, 5, 1], [4, 11, 6], [7, 8, 9]] },
        { path: "rowTotals", value: [8, 21, 24] },
        { path: "columnTotals", value: [13, 24, 16] },
        { path: "total", value: 53 },
        { path: "rowSummary", value: "r0=8 | r1=21 | r2=24" },
        { path: "columnSummary", value: "c0=13 | c1=24 | c2=16" },
        {
          path: "label",
          value:
            "Rows r0=8 | r1=21 | r2=24 | Cols c0=13 | c1=24 | c2=16 | Total 53",
        },
      ],
    },
    {
      events: [{
        stream: "setColumn",
        payload: { column: 2, values: [10, 20, 30] },
      }],
      expect: [
        { path: "matrix", value: [[2, 5, 10], [4, 11, 20], [7, 8, 30]] },
        { path: "rowTotals", value: [17, 35, 45] },
        { path: "columnTotals", value: [13, 24, 60] },
        { path: "total", value: 97 },
        { path: "rowSummary", value: "r0=17 | r1=35 | r2=45" },
        { path: "columnSummary", value: "c0=13 | c1=24 | c2=60" },
        {
          path: "label",
          value:
            "Rows r0=17 | r1=35 | r2=45 | Cols c0=13 | c1=24 | c2=60 | Total 97",
        },
      ],
    },
    {
      events: [{ stream: "setColumn", payload: { column: 0, value: 9 } }],
      expect: [
        { path: "matrix", value: [[9, 5, 10], [9, 11, 20], [9, 8, 30]] },
        { path: "rowTotals", value: [24, 40, 47] },
        { path: "columnTotals", value: [27, 24, 60] },
        { path: "total", value: 111 },
        { path: "rowSummary", value: "r0=24 | r1=40 | r2=47" },
        { path: "columnSummary", value: "c0=27 | c1=24 | c2=60" },
        {
          path: "label",
          value:
            "Rows r0=24 | r1=40 | r2=47 | Cols c0=27 | c1=24 | c2=60 | Total 111",
        },
      ],
    },
  ],
};

export const scenarios = [counterMatrixStateScenario];

describe("counter-matrix-state", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
