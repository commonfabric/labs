/**
 * Test Pattern: the pattern catalog contract, against the fake catalog
 *
 * A catalog answers `page` in the caller's own cell, filtered by text or the
 * whole window for blank text, and says why when it is unavailable. A get
 * request reaches it only through `GetItButton`: a tap appends one request
 * carrying the button's target, the catalog's answer shows on the button,
 * and a button with no target appends nothing. An unavailable catalog says
 * why on a button with no answer yet. The query helpers find an
 * entry by id and filter the window by text.
 *
 * Run: deno task cf test patterns/system/pattern-catalog/pattern-catalog.test.tsx --verbose
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  clickButton,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import {
  type CatalogEntry,
  type CatalogPage,
  type CatalogStatus,
  entryOf,
  GetItButton,
  searchEntries,
} from "./pattern-catalog.tsx";
import { FakeCatalog } from "./fake-catalog.tsx";

const ENTRIES: CatalogEntry[] = [
  {
    patternId: "split-1",
    title: "Bill splitter",
    blurb: "Split a dinner bill between friends",
    tags: ["money"],
    quality: "proven",
  },
  {
    patternId: "read-1",
    title: "Reading tracker",
    blurb: "Books you are reading",
    tags: ["books"],
  },
];

export default pattern(() => {
  const entries = new Writable<CatalogEntry[]>(ENTRIES);
  const status = new Writable<CatalogStatus>({ state: "ready" });
  const catalog = FakeCatalog({ entries, status });

  const searched = new Writable<CatalogPage | null>(null);
  const listed = new Writable<CatalogPage | null>(null);
  const refused = new Writable<CatalogPage | null>(null);

  const button = GetItButton({
    catalog,
    patternId: "split-1",
    target: "board-a",
  });
  const missing = GetItButton({
    catalog,
    patternId: "gone-1",
    target: "board-a",
  });
  const untargeted = GetItButton({
    catalog,
    patternId: "split-1",
    target: "",
  });

  const action_search = action(() => {
    catalog.page.send({ text: " MONEY ", result: searched });
    catalog.page.send({ text: "  ", result: listed });
  });
  const assert_search_answers_in_callers_cell = assert(() =>
    searched.get()?.entries.map((e) => e.patternId).join() === "split-1" &&
    searched.get()?.status.state === "ready"
  );
  const assert_blank_text_lists_the_window = assert(() =>
    listed.get()?.entries.length === 2
  );

  const action_tap_get_it = action(() => {
    clickButton(button[UI], "Get it");
    clickButton(missing[UI], "Get it");
  });
  const assert_tap_appends_one_targeted_request = assert(() => {
    const requests = catalog.getRequests.get();
    const ids = requests.map((r) => `${r.patternId}@${r.target}`).sort();
    return ids.join() === "gone-1@board-a,split-1@board-a";
  });
  const assert_unanswered_until_the_catalog_acts = assert(() =>
    button.answer === null && hasText(button[UI], "Get it") &&
    !hasText(button[UI], "Added")
  );

  const action_catalog_answers = action(() => {
    catalog.answerGetRequests.send();
  });
  const assert_answer_shows_on_the_button = assert(() =>
    button.answer?.state === "placed" && hasText(button[UI], "Added") &&
    missing.answer?.state === "failed" &&
    hasText(missing[UI], "no such pattern")
  );

  const action_tap_without_target = action(() => {
    clickButton(untargeted[UI], "Get it");
  });
  const assert_no_target_appends_nothing = assert(() =>
    catalog.getRequests.get().length === 2
  );

  const action_go_unavailable = action(() => {
    status.set({
      state: "unavailable",
      reason: "This instance is not enrolled",
      remedy: "loom index enroll",
    });
    catalog.page.send({ text: "money", result: refused });
  });
  const assert_unavailable_answers_with_reason = assert(() =>
    refused.get()?.status.state === "unavailable" &&
    refused.get()?.entries.length === 0 &&
    hasText(untargeted[UI], "This instance is not enrolled") &&
    // A request already answered keeps showing its answer.
    hasText(button[UI], "Added")
  );

  const found = entryOf({ entries, patternId: "read-1" });
  const absent = entryOf({ entries, patternId: "nope" });
  const filtered = searchEntries({ entries, text: "BOOKS" });
  const everything = searchEntries({ entries, text: " " });
  const assert_query_helpers = assert(() =>
    found?.title === "Reading tracker" && absent === undefined &&
    filtered.map((e) => e.patternId).join() === "read-1" &&
    everything.length === 2
  );

  return {
    [TESTS]: [
      { action: action_search },
      { assertion: assert_search_answers_in_callers_cell },
      { assertion: assert_blank_text_lists_the_window },
      { action: action_tap_get_it },
      { assertion: assert_tap_appends_one_targeted_request },
      { assertion: assert_unanswered_until_the_catalog_acts },
      { action: action_catalog_answers },
      { assertion: assert_answer_shows_on_the_button },
      { action: action_tap_without_target },
      { assertion: assert_no_target_appends_nothing },
      { action: action_go_unavailable },
      { assertion: assert_unavailable_answers_with_reason },
      { assertion: assert_query_helpers },
    ],
    catalog,
  };
});
