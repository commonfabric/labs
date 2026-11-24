import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterMutableTupleScenario: PatternIntegrationScenario<
  { pair?: [number, number] }
> = {
  name: "counter updates tuple entries together",
  module: new URL("./counter-mutable-tuple.pattern.ts", import.meta.url),
  exportName: "counterWithMutableTuple",
  steps: [
    {
      expect: [
        { path: "tuple", value: [0, 0] },
        { path: "sum", value: 0 },
        { path: "label", value: "Tuple (0, 0) sum 0" },
      ],
    },
    {
      events: [{ stream: "set", payload: { left: 2, right: 3 } }],
      expect: [
        { path: "tuple", value: [2, 3] },
        { path: "left", value: 2 },
        { path: "right", value: 3 },
        { path: "sum", value: 5 },
        { path: "label", value: "Tuple (2, 3) sum 5" },
      ],
    },
    {
      events: [{ stream: "adjust", payload: { left: 1, right: -2 } }],
      expect: [
        { path: "tuple", value: [3, 1] },
        { path: "sum", value: 4 },
        { path: "label", value: "Tuple (3, 1) sum 4" },
      ],
    },
    {
      events: [{ stream: "adjust", payload: { left: -3, right: 0 } }],
      expect: [
        { path: "tuple", value: [0, 1] },
        { path: "sum", value: 1 },
        { path: "label", value: "Tuple (0, 1) sum 1" },
      ],
    },
  ],
};

export const scenarios = [counterMutableTupleScenario];

describe("counter-mutable-tuple", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
