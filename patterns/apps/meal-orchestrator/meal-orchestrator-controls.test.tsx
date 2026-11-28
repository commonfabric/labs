/**
 * Meal Orchestrator tests for the controls its view binds: adding dishes from
 * the space and filtering them, the number inputs, each oven's inputs, the
 * dietary tags, the remove buttons, menu suggestions while an oven conflict
 * stands, and linking notes to dishes already in the space through cancel,
 * the review's checkboxes, and apply.
 *
 * The meal finds the space's dishes with `#recipe` and `#preparedFood` wishes
 * over the space's mentionables. A wish there matches a piece by the tag its
 * schema carries or by its name, and a piece made in a test carries no tag, so
 * the dishes the test lists are `ShelfDish` pieces named for the tag.
 *
 * Run: deno task cf test patterns/apps/meal-orchestrator/meal-orchestrator-controls.test.tsx --root patterns --verbose
 */
import {
  action,
  assert,
  type Default,
  NAME,
  pattern,
  TESTS,
  UI,
  wish,
  type Writable,
} from "commonfabric";
import {
  clickButton,
  findElement,
  findNode,
  findNodeByProp,
  fireClick,
  fireEvent,
  hasText,
  isElement,
  propValue,
  typeInto,
} from "../../tools/test-support/vnode-helpers.ts";
import type { RecipeCategory, StepGroup } from "../food-recipe/schemas.tsx";
import MealOrchestrator from "./main.tsx";

const NOTES_PLACEHOLDER =
  "Rough ideas: turkey, Mom's stuffing, pie from Costco, Sam brings rolls...";
const FILTER_PLACEHOLDER = "Filter recipes and prepared foods...";

export const llmMocks = [
  {
    when: { lastMessageContains: "the roast, a cheese plate and a baguette" },
    repeat: true,
    object: {
      items: [
        {
          name: "Roast",
          type: "recipe",
          existingName: "Roast",
          quote: "the roast",
        },
        {
          name: "Cheese Plate",
          type: "prepared",
          existingName: "Cheese Plate",
          quote: "a cheese plate",
        },
        {
          name: "Baguette",
          type: "prepared",
          existingName: "Baguette",
          quote: "a baguette",
        },
      ],
    },
  },
  {
    when: { lastMessageContains: "- Tart: Oven 1 has Roast at 350°F." },
    object: { suggestions: ["Bake the tart before the roast goes in."] },
  },
];

interface ShelfDishInput {
  tag: string;
  name: string;
  category: RecipeCategory;
  servings: number;
  stepGroups?: StepGroup[] | Default<[]>;
}

interface ShelfDishOutput {
  [NAME]: string;
  name: string;
  category: RecipeCategory;
  servings: number;
  stepGroups: StepGroup[];
}

/** A dish a `#<tag>` wish over the space's mentionables finds by its name. */
const ShelfDish = pattern<ShelfDishInput, ShelfDishOutput>((
  { tag, name, category, servings, stepGroups },
) => ({ [NAME]: tag, name, category, servings, stepGroups }));

// ===== View helpers =====

/** The number input with these bounds. */
const numberInput = (root: unknown, min: string, max?: string): unknown =>
  findNode(
    root,
    (node) =>
      isElement(node, "cf-input") && propValue(node, "min") === min &&
      propValue(node, "max") === max,
  );

const change = (node: unknown, value: string) =>
  fireEvent(node, "oncf-change", { detail: { value } });

const removeButton = (root: unknown, label: string): unknown =>
  findNodeByProp(root, "aria-label", label);

const names = (dishes: readonly { name?: string }[]): string =>
  dishes.map((d) => d?.name).join();

