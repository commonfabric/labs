import {
  action,
  assert,
  computed,
  handler,
  pattern,
  type Stream,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findElementByExactText,
  findNodeByProp,
  hasText,
  propsOf,
  propValue,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";
import PollOptionCard from "./poll-option-card.tsx";
import type {
  CastVoteEvent,
  LogVisitEvent,
  LunchProfile,
  Option,
  RemoveOptionEvent,
  SetOptionImageEvent,
  Vote,
} from "./main.tsx";

type EmptyState = Record<PropertyKey, never>;

const noopCastVote = handler<CastVoteEvent, EmptyState>(() => {});
const noopRemoveOption = handler<RemoveOptionEvent, EmptyState>(() => {});
const noopLogVisit = handler<LogVisitEvent, EmptyState>(() => {});
const recordSetOptionImage = handler<
  SetOptionImageEvent,
  { lastEvent: Writable<SetOptionImageEvent | undefined> }
>((event, { lastEvent }) => lastEvent.set(event));

// Carries a stored image so this admin-viewer card takes the stored-art path
// (no generation request).
const STORED_OPTION: Option = {
  id: "opt-sushi",
  title: "Sushi Place",
  addedByName: "Alex",
  imageUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ",
};

// Nothing stored: the admin card generates via the mocked endpoint below.
const GENERATING_OPTION: Option = {
  id: "opt-tacos",
  title: "Taco Truck",
  addedByName: "Alex",
  imageUrl: "",
};

export const fetchMocks = [
  {
    urlIncludes: "/api/ai/img",
    contentType: "image/png",
    base64Body:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  },
];

const GENERATED_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export default pattern(() => {
  // Identity is a profile cell, so the viewer and their vote are built here
  // rather than seeded as module-level static data.
  const alex = Writable.of<LunchProfile>({ name: "Alex" });
  const votes = computed((): Vote[] => [
    { optionId: "opt-sushi", voter: alex, voteType: "green" },
  ]);
  const removeConfirmTarget = new Writable<string | null | undefined>(
    undefined,
  );
  const rank = new Writable<number | undefined>(undefined);
  const reactiveRank = computed(() => rank.get());

  const castVote: Stream<CastVoteEvent> = noopCastVote({});
  const removeOption: Stream<RemoveOptionEvent> = noopRemoveOption({});
  const logVisit: Stream<LogVisitEvent> = noopLogVisit({});
  const lastSetOptionImage = new Writable<SetOptionImageEvent | undefined>(
    undefined,
  );
  const setOptionImage: Stream<SetOptionImageEvent> = recordSetOptionImage({
    lastEvent: lastSetOptionImage,
  });

  const card = PollOptionCard({
    option: STORED_OPTION,
    rank: reactiveRank,
    viewerProfile: alex,
    isJoined: true,
    isAdmin: true,
    votes,
    removeConfirmTarget,
    castVote,
    removeOption,
    logVisit,
    setOptionImage,
  });

  const assert_my_green_vote_label_renders = assert(() =>
    findNodeByProp(
      card[UI],
      "aria-label",
      "Clear my green vote",
    ) !== undefined
  );

  const assert_unset_rank_renders_placeholder = assert(() =>
    hasText(card[UI], "—") && !hasText(card[UI], "#0")
  );

  const action_resolve_rank = action(() => rank.set(1));

  const assert_resolved_rank_renders = assert(() =>
    hasText(card[UI], "#1") && !hasText(card[UI], "—")
  );

  const action_set_zero_rank = action(() => rank.set(0));

  const assert_zero_rank_renders_placeholder = assert(() =>
    hasText(card[UI], "—") && !hasText(card[UI], "#0")
  );

  const assert_my_green_vote_styles_buttons = assert(() => {
    const green = findNodeByProp(
      card[UI],
      "aria-label",
      "Clear my green vote",
    );
    const yellow = findNodeByProp(
      card[UI],
      "aria-label",
      "Okay with it",
    );
    const red = findNodeByProp(card[UI], "aria-label", "Veto");
    return typeof propValue(green, "style") === "string" &&
      (propValue(green, "style") as string).includes("#22c55e") &&
      propValue(yellow, "style") === "opacity: 0.4;" &&
      propValue(red, "style") === "opacity: 0.4;";
  });

  const assert_remove_control_contains_only_link_text = assert(() => {
    const remove = findElementByExactText(card[UI], "button", "remove");
    return remove !== undefined &&
      propValue(remove, "aria-label") === "Remove option (host)";
  });

  const assert_remove_control_is_clickable = assert(() => {
    const remove = findElementByExactText(card[UI], "button", "remove");
    return propsOf(remove)?.onClick !== undefined;
  });

  const assert_remove_control_is_underlined = assert(() => {
    const remove = findElementByExactText(card[UI], "button", "remove");
    const removeStyle = propValue(remove, "style");
    return typeof removeStyle === "object" && removeStyle !== null &&
      readValue(
          (removeStyle as Record<PropertyKey, unknown>).textDecoration,
        ) === "underline";
  });

  const assert_remove_separator_is_plain = assert(() => {
    const separator = findElementByExactText(card[UI], "span", "·");
    const separatorAriaHidden = propValue(separator, "aria-hidden");
    const separatorStyle = propValue(separator, "style");
    const separatorStyleRecord =
      typeof separatorStyle === "object" && separatorStyle !== null
        ? separatorStyle as Record<PropertyKey, unknown>
        : undefined;
    const separatorTextDecoration = separatorStyleRecord
      ? readValue(separatorStyleRecord.textDecoration)
      : undefined;
    const separatorTextDecorationLine = separatorStyleRecord
      ? readValue(separatorStyleRecord.textDecorationLine)
      : undefined;
    return separator !== undefined &&
      (separatorAriaHidden === true || separatorAriaHidden === "true") &&
      propsOf(separator)?.onClick === undefined &&
      separatorTextDecoration === "none" &&
      (separatorTextDecorationLine === undefined ||
        separatorTextDecorationLine === "none");
  });

  const assert_log_visit_control_renders = assert(() =>
    findNodeByProp(
      card[UI],
      "aria-label",
      "Log that we went here (host)",
    ) !== undefined
  );

  // Stored art ⇒ artSyncState "stored" ⇒ no keep affordance.
  const assert_no_keep_button_when_stored = assert(() =>
    readValue(card.artSyncState) === "stored" &&
    findNodeByProp(
        card[UI],
        "aria-label",
        "Keep this art (host)",
      ) === undefined
  );

  // The generation path: an admin card with nothing stored generates (mocked
  // endpoint), surfaces the live fetch state through `artSyncState` (a direct
  // fetch-derived read — post-CT-1836), and shows the keep affordance.
  const generatingCard = PollOptionCard({
    option: GENERATING_OPTION,
    rank: 2,
    viewerProfile: alex,
    isJoined: true,
    isAdmin: true,
    votes,
    removeConfirmTarget,
    castVote,
    removeOption,
    logVisit,
    setOptionImage,
  });

  const assert_keep_button_when_generated = assert(() =>
    readValue(generatingCard.artSyncState) === "generated" &&
    findNodeByProp(
        generatingCard[UI],
        "aria-label",
        "Keep this art (host)",
      ) !== undefined
  );

  const action_keep_generated_art = action(() => {
    const button = findNodeByProp(
      generatingCard[UI],
      "aria-label",
      "Keep this art (host)",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const assert_keep_sends_generated_image = assert(() => {
    const event = readValue(lastSetOptionImage);
    return typeof event === "object" && event !== null &&
      readValue((event as SetOptionImageEvent).optionId) === "opt-tacos" &&
      readValue((event as SetOptionImageEvent).imageUrl) ===
        GENERATED_IMAGE_DATA_URL;
  });

  return {
    [TESTS]: [
      { assertion: assert_my_green_vote_label_renders },
      { assertion: assert_unset_rank_renders_placeholder },
      { action: action_resolve_rank },
      { assertion: assert_resolved_rank_renders },
      { action: action_set_zero_rank },
      { assertion: assert_zero_rank_renders_placeholder },
      { assertion: assert_my_green_vote_styles_buttons },
      { assertion: assert_remove_control_contains_only_link_text },
      { assertion: assert_remove_control_is_clickable },
      { assertion: assert_remove_control_is_underlined },
      { assertion: assert_remove_separator_is_plain },
      { assertion: assert_log_visit_control_renders },
      // Drives the generating card's mocked fetch to completion (and gives
      // both cards' art state a settle beat before it is read directly).
      { settle: true },
      { assertion: assert_no_keep_button_when_stored },
      { assertion: assert_keep_button_when_generated },
      { action: action_keep_generated_art },
      { assertion: assert_keep_sends_generated_image },
    ],
    card,
    generatingCard,
  };
});
