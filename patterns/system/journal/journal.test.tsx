/**
 * Test Pattern: the journal
 *
 * The journal shows the home journal's entries, newest first, each with its
 * kind of event, its age, its narrative, the piece it was about, and its tags.
 * The test writes entries into the home journal at known ages and reads each
 * part back from the view, then clears the journal from its own control.
 *
 * The view ages entries by the shared minute clock, which can tick between
 * the write and an assertion; the ages in minutes are therefore expected
 * from how far the clock has moved since the write, read from the same clock.
 */
import {
  action,
  assert,
  computed,
  NAME,
  pattern,
  TESTS,
  UI,
  wish,
  Writable,
} from "commonfabric";
import {
  clickButton,
  countElements,
  findNode,
  hasText,
  innermostNode,
  isButton,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import Journal, { type JournalEntry } from "./journal.tsx";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The view's debug panel prints the raw entries, so a search for an entry's
// text skips any node that holds the panel's `narrative:` keys.
const outsideDebug = (node: unknown): boolean => !hasText(node, "narrative:");

/** The text of the entry row that shows `narrative`: the innermost node
 * holding it alongside the row's header of icon, kind, and age. */
const rowText = (ui: unknown, narrative: string): string =>
  textContent(
    innermostNode(
      ui,
      (node) =>
        hasText(node, narrative) && outsideDebug(node) &&
        countElements(node, "span") >= 3,
    ),
  );

/** The text of the list of entries. */
const listText = (ui: unknown): string =>
  textContent(
    innermostNode(
      ui,
      (node) =>
        hasText(node, "Newest") && hasText(node, "Oldest") &&
        outsideDebug(node),
    ),
  );

export default pattern(() => {
  const journal = wish<Writable<JournalEntry[]>>({ query: "#journal" })
    .result!;
  const nowCell = wish<number>({ query: "#now/60" });
  // The clock's reading when the entries were written, and the date an entry
  // over a week old shows, worked out then.
  const writtenAt = new Writable(0);
  const oldDate = new Writable("");

  const subject = new Writable<{ [NAME]?: string }>({ [NAME]: "Garden plan" });
  const view = Journal({});

  const assert_starts_empty = assert(() =>
    view[NAME] === "Journal" &&
    hasText(view[UI], "No journal entries yet.") &&
    findNode(view[UI], isButton("Clear Journal")) === undefined
  );

  const action_write_entries = action(() => {
    const now = nowCell.result;
    if (now === undefined) return;
    writtenAt.set(now);
    oldDate.set(new Date(now - 30 * DAY).toLocaleDateString());
    journal.set([
      {
        timestamp: now - 30 * DAY,
        eventType: "space:entered",
        narrative: "Oldest",
      },
      {
        timestamp: now - 3 * DAY,
        eventType: "piece:modified",
        narrative: "Days",
      },
      {
        timestamp: now - 5 * HOUR,
        eventType: "piece:created",
        narrative: "Hours",
      },
      {
        timestamp: now - 15 * MINUTE,
        eventType: "piece:unfavorited",
        narrative: "Minutes",
      },
      { eventType: "custom:event", narrative: "Undated" },
      { narrative: "Untyped" },
      {
        timestamp: now,
        eventType: "piece:favorited",
        narrative: "Newest",
        subject,
        snapshot: { name: "Garden plan" },
        tags: ["outdoors", "spring"],
      },
    ]);
  });

  const assert_newest_first = assert(() => {
    const text = listText(view[UI]);
    return text.indexOf("Newest") < text.indexOf("Minutes") &&
      text.indexOf("Minutes") < text.indexOf("Oldest");
  });
  const assert_labels_event_kinds = assert(() =>
    rowText(view[UI], "Newest").includes("Favorited") &&
    rowText(view[UI], "Minutes").includes("Unfavorited") &&
    rowText(view[UI], "Hours").includes("Created") &&
    rowText(view[UI], "Days").includes("Modified") &&
    rowText(view[UI], "Oldest").includes("Entered space") &&
    rowText(view[UI], "Undated").includes("custom:event") &&
    rowText(view[UI], "Untyped").includes("Unknown")
  );
  // Minutes the clock has ticked since the write: normally none.
  const ticks = computed(() =>
    Math.round(((nowCell.result ?? 0) - writtenAt.get()) / MINUTE)
  );
  const assert_shows_ages = assert(() =>
    rowText(view[UI], "Newest").includes(
      ticks === 0 ? "just now" : `${ticks}m ago`,
    ) &&
    rowText(view[UI], "Minutes").includes(`${15 + ticks}m ago`) &&
    rowText(view[UI], "Hours").includes("5h ago") &&
    rowText(view[UI], "Days").includes("3d ago") &&
    rowText(view[UI], "Oldest").includes(oldDate.get())
  );
  const assert_shows_subject_and_tags = assert(() =>
    rowText(view[UI], "Newest").includes("Garden plan:") &&
    rowText(view[UI], "Newest").includes("outdoors") &&
    rowText(view[UI], "Newest").includes("spring")
  );

  const action_clear = action(() => clickButton(view[UI], "Clear Journal"));
  const assert_cleared = assert(() =>
    journal.get()?.length === 0 && hasText(view[UI], "No journal entries yet.")
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_empty },
      { action: action_write_entries },
      { assertion: assert_newest_first },
      { assertion: assert_labels_event_kinds },
      { assertion: assert_shows_ages },
      { assertion: assert_shows_subject_and_tags },
      { action: action_clear },
      { assertion: assert_cleared },
    ],
    view,
  };
});
