/**
 * Test Pattern: Do List
 *
 * Exercises the do-list contract via runSynced:
 * - empty initial state
 * - add items via addItem
 * - reference-addressed update (updateItem matched with equals())
 * - title-addressed update (updateItemByTitle, case-insensitive, updates ALL
 *   matching titles — the legacy-but-consumed omnibox API)
 * - reference-addressed remove (removeItem)
 * - held-reference survival (CT-1715): a reference stashed in a cell BEFORE
 *   an update (a selection cell, a caller that read the item earlier) must
 *   still `equals()`-match and still drive a subsequent operation AFTER the
 *   item is updated — both for the reference-addressed updateItem and the
 *   title-addressed updateItemByTitle. This guards the update-in-place
 *   contract: updates write through the element's cells; replacing the array
 *   slot with a fresh object literal would re-mint the entity identity and
 *   orphan every held reference.
 * - the name, summary, and mentionable outputs, and the rendered list: the
 *   completed section and its archive button, each card's remove button,
 *   attachment drop and removal, and both add-item fields
 * - batch adds, removal of a task with its subtasks by reference and by
 *   title, and attachments added by title
 *
 * Run: deno task cf test patterns/examples/do-list/do-list.test.tsx --verbose
 */
import {
  action,
  assert,
  equals,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  findNode,
  findNodeByProp,
  fireClick,
  fireEvent,
  hasText,
  innermostNode,
  isButton,
  propValue,
  sendMessage,
  viewShows,
} from "../../tools/test-support/vnode-helpers.ts";
import DoList, { type DoItem } from "./do-list.tsx";

const titles = (items: readonly DoItem[]): string =>
  items.map((item) => item.title).join(",");

// The drop zone wrapping the card whose title field holds `title`.
const dropZoneOf = (root: unknown, title: string): unknown =>
  findNode(
    root,
    (node) =>
      propValue(node, "accept") === "cell-link" &&
      findNodeByProp(node, "$value", title) !== undefined,
  );

// The card's own row: its checkbox, title field, and remove button.
const cardRowOf = (root: unknown, title: string): unknown =>
  innermostNode(
    root,
    (node) =>
      findNodeByProp(node, "$value", title) !== undefined &&
      findNode(node, isButton("x")) !== undefined,
  );

