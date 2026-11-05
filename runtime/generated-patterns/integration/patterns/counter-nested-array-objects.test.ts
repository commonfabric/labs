import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface EntryDetails {
  note?: string;
}

interface NestedEntry {
  id?: string;
  label?: string;
  value?: number;
  details?: EntryDetails;
}

interface NestedGroup {
  title?: string;
  entries?: NestedEntry[];
}

export const counterNestedArrayObjectsScenario: PatternIntegrationScenario<
  { groups?: NestedGroup[] }
> = {
  name: "counter updates nested array objects",
  module: new URL(
    "./counter-nested-array-objects.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithNestedArrayObjects",
  argument: {
    groups: [
      {
        title: "Alpha",
        entries: [
          {
            id: "a-1",
            label: "Alpha One",
            value: 2,
            details: { note: "warm" },
          },
          {
            id: "a-2",
            label: "Alpha Two",
            value: 3,
            details: { note: "cool" },
          },
        ],
      },
      {
        title: "Beta",
        entries: [
          {
            id: "b-1",
            label: "Beta One",
            value: 5,
            details: { note: "" },
          },
        ],
      },
    ],
  },
  steps: [
    {
      expect: [
        { path: "totals", value: 10 },
        { path: "summaries.0.total", value: 5 },
        { path: "summaries.1.total", value: 5 },
        { path: "notes", value: ["warm", "cool"] },
        { path: "headline", value: "Nested total 10" },
      ],
    },
    {
      events: [
        {
          stream: "updateEntry",
          payload: {
            groupIndex: 0,
            entryIndex: 1,
            delta: 4,
            note: "boosted",
            label: "Alpha Two+",
          },
        },
      ],
      expect: [
        { path: "groups.0.entries.1.value", value: 7 },
        { path: "groups.0.entries.1.label", value: "Alpha Two+" },
        { path: "groups.0.entries.1.details.note", value: "boosted" },
        { path: "totals", value: 14 },
        { path: "summaries.0.total", value: 9 },
        { path: "notes", value: ["warm", "boosted"] },
        { path: "headline", value: "Nested total 14" },
      ],
    },
    {
      events: [
        {
          stream: "appendEntry",
          payload: {
            groupIndex: 1,
            label: "Beta Two",
            value: 4,
            note: "new",
          },
        },
      ],
      expect: [
        { path: "groups.1.entries.1.label", value: "Beta Two" },
        { path: "groups.1.entries.1.value", value: 4 },
        { path: "groups.1.entries.1.details.note", value: "new" },
        { path: "totals", value: 18 },
        { path: "summaries.1.total", value: 9 },
        { path: "notes", value: ["warm", "boosted", "new"] },
        { path: "headline", value: "Nested total 18" },
      ],
    },
  ],
};

export const scenarios = [counterNestedArrayObjectsScenario];

describe("counter-nested-array-objects", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
