/**
 * Lists a fixed set of summary index entries in the browser the tester shows,
 * filters them by name and by summary, and loads the tester itself in a test
 * space, which has no summary index.
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
import type { SummarizablePiece } from "../../system/summary-index/summary-index.tsx";
import {
  childNodes,
  countElements,
  findElement,
  hasText,
  readValue,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import SummaryIndexTester, {
  SummaryIndexBrowser,
} from "./summary-index-tester.tsx";

/**
 * The text of each row the view lists. A row's name is a link to its piece,
 * which carries no text, so the text is the entry's summary.
 */
const rowSummaries = (root: unknown): string[] => {
  const rows: string[] = [];
  const walk = (node: unknown): void => {
    if (findElement(node, "tr") === node) rows.push(textContent(node));
    else childNodes(node).forEach((child) => walk(readValue(child)));
  };
  walk(readValue(findElement(root, "tbody")));
  return rows;
};

export default pattern(() => {
  const groceries = new Writable<SummarizablePiece>({
    [NAME]: "Groceries",
    summary: "Milk, eggs and bread",
  });
  const trip = new Writable<SummarizablePiece>({
    [NAME]: "Trip plan",
    summary: "Train to the coast",
  });
  const query = new Writable("");
  const browser = SummaryIndexBrowser({
    entries: [
      { piece: groceries, name: "Groceries", summary: "Milk, eggs and bread" },
      { piece: trip, name: "Trip plan", summary: "Train to the coast" },
    ],
    query,
  });
  const tester = SummaryIndexTester({});

  const assert_named_and_counts_every_entry = assert(() =>
    browser[NAME] === "Summary Index Tester" &&
    hasText(browser[UI], "Index: 2 entries") &&
    hasText(browser[UI], "Showing 2 results")
  );
  const assert_lists_every_entry_with_its_piece = assert(() =>
    rowSummaries(browser[UI]).join() ===
      "Milk, eggs and bread,Train to the coast" &&
    countElements(browser[UI], "cf-cell-link") === 2
  );

  const action_search_summary = action(() => query.set("  COAST "));
  const assert_lists_the_summary_match = assert(() =>
    rowSummaries(browser[UI]).join() === "Train to the coast" &&
    hasText(browser[UI], "Showing 1 results") &&
    hasText(browser[UI], "Index: 2 entries")
  );

  const action_search_name = action(() => query.set("grocer"));
  const assert_lists_the_name_match = assert(() =>
    rowSummaries(browser[UI]).join() === "Milk, eggs and bread"
  );

  const action_search_nothing = action(() => query.set("zebra"));
  const assert_lists_nothing = assert(() =>
    rowSummaries(browser[UI]).length === 0 &&
    hasText(browser[UI], "Showing 0 results")
  );

  const action_clear_search = action(() => query.set(""));

  const assert_tester_lists_nothing_without_an_index = assert(() =>
    tester[NAME] === "Summary Index Tester" &&
    hasText(tester[UI], "Index: 0 entries") &&
    rowSummaries(tester[UI]).length === 0
  );

  return {
    [TESTS]: [
      { assertion: assert_named_and_counts_every_entry },
      { assertion: assert_lists_every_entry_with_its_piece },

      { action: action_search_summary },
      { assertion: assert_lists_the_summary_match },

      { action: action_search_name },
      { assertion: assert_lists_the_name_match },

      { action: action_search_nothing },
      { assertion: assert_lists_nothing },

      { action: action_clear_search },
      { assertion: assert_named_and_counts_every_entry },

      { assertion: assert_tester_lists_nothing_without_an_index },
    ],
    browser,
    tester,
  };
});
