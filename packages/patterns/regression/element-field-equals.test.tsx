/**
 * Regression test: a handler comparing a cell field of a list element with
 * `.equals()` must receive the element whole.
 *
 * `entries.get().find((entry) => entry.item.equals(item))` compares the
 * `item` cell held in each element. The transformer narrows the handler's
 * state to what the body uses, and once read that narrowing as "the elements
 * themselves are only compared", so every element arrived as an opaque value
 * whose `item` read `undefined`, and the handler threw
 * `Cannot read properties of undefined (reading 'equals')` though the pattern
 * type-checked. The same comparison inside a helper function, or through
 * `equals(entry.item, item)`, was unaffected.
 *
 * The handler also reads the matched element's `note`, so the step fails as
 * well if the element arrives without its plain fields. The second event names
 * a cell the list does not hold whose value equals one it does, which proves
 * the match rests on the cell's link identity rather than on its value.
 *
 * Run: deno task cf test packages/patterns/regression/element-field-equals.test.tsx
 */
import { assert, handler, pattern, TESTS, Writable } from "commonfabric";

interface Item {
  name: string;
}

interface Entry {
  item: Writable<Item>;
  note: string;
}

const addEntry = handler<
  { item: Writable<Item>; note: string },
  { entries: Writable<Entry[]> }
>(({ item, note }, { entries }) => {
  entries.push({ item, note });
});

const recordMatch = handler<
  { item: Writable<Item> },
  { entries: Writable<Entry[]>; found: Writable<string> }
>(({ item }, { entries, found }) => {
  const entry = entries.get().find((candidate) => candidate.item.equals(item));
  found.set(entry ? entry.note : "missing");
});

export default pattern(() => {
  const first = new Writable<Item>({ name: "a" });
  const second = new Writable<Item>({ name: "b" });
  const lookalike = new Writable<Item>({ name: "b" });
  const entries = new Writable<Entry[]>([]);
  const found = new Writable<string>("");
  const add = addEntry({ entries });
  const match = recordMatch({ entries, found });

  const assertSecondMatched = assert(() => found.get() === "second note");
  const assertLookalikeMissing = assert(() => found.get() === "missing");

  return {
    [TESTS]: [
      { action: add, event: { item: first, note: "first note" } },
      { action: add, event: { item: second, note: "second note" } },
      { action: match, event: { item: second } },
      { assertion: assertSecondMatched },
      { action: match, event: { item: lookalike } },
      { assertion: assertLookalikeMissing },
    ],
  };
});
