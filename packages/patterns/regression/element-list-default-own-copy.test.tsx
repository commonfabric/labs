/**
 * Each element a parent passes to a child, without a field the child defaults
 * to a list, gets a list of its own: tagging the first element leaves the
 * second untagged.
 *
 * The child's argument is filled with its defaults in one merge, and the merge
 * fills every element from the one default it holds for the item schema. Were
 * that one list placed at both elements, the argument write would store the
 * second element's list as a link to the first's, and the two lists would be
 * one.
 *
 * Run: deno task cf test packages/patterns/regression/element-list-default-own-copy.test.tsx
 */
import {
  action,
  assert,
  type Default,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";

interface Item {
  name: string;
  tags?: string[] | Default<[]>;
}

interface ListInput {
  items?: Writable<Item[] | Default<[]>>;
}

interface ListOutput {
  items: Writable<Item[]>;
}

const List = pattern<ListInput, ListOutput>(({ items }) => ({ items }));

export default pattern(() => {
  const list = List({ items: [{ name: "a" }, { name: "b" }] });

  const tagFirst = action(() => list.items.key(0).key("tags").push("x"));

  const assertFirstTagged = assert(() =>
    (list.items.get()[0].tags ?? []).length === 1
  );
  const assertSecondUntagged = assert(() =>
    (list.items.get()[1].tags ?? []).length === 0
  );

  return {
    [TESTS]: [
      { action: tagFirst },
      { assertion: assertFirstTagged },
      { assertion: assertSecondUntagged },
    ],
  };
});
