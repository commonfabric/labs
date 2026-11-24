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
    when: { lastMessageContains: "- 2 cup flour" },
    object: {
      compatible: ["vegetarian", "nut-free"],
      incompatible: ["vegan", "gluten-free"],
      warnings: ["Contains butter - not vegan"],
      primaryIngredients: ["flour", "butter"],
    },
  },
  {
    when: { lastMessageContains: "(retry" },
    object: {
      compatible: ["vegetarian"],
      incompatible: ["vegan"],
      warnings: [],
      primaryIngredients: ["flour", "butter", "sugar"],
    },
  },
  // Every other request fails, as an unanswered one did before `cf test`
  // answered every request: these steps check what the pattern does without
  // the answer.
  { error: "Not answered in this test.", repeat: true },
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
    !analyzer.analyzed && !analyzer.pending && analyzer.error === "" &&
    analyzer.dietarySource === "none" &&
    analyzer.dietaryCompatibility.compatible.length === 0 &&
    hasText(analyzer[UI], "Not analyzed yet.")
  );

  const action_analyze = action(() => clickButton(analyzer[UI], "Analyze"));
  const assert_analyzed = assert(() =>
    analyzer.analyzed && !analyzer.stale &&
    analyzer.dietarySource === "analyzed" &&
    analyzer.dietaryCompatibility.compatible.includes("vegetarian") &&
    analyzer.dietaryCompatibility.incompatible.includes("vegan") &&
    hasText(analyzer[UI], "Contains butter - not vegan")
  );

  const action_change_ingredients = action(() =>
    ingredients.push({ item: "sugar", amount: "1/4", unit: "cup" })
  );
  const assert_stale_keeps_last_result = assert(() =>
    analyzer.stale && analyzer.dietarySource === "stale" &&
    analyzer.dietaryCompatibility.compatible.includes("vegetarian") &&
    hasText(analyzer[UI], "The recipe changed since this analysis.")
  );

  // Re-analyzing the changed recipe fails (no mock answers it); the result is
  // gone, and asking again retries rather than repeating the failed request.
  const action_reanalyze = action(() => analyzer.analyze.send());
  const assert_failed = assert(() =>
    analyzer.error.includes("Not answered in this test.") &&
    !analyzer.analyzed && !analyzer.pending &&
    analyzer.dietarySource === "none" &&
    analyzer.dietaryCompatibility.compatible.length === 0
  );
  const action_retry = action(() => analyzer.analyze.send());
  const assert_retried = assert(() =>
    analyzer.error === "" && analyzer.dietarySource === "analyzed" &&
    analyzer.dietaryCompatibility.primaryIngredients.includes("sugar")
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
      { action: action_reanalyze },
      { settle: true },
      { assertion: assert_failed },
      { action: action_retry },
      { settle: true },
      { assertion: assert_retried },
    ],
    analyzer,
    allowConsoleWarnings: true,
  };
});
