/**
 * Regression test: CT-1639 — equals()-based list removal must work when the
 * array type carries `Default<[]>`.
 *
 * `equals(item, el)` is the documented list-removal idiom. It only works when
 * the transformer annotates the array's ITEMS as `asCell: ["comparable"]` in
 * the handler context schema, so `cell.get()` returns link-carrying elements
 * that equals() can match. CT-1639: a `Writable<Item[] | Default<[]>>` type
 * silently stripped that `comparable` annotation, so findIndex(equals) always
 * returned -1 and the removal no-oped — no type error, no runtime error, just
 * silent data loss (the × button "did nothing").
 *
 * This guards the RUNTIME behavior end-to-end (the existing schema-generator
 * test pins the emitted `comparable` annotation; this proves the removal
 * actually lands). The sensitivity case proves the match relies on comparable
 * link identity, not value equality.
 *
 * Run: deno task cf test patterns/dev/regression/ct1639-equals-removal.test.tsx
 */
import {
  assert,
  Default,
  equals,
  handler,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";

interface Item {
  label: string;
}

// The CT-1639 idiom: locate an element by equals() against a `.get()` element
// and splice it out. `which` rides in the handler context so the test can bind
// it without a synthetic event.
const removeAt = handler<
  void,
  { items: Writable<Item[] | Default<[]>>; which: number }
>(
  (_event, { items, which }) => {
    const cur = items.get();
    const target = cur[which];
    const idx = cur.findIndex((el) => equals(target, el));
    if (idx >= 0) items.set(cur.toSpliced(idx, 1));
  },
);

// Sensitivity guard: a freshly-constructed plain object carries no link, so
// equals() must NOT match any comparable element — removal is a no-op. This
// proves the positive case below matches via comparable link identity, not by
// structural value equality (which would mask a comparable regression).
const removeByPlainValue = handler<
  void,
  { items: Writable<Item[] | Default<[]>>; label: string }
>(
  (_event, { items, label }) => {
    const cur = items.get();
    const target = { label };
    const idx = cur.findIndex((el) => equals(target, el));
    if (idx >= 0) items.set(cur.toSpliced(idx, 1));
  },
);

interface ReproState {
  items: Writable<Item[] | Default<[]>>;
}

const Repro = pattern<ReproState>(({ items }) => ({ items }));

export default pattern(() => {
  const itemsCell = new Writable<Item[]>([
    { label: "a" },
    { label: "b" },
    { label: "c" },
  ]);
  const repro = Repro({ items: itemsCell });

  const assertStartsThree = assert(() => repro.items.length === 3);

  // Remove the middle item ("b") via equals()-located findIndex.
  const removeMiddle = removeAt({ items: itemsCell, which: 1 });
  const assertTwoAfterRemove = assert(() => repro.items.length === 2);
  const assertMiddleGone = assert(() =>
    repro.items.findIndex((i: Item) => i.label === "b") === -1
  );
  const assertEndsRemain = assert(() =>
    repro.items[0]?.label === "a" && repro.items[1]?.label === "c"
  );

  // Removing by a linkless plain value must NOT match → "a" stays.
  const removeByValue = removeByPlainValue({ items: itemsCell, label: "a" });
  const assertPlainValueNoops = assert(() =>
    repro.items.findIndex((i: Item) => i.label === "a") !== -1
  );

  return {
    [TESTS]: [
      { assertion: assertStartsThree },
      { action: removeMiddle },
      { assertion: assertTwoAfterRemove },
      { assertion: assertMiddleGone },
      { assertion: assertEndsRemain },
      { action: removeByValue },
      { assertion: assertPlainValueNoops },
    ],
  };
});
