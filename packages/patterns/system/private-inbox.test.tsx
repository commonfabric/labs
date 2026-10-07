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
  ensurePrivateInbox,
  type EnsurePrivateInboxEvent,
  isNonListAppendRefusal,
  type Offer,
  OFFER_ADDRESS_MAX_LENGTH,
  OFFER_DEFAULT_KIND,
  OFFER_ID_MAX_LENGTH,
  OFFER_KIND_MAX_LENGTH,
  OFFER_TITLE_MAX_LENGTH,
  pointProfilesAtPrivateInbox,
  type PointTarget,
  type PrivateInboxHolder,
  type PrivateInboxPiece,
  type PrivateInboxRefusalHolder,
  type RetainedPrivateInboxes,
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
 * in the calling space.
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

/** The string a malformed stored pointer holds instead of an object. */
const MALFORMED_POINTER = "broken-pointer-container";

/**
 * Stands in for a profile whose stored pointer is not an object, as a writer
 * bypassing `setInbox` can leave it. `stored` is the pointer as stored, which
 * `inbox`'s type does not show.
 */
const MalformedPointerProfile = pattern<
  Record<never, never>,
  {
    inbox: Pointer;
    stored: Pointer | string;
    setInbox: Stream<{ inbox?: Cell<PrivateInboxPiece> }>;
  }
