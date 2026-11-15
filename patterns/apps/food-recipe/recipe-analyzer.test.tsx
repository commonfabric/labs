/**
 * Recipe Analyzer tests. The model's answer comes from `llmMocks`; the test
 * checks the analysis runs only when asked, and is flagged once the
 * ingredients change.
 *
 * Run: deno task cf test patterns/apps/food-recipe/recipe-analyzer.test.tsx --verbose
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  clickButton,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import RecipeAnalyzer, { dietaryPrompt } from "./recipe-analyzer.tsx";
import type { Ingredient } from "./schemas.tsx";

export const llmMocks = [
  {
    promptIncludes: "- 2 cup flour",
    object: {
      compatible: ["vegetarian", "nut-free"],
      incompatible: ["vegan", "gluten-free"],
      warnings: ["Contains butter - not vegan"],
      primaryIngredients: ["flour", "butter"],
    },
  },
];

export default pattern(() => {
  const ingredients = new Writable<Ingredient[]>([
    { item: "flour", amount: "2", unit: "cup" },
    { item: "butter", amount: "1/2", unit: "cup" },
  ]);
  const analyzer = RecipeAnalyzer({
    recipeName: "Shortbread",
    ingredients,
    category: "dessert",
    tags: [],
  });

  const assert_prompt_lists_ingredients = assert(() =>
    dietaryPrompt("X", "main", [], [{ item: "rice", amount: "1", unit: "cup" }])
      .includes("- 1 cup rice")
  );
  const assert_no_prompt_without_ingredients = assert(() =>
    dietaryPrompt("X", "main", [], [{ item: " ", amount: "", unit: "" }]) ===
      ""
  );

  const assert_not_analyzed_yet = assert(() =>
    !analyzer.analyzed && !analyzer.pending &&
    analyzer.dietaryCompatibility.compatible.length === 0 &&
    hasText(analyzer[UI], "Not analyzed yet.")
  );

  const action_analyze = action(() => clickButton(analyzer[UI], "Analyze"));
  const assert_analyzed = assert(() =>
    analyzer.analyzed && !analyzer.stale &&
    analyzer.dietaryCompatibility.compatible.includes("vegetarian") &&
    analyzer.dietaryCompatibility.incompatible.includes("vegan") &&
    hasText(analyzer[UI], "Contains butter - not vegan")
  );

  const action_change_ingredients = action(() =>
    ingredients.push({ item: "sugar", amount: "1/4", unit: "cup" })
  );
  const assert_stale_keeps_last_result = assert(() =>
    analyzer.stale &&
    analyzer.dietaryCompatibility.compatible.includes("vegetarian") &&
    hasText(analyzer[UI], "The ingredients changed since this analysis.")
  );

  return {
    [TESTS]: [
      { assertion: assert_prompt_lists_ingredients },
      { assertion: assert_no_prompt_without_ingredients },
      { assertion: assert_not_analyzed_yet },
      { action: action_analyze },
      { settle: true },
      { assertion: assert_analyzed },
      { action: action_change_ingredients },
      { assertion: assert_stale_keeps_last_result },
    ],
    analyzer,
    allowConsoleWarnings: true,
  };
});
