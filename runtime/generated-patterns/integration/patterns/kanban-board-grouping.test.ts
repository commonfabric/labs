import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const kanbanBoardGroupingScenario: PatternIntegrationScenario<
  Record<string, never>
> = {
  name: "kanban board groups tasks and flags overloads",
  module: new URL("./kanban-board-grouping.pattern.ts", import.meta.url),
  exportName: "kanbanBoardGrouping",
  steps: [
    {
      expect: [
        { path: "columns.0.key", value: "backlog" },
        { path: "columns.0.count", value: 1 },
        { path: "columns.1.key", value: "inProgress" },
        { path: "columns.1.count", value: 2 },
        { path: "columns.1.limit", value: 2 },
        { path: "limits.inProgress", value: 2 },
        { path: "status", value: "All columns within limits" },
        { path: "overloadedColumns.length", value: 0 },
        { path: "history.length", value: 0 },
      ],
    },
    {
      events: [
        {
          stream: "moveTask",
          payload: { id: "task-plan-roadmap", to: "in-progress" },
        },
      ],
      expect: [
        { path: "columns.1.count", value: 3 },
        { path: "columns.1.overloaded", value: true },
        { path: "overloadedColumns.0", value: "inProgress" },
        { path: "status", value: "Over capacity: In Progress 3/2" },
        { path: "history.length", value: 1 },
        { path: "history.0.taskId", value: "task-plan-roadmap" },
        { path: "history.0.from", value: "backlog" },
        { path: "history.0.to", value: "inProgress" },
      ],
    },
    {
      events: [
        {
          stream: "setLimit",
          payload: { column: "in-progress", limit: 4 },
        },
      ],
      expect: [
        { path: "columns.1.limit", value: 4 },
        { path: "limits.inProgress", value: 4 },
        { path: "columns.1.overloaded", value: false },
        { path: "overloadedColumns.length", value: 0 },
        { path: "status", value: "All columns within limits" },
      ],
    },
  ],
};

export const scenarios = [kanbanBoardGroupingScenario];

describe("kanban-board-grouping", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
