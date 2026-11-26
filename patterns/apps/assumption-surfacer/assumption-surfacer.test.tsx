/**
 * Assumption Surfacer pattern tests.
 *
 * The test environment has no language model: the dialog answers the one
 * message `llmMocks` covers with its text and every other with its error reply,
 * and never calls the `recordAssumptions` tool. The tests play the model's part
 * by appending its tool call to the chat, which is where the pattern reads the
 * assumptions from, then drive the verdicts through the streams and the
 * sidebar's buttons. The mocked turn is what keeps `pending`
 * true while verdicts arrive, which is where updates must queue, not vanish.
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
import {
  clickButton,
  clickInRow,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import AssumptionSurfacer, {
  applyVerdict,
  type Assumption,
  buildSystemPrompt,
  chatTitle,
  composeMessage,
  messageText,
  nextUpdate,
  normalizeReported,
  realUserMessages,
  recordedAssumptions,
  type ReportedAssumption,
  type SentUpdate,
  settledFacts,
  unsentUpdates,
  UPDATE_TAG,
  updateFor,
  userText,
  withRecorded,
} from "./main.tsx";

const FOLLOW_UP = "Make it work in a browser";

export const llmMocks = [
  {
    when: { lastMessageContains: FOLLOW_UP },
    text: "Here is a browser version.",
  },
  // Every other request fails, as an unanswered one did before `cf test`
  // answered every request: these steps check what the pattern does without
  // the answer.
  { error: "Not answered in this test.", repeat: true },
];

const user = (text: string): BuiltInLLMMessage => ({
  role: "user",
  content: [{ type: "text" as const, text }],
});

/** The assistant's message calling its tool, as the dialog stores it. */
const toolCall = (assumptions: ReportedAssumption[]): BuiltInLLMMessage => ({
  role: "assistant",
  content: [{
    type: "tool-call" as const,
    toolCallId: `call-${assumptions.map((a) => a.label).join("-")}`,
    toolName: "recordAssumptions",
    input: { assumptions },
  }],
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

const LANGUAGE_UPDATE = "Regarding language: JavaScript rather than Python.";
const LEVEL_UPDATE = "Regarding skill level: Intermediate after all.";

/** Every user message's text after the follow-up, joined. */
const sinceFollowUp = (messages: readonly BuiltInLLMMessage[]): string =>
  messages
    .slice(messages.findIndex((m) => messageText(m) === FOLLOW_UP))
    .filter((m) => m.role === "user")
    .map(messageText)
    .join(" ");

const update = (...lines: string[]): string =>
  `${UPDATE_TAG} ${lines.join(" ")}`;

export default pattern(() => {
  const messages = new Writable<BuiltInLLMMessage[]>([
    user("How do I sort a list?"),
  ]);
  const systemPrompt = new Writable("You are terse.");
  const surfacer = AssumptionSurfacer({ messages, systemPrompt });

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
  // The assumed index names an alternative as reported: blanks and repeats
  // dropped before it do not shift it onto a different option.
  const assert_parse_follows_assumed = assert(() => {
    const [shifted, dropped] = normalizeReported({
      assumptions: [
        {
          label: "Editor",
          alternatives: ["", "Vim", "Vim", "Emacs"],
          assumedIndex: 3,
        },
        { label: "Shell", alternatives: ["bash", "", "zsh"], assumedIndex: 1 },
      ],
    });
    return shifted?.alternatives.join() === "Vim,Emacs" &&
      shifted?.assumedIndex === 1 && dropped?.assumedIndex === 0;
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
  // A second call in the same reply may replace its cards but not add past
  // three; a later reply starts its own three.
  const assert_record_caps_reply = assert(() => {
    const os = { label: "OS", alternatives: ["Mac", "Linux"], assumedIndex: 0 };
    const editor = { ...os, label: "Editor" };
    const third = withRecorded(recorded(), [os, editor], 1, "");
    const swapped = withRecorded(
      third,
      [editor, { ...level, assumedIndex: 2 }],
      1,
      "",
    );
    const next = withRecorded(third, [editor], 2, "");
    return third.map((a) => a.label).join() === "Language,Skill level,OS" &&
      swapped.length === 3 &&
      swapped.find((a) => a.label === "Skill level")?.assumedIndex === 2 &&
      next.length === 4;
  });
  const assert_verdict_updates = assert(() => {
    const base = recorded();
    const confirmed = applyVerdict(base, "a1", { kind: "confirm" });
    const corrected = applyVerdict(base, "a1", { kind: "choose", index: 2 });
    const rejected = applyVerdict(base, "a1", { kind: "reject" });
    const undone = applyVerdict(corrected, "a1", { kind: "choose", index: 0 });
    return updateFor(confirmed[0], 0) === "" &&
      confirmed[0].status === "confirmed" &&
      updateFor(corrected[0], 0) ===
        "Regarding language: TypeScript rather than Python." &&
      corrected[0].chosenIndex === 2 &&
      updateFor(rejected[0], 0) ===
        "Regarding language: none of Python, JavaScript, TypeScript." &&
      // Taken back after the assistant heard the correction, and before.
      updateFor(undone[0], 2) === "Regarding language: Python after all." &&
      updateFor(undone[0], 0) === "" &&
      undone[0].status === "confirmed";
  });
  // An update counts as told only once its message is in the chat: a send the
  // dialog dropped leaves it unsent.
  const assert_told_only_when_landed = assert(() => {
    const corrected = applyVerdict(recorded(), "a1", {
      kind: "choose",
      index: 2,
    });
    const history = [user("How do I sort a list?")];
    const send = nextUpdate(corrected, [], history) as SentUpdate;
    const landed = [...history, composeMessage(send.text, "")!];
    return send.from === 1 && send.beliefs[0]?.index === 2 &&
      unsentUpdates(corrected, [send], history).length === 1 &&
      unsentUpdates(corrected, [send], landed).length === 0 &&
      nextUpdate(corrected, [send], landed) === null &&
      // Before `from`, the same text is an older send, not this one.
      unsentUpdates(corrected, [{ ...send, from: 2 }], landed).length === 1;
  });
  const assert_verdict_noops = assert(() => {
    const corrected = applyVerdict(recorded(), "a1", {
      kind: "choose",
      index: 2,
    });
    return applyVerdict(corrected, "a1", { kind: "choose", index: 7 })[0]
          .chosenIndex === 2 &&
      applyVerdict(corrected, "missing", { kind: "reject" }).every((a, i) =>
        a.status === corrected[i].status
      );
  });
  // Updates ride in a tagged part of their own, so they never count as words
  // the user wrote: not for the title, the turn, or a card's "About".
  const assert_update_parts = assert(() => {
    const tagged = `${UPDATE_TAG} Regarding x: y rather than z.`;
    const both = composeMessage(tagged, "Hi");
    const only = composeMessage(tagged, "");
    const messages = [user("First"), only!, both!];
    return composeMessage("", " ") === null &&
      userText(both!) === "Hi" && userText(only!) === "" &&
      messageText(only!).startsWith(UPDATE_TAG) &&
      realUserMessages(messages).length === 2 &&
      chatTitle([only!, user("Later")]) === "Later";
  });
  const assert_latest_fact_wins = assert(() => {
    const first = applyVerdict(recorded(), "a1", { kind: "confirm" });
    const second = withRecorded(first, [language], 2, "");
    const facts = settledFacts(
      applyVerdict(second, "a3", { kind: "choose", index: 1 }),
    );
    return facts.length === 1 &&
      facts[0] === "Language: JavaScript (not Python)";
  });
  const assert_prompt_builds = assert(() => {
    const open = buildSystemPrompt("", recorded());
    const settledPrompt = buildSystemPrompt(
      "Be kind.",
      applyVerdict(recorded(), "a2", { kind: "reject" }),
    );
    return open.startsWith("You are a helpful") &&
      open.includes("recordAssumptions") && !open.includes("settled") &&
      settledPrompt.startsWith("Be kind.") &&
      settledPrompt.includes(
        "- Skill level: none of Beginner, Intermediate, Expert",
      );
  });
  // The record is read from the tool calls in the chat: each rests on the
  // user's last own message, never on an update sent on their behalf.
  const assert_record_from_chat = assert(() => {
    const record = recordedAssumptions([
      user("How do I sort a list?"),
      toolCall([language, level]),
      { role: "assistant", content: "Use sorted()." },
      composeMessage(`${UPDATE_TAG} Regarding x: y.`, "")!,
      toolCall([{ ...language, assumedIndex: 1 }]),
      user("Now in a browser"),
      toolCall([{ label: "", alternatives: ["a"], assumedIndex: 0 }]),
      toolCall([{
        label: "Browser",
        alternatives: ["A", "B"],
        assumedIndex: 0,
      }]),
    ]);
    return record.map((a) => `${a.id}:${a.label}:${a.turn}`).join() ===
        "a2:Skill level:1,a3:Language:1,a4:Browser:2" &&
      record[1].assumedIndex === 1 && record[2].about === "Now in a browser" &&
      record.every((a) => a.status === "open");
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

  // The model reports its assumptions through its tool; the call lands in the
  // chat. The handler itself writes nothing.
  const action_record = action(() => {
    surfacer.recordAssumptions.send({ assumptions: [language, level] });
    messages.push(toolCall([language, level]));
  });
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
    surfacer.unsent.length === 0 &&
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
      update("Regarding language: TypeScript rather than Python.") &&
    surfacer.unsent.length === 0 &&
    surfacer.settled.includes("Language: TypeScript (not Python)")
  );

  const action_reject_level = action(() =>
    surfacer.rejectAssumption.send({ id: "a2" })
  );
  const assert_rejected = assert(() =>
    surfacer.assumptions[1]?.status === "rejected" &&
    lastText(surfacer.messages).startsWith(
      update("Regarding skill level: none of Beginner,"),
    ) &&
    surfacer.system.includes("- Skill level: none of")
  );

  const assert_fs_projection = assert(() =>
    surfacer[FS].content.includes(
      "- Language (corrected): **Python** / JavaScript / TypeScript → TypeScript",
    ) &&
    surfacer[FS].content.includes("- Skill level (none of these)")
  );

  // A follow-up from the user, answered by the mocked model.
  const action_follow_up = action(() =>
    surfacer.addMessage.send(user(FOLLOW_UP))
  );
  const assert_follow_up_answered = assert(() =>
    lastText(surfacer.messages) === FOLLOW_UP &&
    messageText(surfacer.messages.at(-1)) === "Here is a browser version."
  );

  // Two verdicts at once: the first is sent and starts a turn, and the second
  // arrives before or while that turn runs, when the dialog drops a message.
  // Which interleaving happens is the scheduler's choice, so the test pins
  // what must hold for either: no verdict vanishes. Each one has reached the
  // chat or is still waiting, and sending what waits tells the assistant all.
  const action_two_verdicts = action(() => {
    surfacer.chooseAlternative.send({ id: "a1", index: 1 });
    surfacer.confirmAssumption.send({ id: "a2" });
  });
  const assert_nothing_vanished = assert(() => {
    const told = sinceFollowUp(surfacer.messages);
    const waiting = surfacer.unsent.join(" ");
    return surfacer.assumptions[0]?.chosenIndex === 1 &&
      surfacer.assumptions[1]?.status === "confirmed" &&
      (told + waiting).includes(LANGUAGE_UPDATE) &&
      (told + waiting).includes(LEVEL_UPDATE) &&
      surfacer.pending !== true;
  });
  const action_send_waiting = action(() => surfacer.sendUpdates.send());
  const assert_all_told = assert(() => {
    const told = sinceFollowUp(surfacer.messages);
    return surfacer.unsent.length === 0 && told.includes(LANGUAGE_UPDATE) &&
      told.includes(LEVEL_UPDATE);
  });

  // A verdict the assistant has not heard waits in the sidebar, which offers
  // to send it. Seeded here: an assumption corrected but never sent.
  const seeded = AssumptionSurfacer({
    messages: new Writable<BuiltInLLMMessage[]>([
      user("How do I sort?"),
      toolCall([language, level]),
    ]),
    verdicts: new Writable({
      a1: { status: "corrected" as const, chosenIndex: 2 },
    }),
  });
  const assert_waiting_offered = assert(() =>
    seeded.unsent.length === 1 &&
    hasText(seeded[UI], "1 update for the assistant not sent yet")
  );
  const action_tell_now = action(() => clickButton(seeded[UI], "Tell it now"));
  const assert_told_now = assert(() =>
    lastText(seeded.messages) ===
      update("Regarding language: TypeScript rather than Python.") &&
    seeded.unsent.length === 0
  );

  // The reply to that update-only message records an assumption: it rests on
  // the user's own second message, not on the update.
  const action_record_after_update = action(() =>
    messages.push(toolCall([{
      label: "Browser",
      alternatives: ["Chrome", "Firefox"],
      assumedIndex: 0,
    }]))
  );
  const assert_turn_counts_real_messages = assert(() => {
    const card = surfacer.assumptions.find((a) => a.label === "Browser");
    return card?.turn === 2 && card?.about === FOLLOW_UP;
  });

  const action_clear = action(() => surfacer.clearChat.send());
  const assert_cleared = assert(() =>
    surfacer.messages.length === 0 && surfacer.assumptions.length === 0 &&
    surfacer.openCount === 0 && surfacer.unsent.length === 0 &&
    surfacer.settled.length === 0 &&
    surfacer[NAME] === "Assumption Surfacer"
  );

  return {
    [TESTS]: [
      { assertion: assert_parse_drops_unusable },
      { assertion: assert_parse_clamps },
      { assertion: assert_parse_follows_assumed },
      { assertion: assert_parse_accepts_legacy_shape },
      { assertion: assert_parse_rejects_non_object },
      { assertion: assert_record_ids_and_replace },
      { assertion: assert_record_caps_reply },
      { assertion: assert_verdict_updates },
      { assertion: assert_told_only_when_landed },
      { assertion: assert_verdict_noops },
      { assertion: assert_update_parts },
      { assertion: assert_latest_fact_wins },
      { assertion: assert_prompt_builds },
      { assertion: assert_record_from_chat },
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
      { action: action_follow_up },
      { assertion: assert_follow_up_answered },
      { action: action_two_verdicts },
      { settle: true },
      { assertion: assert_nothing_vanished },
      { action: action_send_waiting },
      { settle: true },
      { assertion: assert_all_told },
      { action: action_record_after_update },
      { assertion: assert_turn_counts_real_messages },
      { action: action_clear },
      { assertion: assert_cleared },
      { assertion: assert_waiting_offered },
      { action: action_tell_now },
      { settle: true },
      { assertion: assert_told_now },
    ],
    surfacer,
  };
});
