import {
  action,
  assert,
  Default,
  equals,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import ParticipantIdentityCard, {
  JOIN_NEEDS_PROFILE,
} from "./participant-identity-card.tsx";
import {
  DEFAULT_HOST,
  type HostValue,
  type LunchProfile,
  type User,
} from "./main.tsx";
import {
  findNode,
  hasText,
  propsOf,
  readValue,
} from "../test/vnode-helpers.ts";

// Find a rendered node by a prop value. Walking the tree pulls the join
// surface's UI-only computeds (hasProfile, joinHint), which no direct
// handler/output read reaches otherwise.
const findByProp = (
  root: unknown,
  prop: string,
  expected: unknown,
): unknown | undefined =>
  findNode(root, (node) => {
    const props = propsOf(node);
    return props !== undefined && readValue(props[prop]) === expected;
  });

export default pattern(() => {
  // Lane 1 — no profile resolved: the card shows the create/pick surface and
  // offers no way in. Joining requires an identity, so there is no typed-name
  // fallback to collide with or spoof.
  const noProfileUsers = new Writable<User[] | Default<[]>>([]);
  const noProfileHost = Writable.of<HostValue>(DEFAULT_HOST);
  const noProfileCard = ParticipantIdentityCard({
    users: noProfileUsers,
    host: noProfileHost,
    profileName: "",
  });

  // Lane 2 — two DIFFERENT people who share a display name. Under name-keyed
  // identity these collided; under cell identity they are simply two people.
  const users = new Writable<User[] | Default<[]>>([]);
  const host = Writable.of<HostValue>(DEFAULT_HOST);

  const alexProfile = Writable.of<LunchProfile>({
    name: "Alex",
    avatar: "alex.png",
  });
  const otherAlexProfile = Writable.of<LunchProfile>({ name: "Alex" });

  const alexName = new Writable<string | Default<"">>("Alex");
  const alexCard = ParticipantIdentityCard({
    users,
    host,
    profile: alexProfile,
    profileName: alexName,
  });

  // Lane 3 — identity resolves LATE: the transient where one profile wish has
  // resolved and the other has not. The join must reject loudly, then heal
  // once the identity completes — and the complaint must clear.
  const lateUsers = new Writable<User[] | Default<[]>>([]);
  const lateHost = Writable.of<HostValue>(DEFAULT_HOST);
  const lateProfile = Writable.of<LunchProfile>({ name: "Late" });
  const lateName = new Writable<string | Default<"">>("");
  const lateCard = ParticipantIdentityCard({
    users: lateUsers,
    host: lateHost,
    profile: lateProfile,
    profileName: lateName,
  });
  // Lane 4 — the OTHER transient: the display name has resolved but the
  // profile DOCUMENT has not been pulled yet (a reference into the viewer's
  // own space, still on its way under a slow link). The button must wait for
  // the document rather than offer a join that `joinAs` will refuse, and a
  // refusal left by a headless caller must clear on its own once the document
  // reads present — without another join.
  const docLateUsers = new Writable<User[] | Default<[]>>([]);
  const docLateHost = Writable.of<HostValue>(DEFAULT_HOST);
  // A cell with no value yet is exactly what an unpulled document reads as.
  const docLateProfile = new Writable<LunchProfile>();
  const docLateCard = ParticipantIdentityCard({
    users: docLateUsers,
    host: docLateHost,
    profile: docLateProfile,
    profileName: "Doc",
  });
  const otherAlexCard = ParticipantIdentityCard({
    users,
    host,
    profile: otherAlexProfile,
    profileName: "Alex",
  });

  // === Actions ===

  const action_join_as_alex = action(() => {
    alexCard.joinAs.send({});
  });
  const action_join_again = action(() => {
    alexCard.joinAs.send({});
  });
  const action_join_as_other_alex = action(() => {
    otherAlexCard.joinAs.send({});
  });
  const action_other_alex_claims_host = action(() => {
    otherAlexCard.claimHost.send({});
  });
  const action_rename_alex = action(() => {
    alexName.set("Alexandra");
  });
  const action_join_with_no_profile = action(() => {
    noProfileCard.joinAs.send({});
  });
  const action_late_join_too_early = action(() => {
    lateCard.joinAs.send({});
  });
  const action_late_identity_resolves = action(() => {
    lateName.set("Late");
  });
  const action_late_join_after_resolve = action(() => {
    lateCard.joinAs.send({});
  });
  const action_doc_late_join_too_early = action(() => {
    docLateCard.joinAs.send({});
  });
  const action_doc_late_document_arrives = action(() => {
    docLateProfile.set({ name: "Doc" });
  });
  const action_doc_late_join = action(() => {
    docLateCard.joinAs.send({});
  });

  // === Assertions ===

  const assert_setup_surface_without_profile = assert(() => {
    const ui = noProfileCard[UI];
    return findByProp(ui, "data-profile-setup", true) !== undefined &&
      findByProp(ui, "id", "lp-join-button") === undefined &&
      hasText(ui, "First to join becomes the host.");
  });

  // Joining needs an identity, so a viewer without one changes nothing —
  // and the rejection says so, in the output AND the rendered card, instead
  // of silently doing nothing.
  const assert_no_profile_cannot_join = assert(() =>
    (noProfileUsers.get() ?? []).length === 0 &&
    noProfileCard.isJoined === false &&
    noProfileCard.joinMessage === JOIN_NEEDS_PROFILE &&
    hasText(noProfileCard[UI], JOIN_NEEDS_PROFILE)
  );

  // The late lane rejects the same way while the identity is incomplete…
  const assert_late_join_rejected_loudly = assert(() =>
    (lateUsers.get() ?? []).length === 0 &&
    lateCard.isJoined === false &&
    lateCard.joinMessage === JOIN_NEEDS_PROFILE
  );
  // …and once it completes, the join lands and the complaint clears.
  const assert_late_join_healed = assert(() =>
    (lateUsers.get() ?? []).length === 1 &&
    lateCard.isJoined === true &&
    lateCard.joinMessage === ""
  );

  // While the document is on its way the button is there but waits, saying
  // so, and a headless join in that window is refused loudly as before.
  const assert_doc_late_button_waits = assert(() => {
    const ui = docLateCard[UI];
    const button = findByProp(ui, "id", "lp-join-button");
    return button !== undefined &&
      readValue(propsOf(button)?.disabled) === true &&
      hasText(ui, "Loading your profile…") &&
      !hasText(ui, "Join as Doc");
  });
  const assert_doc_late_join_refused = assert(() =>
    (docLateUsers.get() ?? []).length === 0 &&
    docLateCard.isJoined === false &&
    docLateCard.joinMessage === JOIN_NEEDS_PROFILE
  );
  // Once the document reads present the button enables and the on-screen
  // complaint goes away — with no further join sent. The EXPORTED verdict
  // does not: the earlier attempt was refused and nothing has joined, so a
  // headless caller reading `joinMessage` must not be told otherwise.
  const assert_doc_late_heals_on_screen_only = assert(() => {
    const ui = docLateCard[UI];
    const button = findByProp(ui, "id", "lp-join-button");
    return button !== undefined &&
      readValue(propsOf(button)?.disabled) !== true &&
      hasText(ui, "Join as Doc") &&
      findByProp(ui, "data-join-message", true) === undefined &&
      docLateCard.joinMessage === JOIN_NEEDS_PROFILE &&
      docLateCard.isJoined === false &&
      (docLateUsers.get() ?? []).length === 0;
  });
  const assert_doc_late_joined = assert(() =>
    (docLateUsers.get() ?? []).length === 1 &&
    docLateCard.isJoined === true &&
    docLateCard.joinMessage === ""
  );
  const assert_offers_join_with_profile = assert(() => {
    const ui = alexCard[UI];
    return hasText(ui, "Join as Alex") &&
      findByProp(ui, "data-profile-identity", "canonical") !== undefined;
  });

  const assert_joined_and_hosts = assert(() => {
    const roster = users.get() ?? [];
    return roster.length === 1 &&
      roster[0]?.name === "Alex" &&
      // The roster shows the live profile, so no avatar is copied into it.
      roster[0]?.avatar === undefined &&
      equals(roster[0]?.profile, alexProfile) &&
      alexCard.isJoined === true &&
      alexCard.isAdmin === true &&
      alexCard.joinMessage === "";
  });

  // Joining twice is a no-op: the entry is found by identity, not by name.
  const assert_join_is_idempotent = assert(() =>
    (users.get() ?? []).length === 1
  );

  // The whole point: a second person named "Alex" is a second participant.
  const assert_same_name_two_people = assert(() => {
    const roster = users.get() ?? [];
    return roster.length === 2 &&
      roster[0]?.name === "Alex" &&
      roster[1]?.name === "Alex" &&
      equals(roster[0]?.profile, alexProfile) &&
      equals(roster[1]?.profile, otherAlexProfile) &&
      otherAlexCard.isJoined === true &&
      // Sharing a name does not share host status.
      otherAlexCard.isAdmin === false;
  });

  const assert_host_transferred = assert(() =>
    otherAlexCard.isAdmin === true && alexCard.isAdmin === false
  );

  // A rename changes what the viewer is called, not who they are: the stored
  // entry still matches them, so they stay joined and stay one participant.
  const assert_rename_keeps_identity = assert(() =>
    alexCard.isJoined === true &&
    (users.get() ?? []).length === 2 &&
    // The point of the break, stated as an assertion: the roster entry still
    // carries the JOIN-TIME name, which no longer matches what the viewer is
    // called, and they stay joined anyway because the entry is matched by
    // profile cell. A name-keyed roster would have lost them here.
    (users.get() ?? [])[0]?.name === "Alex" &&
    equals((users.get() ?? [])[0]?.profile, alexProfile)
  );

  return {
    [TESTS]: [
      { assertion: assert_setup_surface_without_profile },
      { action: action_join_with_no_profile },
      { assertion: assert_no_profile_cannot_join },
      { action: action_late_join_too_early },
      { assertion: assert_late_join_rejected_loudly },
      { action: action_late_identity_resolves },
      { action: action_late_join_after_resolve },
      { assertion: assert_late_join_healed },
      { assertion: assert_doc_late_button_waits },
      { action: action_doc_late_join_too_early },
      { assertion: assert_doc_late_join_refused },
      { action: action_doc_late_document_arrives },
      { assertion: assert_doc_late_heals_on_screen_only },
      { action: action_doc_late_join },
      { assertion: assert_doc_late_joined },
      { assertion: assert_offers_join_with_profile },
      { action: action_join_as_alex },
      { assertion: assert_joined_and_hosts },
      { action: action_join_again },
      { assertion: assert_join_is_idempotent },
      { action: action_join_as_other_alex },
      { assertion: assert_same_name_two_people },
      { action: action_other_alex_claims_host },
      { assertion: assert_host_transferred },
      { action: action_rename_alex },
      { assertion: assert_rename_keeps_identity },
    ],
    alexCard,
  };
});
