import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

type GateMode = "enabled" | "disabled";

export const counterDerivedHandlerGateScenario: PatternIntegrationScenario<
  { value?: number; gateMode?: GateMode }
> = {
  name: "counter gates increment handler via derived boolean",
  module: new URL(
    "./counter-derived-handler-gate.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithDerivedHandlerGate",
  steps: [
    {
      expect: [
        { path: "current", value: 0 },
        { path: "gateMode", value: "enabled" },
        { path: "isActive", value: true },
        { path: "status", value: "enabled" },
        { path: "blockedAttempts", value: 0 },
        { path: "appliedAttempts", value: 0 },
        { path: "attemptHistory", value: [] },
        { path: "label", value: "Count 0 (enabled)" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 1 } }],
      expect: [
        { path: "current", value: 1 },
        { path: "gateMode", value: "enabled" },
        { path: "isActive", value: true },
        { path: "status", value: "enabled" },
        { path: "blockedAttempts", value: 0 },
        { path: "appliedAttempts", value: 1 },
        { path: "attemptHistory", value: ["applied:1"] },
        { path: "label", value: "Count 1 (enabled)" },
      ],
    },
    {
      events: [{ stream: "toggleGate", payload: { mode: "disabled" } }],
      expect: [
        { path: "current", value: 1 },
        { path: "gateMode", value: "disabled" },
        { path: "isActive", value: false },
        { path: "status", value: "disabled" },
        { path: "blockedAttempts", value: 0 },
        { path: "appliedAttempts", value: 1 },
        { path: "attemptHistory", value: ["applied:1"] },
        { path: "label", value: "Count 1 (disabled)" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 3 } }],
      expect: [
        { path: "current", value: 1 },
        { path: "gateMode", value: "disabled" },
        { path: "isActive", value: false },
        { path: "status", value: "disabled" },
        { path: "blockedAttempts", value: 1 },
        { path: "appliedAttempts", value: 1 },
        {
          path: "attemptHistory",
          value: ["applied:1", "blocked:3"],
        },
        { path: "label", value: "Count 1 (disabled)" },
      ],
    },
    {
      events: [{ stream: "toggleGate", payload: {} }],
      expect: [
        { path: "current", value: 1 },
        { path: "gateMode", value: "enabled" },
        { path: "isActive", value: true },
        { path: "status", value: "enabled" },
        { path: "blockedAttempts", value: 1 },
        { path: "appliedAttempts", value: 1 },
        {
          path: "attemptHistory",
          value: ["applied:1", "blocked:3"],
        },
        { path: "label", value: "Count 1 (enabled)" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 3 } }],
      expect: [
        { path: "current", value: 4 },
        { path: "gateMode", value: "enabled" },
        { path: "isActive", value: true },
        { path: "status", value: "enabled" },
        { path: "blockedAttempts", value: 1 },
        { path: "appliedAttempts", value: 2 },
        {
          path: "attemptHistory",
          value: ["applied:1", "blocked:3", "applied:4"],
        },
        { path: "label", value: "Count 4 (enabled)" },
      ],
    },
  ],
};

export const scenarios = [counterDerivedHandlerGateScenario];

describe("counter-derived-handler-gate", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
