import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const recipeIngredientScalerScenario: PatternIntegrationScenario = {
  name: "pattern ingredient scaler multiplies quantities",
  module: new URL(
    "./pattern-ingredient-scaler.pattern.ts",
    import.meta.url,
  ),
  exportName: "recipeIngredientScaler",
  steps: [
    {
      expect: [
        { path: "recipeName", value: "Herb Pasta" },
        { path: "desiredServings", value: 4 },
        { path: "desiredLabel", value: "4" },
        { path: "multiplier", value: 1 },
        { path: "multiplierLabel", value: "x1" },
        {
          path: "scaledIngredients",
          value: [
            { name: "Spaghetti", quantity: 200, unit: "gram" },
            { name: "Cherry Tomato", quantity: 150, unit: "gram" },
            { name: "Olive Oil", quantity: 2, unit: "tbsp" },
            { name: "Basil", quantity: 6, unit: "leaf" },
          ],
        },
        {
          path: "scaledLabel",
          value: "Spaghetti: 200 gram; Cherry Tomato: 150 gram; " +
            "Olive Oil: 2 tbsp; Basil: 6 leaf",
        },
        { path: "summary", value: "Herb Pasta: 4 servings (x1)" },
        { path: "history", value: [] },
      ],
    },
    {
      events: [{ stream: "setServings", payload: { servings: 6 } }],
      expect: [
        { path: "desiredServings", value: 6 },
        { path: "desiredLabel", value: "6" },
        { path: "multiplier", value: 1.5 },
        { path: "multiplierLabel", value: "x1.5" },
        {
          path: "scaledIngredients",
          value: [
            { name: "Spaghetti", quantity: 300, unit: "gram" },
            { name: "Cherry Tomato", quantity: 225, unit: "gram" },
            { name: "Olive Oil", quantity: 3, unit: "tbsp" },
            { name: "Basil", quantity: 9, unit: "leaf" },
          ],
        },
        {
          path: "scaledLabel",
          value: "Spaghetti: 300 gram; Cherry Tomato: 225 gram; " +
            "Olive Oil: 3 tbsp; Basil: 9 leaf",
        },
        { path: "summary", value: "Herb Pasta: 6 servings (x1.5)" },
        {
          path: "history",
          value: ["Set servings to 6 (x1.5)"],
        },
      ],
    },
    {
      events: [{ stream: "adjustServings", payload: { delta: -3.5 } }],
      expect: [
        { path: "desiredServings", value: 2.5 },
        { path: "desiredLabel", value: "2.5" },
        { path: "multiplier", value: 0.63 },
        { path: "multiplierLabel", value: "x0.63" },
        {
          path: "scaledIngredients",
          value: [
            { name: "Spaghetti", quantity: 126, unit: "gram" },
            { name: "Cherry Tomato", quantity: 94.5, unit: "gram" },
            { name: "Olive Oil", quantity: 1.26, unit: "tbsp" },
            { name: "Basil", quantity: 3.78, unit: "leaf" },
          ],
        },
        {
          path: "scaledLabel",
          value: "Spaghetti: 126 gram; Cherry Tomato: 94.5 gram; " +
            "Olive Oil: 1.26 tbsp; Basil: 3.78 leaf",
        },
        { path: "summary", value: "Herb Pasta: 2.5 servings (x0.63)" },
        {
          path: "history",
          value: [
            "Set servings to 6 (x1.5)",
            "Adjusted by -3.5 -> 2.5 (x0.63)",
          ],
        },
      ],
    },
  ],
};

export const scenarios = [recipeIngredientScalerScenario];

describe("pattern-ingredient-scaler", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
