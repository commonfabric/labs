/**
 * Assumption Surfacer pattern tests.
 *
 * The test environment has no language model: the dialog answers each message
 * with its error reply and never calls the `recordAssumptions` tool. The tests
 * play the model's part by sending that tool's stream directly, then drive the
 * verdicts through the streams and the sidebar's buttons.
 *
 * Run: deno task cf test patterns/apps/assumption-surfacer/assumption-surfacer.test.tsx --verbose
 */
import {
  action,
  assert,
  type BuiltInLLMMessage,
  FS,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { clickInRow } from "../../tools/test-support/vnode-helpers.ts";
import AssumptionSurfacer, {
  applyVerdict,
  type Assumption,
  buildSystemPrompt,
  chatTitle,
  messageText,
  normalizeReported,
  settledFacts,
  withRecorded,
} from "./assumption-surfacer.tsx";

const user = (text: string): BuiltInLLMMessage => ({
  role: "user",
  content: [{ type: "text" as const, text }],
});

const language = {
  label: "Language",
  description: "Which language the code is in.",
  alternatives: ["Python", "JavaScript", "TypeScript"],
  assumedIndex: 0,
};
const level = {
  label: "Skill level",
  alternatives: ["Beginner", "Intermediate", "Expert"],
  assumedIndex: 1,
};

const recorded = (): Assumption[] =>
  withRecorded([], [language, level], 1, "sort a list");

const lastText = (messages: readonly BuiltInLLMMessage[]): string =>
  messageText(messages.filter((m) => m.role === "user").at(-1));

export default pattern(() => {
  const messages = new Writable<BuiltInLLMMessage[]>([
    user("How do I sort a list?"),
  ]);
  const assumptions = new Writable<Assumption[]>([]);
  const systemPrompt = new Writable("You are terse.");
  const surfacer = AssumptionSurfacer({ messages, assumptions, systemPrompt });

  // --- Pure parsing and rules ------------------------------------------------

  const assert_parse_drops_unusable = assert(() => {
    const parsed = normalizeReported({
      assumptions: [
        language,
        { label: "", alternatives: ["a", "b"], assumedIndex: 0 },
        { label: "Only one", alternatives: ["x", "x"], assumedIndex: 0 },
        "junk",
      ],
    });
    return parsed.length === 1 && parsed[0].label === "Language";
  });
  const assert_parse_clamps = assert(() => {
    const parsed = normalizeReported({
      assumptions: [
        {
          label: "  OS  ",
          alternatives: ["Mac", " Linux ", "Windows", "BSD", "Plan 9"],
          assumedIndex: 9,
        },
        language,
        level,
        { ...level, label: "Fourth" },
      ],
    });
    return parsed.length === 3 && parsed[0].label === "OS" &&
      parsed[0].alternatives.length === 4 &&
      parsed[0].alternatives[1] === "Linux" && parsed[0].assumedIndex === 0;
  });
  // The original's shape: alternatives as { value } and `selectedIndex`.
  const assert_parse_accepts_legacy_shape = assert(() => {
    const parsed = normalizeReported({
      assumptions: [{
        label: "Language",
        alternatives: [{ value: "Python" }, { value: "Go" }],
        selectedIndex: 1,
      }],
    });
    return parsed[0]?.alternatives[1] === "Go" && parsed[0]?.assumedIndex === 1;
  });
  const assert_parse_rejects_non_object = assert(() =>
    normalizeReported(undefined).length === 0 &&
    normalizeReported({ assumptions: "no" }).length === 0
  );
  const assert_record_ids_and_replace = assert(() => {
    const first = recorded();
    const again = withRecorded(
      first,
      [{ ...language, assumedIndex: 2 }],
      1,
      "",
    );
    const later = withRecorded(again, [language], 2, "");
    return first.map((a) => a.id).join() === "a1,a2" &&
      again.length === 2 &&
      again.find((a) => a.label === "Language")?.assumedIndex === 2 &&
      later.length === 3 && later[2].id === "a4";
  });
  const assert_verdict_messages = assert(() => {
    const base = recorded();
    const confirmed = applyVerdict(base, "a1", { kind: "confirm" });
    const corrected = applyVerdict(base, "a1", { kind: "choose", index: 2 });
    const rejected = applyVerdict(base, "a1", { kind: "reject" });
    const undone = applyVerdict(corrected.assumptions, "a1", {
      kind: "choose",
      index: 0,
    });
    return confirmed.message === "" &&
      confirmed.assumptions[0].status === "confirmed" &&
      corrected.message ===
        "Regarding language: TypeScript rather than Python." &&
      corrected.assumptions[0].chosenIndex === 2 &&
      rejected.message.startsWith("Regarding language: not Python") &&
      undone.message === "Regarding language: Python after all." &&
      undone.assumptions[0].status === "confirmed";
  });
  const assert_verdict_noops = assert(() => {
    const corrected =
      applyVerdict(recorded(), "a1", { kind: "choose", index: 2 })
        .assumptions;
    return applyVerdict(corrected, "a1", { kind: "choose", index: 2 })
          .message === "" &&
      applyVerdict(corrected, "a1", { kind: "choose", index: 7 }).message ===
        "" &&
      applyVerdict(corrected, "missing", { kind: "reject" }).message === "";
  });
  const assert_latest_fact_wins = assert(() => {
    const first = applyVerdict(recorded(), "a1", { kind: "confirm" })
      .assumptions;
    const second = withRecorded(first, [language], 2, "");
    const facts = settledFacts(
      applyVerdict(second, "a3", { kind: "choose", index: 1 }).assumptions,
    );
    return facts.length === 1 &&
      facts[0] === "Language: JavaScript (not Python)";
  });
  const assert_prompt_builds = assert(() => {
    const open = buildSystemPrompt("", recorded());
    const settledPrompt = buildSystemPrompt(
      "Be kind.",
      applyVerdict(recorded(), "a2", { kind: "reject" }).assumptions,
    );
    return open.startsWith("You are a helpful") &&
      open.includes("recordAssumptions") && !open.includes("settled") &&
      settledPrompt.startsWith("Be kind.") &&
      settledPrompt.includes(
        "- Skill level: none of Beginner, Intermediate, Expert",
      );
  });
  const assert_title = assert(() =>
    chatTitle([]) === "Assumption Surfacer" &&
    chatTitle([user("short")]) === "short" &&
    chatTitle([user("a".repeat(40))]) === `${"a".repeat(30)}…`
  );

  // --- Through the pattern ----------------------------------------------------

  const assert_starts_empty = assert(() =>
    surfacer.assumptions.length === 0 && surfacer.openCount === 0 &&
    surfacer[NAME] === "How do I sort a list?" &&
    surfacer.system.startsWith("You are terse.")
  );

  // The model reports its assumptions through its tool.
  const action_record = action(() =>
    surfacer.recordAssumptions.send({ assumptions: [language, level] })
  );
  const assert_recorded = assert(() =>
    surfacer.assumptions.length === 2 && surfacer.openCount === 2 &&
    surfacer.assumptions[0]?.turn === 1 &&
    surfacer.assumptions[0]?.about === "How do I sort a list?"
  );

  const action_confirm_level = action(() =>
    surfacer.confirmAssumption.send({ id: "a2" })
  );
  const assert_confirmed_no_message = assert(() =>
    surfacer.assumptions[1]?.status === "confirmed" &&
    surfacer.openCount === 1 &&
    surfacer.messages.filter((m) => m.role === "user").length === 1 &&
    surfacer.system.includes("- Skill level: Intermediate (confirmed)")
  );

  // Picking another alternative in the sidebar corrects it and tells the chat.
  const action_click_typescript = action(() =>
    clickInRow(surfacer[UI], "Language", "TypeScript")
  );
  const assert_corrected = assert(() =>
    surfacer.assumptions[0]?.status === "corrected" &&
    surfacer.assumptions[0]?.chosenIndex === 2 &&
    surfacer.openCount === 0 &&
    lastText(surfacer.messages) ===
      "Regarding language: TypeScript rather than Python." &&
    surfacer.settled.includes("Language: TypeScript (not Python)")
  );

  const action_reject_level = action(() =>
    surfacer.rejectAssumption.send({ id: "a2" })
  );
  const assert_rejected = assert(() =>
    surfacer.assumptions[1]?.status === "rejected" &&
    lastText(surfacer.messages).startsWith("Regarding skill level: not") &&
    surfacer.system.includes("- Skill level: none of")
  );

  const assert_fs_projection = assert(() =>
    surfacer[FS].content.includes(
      "- Language (corrected): **Python** / JavaScript / TypeScript → TypeScript",
    ) &&
    surfacer[FS].content.includes("- Skill level (none of these)")
  );

  const action_clear = action(() => surfacer.clearChat.send());
  const assert_cleared = assert(() =>
    surfacer.messages.length === 0 && surfacer.assumptions.length === 0 &&
    surfacer[NAME] === "Assumption Surfacer"
  );

  return {
    [TESTS]: [
      { assertion: assert_parse_drops_unusable },
      { assertion: assert_parse_clamps },
      { assertion: assert_parse_accepts_legacy_shape },
      { assertion: assert_parse_rejects_non_object },
      { assertion: assert_record_ids_and_replace },
      { assertion: assert_verdict_messages },
      { assertion: assert_verdict_noops },
      { assertion: assert_latest_fact_wins },
      { assertion: assert_prompt_builds },
      { assertion: assert_title },
      { assertion: assert_starts_empty },
      { action: action_record },
      { assertion: assert_recorded },
      { action: action_confirm_level },
      { assertion: assert_confirmed_no_message },
      { action: action_click_typescript },
      { settle: true },
      { assertion: assert_corrected },
      { action: action_reject_level },
      { settle: true },
      { assertion: assert_rejected },
      { assertion: assert_fs_projection },
      { action: action_clear },
      { assertion: assert_cleared },
    ],
    surfacer,
  };
});
