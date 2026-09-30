/**
 * Test: Cozy Lunch Poll - Scoped
 *
 * Exercises the scope idioms (per-space directory, per-user identity,
 * derived admin) and the core voting flows.
 *
 * Single-identity caveat (CT-1598): this file runs in one runtime with one
 * identity, so admin gating is exercised by attempting admin actions *before*
 * any join (the host pointer is unset, so `isHost` is false for everyone).
 * The real second-user cases — gating against a non-host user, host takeover,
 * cross-runtime visibility — are covered by multi-user.test.tsx.
 */

import {
  action,
  assert,
  computed,
  equals,
  pattern,
  TESTS,
  UI,
  wish,
  Writable,
} from "commonfabric";
import {
  findNode,
  hasExactText,
  propsOf,
  readValue,
} from "../test/vnode-helpers.ts";
import { JOIN_NEEDS_PROFILE } from "./participant-identity-card.tsx";
import CozyPoll, {
  dayKeyOf,
  type LunchProfile,
  type Option,
  type User,
  type Vote,
  type VoteColor,
} from "./main.tsx";

// This file's single identity IS the host, so adding options triggers the
// host-gated art generation. Mock the image endpoint so the flows stay
// deterministic and never reach a live dev server's real generator (the
// stored-art wiring itself is asserted in art-sync.test.tsx).
export const fetchMocks = [
  {
    urlIncludes: "/api/ai/img",
    contentType: "image/png",
    base64Body:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  },
];

const findNodeByProp = (
  root: unknown,
  prop: string,
  expected: unknown,
): unknown | undefined =>
  findNode(root, (node) => {
    const props = propsOf(node);
    return props !== undefined && readValue(props[prop]) === expected;
  });

/**
 * The `box-shadow` a vote swatch carries. The self mark reaches the view as
 * this style alone: a ring around the viewer's own vote, and "none" on every
 * other swatch.
 */
const selfRingOf = (node: unknown): unknown => {
  const style = readValue(propsOf(node)?.style);
  return style instanceof Object
    ? readValue(Reflect.get(style, "boxShadow"))
    : undefined;
};

const SEEDED_OPTION: Option = {
  id: "opt-seeded",
  title: "Leftover Café",
  addedByName: "Stan",
};

const COLLIDING_INITIAL_OPTION: Option = {
  id: "opt-colliding-initials",
  title: "Initials Café",
  addedByName: "Daffodil",
};

/**
 * Participants whose names share prefixes, so the vote-swatch labels must
 * disambiguate them. Names and colours only — each one's identity is a profile
 * cell minted in the pattern body, since a cell cannot be static seed data.
 */
const COLLIDING_INITIAL_PEOPLE: Array<[string, string]> = [
  ["Daffodil", "#2f6f4e"],
  ["Dragonfly", "#c2573a"],
  ["Dan", "#3b4a6b"],
  ["Dana", "#a33b35"],
  ["dan", "#b27722"],
  ["A", "#7c3aed"],
  ["a", "#2f6f4e"],
  ["A1", "#c2573a"],
  ["Bob Smith", "#3b4a6b"],
  ["Bob  Smith", "#a33b35"],
  ["👩🏽‍💻Alice", "#7c3aed"],
  ["👩🏽‍💻Bob", "#2f6f4e"],
  ["🇺🇸Alice", "#c2573a"],
  ["🇺🇸Bob", "#3b4a6b"],
  ["e\u0301Alice", "#a33b35"],
  ["e\u0301Bob", "#b27722"],
];

/** Each colliding participant's vote colour, in the same order. */
const COLLIDING_VOTE_COLORS: VoteColor[] = [
  "green",
  "yellow",
  "red",
  "green",
  "yellow",
  "red",
  "green",
  "yellow",
  "red",
  "green",
  "yellow",
  "red",
  "green",
  "yellow",
  "red",
  "green",
];

