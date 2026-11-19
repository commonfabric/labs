/**
 * The pattern catalog contract, against the fake catalog.
 *
 * A catalog answers `page` in the caller's own cell, filtered by text or the
 * whole window for blank text, and says why when it is unavailable. A request
 * to get a pattern is appended only by a trusted tap on `GetItButton`: a
 * forged push and an untrusted send leave the list alone, a second tap while
 * a request is open adds nothing, and a failed request can be tapped again.
 * The host's answer shows on the button. A request names the host and the
 * time of its tap, a host leaves a request naming another host alone, and
 * with no host or no pattern id the button says so and adds nothing. The button names the
 * pattern by the catalog's own title for its id, whatever text a caller
 * passes, and the place it installs onto by the name the caller gives.
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
import {
  countElements,
  findElement,
  hasText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import {
  CatalogByline,
  type CatalogEntry,
  type CatalogPage,
  type CatalogProfile,
  type CatalogStatus,
  GET_IT_ACTION,
  GET_IT_SURFACE,
  GetItButton,
  type GetItButtonInput,
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

/** What the button `ui` asks `cf-pattern-install` to show. */
const installShows = (ui: unknown) => {
  const install = findElement(ui, "cf-pattern-install");
  return {
    patternId: propValue(install, "patternId"),
    patternTitle: propValue(install, "patternTitle"),
    destinationName: propValue(install, "destinationName"),
  };
};

/** A pattern that tries to add a request without the button. */
const forgeRequest = handler<void, { getItRequests: Writable<GetItRequest[]> }>(
  (_, { getItRequests }) => {
    getItRequests.push({
      requestId: "forged",
      patternId: "split-1",
      destination: "board-b",
      requestedAt: 0,
      host: "fake-host",
    });
  },
);

