/**
 * Test: the daily journal and its weekly rollup view.
 *
 * Picking a day on the calendar, and "Go to Today", file a note for that day
 * from the template, once: picking the day again finds the note rather than
 * filing another. The summary, the calendar's marked days, the settings view,
 * and the rollup card for a week with notes in it are read off the journal.
 *
 * The journal's rollup comes from a language model, which a pattern test
 * cannot reach, so the rollup view is given rollups directly.
 *
 * Run: deno task cf test patterns/system/notes/daily-journal.test.tsx --root patterns --verbose
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  wish,
  Writable,
} from "commonfabric";
import {
  clickButton,
  findElement,
  findNode,
  findNodeByText,
  fireEvent,
  hasText,
  isElement,
  propValue,
  styleOf,
} from "../../tools/test-support/vnode-helpers.ts";
import DailyJournal, { RollupView } from "./daily-journal.tsx";
import Note from "./note.tsx";

// ===== View helpers (module scope: SES callbacks may not capture callables
// from enclosing function scopes) =====

const pickDay = (root: unknown, value: string): void =>
  fireEvent(
    findElement(root, "cf-calendar"),
    "oncf-change",
    { detail: { value, oldValue: "" } },
    "the calendar",
  );

/** The settings view: the stack that holds the template editor. */
const settingsView = (root: unknown): unknown =>
  findNode(
    root,
    (node) =>
      isElement(node, "cf-vstack") && hasText(node, "Daily Note Template"),
  );

type Entry = { title?: string; content?: string };

const entriesOf = (journal: { entries?: unknown }): Entry[] => [
  ...((journal.entries as Entry[] | undefined) ?? []),
];

const contentOf = (journal: { entries?: unknown }, title: string) =>
  entriesOf(journal).find((e) => e?.title === title)?.content ?? "";

const TODAY_TITLE = /^\d{4}-\d{2}-\d{2} - [A-Z][a-z]+day$/;

const ROLLUP = {
  headline: "A steady week",
  themes: [{ name: "Garden", detail: "planted beans" }],
  accomplishments: ["Fixed the fence"],
  openThreads: ["Order seeds"],
  mood: "calm",
};

