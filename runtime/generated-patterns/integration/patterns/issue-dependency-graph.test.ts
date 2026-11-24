import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const issueDependencyGraphScenario: PatternIntegrationScenario<
  { issues?: Array<{ id: string; title?: string; dependencies?: string[] }> }
> = {
  name: "issue dependency graph maintains acyclic order",
  module: new URL("./issue-dependency-graph.pattern.ts", import.meta.url),
  exportName: "issueDependencyGraph",
  argument: {
    issues: [
      { id: "design", title: "Design" },
      { id: "api", title: "API", dependencies: ["design"] },
      { id: "ui", title: "UI", dependencies: ["api"] },
    ],
  },
  steps: [
    {
      expect: [
        { path: "order", value: ["design", "api", "ui"] },
        { path: "roots", value: ["design"] },
        { path: "blocked", value: [] },
        { path: "hasCycle", value: false },
        { path: "summary", value: "valid: design -> api -> ui" },
        { path: "adjacency.design", value: [] },
        { path: "adjacency.api", value: ["design"] },
        { path: "adjacency.ui", value: ["api"] },
        { path: "rejectionHistory", value: [] },
      ],
    },
    {
      events: [
        { stream: "addIssue", payload: { id: "qa", title: "QA" } },
      ],
      expect: [
        { path: "issues.3.id", value: "qa" },
        { path: "order", value: ["design", "api", "qa", "ui"] },
        { path: "roots", value: ["design", "qa"] },
        { path: "summary", value: "valid: design -> api -> qa -> ui" },
      ],
    },
    {
      events: [
        { stream: "linkDependency", payload: { from: "qa", to: "ui" } },
      ],
      expect: [
        { path: "adjacency.qa", value: ["ui"] },
        { path: "order", value: ["design", "api", "ui", "qa"] },
        { path: "roots", value: ["design"] },
        { path: "summary", value: "valid: design -> api -> ui -> qa" },
        { path: "hasCycle", value: false },
        { path: "rejectionHistory", value: [] },
      ],
    },
    {
      events: [
        { stream: "linkDependency", payload: { from: "design", to: "ui" } },
      ],
      expect: [
        { path: "order", value: ["design", "api", "ui", "qa"] },
        { path: "hasCycle", value: false },
        { path: "rejectionHistory.0.reason", value: "cycle" },
        { path: "rejectionHistory.0.from", value: "design" },
        { path: "rejectionHistory.0.to", value: "ui" },
      ],
    },
    {
      events: [
        { stream: "unlinkDependency", payload: { from: "qa", to: "ui" } },
      ],
      expect: [
        { path: "adjacency.qa", value: [] },
        { path: "order", value: ["design", "api", "qa", "ui"] },
        { path: "roots", value: ["design", "qa"] },
        { path: "summary", value: "valid: design -> api -> qa -> ui" },
        { path: "rejectionHistory.0.reason", value: "cycle" },
      ],
    },
  ],
};

export const scenarios = [issueDependencyGraphScenario];

describe("issue-dependency-graph", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