export default pattern(() => {
  const entries = new Writable<CatalogEntry[]>(ENTRIES);
  const status = new Writable<CatalogStatus>({ state: "ready" });
  const host = new Writable<string>("fake-host");
  const catalog = FakeCatalog({ entries, status, host });

  const searched = new Writable<CatalogPage | null>(null);
  const listed = new Writable<CatalogPage | null>(null);
  const refused = new Writable<CatalogPage | null>(null);

  const split = GetItButton({
    catalog,
    patternId: "split-1",
    destination: "board-a",
    destinationName: "Home",
  });
  const missing = GetItButton({
    catalog,
    patternId: "gone-1",
    destination: "board-a",
  });
  const nameless = GetItButton({
    catalog,
    patternId: "",
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
  const swapped = GetItButton({
    catalog,
    patternId: "read-1",
    destination: "board-b",
  });
  // A caller that passes text of its own for the button, which no longer
  // takes any.
  const posing = GetItButton({
    catalog,
    patternId: "read-1",
    destination: "board-c",
    label: "Bill splitter",
  } as GetItButtonInput);
  const forge = forgeRequest({ getItRequests: catalog.getItRequests });

  const samProfile: CatalogProfile = new Writable<Record<string, never>>({});
  const anonymous = CatalogByline({
    entry: {
      patternId: "habit-2",
      title: "Habit tracker",
      author: "a-3kf9q2xxxxx",
      authorTier: 4,
      remixOf: [
        { patternId: "habit-1", title: "Habit   tracker\n" },
        { patternId: "log-1" },
        { unavailable: true },
        { patternId: "beyond-1", title: "Past the end" },
      ],
    },
  });
  const named = CatalogByline({
    entry: {
      patternId: "habit-3",
      title: "Habit tracker",
      author: "a-7hh2m0xxxxx",
      authorTier: 6,
      authorProfile: samProfile,
    },
  });
  const plain = CatalogByline({
    entry: { patternId: "plain-1", title: "Plain" },
  });
  const takenDown = CatalogByline({
    entry: {
      patternId: "remix-9",
      title: "Remix",
      remixOf: [{ unavailable: true }, {
        patternId: "behind-1",
        title: "Hidden",
      }],
    },
  });
  const malformed = CatalogByline({
    entry: {
      patternId: "remix-8",
      title: "Remix",
      remixOf: [
        { patternId: "", title: "No id" },
        { patternId: "behind-2", title: "Hidden" },
      ],
    },
  });
  const changing = new Writable<CatalogEntry>({
    patternId: "habit-4",
    title: "Habit tracker",
    author: "a-9zz1q0xxxxx",
  });
  const unpublished = CatalogByline({ entry: changing });

  const action_page = action(() => {
    catalog.page.send({ text: " MONEY ", result: searched });
    catalog.page.send({ text: "  ", result: listed });
  });
  const assert_page_answers_in_callers_cell = assert(() =>
    searched.get()?.entries.map((e) => e.patternId).join() === "split-1" &&
    searched.get()?.status.state === "ready" &&
    listed.get()?.entries.length === 2
  );

  const assert_button_names_catalog_title_and_destination = assert(() => {
    const split_ = installShows(split[UI]);
    const posing_ = installShows(posing[UI]);
    const missing_ = installShows(missing[UI]);
    return split_.patternId === "split-1" &&
      split_.patternTitle === "Bill splitter" &&
      split_.destinationName === "Home" &&
      posing_.patternTitle === "Reading tracker" &&
      missing_.patternId === "gone-1" && missing_.patternTitle === "" &&
      missing_.destinationName === undefined;
  });

  const assert_anonymous_shows_pseudonym_only = assert(() =>
    hasText(anonymous[UI], "by a-3kf9q2xxxxx · credibility 4 of 9") &&
    countElements(anonymous[UI], "cf-profile-badge") === 0
  );
  const assert_named_shows_profile_not_pseudonym = assert(() =>
    countElements(named[UI], "cf-profile-badge") === 1 &&
    !hasText(named[UI], "a-7hh2m0xxxxx") && !hasText(named[UI], "credibility")
  );
  const assert_remix_chain_stops_at_what_viewer_cannot_see = assert(() =>
    hasText(
      anonymous[UI],
      "Remix of “Habit tracker”, a remix of an untitled pattern, a remix of a pattern that's no longer available",
    ) && !hasText(anonymous[UI], "log-1") &&
    !hasText(anonymous[UI], "Past the end") &&
    !hasText(anonymous[UI], "beyond-1")
  );
  const assert_unavailable_first_step_hides_the_rest = assert(() =>
    hasText(takenDown[UI], "Remix of a pattern that's no longer available") &&
    !hasText(takenDown[UI], "Hidden") && !hasText(takenDown[UI], "behind-1") &&
    hasText(malformed[UI], "Remix of a pattern that's no longer available") &&
    !hasText(malformed[UI], "No id") && !hasText(malformed[UI], "Hidden")
  );
  const action_publish = action(() => {
    changing.set({
      patternId: "habit-4",
      title: "Habit tracker",
      author: "a-9zz1q0xxxxx",
      authorProfile: samProfile,
      remixOf: [{ patternId: "habit-1", title: "Habit tracker" }],
    });
  });
  const assert_named_remix_shows_both = assert(() =>
    countElements(unpublished[UI], "cf-profile-badge") === 1 &&
    !hasText(unpublished[UI], "a-9zz1q0xxxxx") &&
    hasText(unpublished[UI], "Remix of “Habit tracker”")
  );
  const action_unpublish = action(() => {
    changing.set({
      patternId: "habit-4",
      title: "Habit tracker",
      author: "a-9zz1q0xxxxx",
    });
  });
  const assert_unpublished_drops_badge_and_remix = assert(() =>
    countElements(unpublished[UI], "cf-profile-badge") === 0 &&
    hasText(unpublished[UI], "by a-9zz1q0xxxxx") &&
    !hasText(unpublished[UI], "Remix")
  );
  const assert_not_a_remix_says_nothing = assert(() =>
    !hasText(plain[UI], "Remix") && !hasText(plain[UI], "by ") &&
    countElements(plain[UI], "cf-profile-badge") === 0
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
    hasText(nameless[UI], "There is no pattern to get") &&
    propValue(findElement(nameless[UI], "cf-pattern-install"), "disabled") ===
      true &&
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
    hasText(later[UI], "loom index enroll") &&
    catalog.getItRequests.length === 3
  );

  const action_ready_again = action(() => {
    status.set({ state: "ready" });
  });
  const assert_request_names_host_and_time = assert(() => {
    const request = catalog.getItRequests[3];
    return catalog.getItRequests.length === 4 &&
      request?.patternId === "read-1" && request?.host === "fake-host" &&
      typeof request?.requestedAt === "number" && request.requestedAt > 0;
  });

  const action_another_host_answers = action(() => {
    host.set("other-host");
    catalog.answerGetItRequests.send();
  });
  const assert_request_for_another_host_unanswered = assert(() =>
    swapped.answer?.state === "started" &&
    catalog.getItAnswers[catalog.getItRequests[3]?.requestId ?? ""] ===
      undefined
  );

  const action_no_host = action(() => {
    host.set("");
  });
  const assert_no_host_says_why_and_adds_nothing = assert(() =>
    hasText(later[UI], "Nothing can get patterns here yet") &&
    catalog.getItRequests.length === 4
  );

  const action_retitle = action(() => {
    entries.set(
      ENTRIES.map((entry) =>
        entry.patternId === "split-1"
          ? { ...entry, title: "Dinner splitter" }
          : entry
      ),
    );
  });
  const assert_button_follows_catalog_title = assert(() =>
    installShows(split[UI]).patternTitle === "Dinner splitter"
  );

  return {
    [TESTS]: [
      { action: action_page },
      { assertion: assert_page_answers_in_callers_cell },
      { assertion: assert_button_names_catalog_title_and_destination },
      { assertion: assert_anonymous_shows_pseudonym_only },
      { assertion: assert_named_shows_profile_not_pseudonym },
      { assertion: assert_remix_chain_stops_at_what_viewer_cannot_see },
      { assertion: assert_not_a_remix_says_nothing },
      { assertion: assert_unavailable_first_step_hides_the_rest },
      { action: action_publish },
      { assertion: assert_named_remix_shows_both },
      { action: action_unpublish },
      { assertion: assert_unpublished_drops_badge_and_remix },
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
      { action: nameless.getIt, trustedUi: TRUSTED_TAP },
      { assertion: assert_nowhere_says_why_and_adds_nothing },
      { action: action_go_unavailable },
      { action: later.getIt, trustedUi: TRUSTED_TAP },
      { assertion: assert_unavailable_says_why },
      { action: action_ready_again },
      { action: swapped.getIt, trustedUi: TRUSTED_TAP },
      { assertion: assert_request_names_host_and_time },
      { action: action_another_host_answers },
      { assertion: assert_request_for_another_host_unanswered },
      { action: action_no_host },
      { action: later.getIt, trustedUi: TRUSTED_TAP },
      { assertion: assert_no_host_says_why_and_adds_nothing },
      { action: action_retitle },
      { assertion: assert_button_follows_catalog_title },
    ],
    // The forged push and the untrusted send are refused, and the runtime
    // warns as it drops them.
    allowConsoleWarnings: true,
    catalog,
  };
});
