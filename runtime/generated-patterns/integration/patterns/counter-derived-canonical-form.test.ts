import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterDerivedCanonicalFormScenario: PatternIntegrationScenario<
  { groups?: Array<{ name?: string; counters?: Array<{ id?: string }> }> }
> = {
  name: "counter derives canonical nested structure",
  module: new URL(
    "./counter-derived-canonical-form.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithDerivedCanonicalForm",
  steps: [
    {
      expect: [
        { path: "groups", value: [] },
        { path: "canonical.groups", value: [] },
        { path: "canonical.totalValue", value: 0 },
        { path: "canonical.signature", value: [] },
        { path: "canonicalLabel", value: "Canonical total 0 -> none" },
        { path: "canonicalSignatureText", value: "none" },
        { path: "operations", value: 0 },
        { path: "operationsLabel", value: "Mutations: 0" },
        { path: "history", value: [] },
        { path: "lastMutation", value: "none" },
      ],
    },
    {
      events: [{
        stream: "controls.adjust",
        payload: { group: "beta", id: "bravo", delta: 3 },
      }],
      expect: [
        {
          path: "groups",
          value: [{
            name: "beta",
            counters: [{ id: "bravo", label: "bravo", value: 3 }],
          }],
        },
        {
          path: "canonical.groups",
          value: [{
            name: "beta",
            total: 3,
            counters: [{ id: "bravo", label: "bravo", value: 3 }],
          }],
        },
        { path: "canonical.totalValue", value: 3 },
        { path: "canonical.signature", value: ["beta:bravo:3"] },
        { path: "canonicalLabel", value: "Canonical total 3 -> beta:bravo:3" },
        { path: "canonicalSignatureText", value: "beta:bravo:3" },
        { path: "operations", value: 1 },
        { path: "operationsLabel", value: "Mutations: 1" },
        { path: "history", value: ["beta:bravo:3"] },
        { path: "lastMutation", value: "beta:bravo:3" },
      ],
    },
    {
      events: [{
        stream: "controls.adjust",
        payload: { group: "alpha", id: "charlie", delta: 2 },
      }],
      expect: [
        {
          path: "groups",
          value: [
            {
              name: "beta",
              counters: [{ id: "bravo", label: "bravo", value: 3 }],
            },
            {
              name: "alpha",
              counters: [{ id: "charlie", label: "charlie", value: 2 }],
            },
          ],
        },
        {
          path: "canonical.groups",
          value: [
            {
              name: "alpha",
              total: 2,
              counters: [{ id: "charlie", label: "charlie", value: 2 }],
            },
            {
              name: "beta",
              total: 3,
              counters: [{ id: "bravo", label: "bravo", value: 3 }],
            },
          ],
        },
        {
          path: "canonical.signature",
          value: ["alpha:charlie:2", "beta:bravo:3"],
        },
        {
          path: "canonicalLabel",
          value: "Canonical total 5 -> alpha:charlie:2 | beta:bravo:3",
        },
        {
          path: "canonicalSignatureText",
          value: "alpha:charlie:2 | beta:bravo:3",
        },
        { path: "operations", value: 2 },
        {
          path: "history",
          value: ["beta:bravo:3", "alpha:charlie:2"],
        },
        { path: "lastMutation", value: "alpha:charlie:2" },
      ],
    },
    {
      events: [{
        stream: "controls.adjust",
        payload: { group: "alpha", label: "Able", delta: 4 },
      }],
      expect: [
        {
          path: "groups",
          value: [
            {
              name: "beta",
              counters: [{ id: "bravo", label: "bravo", value: 3 }],
            },
            {
              name: "alpha",
              counters: [
                { id: "charlie", label: "charlie", value: 2 },
                { id: "Able", label: "Able", value: 4 },
              ],
            },
          ],
        },
        {
          path: "canonical.groups",
          value: [
            {
              name: "alpha",
              total: 6,
              counters: [
                { id: "Able", label: "Able", value: 4 },
                { id: "charlie", label: "charlie", value: 2 },
              ],
            },
            {
              name: "beta",
              total: 3,
              counters: [{ id: "bravo", label: "bravo", value: 3 }],
            },
          ],
        },
        {
          path: "canonical.signature",
          value: [
            "alpha:Able:4",
            "alpha:charlie:2",
            "beta:bravo:3",
          ],
        },
        {
          path: "canonicalLabel",
          value:
            "Canonical total 9 -> alpha:Able:4 | alpha:charlie:2 | beta:bravo:3",
        },
        {
          path: "canonicalSignatureText",
          value: "alpha:Able:4 | alpha:charlie:2 | beta:bravo:3",
        },
        { path: "operations", value: 3 },
        {
          path: "history",
          value: [
            "beta:bravo:3",
            "alpha:charlie:2",
            "alpha:Able:4",
          ],
        },
        { path: "lastMutation", value: "alpha:Able:4" },
      ],
    },
    {
      events: [{
        stream: "controls.adjust",
        payload: {
          group: "beta",
          id: "BRAVO",
          label: "Bravo",
          set: 10,
        },
      }],
      expect: [
        {
          path: "groups",
          value: [
            {
              name: "beta",
              counters: [{ id: "BRAVO", label: "Bravo", value: 10 }],
            },
            {
              name: "alpha",
              counters: [
                { id: "charlie", label: "charlie", value: 2 },
                { id: "Able", label: "Able", value: 4 },
              ],
            },
          ],
        },
        {
          path: "canonical.groups",
          value: [
            {
              name: "alpha",
              total: 6,
              counters: [
                { id: "Able", label: "Able", value: 4 },
                { id: "charlie", label: "charlie", value: 2 },
              ],
            },
            {
              name: "beta",
              total: 10,
              counters: [{ id: "BRAVO", label: "Bravo", value: 10 }],
            },
          ],
        },
        {
          path: "canonical.signature",
          value: [
            "alpha:Able:4",
            "alpha:charlie:2",
            "beta:Bravo:10",
          ],
        },
        {
          path: "canonicalLabel",
          value:
            "Canonical total 16 -> alpha:Able:4 | alpha:charlie:2 | beta:Bravo:10",
        },
        {
          path: "canonicalSignatureText",
          value: "alpha:Able:4 | alpha:charlie:2 | beta:Bravo:10",
        },
        { path: "operations", value: 4 },
        {
          path: "operationsLabel",
          value: "Mutations: 4",
        },
        {
          path: "history",
          value: [
            "beta:bravo:3",
            "alpha:charlie:2",
            "alpha:Able:4",
            "beta:Bravo:10",
          ],
        },
        { path: "lastMutation", value: "beta:Bravo:10" },
      ],
    },
  ],
};

export const scenarios = [counterDerivedCanonicalFormScenario];

describe("counter-derived-canonical-form", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
