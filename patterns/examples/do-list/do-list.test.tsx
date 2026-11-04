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
 *
 * Run: deno task cf test patterns/examples/do-list/do-list.test.tsx --verbose
 */
import { action, assert, equals, pattern, TESTS, Writable } from "commonfabric";
import DoList, { type DoItem } from "./do-list.tsx";

export default pattern(() => {
  const doList = DoList({});

  // Simulates an external holder (selection cell / attachment source) that
  // read an item once and keeps the reference across later mutations.
  const held = new Writable<DoItem | null>(null);
  const heldByTitle = new Writable<DoItem | null>(null);

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
  const add_dup_a = action(() => {
    doList.addItem.send({ title: "Dup" });
  });
  const add_dup_b = action(() => {
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

  // ==========================================================================
  // Assertions
  // ==========================================================================

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
  const assert_held_stashed = assert(() => {
    const h = held.get();
    return h !== null && equals(doList.items[5], h);
  });
  const assert_held_renamed = assert(() =>
    doList.items[5]?.title === "HeldRenamed"
  );
  // KEY: the stale-but-once-valid reference still equals()-matches the item
  // AFTER updateItem patched it.
  const assert_held_survives_update = assert(() => {
    const h = held.get();
    return h !== null && equals(doList.items[5], h);
  });
  // KEY: the held reference still DRIVES mutations after the update.
  const assert_done_via_held = assert(() => doList.items[5]?.done === true);
  const assert_removed_via_held = assert(() =>
    doList.itemCount === 5 &&
    doList.items.find((i: DoItem) => i.title === "HeldRenamed") === undefined
  );

  // Held-reference survival (title-addressed update).
  const assert_six_again = assert(() => doList.itemCount === 6);
  const assert_title_held_stashed = assert(() => {
    const h = heldByTitle.get();
    return h !== null && equals(doList.items[5], h);
  });
  const assert_title_held_renamed = assert(() =>
    doList.items[5]?.title === "TitleHeldRenamed" &&
    doList.items[5]?.done === true
  );
  const assert_title_held_survives_update = assert(() => {
    const h = heldByTitle.get();
    return h !== null && equals(doList.items[5], h);
  });
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
      { action: add_dup_a },
      { action: add_dup_b },
      { assertion: assert_five },
      { action: done_all_dups_by_title },
      { assertion: assert_all_dups_done },

      // Held-reference survival: stash → reference-addressed update → the old
      // reference still matches and still drives done/remove.
      { action: add_held_target },
      { assertion: assert_six },
      { action: stash_held },
      { assertion: assert_held_stashed },
      { action: rename_held_target },
      { assertion: assert_held_renamed },
      { assertion: assert_held_survives_update },
      { action: done_via_held },
      { assertion: assert_done_via_held },
      { action: remove_via_held },
      { assertion: assert_removed_via_held },

      // Held-reference survival: stash → TITLE-addressed update → the old
      // reference still matches and still drives removal.
      { action: add_title_held_target },
      { assertion: assert_six_again },
      { action: stash_title_held },
      { assertion: assert_title_held_stashed },
      { action: rename_title_held_by_title },
      { assertion: assert_title_held_renamed },
      { assertion: assert_title_held_survives_update },
      { action: remove_via_title_held },
      { assertion: assert_removed_via_title_held },
    ],
    doList,
  };
});
