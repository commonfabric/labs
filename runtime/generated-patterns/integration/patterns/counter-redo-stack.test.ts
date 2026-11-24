import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterRedoStackScenario: PatternIntegrationScenario<
  { value?: number; undoStack?: number[]; redoStack?: number[] }
> = {
  name: "counter manages redo stack replay",
  module: new URL("./counter-redo-stack.pattern.ts", import.meta.url),
  exportName: "counterRedoStack",
  argument: { value: 0, undoStack: [], redoStack: [] },
  steps: [
    {
      expect: [
        { path: "value", value: 0 },
        { path: "currentValue", value: 0 },
        { path: "undoStack", value: [] },
        { path: "undoHistory", value: [] },
        { path: "redoStack", value: [] },
        { path: "redoHistory", value: [] },
        { path: "undoCount", value: 0 },
        { path: "redoCount", value: 0 },
        { path: "canUndo", value: false },
        { path: "canRedo", value: false },
        { path: "status", value: "Value 0 | undo 0 | redo 0" },
      ],
    },
    {
      events: [{ stream: "apply", payload: { amount: 3 } }],
      expect: [
        { path: "value", value: 3 },
        { path: "currentValue", value: 3 },
        { path: "undoStack", value: [0] },
        { path: "undoHistory", value: [0] },
        { path: "redoStack", value: [] },
        { path: "redoHistory", value: [] },
        { path: "undoCount", value: 1 },
        { path: "redoCount", value: 0 },
        { path: "canUndo", value: true },
        { path: "canRedo", value: false },
        { path: "status", value: "Value 3 | undo 1 | redo 0" },
      ],
    },
    {
      events: [{ stream: "apply", payload: { amount: -1 } }],
      expect: [
        { path: "value", value: 2 },
        { path: "currentValue", value: 2 },
        { path: "undoStack", value: [0, 3] },
        { path: "undoHistory", value: [0, 3] },
        { path: "redoStack", value: [] },
        { path: "redoHistory", value: [] },
        { path: "undoCount", value: 2 },
        { path: "redoCount", value: 0 },
        { path: "canUndo", value: true },
        { path: "canRedo", value: false },
        { path: "status", value: "Value 2 | undo 2 | redo 0" },
      ],
    },
    {
      events: [{ stream: "undo", payload: {} }],
      expect: [
        { path: "value", value: 3 },
        { path: "currentValue", value: 3 },
        { path: "undoStack", value: [0] },
        { path: "undoHistory", value: [0] },
        { path: "redoStack", value: [2] },
        { path: "redoHistory", value: [2] },
        { path: "undoCount", value: 1 },
        { path: "redoCount", value: 1 },
        { path: "canUndo", value: true },
        { path: "canRedo", value: true },
        { path: "status", value: "Value 3 | undo 1 | redo 1" },
      ],
    },
    {
      events: [{ stream: "redo", payload: {} }],
      expect: [
        { path: "value", value: 2 },
        { path: "currentValue", value: 2 },
        { path: "undoStack", value: [0, 3] },
        { path: "undoHistory", value: [0, 3] },
        { path: "redoStack", value: [] },
        { path: "redoHistory", value: [] },
        { path: "undoCount", value: 2 },
        { path: "redoCount", value: 0 },
        { path: "canUndo", value: true },
        { path: "canRedo", value: false },
        { path: "status", value: "Value 2 | undo 2 | redo 0" },
      ],
    },
    {
      events: [{ stream: "undo", payload: {} }],
      expect: [
        { path: "value", value: 3 },
        { path: "currentValue", value: 3 },
        { path: "undoStack", value: [0] },
        { path: "undoHistory", value: [0] },
        { path: "redoStack", value: [2] },
        { path: "redoHistory", value: [2] },
        { path: "undoCount", value: 1 },
        { path: "redoCount", value: 1 },
        { path: "canUndo", value: true },
        { path: "canRedo", value: true },
        { path: "status", value: "Value 3 | undo 1 | redo 1" },
      ],
    },
    {
      events: [{ stream: "apply", payload: { amount: 5 } }],
      expect: [
        { path: "value", value: 8 },
        { path: "currentValue", value: 8 },
        { path: "undoStack", value: [0, 3] },
        { path: "undoHistory", value: [0, 3] },
        { path: "redoStack", value: [] },
        { path: "redoHistory", value: [] },
        { path: "undoCount", value: 2 },
        { path: "redoCount", value: 0 },
        { path: "canUndo", value: true },
        { path: "canRedo", value: false },
        { path: "status", value: "Value 8 | undo 2 | redo 0" },
      ],
    },
    {
      events: [{ stream: "redo", payload: {} }],
      expect: [
        { path: "value", value: 8 },
        { path: "currentValue", value: 8 },
        { path: "undoStack", value: [0, 3] },
        { path: "undoHistory", value: [0, 3] },
        { path: "redoStack", value: [] },
        { path: "redoHistory", value: [] },
        { path: "undoCount", value: 2 },
        { path: "redoCount", value: 0 },
        { path: "canUndo", value: true },
        { path: "canRedo", value: false },
        { path: "status", value: "Value 8 | undo 2 | redo 0" },
      ],
    },
    {
      events: [{ stream: "undo", payload: {} }],
      expect: [
        { path: "value", value: 3 },
        { path: "currentValue", value: 3 },
        { path: "undoStack", value: [0] },
        { path: "undoHistory", value: [0] },
        { path: "redoStack", value: [8] },
        { path: "redoHistory", value: [8] },
        { path: "undoCount", value: 1 },
        { path: "redoCount", value: 1 },
        { path: "canUndo", value: true },
        { path: "canRedo", value: true },
        { path: "status", value: "Value 3 | undo 1 | redo 1" },
      ],
    },
    {
      events: [{ stream: "undo", payload: {} }],
      expect: [
        { path: "value", value: 0 },
        { path: "currentValue", value: 0 },
        { path: "undoStack", value: [] },
        { path: "undoHistory", value: [] },
        { path: "redoStack", value: [8, 3] },
        { path: "redoHistory", value: [8, 3] },
        { path: "undoCount", value: 0 },
        { path: "redoCount", value: 2 },
        { path: "canUndo", value: false },
        { path: "canRedo", value: true },
        { path: "status", value: "Value 0 | undo 0 | redo 2" },
      ],
    },
    {
      events: [{ stream: "redo", payload: {} }],
      expect: [
        { path: "value", value: 3 },
        { path: "currentValue", value: 3 },
        { path: "undoStack", value: [0] },
        { path: "undoHistory", value: [0] },
        { path: "redoStack", value: [8] },
        { path: "redoHistory", value: [8] },
        { path: "undoCount", value: 1 },
        { path: "redoCount", value: 1 },
        { path: "canUndo", value: true },
        { path: "canRedo", value: true },
        { path: "status", value: "Value 3 | undo 1 | redo 1" },
      ],
    },
    {
      events: [{ stream: "apply", payload: {} }],
      expect: [
        { path: "value", value: 4 },
        { path: "currentValue", value: 4 },
        { path: "undoStack", value: [0, 3] },
        { path: "undoHistory", value: [0, 3] },
        { path: "redoStack", value: [] },
        { path: "redoHistory", value: [] },
        { path: "undoCount", value: 2 },
        { path: "redoCount", value: 0 },
        { path: "canUndo", value: true },
        { path: "canRedo", value: false },
        { path: "status", value: "Value 4 | undo 2 | redo 0" },
      ],
    },
  ],
};

export const scenarios = [counterRedoStackScenario];

describe("counter-redo-stack", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
