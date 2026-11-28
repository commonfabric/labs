/**
 * The fake catalog's own name and view: it names itself as the fake, and its
 * view counts the entries it holds, following them as they change.
 *
 * Run: deno task cf test patterns/system/pattern-catalog/fake-catalog.test.tsx --verbose
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { hasText } from "../../tools/test-support/vnode-helpers.ts";
import { type CatalogEntry } from "./pattern-catalog.tsx";
import { FakeCatalog } from "./fake-catalog.tsx";

const ENTRIES: CatalogEntry[] = [
  { patternId: "split-1", title: "Bill splitter", standalone: true },
  { patternId: "read-1", title: "Reading tracker", standalone: false },
  { patternId: "habit-1", title: "Habit tracker", standalone: true },
];

export default pattern(() => {
  const entries = new Writable<CatalogEntry[]>(ENTRIES);
  const catalog = FakeCatalog({ entries });
  const empty = FakeCatalog({});

  const assert_names_itself_the_fake = assert(() =>
    catalog[NAME] === "Pattern catalog (fake)"
  );
  const assert_view_counts_entries = assert(() =>
    hasText(catalog[UI], "3 patterns") && hasText(empty[UI], "0 patterns") &&
    !hasText(empty[UI], "3 patterns")
  );

  const action_drop_one = action(() => {
    entries.set(ENTRIES.slice(1));
  });
  const assert_view_follows_entries = assert(() =>
    hasText(catalog[UI], "2 patterns") && !hasText(catalog[UI], "3 patterns")
  );

  return {
    [TESTS]: [
      { assertion: assert_names_itself_the_fake },
      { assertion: assert_view_counts_entries },
      { action: action_drop_one },
      { assertion: assert_view_follows_entries },
    ],
  };
});
