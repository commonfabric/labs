/**
 * Pattern tests for a request for Home's private inbox: `requestPrivateInbox`
 * has Home ensure its inbox, and Home's answer for each profile, which
 * `privateInboxAnswersOf()` computes and a request's receipt links to, says
 * where a request naming that profile stands. A pattern test cannot read a
 * handling's receipt, so each case reads the answers a stand-in Home computes;
 * the receipt itself is read in
 * `packages/patterns/integration/private-inbox-multi-runtime.test.ts`.
 */

import {
  action,
  assert,
  type Cell,
  computed,
  equals,
  handler,
  pattern,
  type Stream,
  TESTS,
  Writable,
} from "commonfabric";
import ProfileHome from "./profile-home.tsx";
import PrivateInbox, {
  ensurePrivateInbox,
  pointProfilesAtPrivateInbox,
  type PointTarget,
  PrivateInboxAnswering,
  type PrivateInboxAnswers,
  type PrivateInboxHolder,
  type PrivateInboxPiece,
  type PrivateInboxReceipt,
  type PrivateInboxRefusalHolder,
  type PrivateInboxRequest,
  profileKeyOf,
  requestPrivateInbox,
  type RetainedPrivateInboxes,
} from "./private-inbox.tsx";

/** An inbox's result, as the link a holder keeps. */
function linkOf(inbox: unknown): Cell<PrivateInboxPiece>;
function linkOf(inbox: unknown): unknown {
  return inbox;
}

/** Creates an inbox in the calling space and keeps it in `holder`. */
const holdNewInbox = handler<void, { holder: Writable<PrivateInboxHolder> }>(
  (_event, { holder }) => {
    holder.set({ piece: linkOf(PrivateInbox({ offers: [] })) });
  },
);

/** Creates an inbox in a space of its own and keeps it in `holder`. */
const holdInboxElsewhere = handler<
  void,
  { holder: Writable<PrivateInboxHolder> }
>((_event, { holder }) => {
  holder.set({
    piece: linkOf(PrivateInbox.inSpace("elsewhere-inbox")({ offers: [] })),
  });
});

/**
 * Stands in for Home's request for its inbox: Home's `requestPrivateInbox`
 * over a profile list and the answers Home computes for it, sending Home's
 * `ensurePrivateInbox`, with its pointing step, over the same.
 */
const RequestingHome = pattern<
  {
    privateInbox: Writable<PrivateInboxHolder>;
    profiles: PointTarget[];
  },
  {
    request: Stream<PrivateInboxRequest, PrivateInboxReceipt>;
    answers: PrivateInboxAnswers;
  }
>(({ privateInbox, profiles }) => {
  const requested = new Writable<Record<string, boolean>>({});
  const { answers } = PrivateInboxAnswering({
    privateInbox,
    profiles,
    requested,
  });
  return {
    request: requestPrivateInbox({
      profiles,
      requested,
      answers,
      ensure: ensurePrivateInbox({
        privateInbox,
        retainedPrivateInboxes: new Writable<RetainedPrivateInboxes>([]),
        privateInboxRefusal: new Writable<PrivateInboxRefusalHolder>({}),
        profiles,
        pointProfiles: pointProfilesAtPrivateInbox({ privateInbox, profiles }),
      }),
    }),
    answers,
  };
});

/** The keys Home files its answers for `profiles` under, as requested. */
function keysOf(profiles: readonly unknown[]): Record<string, boolean> {
  const keys: Record<string, boolean> = {};
  for (const profile of profiles) {
    const key = profileKeyOf(profile);
    if (key !== undefined) keys[key] = true;
  }
  return keys;
}

/** The status Home answers a request naming `profile` with, if any. */
function answerOf(
  answers: PrivateInboxAnswers | undefined,
  profile: unknown,
): string | undefined {
  const key = profileKeyOf(profile);
  return key === undefined ? undefined : answers?.profiles?.[key]?.status;
}

