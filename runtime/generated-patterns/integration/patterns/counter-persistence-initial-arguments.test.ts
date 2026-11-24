import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

const persistedArgument = {
  value: 12,
  step: 3,
  history: [5, 8, 12],
};

interface CounterPersistenceArgs {
  state?: { value?: number; step?: number; history?: number[] };
  metadata?: { label?: string };
}

export const counterPersistenceInitialArgumentsScenario:
  PatternIntegrationScenario<CounterPersistenceArgs> = {
    name: "counter preserves provided persisted arguments",
    module: new URL(
      "./counter-persistence-initial-arguments.pattern.ts",
      import.meta.url,
    ),
    exportName: "counterPersistenceViaInitialArguments",
    argument: {
      state: persistedArgument,
      metadata: { label: "Restored counter" },
    },
    steps: [
      {
        expect: [
          { path: "state.value", value: 12 },
          { path: "state.step", value: 3 },
          { path: "state.history.0", value: 5 },
          { path: "state.history.1", value: 8 },
          { path: "state.history.2", value: 12 },
          { path: "value", value: 12 },
          { path: "step", value: 3 },
          { path: "history.0", value: 5 },
          { path: "history.1", value: 8 },
          { path: "history.2", value: 12 },
          { path: "historyPreview", value: "0:5 | 1:8 | 2:12" },
          { path: "initializationStatus", value: "restored" },
          {
            path: "summary",
            value: "Restored counter: value 12 (mode restored)",
          },
          {
            path: "details",
            value: "Restored counter: value 12 (mode restored) history " +
              "0:5 | 1:8 | 2:12",
          },
          { path: "lastPersistedChange.reason", value: "initial" },
        ],
      },
      {
        events: [{ stream: "increment", payload: {} }],
        expect: [
          { path: "state.value", value: 15 },
          { path: "state.step", value: 3 },
          { path: "state.history.3", value: 15 },
          { path: "value", value: 15 },
          { path: "history.3", value: 15 },
          { path: "historyPreview", value: "0:5 | 1:8 | 2:12 | 3:15" },
          { path: "initializationStatus", value: "restored" },
          {
            path: "summary",
            value: "Restored counter: value 15 (mode restored)",
          },
          {
            path: "details",
            value: "Restored counter: value 15 (mode restored) history " +
              "0:5 | 1:8 | 2:12 | 3:15",
          },
          { path: "lastPersistedChange.reason", value: "increment" },
          { path: "lastPersistedChange.previous", value: 12 },
          { path: "lastPersistedChange.next", value: 15 },
          { path: "lastPersistedChange.amount", value: 3 },
          { path: "lastPersistedChange.step", value: 3 },
          { path: "lastPersistedChange.historyLength", value: 4 },
        ],
      },
      {
        events: [{ stream: "increment", payload: { amount: 4, step: 2 } }],
        expect: [
          { path: "state.value", value: 19 },
          { path: "state.step", value: 2 },
          { path: "state.history.4", value: 19 },
          { path: "value", value: 19 },
          { path: "step", value: 2 },
          { path: "history.4", value: 19 },
          { path: "historyPreview", value: "0:5 | 1:8 | 2:12 | 3:15 | 4:19" },
          { path: "initializationStatus", value: "restored" },
          {
            path: "summary",
            value: "Restored counter: value 19 (mode restored)",
          },
          {
            path: "details",
            value: "Restored counter: value 19 (mode restored) history " +
              "0:5 | 1:8 | 2:12 | 3:15 | 4:19",
          },
          { path: "lastPersistedChange.reason", value: "increment" },
          { path: "lastPersistedChange.previous", value: 15 },
          { path: "lastPersistedChange.next", value: 19 },
          { path: "lastPersistedChange.amount", value: 4 },
          { path: "lastPersistedChange.step", value: 2 },
          { path: "lastPersistedChange.historyLength", value: 5 },
        ],
      },
    ],
  };

export const scenarios = [counterPersistenceInitialArgumentsScenario];

describe("counter-persistence-initial-arguments", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
