import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterTypedHandlerRecordScenario: PatternIntegrationScenario<
  { value?: number; step?: number }
> = {
  name: "counter exposes typed handler record",
  module: new URL(
    "./counter-typed-handler-record.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithTypedHandlerRecord",
  argument: { value: 5, step: 3 },
  steps: [
    {
      expect: [
        { path: "value", value: 5 },
        { path: "step", value: 3 },
        { path: "summary", value: "Value 5 :: inc:0 dec:0 set:0" },
        { path: "counts", value: { increment: 0, decrement: 0, setExact: 0 } },
        { path: "lastChange.action", value: "init" },
        { path: "lastChangeLabel", value: "init:0->0" },
        { path: "history", value: [] },
        { path: "handlerCatalog.0.key", value: "increment" },
        { path: "handlerCatalog.0.label", value: "Increment by 3" },
        { path: "handlerCatalog.1.key", value: "decrement" },
        { path: "handlerCatalog.2.key", value: "setExact" },
        { path: "handlerCatalog.2.calls", value: 0 },
      ],
    },
    {
      events: [{ stream: "handlers.increment", payload: { amount: 4 } }],
      expect: [
        { path: "value", value: 9 },
        { path: "summary", value: "Value 9 :: inc:1 dec:0 set:0" },
        {
          path: "counts",
          value: { increment: 1, decrement: 0, setExact: 0 },
        },
        { path: "lastChangeLabel", value: "increment:5->9" },
        {
          path: "history",
          value: [
            { action: "increment", previous: 5, next: 9 },
          ],
        },
        { path: "handlerCatalog.0.calls", value: 1 },
        { path: "handlerCatalog.1.calls", value: 0 },
      ],
    },
    {
      events: [{ stream: "handlers.decrement", payload: { amount: 2 } }],
      expect: [
        { path: "value", value: 7 },
        { path: "summary", value: "Value 7 :: inc:1 dec:1 set:0" },
        {
          path: "counts",
          value: { increment: 1, decrement: 1, setExact: 0 },
        },
        { path: "lastChangeLabel", value: "decrement:9->7" },
        {
          path: "history",
          value: [
            { action: "increment", previous: 5, next: 9 },
            { action: "decrement", previous: 9, next: 7 },
          ],
        },
        { path: "handlerCatalog.0.calls", value: 1 },
        { path: "handlerCatalog.1.calls", value: 1 },
      ],
    },
    {
      events: [{ stream: "handlers.setExact", payload: { value: 12.6 } }],
      expect: [
        { path: "value", value: 12.6 },
        { path: "summary", value: "Value 12.6 :: inc:1 dec:1 set:1" },
        {
          path: "counts",
          value: { increment: 1, decrement: 1, setExact: 1 },
        },
        { path: "lastChangeLabel", value: "setExact:7->12.6" },
        {
          path: "history",
          value: [
            { action: "increment", previous: 5, next: 9 },
            { action: "decrement", previous: 9, next: 7 },
            { action: "setExact", previous: 7, next: 12.6 },
          ],
        },
        { path: "handlerCatalog.0.calls", value: 1 },
        { path: "handlerCatalog.1.calls", value: 1 },
        { path: "handlerCatalog.2.calls", value: 1 },
      ],
    },
  ],
};

export const scenarios = [counterTypedHandlerRecordScenario];

describe("counter-typed-handler-record", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