export default pattern(() => {
  // A Home holding no inbox, with two profiles pointing at none.
  const first = ProfileHome({ initialName: "First" });
  const second = ProfileHome({ initialName: "Second" });
  const held = new Writable<PrivateInboxHolder>({});
  const home = RequestingHome({
    privateInbox: held,
    // deno-lint-ignore no-explicit-any
    profiles: [first, second] as any,
  });

  // Home's answers for a Home that holds an inbox it has not pointed its
  // profiles at yet, as requests for each would read them: the first is
  // pointed by Home, the second at an inbox in another space, and the third at
  // another inbox in the space of the one Home holds.
  const pointedByHome = ProfileHome({ initialName: "Pointed by Home" });
  const pointedElsewhere = ProfileHome({ initialName: "Pointed elsewhere" });
  const pointedNearby = ProfileHome({ initialName: "Pointed nearby" });
  const holding = new Writable<PrivateInboxHolder>({});
  const nearby = new Writable<PrivateInboxHolder>({});
  const elsewhere = new Writable<PrivateInboxHolder>({});
  const holdInbox = holdNewInbox({ holder: holding });
  const holdNearby = holdNewInbox({ holder: nearby });
  const holdElsewhere = holdInboxElsewhere({ holder: elsewhere });
  const holdingAnswers = PrivateInboxAnswering({
    privateInbox: holding,
    // deno-lint-ignore no-explicit-any
    profiles: [pointedByHome, pointedElsewhere, pointedNearby] as any,
    requested: computed(() =>
      keysOf([
        pointedByHome,
        pointedElsewhere,
        pointedNearby,
      ])
    ),
  }).answers;
  const pointHolding = pointProfilesAtPrivateInbox({
    privateInbox: holding,
    // deno-lint-ignore no-explicit-any
    profiles: [pointedByHome] as any,
  });

  // A Home holding no inbox, whose one profile points at another inbox.
  const advertising = ProfileHome({ initialName: "Advertising" });
  const unheld = new Writable<PrivateInboxHolder>({});
  const advertisingHome = RequestingHome({
    privateInbox: unheld,
    // deno-lint-ignore no-explicit-any
    profiles: [advertising] as any,
  });

  // A Home holding no inbox, whose first profile points at none while its
  // second advertises an inbox the host has not vetted.
  const waiting = ProfileHome({ initialName: "Waiting" });
  const unvetted = ProfileHome({ initialName: "Unvetted" });
  const awaitingVetting = new Writable<PrivateInboxHolder>({});
  const awaitingHome = RequestingHome({
    privateInbox: awaitingVetting,
    // deno-lint-ignore no-explicit-any
    profiles: [waiting, unvetted] as any,
  });

  // A Home with no profiles at all.
  const lone = ProfileHome({ initialName: "Lone" });
  const profileless = new Writable<PrivateInboxHolder>({});
  const profilelessHome = RequestingHome({
    privateInbox: profileless,
    profiles: [],
  });

  // A Home whose earlier profile leaves its list once both are requested.
  const leaving = ProfileHome({ initialName: "Leaving" });
  const staying = ProfileHome({ initialName: "Staying" });
  const leavingHeld = new Writable<PrivateInboxHolder>({});
  const leavingList = new Writable<PointTarget[]>([]);
  const leavingHome = RequestingHome({
    privateInbox: leavingHeld,
    profiles: leavingList,
  });

  const assert_no_profile_is_answered_before_a_request_names_it = assert(() =>
    Object.keys(home.answers.profiles).length === 0 &&
    home.answers.unlisted.status === "unlisted" &&
    home.answers.unpointable.status === "unpointable"
  );

  const action_hold_the_inboxes = action(() => {
    holdInbox.send();
    holdNearby.send();
    holdElsewhere.send();
  });
  const assert_a_held_inbox_the_profile_does_not_point_at_is_pending = assert(
    () =>
      holding.get().piece !== undefined &&
      answerOf(holdingAnswers, pointedByHome) === "pending",
  );

  const action_point_the_profiles = action(() => {
    pointHolding.send();
    pointedElsewhere.setInbox.send({
      inbox: elsewhere.get().piece?.resolveAsCell(),
    });
    pointedNearby.setInbox.send({
      inbox: nearby.get().piece?.resolveAsCell(),
    });
    advertising.setInbox.send({
      inbox: elsewhere.get().piece?.resolveAsCell(),
    });
    unvetted.setInbox.send({ inbox: elsewhere.get().piece?.resolveAsCell() });
  });
  const assert_the_answer_follows_the_pointer_to_the_held_inbox = assert(() =>
    answerOf(holdingAnswers, pointedByHome) === "ensured" &&
    equals(pointedByHome.inbox?.piece, holding.get().piece)
  );
  const assert_a_profile_another_inbox_won_is_not_held = assert(() =>
    answerOf(holdingAnswers, pointedElsewhere) === "not-held" &&
    equals(pointedElsewhere.inbox?.piece, elsewhere.get().piece)
  );
  const assert_another_inbox_in_the_held_inbox_space_is_not_held = assert(() =>
    answerOf(holdingAnswers, pointedNearby) === "not-held"
  );

  // Two requests to the first Home, one after the other, as from two clients.
  // Each Home that creates its inbox is sent its requests in actions of its
  // own: two ensures in flight at once over a Home holding none commit across
  // spaces against each other, which the runtime logs as an error.
  // `private-inbox-multi-runtime.test.ts` sends two at once.
  const action_request_first = action(() => {
    home.request.send({ from: first });
  });
  const action_request_second = action(() => {
    home.request.send({ from: second });
  });
  const action_request_where_home_creates_none = action(() => {
    advertisingHome.request.send({ from: advertising });
    awaitingHome.request.send({ from: waiting });
  });
  const action_request_without_profiles = action(() => {
    profilelessHome.request.send({ from: lone });
  });
  const action_list_the_leaving_home_profiles = action(() => {
    // deno-lint-ignore no-explicit-any
    leavingList.set([leaving, staying] as any);
  });
  const action_request_the_leaving_profile = action(() => {
    leavingHome.request.send({ from: leaving });
  });
  const action_request_the_staying_profile = action(() => {
    leavingHome.request.send({ from: staying });
  });

  const assert_a_request_is_ensured_once_home_points_its_profile = assert(
    () =>
      answerOf(home.answers, first) === "ensured" &&
      held.get().piece !== undefined &&
      equals(first.inbox?.piece, held.get().piece),
  );
  const assert_two_requests_end_at_one_inbox = assert(() =>
    answerOf(home.answers, second) === "ensured" &&
    equals(second.inbox?.piece, first.inbox?.piece)
  );
  const assert_a_profile_advertising_another_inbox_is_not_held = assert(() =>
    answerOf(advertisingHome.answers, advertising) === "not-held" &&
    unheld.get().piece === undefined
  );
  const assert_a_profile_home_will_not_point_is_not_held = assert(() =>
    answerOf(awaitingHome.answers, waiting) === "not-held" &&
    awaitingVetting.get().piece === undefined &&
    waiting.inbox?.piece === undefined
  );
  const assert_a_home_without_profiles_creates_its_inbox_and_answers_none =
    assert(() =>
      Object.keys(profilelessHome.answers.profiles).length === 0 &&
      profileless.get().piece !== undefined &&
      lone.inbox?.piece === undefined
    );
  const assert_both_profiles_of_the_leaving_home_are_ensured = assert(() =>
    answerOf(leavingHome.answers, leaving) === "ensured" &&
    answerOf(leavingHome.answers, staying) === "ensured"
  );

  const action_remove_the_earlier_profile = action(() => {
    // deno-lint-ignore no-explicit-any
    leavingList.set([staying] as any);
  });
  const assert_a_removed_profile_is_unlisted_and_the_next_keeps_its_answer =
    assert(() =>
      answerOf(leavingHome.answers, leaving) === "unlisted" &&
      answerOf(leavingHome.answers, staying) === "ensured"
    );

  return {
    [TESTS]: [
      { assertion: assert_no_profile_is_answered_before_a_request_names_it },
      { action: action_hold_the_inboxes },
      {
        assertion: assert_a_held_inbox_the_profile_does_not_point_at_is_pending,
      },
      { action: action_point_the_profiles },
      { assertion: assert_the_answer_follows_the_pointer_to_the_held_inbox },
      { assertion: assert_a_profile_another_inbox_won_is_not_held },
      { assertion: assert_another_inbox_in_the_held_inbox_space_is_not_held },
      { action: action_request_first },
      { action: action_request_second },
      { action: action_request_where_home_creates_none },
      { action: action_request_without_profiles },
      { action: action_list_the_leaving_home_profiles },
      { action: action_request_the_leaving_profile },
      { action: action_request_the_staying_profile },
      { assertion: assert_a_request_is_ensured_once_home_points_its_profile },
      { assertion: assert_two_requests_end_at_one_inbox },
      { assertion: assert_a_profile_advertising_another_inbox_is_not_held },
      { assertion: assert_a_profile_home_will_not_point_is_not_held },
      {
        assertion:
          assert_a_home_without_profiles_creates_its_inbox_and_answers_none,
      },
      { assertion: assert_both_profiles_of_the_leaving_home_are_ensured },
      { action: action_remove_the_earlier_profile },
      {
        assertion:
          assert_a_removed_profile_is_unlisted_and_the_next_keeps_its_answer,
      },
    ],
  };
});