>(() => {
  const inbox = new Writable<Pointer | string>(MALFORMED_POINTER).for("inbox");
  return {
    // deno-lint-ignore no-explicit-any
    inbox: inbox as any,
    stored: inbox,
    // deno-lint-ignore no-explicit-any
    setInbox: setStandInInbox({ inbox: inbox as any }),
  };
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

/**
 * Stands in for Home's ensure step: Home's `ensurePrivateInbox` over a holder,
 * a list of retained inboxes and a profile list, with its pointing step, and
 * a refusal holder of its own, which `refusal` returns.
 */
const EnsuringHome = pattern<
  {
    privateInbox: Writable<PrivateInboxHolder>;
    retainedPrivateInboxes: Writable<RetainedPrivateInboxes>;
    profiles: PointTarget[];
  },
  {
    ensure: Stream<EnsurePrivateInboxEvent>;
    refusal: PrivateInboxRefusalHolder;
  }
>(({ privateInbox, retainedPrivateInboxes, profiles }) => {
  const refusal = new Writable<PrivateInboxRefusalHolder>({});
  return {
    ensure: ensurePrivateInbox({
      privateInbox,
      retainedPrivateInboxes,
      privateInboxRefusal: refusal,
      profiles,
      pointProfiles: pointProfilesAtPrivateInbox({ privateInbox, profiles }),
    }),
    refusal,
  };
});

/** Whether `retained` holds exactly the inboxes `expected` holds, in order. */
function retainsExactly(
  retained: readonly (Cell<PrivateInboxPiece> | undefined)[] | undefined,
  expected: readonly (Cell<PrivateInboxPiece> | undefined)[],
): boolean {
  return (retained ?? []).length === expected.length &&
    expected.every((each, index) => equals(retained?.[index], each));
}

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
  const malformedPointer = MalformedPointerProfile({});
  const home = new Writable<PrivateInboxHolder>({});
  const elsewhere = new Writable<PrivateInboxHolder>({});
  const holdHomeInbox = holdNewInbox({ holder: home });
  const holdElsewhereInbox = holdNewInbox({ holder: elsewhere });
  const pointProfiles = pointProfilesAtPrivateInbox({
    privateInbox: home,
    profiles: [
      pointed,
      earlierPointed,
      earlierUnpointed,
      unpointed,
      malformedPointer,
      // deno-lint-ignore no-explicit-any
    ] as any,
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
  // Home repairs a stored pointer that is not an object: the pointer type
  // reads it as no pointer, so the owner's Home points the owner's profile.
  const assert_the_malformed_pointer_is_stored = assert(() =>
    malformedPointer.stored === MALFORMED_POINTER
  );
  const assert_the_malformed_pointer_is_repaired = assert(() =>
    equals(malformedPointer.inbox?.piece, home.get().piece)
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

  // Ensuring Home's inbox. Which inbox Home should hold is the host's decision
  // (`packages/piece/test/ops/private-inbox.test.ts`); the event names the
  // inbox to adopt and the profile that decided it. Home adopts it only when
  // that profile is in its list and still points at it, retaining an inbox it
  // held, and otherwise keeps what it holds, or holds none. A profile pointing
  // at another inbox keeps its pointer, and the seed step points a new profile
  // at the adopted inbox. Creating an inbox when no profile points at one is
  // covered by `integration/private-inbox-multi-runtime.test.ts`.
  const third = new Writable<PrivateInboxHolder>({});
  const holdThirdInbox = holdNewInbox({ holder: third });

  // Homes holding no inbox.
  const loneUnpointed = ProfileHome({ initialName: "Lone unpointed" });
  const loneAdvertising = EarlierVintageProfile({});
  const adoptingOne = new Writable<PrivateInboxHolder>({});
  const adoptingOneRetained = new Writable<RetainedPrivateInboxes>([]);
  const ensureAdoptingOne = EnsuringHome({
    privateInbox: adoptingOne,
    retainedPrivateInboxes: adoptingOneRetained,
    // deno-lint-ignore no-explicit-any
    profiles: [loneUnpointed, loneAdvertising] as any,
  });
  const firstUnpointed = ProfileHome({ initialName: "First unpointed" });
  const adoptedAdvertising = ProfileHome({
    initialName: "Adopted advertising",
  });
  const otherAdvertising = ProfileHome({ initialName: "Other advertising" });
  const lastUnpointed = EarlierVintageProfile({});
  const adoptingAmongOthers = new Writable<PrivateInboxHolder>({});
  const ensureAdoptingAmongOthers = EnsuringHome({
    privateInbox: adoptingAmongOthers,
    retainedPrivateInboxes: new Writable<RetainedPrivateInboxes>([]),
    // deno-lint-ignore no-explicit-any
    profiles: [
      firstUnpointed,
      adoptedAdvertising,
      otherAdvertising,
      lastUnpointed,
    ] as any,
  });
  // The host's order picked the second profile, as a default or the MRU list
  // does.
  const passedOverAdvertising = ProfileHome({
    initialName: "Passed over advertising",
  });
  const decidingAdvertising = ProfileHome({
    initialName: "Deciding advertising",
  });
  const followingDecider = new Writable<PrivateInboxHolder>({});
  const ensureFollowingDecider = EnsuringHome({
    privateInbox: followingDecider,
    retainedPrivateInboxes: new Writable<RetainedPrivateInboxes>([]),
    // deno-lint-ignore no-explicit-any
    profiles: [passedOverAdvertising, decidingAdvertising] as any,
  });
  const unvettedUnpointed = ProfileHome({ initialName: "Unvetted unpointed" });
  const unvettedAdvertising = ProfileHome({
    initialName: "Unvetted advertising",
  });
  const unvetted = new Writable<PrivateInboxHolder>({});
  const ensureUnvetted = EnsuringHome({
    privateInbox: unvetted,
    retainedPrivateInboxes: new Writable<RetainedPrivateInboxes>([]),
    // deno-lint-ignore no-explicit-any
    profiles: [unvettedUnpointed, unvettedAdvertising] as any,
  });
  const mismatchedAdvertising = ProfileHome({
    initialName: "Mismatched advertising",
  });
  const mismatched = new Writable<PrivateInboxHolder>({});
  const ensureMismatched = EnsuringHome({
    privateInbox: mismatched,
    retainedPrivateInboxes: new Writable<RetainedPrivateInboxes>([]),
    // deno-lint-ignore no-explicit-any
    profiles: [mismatchedAdvertising] as any,
  });
  // A profile outside the Home's list, pointing at the inbox the event names.
  const outsider = ProfileHome({ initialName: "Outsider" });
  const outsiderListed = ProfileHome({ initialName: "Outsider listed" });
  const namingAnOutsider = new Writable<PrivateInboxHolder>({});
  const ensureNamingAnOutsider = EnsuringHome({
    privateInbox: namingAnOutsider,
    retainedPrivateInboxes: new Writable<RetainedPrivateInboxes>([]),
    // deno-lint-ignore no-explicit-any
    profiles: [outsiderListed] as any,
  });
  // An event from a host that names no deciding profile.
  const unnamedAdvertising = EarlierVintageProfile({});
  const adoptingUnnamed = new Writable<PrivateInboxHolder>({});
  const ensureAdoptingUnnamed = EnsuringHome({
    privateInbox: adoptingUnnamed,
    retainedPrivateInboxes: new Writable<RetainedPrivateInboxes>([]),
    // deno-lint-ignore no-explicit-any
    profiles: [unnamedAdvertising] as any,
  });
  const freshAfterAdoption = ProfileHome({ initialName: "" });
  const seederAfterAdoption = Seeder({
    // deno-lint-ignore no-explicit-any
    profiles: [freshAfterAdoption] as any,
    privateInbox: adoptingOne,
  });

  // Homes holding Home's inbox.
  const readoptingAdvertising = ProfileHome({
    initialName: "Adopting again advertising",
  });
  const readoptingUnpointed = ProfileHome({
    initialName: "Adopting again unpointed",
  });
  const readopting = new Writable<PrivateInboxHolder>({});
  const readoptingRetained = new Writable<RetainedPrivateInboxes>([]);
  const ensureReadopting = EnsuringHome({
    privateInbox: readopting,
    retainedPrivateInboxes: readoptingRetained,
    // deno-lint-ignore no-explicit-any
    profiles: [readoptingAdvertising, readoptingUnpointed] as any,
  });
  // Another profile still points at the inbox Home holds, ahead of the
  // deciding one in the list.
  const stillAdvertisingHeld = ProfileHome({
    initialName: "Still advertising held",
  });
  const decidingElsewhere = EarlierVintageProfile({});
  const readoptingOverAnother = new Writable<PrivateInboxHolder>({});
  const readoptingOverAnotherRetained = new Writable<RetainedPrivateInboxes>(
    [],
  );
  const ensureReadoptingOverAnother = EnsuringHome({
    privateInbox: readoptingOverAnother,
    retainedPrivateInboxes: readoptingOverAnotherRetained,
    // deno-lint-ignore no-explicit-any
    profiles: [stillAdvertisingHeld, decidingElsewhere] as any,
  });
  // One whose retained list already holds the inbox it adopts, as after Home
  // gave that inbox up and a profile then pointed at it again.
  const returningAdvertising = EarlierVintageProfile({});
  const returning = new Writable<PrivateInboxHolder>({});
  const returningRetained = new Writable<RetainedPrivateInboxes>([]);
  const ensureReturning = EnsuringHome({
    privateInbox: returning,
    retainedPrivateInboxes: returningRetained,
    // deno-lint-ignore no-explicit-any
    profiles: [returningAdvertising] as any,
  });
  const keepingUnadvertisedPointed = ProfileHome({
    initialName: "Keeping unadvertised pointed",
  });
  const keepingUnadvertised = new Writable<PrivateInboxHolder>({});
  const keepingUnadvertisedRetained = new Writable<RetainedPrivateInboxes>([]);
  const ensureKeepingUnadvertised = EnsuringHome({
    privateInbox: keepingUnadvertised,
    retainedPrivateInboxes: keepingUnadvertisedRetained,
    // deno-lint-ignore no-explicit-any
    profiles: [keepingUnadvertisedPointed] as any,
  });
  const refusingAdvertising = ProfileHome({
    initialName: "Refusing advertising",
  });
  const refusing = new Writable<PrivateInboxHolder>({});
  const refusingRetained = new Writable<RetainedPrivateInboxes>([]);
  const ensureRefusing = EnsuringHome({
    privateInbox: refusing,
    retainedPrivateInboxes: refusingRetained,
    // deno-lint-ignore no-explicit-any
    profiles: [refusingAdvertising] as any,
  });
  const guardedAdvertising = ProfileHome({
    initialName: "Guarded advertising",
  });
  const guarded = new Writable<PrivateInboxHolder>({});
  const guardedRetained = new Writable<RetainedPrivateInboxes>([]);
  const ensureGuarded = EnsuringHome({
    privateInbox: guarded,
    retainedPrivateInboxes: guardedRetained,
    // deno-lint-ignore no-explicit-any
    profiles: [guardedAdvertising] as any,
  });
  const heldOutsiderListed = ProfileHome({
    initialName: "Held outsider listed",
  });
  const heldNamingAnOutsider = new Writable<PrivateInboxHolder>({});
  const heldNamingAnOutsiderRetained = new Writable<RetainedPrivateInboxes>(
    [],
  );
  const ensureHeldNamingAnOutsider = EnsuringHome({
    privateInbox: heldNamingAnOutsider,
    retainedPrivateInboxes: heldNamingAnOutsiderRetained,
    // deno-lint-ignore no-explicit-any
    profiles: [heldOutsiderListed] as any,
  });
  // One holding the link Home's holder reached the inbox through when it
  // created it, while its profile is given the inbox's own result document, so
  // the two links are equal only once both are resolved.
  const aliasAdvertising = ProfileHome({ initialName: "Alias advertising" });
  const aliasKeeping = new Writable<PrivateInboxHolder>({});
  const aliasKeepingRetained = new Writable<RetainedPrivateInboxes>([]);
  const ensureAliasKeeping = EnsuringHome({
    privateInbox: aliasKeeping,
    retainedPrivateInboxes: aliasKeepingRetained,
    // deno-lint-ignore no-explicit-any
    profiles: [aliasAdvertising] as any,
  });

  const action_advertise_inboxes = action(() => {
    holdThirdInbox.send();
    const advertised = elsewhere.get().piece?.resolveAsCell();
    const homeInbox = home.get().piece?.resolveAsCell();
    for (
      const profile of [
        loneAdvertising,
        adoptedAdvertising,
        passedOverAdvertising,
        unvettedAdvertising,
        mismatchedAdvertising,
        outsiderListed,
        unnamedAdvertising,
        readoptingAdvertising,
        decidingElsewhere,
        returningAdvertising,
        refusingAdvertising,
        guardedAdvertising,
        heldOutsiderListed,
        outsider,
      ]
    ) {
      profile.setInbox.send({ inbox: advertised });
    }
    stillAdvertisingHeld.setInbox.send({ inbox: homeInbox });
    aliasAdvertising.setInbox.send({ inbox: homeInbox });
    for (
      const holder of [
        readopting,
        readoptingOverAnother,
        returning,
        keepingUnadvertised,
        refusing,
        guarded,
        heldNamingAnOutsider,
      ]
    ) {
      holder.set({ piece: homeInbox });
    }
    aliasKeeping.set({ piece: home.get().piece });
    if (advertised !== undefined) returningRetained.set([advertised]);
  });
  const action_advertise_a_second_inbox = action(() => {
    const another = third.get().piece?.resolveAsCell();
    otherAdvertising.setInbox.send({ inbox: another });
    decidingAdvertising.setInbox.send({ inbox: another });
  });
  const action_ensure_inboxes = action(() => {
    const vetted = elsewhere.get().piece?.resolveAsCell();
    const another = third.get().piece?.resolveAsCell();
    const homeInbox = home.get().piece?.resolveAsCell();
    ensureAdoptingOne.ensure.send({ adopt: vetted, from: loneAdvertising });
    ensureAdoptingAmongOthers.ensure.send({
      adopt: vetted,
      from: adoptedAdvertising,
    });
    ensureFollowingDecider.ensure.send({
      adopt: another,
      from: decidingAdvertising,
    });
    ensureUnvetted.ensure.send({});
    ensureMismatched.ensure.send({
      adopt: another,
      from: mismatchedAdvertising,
    });
    ensureNamingAnOutsider.ensure.send({ adopt: vetted, from: outsider });
    ensureAdoptingUnnamed.ensure.send({ adopt: vetted });
    ensureReadopting.ensure.send({
      adopt: vetted,
      from: readoptingAdvertising,
    });
    ensureReadoptingOverAnother.ensure.send({
      adopt: vetted,
      from: decidingElsewhere,
    });
    ensureReturning.ensure.send({ adopt: vetted, from: returningAdvertising });
    ensureKeepingUnadvertised.ensure.send({});
    ensureRefusing.ensure.send({});
    ensureGuarded.ensure.send({ adopt: another, from: guardedAdvertising });
    ensureHeldNamingAnOutsider.ensure.send({ adopt: vetted, from: outsider });
    ensureAliasKeeping.ensure.send({
      adopt: homeInbox,
      from: aliasAdvertising,
    });
  });
  const assert_the_named_inbox_is_adopted = assert(() =>
    equals(adoptingOne.get().piece, elsewhere.get().piece) &&
    equals(loneUnpointed.inbox?.piece, elsewhere.get().piece) &&
    equals(loneAdvertising.inbox?.piece, elsewhere.get().piece) &&
    adoptingOneRetained.get().length === 0
  );
  const assert_another_advertised_inbox_is_left_as_it_was = assert(() =>
    equals(adoptingAmongOthers.get().piece, elsewhere.get().piece) &&
    equals(firstUnpointed.inbox?.piece, elsewhere.get().piece) &&
    equals(lastUnpointed.inbox?.piece, elsewhere.get().piece) &&
    equals(otherAdvertising.inbox?.piece, third.get().piece)
  );
  const assert_the_deciding_profile_is_followed_past_an_earlier_one = assert(
    () =>
      equals(followingDecider.get().piece, third.get().piece) &&
      equals(passedOverAdvertising.inbox?.piece, elsewhere.get().piece),
  );
  const assert_an_unvetted_advertisement_leaves_home_without_an_inbox = assert(
    () =>
      unvetted.get().piece === undefined &&
      unvettedUnpointed.inbox?.piece === undefined &&
      equals(unvettedAdvertising.inbox?.piece, elsewhere.get().piece),
  );
  const assert_an_inbox_the_named_profile_does_not_advertise_is_not_adopted =
    assert(() =>
      mismatched.get().piece === undefined &&
      equals(mismatchedAdvertising.inbox?.piece, elsewhere.get().piece)
    );
  const assert_an_inbox_named_by_a_profile_outside_the_list_is_not_adopted =
    assert(() =>
      namingAnOutsider.get().piece === undefined &&
      heldNamingAnOutsiderRetained.get().length === 0 &&
      equals(heldNamingAnOutsider.get().piece, home.get().piece) &&
      equals(outsider.inbox?.piece, elsewhere.get().piece)
    );
  const assert_an_unnamed_profile_is_taken_as_the_first_advertising_one =
    assert(() => equals(adoptingUnnamed.get().piece, elsewhere.get().piece));
  const assert_a_held_inbox_is_replaced_and_retained = assert(() =>
    equals(readopting.get().piece, elsewhere.get().piece) &&
    retainsExactly(readoptingRetained.get(), [home.get().piece]) &&
    equals(readoptingUnpointed.inbox?.piece, elsewhere.get().piece) &&
    equals(readoptingAdvertising.inbox?.piece, elsewhere.get().piece)
  );
  const assert_a_held_inbox_another_profile_advertises_is_replaced = assert(
    () =>
      equals(readoptingOverAnother.get().piece, elsewhere.get().piece) &&
      retainsExactly(readoptingOverAnotherRetained.get(), [
        home.get().piece,
      ]) &&
      equals(stillAdvertisingHeld.inbox?.piece, home.get().piece),
  );
  const assert_an_inbox_adopted_again_leaves_the_retained_list = assert(() =>
    equals(returning.get().piece, elsewhere.get().piece) &&
    retainsExactly(returningRetained.get(), [home.get().piece])
  );
  const assert_a_held_inbox_is_kept_when_none_is_advertised = assert(() =>
    equals(keepingUnadvertised.get().piece, home.get().piece) &&
    keepingUnadvertisedRetained.get().length === 0 &&
    equals(keepingUnadvertisedPointed.inbox?.piece, home.get().piece)
  );
  const assert_a_held_inbox_is_kept_when_the_host_names_none = assert(() =>
    equals(refusing.get().piece, home.get().piece) &&
    refusingRetained.get().length === 0 &&
    equals(refusingAdvertising.inbox?.piece, elsewhere.get().piece)
  );
  const assert_a_held_inbox_is_kept_when_the_host_names_another = assert(() =>
    equals(guarded.get().piece, home.get().piece) &&
    guardedRetained.get().length === 0 &&
    equals(guardedAdvertising.inbox?.piece, elsewhere.get().piece)
  );
  const assert_a_held_inbox_reached_through_another_link_is_kept = assert(
    () =>
      equals(aliasKeeping.get().piece, home.get().piece) &&
      !aliasKeeping.get().piece?.equalLinks(aliasAdvertising.inbox?.piece) &&
      aliasKeepingRetained.get().length === 0,
  );
  const action_seed_after_adoption = action(() => {
    seederAfterAdoption.seed.send({ name: "Fresh", index: 0 });
  });
  const assert_a_new_profile_is_pointed_at_the_adopted_inbox = assert(() =>
    equals(freshAfterAdoption.inbox?.piece, elsewhere.get().piece)
  );

  // Recording the host's refusal of the deciding profile's inbox. Home records
  // a refusal only while the profile the event names is in its list and still
  // points at the refused inbox, replaces one recorded before, and clears it
  // when it adopts an inbox and when the deciding profile points at the inbox
  // it holds. Clearing it when Home creates an inbox is covered by
  // `integration/private-inbox-multi-runtime.test.ts`.
  const REFUSED = "inbox-adoption-acl-mismatch";
  const REFUSED_AGAIN = "inbox-receive-missing";
  const refusedNoneUnpointed = ProfileHome({
    initialName: "Refused none unpointed",
  });
  const refusedNoneAdvertising = ProfileHome({
    initialName: "Refused none advertising",
  });
  const refusedNone = new Writable<PrivateInboxHolder>({});
  const ensureRefusedNone = EnsuringHome({
    privateInbox: refusedNone,
    retainedPrivateInboxes: new Writable<RetainedPrivateInboxes>([]),
    // deno-lint-ignore no-explicit-any
    profiles: [refusedNoneUnpointed, refusedNoneAdvertising] as any,
  });
  const refusedHeldAdvertising = ProfileHome({
    initialName: "Refused held advertising",
  });
  const refusedHeld = new Writable<PrivateInboxHolder>({});
  const refusedHeldRetained = new Writable<RetainedPrivateInboxes>([]);
  const ensureRefusedHeld = EnsuringHome({
    privateInbox: refusedHeld,
    retainedPrivateInboxes: refusedHeldRetained,
    // deno-lint-ignore no-explicit-any
    profiles: [refusedHeldAdvertising] as any,
  });
  const staleInboxAdvertising = ProfileHome({
    initialName: "Stale inbox advertising",
  });
  const ensureStaleInbox = EnsuringHome({
    privateInbox: new Writable<PrivateInboxHolder>({}),
    retainedPrivateInboxes: new Writable<RetainedPrivateInboxes>([]),
    // deno-lint-ignore no-explicit-any
    profiles: [staleInboxAdvertising] as any,
  });
  const staleProfileListed = ProfileHome({
    initialName: "Stale profile listed",
  });
  const ensureStaleProfile = EnsuringHome({
    privateInbox: new Writable<PrivateInboxHolder>({}),
    retainedPrivateInboxes: new Writable<RetainedPrivateInboxes>([]),
    // deno-lint-ignore no-explicit-any
    profiles: [staleProfileListed] as any,
  });
  const unnamedRefusalAdvertising = ProfileHome({
    initialName: "Unnamed refusal advertising",
  });
  const ensureUnnamedRefusal = EnsuringHome({
    privateInbox: new Writable<PrivateInboxHolder>({}),
    retainedPrivateInboxes: new Writable<RetainedPrivateInboxes>([]),
    // deno-lint-ignore no-explicit-any
    profiles: [unnamedRefusalAdvertising] as any,
  });
  const repeatedAdvertising = ProfileHome({
    initialName: "Repeated advertising",
  });
  const ensureRepeated = EnsuringHome({
    privateInbox: new Writable<PrivateInboxHolder>({}),
    retainedPrivateInboxes: new Writable<RetainedPrivateInboxes>([]),
    // deno-lint-ignore no-explicit-any
    profiles: [repeatedAdvertising] as any,
  });
  const curedAdvertising = ProfileHome({ initialName: "Cured advertising" });
  const cured = new Writable<PrivateInboxHolder>({});
  const ensureCured = EnsuringHome({
    privateInbox: cured,
    retainedPrivateInboxes: new Writable<RetainedPrivateInboxes>([]),
    // deno-lint-ignore no-explicit-any
    profiles: [curedAdvertising] as any,
  });

  const action_advertise_refused_inboxes = action(() => {
    const advertised = elsewhere.get().piece?.resolveAsCell();
    for (
      const profile of [
        refusedNoneAdvertising,
        refusedHeldAdvertising,
        staleInboxAdvertising,
        staleProfileListed,
        unnamedRefusalAdvertising,
        repeatedAdvertising,
        curedAdvertising,
      ]
    ) {
      profile.setInbox.send({ inbox: advertised });
    }
    refusedHeld.set({ piece: home.get().piece?.resolveAsCell() });
  });
  const action_send_refusals = action(() => {
    const advertised = elsewhere.get().piece?.resolveAsCell();
    const another = third.get().piece?.resolveAsCell();
    if (advertised === undefined || another === undefined) return;
    ensureRefusedNone.ensure.send({
      from: refusedNoneAdvertising,
      refused: { reason: REFUSED, inbox: advertised },
    });
    ensureRefusedHeld.ensure.send({
      from: refusedHeldAdvertising,
      refused: { reason: REFUSED, inbox: advertised },
    });
    ensureStaleInbox.ensure.send({
      from: staleInboxAdvertising,
      refused: { reason: REFUSED, inbox: another },
    });
    ensureStaleProfile.ensure.send({
      from: outsider,
      refused: { reason: REFUSED, inbox: advertised },
    });
    ensureUnnamedRefusal.ensure.send({
      refused: { reason: REFUSED, inbox: advertised },
    });
    ensureRepeated.ensure.send({
      from: repeatedAdvertising,
      refused: { reason: REFUSED, inbox: advertised },
    });
    ensureCured.ensure.send({
      from: curedAdvertising,
      refused: { reason: REFUSED, inbox: advertised },
    });
  });
  const assert_a_refusal_is_recorded_with_its_reason_and_inbox = assert(() => {
    const refusal = ensureRefusedNone.refusal.refusal;
    return refusal !== undefined && refusal.reason === REFUSED &&
      equals(refusal.inbox, elsewhere.get().piece) &&
      typeof refusal.refusedAt === "number" && refusal.refusedAt > 0 &&
      refusedNone.get().piece === undefined &&
      refusedNoneUnpointed.inbox?.piece === undefined;
  });
  const assert_a_refusal_is_recorded_beside_a_held_inbox = assert(() =>
    ensureRefusedHeld.refusal.refusal?.reason === REFUSED &&
    equals(ensureRefusedHeld.refusal.refusal?.inbox, elsewhere.get().piece) &&
    equals(refusedHeld.get().piece, home.get().piece) &&
    refusedHeldRetained.get().length === 0
  );
  const assert_a_refusal_of_an_inbox_the_named_profile_does_not_advertise_is_not_recorded =
    assert(() => ensureStaleInbox.refusal.refusal === undefined);
  const assert_a_refusal_named_by_a_profile_outside_the_list_is_not_recorded =
    assert(() => ensureStaleProfile.refusal.refusal === undefined);
  const assert_a_refusal_naming_no_profile_is_not_recorded = assert(() =>
    ensureUnnamedRefusal.refusal.refusal === undefined
  );
  const assert_an_event_naming_no_refusal_records_none = assert(() =>
    ensureRefusing.refusal.refusal === undefined &&
    ensureUnvetted.refusal.refusal === undefined
  );

  const action_move_refused_pointers = action(() => {
    repeatedAdvertising.setInbox.send({
      inbox: third.get().piece?.resolveAsCell(),
    });
    refusedHeldAdvertising.setInbox.send({
      inbox: home.get().piece?.resolveAsCell(),
    });
  });
  const action_send_after_the_refusals = action(() => {
    const advertised = elsewhere.get().piece?.resolveAsCell();
    const another = third.get().piece?.resolveAsCell();
    if (another === undefined) return;
    ensureRepeated.ensure.send({
      from: repeatedAdvertising,
      refused: { reason: REFUSED_AGAIN, inbox: another },
    });
    ensureRefusedHeld.ensure.send({ from: refusedHeldAdvertising });
    ensureCured.ensure.send({ adopt: advertised, from: curedAdvertising });
  });
  const assert_a_repeated_refusal_replaces_the_one_recorded = assert(() =>
    ensureRepeated.refusal.refusal?.reason === REFUSED_AGAIN &&
    equals(ensureRepeated.refusal.refusal?.inbox, third.get().piece)
  );
  const assert_a_refusal_is_cleared_when_the_deciding_profile_points_at_the_held_inbox =
    assert(() =>
      ensureRefusedHeld.refusal.refusal === undefined &&
      equals(refusedHeld.get().piece, home.get().piece)
    );
  const assert_a_refusal_is_cleared_when_home_adopts_an_inbox = assert(() =>
    ensureCured.refusal.refusal === undefined &&
    equals(cured.get().piece, elsewhere.get().piece)
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
      { assertion: assert_the_malformed_pointer_is_stored },
      { action: action_point_profiles },
      { assertion: assert_only_the_unpointed_profile_points_at_home_inbox },
      { assertion: assert_the_malformed_pointer_is_repaired },
      // Pointing again changes nothing.
      { action: action_point_profiles },
      { assertion: assert_only_the_unpointed_profile_points_at_home_inbox },
      { action: action_point_fresh_elsewhere },
      { action: action_name_the_existing_profile },
      { action: action_seed_fresh_profiles },
      { assertion: assert_only_the_unpointed_fresh_profile_is_pointed },
      { assertion: assert_existing_named_profile_left_alone },
      { action: action_advertise_inboxes },
      { action: action_advertise_a_second_inbox },
      { action: action_ensure_inboxes },
      { assertion: assert_the_named_inbox_is_adopted },
      { assertion: assert_another_advertised_inbox_is_left_as_it_was },
      {
        assertion: assert_the_deciding_profile_is_followed_past_an_earlier_one,
      },
      {
        assertion:
          assert_an_unvetted_advertisement_leaves_home_without_an_inbox,
      },
      {
        assertion:
          assert_an_inbox_the_named_profile_does_not_advertise_is_not_adopted,
      },
      {
        assertion:
          assert_an_inbox_named_by_a_profile_outside_the_list_is_not_adopted,
      },
      {
        assertion:
          assert_an_unnamed_profile_is_taken_as_the_first_advertising_one,
      },
      { assertion: assert_a_held_inbox_is_replaced_and_retained },
      { assertion: assert_a_held_inbox_another_profile_advertises_is_replaced },
      { assertion: assert_an_inbox_adopted_again_leaves_the_retained_list },
      { assertion: assert_a_held_inbox_is_kept_when_none_is_advertised },
      { assertion: assert_a_held_inbox_is_kept_when_the_host_names_none },
      { assertion: assert_a_held_inbox_is_kept_when_the_host_names_another },
      { assertion: assert_a_held_inbox_reached_through_another_link_is_kept },
      // Ensuring again changes nothing, and retains nothing more.
      { action: action_ensure_inboxes },
      { assertion: assert_the_named_inbox_is_adopted },
      { assertion: assert_another_advertised_inbox_is_left_as_it_was },
      {
        assertion: assert_the_deciding_profile_is_followed_past_an_earlier_one,
      },
      {
        assertion:
          assert_an_unvetted_advertisement_leaves_home_without_an_inbox,
      },
      {
        assertion:
          assert_an_inbox_the_named_profile_does_not_advertise_is_not_adopted,
      },
      {
        assertion:
          assert_an_inbox_named_by_a_profile_outside_the_list_is_not_adopted,
      },
      {
        assertion:
          assert_an_unnamed_profile_is_taken_as_the_first_advertising_one,
      },
      { assertion: assert_a_held_inbox_is_replaced_and_retained },
      { assertion: assert_a_held_inbox_another_profile_advertises_is_replaced },
      { assertion: assert_an_inbox_adopted_again_leaves_the_retained_list },
      { assertion: assert_a_held_inbox_is_kept_when_none_is_advertised },
      { assertion: assert_a_held_inbox_is_kept_when_the_host_names_none },
      { assertion: assert_a_held_inbox_is_kept_when_the_host_names_another },
      { assertion: assert_a_held_inbox_reached_through_another_link_is_kept },
      { action: action_seed_after_adoption },
      { assertion: assert_a_new_profile_is_pointed_at_the_adopted_inbox },
      { action: action_advertise_refused_inboxes },
      { action: action_send_refusals },
      { assertion: assert_a_refusal_is_recorded_with_its_reason_and_inbox },
      { assertion: assert_a_refusal_is_recorded_beside_a_held_inbox },
      {
        assertion:
          assert_a_refusal_of_an_inbox_the_named_profile_does_not_advertise_is_not_recorded,
      },
      {
        assertion:
          assert_a_refusal_named_by_a_profile_outside_the_list_is_not_recorded,
      },
      { assertion: assert_a_refusal_naming_no_profile_is_not_recorded },
      { assertion: assert_an_event_naming_no_refusal_records_none },
      { action: action_move_refused_pointers },
      { action: action_send_after_the_refusals },
      { assertion: assert_a_repeated_refusal_replaces_the_one_recorded },
      {
        assertion:
          assert_a_refusal_is_cleared_when_the_deciding_profile_points_at_the_held_inbox,
      },
      { assertion: assert_a_refusal_is_cleared_when_home_adopts_an_inbox },
    ],
  };
});