export default pattern(() => {
  // Identity is a profile cell; the test claims the viewer's through the
  // `overrideViewer` seam the `#profile` wish fills in production.
  const alex = Writable.of<LunchProfile>({ name: "Alex" });
  const poll = CozyPoll({});

  // The clock the assertions read: the interval `#now/300` wish, the same
  // shared ticking clock the pattern under test runs on (the pattern body
  // cannot read the ambient clock, and the bare one-shot `#now` would freeze
  // at first capture, which is exactly what the poll must not do). It reads
  // as unresolved (undefined / "") until the wish lands; the dependent
  // assertions guard that window and the harness re-evaluates them once it
  // does.
  const nowCell = wish<number>({ query: "#now/300" });
  const todayKey = computed(() =>
    nowCell.result == null ? "" : dayKeyOf(nowCell.result)
  );

  // Seed cells for the two polls whose scenarios start with data in them.
  // Plain cells, filled once by `action_seed_fixtures` below, never a
  // `computed()`: an argument is a link, so a derived one would hold the
  // poll's durable state in the derivation's own output cell, and the next
  // run of that derivation replaces every vote the poll has cast with the
  // seed again. `#now/300` advances on wall-clock five-minute boundaries, so
  // a seed derived from it re-runs partway through the run. See
  // docs/common/workflows/pattern-testing.md, "Seeding Stored State".
  const stan = Writable.of<LunchProfile>({ name: "Stan" });
  const staleVotes = Writable.of<Vote[]>([]);
  const collidingUsers = Writable.of<User[]>([]);
  const collidingVotes = Writable.of<Vote[]>([]);

  // Second instance, for the current-day filter scenario: it holds a vote cast
  // "yesterday" (castVote always stamps "now", so staleness must be seeded).
  // Stan claims his identity through the seam before the join step below.
  const stalePoll = CozyPoll({
    options: [SEEDED_OPTION],
    votes: staleVotes,
  });

  // Participant names with shared prefixes use distinct current-day vote labels.
  // Each label preserves complete displayed characters.
  const collidingPeople = COLLIDING_INITIAL_PEOPLE.map((
    [name, color],
    index,
  ) => ({
    name,
    color,
    profile: Writable.of<LunchProfile>({ name }),
    voteType: COLLIDING_VOTE_COLORS[index] ?? "green",
  }));
  const initialsPoll = CozyPoll({
    options: [COLLIDING_INITIAL_OPTION],
    users: collidingUsers,
    votes: collidingVotes,
  });

  // Fifth instance, for a vote whose voter is not on the roster: the tally
  // looks a voter up by cell, and a voter who has left has no row to find.
  // Robin never joins, so her vote has to tally without one.
  const robin = Writable.of<LunchProfile>({ name: "Robin" });
  const departedUsers = Writable.of<User[]>([]);
  const departedVotes = Writable.of<Vote[]>([]);
  const departedPoll = CozyPoll({
    options: [SEEDED_OPTION],
    users: departedUsers,
    votes: departedVotes,
  });

  // Sixth instance, for the self mark: two participants who share a display
  // name. The mark compares the viewer's profile cell with the vote's, so the
  // name they share cannot decide it, and only one of the two swatches is
  // ringed. The assertion checks the two cells differ, so a runtime that
  // minted one cell for both would fail here rather than pass emptily.
  const samMine = Writable.of<LunchProfile>({ name: "Sam" });
  const samTheirs = Writable.of<LunchProfile>({ name: "Sam" });
  const twinUsers = Writable.of<User[]>([]);
  const twinVotes = Writable.of<Vote[]>([]);
  const twinPoll = CozyPoll({
    options: [SEEDED_OPTION],
    users: twinUsers,
    votes: twinVotes,
  });

  // Fourth instance: a NAME-ONLY claim (no profile cell anywhere) must not
  // produce an identity. This exercises main's override-vs-wish selection with
  // the profile side of the claim absent — the browser wish-path shape, where
  // an absent cell-typed field reads as a truthy empty handle at `asCell`
  // seams. The join must reject loudly and store NOTHING; the display name
  // resolving is fine (display is not identity).
  const ghostPoll = CozyPoll({});

  // Profile-first join + the header strip/viewer-chip rendering from stored
  // profile cells are verified at the browser/integration tier (the
  // scrabble/battleship precedent), not here: a pattern-body `#profile` wish
  // has no resolving environment in a unit test, and an unset optional cell
  // input reads as a truthy proxy — so there is no honest way to inject a
  // resolvable viewer profile cell at this tier. The join LOGIC (name
  // snapshot, equals()-keyed dedup, directory write) is covered by
  // participant-identity-card.test.tsx, which injects those values into the
  // card directly.

  // === Actions ===

  // Fill every seed cell, once, before anything else runs. A handler reads a
  // timestamp off the clock and writes it as a fixed number, which is how the
  // seed gets a date without the polls' state living in a derivation. An
  // unresolved clock writes nothing, and `assert_stale_vote_hidden` reads the
  // seeded vote back, so a seed that never landed fails there.
  const action_seed_fixtures = action(() => {
    const now = nowCell.result;
    if (now === undefined) return;
    staleVotes.set([{
      voter: stan,
      optionId: SEEDED_OPTION.id,
      voteType: "green",
      castAt: now - 86_400_000,
    }]);
    collidingUsers.set(
      collidingPeople.map(({ name, color, profile }) => ({
        profile,
        name,
        avatar: "",
        color,
      })),
    );
    collidingVotes.set(
      collidingPeople.map(({ profile, voteType }) => ({
        voter: profile,
        optionId: COLLIDING_INITIAL_OPTION.id,
        voteType,
        castAt: now,
      })),
    );
    departedUsers.set([{
      profile: alex,
      name: "Alex",
      avatar: "",
      color: "#2f6f4e",
    }]);
    departedVotes.set([
      {
        voter: alex,
        optionId: SEEDED_OPTION.id,
        voteType: "green",
        castAt: now,
      },
      {
        voter: robin,
        optionId: SEEDED_OPTION.id,
        voteType: "red",
        castAt: now,
      },
    ]);
    twinUsers.set([
      { profile: samMine, name: "Sam", avatar: "", color: "#2f6f4e" },
      { profile: samTheirs, name: "Sam", avatar: "", color: "#c2573a" },
    ]);
    twinVotes.set([
      {
        voter: samMine,
        optionId: SEEDED_OPTION.id,
        voteType: "green",
        castAt: now,
      },
      {
        voter: samTheirs,
        optionId: SEEDED_OPTION.id,
        voteType: "red",
        castAt: now,
      },
    ]);
  });

  const action_become_my_sam = action(() => {
    twinPoll.overrideViewer.send({ profile: samMine, name: "Sam" });
  });

  const action_become_alex = action(() => {
    poll.overrideViewer.send({ profile: alex, name: "Alex" });
  });

  const action_try_add_before_join = action(() => {
    poll.addOption.send({ title: "Should not appear" });
  });

  const action_try_remove_before_join = action(() => {
    poll.removeOption.send({ optionId: "any" });
  });

  const action_try_reset_before_join = action(() => {
    poll.resetVotes.send({});
  });

  const action_try_log_before_join = action(() => {
    poll.logVisit.send({ title: "Sneaky" });
  });

  // A resolved profile is not membership. `castVote` is a public stream, so a
  // headless caller reaches it with an identity and no roster entry; the UI
  // never offers the control, which is why nothing else here would catch a
  // vote that counted anyway.
  const action_try_vote_before_join = action(() => {
    poll.castVote.send({ optionId: "any", voteType: "green" });
  });

  // The same refusal against a REAL option, from an identity that resolves
  // but never joined — the shape a headless caller actually has once the poll
  // is populated. Runs last so the viewer switch disturbs nothing before it.
  const outsider = Writable.of<LunchProfile>({ name: "Outsider" });
  const action_become_outsider = action(() => {
    poll.overrideViewer.send({ profile: outsider, name: "Outsider" });
  });
  const action_outsider_votes_real_option = action(() => {
    const first = (poll.options ?? [])[0];
    if (first) poll.castVote.send({ optionId: first.id, voteType: "green" });
  });

  const assert_no_vote_without_membership = assert(() =>
    (poll.votes ?? []).length === 0
  );

  const assert_outsider_left_the_tally_alone = assert(() =>
    // The switch LANDED — without this the lane passes under whoever was
    // viewing before, who is joined and may legitimately vote.
    poll.myName === "Outsider" &&
    poll.isJoined === false &&
    // And the standing invariant the guard exists to keep: every stored vote
    // belongs to somebody on the roster. Stronger than naming the outsider,
    // since it fails for any non-member's vote rather than this one's.
    (poll.votes ?? []).every((v) =>
      (poll.users ?? []).some((u) => equals(u.profile, v.voter))
    ) &&
    (poll.users ?? []).every((u) => !equals(u.profile, outsider))
  );

  const action_join_as_alex = action(() => {
    poll.joinAs.send({});
  });

  const action_try_rejoin_as_alex_two = action(() => {
    // Same identity joining again: idempotent, not a second participant.
    poll.joinAs.send({});
  });

  const action_add_chipotle = action(() => {
    poll.addOption.send({ title: "Chipotle" });
  });

  const action_add_thai = action(() => {
    poll.addOption.send({ title: "Thai Kitchen" });
  });

  const action_vote_green_first = action(() => {
    const first = poll.options[0];
    if (first) poll.castVote.send({ optionId: first.id, voteType: "green" });
  });

  const action_vote_yellow_first = action(() => {
    const first = poll.options[0];
    if (first) poll.castVote.send({ optionId: first.id, voteType: "yellow" });
  });

  const action_vote_red_first = action(() => {
    const first = poll.options[0];
    if (first) poll.castVote.send({ optionId: first.id, voteType: "red" });
  });

  const action_vote_green_first_again = action(() => {
    const first = poll.options[0];
    if (first) poll.castVote.send({ optionId: first.id, voteType: "green" });
  });

  const action_clear_my_vote_first = action(() => {
    const first = poll.options[0];
    if (first) poll.clearMyVote.send({ optionId: first.id });
  });

  const action_reset_votes = action(() => {
    poll.resetVotes.send({});
  });

  const action_remove_first_option = action(() => {
    const first = poll.options[0];
    if (first) poll.removeOption.send({ optionId: first.id });
  });

  // Cast a green vote on the surviving option (Thai) so that the next
  // logVisit captures a non-empty vote snapshot embedded in the entry.
  const action_vote_green_thai = action(() => {
    const first = poll.options[0]; // Thai Kitchen (the only survivor)
    if (first) poll.castVote.send({ optionId: first.id, voteType: "green" });
  });

  // Log a specific place by title (defaults wentAt to today). With a live
  // green vote on Thai, this also embeds one vote snapshot in the entry.
  const action_log_thai = action(() => {
    poll.logVisit.send({ title: "Thai Kitchen" });
  });

  // Backdated visits — fixed past timestamp so assertions are deterministic.
  const PAST_VISIT = 1700000000000; // 2023-11-14
  const action_log_visit_chipotle_backdated = action(() => {
    poll.logVisit.send({ title: "Chipotle", wentAt: PAST_VISIT + 1000 });
  });

  // Most-recent visit is recentVisits[0] (newest first). Thai is logged
  // "today" so it sorts ahead of the backdated Chipotle.
  const action_remove_first_history = action(() => {
    const first = poll.recentVisits[0];
    if (first) poll.removeHistoryEntry.send({ id: first.id });
  });

  const action_clear_history = action(() => {
    poll.clearHistory.send({});
  });

  // Single-identity caveat (CT-1598): host *takeover* needs a second user and
  // is covered by multi-user.test.tsx. This just confirms claimHost is wired
  // and is a harmless no-op when the caller already holds the role.
  const action_claim_host = action(() => {
    poll.claimHost.send({});
  });

  // === Assertions ===

  // After joining, no leftovers from the pre-join admin attempts: only
  // Alex is in users, no admin name was claimed by anyone else, and the
  // "Should not appear" option is absent (implied by chipotle assertions
  // later — options.length === 1 after only Chipotle is added).
  const assert_joined_as_alex = assert(() =>
    poll.users.length === 1 &&
    poll.users[0]?.name === "Alex" &&
    poll.myName === "Alex" &&
    poll.hostName === "Alex" &&
    poll.isJoined === true &&
    poll.isAdmin === true &&
    // The loud-rejection channel is empty after a successful join.
    poll.joinMessage === ""
  );

  const assert_immutable_after_join = assert(() =>
    poll.users.length === 1 &&
    poll.myName === "Alex"
  );

  const assert_chipotle_added = assert(() =>
    poll.options.length === 1 &&
    poll.options[0]?.title === "Chipotle" &&
    poll.options[0]?.addedByName === "Alex"
  );

  // The empty state is the only thing on the board before anyone adds an
  // option, and its job is to say who can do something about that. It reads
  // differently to a viewer with no host to wait for than to the host
  // themselves, so both are checked; between them they are every branch the
  // hint has except the one naming somebody else, which needs a second
  // identity and belongs to multi-user.test.tsx.
  const assert_empty_state_awaits_a_host = assert(() =>
    poll.optionCount === 0 &&
    findNode(poll[UI], (node) => hasExactText(node, "No options yet")) !==
      undefined &&
    findNode(
        poll[UI],
        (node) => hasExactText(node, "Waiting for a host to join."),
      ) !== undefined
  );

  const assert_empty_state_prompts_the_host = assert(() =>
    poll.optionCount === 0 &&
    findNode(poll[UI], (node) => hasExactText(node, "No options yet")) !==
      undefined &&
    findNode(
        poll[UI],
        (node) => hasExactText(node, "Add the first one above."),
      ) !== undefined
  );

  const assert_two_options = assert(() => poll.options.length === 2);

  const assert_green_vote_recorded = assert(() => {
    const v = poll.votes[0];
    return poll.votes.length === 1 &&
      v?.voteType === "green" &&
      equals(v?.voter, alex) &&
      // A handler-cast vote is stamped with today's castAt, so it must also
      // appear in the current-day view.
      poll.todaysVotes.length === 1 &&
      poll.todayVoteCount === 1;
  });

  // The "All options" overview renders one swatch per voter, sourced from a
  // per-option `votes.filter((v) => v.optionId === oid)`. Regression guard for
  // the transformer filter/map lift bug (CT-1777) where the predicate compiled
  // to a proxy-vs-proxy `===` (always false), so the filter dropped every vote
  // and the swatches silently stopped rendering: after Alex's green vote, his
  // swatch must appear in the rendered UI tree.
  const assert_alex_swatch_renders = assert(() =>
    findNodeByProp(poll[UI], "data-vote-swatch-name", "Alex") !== undefined
  );

  const assert_changed_to_yellow = assert(() => {
    const v = poll.votes[0];
    return poll.votes.length === 1 &&
      v?.voteType === "yellow";
  });

  const assert_changed_to_red = assert(() => {
    const v = poll.votes[0];
    return poll.votes.length === 1 &&
      v?.voteType === "red";
  });

  const assert_revote_green_cleared = assert(() => poll.votes.length === 0);

  const assert_my_vote_cleared = assert(() => poll.votes.length === 0);

  const assert_votes_reset = assert(() => poll.votes.length === 0);

  const assert_option_removed_with_its_votes = assert(() =>
    poll.options.length === 1 &&
    poll.options[0]?.title === "Thai Kitchen" &&
    poll.votes.length === 0
  );

  const assert_still_alex_host = assert(() =>
    poll.hostName === "Alex" && poll.isAdmin === true
  );

  // History lives in the `visits` PerSpace array now; we assert directly on the
  // `recentVisits` array (newest first) plus the `historyCount` /
  // `mostRecentTitle` / `voteHistoryCount` scalars.

  // Logged the surviving option (Thai Kitchen) by title → one entry, attributed
  // to the host (the frozen `loggedByName` snapshot). If the pre-join attempt
  // ("Sneaky") had not been gated, an entry would exist before this — so this
  // implicitly verifies the host gate too.
  const assert_thai_logged = assert(() => {
    const rows = poll.recentVisits ?? [];
    return rows.length === 1 &&
      rows[0]?.title === "Thai Kitchen" &&
      rows[0]?.loggedByName === "Alex" &&
      poll.historyCount === 1 &&
      poll.mostRecentTitle === "Thai Kitchen";
  });

  const assert_recent_visit_row_renders = assert(() =>
    findNodeByProp(
      poll[UI],
      "data-recent-visit-title",
      "Thai Kitchen",
    ) !== undefined
  );

  // The live green vote on Thai was snapshotted into the entry's `votes` when
  // Thai was logged → exactly one embedded snapshot.
  const assert_vote_snapshot = assert(() => poll.voteHistoryCount === 1);

  // Second entry is the backdated Chipotle log; newest-first sort puts it after
  // today's Thai, so it's rows[1]. `wentAt` is a plain ms-epoch number now, so
  // the backdated value compares directly (no TEXT encoding to round-trip).
  const assert_two_history = assert(() => {
    const rows = poll.recentVisits ?? [];
    return rows.length === 2 &&
      rows[1]?.title === "Chipotle" &&
      rows[1]?.wentAt === PAST_VISIT + 1000 &&
      poll.historyCount === 2;
  });

  // After deleting rows[0] (Thai, the most recent), only Chipotle remains. With
  // SQLite gone there are no independent async queries to settle, so we assert
  // the row content directly (which entry survived), not just the count — and
  // that the entry's live `loggedBy` link survives the array round-trip (push
  // on log + the set-subset filter on delete).
  const assert_one_history_after_remove = assert(() => {
    const rows = poll.recentVisits ?? [];
    return poll.historyCount === 1 &&
      rows.length === 1 &&
      rows[0]?.title === "Chipotle" &&
      rows[0]?.loggedByName === "Alex" &&
      rows[0]?.loggedBy != null;
  });

  // Clearing visits also drops the embedded vote snapshots.
  const assert_history_cleared = assert(() =>
    poll.historyCount === 0 &&
    poll.voteHistoryCount === 0
  );

  // === Current-day vote filter ===

  // The header renders the current date, and `todayDate` exposes the local
  // day key the votes are filtered to. The `todayKey !== ""` guard holds the
  // assertion false until this pattern's `#now` wish resolves.
  const assert_today_header_renders = assert(() =>
    todayKey !== "" &&
    findNodeByProp(poll[UI], "data-poll-today", true) !== undefined &&
    poll.todayDate === todayKey
  );

  const assert_colliding_initials_are_disambiguated = assert(() => {
    const ui = initialsPoll[UI];
    const daffodil = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "Daffodil",
    );
    const dragonfly = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "Dragonfly",
    );
    const dan = findNodeByProp(ui, "data-vote-swatch-name", "Dan");
    const dana = findNodeByProp(ui, "data-vote-swatch-name", "Dana");
    const lowerDan = findNodeByProp(ui, "data-vote-swatch-name", "dan");
    const upperA = findNodeByProp(ui, "data-vote-swatch-name", "A");
    const lowerA = findNodeByProp(ui, "data-vote-swatch-name", "a");
    const aOne = findNodeByProp(ui, "data-vote-swatch-name", "A1");
    const bobSmith = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "Bob Smith",
    );
    const bobDoubleSpace = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "Bob  Smith",
    );
    const emojiAlice = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "👩🏽‍💻Alice",
    );
    const emojiBob = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "👩🏽‍💻Bob",
    );
    const flagAlice = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "🇺🇸Alice",
    );
    const flagBob = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "🇺🇸Bob",
    );
    const accentAlice = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "e\u0301Alice",
    );
    const accentBob = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "e\u0301Bob",
    );
    return todayKey !== "" &&
      initialsPoll.todayDate === todayKey &&
      hasExactText(daffodil, "DF") &&
      hasExactText(dragonfly, "DR") &&
      hasExactText(dan, "DAN1") &&
      hasExactText(dana, "DANA") &&
      hasExactText(lowerDan, "DAN2") &&
      hasExactText(upperA, "A2") &&
      hasExactText(lowerA, "A3") &&
      hasExactText(aOne, "A1") &&
      hasExactText(bobSmith, "BOBSMITH1") &&
      hasExactText(bobDoubleSpace, "BOBSMITH2") &&
      hasExactText(emojiAlice, "👩🏽‍💻A") &&
      hasExactText(emojiBob, "👩🏽‍💻B") &&
      hasExactText(flagAlice, "🇺🇸A") &&
      hasExactText(flagBob, "🇺🇸B") &&
      hasExactText(accentAlice, "E\u0301A") &&
      hasExactText(accentBob, "E\u0301B");
  });

  // A voter who has left the roster still tallies. The name and color on a
  // swatch come from the roster row the vote's voter names, so a vote with no
  // row renders with neither: an empty name, and the fallback swatch color.
  const assert_departed_voter_tallies_namelessly = assert(() => {
    const ui = departedPoll[UI];
    const alexSwatch = findNodeByProp(ui, "data-vote-swatch-name", "Alex");
    const namelessSwatch = findNodeByProp(ui, "data-vote-swatch-name", "");
    return departedPoll.todayVoteCount === 2 &&
      alexSwatch !== undefined &&
      namelessSwatch !== undefined &&
      readValue(propsOf(namelessSwatch)?.["aria-label"]) === ": red vote";
  });

  // Two participants share the name "Sam", and the viewer is one of them. The
  // self mark follows the profile cell, so it lands on the viewer's swatch and
  // not on the other Sam's.
  const assert_self_mark_follows_the_cell_not_the_name = assert(() => {
    const ui = twinPoll[UI];
    const mine = findNodeByProp(ui, "aria-label", "Sam: green vote");
    const theirs = findNodeByProp(ui, "aria-label", "Sam: red vote");
    return !equals(samMine, samTheirs) &&
      mine !== undefined && theirs !== undefined &&
      selfRingOf(mine) !== "none" && selfRingOf(theirs) === "none";
  });

  const assert_vote_swatches_have_accessible_names = assert(() => {
    const ui = initialsPoll[UI];
    const daffodil = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "Daffodil",
    );
    const emojiBob = findNodeByProp(
      ui,
      "data-vote-swatch-name",
      "👩🏽‍💻Bob",
    );
    return readValue(propsOf(daffodil)?.role) === "img" &&
      readValue(propsOf(daffodil)?.["aria-label"]) ===
        "Daffodil: green vote" &&
      readValue(propsOf(emojiBob)?.role) === "img" &&
      readValue(propsOf(emojiBob)?.["aria-label"]) ===
        "👩🏽‍💻Bob: red vote";
  });

  // The seeded stale vote is stored but hidden: absent from `todaysVotes`,
  // the count, and the rendered swatches. The seeded `castAt` is read back and
  // dated earlier than today (day keys are "YYYY-MM-DD", so they compare as
  // dates), so the vote is hidden for the reason the filter is meant to hide
  // it. Guarded on both `#now` reads — this pattern's (`todayKey`) and the
  // poll's own (via `todayDate`) — so it passes only once the day filter is
  // live.
  const assert_stale_vote_hidden = assert(() => {
    const seeded = stalePoll.votes[0];
    return todayKey !== "" &&
      stalePoll.todayDate === todayKey &&
      stalePoll.votes.length === 1 &&
      typeof seeded?.castAt === "number" &&
      dayKeyOf(seeded.castAt) < todayKey &&
      stalePoll.todaysVotes.length === 0 &&
      stalePoll.todayVoteCount === 0 &&
      findNodeByProp(stalePoll[UI], "data-vote-swatch-name", "Stan") ===
        undefined;
  });

  // Options saved before generated art was introduced have no `imageUrl`
  // property. They must still satisfy the card's map/pattern contract and
  // render normally rather than passing a present-but-undefined value.
  const assert_legacy_option_without_image_renders = assert(() =>
    findNodeByProp(
      stalePoll[UI],
      "data-option-title",
      SEEDED_OPTION.title,
    ) !== undefined
  );

  const action_ghost_claims_name_only = action(() => {
    ghostPoll.overrideViewer.send({ name: "Ghost" });
  });

  const action_ghost_tries_join = action(() => {
    ghostPoll.joinAs.send({});
  });

  // The gate that matters is the STORE gate: an identity must READ as
  // present. A truthy-but-empty profile handle joins nobody.
  const assert_name_only_claim_cannot_join = assert(() =>
    ghostPoll.users.length === 0 &&
    ghostPoll.isJoined === false &&
    ghostPoll.myName === "Ghost" &&
    ghostPoll.joinMessage === JOIN_NEEDS_PROFILE
  );

  const action_stale_become_stan = action(() => {
    stalePoll.overrideViewer.send({ profile: stan, name: "Stan" });
  });

  const action_stale_join_as_stan = action(() => {
    stalePoll.joinAs.send({});
  });

  // Same color as the hidden stale vote.
  const action_stale_vote_green = action(() => {
    stalePoll.castVote.send({ optionId: "opt-seeded", voteType: "green" });
  });

  // A same-color click on a stale vote RE-CASTS it for today (fresh castAt)
  // instead of toggling off a vote the voter cannot see; the vote becomes
  // visible again (list, count, and swatch).
  const assert_stale_recast_visible = assert(() => {
    const v = stalePoll.todaysVotes[0];
    return todayKey !== "" &&
      stalePoll.todaysVotes.length === 1 &&
      equals(v?.voter, stan) &&
      v?.voteType === "green" &&
      typeof v?.castAt === "number" &&
      dayKeyOf(v.castAt) === todayKey &&
      stalePoll.todayVoteCount === 1 &&
      findNodeByProp(stalePoll[UI], "data-vote-swatch-name", "Stan") !==
        undefined;
  });

  // A second same-color click is the normal today-toggle-off.
  const assert_stale_recast_cleared = assert(() =>
    stalePoll.todaysVotes.length === 0 &&
    stalePoll.todayVoteCount === 0
  );

  return {
    [TESTS]: [
      // Seed data first, so nothing downstream depends on a derivation that
      // could re-run over the top of what the polls write.
      { action: action_seed_fixtures },
      // Alex claims his identity first (matching production, where the
      // `#profile` wish resolves before any interaction).
      { action: action_become_alex },
      // Admin-gated handlers are no-ops before anyone joins: the host
      // pointer is still unset, so `isHost` is false for everyone. No
      // separate assertion here — downstream assertions (e.g. only
      // Chipotle ends up in options, only Alex in users) implicitly
      // verify these attempts left no state. See ADMIN-FUTURE.md for
      // the kernel-level upgrade path.
      { action: action_try_add_before_join },
      { action: action_try_remove_before_join },
      { action: action_try_reset_before_join },
      { action: action_try_log_before_join },
      { action: action_try_vote_before_join },
      { assertion: assert_no_vote_without_membership },
      // Nobody has joined, so the board has no host to name.
      { assertion: assert_empty_state_awaits_a_host },

      // First join → claims admin
      { action: action_join_as_alex },
      { assertion: assert_joined_as_alex },

      // Second join attempt → no-op (name immutable after join)
      { action: action_try_rejoin_as_alex_two },
      { assertion: assert_immutable_after_join },

      // claimHost is a harmless no-op when the caller is already host.
      { action: action_claim_host },
      { assertion: assert_still_alex_host },

      // Alex hosts now, so the same empty board asks him for the first option.
      { assertion: assert_empty_state_prompts_the_host },

      // Admin adds options
      { action: action_add_chipotle },
      { assertion: assert_chipotle_added },
      { action: action_add_thai },
      { assertion: assert_two_options },

      // Vote green → yellow → red (covers all three colors)
      { action: action_vote_green_first },
      { assertion: assert_green_vote_recorded },
      { assertion: assert_alex_swatch_renders },
      { action: action_vote_yellow_first },
      { assertion: assert_changed_to_yellow },
      { action: action_vote_red_first },
      { assertion: assert_changed_to_red },

      // Voting green again (was red) → switches to green
      { action: action_vote_green_first_again },
      { assertion: assert_green_vote_recorded },

      // Voting same color again → toggles off
      { action: action_vote_green_first_again },
      { assertion: assert_revote_green_cleared },

      // Voting that same color once more re-adds it. A removed vote clears its
      // entity, so the toggle decision does not see stale content and dead-click.
      { action: action_vote_green_first_again },
      { assertion: assert_green_vote_recorded },

      // Clearing my vote drops it, and casting that same color afterwards
      // re-adds it: the clear discards the vote's stored content as well as
      // its place in the list, so the next cast is not read as a toggle
      // against the vote it just removed.
      { action: action_clear_my_vote_first },
      { assertion: assert_my_vote_cleared },
      { action: action_vote_green_first_again },
      { assertion: assert_green_vote_recorded },

      // Admin reset clears votes
      { action: action_reset_votes },
      { assertion: assert_votes_reset },

      // After a reset, re-voting the same color also re-adds (reset clears the
      // vote entities too, so the toggle is not fooled by stale content).
      { action: action_vote_green_first },
      { assertion: assert_green_vote_recorded },
      { action: action_reset_votes },
      { assertion: assert_votes_reset },

      // Remove option with votes → option AND its votes are discarded
      { action: action_vote_green_first },
      { action: action_remove_first_option },
      { assertion: assert_option_removed_with_its_votes },

      // "We went here" history. The pre-join attempt above ("Sneaky") must
      // have left no trace.
      // Cast a live green vote on the surviving option (Thai) so the next
      // logVisit embeds it in the entry's snapshot.
      { action: action_vote_green_thai },
      // Log the surviving option by title → one visit entry, attributed to the
      // host, with one embedded vote snapshot for the green vote. History reads
      // are plain computeds over the `visits` array now, so the light per-action
      // settle is sufficient — no `{ settle: true }` async-query waits needed.
      { action: action_log_thai },
      { assertion: assert_thai_logged },
      { assertion: assert_recent_visit_row_renders },
      { assertion: assert_vote_snapshot },
      // A second, backdated, explicit log → two entries (proves backdating).
      { action: action_log_visit_chipotle_backdated },
      { assertion: assert_two_history },
      // Delete a single entry (host) → the other remains.
      { action: action_remove_first_history },
      { assertion: assert_one_history_after_remove },
      // Clear all → empty.
      { action: action_clear_history },
      { assertion: assert_history_cleared },

      // === Current-day vote filter ===
      // Header date + exposed day key.
      { assertion: assert_today_header_renders },
      // Same-first-letter participant names get stable, distinct swatches.
      { assertion: assert_colliding_initials_are_disambiguated },
      { assertion: assert_vote_swatches_have_accessible_names },
      // A vote whose voter never joined still counts, and renders unnamed.
      { assertion: assert_departed_voter_tallies_namelessly },
      // Sharing a display name does not share the viewer's self mark.
      { action: action_become_my_sam },
      { assertion: assert_self_mark_follows_the_cell_not_the_name },
      // Seeded stale (yesterday) vote: stored but hidden everywhere.
      { assertion: assert_legacy_option_without_image_renders },
      { assertion: assert_stale_vote_hidden },
      // Same-color click on the stale vote re-casts it for today…
      { action: action_stale_become_stan },
      { action: action_stale_join_as_stan },
      { action: action_stale_vote_green },
      { assertion: assert_stale_recast_visible },
      // …and a second same-color click toggles today's vote off as usual.
      { action: action_stale_vote_green },
      { assertion: assert_stale_recast_cleared },

      // A name-only claim never becomes an identity.
      { action: action_ghost_claims_name_only },
      { action: action_ghost_tries_join },
      { assertion: assert_name_only_claim_cannot_join },

      // A resolved identity that never joined cannot vote on a real option.
      { action: action_become_outsider },
      { action: action_outsider_votes_real_option },
      { assertion: assert_outsider_left_the_tally_alone },
    ],
    poll,
    stalePoll,
  };
});
