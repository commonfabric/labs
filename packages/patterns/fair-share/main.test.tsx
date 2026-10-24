/**
 * Test Pattern: Fair Share — joinWithProfile identity preservation
 *
 * Exercises the exported joinWithProfile handler (the participant/roster
 * "join with your profile" idiom) against test-owned cells:
 * - joining as a new person pushes a {name, picture?} snapshot and selects
 *   them as "you" (myName)
 * - joining as an existing picture-less person BACKFILLS the picture
 * - the picture backfill must preserve the person's entity identity
 *   (CT-1715): it writes through the element's cell; replacing the array
 *   slot with a fresh object literal would re-mint the entity and orphan
 *   every previously-held reference (selection cells, rows read earlier)
 * - an existing picture is NOT overwritten by a later join
 * - held-reference survival: a reference stashed BEFORE the backfill still
 *   `equals()`-matches the person and still drives a subsequent
 *   equals()-located removal AFTER the backfill
 *
 * The full Fair Share pattern is not instantiated here: its UI resolves
 * `wish()` queries, and the ledger handler under test is module-scope state
 * bound, so the contract is exercised directly on the cells.
 *
 * Run: deno task cf test packages/patterns/fair-share/main.test.tsx --verbose
 */
import {
  action,
  assert,
  equals,
  FabricBytes,
  handler,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import { joinWithProfile } from "./main.tsx";

interface Person {
  name: string;
  picture?: FabricBytes;
  avatar?: string;
}

// Stand-ins for pictures: the ledger copies the bytes and never decodes them,
// so any distinct bytes will do.
const SMILE = [1, 1];
const FOX = [2, 2];
const CAT = [3, 3];

const bytesAre = (actual: FabricBytes | undefined, expected: number[]) =>
  actual?.slice().join() === expected.join();

const dee = (people: readonly Person[]) => people.find((p) => p.name === "Dee");

// Test plumbing: remove the person the held reference points at, locating it
// with equals() — proves a reference held across the picture backfill still
// drives operations (it would silently no-op if the backfill had re-minted
// the person's entity identity).
const removeHeldPerson = handler<
  void,
  { people: Writable<Person[]>; held: Writable<Person> }
>((_event, { people, held }) => {
  const cur = people.get();
  const idx = cur.findIndex((p) => equals(held, p));
  if (idx >= 0) {
    people.set(cur.toSpliced(idx, 1));
  }
});

export default pattern(() => {
  const peopleCell = new Writable<Person[]>([]);
  const myNameCell = new Writable<string>("");

  // Simulates an external holder (selection cell / balance row) that read a
  // person once and keeps the reference across later mutations. Typed
  // non-null (placeholder initial value) so the cell can be bound directly
  // as handler state.
  const held = new Writable<Person>({ name: "" });

  // ==========================================================================
  // Actions
  // ==========================================================================

  // Ann is added by hand first (no picture) — the backfill target. A profile
  // with no picture binds no `picture` at all.
  const action_join_ann_no_picture = joinWithProfile({
    people: peopleCell,
    myName: myNameCell,
    name: "Ann",
  });

  const action_stash_held = action(() => {
    const p = peopleCell.get()[0];
    if (p) held.set(p);
  });

  // Ann joins again with a profile picture — exercises the backfill branch.
  const action_join_ann_with_picture = joinWithProfile({
    people: peopleCell,
    myName: myNameCell,
    name: "Ann",
    picture: new FabricBytes(new Uint8Array(SMILE)),
  });

  // A later join must NOT clobber an existing picture snapshot.
  const action_join_ann_other_picture = joinWithProfile({
    people: peopleCell,
    myName: myNameCell,
    name: "Ann",
    picture: new FabricBytes(new Uint8Array(FOX)),
  });

  // New person with a picture — the push branch. Their avatar text is not
  // copied beside a picture.
  const action_join_bob = joinWithProfile({
    people: peopleCell,
    myName: myNameCell,
    name: "Bob",
    picture: new FabricBytes(new Uint8Array(CAT)),
    avatar: "🐱",
  });

  // New person with avatar text and no picture — the text is copied instead.
  const action_join_cy = joinWithProfile({
    people: peopleCell,
    myName: myNameCell,
    name: "Cy",
    avatar: " 🦊 ",
  });

  // Dee is added by hand, then joins with avatar text (backfilled), then with
  // a picture (backfilled beside the text, which the picture outranks).
  const action_add_dee = joinWithProfile({
    people: peopleCell,
    myName: myNameCell,
    name: "Dee",
  });
  const action_join_dee_with_text = joinWithProfile({
    people: peopleCell,
    myName: myNameCell,
    name: "Dee",
    avatar: "🐙",
  });
  const action_join_dee_with_other_text = joinWithProfile({
    people: peopleCell,
    myName: myNameCell,
    name: "Dee",
    avatar: "🦑",
  });
  const action_join_dee_with_picture = joinWithProfile({
    people: peopleCell,
    myName: myNameCell,
    name: "Dee",
    picture: new FabricBytes(new Uint8Array(FOX)),
  });

  const action_remove_via_held = removeHeldPerson({
    people: peopleCell,
    held,
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_ann_added = assert(() => {
    const cur = peopleCell.get();
    return cur.length === 1 && cur[0]?.name === "Ann" && !cur[0]?.picture;
  });
  const assert_my_name_ann = assert(() => myNameCell.get() === "Ann");

  const assert_held_stashed = assert(() => {
    const h = held.get();
    return h.name === "Ann" && equals(peopleCell.get()[0], h);
  });

  const assert_picture_backfilled = assert(() =>
    bytesAre(peopleCell.get()[0]?.picture, SMILE)
  );
  // KEY: the stale-but-once-valid reference still equals()-matches the
  // person AFTER the backfill wrote through the element's cell.
  const assert_held_survives_backfill = assert(() => {
    const h = held.get();
    return equals(peopleCell.get()[0], h);
  });
  // The held reference also READS the update (it would show the stale,
  // orphaned entity if the backfill had re-minted identity).
  const assert_held_reads_backfill = assert(() =>
    bytesAre(held.get().picture, SMILE)
  );

  const assert_picture_not_clobbered = assert(() =>
    bytesAre(peopleCell.get()[0]?.picture, SMILE)
  );

  const assert_bob_added_with_picture = assert(() => {
    const cur = peopleCell.get();
    return cur.length === 2 && cur[1]?.name === "Bob" &&
      bytesAre(cur[1]?.picture, CAT) && cur[1]?.avatar === undefined;
  });
  const assert_my_name_bob = assert(() => myNameCell.get() === "Bob");

  // KEY: the held reference still DRIVES an equals()-located removal.
  const assert_removed_via_held = assert(() => {
    const cur = peopleCell.get();
    return cur.length === 1 && cur[0]?.name === "Bob";
  });

  const assert_dee_text_backfilled = assert(() => {
    const d = dee(peopleCell.get());
    return d?.avatar === "🐙" && d.picture === undefined;
  });
  const assert_dee_picture_backfilled = assert(() => {
    const d = dee(peopleCell.get());
    return bytesAre(d?.picture, FOX) && d?.avatar === "🐙";
  });

  const assert_cy_added_with_avatar = assert(() => {
    const cur = peopleCell.get();
    return cur.length === 2 && cur[1]?.name === "Cy" &&
      cur[1]?.avatar === "🦊" && cur[1]?.picture === undefined;
  });

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      // Join as a new (picture-less) person
      { action: action_join_ann_no_picture },
      { assertion: assert_ann_added },
      { assertion: assert_my_name_ann },

      // Stash an external reference BEFORE the backfill
      { action: action_stash_held },
      { assertion: assert_held_stashed },

      // Picture backfill preserves identity
      { action: action_join_ann_with_picture },
      { assertion: assert_picture_backfilled },
      { assertion: assert_held_survives_backfill },
      { assertion: assert_held_reads_backfill },

      // Existing picture is not overwritten
      { action: action_join_ann_other_picture },
      { assertion: assert_picture_not_clobbered },

      // New person push branch
      { action: action_join_bob },
      { assertion: assert_bob_added_with_picture },
      { assertion: assert_my_name_bob },

      // The held reference still drives removal after the backfill
      { action: action_remove_via_held },
      { assertion: assert_removed_via_held },

      // Avatar text stands in for a missing picture
      { action: action_join_cy },
      { assertion: assert_cy_added_with_avatar },

      // Avatar text is backfilled, not overwritten; a picture is backfilled
      // beside it
      { action: action_add_dee },
      { action: action_join_dee_with_text },
      { assertion: assert_dee_text_backfilled },
      { action: action_join_dee_with_other_text },
      { assertion: assert_dee_text_backfilled },
      { action: action_join_dee_with_picture },
      { assertion: assert_dee_picture_backfilled },
    ],
    peopleCell,
  };
});