export default pattern(() => {
  const doList = DoList({});

  // Simulates an external holder (selection cell / attachment source) that
  // read an item once and keeps the reference across later mutations.
  const held = new Writable<DoItem | null>(null);
  const heldByTitle = new Writable<DoItem | null>(null);
  // A cell attached to a task.
  const packingList = Writable.of({ title: "Packing list" });

  // ==========================================================================
  // Actions
  // ==========================================================================

  const add_alpha = action(() => {
    doList.addItem.send({ title: "Alpha" });
  });
  const add_beta = action(() => {
    doList.addItem.send({ title: "Beta" });
  });
  const add_gamma = action(() => {
    doList.addItem.send({ title: "Gamma" });
  });

  // Reference-addressed: read the live item from the list, then send it.
  const done_first_by_ref = action(() => {
    const item = doList.items[0];
    if (item) doList.updateItem.send({ item, done: true });
  });
  const rename_first_by_ref = action(() => {
    const item = doList.items[0];
    if (item) doList.updateItem.send({ item, title: "Alpha!" });
  });

  // Title-addressed (LLM/omnibox API), case-insensitive.
  const rename_beta_by_title = action(() => {
    doList.updateItemByTitle.send({
      title: "BETA",
      newTitle: "Beta2",
      done: true,
    });
  });

  // Duplicate titles: the title-addressed handler updates ALL matches (the
  // original `.map()` semantics, preserved by the in-place rewrite).
  const add_dup = action(() => {
    doList.addItem.send({ title: "Dup" });
  });
  const done_all_dups_by_title = action(() => {
    doList.updateItemByTitle.send({ title: "dup", done: true });
  });

  // Held-reference survival across the reference-addressed updateItem.
  const add_held_target = action(() => {
    doList.addItem.send({ title: "Held" });
  });
  const stash_held = action(() => {
    const item = doList.items[5];
    if (item) held.set(item);
  });
  const rename_held_target = action(() => {
    const item = doList.items[5];
    if (item) doList.updateItem.send({ item, title: "HeldRenamed" });
  });
  const done_via_held = action(() => {
    const h = held.get();
    if (h) doList.updateItem.send({ item: h, done: true });
  });
  const remove_via_held = action(() => {
    const h = held.get();
    if (h) doList.removeItem.send({ item: h });
  });

  // Held-reference survival across the TITLE-addressed updateItemByTitle.
  const add_title_held_target = action(() => {
    doList.addItem.send({ title: "TitleHeld" });
  });
  const stash_title_held = action(() => {
    const item = doList.items[5];
    if (item) heldByTitle.set(item);
  });
  const rename_title_held_by_title = action(() => {
    doList.updateItemByTitle.send({
      title: "titleheld",
      newTitle: "TitleHeldRenamed",
      done: true,
    });
  });
  const remove_via_title_held = action(() => {
    const h = heldByTitle.get();
    if (h) doList.removeItem.send({ item: h });
  });

  // Through the rendered view, and the batch and title-addressed streams
  const archive_all = action(() => clickButton(doList[UI], "Archive all"));
  const add_trip_batch = action(() => {
    doList.addItems.send({
      items: [
        { title: "Plan trip" },
        { title: "Book flights", indent: 1 },
        { title: "Pick seats", indent: 2 },
        { title: "   " },
        { title: "Pack" },
      ],
    });
  });
  const click_remove_plan_trip = action(() =>
    fireClick(
      findNode(cardRowOf(doList[UI], "Plan trip"), isButton("x")),
      "the remove button on Plan trip",
    )
  );
  const add_errands_batch = action(() => {
    doList.addItems.send({
      items: [
        { title: "Errands" },
        { title: "Groceries", indent: 1 },
        { title: "Laundry" },
      ],
    });
  });
  const remove_errands_by_title = action(() => {
    doList.removeItemByTitle.send({ title: "ERRANDS" });
    doList.removeItemByTitle.send({ title: "No such task" });
  });
  const attach_by_title = action(() => {
    doList.updateItemByTitle.send({
      title: "pack",
      attachments: [packingList],
    });
  });
  const click_remove_attachment = action(() =>
    fireClick(
      findNode(dropZoneOf(doList[UI], "Pack"), isButton("×")),
      "the attachment's remove button on Pack",
    )
  );
  const drop_on_pack = action(() =>
    fireEvent(
      dropZoneOf(doList[UI], "Pack"),
      "oncf-drop",
      { type: "cf-drop", detail: { sourceCell: packingList } },
      "Pack",
    )
  );
  const submit_in_full_view = action(() => {
    sendMessage(doList[UI], "  Wash car ");
    sendMessage(doList[UI], "   ");
  });
  const submit_in_compact_view = action(() =>
    sendMessage(doList.compactUI, "Fuel up")
  );
  const done_laundry = action(() =>
    doList.updateItemByTitle.send({ title: "Laundry", done: true })
  );
  const archive_in_compact_view = action(() =>
    clickButton(doList.compactUI, "Archive completed")
  );

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_initial_view = assert(() =>
    doList[NAME] === "Do List (0)" && doList.summary === "" &&
    viewShows(doList[UI], ["0 items", "No items yet. Add one below!"], [
      "Completed (",
    ]) &&
    hasText(doList.compactUI, "No items yet. Add one below!")
  );

  // Done items move to the completed section; only open ones are cards and
  // mentionable.
  const assert_completed_section = assert(() =>
    doList[NAME] === "Do List (5)" &&
    doList.summary === "✓ Alpha!, ✓ Beta2, ○ Gamma, ✓ Dup, ✓ Dup" &&
    viewShows(doList[UI], ["1 items", "Completed (4)", "Alpha!"], [
      "No items yet.",
    ]) &&
    doList.mentionable.length === 1 &&
    doList.mentionable[0]?.[NAME] === "Gamma" &&
    doList.mentionable[0]?.summary === "Gamma"
  );
  const assert_archived = assert(() =>
    titles(doList.items) === "Gamma" && doList[NAME] === "Do List (1)" &&
    !hasText(doList[UI], "Completed (")
  );

  // Each card is indented by its depth; the blank title was skipped.
  const assert_trip_batch = assert(() =>
    titles(doList.items) === "Gamma,Plan trip,Book flights,Pick seats,Pack" &&
    doList.items[3]?.indent === 2 && doList.items[4]?.indent === 0 &&
    findNodeByProp(
        findNodeByProp(doList[UI], "style", "margin-left: 48px;"),
        "$value",
        "Pick seats",
      ) !== undefined
  );
  const assert_trip_removed_with_subtasks = assert(() =>
    titles(doList.items) === "Gamma,Pack"
  );
  const assert_errands_batch = assert(() =>
    titles(doList.items) === "Gamma,Pack,Errands,Groceries,Laundry"
  );
  const assert_errands_removed_with_subtasks = assert(() =>
    titles(doList.items) === "Gamma,Pack,Laundry"
  );
  const assert_attached = assert(() =>
    doList.items[1]?.attachments.length === 1 &&
    equals(doList.items[1]?.attachments[0], packingList) &&
    findNode(dropZoneOf(doList[UI], "Pack"), isButton("×")) !== undefined
  );
  const assert_attachment_removed = assert(() =>
    doList.items[1]?.attachments.length === 0 &&
    findNode(dropZoneOf(doList[UI], "Pack"), isButton("×")) === undefined
  );
  const assert_submitted = assert(() =>
    titles(doList.items) === "Gamma,Pack,Laundry,Wash car,Fuel up"
  );
  const assert_archived_in_compact_view = assert(() =>
    titles(doList.items) === "Gamma,Pack,Wash car,Fuel up"
  );

  const assert_initial_empty = assert(() => doList.itemCount === 0);

  const assert_three = assert(() => doList.itemCount === 3);
  const assert_titles = assert(() =>
    doList.items[0]?.title === "Alpha" &&
    doList.items[1]?.title === "Beta" &&
    doList.items[2]?.title === "Gamma"
  );

  const assert_first_done = assert(() => doList.items[0]?.done === true);
  const assert_first_renamed = assert(() =>
    doList.items[0]?.title === "Alpha!" && doList.items[0]?.done === true
  );
  const assert_others_untouched = assert(() =>
    doList.items[1]?.title === "Beta" && doList.items[1]?.done === false &&
    doList.items[2]?.title === "Gamma" && doList.items[2]?.done === false
  );

  const assert_beta_renamed_done = assert(() =>
    doList.items[1]?.title === "Beta2" && doList.items[1]?.done === true
  );

  const assert_five = assert(() => doList.itemCount === 5);
  const assert_all_dups_done = assert(() => {
    const dups = doList.items.filter((i: DoItem) => i.title === "Dup");
    return dups.length === 2 && dups.every((i: DoItem) => i.done === true);
  });

  // Held-reference survival (reference-addressed update).
  const assert_six = assert(() => doList.itemCount === 6);
  const assert_held_matches_item = assert(() => {
    const h = held.get();
    return h !== null && equals(doList.items[5], h);
  });
  const assert_held_renamed = assert(() =>
    doList.items[5]?.title === "HeldRenamed"
  );
  // KEY: the held reference still DRIVES mutations after the update.
  const assert_done_via_held = assert(() => doList.items[5]?.done === true);
  const assert_removed_via_held = assert(() =>
    doList.itemCount === 5 &&
    doList.items.find((i: DoItem) => i.title === "HeldRenamed") === undefined
  );

  const assert_title_held_matches_item = assert(() => {
    const h = heldByTitle.get();
    return h !== null && equals(doList.items[5], h);
  });
  const assert_title_held_renamed = assert(() =>
    doList.items[5]?.title === "TitleHeldRenamed" &&
    doList.items[5]?.done === true
  );
  const assert_removed_via_title_held = assert(() =>
    doList.itemCount === 5 &&
    doList.items.find((i: DoItem) => i.title === "TitleHeldRenamed") ===
      undefined
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      // Initial empty
      { assertion: assert_initial_empty },
      { assertion: assert_initial_view },

      // Add three items
      { action: add_alpha },
      { action: add_beta },
      { action: add_gamma },
      { assertion: assert_three },
      { assertion: assert_titles },

      // Reference-addressed update (equals() identity)
      { action: done_first_by_ref },
      { assertion: assert_first_done },
      { action: rename_first_by_ref },
      { assertion: assert_first_renamed },
      { assertion: assert_others_untouched },

      // Title-addressed update (case-insensitive)
      { action: rename_beta_by_title },
      { assertion: assert_beta_renamed_done },

      // Title-addressed update hits ALL matching titles
      { action: add_dup },
      { action: add_dup },
      { assertion: assert_five },
      { action: done_all_dups_by_title },
      { assertion: assert_all_dups_done },

      // Held-reference survival: stash → reference-addressed update → the old
      // reference still matches and still drives done/remove.
      { action: add_held_target },
      { assertion: assert_six },
      { action: stash_held },
      { assertion: assert_held_matches_item },
      { action: rename_held_target },
      { assertion: assert_held_renamed },
      // KEY: the stale-but-once-valid reference still equals()-matches the
      // item AFTER updateItem patched it.
      { assertion: assert_held_matches_item },
      { action: done_via_held },
      { assertion: assert_done_via_held },
      { action: remove_via_held },
      { assertion: assert_removed_via_held },

      // Held-reference survival: stash → TITLE-addressed update → the old
      // reference still matches and still drives removal.
      { action: add_title_held_target },
      { assertion: assert_six },
      { action: stash_title_held },
      { assertion: assert_title_held_matches_item },
      { action: rename_title_held_by_title },
      { assertion: assert_title_held_renamed },
      { assertion: assert_title_held_matches_item },
      { action: remove_via_title_held },
      { assertion: assert_removed_via_title_held },

      // The completed section and its archive button
      { assertion: assert_completed_section },
      { action: archive_all },
      { assertion: assert_archived },

      // Removing a task removes the subtasks indented under it
      { action: add_trip_batch },
      { assertion: assert_trip_batch },
      { action: click_remove_plan_trip },
      { assertion: assert_trip_removed_with_subtasks },
      { action: add_errands_batch },
      { assertion: assert_errands_batch },
      { action: remove_errands_by_title },
      { assertion: assert_errands_removed_with_subtasks },

      // Attachments
      { action: attach_by_title },
      { assertion: assert_attached },
      { action: click_remove_attachment },
      { assertion: assert_attachment_removed },
      { action: drop_on_pack },
      { assertion: assert_attached },

      // Both add-item fields, and the compact view's archive button
      { action: submit_in_full_view },
      { action: submit_in_compact_view },
      { assertion: assert_submitted },
      { action: done_laundry },
      { action: archive_in_compact_view },
      { assertion: assert_archived_in_compact_view },
    ],
    doList,
    packingList,
  };
});
