/**
 * Cooking View tests: step and group checkboxes, progress, and following the
 * recipe's live step groups.
 *
 * Run: deno task cf test patterns/apps/food-recipe/viewer.test.tsx --verbose
 */
import {
  action,
  assert,
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
import Viewer, {
  groupViews,
  progressAfterMove,
  progressAfterRemove,
  progressWithoutGroup,
  stepKey,
} from "./viewer.tsx";
import type { StepGroup } from "./schemas.tsx";

export default pattern(() => {
  const stepGroups = new Writable<StepGroup[]>([
    {
      id: "prep",
      name: "Prep",
      minutesBeforeServing: 90,
      steps: [{ description: "Chop onions" }, { description: "Mince garlic" }],
    },
    {
      id: "roast",
      name: "Roast",
      minutesBeforeServing: 60,
      oven: { temperature: 425, duration: 45, heightSlots: 2, width: "full" },
      steps: [{ description: "Roast until golden" }],
    },
  ]);
  const view = Viewer({
    recipeName: "Roast Chicken",
    servings: 4,
    ingredients: [{ item: "chicken", amount: "1", unit: "piece" }],
    stepGroups,
  });

  // Moving or deleting a step carries its checkmark with it.
  const assert_progress_follows_steps = assert(() => {
    const done = ["p#0", "p#2", "q#1"];
    return progressAfterMove(done, "p", 0, 1, 3).join() === "p#1,p#2,q#1" &&
      progressAfterMove(done, "p", 2, 1, 3).join() === done.join() &&
      progressAfterRemove(done, "p", 1).join() === "p#0,p#1,q#1" &&
      progressAfterRemove(done, "p", 0).join() === "p#1,q#1" &&
      progressWithoutGroup(done, "p").join() === "q#1";
  });
  // A group that must move straight on still says so.
  const assert_zero_wait_shown = assert(() =>
    groupViews(
      [{ id: "m", name: "Marinate", maxWaitMinutes: 0, steps: [] }],
      [],
    )[0]
      .details.includes("move straight on")
  );

  const assert_shows_recipe = assert(() =>
    view[NAME] === "👨‍🍳 Roast Chicken · Cooking" &&
    hasText(view[UI], "1 piece chicken") &&
    hasText(view[UI], "1h 30m before serving") &&
    hasText(view[UI], "425°F for 45 min") &&
    view.stepsTotal === 3 && view.stepsDone === 0
  );

  const action_check_step = action(() =>
    view.toggleStep.send({ key: stepKey("prep", 0) })
  );
  const assert_one_done = assert(() =>
    view.stepsDone === 1 && hasText(view[UI], "1 of 3 steps done")
  );

  // Checking the group checks its remaining step; checking again clears both.
  const action_check_group = action(() =>
    view.toggleGroup.send({ groupId: "prep" })
  );
  const assert_group_done = assert(() => view.stepsDone === 2);
  const action_uncheck_group = action(() =>
    view.toggleGroup.send({ groupId: "prep" })
  );
  const assert_group_cleared = assert(() => view.stepsDone === 0);

  // An edit to the recipe shows in the view.
  const action_add_step = action(() =>
    stepGroups.key(1).key("steps").push({ description: "Rest 10 minutes" })
  );
  const assert_follows_recipe = assert(() =>
    view.stepsTotal === 4 && hasText(view[UI], "Rest 10 minutes")
  );

  const action_check_then_reset = action(() => {
    view.toggleStep.send({ key: stepKey("roast", 0) });
    clickButton(view[UI], "Start over");
  });
  const assert_reset = assert(() => view.stepsDone === 0);

  return {
    [TESTS]: [
      { assertion: assert_progress_follows_steps },
      { assertion: assert_zero_wait_shown },
      { assertion: assert_shows_recipe },
      { action: action_check_step },
      { assertion: assert_one_done },
      { action: action_check_group },
      { assertion: assert_group_done },
      { action: action_uncheck_group },
      { assertion: assert_group_cleared },
      { action: action_add_step },
      { assertion: assert_follows_recipe },
      { action: action_check_then_reset },
      { assertion: assert_reset },
    ],
    view,
  };
});
