/**
 * Prepared Food tests: declared dietary tags, quick-add, and the
 * `dietaryCompatibility` a meal planner reads.
 *
 * Run: deno task cf test patterns/apps/food-recipe/prepared-food.test.tsx --verbose
 */
import { action, assert, FS, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  findElement,
  fireEvent,
} from "../../tools/test-support/vnode-helpers.ts";
import PreparedFood, { normalizedTags } from "./prepared-food.tsx";

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
    ],
    food,
  };
});
