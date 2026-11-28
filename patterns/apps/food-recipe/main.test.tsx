/**
 * Food Recipe editor tests, driven through the rendered view: the number
 * fields, tags and photos, the scaling and ingredient buttons, and every
 * control on a step group card (moving and removing groups, the timing and
 * oven fields, and moving, removing and adding steps).
 *
 * Extraction, timing suggestions and the recipe logic are in
 * food-recipe.test.tsx.
 *
 * Run: deno task cf test patterns/apps/food-recipe/main.test.tsx --verbose
 */
import {
  action,
  assert,
  type ImageData,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  findElement,
  findElementByText,
  findNode,
  findNodeByProp,
  findNodes,
  fireClick,
  fireEvent,
  hasText,
  innermostNode,
  isButton,
  isElement,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import FoodRecipe from "./main.tsx";
import type { Ingredient, StepGroup } from "./schemas.tsx";

const dough: StepGroup = {
  id: "dough",
  name: "Dough",
  steps: [
    { description: "Mix" },
    { description: "Knead" },
    { description: "Rest" },
  ],
};
const bake: StepGroup = {
  id: "bake",
  name: "Bake",
  steps: [{ description: "Bake" }],
};

const image = (url: string): ImageData => ({
  id: url,
  name: url,
  url,
  data: "",
  timestamp: 0,
  size: 0,
  type: "image/png",
});

/** The `cf-input` inside the first label whose text carries `label`. */
const inputLabelled = (root: unknown, label: string) =>
  findElement(findElementByText(root, "label", label), "cf-input");

/** Types `value` into the input labelled `label`, as cf-input reports it. */
const change = (root: unknown, label: string, value: string) =>
  fireEvent(
    inputLabelled(root, label),
    "oncf-change",
    { detail: { value } },
    `the "${label}" input`,
  );

/** The card of the step group whose name field holds `name`. */
const groupCard = (root: unknown, name: string) =>
  innermostNode(
    root,
    (node) =>
      isElement(node, "cf-card") &&
      findNodeByProp(node, "$value", name) !== undefined,
  );

/** The `index`th control under `root` with the aria-label `label`. */
const ariaControl = (root: unknown, label: string, index = 0) =>
  findNodes(root, (node) => propValue(node, "aria-label") === label)[index];

const extractDisabled = (root: unknown) =>
  propValue(findNode(root, isButton("Extract Recipe Data")), "disabled");

const stepsOf = (groups: StepGroup[], id: string) =>
  groups.find((g) => g.id === id)?.steps.map((s) => s.description).join();

export default pattern(() => {
  const stepGroups = new Writable<StepGroup[]>([dough, bake]);
  const ingredients = new Writable<Ingredient[]>([
    { item: "flour", amount: "2", unit: "cup" },
    { item: "salt", amount: "1", unit: "tsp" },
  ]);
  const recipe = FoodRecipe({ stepGroups, ingredients });

  // --- Scaling and ingredients ----------------------------------------------

  const action_halve = action(() => clickButton(recipe[UI], "÷2"));
  const assert_halved = assert(() =>
    recipe.servings === 2 &&
    recipe.ingredients.map((i) => i.amount).join() === "1,1/2"
  );
  const action_one_and_a_half = action(() => clickButton(recipe[UI], "×1.5"));
  const assert_one_and_a_half = assert(() =>
    recipe.servings === 3 &&
    recipe.ingredients.map((i) => i.amount).join() === "1 1/2,3/4"
  );

  const action_add_ingredient = action(() =>
    clickButton(recipe[UI], "+ Add Ingredient")
  );
  const assert_blank_ingredient_added = assert(() =>
    recipe.ingredients.length === 3 &&
    recipe.ingredients[2]?.item === "" &&
    recipe.ingredients[2]?.amount === "" &&
    recipe.ingredients[2]?.unit === ""
  );
  const action_remove_first_ingredient = action(() =>
    fireClick(
      ariaControl(recipe[UI], "Remove ingredient", 0),
      "the first ingredient's remove button",
    )
  );
  const assert_first_ingredient_removed = assert(() =>
    recipe.ingredients.map((i) => i.item).join() === "salt,"
  );

  // --- Number fields --------------------------------------------------------

  const action_type_numbers = action(() => {
    change(recipe[UI], "Servings", "6.4");
    change(recipe[UI], "Prep Time (min)", "12");
    change(recipe[UI], "Cook Time (min)", "30");
    change(recipe[UI], "Rest Time (min)", "5");
    change(recipe[UI], "Hold Time (min)", "10");
  });
  const assert_numbers_set = assert(() =>
    recipe.servings === 6 && recipe.prepTime === 12 &&
    recipe.cookTime === 30 && recipe.restTime === 5 &&
    recipe.holdTime === 10 && recipe.totalTime === 47 &&
    hasText(recipe[UI], "47 min total")
  );
  // Blank, non-numeric and negative input leave the field as it was.
  const action_type_invalid = action(() => {
    change(recipe[UI], "Servings", "");
    change(recipe[UI], "Servings", "lots");
    change(recipe[UI], "Prep Time (min)", "-3");
    fireEvent(inputLabelled(recipe[UI], "Cook Time (min)"), "oncf-change", {});
  });
  const assert_invalid_ignored = assert(() =>
    recipe.servings === 6 && recipe.prepTime === 12 && recipe.cookTime === 30
  );
  const action_zero_servings = action(() =>
    change(recipe[UI], "Servings", "0")
  );
  const assert_servings_at_least_one = assert(() => recipe.servings === 1);

  // --- Tags and photos ------------------------------------------------------

  const action_set_tags = action(() =>
    fireEvent(findElement(recipe[UI], "cf-tags"), "oncf-change", {
      detail: { tags: [" spicy ", "vegan", "spicy", ""] },
    })
  );
  const assert_tags_trimmed_and_unique = assert(() =>
    recipe.tags.join() === "spicy,vegan"
  );

  // With no notes, a photo is what makes extraction possible.
  const assert_extract_needs_input = assert(() =>
    recipe.notes === "" && extractDisabled(recipe[UI]) === true
  );
  const action_add_photos = action(() =>
    fireEvent(findElement(recipe[UI], "cf-image-input"), "oncf-change", {
      detail: {
        images: [image("https://images.example/b.png")],
        allImages: [
          image("https://images.example/a.png"),
          image("https://images.example/b.png"),
        ],
      },
    })
  );
  const assert_photo_enables_extract = assert(() =>
    extractDisabled(recipe[UI]) === false
  );
  const action_remove_photos = action(() =>
    fireEvent(findElement(recipe[UI], "cf-image-input"), "oncf-remove", {
      detail: { images: [] },
    })
  );
  const assert_no_photo_disables_extract = assert(() =>
    extractDisabled(recipe[UI]) === true
  );

  // --- Step groups ----------------------------------------------------------

  const action_add_group = action(() => clickButton(recipe[UI], "+ Add Group"));
  const assert_group_added = assert(() => {
    const added = recipe.stepGroups[2];
    return recipe.stepGroups.length === 3 &&
      added?.name === "New Step Group" &&
      /^g[0-9a-z]+$/.test(added.id) &&
      added.steps.length === 1 && added.steps[0]?.description === "";
  });

  const action_move_dough_down = action(() =>
    fireClick(
      ariaControl(groupCard(recipe[UI], "Dough"), "Move group down"),
      "Dough's move-down button",
    )
  );
  const assert_dough_moved_down = assert(() =>
    recipe.stepGroups.map((g) => g.name).join() ===
      "Bake,Dough,New Step Group"
  );
  const action_move_new_group_up = action(() =>
    fireClick(
      ariaControl(groupCard(recipe[UI], "New Step Group"), "Move group up"),
      "the new group's move-up button",
    )
  );
  const assert_new_group_moved_up = assert(() =>
    recipe.stepGroups.map((g) => g.name).join() ===
      "Bake,New Step Group,Dough"
  );
  // The first group has nowhere higher to go.
  const action_move_first_group_up = action(() =>
    fireClick(
      ariaControl(groupCard(recipe[UI], "Bake"), "Move group up"),
      "Bake's move-up button",
    )
  );
  const action_remove_new_group = action(() =>
    fireClick(
      findNode(
        groupCard(recipe[UI], "New Step Group"),
        isButton("Remove Group"),
      ),
      "the new group's remove button",
    )
  );
  const assert_new_group_removed = assert(() =>
    recipe.stepGroups.map((g) => g.id).join() === "bake,dough"
  );

  // --- A group's timing and oven fields -------------------------------------

  const action_set_timing = action(() => {
    const card = groupCard(recipe[UI], "Dough");
    change(card, "Nights before", "1");
    change(card, "Takes (min)", "20");
    change(card, "Can wait (min)", "15");
  });
  const assert_timing_set = assert(() => {
    const g = recipe.stepGroups.find((s) => s.id === "dough");
    return g?.nightsBeforeServing === 1 && g.duration === 20 &&
      g.maxWaitMinutes === 15 &&
      propValue(
          inputLabelled(groupCard(recipe[UI], "Dough"), "Nights before"),
          "value",
        ) === "1" &&
      recipe.stepGroups.find((s) => s.id === "bake")?.duration === undefined;
  });
  // Minutes before serving replaces the night before; a blank field clears.
  const action_change_timing = action(() => {
    const card = groupCard(recipe[UI], "Dough");
    change(card, "or min before serving", "90");
    change(card, "Can wait (min)", "");
  });
  const assert_timing_changed = assert(() => {
    const g = recipe.stepGroups.find((s) => s.id === "dough");
    return g?.minutesBeforeServing === 90 &&
      g.nightsBeforeServing === undefined &&
      g.maxWaitMinutes === undefined && g.duration === 20;
  });

  // A group uses the oven once it has a temperature; the other oven fields
  // apply to that.
  const action_set_temperature = action(() =>
    change(groupCard(recipe[UI], "Dough"), "Temp (°F)", "400")
  );
  const action_set_oven = action(() => {
    const card = groupCard(recipe[UI], "Dough");
    change(card, "In oven (min)", "25");
    change(card, "Rack height", "3");
  });
  const assert_oven_set = assert(() => {
    const oven = recipe.stepGroups.find((s) => s.id === "dough")?.oven;
    return oven?.temperature === 400 && oven.duration === 25 &&
      oven.heightSlots === 3 && oven.width === "full" &&
      recipe.ovenRequirements.temps.join() === "400";
  });
  const action_clear_temperature = action(() =>
    change(groupCard(recipe[UI], "Dough"), "Temp (°F)", "")
  );
  const assert_oven_cleared = assert(() =>
    recipe.stepGroups.find((s) => s.id === "dough")?.oven === undefined &&
    !recipe.ovenRequirements.needsOven
  );

  // --- Steps ----------------------------------------------------------------

  const action_move_first_step_down = action(() =>
    fireClick(
      ariaControl(groupCard(recipe[UI], "Dough"), "Move step down", 0),
      "the first step's move-down button",
    )
  );
  const assert_first_step_moved_down = assert(() =>
    stepsOf(recipe.stepGroups, "dough") === "Knead,Mix,Rest"
  );
  const action_move_last_step_up = action(() =>
    fireClick(
      ariaControl(groupCard(recipe[UI], "Dough"), "Move step up", 2),
      "the last step's move-up button",
    )
  );
  const assert_last_step_moved_up = assert(() =>
    stepsOf(recipe.stepGroups, "dough") === "Knead,Rest,Mix"
  );
  const action_remove_first_step = action(() =>
    fireClick(
      ariaControl(groupCard(recipe[UI], "Dough"), "Remove step", 0),
      "the first step's remove button",
    )
  );
  const assert_first_step_removed = assert(() =>
    stepsOf(recipe.stepGroups, "dough") === "Rest,Mix"
  );
  const action_add_step = action(() =>
    fireClick(
      findNode(groupCard(recipe[UI], "Dough"), isButton("+ Add Step")),
      "Dough's add-step button",
    )
  );
  const assert_step_added_to_its_group = assert(() =>
    stepsOf(recipe.stepGroups, "dough") === "Rest,Mix," &&
    stepsOf(recipe.stepGroups, "bake") === "Bake"
  );

  // Cook opens the cooking view; the recipe itself is left as it was.
  const assert_cooking_leaves_recipe = assert(() =>
    recipe.stepGroups.map((g) => g.id).join() === "bake,dough" &&
    stepsOf(recipe.stepGroups, "dough") === "Rest,Mix," &&
    recipe.servings === 1
  );

  return {
    [TESTS]: [
      { action: action_halve },
      { assertion: assert_halved },
      { action: action_one_and_a_half },
      { assertion: assert_one_and_a_half },
      { action: action_add_ingredient },
      { assertion: assert_blank_ingredient_added },
      { action: action_remove_first_ingredient },
      { assertion: assert_first_ingredient_removed },
      { action: action_type_numbers },
      { assertion: assert_numbers_set },
      { action: action_type_invalid },
      { assertion: assert_invalid_ignored },
      { action: action_zero_servings },
      { assertion: assert_servings_at_least_one },
      { action: action_set_tags },
      { assertion: assert_tags_trimmed_and_unique },
      { assertion: assert_extract_needs_input },
      { action: action_add_photos },
      { assertion: assert_photo_enables_extract },
      { action: action_remove_photos },
      { assertion: assert_no_photo_disables_extract },
      { action: action_add_group },
      { assertion: assert_group_added },
      { action: action_move_dough_down },
      { assertion: assert_dough_moved_down },
      { action: action_move_new_group_up },
      { assertion: assert_new_group_moved_up },
      { action: action_move_first_group_up },
      { assertion: assert_new_group_moved_up },
      { action: action_remove_new_group },
      { assertion: assert_new_group_removed },
      { action: action_set_timing },
      { assertion: assert_timing_set },
      { action: action_change_timing },
      { assertion: assert_timing_changed },
      { action: action_set_temperature },
      { action: action_set_oven },
      { assertion: assert_oven_set },
      { action: action_clear_temperature },
      { assertion: assert_oven_cleared },
      { action: action_move_first_step_down },
      { assertion: assert_first_step_moved_down },
      { action: action_move_last_step_up },
      { assertion: assert_last_step_moved_up },
      { action: action_remove_first_step },
      { assertion: assert_first_step_removed },
      { action: action_add_step },
      { assertion: assert_step_added_to_its_group },
      { press: recipe[UI], control: "👨‍🍳 Cook" },
      { assertion: assert_cooking_leaves_recipe },
    ],
    recipe,
  };
});
