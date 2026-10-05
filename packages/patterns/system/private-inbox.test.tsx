import {
  action,
  assert,
  type Cell,
  currentPrincipal,
  equals,
  handler,
  pattern,
  type Stream,
  TESTS,
  Writable,
} from "commonfabric";
import { seedProfileName } from "./profile-create.tsx";
import ProfileHome, {
  type BackwardsCompatibleProfile,
  type ProfileInbox,
} from "./profile-home.tsx";
import PrivateInbox, {
  isNonListAppendRefusal,
  type Offer,
  OFFER_ADDRESS_MAX_LENGTH,
  OFFER_DEFAULT_KIND,
  OFFER_ID_MAX_LENGTH,
  OFFER_KIND_MAX_LENGTH,
  OFFER_TITLE_MAX_LENGTH,
  pointProfilesAtPrivateInbox,
  type PrivateInboxHolder,
  type PrivateInboxPiece,
} from "./private-inbox.tsx";

/** A well-formed space DID for an offer to name. */
const ROOM_SPACE = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

/** A well-formed DID of a principal other than the test's. */
const SOMEONE_ELSE = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

/** A well-formed host origin for an offer to name. */
const HOST = "https://example.com";

/** The offer in `offers` with `id`, if any. */
function offerWithId(
  offers: readonly (Offer | undefined)[],
  id: string,
): Offer | undefined {
  return offers.find((each) => each?.id === id);
}

/** An inbox's result, as the link a holder keeps. */
function linkOf(inbox: unknown): Cell<PrivateInboxPiece>;
function linkOf(inbox: unknown): unknown {
  return inbox;
}

/**
 * Creates an inbox and keeps it in `holder`, as `ensurePrivateInbox` does but
 * in the calling space, since a pattern test cannot create a space.
 */
const holdNewInbox = handler<void, { holder: Writable<PrivateInboxHolder> }>(
  (_event, { holder }) => {
    holder.set({ piece: linkOf(PrivateInbox({ offers: [] })) });
  },
);

/** A pointer as a profile holds it. */
type Pointer = { piece?: Cell<PrivateInboxPiece> };

/** Points a stand-in profile's pointer where the event says. */
const setStandInInbox = handler<
  { inbox?: Cell<PrivateInboxPiece> },
  { inbox: Writable<Pointer> }
>((event, { inbox }) => {
  inbox.set(event.inbox === undefined ? {} : { piece: event.inbox });
});

/**
 * Stands in for a profile of an earlier vintage: a pointer and `setInbox`, and
 * none of the current profile's other fields and streams.
 */
const EarlierVintageProfile = pattern<
  Record<never, never>,
  { inbox: Pointer; setInbox: Stream<{ inbox?: Cell<PrivateInboxPiece> }> }
>(() => {
  const inbox = new Writable<Pointer>({}).for("inbox");
  return { inbox, setInbox: setStandInInbox({ inbox }) };
});

/**
 * Stands in for the profile-create surface's seed step, the step that runs
 * after each profile is created, with Home's inbox given or left out as an
 * embedder gives it or leaves it out.
 */
const Seeder = pattern<
  { profiles: BackwardsCompatibleProfile[]; privateInbox?: ProfileInbox },
  { seed: Stream<{ name?: string; index?: number }> }
>(({ profiles, privateInbox }) => ({
  // deno-lint-ignore no-explicit-any
  seed: seedProfileName({ profiles: profiles as any, privateInbox }),
}));

/** Records the actor's principal in `me`. */
const introduce = handler<void, { me: Writable<string> }>((_event, { me }) => {
  me.set(currentPrincipal() ?? "");
});

