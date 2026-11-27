/**
 * Smart Rubric pattern tests.
 *
 * The scoring, ranking and Quick Add checking rules are pure functions and are
 * tested directly. The pattern is then driven through its UI and streams with
 * a seeded rubric. The Quick Add LLM call is answered by `llmMocks`: two
 * descriptions have mocked answers, and a third, unanswered one reaches the
 * error path.
 *
 * Run: deno task cf test patterns/apps/smart-rubric/smart-rubric.test.tsx --verbose
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
  clickInRow,
  findNodeByProp,
  fireClick,
  fireEvent,
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
  withRange,
  withWeightChanged,
} from "./main.tsx";

const LOFT_ANSWER: QuickAddResponse = {
  optionName: "Sunny Loft",
  extractedValues: [
    { dimensionName: "Location", value: "excellent", confidence: "high" },
    { dimensionName: "Rent", value: "$2,100", confidence: "medium" },
    { dimensionName: "Parking", value: "Yes", confidence: "low" },
  ],
  reasoning: "Near the park reads as a great location.",
};

const COTTAGE_ANSWER: QuickAddResponse = {
  optionName: "Cosy Cottage",
  extractedValues: [
    { dimensionName: "Location", value: "Fair", confidence: "high" },
  ],
  reasoning: "Out of town reads as a fair location.",
};

const QUICK_ADD_PLACEHOLDER =
  "Describe an option, e.g. 'Apartment A: 2br in the Mission, $2100/mo'";

export const llmMocks = [
  {
    when: { lastMessageContains: "sunny loft near the park" },
    object: LOFT_ANSWER,
  },
  {
    when: { lastMessageContains: "cosy cottage out of town" },
    object: COTTAGE_ANSWER,
  },
  // Every other request fails, as an unanswered one did before `cf test`
  // answered every request: these steps check what the pattern does without
  // the answer.
  { error: "Not answered in this test.", repeat: true },
];

/** Commits `value` in the field labelled `label`, as cf-input does on blur. */
const editRange = (root: unknown, label: string, value: string): void =>
  fireEvent(
    findNodeByProp(root, "aria-label", label),
    "oncf-change",
    { detail: { value } },
    `the "${label}" field`,
  );