export default pattern(() => {
  const mentionable = wish<Writable<object[]>>({ query: "#mentionable" })
    .result!;

  const roast = ShelfDish({
    tag: "recipe",
    name: "Roast",
    category: "main",
    servings: 6,
    stepGroups: [{
      id: "roast",
      name: "Roast",
      minutesBeforeServing: 180,
      duration: 120,
      oven: { temperature: 350, duration: 120, heightSlots: 2, width: "full" },
      steps: [],
    }],
  });
  const tart = ShelfDish({
    tag: "recipe",
    name: "Tart",
    category: "dessert",
    servings: 6,
    stepGroups: [{
      id: "bake",
      name: "Bake",
      minutesBeforeServing: 120,
      oven: { temperature: 425, duration: 40, heightSlots: 1, width: "full" },
      steps: [],
    }],
  });
  const stew = ShelfDish({
    tag: "recipe",
    name: "Beef Stew",
    category: "main",
    servings: 6,
  });
  const baguette = ShelfDish({
    tag: "preparedFood",
    name: "Baguette",
    category: "bread",
    servings: 8,
  });
  const cheese = ShelfDish({
    tag: "preparedFood",
    name: "Cheese Plate",
    category: "appetizer",
    servings: 6,
  });

  const meal = MealOrchestrator({
    mealName: "Supper",
    mealTime: "18:00",
    dietaryProfiles: [{ guestName: "Ana", requirements: ["vegan"] }],
  });

  // ===== Dishes from the space =====

  const action_list_dishes = action(() => {
    mentionable.pushAll([roast, tart, stew, baguette, cheese]);
  });
  const assert_offers_dishes = assert(() =>
    meal.recipes.length === 0 &&
    hasText(meal[UI], "+ 🍳 Roast") &&
    hasText(meal[UI], "+ 🍳 Tart") &&
    hasText(meal[UI], "+ 🍳 Beef Stew") &&
    hasText(meal[UI], "+ 🛒 Baguette") &&
    hasText(meal[UI], "+ 🛒 Cheese Plate")
  );

  const action_filter = action(() =>
    typeInto(meal[UI], FILTER_PLACEHOLDER, " BAG ")
  );
  const assert_filtered = assert(() =>
    hasText(meal[UI], "+ 🛒 Baguette") &&
    !hasText(meal[UI], "+ 🛒 Cheese Plate") &&
    !hasText(meal[UI], "+ 🍳 Beef Stew")
  );
  const action_add_baguette = action(() =>
    clickButton(meal[UI], "+ 🛒 Baguette")
  );
  const action_filter_nothing = action(() =>
    typeInto(meal[UI], FILTER_PLACEHOLDER, "zzz")
  );
  const assert_nothing_matches = assert(() =>
    hasText(meal[UI], "Nothing here matches the filter.") &&
    !hasText(meal[UI], "+ 🛒 Cheese Plate")
  );
  const action_clear_filter = action(() =>
    typeInto(meal[UI], FILTER_PLACEHOLDER, "")
  );
  const action_add_roast = action(() => clickButton(meal[UI], "+ 🍳 Roast"));
  const action_add_tart = action(() => clickButton(meal[UI], "+ 🍳 Tart"));
  const action_add_stew = action(() => clickButton(meal[UI], "+ 🍳 Beef Stew"));
  // A dish in the meal is no longer offered.
  const assert_added = assert(() =>
    names(meal.recipes) === "Roast,Tart,Beef Stew" &&
    names(meal.preparedFoods) === "Baguette" &&
    !hasText(meal[UI], "+ 🍳 Roast") &&
    !hasText(meal[UI], "+ 🍳 Beef Stew") &&
    !hasText(meal[UI], "+ 🛒 Baguette") &&
    hasText(meal[UI], "+ 🛒 Cheese Plate")
  );

  // ===== Suggestions while an oven conflict stands =====

  // The tart wants 425°F while the roast holds the one oven at 350°F, and the
  // model is told so: the mock answers only a prompt that names the conflict.
  const assert_conflict = assert(() =>
    meal.ovenPlan.conflicts.length === 1 &&
    meal.ovenPlan.conflicts[0]?.dish === "Tart"
  );
  const action_suggest = action(() =>
    clickButton(meal[UI], "Suggest Improvements")
  );
  const assert_suggested = assert(() =>
    meal.suggestions?.suggestions.join() ===
      "Bake the tart before the roast goes in."
  );

  // ===== Number inputs =====

  const action_set_numbers = action(() => {
    change(numberInput(meal[UI], "1"), " 6.4 ");
    change(numberInput(meal[UI], "0", "12"), "-3");
  });
  const assert_numbers_set = assert(() =>
    meal.guestCount === 6 && meal.stovetopBurners === 0
  );
  // Text that is not a number, or nothing, leaves the count as it was.
  const action_bad_numbers = action(() => {
    change(numberInput(meal[UI], "1"), "many");
    change(numberInput(meal[UI], "1"), " ");
  });
  const assert_numbers_kept = assert(() => meal.guestCount === 6);

  // ===== Ovens =====

  const action_add_oven = action(() => meal.addOven.send());
  // The first oven's inputs edit the first oven only, within its bounds.
  const action_edit_first_oven = action(() => {
    change(numberInput(meal[UI], "3", "7"), "6");
    change(numberInput(meal[UI], "1", "3"), "9");
  });
  const assert_first_oven_edited = assert(() =>
    meal.ovens.length === 2 &&
    meal.ovens[0]?.rackPositions === 6 &&
    meal.ovens[0]?.physicalRacks === 3 &&
    meal.ovens[1]?.rackPositions === 5 &&
    meal.ovens[1]?.physicalRacks === 2
  );
  const action_remove_first_oven = action(() =>
    fireClick(removeButton(meal[UI], "Remove oven"))
  );
  const assert_first_oven_removed = assert(() =>
    meal.ovens.length === 1 && meal.ovens[0]?.rackPositions === 5
  );

  // ===== Guests =====

  const action_add_guest = action(() => meal.addGuest.send());
  const action_tag_first_guest = action(() =>
    fireEvent(findElement(meal[UI], "cf-tags"), "oncf-change", {
      detail: { tags: ["Gluten Free", "vegan", "VEGAN"] },
    })
  );
  const assert_tagged = assert(() =>
    meal.dietaryProfiles[0]?.requirements.join() === "gluten-free,vegan" &&
    meal.dietaryProfiles[1]?.requirements.length === 0
  );
  const action_remove_first_guest = action(() =>
    fireClick(removeButton(meal[UI], "Remove guest"))
  );
  const assert_first_guest_removed = assert(() =>
    meal.dietaryProfiles.length === 1 &&
    meal.dietaryProfiles[0]?.guestName === "" &&
    hasText(meal[UI], "Dietary Needs (0 guests with needs)")
  );

  // ===== Removing dishes =====

  const action_remove_dishes = action(() => {
    fireClick(removeButton(meal[UI], "Remove recipe"));
    fireClick(removeButton(meal[UI], "Remove prepared food"));
  });
  // A dish taken out of the meal is offered from the space again.
  const assert_dishes_removed = assert(() =>
    names(meal.recipes) === "Tart,Beef Stew" &&
    meal.preparedFoods.length === 0 &&
    hasText(meal[UI], "+ 🍳 Roast") &&
    hasText(meal[UI], "+ 🛒 Baguette")
  );

  // ===== Linking notes to dishes in the space =====

  const action_write_notes = action(() =>
    typeInto(
      meal[UI],
      NOTES_PLACEHOLDER,
      "the roast, a cheese plate and a baguette",
    )
  );
  const action_link = action(() =>
    clickButton(meal[UI], "Link Dishes from Notes")
  );
  const assert_review = assert(() =>
    meal.linkAnalysis?.items.length === 3 &&
    hasText(meal[UI], "Add existing recipe") &&
    hasText(meal[UI], "Add existing prepared food") &&
    !hasText(meal[UI], "Skip: unchecked")
  );

  // Cancel closes the review and adds nothing.
  const action_cancel = action(() => clickButton(meal[UI], "Cancel"));
  const assert_cancelled = assert(() =>
    meal.linkAnalysis === null &&
    names(meal.recipes) === "Tart,Beef Stew" &&
    meal.preparedFoods.length === 0
  );

  // The roast's checkbox unchecks it; the baguette is unchecked by stream.
  const action_uncheck = action(() => {
    fireEvent(findElement(meal[UI], "cf-checkbox"), "oncf-change", {});
    meal.toggleLinkItem.send({ index: 2 });
  });
  const assert_unchecked = assert(() =>
    hasText(meal[UI], "Skip: unchecked") &&
    !hasText(meal[UI], "Add existing recipe")
  );
  // Its checkbox again checks the roast back.
  const action_recheck = action(() =>
    fireEvent(findElement(meal[UI], "cf-checkbox"), "oncf-change", {})
  );
  const assert_rechecked = assert(() =>
    hasText(meal[UI], "Add existing recipe") &&
    hasText(meal[UI], "Skip: unchecked")
  );

  const action_apply = action(() => clickButton(meal[UI], "Add Checked"));
  // The checked dishes join the meal as the space's own pieces; nothing is
  // created, and the unchecked baguette stays out.
  const assert_applied = assert(() =>
    meal.linkAnalysis === null &&
    names(meal.recipes) === "Tart,Beef Stew,Roast" &&
    names(meal.preparedFoods) === "Cheese Plate" &&
    meal.mentionable.length === 0 &&
    !hasText(meal[UI], "+ 🍳 Roast") &&
    hasText(meal[UI], "+ 🛒 Baguette")
  );

  return {
    [TESTS]: [
      { action: action_list_dishes },
      { assertion: assert_offers_dishes },
      { action: action_filter },
      { assertion: assert_filtered },
      { action: action_add_baguette },
      { action: action_filter_nothing },
      { assertion: assert_nothing_matches },
      { action: action_clear_filter },
      { action: action_add_roast },
      { action: action_add_tart },
      { action: action_add_stew },
      { assertion: assert_added },
      { assertion: assert_conflict },
      { action: action_suggest },
      { settle: true },
      { assertion: assert_suggested },
      { action: action_set_numbers },
      { assertion: assert_numbers_set },
      { action: action_bad_numbers },
      { assertion: assert_numbers_kept },
      { action: action_add_oven },
      { action: action_edit_first_oven },
      { assertion: assert_first_oven_edited },
      { action: action_remove_first_oven },
      { assertion: assert_first_oven_removed },
      { action: action_add_guest },
      { action: action_tag_first_guest },
      { assertion: assert_tagged },
      { action: action_remove_first_guest },
      { assertion: assert_first_guest_removed },
      { action: action_remove_dishes },
      { assertion: assert_dishes_removed },
      { action: action_write_notes },
      { action: action_link },
      { settle: true },
      { assertion: assert_review },
      { action: action_cancel },
      { assertion: assert_cancelled },
      { action: action_link },
      { settle: true },
      { assertion: assert_review },
      { action: action_uncheck },
      { assertion: assert_unchecked },
      { action: action_recheck },
      { assertion: assert_rechecked },
      { action: action_apply },
      { assertion: assert_applied },
    ],
    meal,
  };
});
