/**
 * Smart Rubric pattern tests.
 *
 * The scoring, ranking and Quick Add checking rules are pure functions and are
 * tested directly. The pattern is then driven through its UI and streams with
 * a seeded rubric. The Quick Add LLM call is answered by `llmMocks`: one
 * description has a mocked answer, and a second, unanswered one reaches the
 * error path.
 *
 * Run: deno task cf test patterns/apps/smart-rubric/smart-rubric.test.tsx --verbose
 */
import { action, assert, FS, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  clickButton,
  clickInRow,
  hasText,
  typeInto,
} from "../../tools/test-support/vnode-helpers.ts";
import SmartRubric, {
  buildQuickAddSystemPrompt,
  DEFAULT_CATEGORIES,
  type Dimension,
  dimensionScore,
  fitValue,
  previewFromResponse,
  type QuickAddResponse,
  rankOptions,
  type RubricOption,
  scoreOption,
  steppedValue,
  uniqueName,
  withOptionMoved,
  withWeightChanged,
} from "./smart-rubric.tsx";

const LOFT_ANSWER: QuickAddResponse = {
  optionName: "Sunny Loft",
  extractedValues: [
    { dimensionName: "Location", value: "excellent", confidence: "high" },
    { dimensionName: "Rent", value: "$2,100", confidence: "medium" },
    { dimensionName: "Parking", value: "Yes", confidence: "low" },
  ],
  reasoning: "Near the park reads as a great location.",
};

const QUICK_ADD_PLACEHOLDER =
  "Describe an option, e.g. 'Apartment A: 2br in the Mission, $2100/mo'";

export const llmMocks = [
  {
    promptIncludes: "sunny loft near the park",
    object: LOFT_ANSWER,
  },
];

const location: Dimension = {
  name: "Location",
  type: "categorical",
  multiplier: 2,
  categories: DEFAULT_CATEGORIES,
  numericMin: 0,
  numericMax: 10,
};
const rent: Dimension = {
  name: "Rent",
  type: "numeric",
  multiplier: 1,
  categories: [],
  numericMin: 1000,
  numericMax: 3000,
};

const option = (
  name: string,
  loc?: string,
  rentValue?: number,
  manualRank: number | null = null,
): RubricOption => ({
  name,
  values: [
    ...(loc ? [{ dimensionName: "Location", value: loc }] : []),
    ...(rentValue !== undefined
      ? [{ dimensionName: "Rent", value: rentValue }]
      : []),
  ],
  manualRank,
});

const names = (ranked: readonly { name: string }[]): string =>
  ranked.map((r) => r.name).join(",");