export default pattern(() => {
  const registrations = wish<{ testPieceRegistrationCount: number }>({
    query: "#default",
  }).result!;

  const template = new Writable("");
  const journal = DailyJournal({
    title: "Journal",
    entries: [Note({ title: "Ideas", content: "Undated" })],
    template,
  });

  // ===== Filing a day's note =====

  const action_pick_march_second = action(() =>
    pickDay(journal[UI], "2026-03-02")
  );
  const assert_march_second_filed = assert(() =>
    entriesOf(journal).length === 2 &&
    contentOf(journal, "2026-03-02 - Monday").startsWith(
      "# 2026-03-02 - Monday\n\n## Tasks",
    ) &&
    registrations.testPieceRegistrationCount === 1
  );
  const assert_pick_again_files_nothing = assert(() =>
    entriesOf(journal).length === 2 &&
    registrations.testPieceRegistrationCount === 1
  );

  const action_set_template = action(() => {
    template.set("Plan for {{dayOfWeek}}, {{month}} {{year}} ({{date}})");
  });
  const action_pick_march_tenth = action(() =>
    pickDay(journal[UI], "2026-03-10")
  );
  const assert_template_applied = assert(() =>
    contentOf(journal, "2026-03-10 - Tuesday") ===
      "Plan for Tuesday, March 2026 (2026-03-10)"
  );

  const action_go_to_today = action(() => {
    journal.goToToday.send();
  });
  const assert_today_filed = assert(() => {
    const today = entriesOf(journal).filter((e) =>
      TODAY_TITLE.test(e?.title ?? "") &&
      e?.title !== "2026-03-02 - Monday" && e?.title !== "2026-03-10 - Tuesday"
    );
    return entriesOf(journal).length === 4 && today.length === 1 &&
      (today[0]?.content ?? "").startsWith("Plan for ");
  });
  const action_go_to_today_again = action(() => {
    journal.goToToday.send();
  });
  const assert_today_not_filed_twice = assert(() =>
    entriesOf(journal).length === 4
  );

  // ===== What the journal reports =====

  const assert_name = assert(() => journal[NAME] === "📅 Journal");
  const assert_summary_names_latest = assert(() => {
    const latest = entriesOf(journal)
      .map((e) => e?.title ?? "")
      .sort()
      .reverse()[0]
      .slice(0, 10);
    return journal.summary === `Daily Journal — 4 entries, last: ${latest}`;
  });
  const assert_calendar_marks_dated_entries = assert(() => {
    const marked = [
      ...((propValue(
        findElement(journal[UI], "cf-calendar"),
        "markedDates",
      ) as string[] | undefined) ?? []),
    ];
    return marked.length === 3 && marked.includes("2026-03-02") &&
      marked.includes("2026-03-10");
  });
  // Today's note is from this week, so the rollup card is shown.
  const assert_rollup_card_shown = assert(() =>
    findNodeByText(journal[UI], "Weekly Rollup") !== undefined
  );

  // ===== Settings =====

  const action_open_settings = action(() =>
    clickButton(journal[UI], "Settings")
  );
  const assert_settings_shown = assert(() =>
    styleOf(settingsView(journal[UI]), "display") === "flex"
  );
  const action_close_settings = action(() => clickButton(journal[UI], "Done"));
  const assert_settings_hidden = assert(() =>
    styleOf(settingsView(journal[UI]), "display") === "none"
  );

  // ===== The rollup view =====

  const full = RollupView({ rollup: ROLLUP });
  const sparse = RollupView({
    rollup: {
      headline: "",
      themes: [],
      accomplishments: [],
      openThreads: [],
      mood: "",
    },
  });
  const none = RollupView({});

  const assert_rollup_shown = assert(() =>
    hasText(full[UI], "A steady week") &&
    hasText(full[UI], "Garden — planted beans") &&
    hasText(full[UI], "DoneFixed the fence") &&
    hasText(full[UI], "Open ThreadsOrder seeds") &&
    hasText(full[UI], "calm")
  );
  const assert_rollup_asks_for_suggestion = assert(() =>
    full.situation ===
      "Based on my weekly journal rollup, suggest a next step or useful pattern. Active themes: Garden. Open threads: Order seeds. Mood: calm." &&
    full.context.weeklyHeadline === "A steady week" &&
    full.context.openThreads[0] === "Order seeds"
  );
  const assert_empty_lists_hidden = assert(() =>
    !hasText(sparse[UI], "Done") && !hasText(sparse[UI], "Open Threads") &&
    sparse.situation.endsWith("Mood: unknown.") &&
    sparse.context.weeklyHeadline === ""
  );
  const assert_no_rollup_asks_generally = assert(() =>
    none.situation === "Suggest something useful based on my daily journal." &&
    none.context.themes.length === 0
  );

  return {
    [TESTS]: [
      { action: action_pick_march_second },
      { assertion: assert_march_second_filed },
      { action: action_pick_march_second },
      { assertion: assert_pick_again_files_nothing },
      { action: action_set_template },
      { action: action_pick_march_tenth },
      { assertion: assert_template_applied },
      { action: action_go_to_today },
      { assertion: assert_today_filed },
      { action: action_go_to_today_again },
      { assertion: assert_today_not_filed_twice },

      { assertion: assert_name },
      { assertion: assert_summary_names_latest },
      { assertion: assert_calendar_marks_dated_entries },
      { assertion: assert_rollup_card_shown },

      { action: action_open_settings },
      { assertion: assert_settings_shown },
      { action: action_close_settings },
      { assertion: assert_settings_hidden },

      { assertion: assert_rollup_shown },
      { assertion: assert_rollup_asks_for_suggestion },
      { assertion: assert_empty_lists_hidden },
      { assertion: assert_no_rollup_asks_generally },
    ],
    journal,
    // With server execution on, a navigation an action's event makes is a
    // cascade hop, which the client does not enact ahead of the server, and
    // the runtime warns `optimistic-navigate-skipped`. A pick on the calendar
    // is a `cf-change`, which only an action can send, and "Go to Today" sent
    // as a step of its own is dropped ("no handler registered ... after
    // starting its piece") with server execution off. The flag is a boolean,
    // so it cannot be pinned to that warning.
    allowConsoleWarnings: true,
  };
});