export default pattern(() => {
  const inbox = PrivateInbox({ offers: [] });
  const me = new Writable("");
  const introduceMe = introduce({ me });
  const action_introduce = action(() => {
    introduceMe.send();
  });

  // A loom-shaped offer, with all eight fields and one the envelope lacks.
  const action_receive_loom_shaped = action(() => {
    inbox.receive.send({
      kind: "loom",
      id: "loom-shaped",
      space: ROOM_SPACE,
      host: HOST,
      ownerOrigin: "https://owner.example.com",
      title: "Lunch",
      from: me.get(),
      sharedAt: 1_700_000_000_123,
      extra: "dropped",
    } as never);
  });
  const assert_loom_shaped_offer_kept_whole = assert(() => {
    const offer = offerWithId(inbox.offers, "loom-shaped");
    return me.get() !== "" && offer !== undefined &&
      offer.kind === "loom" && offer.space === ROOM_SPACE &&
      offer.host === HOST &&
      offer.ownerOrigin === "https://owner.example.com" &&
      offer.title === "Lunch" && offer.from === me.get() &&
      offer.sharedAt === 1_700_000_000_123 &&
      typeof offer.receivedAt === "number" && offer.receivedAt > 0 &&
      !("extra" in offer);
  });

  // Strings are trimmed before they are checked and kept.
  const action_receive_padded = action(() => {
    inbox.receive.send({
      kind: "  fabrichat-room  ",
      id: "  padded  ",
      space: `  ${ROOM_SPACE}  `,
      host: `  ${HOST}  `,
      ownerOrigin: `  ${HOST}  `,
      title: "  Dinner  ",
      from: `  ${me.get()}  `,
    });
  });
  const assert_padded_offer_trimmed = assert(() => {
    const offer = offerWithId(inbox.offers, "padded");
    return offer !== undefined && offer.kind === "fabrichat-room" &&
      offer.space === ROOM_SPACE && offer.host === HOST &&
      offer.ownerOrigin === HOST && offer.title === "Dinner" &&
      offer.from === me.get();
  });

  // What an offer that leaves fields out is kept with.
  const action_receive_bare = action(() => {
    inbox.receive.send({
      space: ROOM_SPACE,
      host: HOST,
      ownerOrigin: "not an origin",
      from: me.get(),
    });
  });
  const assert_bare_offer_defaulted = assert(() => {
    const offer = inbox.offers.find((each) =>
      each?.id.startsWith(`${ROOM_SPACE}@`) === true
    );
    return offer !== undefined && offer.kind === OFFER_DEFAULT_KIND &&
      offer.id === `${ROOM_SPACE}@${offer.sharedAt}` &&
      offer.sharedAt === offer.receivedAt && offer.ownerOrigin === "" &&
      offer.title === "";
  });

  // Over-long strings are cut, and a host is cut before it is checked.
  const longHost = `https://${"h".repeat(OFFER_ADDRESS_MAX_LENGTH)}`;
  const action_receive_long = action(() => {
    inbox.receive.send({
      kind: "k".repeat(OFFER_KIND_MAX_LENGTH * 2),
      id: "i".repeat(OFFER_ID_MAX_LENGTH * 2),
      space: ROOM_SPACE,
      host: longHost,
      title: "t".repeat(OFFER_TITLE_MAX_LENGTH * 2),
      from: me.get(),
    });
  });
  const assert_long_offer_cut = assert(() => {
    const offer = offerWithId(inbox.offers, "i".repeat(OFFER_ID_MAX_LENGTH));
    return offer !== undefined &&
      offer.kind === "k".repeat(OFFER_KIND_MAX_LENGTH) &&
      offer.title === "t".repeat(OFFER_TITLE_MAX_LENGTH) &&
      offer.host === longHost.slice(0, OFFER_ADDRESS_MAX_LENGTH);
  });

  // Each refused, by the one rule it breaks.
  const action_receive_refused = action(() => {
    const valid = {
      kind: "loom",
      space: ROOM_SPACE,
      host: HOST,
      from: me.get(),
    };
    inbox.receive.send({ ...valid, id: "bad-space", space: "not-a-did" });
    inbox.receive.send({ ...valid, id: "no-space", space: undefined });
    inbox.receive.send({ ...valid, id: "bad-from", from: "not-a-did" });
    inbox.receive.send({ ...valid, id: "no-from", from: undefined });
    inbox.receive.send({ ...valid, id: "ftp-host", host: "ftp://example.com" });
    inbox.receive.send({ ...valid, id: "path-host", host: `${HOST}/path` });
    inbox.receive.send({ ...valid, id: "no-host", host: undefined });
    inbox.receive.send({
      ...valid,
      id: "userinfo-host",
      host: "https://good.example@evil.example",
    });
    inbox.receive.send({
      ...valid,
      id: "fragment-host",
      host: "https://good.example#@evil.example",
    });
    inbox.receive.send({
      ...valid,
      id: "query-host",
      host: "https://good.example?evil.example",
    });
    inbox.receive.send({
      ...valid,
      id: "bad-port-host",
      host: "https://example.com:99999",
    });
    inbox.receive.send({
      ...valid,
      id: "backslash-host",
      host: "https://example.com\\evil",
    });
    inbox.receive.send({
      ...valid,
      id: "default-port-host",
      host: "https://example.com:443",
    });
    inbox.receive.send({ ...valid, id: "query-space", space: "did:key:abc?" });
    inbox.receive.send({ ...valid, id: "not-me", from: SOMEONE_ELSE });
  });
  const assert_refused_offers_dropped = assert(() =>
    [
      "bad-space",
      "no-space",
      "bad-from",
      "no-from",
      "ftp-host",
      "path-host",
      "no-host",
      "userinfo-host",
      "fragment-host",
      "query-host",
      "bad-port-host",
      "backslash-host",
      "default-port-host",
      "query-space",
      "not-me",
    ].every((id) => offerWithId(inbox.offers, id) === undefined)
  );

  // A second offer under an `id` the inbox holds is dropped.
  const action_receive_duplicate = action(() => {
    inbox.receive.send({
      kind: "loom",
      id: "loom-shaped",
      space: ROOM_SPACE,
      host: HOST,
      title: "Second",
      from: me.get(),
    });
  });
  const assert_duplicate_dropped = assert(() =>
    inbox.offers.filter((each) => each?.id === "loom-shaped").length === 1 &&
    offerWithId(inbox.offers, "loom-shaped")?.title === "Lunch"
  );

  // An inbox whose `offers` a writer replaced with something other than a
  // list keeps nothing, and leaves it as it is.
  const corruptOffers = new Writable<string>("not a list");
  // deno-lint-ignore no-explicit-any
  const corrupt = PrivateInbox({ offers: corruptOffers as any });
  const action_receive_into_corrupt = action(() => {
    corrupt.receive.send({
      kind: "loom",
      id: "into-corrupt",
      space: ROOM_SPACE,
      host: HOST,
      from: me.get(),
    });
  });
  const assert_corrupt_offers_left_as_they_were = assert(() =>
    corruptOffers.get() === "not a list"
  );

  // Only an append's refusal of a non-list is passed over; any other failure
  // of the append propagates out of `receive`.
  const assert_only_a_non_list_refusal_is_passed_over = assert(() =>
    isNonListAppendRefusal(
      new Error(
        "Cell.push() or Cell.pushAll() requires transaction and array value\nhelp: use in handlers only, ensure cell is typed as array",
      ),
    ) &&
    !isNonListAppendRefusal(
      new TypeError("Cell.pushAll() requires an array of values, not `1`"),
    ) &&
    !isNonListAppendRefusal(new Error("writer-fit confidentiality misfit")) &&
    !isNonListAppendRefusal(undefined)
  );

  // Pointing profiles at an inbox: of the current vintage and of an earlier
  // one, one profile already points at another inbox, and one points at
  // nothing.
  const pointed = ProfileHome({ initialName: "Pointed" });
  const unpointed = ProfileHome({ initialName: "Unpointed" });
  const earlierPointed = EarlierVintageProfile({});
  const earlierUnpointed = EarlierVintageProfile({});
  const home = new Writable<PrivateInboxHolder>({});
  const elsewhere = new Writable<PrivateInboxHolder>({});
  const holdHomeInbox = holdNewInbox({ holder: home });
  const holdElsewhereInbox = holdNewInbox({ holder: elsewhere });
  const pointProfiles = pointProfilesAtPrivateInbox({
    privateInbox: home,
    // deno-lint-ignore no-explicit-any
    profiles: [pointed, earlierPointed, earlierUnpointed, unpointed] as any,
  });

  const action_create_inboxes = action(() => {
    holdHomeInbox.send();
    holdElsewhereInbox.send();
  });
  const action_point_one_elsewhere = action(() => {
    pointed.setInbox.send({ inbox: elsewhere.get().piece?.resolveAsCell() });
    earlierPointed.setInbox.send({
      inbox: elsewhere.get().piece?.resolveAsCell(),
    });
  });
  const action_point_profiles = action(() => {
    pointProfiles.send();
  });
  const assert_inboxes_created = assert(() =>
    home.get().piece !== undefined && elsewhere.get().piece !== undefined &&
    !equals(home.get().piece, elsewhere.get().piece)
  );
  const assert_only_the_unpointed_profile_points_at_home_inbox = assert(() =>
    equals(pointed.inbox?.piece, elsewhere.get().piece) &&
    equals(earlierPointed.inbox?.piece, elsewhere.get().piece) &&
    equals(unpointed.inbox?.piece, home.get().piece) &&
    equals(earlierUnpointed.inbox?.piece, home.get().piece)
  );

  // A profile created after Home pointed its profiles is pointed by the seed
  // step that follows its creation: when Home's inbox is given and the profile
  // points at nothing, and not otherwise.
  const freshForInbox = ProfileHome({ initialName: "" });
  const freshWithoutInbox = ProfileHome({ initialName: "" });
  const freshPointedElsewhere = ProfileHome({ initialName: "" });
  // deno-lint-ignore no-explicit-any
  const seederWithInbox = Seeder({
    profiles: [freshForInbox] as any,
    privateInbox: home,
  });
  // deno-lint-ignore no-explicit-any
  const seederWithoutInbox = Seeder({ profiles: [freshWithoutInbox] as any });
  const seederOverPointed = Seeder({
    // deno-lint-ignore no-explicit-any
    profiles: [freshPointedElsewhere] as any,
    privateInbox: home,
  });
  // An existing, named profile at the index the seed step is handed, as when
  // the create read its index from a list it had not loaded: left alone.
  const namedAtIndex = ProfileHome({ initialName: "" });
  const seederOverNamed = Seeder({
    // deno-lint-ignore no-explicit-any
    profiles: [namedAtIndex] as any,
    privateInbox: home,
  });
  const action_name_the_existing_profile = action(() => {
    namedAtIndex.setName.send({ name: "Ada" });
  });
  const action_point_fresh_elsewhere = action(() => {
    freshPointedElsewhere.setInbox.send({
      inbox: elsewhere.get().piece?.resolveAsCell(),
    });
  });
  const action_seed_fresh_profiles = action(() => {
    seederWithInbox.seed.send({ name: "Fresh", index: 0 });
    seederWithoutInbox.seed.send({ name: "Fresh", index: 0 });
    seederOverPointed.seed.send({ name: "Fresh", index: 0 });
    seederOverNamed.seed.send({ name: "Fresh", index: 0 });
  });
  const assert_only_the_unpointed_fresh_profile_is_pointed = assert(() =>
    equals(freshForInbox.inbox?.piece, home.get().piece) &&
    freshForInbox.name === "Fresh" &&
    freshWithoutInbox.inbox?.piece === undefined &&
    freshWithoutInbox.name === "Fresh" &&
    equals(freshPointedElsewhere.inbox?.piece, elsewhere.get().piece)
  );
  const assert_existing_named_profile_left_alone = assert(() =>
    namedAtIndex.inbox?.piece === undefined && namedAtIndex.name === "Ada"
  );

  return {
    [TESTS]: [
      { action: action_introduce },
      { action: action_receive_loom_shaped },
      { assertion: assert_loom_shaped_offer_kept_whole },
      { action: action_receive_padded },
      { assertion: assert_padded_offer_trimmed },
      { action: action_receive_bare },
      { assertion: assert_bare_offer_defaulted },
      { action: action_receive_long },
      { assertion: assert_long_offer_cut },
      { action: action_receive_refused },
      { assertion: assert_refused_offers_dropped },
      { action: action_receive_duplicate },
      { assertion: assert_duplicate_dropped },
      { action: action_receive_into_corrupt },
      { assertion: assert_corrupt_offers_left_as_they_were },
      { assertion: assert_only_a_non_list_refusal_is_passed_over },
      { action: action_create_inboxes },
      { assertion: assert_inboxes_created },
      { action: action_point_one_elsewhere },
      { action: action_point_profiles },
      { assertion: assert_only_the_unpointed_profile_points_at_home_inbox },
      // Pointing again changes nothing.
      { action: action_point_profiles },
      { assertion: assert_only_the_unpointed_profile_points_at_home_inbox },
      { action: action_point_fresh_elsewhere },
      { action: action_name_the_existing_profile },
      { action: action_seed_fresh_profiles },
      { assertion: assert_only_the_unpointed_fresh_profile_is_pointed },
      { assertion: assert_existing_named_profile_left_alone },
    ],
  };
});