export default pattern(() => {
  const dimensions = new Writable<Dimension[]>([location, rent]);
  const options = new Writable<RubricOption[]>([]);
  const rubric = SmartRubric({ dimensions, options });

  // --- Pure rules -----------------------------------------------------------

  const assert_numeric_normalized_to_ten = assert(() =>
    dimensionScore(rent, 2000) === 5 &&
    dimensionScore(rent, 500) === 0 &&
    dimensionScore(rent, 9000) === 10 &&
    dimensionScore(rent, undefined) === 0
  );
  const assert_categorical_scores_label = assert(() =>
    dimensionScore(location, "Good") === 7 &&
    dimensionScore(location, "Nowhere") === 0
  );
  const assert_score_is_weighted_sum = assert(() =>
    // Good (7) × 2 + Rent 3000 (10) × 1
    scoreOption(option("A", "Good", 3000), [location, rent]) === 24
  );
  const assert_rank_by_score_ties_by_order = assert(() =>
    names(rankOptions([
      option("Low", "Poor"),
      option("High", "Excellent"),
      option("TieA", "Fair"),
      option("TieB", "Fair"),
    ], [location])) === "High,TieA,TieB,Low"
  );
  const assert_move_pins_every_option = assert(() => {
    const moved = withOptionMoved(
      [option("A", "Excellent"), option("B", "Poor"), option("C", "Good")],
      [location],
      "B",
      -1,
    );
    const ranked = rankOptions(moved, [location]);
    return names(ranked) === "A,B,C" &&
      moved.every((o) => o.manualRank !== null) &&
      ranked.find((r) => r.name === "B")?.movedByHand === true &&
      ranked.find((r) => r.name === "A")?.movedByHand === false;
  });
  const assert_move_past_end_is_noop = assert(() =>
    withOptionMoved([option("A"), option("B")], [location], "A", -1)
      .every((o) => o.manualRank === null)
  );
  const assert_manual_ranks_come_first = assert(() =>
    names(rankOptions([
      option("Best", "Excellent"),
      option("Pinned", "Poor", undefined, 1),
    ], [location])) === "Pinned,Best"
  );
  const assert_unique_names = assert(() =>
    uniqueName("A", ["B"]) === "A" &&
    uniqueName("A", ["A", "A (2)"]) === "A (3)"
  );
  const assert_weight_steps_and_clamps = assert(() =>
    withWeightChanged([location], "Location", -0.5)[0].multiplier === 1.5 &&
    withWeightChanged([{ ...location, multiplier: 0.5 }], "Location", -0.5)[0]
        .multiplier === 0 &&
    withWeightChanged([{ ...location, multiplier: 0 }], "Location", -0.5)[0]
        .multiplier === 0 &&
    withWeightChanged([{ ...location, multiplier: 10 }], "Location", 0.5)[0]
        .multiplier === 10
  );
  const assert_step_from_unset_and_clamps = assert(() =>
    steppedValue(rent, undefined, 1) === 1200 &&
    steppedValue(rent, 2900, 1) === 3000 &&
    steppedValue(rent, 1000, -1) === 1000
  );
  const assert_fit_value = assert(() =>
    fitValue(location, "good") === "Good" &&
    fitValue(location, "Superb") === undefined &&
    fitValue(rent, "$2,100/mo") === 2100 &&
    fitValue(rent, 99_999) === 3000 &&
    fitValue(rent, "cheap") === undefined
  );
  const assert_preview_keeps_only_fitting_values = assert(() => {
    const preview = previewFromResponse(LOFT_ANSWER, [location, rent]);
    return preview.ready && preview.name === "Sunny Loft" &&
      preview.values.length === 2 &&
      preview.values[0].value === "Excellent" &&
      preview.values[1].value === 2100;
  });
  const assert_preview_empty_without_answer = assert(() =>
    !previewFromResponse(undefined, [location]).ready
  );
  const assert_system_prompt_lists_scale = assert(() => {
    const prompt = buildQuickAddSystemPrompt([location, rent]);
    return prompt.includes(`"Excellent" (10 pts)`) &&
      prompt.includes("Rent (numeric): a number from 1000 to 3000") &&
      buildQuickAddSystemPrompt([]).includes("no dimensions yet");
  });

  // --- Through the pattern --------------------------------------------------

  const assert_starts_empty = assert(() =>
    rubric.title === "Decision Rubric" &&
    rubric.ranked.length === 0 &&
    rubric.selected === "" &&
    rubric.quickAddStatus === "idle" &&
    hasText(rubric[UI], "How it works")
  );

  // Add two options through the form, and one through the stream.
  const action_add_by_form = action(() => {
    typeInto(rubric[UI], "New option name", "Apartment A");
    clickButton(rubric[UI], "+ Add Option");
  });
  const action_add_second = action(() => {
    typeInto(rubric[UI], "New option name", "Apartment B");
    clickButton(rubric[UI], "+ Add Option");
  });
  const action_add_duplicate = action(() =>
    rubric.addOption.send({ name: "Apartment A" })
  );
  const assert_options_added_unique = assert(() =>
    names(rubric.options) === "Apartment A,Apartment B,Apartment A (2)" &&
    rubric.ranked.every((r) => r.score === 0)
  );

  // Select B by clicking its name and rate its location.
  const action_select_b = action(() =>
    clickButton(rubric[UI], "2. Apartment B")
  );
  const assert_b_selected = assert(() =>
    rubric.selected === "Apartment B" &&
    hasText(rubric[UI], "Editing: Apartment B")
  );
  const action_rate_b_excellent = action(() =>
    clickButton(rubric[UI], "Excellent (10 pts)")
  );
  const action_raise_b_rent = action(() =>
    clickInRow(rubric[UI], "Rent [numeric]", "+")
  );
  // Excellent (10) × 2 + Rent 1200 (1) × 1 = 21; B now ranks first.
  const assert_b_ranks_first = assert(() =>
    rubric.ranked[0]?.name === "Apartment B" &&
    rubric.ranked[0]?.scoreLabel === "21.0" &&
    rubric.ranked[0]?.movedByHand === false
  );

  // A gets Good via the stream: 14, second.
  const action_rate_a = action(() =>
    rubric.setValue.send({
      option: "Apartment A",
      dimension: "Location",
      value: "Good",
    })
  );
  const action_reject_bad_value = action(() =>
    rubric.setValue.send({
      option: "Apartment A",
      dimension: "Location",
      value: "Castle",
    })
  );
  const assert_score_order = assert(() =>
    names(rubric.ranked) === "Apartment B,Apartment A,Apartment A (2)" &&
    rubric.ranked[1]?.score === 14
  );

  // Moving A up by hand overrides the score order and marks it.
  const action_move_a_up = action(() =>
    clickInRow(rubric[UI], "Apartment A", "▲")
  );
  const assert_manual_order = assert(() =>
    names(rubric.ranked) === "Apartment A,Apartment B,Apartment A (2)" &&
    rubric.ranked[0]?.movedByHand === true &&
    hasText(rubric[UI], "✋")
  );

  // Weighting Location to zero makes Rent decide; the manual order still holds.
  const action_zero_location = action(() => {
    rubric.changeWeight.send({ name: "Location", delta: -0.5 });
    rubric.changeWeight.send({ name: "Location", delta: -0.5 });
    rubric.changeWeight.send({ name: "Location", delta: -0.5 });
    rubric.changeWeight.send({ name: "Location", delta: -0.5 });
  });
  const assert_weight_zero = assert(() =>
    rubric.dimensions[0]?.multiplier === 0 &&
    rubric.ranked.find((r) => r.name === "Apartment A")?.score === 0 &&
    names(rubric.ranked) === "Apartment A,Apartment B,Apartment A (2)"
  );

  const action_reset_ranks = action(() =>
    clickButton(rubric[UI], "Reset Manual Ranks")
  );
  const assert_back_to_score_order = assert(() =>
    rubric.ranked[0]?.name === "Apartment B" &&
    rubric.options.every((o) => o.manualRank === null)
  );

  const action_restore_weight = action(() =>
    rubric.changeWeight.send({ name: "Location", delta: 2 })
  );

  // Add a dimension through the form; remove the duplicate option.
  const action_add_dimension = action(() => {
    typeInto(rubric[UI], "New dimension name", "Commute");
    clickButton(rubric[UI], "+ Numeric");
  });
  const action_remove_duplicate = action(() =>
    rubric.removeOption.send({ name: "Apartment A (2)" })
  );
  const assert_dimension_added_option_removed = assert(() =>
    rubric.dimensions.length === 3 &&
    rubric.dimensions[2]?.name === "Commute" &&
    rubric.dimensions[2]?.type === "numeric" &&
    rubric.options.length === 2
  );
  const action_remove_dimension = action(() =>
    rubric.removeDimension.send({ name: "Commute" })
  );
  const assert_dimension_removed = assert(() => rubric.dimensions.length === 2);

  // Quick Add: the mocked answer is checked against the rubric before adding.
  const action_quick_add = action(() => {
    typeInto(rubric[UI], QUICK_ADD_PLACEHOLDER, "A sunny loft near the park");
    clickButton(rubric[UI], "Analyze");
  });
  const assert_quick_add_ready = assert(() =>
    rubric.quickAddStatus === "ready" &&
    rubric.quickAddPreview.name === "Sunny Loft" &&
    rubric.quickAddPreview.values.length === 2 &&
    hasText(rubric[UI], "Proposed option:")
  );
  const action_accept = action(() => clickButton(rubric[UI], "Accept & Add"));
  const assert_quick_add_accepted = assert(() => {
    const loft = rubric.options.find((o) => o.name === "Sunny Loft");
    return !!loft && loft.values.length === 2 &&
      rubric.selected === "Sunny Loft" &&
      rubric.quickAddStatus === "idle" &&
      // Excellent (10) × 2 + Rent 2100 (5.5) × 1
      rubric.ranked[0]?.name === "Sunny Loft" &&
      rubric.ranked[0]?.score === 25.5;
  });

  // A description with no mocked answer fails, and Clear dismisses it.
  const action_quick_add_unanswered = action(() => {
    typeInto(rubric[UI], QUICK_ADD_PLACEHOLDER, "A houseboat");
    rubric.analyzeQuickAdd.send();
  });
  const assert_quick_add_error = assert(() =>
    rubric.quickAddStatus === "error" && hasText(rubric[UI], "Error:")
  );
  const action_clear = action(() => clickButton(rubric[UI], "Clear"));
  const assert_cleared = assert(() =>
    rubric.quickAddStatus === "idle" &&
    rubric.options.length === 3
  );

  const assert_fs_projection = assert(() =>
    rubric[FS].content.startsWith("# Decision Rubric") &&
    rubric[FS].content.includes("1. Sunny Loft — 25.5") &&
    rubric[FS].content.includes("Location [categorical], weight 2.0×")
  );

  return {
    [TESTS]: [
      { assertion: assert_numeric_normalized_to_ten },
      { assertion: assert_categorical_scores_label },
      { assertion: assert_score_is_weighted_sum },
      { assertion: assert_rank_by_score_ties_by_order },
      { assertion: assert_move_pins_every_option },
      { assertion: assert_move_past_end_is_noop },
      { assertion: assert_manual_ranks_come_first },
      { assertion: assert_unique_names },
      { assertion: assert_weight_steps_and_clamps },
      { assertion: assert_step_from_unset_and_clamps },
      { assertion: assert_fit_value },
      { assertion: assert_preview_keeps_only_fitting_values },
      { assertion: assert_preview_empty_without_answer },
      { assertion: assert_system_prompt_lists_scale },
      { assertion: assert_starts_empty },
      { action: action_add_by_form },
      { action: action_add_second },
      { action: action_add_duplicate },
      { assertion: assert_options_added_unique },
      { action: action_select_b },
      { assertion: assert_b_selected },
      { action: action_rate_b_excellent },
      { action: action_raise_b_rent },
      { assertion: assert_b_ranks_first },
      { action: action_rate_a },
      { action: action_reject_bad_value },
      { assertion: assert_score_order },
      { action: action_move_a_up },
      { assertion: assert_manual_order },
      { action: action_zero_location },
      { assertion: assert_weight_zero },
      { action: action_reset_ranks },
      { assertion: assert_back_to_score_order },
      { action: action_restore_weight },
      { action: action_add_dimension },
      { action: action_remove_duplicate },
      { assertion: assert_dimension_added_option_removed },
      { action: action_remove_dimension },
      { assertion: assert_dimension_removed },
      { action: action_quick_add },
      { settle: true },
      { assertion: assert_quick_add_ready },
      { action: action_accept },
      { assertion: assert_quick_add_accepted },
      { action: action_quick_add_unanswered },
      { settle: true },
      { assertion: assert_quick_add_error },
      { action: action_clear },
      { assertion: assert_cleared },
      { assertion: assert_fs_projection },
    ],
    rubric,
    allowConsoleWarnings: true,
  };
});
