import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterSearchTermFilterScenario: PatternIntegrationScenario<
  {
    counters?: { id?: string; label?: string; value?: number }[];
    search?: string;
  }
> = {
  name: "counter filters entries by search term updates",
  module: new URL("./counter-search-term-filter.pattern.ts", import.meta.url),
  exportName: "counterWithSearchTermFilter",
  argument: {
    counters: [
      { id: "alpha", label: "Alpha step", value: 3 },
      { id: "beta", label: "Beta branch", value: 1 },
      { id: "gamma", label: "Gamma node", value: 6 },
    ],
    search: " ",
  },
  steps: [
    {
      expect: [
        {
          path: "sanitizedCounters",
          value: [
            { id: "alpha", label: "Alpha step", value: 3 },
            { id: "beta", label: "Beta branch", value: 1 },
            { id: "gamma", label: "Gamma node", value: 6 },
          ],
        },
        { path: "searchTerm", value: "" },
        { path: "searchDisplay", value: "(all)" },
        {
          path: "filtered",
          value: [
            { id: "alpha", label: "Alpha step", value: 3 },
            { id: "beta", label: "Beta branch", value: 1 },
            { id: "gamma", label: "Gamma node", value: 6 },
          ],
        },
        {
          path: "filteredLabels",
          value: [
            "Alpha step (3)",
            "Beta branch (1)",
            "Gamma node (6)",
          ],
        },
        { path: "filteredCount", value: 3 },
        { path: "summary", value: "Matches 3/3 for (all)" },
        { path: "hasMatches", value: true },
      ],
    },
    {
      events: [{ stream: "setSearch", payload: { term: "zz" } }],
      expect: [
        { path: "searchTerm", value: "zz" },
        { path: "searchDisplay", value: "zz" },
        { path: "filtered", value: [] },
        { path: "filteredLabels", value: [] },
        { path: "filteredCount", value: 0 },
        { path: "summary", value: "Matches 0/3 for zz" },
        { path: "hasMatches", value: false },
      ],
    },
    {
      events: [{ stream: "setSearch", payload: { query: "ma" } }],
      expect: [
        { path: "searchTerm", value: "ma" },
        { path: "searchDisplay", value: "ma" },
        {
          path: "filtered",
          value: [{ id: "gamma", label: "Gamma node", value: 6 }],
        },
        { path: "filteredLabels", value: ["Gamma node (6)"] },
        { path: "filteredCount", value: 1 },
        { path: "summary", value: "Matches 1/3 for ma" },
        { path: "hasMatches", value: true },
      ],
    },
    {
      events: [{
        stream: "updateCounter",
        payload: { id: "beta", label: "Beta Gamma" },
      }],
      expect: [
        {
          path: "sanitizedCounters",
          value: [
            { id: "alpha", label: "Alpha step", value: 3 },
            { id: "beta", label: "Beta Gamma", value: 1 },
            { id: "gamma", label: "Gamma node", value: 6 },
          ],
        },
        {
          path: "filtered",
          value: [
            { id: "beta", label: "Beta Gamma", value: 1 },
            { id: "gamma", label: "Gamma node", value: 6 },
          ],
        },
        {
          path: "filteredLabels",
          value: ["Beta Gamma (1)", "Gamma node (6)"],
        },
        { path: "filteredCount", value: 2 },
        { path: "summary", value: "Matches 2/3 for ma" },
      ],
    },
    {
      events: [{ stream: "updateCounter", payload: { id: "beta", delta: 4 } }],
      expect: [
        {
          path: "sanitizedCounters",
          value: [
            { id: "alpha", label: "Alpha step", value: 3 },
            { id: "beta", label: "Beta Gamma", value: 5 },
            { id: "gamma", label: "Gamma node", value: 6 },
          ],
        },
        {
          path: "filtered",
          value: [
            { id: "beta", label: "Beta Gamma", value: 5 },
            { id: "gamma", label: "Gamma node", value: 6 },
          ],
        },
        {
          path: "filteredLabels",
          value: ["Beta Gamma (5)", "Gamma node (6)"],
        },
        { path: "filteredCount", value: 2 },
        { path: "summary", value: "Matches 2/3 for ma" },
      ],
    },
    {
      events: [{ stream: "setSearch", payload: "  be" }],
      expect: [
        { path: "searchTerm", value: "be" },
        { path: "searchDisplay", value: "be" },
        {
          path: "filtered",
          value: [{ id: "beta", label: "Beta Gamma", value: 5 }],
        },
        { path: "filteredLabels", value: ["Beta Gamma (5)"] },
        { path: "filteredCount", value: 1 },
        { path: "summary", value: "Matches 1/3 for be" },
      ],
    },
    {
      events: [{ stream: "resetSearch", payload: {} }],
      expect: [
        { path: "searchTerm", value: "" },
        { path: "searchDisplay", value: "(all)" },
        {
          path: "filtered",
          value: [
            { id: "alpha", label: "Alpha step", value: 3 },
            { id: "beta", label: "Beta Gamma", value: 5 },
            { id: "gamma", label: "Gamma node", value: 6 },
          ],
        },
        {
          path: "filteredLabels",
          value: [
            "Alpha step (3)",
            "Beta Gamma (5)",
            "Gamma node (6)",
          ],
        },
        { path: "filteredCount", value: 3 },
        { path: "summary", value: "Matches 3/3 for (all)" },
        { path: "hasMatches", value: true },
      ],
    },
  ],
};

export const scenarios = [counterSearchTermFilterScenario];

describe("counter-search-term-filter", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
