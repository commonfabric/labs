import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

const relocationHistory = [
  "Relocated Sky Designer from Riley Eng Lead to Morgan Ops",
  "Relocated Riley Eng Lead from Casey CTO to Top Level",
];

export const orgChartHierarchyScenario: PatternIntegrationScenario = {
  name: "org chart relocations maintain reporting chains",
  module: new URL("./org-chart-hierarchy.pattern.ts", import.meta.url),
  exportName: "orgChartHierarchy",
  steps: [
    {
      expect: [
        { path: "summary", value: "Org has 5 members across 1 root nodes" },
        { path: "topLevelNames", value: ["Avery CEO"] },
        { path: "hierarchy.0.id", value: "ceo" },
        { path: "hierarchy.0.reports.0.id", value: "cto" },
        { path: "hierarchy.0.reports.1.id", value: "ops" },
        { path: "hierarchy.0.reports.0.reports.0.id", value: "eng-lead" },
        {
          path: "hierarchy.0.reports.0.reports.0.reports.0.id",
          value: "designer",
        },
        {
          path: "reportingChains.designer",
          value: [
            "Avery CEO",
            "Casey CTO",
            "Riley Eng Lead",
            "Sky Designer",
          ],
        },
        { path: "history", value: [] },
        {
          path: "chainSummaries.0",
          value: "ceo: Avery CEO",
        },
      ],
    },
    {
      events: [
        {
          stream: "relocate",
          payload: { employeeId: "designer", newManagerId: "ops" },
        },
      ],
      expect: [
        { path: "hierarchy.0.reports.0.id", value: "cto" },
        { path: "hierarchy.0.reports.1.reports.0.id", value: "designer" },
        {
          path: "reportingChains.designer",
          value: ["Avery CEO", "Morgan Ops", "Sky Designer"],
        },
        {
          path: "history.0",
          value: relocationHistory[0],
        },
        {
          path: "chainSummaries.2",
          value: "designer: Avery CEO > Morgan Ops > Sky Designer",
        },
      ],
    },
    {
      events: [
        {
          stream: "relocate",
          payload: { employeeId: "eng-lead", newManagerId: null },
        },
      ],
      expect: [
        { path: "summary", value: "Org has 5 members across 2 root nodes" },
        { path: "topLevelNames", value: ["Avery CEO", "Riley Eng Lead"] },
        { path: "hierarchy.1.id", value: "eng-lead" },
        {
          path: "reportingChains.eng-lead",
          value: ["Riley Eng Lead"],
        },
        {
          path: "history.1",
          value: relocationHistory[1],
        },
      ],
    },
    {
      events: [
        {
          stream: "relocate",
          payload: { employeeId: "ceo", newManagerId: "designer" },
        },
      ],
      expect: [
        {
          path: "summary",
          value: "Org has 5 members across 2 root nodes",
        },
        {
          path: "history",
          value: relocationHistory,
        },
        {
          path: "reportingChains.ceo",
          value: ["Avery CEO"],
        },
        {
          path: "hierarchy.0.id",
          value: "ceo",
        },
      ],
    },
  ],
};

export const scenarios = [orgChartHierarchyScenario];

describe("org-chart-hierarchy", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
