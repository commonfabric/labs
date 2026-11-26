/**
 * Test Pattern: Self Model
 *
 * Tests are split into two groups:
 *
 * A) Direct unit tests on the pure exported helpers (upsertNeurotype,
 *    appendValue, appendResponse, withoutNeurotype, withoutValueAt).
 *    These helpers ARE the shipping mutation logic the handlers delegate to,
 *    so asserting against them covers the real code paths.
 *
 * B) Own-cell init test: instantiates Self({}) with no injection and asserts
 *    the owned cell seeds to EMPTY_SELF_MODEL via Default<> (the production
 *    home-local path; CT-1669 regression guard — see section B).
 *
 * C) The streams Self exports, sent to that owned instance, and the
 *    reflections its view lists.
 *
 * Run: deno task cf test patterns/system/self/self.test.tsx --verbose
 */
import {
  action,
  assert,
  handler,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import Self, {
  addValueCardFromForm,
  appendResponse,
  appendValue,
  EMPTY_SELF_MODEL,
  MEANING_PROMPTS,
  type Neurotype,
  type NeurotypeSystem,
  type QAResponse,
  recordNeurotypeFromForm,
  recordReflectionFromForm,
  removeNeurotypeBySystem,
  removeValueCardByIndex,
  type SelfModel,
  upsertNeurotype,
  type ValueCard,
  withoutNeurotype,
  withoutValueAt,
} from "./self.tsx";
import { hasText } from "../../tools/test-support/vnode-helpers.ts";

// ---------------------------------------------------------------------------
// Shared fixture data (no timestamps — helpers don't set them)
// ---------------------------------------------------------------------------

const MBTI_INTJ: Neurotype = {
  system: "mbti",
  result: "INTJ",
  source: "self-reported",
  recordedAt: 1000,
};

const MBTI_ENTP: Neurotype = {
  system: "mbti",
  result: "ENTP",
  source: "self-reported",
  recordedAt: 1001,
};

const ENNEAGRAM_5W4: Neurotype = {
  system: "enneagram",
  result: "5w4",
  source: "self-reported",
  recordedAt: 1002,
};

const CURIOSITY_CARD: ValueCard = {
  title: "Curiosity",
  description: "Seek to understand before judging",
};

const AUTONOMY_CARD: ValueCard = {
  title: "Autonomy",
};

const MEANING_RESPONSE: QAResponse = {
  promptId: "p1",
  prompt: "What energises you most?",
  answer: "Deep problem-solving with autonomy",
  track: "meaning",
  answeredAt: 2000,
};

// ---------------------------------------------------------------------------
// Test-local void handler — data baked into state so the runner fires it as
// Stream<void> with no payload.  Used only for the removeValueCard step.
// ---------------------------------------------------------------------------

const doRemoveValueCard = handler<
  void,
  { selfModel: Writable<SelfModel>; index: number }
>((_event, { selfModel, index }) => {
  const current = selfModel.get();
  selfModel.set({
    ...current,
    values: current.values.filter((_, i) => i !== index),
  });
});

// ---------------------------------------------------------------------------
// Test pattern
// ---------------------------------------------------------------------------

export default pattern(() => {
  // =========================================================================
  // A) Pure helper unit tests — fully deterministic, no timestamps involved
  // =========================================================================

  // --- upsertNeurotype ---

  // A1: append when model is empty
  const after_append_mbti = upsertNeurotype(EMPTY_SELF_MODEL, MBTI_INTJ);
  const assert_append_count = assert(
    () => after_append_mbti.neurotypes.length === 1,
  );
  const assert_append_result = assert(
    () => after_append_mbti.neurotypes[0]?.result === "INTJ",
  );
  const assert_append_system = assert(
    () => after_append_mbti.neurotypes[0]?.system === "mbti",
  );

  // A2: upsert replaces same system, count stays 1
  const after_upsert_mbti = upsertNeurotype(after_append_mbti, MBTI_ENTP);
  const assert_upsert_count = assert(
    () => after_upsert_mbti.neurotypes.length === 1,
  );
  const assert_upsert_result = assert(
    () => after_upsert_mbti.neurotypes[0]?.result === "ENTP",
  );

  // A3: different system coexists — two entries
  const after_add_enneagram = upsertNeurotype(after_upsert_mbti, ENNEAGRAM_5W4);
  const assert_coexist_count = assert(
    () => after_add_enneagram.neurotypes.length === 2,
  );
  const assert_enneagram_present = assert(
    () =>
      after_add_enneagram.neurotypes.some(
        (n) => n.system === "enneagram" && n.result === "5w4",
      ),
  );

  // --- appendValue ---

  // A4: append first value card
  const after_add_curiosity = appendValue(EMPTY_SELF_MODEL, CURIOSITY_CARD);
  const assert_value_count_1 = assert(
    () => after_add_curiosity.values.length === 1,
  );
  const assert_value_title_curiosity = assert(
    () => after_add_curiosity.values[0]?.title === "Curiosity",
  );

  // A5: append second value card — two entries, order preserved
  const after_add_autonomy = appendValue(after_add_curiosity, AUTONOMY_CARD);
  const assert_value_count_2 = assert(
    () => after_add_autonomy.values.length === 2,
  );
  const assert_value_order = assert(
    () =>
      after_add_autonomy.values[0]?.title === "Curiosity" &&
      after_add_autonomy.values[1]?.title === "Autonomy",
  );

  // --- appendResponse ---

  // A6: append a response
  const after_add_response = appendResponse(EMPTY_SELF_MODEL, MEANING_RESPONSE);
  const assert_response_count = assert(
    () => after_add_response.responses.length === 1,
  );
  const assert_response_track = assert(
    () => after_add_response.responses[0]?.track === "meaning",
  );
  const assert_response_prompt_id = assert(
    () => after_add_response.responses[0]?.promptId === "p1",
  );

  // --- withoutNeurotype ---

  // A7: remove enneagram — back to mbti only
  const after_remove_enneagram = withoutNeurotype(
    after_add_enneagram,
    "enneagram",
  );
  const assert_remove_neuro_count = assert(
    () => after_remove_enneagram.neurotypes.length === 1,
  );
  const assert_mbti_remains = assert(
    () => after_remove_enneagram.neurotypes[0]?.system === "mbti",
  );

  // A8: no-op when system not present
  const after_remove_absent = withoutNeurotype(
    after_remove_enneagram,
    "big5",
  );
  const assert_remove_absent_noop = assert(
    () => after_remove_absent.neurotypes.length === 1,
  );

  // --- withoutValueAt ---

  // A9: remove first value (index 0) — only Autonomy remains
  const after_remove_first = withoutValueAt(after_add_autonomy, 0);
  const assert_remove_value_count = assert(
    () => after_remove_first.values.length === 1,
  );
  const assert_autonomy_remains = assert(
    () => after_remove_first.values[0]?.title === "Autonomy",
  );

  // A10: remove last value (index 0 of single-item list) — empty
  const after_remove_last = withoutValueAt(after_remove_first, 0);
  const assert_values_empty = assert(
    () => after_remove_last.values.length === 0,
  );

  // =========================================================================
  // B) Own-cell init test
  //    Instantiate Self with NO injection — the production home-local path that
  //    seeds the owned cell from Default<typeof EMPTY_SELF_MODEL> (CT-1669).
  // =========================================================================

  // Instantiate with NO injection — the REAL production path (home-local, the
  // way the Self tab runs it). Regression guard for CT-1669: the old
  // `injectedSelfModel ?? new Writable<SelfModel>(EMPTY_SELF_MODEL).for("selfModel")`
  // left the owned cell UNDEFINED — a `new Writable(initial)` on the RIGHT of ??
  // is lowered to a lift whose value is undefined when uninjected — so every
  // capture handler threw on `selfModel.get().neurotypes` (caught only by a live
  // deploy, never by the injected tests). The fix seeds the owned cell via
  // `Default<typeof EMPTY_SELF_MODEL>`. We now read the ACTUAL owned cell (not an
  // injected stand-in), so this test fails if the seeding ever regresses.
  // The assertions read the owned cell straight off the instance, not through
  // a derivation of it that can lag behind, and guard the read, so a cell
  // that has not landed fails the assertion with its operands reported rather
  // than throwing.
  const selfOwned = Self({});

  const assert_owned_responses_empty = assert(
    () => selfOwned.selfModel.get()?.responses.length === 0,
  );
  const assert_owned_values_empty = assert(
    () => selfOwned.selfModel.get()?.values.length === 0,
  );
  const assert_owned_neurotypes_empty = assert(
    () => selfOwned.selfModel.get()?.neurotypes.length === 0,
  );

  // =========================================================================
  // Test 5b: removeValueCard removes by index — fresh cell with one value card
  // =========================================================================

  const selfModelValues = new Writable<SelfModel>(
    appendValue(EMPTY_SELF_MODEL, CURIOSITY_CARD),
  );

  const action_remove_first_value = doRemoveValueCard({
    selfModel: selfModelValues,
    index: 0,
  });

  const assert_values_empty_after_remove = assert(
    () => selfModelValues.get().values.length === 0,
  );

  // =========================================================================
  // Form handler tests (CT-1672) — use a fresh selfModel to avoid state bleed
  // =========================================================================

  const selfModel2 = new Writable<SelfModel>(EMPTY_SELF_MODEL);
  const systemField = new Writable<NeurotypeSystem>("enneagram");
  const resultField = new Writable<string>("5w4");

  // Test 6: recordNeurotypeFromForm records entry + clears resultField
  const action_form_record_enneagram = recordNeurotypeFromForm({
    selfModel: selfModel2,
    systemField,
    resultField,
  });

  const assert_form_recorded_enneagram = assert(() =>
    selfModel2
      .get()
      .neurotypes.some(
        (n) =>
          n.system === "enneagram" &&
          n.result === "5w4" &&
          n.source === "self-reported",
      )
  );

  const assert_result_field_cleared = assert(
    () => resultField.get() === "",
  );

  // Test 7: upsert via form — record mbti "INTJ" then "ENFP", expect length 1 + "ENFP"
  const systemField2 = new Writable<NeurotypeSystem>("mbti");
  const resultField2a = new Writable<string>("INTJ");
  const action_form_record_mbti_intj = recordNeurotypeFromForm({
    selfModel: selfModel2,
    systemField: systemField2,
    resultField: resultField2a,
  });

  // After action_form_record_mbti_intj, resultField2a is cleared; set it to ENFP for upsert.
  const resultField2b = new Writable<string>("ENFP");
  const action_form_upsert_mbti_enfp = recordNeurotypeFromForm({
    selfModel: selfModel2,
    systemField: systemField2,
    resultField: resultField2b,
  });

  const assert_form_upsert_length_one = assert(
    () =>
      selfModel2.get().neurotypes.filter((n) => n.system === "mbti").length ===
        1,
  );

  const assert_form_upsert_result_enfp = assert(
    () =>
      selfModel2
        .get()
        .neurotypes.find((n) => n.system === "mbti")?.result === "ENFP",
  );

  // Test 8: removeNeurotypeBySystem — after two systems, remove enneagram, only mbti remains
  const action_remove_enneagram_by_system = removeNeurotypeBySystem({
    selfModel: selfModel2,
    system: "enneagram",
  });

  const assert_only_mbti_after_remove = assert(() => {
    const neurotypes = selfModel2.get().neurotypes;
    return neurotypes.length === 1 && neurotypes[0]?.system === "mbti";
  });

  // =========================================================================
  // CT-1674 Meaning & Values Tests — fresh selfModel3 to avoid state bleed
  // =========================================================================

  const selfModel3 = new Writable<SelfModel>(EMPTY_SELF_MODEL);

  // Test 9: MEANING_PROMPTS sanity — 8 entries, correct kinds present
  const assert_meaning_prompts_count = assert(
    () => MEANING_PROMPTS.length === 8,
  );
  const assert_meaning_prompts_has_open = assert(
    () => MEANING_PROMPTS.some((p) => p.kind === "open"),
  );
  const assert_meaning_prompts_has_scissor = assert(
    () => MEANING_PROMPTS.some((p) => p.kind === "scissor"),
  );
  const assert_meaning_prompts_has_closing = assert(
    () => MEANING_PROMPTS.some((p) => p.kind === "closing"),
  );

  // Test 10: recordReflectionFromForm appends QAResponse(track:"meaning") + clears answerField
  const promptId10 = MEANING_PROMPTS[0].id; // "open-life"
  const currentPromptId10 = new Writable<string>(promptId10);
  const answerField10 = new Writable<string>(
    "I work as a designer and live with my partner.",
  );

  const action_record_reflection = recordReflectionFromForm({
    selfModel: selfModel3,
    currentPromptId: currentPromptId10,
    answerField: answerField10,
  });

  const assert_reflection_appended = assert(
    () => selfModel3.get().responses.length === 1,
  );
  const assert_reflection_track_meaning = assert(
    () => selfModel3.get().responses[0]?.track === "meaning",
  );
  const assert_reflection_prompt_id = assert(
    () => selfModel3.get().responses[0]?.promptId === promptId10,
  );
  const assert_reflection_prompt_text = assert(
    () => selfModel3.get().responses[0]?.prompt === MEANING_PROMPTS[0].text,
  );
  const assert_reflection_answer = assert(
    () =>
      selfModel3.get().responses[0]?.answer ===
        "I work as a designer and live with my partner.",
  );
  const assert_answer_field_cleared = assert(
    () => answerField10.get() === "",
  );

  // Test 11: addValueCardFromForm appends ValueCard with attendingTo/stance/contextTags + clears fields
  const selfModel4 = new Writable<SelfModel>(EMPTY_SELF_MODEL);
  const titleField11 = new Writable<string>("Direct feedback");
  const attendingToField11 = new Writable<string>(
    "a disagreement at the moment it is live",
  );
  const stanceField11 = new Writable<
    "descriptive" | "aspirational" | "conflicted"
  >("descriptive");
  const contextTagsField11 = new Writable<string>("work, team");

  const action_add_value_from_form = addValueCardFromForm({
    selfModel: selfModel4,
    titleField: titleField11,
    attendingToField: attendingToField11,
    stanceField: stanceField11,
    contextTagsField: contextTagsField11,
  });

  const assert_value_appended = assert(
    () => selfModel4.get().values.length === 1,
  );
  const assert_value_title = assert(
    () => selfModel4.get().values[0]?.title === "Direct feedback",
  );
  const assert_value_attending_to = assert(
    () =>
      selfModel4.get().values[0]?.attendingTo ===
        "a disagreement at the moment it is live",
  );
  const assert_value_stance = assert(
    () => selfModel4.get().values[0]?.stance === "descriptive",
  );
  const assert_value_context_tags = assert(() => {
    const tags = selfModel4.get().values[0]?.contextTags;
    return (
      Array.isArray(tags) &&
      tags.length === 2 &&
      tags[0] === "work" &&
      tags[1] === "team"
    );
  });
  const assert_title_field_cleared = assert(() => titleField11.get() === "");
  const assert_attending_field_cleared = assert(
    () => attendingToField11.get() === "",
  );
  const assert_context_tags_field_cleared = assert(
    () => contextTagsField11.get() === "",
  );

  // Test 12: removeValueCardByIndex removes correct entry
  const selfModel5 = new Writable<SelfModel>(EMPTY_SELF_MODEL);
  const titleField12a = new Writable<string>("First value");
  const attendingToField12a = new Writable<string>("");
  const stanceField12a = new Writable<
    "descriptive" | "aspirational" | "conflicted"
  >("descriptive");
  const contextTagsField12a = new Writable<string>("");

  const action_add_first_value = addValueCardFromForm({
    selfModel: selfModel5,
    titleField: titleField12a,
    attendingToField: attendingToField12a,
    stanceField: stanceField12a,
    contextTagsField: contextTagsField12a,
  });

  const titleField12b = new Writable<string>("Second value");
  const attendingToField12b = new Writable<string>("");
  const stanceField12b = new Writable<
    "descriptive" | "aspirational" | "conflicted"
  >("aspirational");
  const contextTagsField12b = new Writable<string>("");

  const action_add_second_value = addValueCardFromForm({
    selfModel: selfModel5,
    titleField: titleField12b,
    attendingToField: attendingToField12b,
    stanceField: stanceField12b,
    contextTagsField: contextTagsField12b,
  });

  const action_remove_first_value_card = removeValueCardByIndex({
    selfModel: selfModel5,
    index: 0,
  });

  const assert_only_second_remains = assert(
    () => selfModel5.get().values.length === 1,
  );
  const assert_second_value_title = assert(
    () => selfModel5.get().values[0]?.title === "Second value",
  );

  // =========================================================================
  // C) The streams Self exports, sent to the owned instance from section B,
  //    and the reflections its view lists.
  // =========================================================================

  const action_stream_record_neurotype = action(() =>
    selfOwned.recordNeurotype.send({
      system: "big5",
      result: "high openness",
      detail: { openness: 90 },
      source: "assessed",
    })
  );
  // Each action sends one event, so the order the entries are appended in is
  // the order of the steps.
  const action_stream_add_craft = action(() =>
    selfOwned.addValueCard.send({
      title: "Craft",
      description: "Do the work well",
      weight: 3,
      sourcePromptId: "p-craft",
    })
  );
  const action_stream_add_rest = action(() =>
    selfOwned.addValueCard.send({ title: "Rest" })
  );
  const action_stream_record_meaning = action(() =>
    selfOwned.recordResponse.send({
      promptId: "p-meaning",
      prompt: "What gives your days meaning?",
      answer: "Teaching my kids to cook.",
      track: "meaning",
    })
  );
  const action_stream_record_aside = action(() =>
    selfOwned.recordResponse.send({
      promptId: "p-free",
      prompt: "Anything else?",
      answer: "Private aside.",
      track: "freeform",
    })
  );
  const action_stream_remove = action(() => {
    selfOwned.removeNeurotype.send({ system: "big5" });
    selfOwned.removeValueCard.send({ index: 0 });
  });

  const assert_stream_neurotype_recorded = assert(() => {
    const neurotypes = selfOwned.selfModel.get()?.neurotypes ?? [];
    const entry = neurotypes[0];
    return neurotypes.length === 1 &&
      entry?.system === "big5" && entry.result === "high openness" &&
      entry.detail?.openness === 90 && entry.source === "assessed" &&
      typeof entry.recordedAt === "number";
  });
  const assert_stream_values_added = assert(() => {
    const values = selfOwned.selfModel.get()?.values ?? [];
    const [craft, rest] = values;
    return values.length === 2 &&
      craft?.title === "Craft" && craft.description === "Do the work well" &&
      craft.weight === 3 && craft.sourcePromptId === "p-craft" &&
      rest?.title === "Rest" && !("description" in rest) &&
      !("weight" in rest) && !("sourcePromptId" in rest);
  });
  // Both answers are kept, and the view lists the meaning reflection alone.
  const assert_stream_responses_recorded = assert(() => {
    const responses = selfOwned.selfModel.get()?.responses ?? [];
    return responses.length === 2 &&
      responses[0]?.track === "meaning" &&
      typeof responses[0]?.answeredAt === "number" &&
      responses[1]?.answer === "Private aside." &&
      hasText(selfOwned[UI], "What gives your days meaning?") &&
      hasText(selfOwned[UI], "Teaching my kids to cook.") &&
      !hasText(selfOwned[UI], "Private aside.");
  });
  const assert_stream_removed = assert(() =>
    selfOwned.selfModel.get()?.neurotypes.length === 0 &&
    selfOwned.selfModel.get()?.values.length === 1 &&
    selfOwned.selfModel.get()?.values[0]?.title === "Rest"
  );

  // =========================================================================
  // Test Sequence
  // =========================================================================
  return {
    [TESTS]: [
      // === A1: upsertNeurotype — append to empty ===
      { assertion: assert_append_count },
      { assertion: assert_append_result },
      { assertion: assert_append_system },

      // === A2: upsertNeurotype — same system replaces ===
      { assertion: assert_upsert_count },
      { assertion: assert_upsert_result },

      // === A3: upsertNeurotype — different system coexists ===
      { assertion: assert_coexist_count },
      { assertion: assert_enneagram_present },

      // === A4: appendValue — first card ===
      { assertion: assert_value_count_1 },
      { assertion: assert_value_title_curiosity },

      // === A5: appendValue — second card, order preserved ===
      { assertion: assert_value_count_2 },
      { assertion: assert_value_order },

      // === A6: appendResponse ===
      { assertion: assert_response_count },
      { assertion: assert_response_track },
      { assertion: assert_response_prompt_id },

      // === A7: withoutNeurotype — removes matching system ===
      { assertion: assert_remove_neuro_count },
      { assertion: assert_mbti_remains },

      // === A8: withoutNeurotype — no-op when absent ===
      { assertion: assert_remove_absent_noop },

      // === A9: withoutValueAt — removes by index ===
      { assertion: assert_remove_value_count },
      { assertion: assert_autonomy_remains },

      // === A10: withoutValueAt — empty after last removal ===
      { assertion: assert_values_empty },

      // === B: Own-cell init (no injection) ===
      { assertion: assert_owned_responses_empty },
      { assertion: assert_owned_values_empty },
      { assertion: assert_owned_neurotypes_empty },

      // === Test 5b: removeValueCard removes by index ===
      { action: action_remove_first_value },
      { assertion: assert_values_empty_after_remove },

      // === Test 6: recordNeurotypeFromForm records + clears resultField ===
      { action: action_form_record_enneagram },
      { assertion: assert_form_recorded_enneagram },
      { assertion: assert_result_field_cleared },

      // === Test 7: upsert via form — same system replaces, length stays 1 ===
      { action: action_form_record_mbti_intj },
      { action: action_form_upsert_mbti_enfp },
      { assertion: assert_form_upsert_length_one },
      { assertion: assert_form_upsert_result_enfp },

      // === Test 8: removeNeurotypeBySystem removes correct entry ===
      { action: action_remove_enneagram_by_system },
      { assertion: assert_only_mbti_after_remove },

      // === Test 9: MEANING_PROMPTS sanity ===
      { assertion: assert_meaning_prompts_count },
      { assertion: assert_meaning_prompts_has_open },
      { assertion: assert_meaning_prompts_has_scissor },
      { assertion: assert_meaning_prompts_has_closing },

      // === Test 10: recordReflectionFromForm appends + clears ===
      { action: action_record_reflection },
      { assertion: assert_reflection_appended },
      { assertion: assert_reflection_track_meaning },
      { assertion: assert_reflection_prompt_id },
      { assertion: assert_reflection_prompt_text },
      { assertion: assert_reflection_answer },
      { assertion: assert_answer_field_cleared },

      // === Test 11: addValueCardFromForm appends with full fields + clears ===
      { action: action_add_value_from_form },
      { assertion: assert_value_appended },
      { assertion: assert_value_title },
      { assertion: assert_value_attending_to },
      { assertion: assert_value_stance },
      { assertion: assert_value_context_tags },
      { assertion: assert_title_field_cleared },
      { assertion: assert_attending_field_cleared },
      { assertion: assert_context_tags_field_cleared },

      // === Test 12: removeValueCardByIndex removes correct entry ===
      { action: action_add_first_value },
      { action: action_add_second_value },
      { action: action_remove_first_value_card },
      { assertion: assert_only_second_remains },
      { assertion: assert_second_value_title },

      // === C: the exported streams, and the reflections the view lists ===
      { action: action_stream_record_neurotype },
      { assertion: assert_stream_neurotype_recorded },
      { action: action_stream_add_craft },
      { action: action_stream_add_rest },
      { assertion: assert_stream_values_added },
      { action: action_stream_record_meaning },
      { action: action_stream_record_aside },
      { assertion: assert_stream_responses_recorded },
      { action: action_stream_remove },
      { assertion: assert_stream_removed },
    ],
  };
});
