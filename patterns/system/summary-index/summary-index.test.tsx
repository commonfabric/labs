/**
 * Test Pattern: the summary index
 *
 * The index lists the space's mentionable pieces that carry a summary. The
 * test puts pieces in the space, with and without a usable summary, and reads
 * the index back through its entries, its view, the view's filter, and its
 * search tool.
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
  findElement,
  hasText,
  setBound,
} from "../../tools/test-support/vnode-helpers.ts";
import SummaryIndex, {
  searchPattern,
  type SummarizablePiece,
} from "./summary-index.tsx";

export default pattern(() => {
  const mentionable = wish<Writable<SummarizablePiece[]>>({
    query: "#mentionable",
  }).result!;

  const recipe = new Writable<SummarizablePiece>({
    [NAME]: "Recipe",
    summary: "Pancakes for Sunday",
  });
  const groceries = new Writable<SummarizablePiece>({
    [NAME]: "Groceries",
    summary: "Eggs and flour",
  });
  const blank = new Writable<SummarizablePiece>({
    [NAME]: "Blank",
    summary: "   ",
  });
  const bare = new Writable<SummarizablePiece>({ [NAME]: "Bare" });

  const index = SummaryIndex({});

  const action_add_pieces = action(() => {
    mentionable.push(recipe);
    mentionable.push(groceries);
    mentionable.push(blank);
    mentionable.push(bare);
  });

  // A blank or missing summary leaves the piece out of the index.
  const assert_lists_summarized_pieces = assert(() =>
    index.entries.map((entry) => `${entry.name}: ${entry.summary}`).join(
      "|",
    ) === "Recipe: Pancakes for Sunday|Groceries: Eggs and flour"
  );
  const assert_view_counts_all = assert(() =>
    hasText(index[UI], "2 of 2 pieces") &&
    hasText(index[UI], "Pancakes for Sunday")
  );

  // The filter matches a summary or a name, ignoring case.
  const action_filter_by_summary = action(() =>
    setBound(findElement(index[UI], "cf-input"), "$value", " EGGS ")
  );
  const assert_filter_matches_summary = assert(() =>
    hasText(index[UI], "1 of 2 pieces") &&
    hasText(index[UI], "Eggs and flour") &&
    !hasText(index[UI], "Pancakes for Sunday")
  );
  const action_filter_by_name = action(() =>
    setBound(findElement(index[UI], "cf-input"), "$value", "recipe")
  );
  const assert_filter_matches_name = assert(() =>
    hasText(index[UI], "1 of 2 pieces") &&
    hasText(index[UI], "Pancakes for Sunday")
  );

  // The search tool, over the index's own entries as the index binds it.
  const entries = index.entries;
  const everything = searchPattern({ query: "  ", entries });
  const bySummary = searchPattern({ query: "FLOUR", entries });
  const byName = searchPattern({ query: "recipe", entries });
  const nothing = searchPattern({ query: "waffles", entries });
  const assert_blank_search_returns_all = assert(() => everything.length === 2);
  const assert_search_matches_summary_or_name = assert(() =>
    bySummary.map((entry) => entry.get().name).join() === "Groceries" &&
    byName.map((entry) => entry.get().name).join() === "Recipe" &&
    nothing.length === 0
  );

  return {
    [TESTS]: [
      { action: action_add_pieces },
      { assertion: assert_lists_summarized_pieces },
      { assertion: assert_view_counts_all },
      { action: action_filter_by_summary },
      { assertion: assert_filter_matches_summary },
      { action: action_filter_by_name },
      { assertion: assert_filter_matches_name },
      { assertion: assert_blank_search_returns_all },
      { assertion: assert_search_matches_summary_or_name },
    ],
    index,
  };
});
