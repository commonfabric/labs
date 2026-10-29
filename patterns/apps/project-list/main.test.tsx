/**
 * Test Pattern: Project List
 *
 * Exercises the toggle handler's identity contract (CT-1715):
 * - toggling flips `done` on the addressed item only
 * - held-reference survival: a reference stashed in a cell BEFORE a toggle
 *   must still `equals()`-match and still drive a subsequent
 *   equals()-located removal AFTER the toggle. The toggle writes through
 *   the element's cell; replacing the array slot with a fresh object
 *   literal would re-mint the item's entity identity and orphan every held
 *   reference.
 *
 * Run: deno task cf test patterns/apps/project-list/main.test.tsx --verbose
 */
import {
  action,
  assert,
  equals,
  handler,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import ProjectList, { toggleItem } from "./main.tsx";

interface ProjectItem {
  id: string;
  title: string;
  done: boolean;
}

// Seed the list with fresh literals so each item becomes an entity doc with
// its own identity (the same shape the pattern's addItem action produces).
const seedItems = handler<void, { items: Writable<ProjectItem[]> }>(
  (_event, { items }) => {
    items.push({ id: "a", title: "First", done: false });
    items.push({ id: "b", title: "Second", done: false });
  },
);

// Test plumbing: remove the item the held reference points at, locating it
// with equals() — proves a reference held across a toggle still drives
// operations (it would silently no-op if the toggle had re-minted the
// item's entity identity).
const removeHeldItem = handler<
  void,
  { items: Writable<ProjectItem[]>; held: Writable<ProjectItem> }
>((_event, { items, held }) => {
  const cur = items.get();
  const idx = cur.findIndex((i) => equals(held, i));
  if (idx >= 0) {
    items.set(cur.toSpliced(idx, 1));
  }
});

export default pattern(() => {
  const itemsCell = new Writable<ProjectItem[]>([]);
  const list = ProjectList({ items: itemsCell });

  // Simulates an external holder (selection cell) that read an item once
  // and keeps the reference across later mutations. Typed non-null
  // (placeholder initial value) so the cell can be bound as handler state.
  const heldItem = new Writable<ProjectItem>({
    id: "",
    title: "",
    done: false,
  });

  // ==========================================================================
  // Actions
  // ==========================================================================

  const action_seed = seedItems({ items: itemsCell });

  const action_stash_held = action(() => {
    const item = itemsCell.get()[0];
    if (item) heldItem.set(item);
  });

  // The REAL exported toggle handler, bound exactly as the row UI binds it.
  const action_toggle_first = toggleItem({ index: 0, items: itemsCell });

  const action_remove_via_held = removeHeldItem({
    items: itemsCell,
    held: heldItem,
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_seeded = assert(() => {
    const cur = itemsCell.get();
    return cur.length === 2 && cur[0]?.title === "First" &&
      cur[1]?.title === "Second";
  });

  const assert_held_stashed = assert(() => {
    const h = heldItem.get();
    return h.title === "First" && equals(itemsCell.get()[0], h);
  });

  const assert_first_done = assert(() => itemsCell.get()[0]?.done === true);
  const assert_second_untouched = assert(() =>
    itemsCell.get()[1]?.done === false
  );
  // KEY: the stale-but-once-valid reference still equals()-matches the item
  // AFTER the toggle updated it.
  const assert_held_survives_toggle = assert(() => {
    const h = heldItem.get();
    return equals(itemsCell.get()[0], h);
  });
  // The held reference also READS the update (it would show the stale,
  // orphaned entity if the toggle had re-minted identity).
  const assert_held_reads_toggle = assert(() => heldItem.get().done === true);

  const assert_toggled_back = assert(() => itemsCell.get()[0]?.done === false);

  // KEY: the held reference still DRIVES an equals()-located removal.
  const assert_removed_via_held = assert(() => {
    const cur = itemsCell.get();
    return cur.length === 1 && cur[0]?.title === "Second";
  });

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      { action: action_seed },
      { assertion: assert_seeded },

      // Held-reference survival: stash → toggle → the old reference still
      // matches, reads the update, and still drives removal.
      { action: action_stash_held },
      { assertion: assert_held_stashed },
      { action: action_toggle_first },
      { assertion: assert_first_done },
      { assertion: assert_second_untouched },
      { assertion: assert_held_survives_toggle },
      { assertion: assert_held_reads_toggle },

      // Toggling again flips back (still through the element's cell).
      { action: action_toggle_first },
      { assertion: assert_toggled_back },

      { action: action_remove_via_held },
      { assertion: assert_removed_via_held },
    ],
    list,
  };
});
