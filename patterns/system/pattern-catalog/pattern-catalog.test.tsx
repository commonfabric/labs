/**
 * The pattern catalog contract, against the fake catalog.
 *
 * A catalog answers `page` in the caller's own cell, filtered by text or the
 * whole window for blank text, and says why when it is unavailable. A request
 * to get a pattern is appended only by a trusted tap on `GetItButton`: a
 * forged push and an untrusted send leave the list alone, a second tap while
 * a request is open adds nothing, and a failed request can be tapped again.
 * The host's answer shows on the button.
 *
 * Run: deno task cf test patterns/system/pattern-catalog/pattern-catalog.test.tsx --verbose
 */
import {
  action,
  assert,
  handler,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { hasText } from "../../tools/test-support/vnode-helpers.ts";
import {
  type CatalogEntry,
  type CatalogPage,
  type CatalogStatus,
  GET_IT_ACTION,
  GET_IT_SURFACE,
  GetItButton,
  type GetItRequest,
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

const TRUSTED_TAP = { surface: GET_IT_SURFACE, action: GET_IT_ACTION };

/** A pattern that tries to add a request without the button. */
const forgeRequest = handler<void, { getItRequests: Writable<GetItRequest[]> }>(
  (_, { getItRequests }) => {
    getItRequests.push({
      requestId: "forged",
      patternId: "split-1",
      destination: "board-b",
    });
  },
);

export default pattern(() => {
  const entries = new Writable<CatalogEntry[]>(ENTRIES);
  const status = new Writable<CatalogStatus>({ state: "ready" });
  const catalog = FakeCatalog({ entries, status });

  const searched = new Writable<CatalogPage | null>(null);
  const listed = new Writable<CatalogPage | null>(null);
  const refused = new Writable<CatalogPage | null>(null);

  const split = GetItButton({
    catalog,
    patternId: "split-1",
    destination: "board-a",
  });
  const missing = GetItButton({
    catalog,
    patternId: "gone-1",
    destination: "board-a",
  });
  const nowhere = GetItButton({
    catalog,
    patternId: "read-1",
    destination: "",
  });
  const later = GetItButton({
    catalog,
    patternId: "read-1",
    destination: "board-a",
  });
  const forge = forgeRequest({ getItRequests: catalog.getItRequests });

  const action_page = action(() => {
    catalog.page.send({ text: " MONEY ", result: searched });
    catalog.page.send({ text: "  ", result: listed });
  });
  const assert_page_answers_in_callers_cell = assert(() =>
    searched.get()?.entries.map((e) => e.patternId).join() === "split-1" &&
    searched.get()?.status.state === "ready" &&
    listed.get()?.entries.length === 2
  );

  const action_forge = action(() => {
    forge.send();
    split.getIt.send();
  });
  const assert_forged_and_untrusted_writes_refused = assert(() =>
    catalog.getItRequests.length === 0
  );

  const assert_untapped_shows_nothing = assert(() =>
    split.answer === null && !hasText(split[UI], "Getting it")
  );

  const assert_tap_appends_one_request = assert(() =>
    catalog.getItRequests.length === 2 &&
    catalog.getItRequests.map((r) => `${r.patternId}@${r.destination}`)
        .sort().join() === "gone-1@board-a,split-1@board-a" &&
    new Set(catalog.getItRequests.map((r) => r.requestId)).size === 2
  );
  const assert_open_request_shows = assert(() =>
    split.answer?.state === "started" && hasText(split[UI], "Getting it…")
  );
  const assert_second_tap_while_open_adds_nothing = assert(() =>
    catalog.getItRequests.length === 2
  );

  const action_host_answers = action(() => {
    catalog.answerGetItRequests.send();
  });
  const assert_answers_show_on_buttons = assert(() =>
    split.answer?.state === "placed" && hasText(split[UI], "Got it") &&
    split.answer?.placed === "board-a/split-1" &&
    missing.answer?.state === "failed" &&
    hasText(missing[UI], "Couldn't get it: no such pattern")
  );

  const assert_placed_tap_adds_nothing_failed_tap_retries = assert(() =>
    catalog.getItRequests.length === 3 &&
    catalog.getItRequests.filter((r) => r.patternId === "gone-1").length ===
      2 &&
    missing.answer?.state === "started"
  );

  const assert_nowhere_says_why_and_adds_nothing = assert(() =>
    hasText(nowhere[UI], "There is nowhere to put it") &&
    catalog.getItRequests.length === 3
  );

  const action_go_unavailable = action(() => {
    status.set({
      state: "unavailable",
      reason: "This instance is not enrolled",
      remedy: "loom index enroll",
    });
    catalog.page.send({ text: "money", result: refused });
  });
  const assert_unavailable_says_why = assert(() =>
    refused.get()?.status.state === "unavailable" &&
    refused.get()?.entries.length === 0 &&
    hasText(later[UI], "This instance is not enrolled") &&
    catalog.getItRequests.length === 3
  );

  return {
    [TESTS]: [
      { action: action_page },
      { assertion: assert_page_answers_in_callers_cell },
      { action: action_forge },
      { assertion: assert_forged_and_untrusted_writes_refused },
      { assertion: assert_untapped_shows_nothing },
      { action: split.getIt, trustedUi: TRUSTED_TAP },
      { action: missing.getIt, trustedUi: TRUSTED_TAP },
      { assertion: assert_tap_appends_one_request },
      { assertion: assert_open_request_shows },
      { action: split.getIt, trustedUi: TRUSTED_TAP },
      { assertion: assert_second_tap_while_open_adds_nothing },
      { action: action_host_answers },
      { assertion: assert_answers_show_on_buttons },
      { action: split.getIt, trustedUi: TRUSTED_TAP },
      { action: missing.getIt, trustedUi: TRUSTED_TAP },
      { assertion: assert_placed_tap_adds_nothing_failed_tap_retries },
      { action: nowhere.getIt, trustedUi: TRUSTED_TAP },
      { assertion: assert_nowhere_says_why_and_adds_nothing },
      { action: action_go_unavailable },
      { action: later.getIt, trustedUi: TRUSTED_TAP },
      { assertion: assert_unavailable_says_why },
    ],
    // The forged push and the untrusted send are refused, and the runtime
    // warns as it drops them.
    allowConsoleWarnings: true,
    catalog,
  };
});
