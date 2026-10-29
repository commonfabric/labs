import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

type EnumerationArgs = {
  state?: "idle" | "running" | "paused" | "complete";
  value?: number;
};

export const counterEnumerationStateScenario: PatternIntegrationScenario<
  EnumerationArgs
> = {
  name: "counter gates increments by enumeration state",
  module: new URL("./counter-enumeration-state.pattern.ts", import.meta.url),
  exportName: "counterWithEnumerationState",
  steps: [
    {
      expect: [
        { path: "state", value: "idle" },
        { path: "value", value: 0 },
        { path: "stateIndex", value: 0 },
        { path: "transitionCount", value: 0 },
        { path: "isRunning", value: false },
        { path: "phaseLabel", value: "state:idle index:0 value:0" },
        { path: "summary", value: "transitions:0 running:false" },
      ],
    },
    {
      events: [{ stream: "tick", payload: { amount: 3 } }],
      expect: [
        { path: "value", value: 0 },
        { path: "transitionCount", value: 0 },
      ],
    },
    {
      events: [{ stream: "advance", payload: { note: "begin" } }],
      expect: [
        { path: "state", value: "running" },
        { path: "stateIndex", value: 1 },
        { path: "transitionCount", value: 1 },
        { path: "isRunning", value: true },
        { path: "phaseLabel", value: "state:running index:1 value:0" },
        { path: "transitions.0.kind", value: "advance" },
        { path: "transitions.0.note", value: "begin" },
        { path: "summary", value: "transitions:1 running:true" },
      ],
    },
    {
      events: [{ stream: "tick", payload: { amount: 2, note: "fast tick" } }],
      expect: [
        { path: "value", value: 2 },
        { path: "transitionCount", value: 2 },
        { path: "transitions.1.kind", value: "tick" },
        { path: "transitions.1.note", value: "fast tick" },
      ],
    },
    {
      events: [{ stream: "advance", payload: { note: "pause" } }],
      expect: [
        { path: "state", value: "paused" },
        { path: "stateIndex", value: 2 },
        { path: "isRunning", value: false },
        { path: "transitionCount", value: 3 },
      ],
    },
    {
      events: [{ stream: "tick", payload: { amount: 5 } }],
      expect: [
        { path: "value", value: 2 },
        { path: "transitionCount", value: 3 },
      ],
    },
    {
      events: [{ stream: "retreat", payload: { note: "resume" } }],
      expect: [
        { path: "state", value: "running" },
        { path: "transitionCount", value: 4 },
        { path: "transitions.3.kind", value: "retreat" },
        { path: "transitions.3.note", value: "resume" },
        { path: "summary", value: "transitions:4 running:true" },
      ],
    },
    {
      events: [{ stream: "reset", payload: { note: "back to idle" } }],
      expect: [
        { path: "state", value: "idle" },
        { path: "value", value: 0 },
        { path: "stateIndex", value: 0 },
        { path: "transitionCount", value: 5 },
        { path: "summary", value: "transitions:5 running:false" },
        { path: "transitions.4.kind", value: "reset" },
        { path: "transitions.4.note", value: "back to idle" },
      ],
    },
  ],
};

export const scenarios = [counterEnumerationStateScenario];

describe("counter-enumeration-state", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
