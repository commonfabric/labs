/**
 * Prepared Food tests: declared dietary tags, quick-add, the number fields,
 * and the `dietaryCompatibility` a meal planner reads.
 *
 * Run: deno task cf test patterns/apps/food-recipe/prepared-food.test.tsx --verbose
 */
import { action, assert, FS, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  findElement,
  findNode,
  fireEvent,
  isElement,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import PreparedFood, { normalizedTags } from "./prepared-food.tsx";

/** Types `value` into the number input whose minimum is `min`: "1" for
 * servings, "0" for prep time. */
const typeNumber = (ui: unknown, min: string, value: string) =>
  fireEvent(
    findNode(
      ui,
      (node) => isElement(node, "cf-input") && propValue(node, "min") === min,
    ),
    "oncf-change",
    { detail: { value } },
    `the number input with min ${min}`,
  );

export default pattern(() => {
  const food = PreparedFood({
    name: "Costco Rotisserie Chicken",
    servings: 6,
    category: "main",
    source: "Costco",
  });

  const assert_normalizes_tags = assert(() =>
    normalizedTags([" Vegan", "vegan", "", "Nut-Free "]).join() ===
      "vegan,nut-free"
  );

  const assert_starts = assert(() =>
    food[NAME] === "🛒 Costco Rotisserie Chicken" &&
    food.servings === 6 &&
    food.dietaryCompatibility.compatible.length === 0 &&
    food.dietaryCompatibility.warnings.length === 0 &&
    food.dietarySource === "none"
  );

  const action_quick_add = action(() => clickButton(food[UI], "+ gluten-free"));
  const assert_quick_added = assert(() =>
    food.dietaryTags.join() === "gluten-free" &&
    food.dietaryCompatibility.compatible.join() === "gluten-free" &&
    food.dietaryCompatibility.warnings.length === 1 &&
    food.dietarySource === "declared"
  );

  // The tag editor reports its whole list; it is normalized on the way in.
  const action_edit_tags = action(() =>
    fireEvent(findElement(food[UI], "cf-tags"), "oncf-change", {
      detail: { tags: ["gluten-free", "Dairy-Free", "dairy-free"] },
    })
  );
  const action_add_twice = action(() =>
    food.addDietaryTag.send({ tag: "GLUTEN-FREE" })
  );
  const assert_tags_normalized = assert(() =>
    food.dietaryTags.join() === "gluten-free,dairy-free"
  );

  const action_servings_rounded = action(() =>
    typeNumber(food[UI], "1", " 8.4 ")
  );
  const assert_servings_rounded = assert(() => food.servings === 8);

  // Text that is not a number, or nothing at all, leaves the value alone.
  const action_servings_not_a_number = action(() =>
    typeNumber(food[UI], "1", "lots")
  );
  const action_servings_blank = action(() => typeNumber(food[UI], "1", "  "));
  const assert_servings_kept = assert(() => food.servings === 8);

  const action_servings_too_low = action(() => typeNumber(food[UI], "1", "0"));
  const assert_servings_clamped = assert(() => food.servings === 1);

  const action_prep_set = action(() => typeNumber(food[UI], "0", "15"));
  const assert_prep_set = assert(() =>
    food.prepTime === 15 && food.servings === 1 &&
    food[FS].content.includes("Prep: 15 min")
  );

  const action_prep_negative = action(() => typeNumber(food[UI], "0", "-5"));
  const assert_prep_clamped = assert(() =>
    food.prepTime === 0 && !food[FS].content.includes("Prep:")
  );

  const assert_fs = assert(() =>
    food[FS].content.includes("From: Costco") &&
    food[FS].content.includes("Dietary: gluten-free, dairy-free")
  );

  return {
    [TESTS]: [
      { assertion: assert_normalizes_tags },
      { assertion: assert_starts },
      { action: action_quick_add },
      { assertion: assert_quick_added },
      { action: action_edit_tags },
      { action: action_add_twice },
      { assertion: assert_tags_normalized },
      { assertion: assert_fs },
      { action: action_servings_rounded },
      { assertion: assert_servings_rounded },
      { action: action_servings_not_a_number },
      { assertion: assert_servings_kept },
      { action: action_servings_blank },
      { assertion: assert_servings_kept },
      { action: action_servings_too_low },
      { assertion: assert_servings_clamped },
      { action: action_prep_set },
      { assertion: assert_prep_set },
      { action: action_prep_negative },
      { assertion: assert_prep_clamped },
    ],
    food,
  };
});