/** Clicks the control labelled `label` through its `aria-label`. */
const clickLabelled = (root: unknown, label: string): void =>
  fireClick(
    findNodeByProp(root, "aria-label", label),
    `the "${label}" control`,
  );

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
    dimensionScore(rent, undefined) === 0 &&
    dimensionScore({ ...rent, higherIsBetter: false }, 1200) === 9
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
  const assert_move_pins_only_the_moved_option = assert(() => {
    const moved = withOptionMoved(
      [option("A", "Excellent"), option("B", "Poor"), option("C", "Good")],
      [location],
      "B",
      -1,
    );
    const ranked = rankOptions(moved, [location]);
    // A new top scorer still rises past the unpinned options around B.
    const withD = rankOptions([...moved, option("D", "Excellent")], [
      location,
    ]);
    return names(ranked) === "A,B,C" &&
      moved.filter((o) => o.manualRank !== null).length === 1 &&
      ranked.find((r) => r.name === "B")?.movedByHand === true &&
      ranked.find((r) => r.name === "A")?.movedByHand === false &&
      names(withD) === "A,B,D,C";
  });
  const assert_pinned_slots_survive_shrinking = assert(() =>
    names(rankOptions([
      option("A", "Excellent"),
      option("Z", "Poor", undefined, 5),
    ], [location])) === "A,Z"
  );
  // Two options claiming the last slot both stay in the list: the second
  // takes the nearest free slot above it.
  const assert_colliding_pins_keep_every_option = assert(() =>
    names(rankOptions([
        option("A", "Excellent"),
        option("P", "Poor", undefined, 3),
        option("Q", "Poor", undefined, 9),
      ], [location])) === "A,Q,P" &&
    names(rankOptions([
        option("A", "Excellent"),
        option("P", "Poor", undefined, 2),
        option("Q", "Poor", undefined, 9),
      ], [location])) === "A,P,Q"
  );
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
  // A range is set bound by bound; one that does not run low to high, or a
  // bound that is not a number, changes nothing.
  const assert_range_edits = assert(() => {
    const [, wider] = withRange([location, rent], "Rent", { max: "5000" });
    const [, lower] = withRange([location, rent], "Rent", { min: 500 });
    const [, inverted] = withRange([location, rent], "Rent", { min: 4000 });
    const [, junk] = withRange([location, rent], "Rent", { max: "lots" });
    const [cat] = withRange([location, rent], "Location", { max: 99 });
    return wider.numericMin === 1000 && wider.numericMax === 5000 &&
      lower.numericMin === 500 && lower.numericMax === 3000 &&
      inverted.numericMin === 1000 && inverted.numericMax === 3000 &&
      junk.numericMax === 3000 && cat.numericMax === 10 &&
      dimensionScore(wider, 3000) === 5;
  });
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
  // A new numeric dimension starts at 0–100; its range fields edit it.
  const action_set_commute_range = action(() => {
    editRange(rubric[UI], "Maximum of Commute", "60");
    editRange(rubric[UI], "Minimum of Commute", "5");
  });
  const assert_commute_range = assert(() =>
    rubric.dimensions[2]?.numericMin === 5 &&
    rubric.dimensions[2]?.numericMax === 60
  );
  const action_invert_commute_range = action(() =>
    editRange(rubric[UI], "Minimum of Commute", "90")
  );
  const assert_inverted_range_refused = assert(() =>
    rubric.dimensions[2]?.numericMin === 5 &&
    rubric.dimensions[2]?.numericMax === 60
  );
  const action_remove_dimension = action(() =>
    rubric.removeDimension.send({ name: "Commute" })
  );
  const assert_dimension_removed = assert(() => rubric.dimensions.length === 2);

  // Flip Rent to lower-is-better: B's 1200 now scores 9, not 1.
  const action_rent_lower_is_better = action(() =>
    clickButton(rubric[UI], "Higher is better")
  );
  const assert_rent_flipped = assert(() =>
    rubric.dimensions[1]?.higherIsBetter === false &&
    rubric.ranked.find((r) => r.name === "Apartment B")?.score === 29 &&
    hasText(rubric[UI], "Lower is better")
  );
  const action_rent_higher_is_better = action(() =>
    rubric.toggleDirection.send({ name: "Rent" })
  );

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

  // A description with no mocked answer fails, and Dismiss clears the error.
  const action_quick_add_unanswered = action(() => {
    typeInto(rubric[UI], QUICK_ADD_PLACEHOLDER, "A houseboat");
    rubric.analyzeQuickAdd.send();
  });
  const assert_quick_add_error = assert(() =>
    rubric.quickAddStatus === "error" && hasText(rubric[UI], "Error:")
  );
  const action_clear = action(() => clickButton(rubric[UI], "Dismiss"));
  const assert_cleared = assert(() =>
    rubric.quickAddStatus === "idle" &&
    rubric.options.length === 3
  );

  const assert_fs_projection = assert(() =>
    rubric[FS].content.startsWith("# Decision Rubric") &&
    rubric[FS].content.includes("1. Sunny Loft — 25.5") &&
    rubric[FS].content.includes("Location [categorical], weight 2.0×")
  );

  // --- Controls on each row ------------------------------------------------

  const assert_name_follows_title = assert(() =>
    rubric[NAME] === "⚖️ Decision Rubric"
  );
  const action_rename = action(() =>
    typeInto(rubric[UI], "Rubric title", "Flat hunt")
  );
  const assert_renamed = assert(() => rubric[NAME] === "⚖️ Flat hunt");

  // Sunny Loft (25.5) leads; ▼ pins it second, behind B (21).
  const action_move_loft_down = action(() =>
    clickLabelled(rubric[UI], "Move Sunny Loft down")
  );
  const assert_loft_moved_down = assert(() =>
    names(rubric.ranked) === "Apartment B,Sunny Loft,Apartment A" &&
    rubric.ranked[1]?.movedByHand === true &&
    rubric.ranked[0]?.movedByHand === false
  );

  // − steps the selected option's rent down a tenth of the range (200).
  const action_decrease_loft_rent = action(() =>
    clickLabelled(rubric[UI], "Decrease Rent")
  );
  const assert_loft_rent_decreased = assert(() => {
    const loft = rubric.options.find((o) => o.name === "Sunny Loft");
    const b = rubric.options.find((o) => o.name === "Apartment B");
    return loft?.values.find((v) => v.dimensionName === "Rent")?.value ===
        1900 &&
      b?.values.find((v) => v.dimensionName === "Rent")?.value === 1200 &&
      hasText(rubric[UI], "1900");
  });

  const action_change_weights = action(() => {
    clickLabelled(rubric[UI], "Raise the weight of Rent");
    clickLabelled(rubric[UI], "Lower the weight of Location");
  });
  const assert_weights_changed = assert(() =>
    rubric.dimensions[0]?.multiplier === 1.5 &&
    rubric.dimensions[1]?.multiplier === 1.5 &&
    hasText(rubric[UI], "Weight: 1.5×")
  );

  // A categorical dimension starts on the default scale.
  const action_add_categorical = action(() => {
    typeInto(rubric[UI], "New dimension name", "Parking");
    clickButton(rubric[UI], "+ Categorical");
  });
  const assert_categorical_added = assert(() => {
    const parking = rubric.dimensions[2];
    return parking?.name === "Parking" && parking.type === "categorical" &&
      parking.multiplier === 1 &&
      parking.categories.map((c) => `${c.label}=${c.score}`).join(", ") ===
        "Excellent=10, Good=7, Fair=4, Poor=1" &&
      hasText(rubric[UI], "Categories: Excellent=10, Good=7, Fair=4, Poor=1");
  });
  const action_rate_loft_parking = action(() =>
    clickInRow(rubric[UI], "Parking [categorical]", "Good (7 pts)")
  );
  const assert_loft_has_parking = assert(() =>
    rubric.options.find((o) => o.name === "Sunny Loft")?.values.some((v) =>
      v.dimensionName === "Parking" && v.value === "Good"
    ) === true
  );
  // Removing a dimension drops its values from every option.
  const action_remove_parking = action(() =>
    clickLabelled(rubric[UI], "Remove Parking")
  );
  const assert_parking_removed = assert(() =>
    rubric.dimensions.map((d) => d.name).join(",") === "Location,Rent" &&
    rubric.options.every((o) =>
      o.values.every((v) => v.dimensionName !== "Parking")
    ) &&
    rubric.options.find((o) => o.name === "Sunny Loft")?.values.length === 2
  );

  // Removing the selected option clears the selection.
  const action_remove_loft = action(() =>
    clickLabelled(rubric[UI], "Remove Sunny Loft")
  );
  const assert_loft_removed = assert(() =>
    names(rubric.options) === "Apartment A,Apartment B" &&
    rubric.selected === "" &&
    hasText(rubric[UI], "How it works")
  );

  // Clear drops a proposal and its description, so Analyze then sends
  // nothing; Dismiss, above, keeps the description.
  const action_quick_add_cottage = action(() => {
    typeInto(rubric[UI], QUICK_ADD_PLACEHOLDER, "A cosy cottage out of town");
    clickButton(rubric[UI], "Analyze");
  });
  const assert_cottage_ready = assert(() =>
    rubric.quickAddStatus === "ready" &&
    rubric.quickAddPreview.name === "Cosy Cottage"
  );
  const action_clear_quick_add = action(() => clickButton(rubric[UI], "Clear"));
  const action_analyze_after_clear = action(() =>
    clickButton(rubric[UI], "Analyze")
  );
  const assert_quick_add_cleared = assert(() =>
    rubric.quickAddStatus === "idle" &&
    !rubric.quickAddPreview.ready &&
    names(rubric.options) === "Apartment A,Apartment B"
  );

  return {
    [TESTS]: [
      { assertion: assert_numeric_normalized_to_ten },
      { assertion: assert_categorical_scores_label },
      { assertion: assert_score_is_weighted_sum },
      { assertion: assert_rank_by_score_ties_by_order },
      { assertion: assert_move_pins_only_the_moved_option },
      { assertion: assert_pinned_slots_survive_shrinking },
      { assertion: assert_colliding_pins_keep_every_option },
      { assertion: assert_move_past_end_is_noop },
      { assertion: assert_manual_ranks_come_first },
      { assertion: assert_unique_names },
      { assertion: assert_weight_steps_and_clamps },
      { assertion: assert_step_from_unset_and_clamps },
      { assertion: assert_range_edits },
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
      { action: action_set_commute_range },
      { assertion: assert_commute_range },
      { action: action_invert_commute_range },
      { assertion: assert_inverted_range_refused },
      { action: action_remove_dimension },
      { assertion: assert_dimension_removed },
      { action: action_rent_lower_is_better },
      { assertion: assert_rent_flipped },
      { action: action_rent_higher_is_better },
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
      { assertion: assert_name_follows_title },
      { action: action_rename },
      { assertion: assert_renamed },
      { action: action_move_loft_down },
      { assertion: assert_loft_moved_down },
      { action: action_decrease_loft_rent },
      { assertion: assert_loft_rent_decreased },
      { action: action_change_weights },
      { assertion: assert_weights_changed },
      { action: action_add_categorical },
      { assertion: assert_categorical_added },
      { action: action_rate_loft_parking },
      { assertion: assert_loft_has_parking },
      { action: action_remove_parking },
      { assertion: assert_parking_removed },
      { action: action_remove_loft },
      { assertion: assert_loft_removed },
      { action: action_quick_add_cottage },
      { settle: true },
      { assertion: assert_cottage_ready },
      { action: action_clear_quick_add },
      { action: action_analyze_after_clear },
      { settle: true },
      { assertion: assert_quick_add_cleared },
    ],
    rubric,
    allowConsoleWarnings: true,
  };
});
