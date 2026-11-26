/**
 * Meal Orchestrator tests, end to end with real food-recipe pieces: the oven
 * conflict and a second oven resolving it, balance as guests change, dietary
 * analysis run through the recipes' own streams (answered by `llmMocks`),
 * linking dishes from the planning notes through review to apply, marking a
 * prepared food as suiting a need, menu suggestions, and the markdown.
 *
 * Run: deno task cf test patterns/apps/meal-orchestrator/meal-orchestrator.test.tsx --verbose
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
  findNodes,
  hasText,
  styleOf,
  typeInto,
} from "../../tools/test-support/vnode-helpers.ts";
import FoodRecipe from "../food-recipe/main.tsx";
import MealOrchestrator from "./main.tsx";

export const llmMocks = [
  {
    when: { lastMessageContains: "- 1 whole turkey" },
    object: {
      compatible: ["gluten-free"],
      incompatible: ["vegan", "vegetarian"],
      warnings: ["Contains poultry"],
      primaryIngredients: ["turkey", "butter"],
    },
  },
  {
    when: { lastMessageContains: "- 2 cup pumpkin" },
    object: {
      compatible: ["vegan", "vegetarian"],
      incompatible: ["gluten-free"],
      warnings: [],
      primaryIngredients: ["pumpkin", "flour"],
    },
  },
  {
    when: { lastMessageContains: "Sam brings rolls" },
    object: {
      items: [
        {
          name: "Dinner Rolls",
          type: "prepared",
          existingName: "",
          quote: "Sam brings rolls",
          servings: 12,
          category: "bread",
          source: "Sam",
        },
        {
          name: "Green Beans",
          type: "recipe",
          existingName: "",
          quote: "green beans",
          category: "vegetable",
        },
        {
          name: "Turkey",
          type: "recipe",
          existingName: "",
          quote: "the turkey",
        },
        {
          name: "Cranberry Sauce",
          type: "prepared",
          existingName: "",
          quote: "maybe cranberry sauce",
        },
      ],
    },
  },
  {
    when: { lastMessageContains: "Meal: Thanksgiving" },
    object: { suggestions: ["Add a vegan main for Sam."] },
  },
];

export default pattern(() => {
  const turkey = FoodRecipe({
    name: "Turkey",
    category: "main",
    servings: 10,
    ingredients: [{ item: "turkey", amount: "1", unit: "whole" }],
    stepGroups: [{
      id: "roast",
      name: "Roast",
      minutesBeforeServing: 300,
      duration: 240,
      oven: { temperature: 325, duration: 240, heightSlots: 3, width: "full" },
      steps: [],
    }],
  });
  const pie = FoodRecipe({
    name: "Pumpkin Pie",
    category: "dessert",
    servings: 8,
    ingredients: [{ item: "pumpkin", amount: "2", unit: "cup" }],
    stepGroups: [{
      id: "bake",
      name: "Bake",
      minutesBeforeServing: 120,
      oven: { temperature: 425, duration: 50, heightSlots: 1, width: "full" },
      steps: [],
    }],
  });
  const guestCount = new Writable(8);
  const meal = MealOrchestrator({
    mealName: "Thanksgiving",
    mealTime: "17:00",
    guestCount,
    recipes: [turkey, pie],
    dietaryProfiles: [{ guestName: "Sam", requirements: ["vegan"] }],
  });

  const assert_starts = assert(() =>
    meal[NAME] === "🍽️ Thanksgiving" &&
    meal.recipes.length === 2 &&
    meal.ovens.length === 1 &&
    meal.balance.categories.map((c) => c.category).join() === "main,dessert" &&
    meal.balance.warnings.length === 0 &&
    meal.linkAnalysis === null
  );

  // A guest with no needs yet is not counted as one with needs.
  const action_blank_guest = action(() => meal.addGuest.send());
  const assert_blank_not_counted = assert(() =>
    meal.dietaryProfiles.length === 2 &&
    hasText(meal[UI], "Dietary Needs (1 guest with needs)")
  );
  const action_drop_blank = action(() => meal.removeGuest.send({ index: 1 }));

  // One oven: the pie wants 425°F while the turkey holds it at 325°F.
  const assert_oven_conflict = assert(() =>
    meal.ovenPlan.conflicts.length === 1 &&
    meal.ovenPlan.conflicts[0].dish === "Pumpkin Pie" &&
    hasText(meal[UI], "Oven Timeline (1 conflict)") &&
    hasText(meal[UI], "Pumpkin Pie (Bake, 425°F from 3:00 PM (2h before))") &&
    hasText(meal[UI], "Oven 1 has Turkey at 325°F.") &&
    hasText(meal[UI], "3:00 PM – 3:50 PM")
  );

  const action_add_oven = action(() => clickButton(meal[UI], "+ Add Oven"));
  // Each timeline bar is placed by a CSS percentage, not "[object Object]%".
  const assert_bars_placed = assert(() => {
    const lefts = findNodes(
      meal[UI],
      (node) => styleOf(node, "position") === "absolute",
    ).map((node) => styleOf(node, "left"));
    return lefts.length === 2 &&
      lefts.every((l) => typeof l === "string" && /^[\d.]+%$/.test(l));
  });
  const assert_resolved = assert(() =>
    meal.ovens.length === 2 &&
    meal.ovenPlan.conflicts.length === 0 &&
    meal.ovenPlan.events.find((e) => e.dish === "Pumpkin Pie")?.oven === 1
  );

  // Input is clamped to the oven's range; the pie still fits the second oven.
  const action_shrink_oven = action(() =>
    meal.setOvenField.send({ index: 1, field: "rackPositions", value: "2" })
  );
  const assert_shrunk = assert(() =>
    meal.ovens[1]?.rackPositions === 3 &&
    meal.ovenPlan.conflicts.length === 0
  );

  const action_more_guests = action(() =>
    meal.setRequirements.send({ index: 0, requirements: ["Vegan", "no nuts"] })
  );
  const assert_requirements_normalized = assert(() =>
    meal.dietaryProfiles[0]?.requirements.join() === "vegan,no-nuts"
  );

  // Nobody has analyzed the recipes yet: their fit is unknown.
  const assert_unknown_before_analysis = assert(() =>
    meal.dietary[0]?.unknown.join() === "Turkey,Pumpkin Pie" &&
    meal.dietary[0]?.warning ===
      "Nothing on the menu is known to suit Sam (vegan)." &&
    hasText(meal[UI], "Analyze Diets (2)")
  );

  const action_analyze = action(() =>
    clickButton(meal[UI], "Analyze Diets (2)")
  );
  const assert_analyzed = assert(() => {
    const vegan = meal.dietary.find((c) => c.requirement === "vegan");
    const nuts = meal.dietary.find((c) => c.requirement === "no-nuts");
    return meal.recipes.every((r) => r.dietarySource === "analyzed") &&
      vegan?.fits.join() === "Pumpkin Pie" &&
      vegan?.conflicts.join() === "Turkey" &&
      vegan?.warning === "No main is known to suit Sam (vegan)." &&
      // Nuts are a class of food: only a nut-free tag could say a dish has
      // none, so missing from the main ingredients is not enough.
      nuts?.fits.length === 0 &&
      nuts?.unknown.join() === "Turkey,Pumpkin Pie" &&
      !hasText(meal[UI], "Analyze Diets");
  });

  const action_write_notes = action(() =>
    typeInto(
      meal[UI],
      "Rough ideas: turkey, Mom's stuffing, pie from Costco, Sam brings rolls...",
      "Sam brings rolls, plus green beans and the turkey, maybe cranberry sauce",
    )
  );
  const action_link = action(() =>
    clickButton(meal[UI], "Link Dishes from Notes")
  );
  const assert_review = assert(() =>
    meal.linkAnalysis?.items.length === 4 &&
    hasText(meal[UI], "Review Dishes from Notes") &&
    hasText(meal[UI], "Create new prepared food") &&
    hasText(meal[UI], "Skip: already in the meal") &&
    hasText(meal[UI], '"Sam brings rolls"')
  );

  // Uncheck the cranberry sauce, then add the rest.
  const action_apply = action(() => {
    meal.toggleLinkItem.send({ index: 3 });
    meal.applyLinking.send();
  });
  const assert_applied = assert(() =>
    meal.linkAnalysis === null &&
    meal.recipes.length === 3 &&
    meal.recipes[2]?.name === "Green Beans" &&
    meal.recipes[2]?.category === "vegetable" &&
    meal.recipes[2]?.dietarySource === "none" &&
    meal.preparedFoods.length === 1 &&
    meal.preparedFoods[0]?.name === "Dinner Rolls" &&
    meal.preparedFoods[0]?.servings === 12 &&
    meal.preparedFoods[0]?.category === "bread" &&
    meal.mentionable.length === 2 &&
    meal.balance.categories.map((c) => c.category).join() ===
      "main,vegetable,dessert,bread"
  );

  // The rolls' fit is declared by hand; marking them records it on the rolls.
  const action_mark = action(() =>
    clickButton(meal[UI], "I checked: Dinner Rolls is vegan")
  );
  const assert_marked = assert(() =>
    meal.preparedFoods[0]?.dietaryCompatibility?.compatible.join() ===
      "vegan" &&
    meal.dietary.find((c) => c.requirement === "vegan")?.fits.join() ===
      "Pumpkin Pie,Dinner Rolls"
  );

  const action_guests = action(() => guestCount.set(12));
  const assert_short = assert(() =>
    meal.balance.warnings.join("|") ===
      "Mains serve 10 for 12 guests.|Vegetables serve 4 for 12 guests.|Desserts serve 8 for 12 guests."
  );

  const action_suggest = action(() =>
    clickButton(meal[UI], "Suggest Improvements")
  );
  const assert_suggested = assert(() =>
    meal.suggestions?.suggestions.join() === "Add a vegan main for Sam." &&
    hasText(meal[UI], "Add a vegan main for Sam.")
  );

  const action_remove = action(() => {
    meal.removeRecipe.send({ index: 0 });
    meal.removeOven.send({ index: 1 });
  });
  const assert_removed = assert(() =>
    meal.recipes.length === 2 &&
    meal.recipes[0]?.name === "Pumpkin Pie" &&
    meal.ovens.length === 1 &&
    meal.ovenPlan.conflicts.length === 0 &&
    meal.mentionable.length === 2
  );

  const assert_fs = assert(() =>
    meal[FS].content.includes("# Thanksgiving") &&
    meal[FS].content.includes("- Dinner Rolls (bread, serves 12)") &&
    meal[FS].content.includes("- Sam: vegan, no-nuts") &&
    meal[FS].content.includes(
      "- 3:00 PM (2h before): Pumpkin Pie (Bake) at 425°F for 50 min, oven 1",
    )
  );

  return {
    [TESTS]: [
      { assertion: assert_starts },
      { action: action_blank_guest },
      { assertion: assert_blank_not_counted },
      { action: action_drop_blank },
      { assertion: assert_oven_conflict },
      { action: action_add_oven },
      { assertion: assert_resolved },
      { assertion: assert_bars_placed },
      { action: action_shrink_oven },
      { assertion: assert_shrunk },
      { action: action_more_guests },
      { assertion: assert_requirements_normalized },
      { assertion: assert_unknown_before_analysis },
      { action: action_analyze },
      { settle: true },
      { assertion: assert_analyzed },
      { action: action_write_notes },
      { action: action_link },
      { settle: true },
      { assertion: assert_review },
      { action: action_apply },
      { assertion: assert_applied },
      { action: action_mark },
      { assertion: assert_marked },
      { action: action_guests },
      { assertion: assert_short },
      { action: action_suggest },
      { settle: true },
      { assertion: assert_suggested },
      { action: action_remove },
      { assertion: assert_removed },
      { assertion: assert_fs },
    ],
    meal,
    allowConsoleWarnings: true,
  };
});
