/**
 * Food Recipe tests: the pure recipe logic, then the pattern end to end:
 * extraction from notes (answered by `llmMocks`) through review to apply,
 * oven needs, scaling, step-group editing, and timing suggestions.
 *
 * The recipe starts with one step group whose id is pinned ("base"), so the
 * mocked timing suggestion can name it.
 *
 * Run: deno task cf test patterns/apps/food-recipe/food-recipe.test.tsx --verbose
 */
import {
  action,
  assert,
  FS,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import FoodRecipe from "./food-recipe.tsx";
import {
  formatQuantity,
  formatTiming,
  newIngredients,
  ovenRequirements,
  scalarChanges,
  scaleAmount,
  timingReview,
  withGroupNumber,
  withOvenField,
  wordDiff,
} from "./recipe-logic.ts";
import type { StepGroup } from "./schemas.tsx";

export const llmMocks = [
  {
    when: { lastMessageContains: "Illegible recipe card" },
    error: "The recipe card could not be read.",
  },
  {
    when: { lastMessageContains: "Grandma's roast chicken" },
    // The all-required wire shape the model fills: "" and 0 mean unknown.
    object: {
      name: "Roast Chicken",
      cuisine: "",
      servings: 6,
      yield: "",
      difficulty: "",
      prepTime: 0,
      cookTime: 75,
      restTime: 0,
      holdTime: 0,
      category: "main",
      source: "",
      ingredients: [
        { item: "chicken", amount: "1", unit: "piece" },
        { item: "butter", amount: "1/2", unit: "cup" },
      ],
      stepGroups: [
        {
          name: "Roast",
          nightsBeforeServing: 0,
          minutesBeforeServing: 90,
          duration: 75,
          maxWaitMinutes: 0,
          oven: {
            temperature: 425,
            duration: 75,
            heightSlots: 2,
            width: "full",
          },
          steps: ["Butter the skin", "Roast until 165°F"],
        },
      ],
      tags: ["sunday"],
      remainingNotes: "Use the big pan.",
    },
  },
  {
    when: { lastMessageContains: "Step groups:" },
    object: {
      stepGroups: [
        { id: "base", nightsBeforeServing: 1, duration: 10, maxWaitMinutes: 0 },
      ],
    },
  },
];

const base: StepGroup = {
  id: "base",
  name: "Brine",
  minutesBeforeServing: 240,
  steps: [{ description: "Salt the bird" }],
};

export default pattern(() => {
  const stepGroups = new Writable<StepGroup[]>([base]);
  const notes = new Writable("");
  const recipe = FoodRecipe({ stepGroups, notes });

  // --- Pure logic -----------------------------------------------------------

  const assert_scales_fractions = assert(() =>
    scaleAmount("1 1/2", 2) === "3" &&
    scaleAmount("1/2", 2) === "1" &&
    scaleAmount("3/4 cup", 0.5) === "3/8 cup" &&
    scaleAmount("2-3 large", 2) === "4-6 large" &&
    scaleAmount("to taste", 2) === "to taste" &&
    formatQuantity(1.25) === "1 1/4"
  );
  const assert_nights_clear_minutes = assert(() => {
    const g = withGroupNumber(base, "nightsBeforeServing", 1);
    return g.nightsBeforeServing === 1 &&
      g.minutesBeforeServing === undefined &&
      formatTiming(g) === "The night before";
  });
  const assert_oven_needs_temperature = assert(() => {
    const hot = withOvenField(base, "temperature", "400");
    const cold = withOvenField(hot, "temperature", "");
    return hot.oven?.temperature === 400 && hot.oven.heightSlots === 1 &&
      cold.oven === undefined &&
      !ovenRequirements([base, cold]).needsOven &&
      ovenRequirements([hot, { ...hot, id: "x" }]).temps.join() === "400";
  });
  const assert_oven_fields_need_an_oven = assert(() =>
    withOvenField(base, "duration", "30").oven === undefined &&
    withOvenField(base, "width", "toggle").oven === undefined
  );
  const assert_timing_review_shows_rack = assert(() => {
    const oven = {
      temperature: 400,
      duration: 20,
      heightSlots: 1,
      width: "full" as const,
    };
    const review = timingReview([{ ...base, oven }], {
      stepGroups: [{ id: "base", oven: { ...oven, heightSlots: 2 } }],
    });
    return review.length === 1 &&
      review[0].changes.some((c) =>
        c.field === "Oven" && c.to.includes("rack height 2")
      );
  });
  const assert_keeps_repeated_ingredients = assert(() => {
    const butter = { item: "butter", amount: "1/2", unit: "cup" };
    const salt = { item: "salt", amount: "1", unit: "tsp" };
    const found = newIngredients([butter], {
      ingredients: [
        butter,
        { ...butter, amount: "2", unit: "tbsp" },
        salt,
        salt,
      ],
    });
    // Already-present butter is skipped; a second butter and salt listed
    // twice (dough and topping) are kept.
    return found.map((i) => `${i.amount} ${i.item}`).join() ===
      "2 butter,1 salt,1 salt";
  });
  const assert_word_diff = assert(() =>
    wordDiff("a b c", "a c d").map((c) => `${c.type[0]}${c.word.trim()}`)
      .filter((s) => s.length > 1).join() === "ua,rb,uc,ad"
  );
  // Long notes compare only the changed middle; a middle too large to
  // compare falls back to removed-then-added rather than a huge table.
  const assert_word_diff_long = assert(() => {
    const words = (n: number, w: string) => Array(n).fill(w).join(" ");
    const shared = wordDiff(
      `${words(5000, "a")} old ${words(5000, "a")}`,
      `${words(5000, "a")} new ${words(5000, "a")}`,
    ).filter((c) => c.type !== "unchanged").map((c) => c.word).join();
    const big = wordDiff(words(1000, "x"), words(1000, "y"));
    return shared === "old,new" &&
      big[0].type === "removed" && big[big.length - 1].type === "added";
  });
  const assert_scalar_changes_skip_unchanged = assert(() =>
    scalarChanges({
      name: "Soup",
      cuisine: "",
      servings: 4,
      yield: "",
      difficulty: "medium",
      prepTime: 0,
      cookTime: 0,
      restTime: 0,
      holdTime: 0,
      category: "other",
      source: "",
      notes: "",
    }, { name: "Soup", servings: 6, category: "nonsense" as never })
      .map((c) => `${c.field}:${c.from}>${c.to}`).join() ===
      "Servings:4>6"
  );

  // --- Through the pattern --------------------------------------------------

  const assert_starts_untitled = assert(() =>
    recipe[NAME] === "🍳 Untitled Recipe" &&
    recipe.servings === 4 &&
    recipe.ingredients.length === 0 &&
    !recipe.ovenRequirements.needsOven &&
    recipe.dietarySource === "none" &&
    recipe.extraction === null
  );

  const action_paste_and_extract = action(() => {
    notes.set(
      "Grandma's roast chicken. Serves 6. Use the big pan.",
    );
    clickButton(recipe[UI], "Extract Recipe Data");
  });
  const assert_review_shows_changes = assert(() =>
    recipe.extraction !== null &&
    recipe.name === "" &&
    hasText(recipe[UI], "Review Extracted Changes") &&
    hasText(recipe[UI], "Recipe Name") &&
    hasText(recipe[UI], "1/2 cup butter") &&
    hasText(recipe[UI], "Roast until 165°F")
  );

  const action_apply = action(() => clickButton(recipe[UI], "Apply"));
  const action_extract_unreadable = action(() => {
    notes.set("Illegible recipe card");
    recipe.extract.send();
  });
  const assert_failed_extraction = assert(() =>
    recipe.extraction === null &&
    hasText(recipe[UI], "The recipe card could not be read.")
  );
  const assert_failed_apply_keeps_recipe = assert(() =>
    recipe.name === "Roast Chicken" && recipe.ingredients.length === 2 &&
    notes.get() === "Illegible recipe card"
  );
  const assert_failure_dismissed = assert(() =>
    recipe.extraction === null &&
    !hasText(recipe[UI], "The recipe card could not be read.")
  );
  const assert_applied = assert(() =>
    recipe.name === "Roast Chicken" &&
    recipe.servings === 6 &&
    recipe.category === "main" &&
    recipe.cookTime === 75 &&
    recipe.ingredients.length === 2 &&
    recipe.stepGroups.length === 2 &&
    recipe.stepGroups[1]?.steps.length === 2 &&
    recipe.tags.join() === "sunday" &&
    recipe.notes === "Use the big pan." &&
    recipe.extraction === null &&
    recipe[NAME] === "🍳 Roast Chicken"
  );
  const assert_oven_derived = assert(() =>
    recipe.ovenRequirements.needsOven &&
    recipe.ovenRequirements.temps.join() === "425" &&
    !recipe.ovenRequirements.tempChanges
  );

  const action_double = action(() => clickButton(recipe[UI], "×2"));
  const assert_doubled = assert(() =>
    recipe.servings === 12 &&
    recipe.ingredients[0]?.amount === "2" &&
    recipe.ingredients[1]?.amount === "1"
  );

  // Editing a step group through its streams.
  const action_edit_group = action(() => {
    recipe.setOven.send({ id: "base", field: "temperature", value: "350" });
    recipe.setGroupNumber.send({
      id: "base",
      field: "duration",
      value: "15",
    });
    recipe.addStep.send({ id: "base" });
    recipe.moveStepGroup.send({ id: "base", delta: 1 });
  });
  const assert_group_edited = assert(() =>
    recipe.stepGroups[1]?.id === "base" &&
    recipe.stepGroups[1]?.duration === 15 &&
    recipe.stepGroups[1]?.steps.length === 2 &&
    recipe.ovenRequirements.temps.join() === "350,425" &&
    recipe.ovenRequirements.tempChanges
  );

  // The rack-width button toggles the first oven group's width.
  const action_toggle_width = action(() => clickButton(recipe[UI], "Full"));
  const assert_width_toggled = assert(() =>
    recipe.stepGroups[0]?.oven?.width === "half"
  );

  const action_suggest_timing = action(() =>
    clickButton(recipe[UI], "Suggest Timing")
  );
  const assert_timing_review = assert(() =>
    recipe.timingSuggestions !== null &&
    hasText(recipe[UI], "Review Timing Suggestions") &&
    hasText(recipe[UI], "The night before")
  );
  const action_apply_timing = action(() => recipe.applyTiming.send());
  const assert_timing_applied = assert(() => {
    const g = recipe.stepGroups.find((s) => s.id === "base");
    return !!g && g.nightsBeforeServing === 1 &&
      g.minutesBeforeServing === undefined &&
      g.duration === 10 && g.maxWaitMinutes === 0 &&
      g.oven?.temperature === 350 &&
      recipe.timingSuggestions === null;
  });

  const action_remove = action(() => {
    recipe.removeIngredient.send({ index: 0 });
    recipe.removeStepGroup.send({ id: "base" });
  });
  const assert_removed = assert(() =>
    recipe.ingredients.length === 1 &&
    recipe.ingredients[0]?.item === "butter" &&
    recipe.stepGroups.length === 1 &&
    !recipe.ovenRequirements.tempChanges
  );

  const assert_fs_projection = assert(() =>
    recipe[FS].content.includes("# Roast Chicken") &&
    recipe[FS].content.includes("- 1 cup butter") &&
    recipe[FS].content.includes("### Roast (1h 30m before serving")
  );

  return {
    [TESTS]: [
      { assertion: assert_scales_fractions },
      { assertion: assert_nights_clear_minutes },
      { assertion: assert_oven_needs_temperature },
      { assertion: assert_oven_fields_need_an_oven },
      { assertion: assert_timing_review_shows_rack },
      { assertion: assert_keeps_repeated_ingredients },
      { assertion: assert_word_diff },
      { assertion: assert_word_diff_long },
      { assertion: assert_scalar_changes_skip_unchanged },
      { assertion: assert_starts_untitled },
      { action: action_paste_and_extract },
      { settle: true },
      { assertion: assert_review_shows_changes },
      { action: action_apply },
      { assertion: assert_applied },
      { assertion: assert_oven_derived },
      { action: action_extract_unreadable },
      { settle: true },
      { assertion: assert_failed_extraction },
      { action: recipe.applyExtraction },
      { assertion: assert_failed_apply_keeps_recipe },
      { action: recipe.cancelExtraction },
      { assertion: assert_failure_dismissed },
      { action: action_double },
      { assertion: assert_doubled },
      { action: action_edit_group },
      { assertion: assert_group_edited },
      { action: action_toggle_width },
      { assertion: assert_width_toggled },
      { action: action_suggest_timing },
      { settle: true },
      { assertion: assert_timing_review },
      { action: action_apply_timing },
      { assertion: assert_timing_applied },
      { action: action_remove },
      { assertion: assert_removed },
      { assertion: assert_fs_projection },
    ],
    recipe,
    allowConsoleWarnings: true,
  };
});
