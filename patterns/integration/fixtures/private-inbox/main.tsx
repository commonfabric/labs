/**
 * Stands in for Home around the system private inbox: it holds the inbox and
 * the owner's profiles, and gives a sender and a stranger handlers of their own
 * that reach the inbox through a profile. Four more stand-ins, `adoptingHome`,
 * `refusingHome`, `curedHome` and `creatingHome`, are Homes whose profiles
 * already point at inboxes when the host first ensures their own, and a fifth,
 * `readoptingHome`, is one whose default profile is pointed elsewhere after it
 * holds an inbox, and a sixth, `replacingHome`, is one whose owner replaces the
 * inbox it was refused. A seventh, `ownSpaceHome`, records a refusal of the
 * private inbox, the one in Home's own `private-inbox` space, and its owner
 * replaces it, and an eighth, `unreadableRefusedHome`, is refused an inbox
 * whose space stops letting the owner read it, which its owner replaces.
 * `olderHome` stands in for a Home of the vintage whose ensure takes no
 * refusal, and `unreadableHome` for one whose profile keeps its pointer per
 * user. `requestingHome`, `profilelessHome` and `leavingHome` are Homes whose
 * inboxes a client requests, as a loom daemon does: a profile of the first's
 * may be of a vintage without `setInbox`, the second has no profiles, and the
 * third loses its first profile once its inbox is requested. `racingHome` is
 * a Home whose one profile two runtimes of the owner's point at inboxes of
 * their own, each only while it points at none. `holdingHome` holds an inbox
 * it did not make while its profile points at another it did not make, and
 * `labeledHoldingHome` holds one its profile points at through a pointer
 * carrying the owner's label. Fixture for
 * `private-inbox-multi-runtime.test.ts` and
 * `private-inbox-labeled-pointer-multi-runtime.test.ts`.
 */

import {
  type Cell,
  type Cfc,
  type Confidential,
  type CurrentPrincipal,
  currentPrincipal,
  Default,
  type DID,
  equals,
  handler,
  NAME,
  pattern,
  type RepresentsCurrentUser,
  revokeSpaceAccess,
  type Stream,
  UI,
  type VNode,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import EarlierProfile from "./earlier-profile.tsx";
import UserScopedProfile from "./user-scoped-profile.tsx";
import ProfileCreate, {
  seedProfileName,
  type SeedProfileNameEvent,
} from "../../../system/profile-create/profile-create.tsx";
import ProfileHome, {
  type ProfileHomeOutput,
  type ProfileInbox,
  type ShareInboxPiece,
} from "../../../system/profile-home/profile-home.tsx";
import PrivateInbox, {
  createOwnPrivateInbox,
  createOwnPrivateInboxOnly,
  ensurePrivateInbox,
  type EnsurePrivateInboxEvent,
  ensurePrivateInboxOnly,
  type Offer,
  type OfferEvent,
  pointProfilesAtPrivateInbox,
  type PointTarget,
  PRIVATE_INBOX_SPACE_NAME,
  PrivateInboxAnswering,
  type PrivateInboxHolder,
  type PrivateInboxOutput,
  type PrivateInboxPiece,
  type PrivateInboxReceipt,
  type PrivateInboxRefusalHolder,
  type PrivateInboxReplacementHolder,
  type PrivateInboxRequest,
  replaceRefusedPrivateInbox,
  repointProfilesFromReplacedInbox,
  requestPrivateInbox,
  type RetainedPrivateInboxes,
} from "../../../system/private-inbox/private-inbox.tsx";

/** The host origin every offer here names. */
const OFFER_HOST = "https://example.com";

/** An offer a sender's handler sends on to the owner's inbox. */
export interface OfferRequest {
  /** The sender's key for the offer. */
  id: string;

  /** The DID of the space offered. */
  space: string;

  /** What the sender calls it. */
  title: string;

  /**
   * The position of the profile to send it through, in the list the handler
   * reads; the first when absent.
   */
  profile?: number;
}

/**
 * The envelope a sender sends for `request`, from the principal sending the
 * event.
 */
function envelopeOf(request: OfferRequest): OfferEvent {
  const from = currentPrincipal();
  return {
    kind: "fabrichat-room",
    id: request.id,
    space: request.space,
    host: OFFER_HOST,
    ownerOrigin: OFFER_HOST,
    title: request.title,
    ...(from !== undefined && { from }),
    sharedAt: Date.now(),
  };
}

/** The fields of an offer a copy keeps. */
export interface CopiedOffer {
  title: string;
  from: string;
}

/** An inbox a link reaches, as the cell its result is. */
function inboxOf(link: unknown): Cell<PrivateInboxOutput>;
function inboxOf(link: unknown): unknown {
  return link;
}

/** An inbox's result, as the link a holder keeps. */
function inboxLinkOf(inbox: unknown): Cell<PrivateInboxPiece>;
function inboxLinkOf(inbox: unknown): unknown {
  return inbox;
}

/** A stand-in profile's result, as an entry in the owner's profile list. */
function asProfile(profile: unknown): ProfileHomeOutput;
function asProfile(profile: unknown): unknown {
  return profile;
}

/**
 * Creates one of the owner's profiles, in a space of its own that grants
 * anyone `WRITE`, and stores its name through `seedName`, as
 * `profile-create.tsx` does: a profile whose owner wrote no name is no one's
 * (`profileOwnerOf()`), and the host's inbox decision reads only the owner's
 * own. `seedName` points the profile at no inbox.
 */
const createProfile = handler<
  void,
  {
    profiles: Writable<ProfileHomeOutput[]>;
    seedName: Stream<SeedProfileNameEvent>;
  }
>((_event, { profiles, seedName }) => {
  const profile = ProfileHome.inSpace(undefined, { grants: { "*": "WRITE" } })({
    initialName: "Owner",
  }) as ProfileHomeOutput;
  profiles.push(profile);
  seedName.send({ name: "Owner", profile });
});

/**
 * Creates a profile of an earlier vintage, in a space of its own that grants
 * anyone `WRITE`.
 */
const createEarlierProfile = handler<
  void,
  { profiles: Writable<ProfileHomeOutput[]> }
>((_event, { profiles }) => {
  profiles.push(
    asProfile(
      EarlierProfile.inSpace(undefined, { grants: { "*": "WRITE" } })({}),
    ),
  );
});

/** The result of {@link PointerOnlyProfile}. */
interface PointerOnlyProfileOutput {
  [NAME]: string;

  /** The stand-in's name, which every profile vintage holds. */
  name: string;

  /** Where the stand-in points, which nothing here sets. */
  inbox: { piece?: Cell<PrivateInboxPiece> };
}

/**
 * Stands in for a profile of a vintage without `setInbox`, the stream through
 * which alone Home points a profile: a name and a pointer.
 */
const PointerOnlyProfile = pattern<
  Record<never, never>,
  PointerOnlyProfileOutput
>(() => ({
  [NAME]: "Pointer-only profile",
  name: "Pointer-only profile",
  inbox: new Writable<{ piece?: Cell<PrivateInboxPiece> }>({}).for("inbox"),
}));

/**
 * Creates a profile of a vintage without `setInbox`, in a space of its own that
 * grants anyone `WRITE`.
 */
const createPointerOnlyProfile = handler<
  void,
  { profiles: Writable<ProfileHomeOutput[]> }
>((_event, { profiles }) => {
  profiles.push(
    asProfile(
      PointerOnlyProfile.inSpace(undefined, { grants: { "*": "WRITE" } })({}),
    ),
  );
});

/**
 * The label of the owner's home space, which the labeled profile's inbox
 * pointer is declared to carry: the owner is the DID the harness derives for
 * the session `private-inbox-owner`.
 */
const OWNER_LABEL = {
  type: "https://commonfabric.org/cfc/atom/PersonalSpace",
  owner: "did:key:z6MkksB58J3VAuKbsxLKa5WoUxcUfcVfU1JdeaX3x2QfVeja",
} as const;

/** An inbox pointer carrying the owner's label. */
type LabeledPointer = Confidential<ProfileInbox, readonly [typeof OWNER_LABEL]>;

/** What setting the labeled profile's name asks: the name. */
interface SetLabeledNameEvent {
  /** The name to set. */
  name?: string;
}

/** Sets the labeled profile's name, its one writer, as a profile's is. */
const setLabeledName = handler<
  SetLabeledNameEvent,
  { name: Writable<string> }
>((event, { name }) => {
  name.set(event?.name ?? "");
});

/**
 * The labeled profile's name, written by `setLabeledName` alone and
 * representing its owner, as a Fabric profile's name is.
 */
type LabeledOwnName = RepresentsCurrentUser<
  Cfc<
    WriteAuthorizedBy<string, typeof setLabeledName>,
    { ownerPrincipal: CurrentPrincipal }
  >
>;

/** What pointing the labeled profile at an inbox asks: the inbox. */
interface SetLabeledInboxEvent {
  /** The inbox piece to point at; absent clears the pointer. */
  // `Cell<…>` is written out rather than reached through an alias: the
  // handler's event schema marks a reference position only where the wrapper
  // is written in the event type.
  inbox?: Cell<ShareInboxPiece>;

  /**
   * When present, the pointer the write requires, as the profile's own
   * `setInbox` takes it: held by nothing when it holds `undefined`, and held by
   * the inbox it names otherwise.
   */
  // Spelled `Cell<…>` for the reason `inbox` is; the `| undefined` admits an
  // explicit `undefined` as a value of the property, as the profile's does.
  replacing?: Cell<ShareInboxPiece> | undefined;
}

/**
 * Points the labeled profile at the event's inbox, or at none, under the
 * condition the profile's own `setInbox` checks: an event carrying `replacing`
 * writes only while the pointer meets it.
 */
const setLabeledInbox = handler<
  SetLabeledInboxEvent,
  { inbox: Writable<LabeledPointer> }
>((event, { inbox }) => {
  if (event !== undefined && "replacing" in event) {
    const held = inbox.get()?.piece;
    const met = event.replacing === undefined
      ? held === undefined
      : held !== undefined && equals(held, event.replacing);
    if (!met) return;
  }
  inbox.set(event?.inbox === undefined ? {} : { piece: event.inbox });
});

/** The labeled profile's result. */
interface LabeledProfileOutput {
  [NAME]: string;

  /** The owner's display name. */
  name: LabeledOwnName;

  /** Where the owner's offers are delivered, carrying the owner's label. */
  inbox: LabeledPointer;

  /** Sets the owner's display name. */
  setName: Stream<SetLabeledNameEvent>;

  /** Points the profile at an inbox. */
  setInbox: Stream<SetLabeledInboxEvent>;
}

/** A profile whose inbox pointer carries the owner's label. */
const LabeledProfile = pattern<Record<never, never>, LabeledProfileOutput>(
  () => {
    const name = new Writable<LabeledOwnName>("").for("name");
    const inbox = new Writable<LabeledPointer>({} as LabeledPointer).for(
      "inbox",
    );
    return {
      [NAME]: "Labeled profile",
      name,
      inbox,
      setName: setLabeledName({ name }),
      setInbox: setLabeledInbox({ inbox }),
    };
  },
);

/**
 * Creates a profile whose inbox pointer carries the owner's label, in a space
 * of its own that grants anyone `WRITE`, and stores its name through
 * `seedName`, as {@link createProfile} does.
 */
const createLabeledProfile = handler<
  void,
  {
    profiles: Writable<ProfileHomeOutput[]>;
    seedName: Stream<SeedProfileNameEvent>;
  }
>((_event, { profiles, seedName }) => {
  const profile = asProfile(
    LabeledProfile.inSpace(undefined, { grants: { "*": "WRITE" } })({}),
  );
  profiles.push(profile);
  seedName.send({ name: "Owner", profile });
});

/**
 * Creates a profile keeping its pointer per user, in a space of its own that
 * grants anyone `WRITE`.
 */
const createUserScopedProfile = handler<
  void,
  { profiles: Writable<ProfileHomeOutput[]> }
>((_event, { profiles }) => {
  profiles.push(
    asProfile(
      UserScopedProfile.inSpace(undefined, { grants: { "*": "WRITE" } })({}),
    ),
  );
});

/** Creates an inbox other than the private inbox, in a space of its own. */
const createOtherInbox = handler<
  void,
  { otherInbox: Writable<PrivateInboxHolder> }
>((_event, { otherInbox }) => {
  otherInbox.set({
    piece: inboxLinkOf(PrivateInbox.inSpace()({ offers: [] })),
  });
});

/**
 * Creates an inbox in a space of its own that grants every principal `WRITE`,
 * as a loom daemon creates its share inbox, and keeps it in `inbox`. The
 * principal sending the event owns the space.
 */
const createSharedInbox = handler<
  void,
  { inbox: Writable<PrivateInboxHolder> }
>((_event, { inbox }) => {
  inbox.set({
    piece: inboxLinkOf(
      PrivateInbox.inSpace(undefined, { grants: { "*": "WRITE" } })({
        offers: [],
      }),
    ),
  });
});

/**
 * Creates an inbox as Home creates its own, in the space Home's space names
 * `private-inbox`, as another runtime's Home does when two ensure Home's inbox
 * at once, and keeps it in `inbox`.
 */
const createHomeMadeInbox = handler<
  void,
  { inbox: Writable<PrivateInboxHolder> }
>((_event, { inbox }) => {
  inbox.set({
    piece: inboxLinkOf(
      PrivateInbox.inSpace(PRIVATE_INBOX_SPACE_NAME, {
        grants: { "*": "WRITE" },
      })({ offers: [] }),
    ),
  });
});

/**
 * Has the Home stand-in whose holder is `privateInbox` hold the inbox `inbox`
 * holds, as Home holds an inbox it adopted.
 */
const holdInbox = handler<
  void,
  {
    privateInbox: Writable<PrivateInboxHolder>;
    inbox: Writable<PrivateInboxHolder>;
  }
>((_event, { privateInbox, inbox }) => {
  const piece = inbox.get().piece;
  if (piece !== undefined) privateInbox.set({ piece });
});

/**
 * Has the Home stand-in whose holder is `privateInbox` hold the inbox its
 * first profile points at, as Home holds an inbox it adopted from the profile
 * advertising it. The holder carries whatever label the pointer does.
 */
const holdFirstProfileInbox = handler<
  void,
  {
    privateInbox: Writable<PrivateInboxHolder>;
    profiles: Writable<ProfileHomeOutput[]>;
  }
>((_event, { privateInbox, profiles }) => {
  const piece = profiles.key(0).resolveAsCell().key("inbox").get()?.piece;
  if (piece !== undefined) privateInbox.set({ piece });
});

/** Which of the owner's profiles to point at an inbox. */
export interface PointElsewhereRequest {
  /** The profile's position in its list. */
  index: number;
}

/** Points one of the profiles in `profiles` at the inbox `inbox` holds. */
const pointProfileAt = handler<
  PointElsewhereRequest,
  {
    profiles: Writable<ProfileHomeOutput[]>;
    inbox: Writable<PrivateInboxHolder>;
  }
>((event, { profiles, inbox }) => {
  const piece = inbox.get().piece?.resolveAsCell();
  profiles.key(event.index).resolveAsCell().key("setInbox").send(
    piece === undefined ? {} : { inbox: piece },
  );
});

/**
 * Points one of the profiles in `profiles` at the inbox `inbox` holds, only
 * while the profile points at no inbox, as Home and a loom daemon point one.
 */
const pointProfileAtIfUnset = handler<
  PointElsewhereRequest,
  {
    profiles: Writable<ProfileHomeOutput[]>;
    inbox: Writable<PrivateInboxHolder>;
  }
>((event, { profiles, inbox }) => {
  const piece = inbox.get().piece?.resolveAsCell();
  profiles.key(event.index).resolveAsCell().key("setInbox").send({
    ...(piece !== undefined && { inbox: piece }),
    replacing: undefined,
  });
});

/** The principal an inbox's space is to let read it. */
export interface ReaderRequest {
  /** The principal's DID. */
  reader: DID;
}

/**
 * Creates an inbox in a space of its own that grants `reader` `READ` and no
 * one else anything, and keeps it in `inbox`. The principal sending the event
 * owns the space.
 */
const createReadableByInbox = handler<
  ReaderRequest,
  { inbox: Writable<PrivateInboxHolder> }
>((event, { inbox }) => {
  inbox.set({
    piece: inboxLinkOf(
      PrivateInbox.inSpace(undefined, { grants: { [event.reader]: "READ" } })({
        offers: [],
      }),
    ),
  });
});

/** Revokes `reader`'s access to the space of the inbox `inbox` holds. */
const revokeReader = handler<
  ReaderRequest,
  { inbox: Writable<PrivateInboxHolder> }
>((event, { inbox }) => {
  const piece = inbox.get().piece?.resolveAsCell();
  if (piece === undefined) return;
  revokeSpaceAccess(piece, event.reader);
});

/**
 * Records in `refusal` the host's refusal of the inbox `inbox` holds, as Home's
 * ensure records one, for a Home holding none.
 */
const recordRefusalOf = handler<
  void,
  {
    inbox: Writable<PrivateInboxHolder>;
    refusal: Writable<PrivateInboxRefusalHolder>;
  }
>((_event, { inbox, refusal }) => {
  const refused = inbox.get().piece?.resolveAsCell();
  if (refused === undefined) return;
  refusal.set({
    refusal: {
      reason: "inbox-offers-invalid",
      inbox: refused,
      refusedAt: Date.now(),
    },
  });
});

/**
 * Takes the first profile out of `profiles`, by removing its link, which
 * leaves every other entry as it is stored.
 */
const dropFirstProfile = handler<
  void,
  { profiles: Writable<ProfileHomeOutput[]> }
>((_event, { profiles }) => {
  profiles.removeByValue(profiles.key(0).resolveAsCell());
});

/** Empties `profiles`. */
const dropProfiles = handler<
  void,
  { profiles: Writable<ProfileHomeOutput[]> }
>((_event, { profiles }) => {
  profiles.set([]);
});

/** A Home's default profile, held under `profile` as Home's slot holds it. */
export interface DefaultProfileSlot {
  /** The default profile, absent while none is chosen. */
  profile?: Cell<ProfileHomeOutput>;
}

/** Makes one of `profiles` the default, as Home's picker does. */
const setDefaultProfile = handler<
  PointElsewhereRequest,
  {
    profiles: Writable<ProfileHomeOutput[]>;
    defaultProfile: Writable<DefaultProfileSlot>;
  }
>((event, { profiles, defaultProfile }) => {
  defaultProfile.set({ profile: profiles.key(event.index).resolveAsCell() });
});

/** What the host reads of a Home, and sends it, and what a test drives. */
export interface HomeStandInOutput {
  [NAME]: string;
  privateInbox: PrivateInboxHolder;
  ownPrivateInbox: PrivateInboxHolder;
  retainedPrivateInboxes: RetainedPrivateInboxes;
  privateInboxRefusal: PrivateInboxRefusalHolder;
  privateInboxReplacement: PrivateInboxReplacementHolder;
  profiles: ProfileHomeOutput[];
  defaultProfile: DefaultProfileSlot;

  /** Makes one of the Home's profiles its default. */
  setDefaultProfile: Stream<PointElsewhereRequest>;

  /** Gives the Home a private inbox, as Home's own stream does. */
  ensurePrivateInbox: Stream<EnsurePrivateInboxEvent>;

  /**
   * Has the Home ensure its inbox and answers with it, as Home's own stream
   * does.
   */
  requestPrivateInbox: Stream<PrivateInboxRequest, PrivateInboxReceipt>;

  /** Replaces the inbox the Home was refused, as Home's own stream does. */
  replaceRefusedPrivateInbox: Stream<void>;

  /**
   * Creates the Home's own inbox for the host before an ensure, as Home's own
   * stream does.
   */
  createOwnPrivateInbox: Stream<EnsurePrivateInboxEvent>;

  /** Creates one of the Home's profiles. */
  createProfile: Stream<void>;

  /** Creates a profile of an earlier vintage in the Home. */
  createEarlierProfile: Stream<void>;
}

/**
 * Stands in for a Home whose profiles may point at inboxes before the host
 * first ensures its own. `label` keeps each stand-in's state its own.
 */
const HomeStandIn = pattern<{ label: string }, HomeStandInOutput>(
  ({ label }) => {
    const privateInbox = new Writable<PrivateInboxHolder>({}).for(
      "privateInbox",
    );
    const ownPrivateInbox = new Writable<PrivateInboxHolder>({}).for(
      "ownPrivateInbox",
    );
    const retainedPrivateInboxes = new Writable<RetainedPrivateInboxes>([])
      .for("retainedPrivateInboxes");
    const privateInboxRefusal = new Writable<PrivateInboxRefusalHolder>({})
      .for("privateInboxRefusal");
    const privateInboxReplacement = new Writable<
      PrivateInboxReplacementHolder
    >({}).for("privateInboxReplacement");
    const profiles = new Writable<ProfileHomeOutput[]>([]).for("profiles");
    const defaultProfile = new Writable<DefaultProfileSlot>({}).for(
      "defaultProfileSlot",
    );
    const requested = new Writable<Record<string, boolean>>({}).for(
      "privateInboxRequests",
    );
    const pointProfiles = pointProfilesAtPrivateInbox({
      privateInbox,
      retainedPrivateInboxes,
      // deno-lint-ignore no-explicit-any
      profiles: profiles as any,
    });
    const ensure = ensurePrivateInbox({
      privateInbox,
      ownPrivateInbox,
      retainedPrivateInboxes,
      privateInboxRefusal,
      // deno-lint-ignore no-explicit-any
      profiles: profiles as any,
      pointProfiles,
      createOwn: createOwnPrivateInbox({
        ownPrivateInbox,
        ensure: ensurePrivateInboxOnly({
          privateInbox,
          ownPrivateInbox,
          retainedPrivateInboxes,
          privateInboxRefusal,
          // deno-lint-ignore no-explicit-any
          profiles: profiles as any,
          pointProfiles,
        }),
      }),
    });
    return {
      [NAME]: label,
      privateInbox,
      ownPrivateInbox,
      retainedPrivateInboxes,
      privateInboxRefusal,
      privateInboxReplacement,
      profiles,
      defaultProfile,
      setDefaultProfile: setDefaultProfile({ profiles, defaultProfile }),
      ensurePrivateInbox: ensure,
      requestPrivateInbox: requestPrivateInbox({
        // deno-lint-ignore no-explicit-any
        profiles: profiles as any,
        requested,
        answers: PrivateInboxAnswering({
          privateInbox,
          // deno-lint-ignore no-explicit-any
          profiles: profiles as any,
          requested,
        }).answers,
        ensure,
      }),
      replaceRefusedPrivateInbox: replaceRefusedPrivateInbox({
        privateInbox,
        ownPrivateInbox,
        privateInboxRefusal,
        privateInboxReplacement,
        repointProfiles: repointProfilesFromReplacedInbox({
          privateInbox,
          privateInboxReplacement,
          // deno-lint-ignore no-explicit-any
          profiles: profiles as any,
        }),
      }),
      createProfile: createProfile({
        profiles,
        seedName: seedProfileName({}),
      }),
      createEarlierProfile: createEarlierProfile({ profiles }),
      createOwnPrivateInbox: createOwnPrivateInboxOnly({ ownPrivateInbox }),
    };
  },
);

/**
 * The event a Home of the vintage before the refusal record takes: an inbox to
 * adopt and the deciding profile, and nothing about a refusal.
 */
export type OlderEnsureEvent = {
  /** The inbox to adopt. */
  adopt?: Cell<PrivateInboxPiece>;

  /** The deciding profile. */
  from?: Cell<PointTarget>;
};

/**
 * Records each event an older Home's ensure is delivered, and the fields
 * delivered with it.
 */
const ensureAsOlderHome = handler<
  OlderEnsureEvent,
  { handled: Writable<number>; delivered: Writable<string[]> }
>((event, { handled, delivered }) => {
  handled.set(handled.get() + 1);
  delivered.set(Object.keys(event ?? {}).sort());
});

/** What the host reads of an older Home, and what a test reads back. */
export interface OlderHomeStandInOutput {
  [NAME]: string;
  privateInbox: PrivateInboxHolder;
  profiles: ProfileHomeOutput[];

  /** How many events its ensure has handled. */
  handled: number;

  /** The fields of the event its ensure last handled, sorted. */
  delivered: string[];

  /** Takes the event as a Home of that vintage typed it. */
  ensurePrivateInbox: Stream<OlderEnsureEvent>;

  /** Creates one of the Home's profiles. */
  createProfile: Stream<void>;
}

/**
 * Stands in for a Home of the vintage whose ensure takes no refusal: its event
 * type names `adopt` and `from` alone, so the event's schema is what such a
 * Home's is.
 */
const OlderHomeStandIn = pattern<Record<never, never>, OlderHomeStandInOutput>(
  () => {
    const privateInbox = new Writable<PrivateInboxHolder>({}).for(
      "privateInbox",
    );
    const profiles = new Writable<ProfileHomeOutput[]>([]).for("profiles");
    const handled = new Writable(0).for("handled");
    const delivered = new Writable<string[]>([]).for("delivered");
    return {
      [NAME]: "Older Home",
      privateInbox,
      profiles,
      handled,
      delivered,
      ensurePrivateInbox: ensureAsOlderHome({ handled, delivered }),
      createProfile: createProfile({
        profiles,
        seedName: seedProfileName({}),
      }),
    };
  },
);

/**
 * Sends an offer to the inbox the profile the request names points at, the
 * owner's first by default, from the event's actor's own handler.
 */
const offer = handler<
  OfferRequest,
  { profiles: Writable<ProfileHomeOutput[]> }
>((event, { profiles }) => {
  const inbox = inboxOf(
    profiles.key(event.profile ?? 0).resolveAsCell().key("inbox").key("piece")
      .resolveAsCell(),
  );
  inbox.key("receive").send(envelopeOf(event));
});

/**
 * Queues `send` with the request, so the offer leaves from a handler that
 * another handler's run emitted, as an offer leaves a room's creation.
 */
const queueOffer = handler<OfferRequest, { send: Stream<OfferRequest> }>(
  (event, { send }) => {
    send.send({ id: event.id, space: event.space, title: event.title });
  },
);

/**
 * Sends an offer to the inbox the owner's first profile points at, reading
 * the pointer through the profile's own types, as a typed link.
 */
const sendToPointedInbox = handler<
  OfferRequest,
  { profiles: Writable<ProfileHomeOutput[]> }
>((event, { profiles }) => {
  const pointer = profiles.key(0).resolveAsCell().key("inbox").get()?.piece;
  if (pointer === undefined) return;
  inboxOf(pointer.resolveAsCell()).key("receive").send(envelopeOf(event));
});

/** Copies the offers in the owner's private inbox into this piece. */
const copyOffers = handler<
  void,
  {
    privateInbox: Writable<PrivateInboxHolder>;
    copiedOffers: Writable<CopiedOffer[]>;
  }
>((_event, { privateInbox, copiedOffers }) => {
  const offers = inboxOf(privateInbox.key("piece").resolveAsCell()).key(
    "offers",
  ).get() as Offer[] | undefined;
  copiedOffers.set(
    (offers ?? []).map((item) => ({
      title: `${item.title}`,
      from: `${item.from}`,
    })),
  );
});

export interface MainInput {
  privateInbox: Writable<Default<PrivateInboxHolder, Record<never, never>>>;
  profiles: Writable<Default<ProfileHomeOutput[], []>>;
  otherInbox: Writable<Default<PrivateInboxHolder, Record<never, never>>>;
  copiedOffers: Writable<Default<CopiedOffer[], []>>;
}

export interface MainOutput {
  [NAME]: string;
  [UI]: VNode;
  privateInbox: PrivateInboxHolder;
  profiles: ProfileHomeOutput[];
  otherInbox: PrivateInboxHolder;
  loomInbox: PrivateInboxHolder;
  homeMadeInbox: PrivateInboxHolder;
  strangerInbox: PrivateInboxHolder;
  readoptLoomInbox: PrivateInboxHolder;
  cureInbox: PrivateInboxHolder;
  unreadableInbox: PrivateInboxHolder;
  adoptingHome: HomeStandInOutput;
  refusingHome: HomeStandInOutput;
  curedHome: HomeStandInOutput;
  creatingHome: HomeStandInOutput;
  readoptingHome: HomeStandInOutput;
  replacingHome: HomeStandInOutput;
  racingHome: HomeStandInOutput;
  ownSpaceHome: HomeStandInOutput;
  unreadableRefusedHome: HomeStandInOutput;
  olderHome: OlderHomeStandInOutput;
  copiedOffers: CopiedOffer[];
  ownPrivateInbox: PrivateInboxHolder;
  retainedPrivateInboxes: RetainedPrivateInboxes;
  privateInboxRefusal: PrivateInboxRefusalHolder;

  /**
   * Gives the stand-in Home the private inbox its profiles advertise, or one of
   * its own, and points profiles at it.
   */
  ensurePrivateInbox: Stream<EnsurePrivateInboxEvent>;

  /**
   * Creates the stand-in Home's own inbox for the host before an ensure, as
   * Home's own stream does.
   */
  createOwnPrivateInbox: Stream<EnsurePrivateInboxEvent>;

  /** Creates one of the owner's profiles. */
  createProfile: Stream<void>;

  /** Creates a profile of an earlier vintage. */
  createEarlierProfile: Stream<void>;

  /** Creates an inbox other than the private inbox. */
  createOtherInbox: Stream<void>;

  /** Points one of the owner's profiles at the other inbox. */
  pointProfileElsewhere: Stream<PointElsewhereRequest>;

  /**
   * Creates an inbox shaped as a loom daemon's, in a space of its own that
   * grants every principal `WRITE`, kept in `loomInbox`.
   */
  createLoomInbox: Stream<void>;

  /**
   * Creates an inbox as `createLoomInbox` does, kept in `strangerInbox`; sent
   * by another principal, the space is theirs.
   */
  createStrangerInbox: Stream<void>;

  /** Creates one of `adoptingHome`'s profiles. */
  createAdoptingProfile: Stream<void>;

  /** Creates a profile of an earlier vintage in `adoptingHome`. */
  createAdoptingEarlierProfile: Stream<void>;

  /**
   * Creates an inbox in Home's own `private-inbox` space, kept in
   * `homeMadeInbox`.
   */
  createHomeMadeInbox: Stream<void>;

  /** Points one of `adoptingHome`'s profiles at the inbox Home made. */
  pointAdoptingProfileAtHomeMade: Stream<PointElsewhereRequest>;

  /** Points one of `adoptingHome`'s profiles at the other inbox. */
  pointAdoptingProfileAtOther: Stream<PointElsewhereRequest>;

  /** Creates one of `refusingHome`'s profiles. */
  createRefusingProfile: Stream<void>;

  /** Points one of `refusingHome`'s profiles at the stranger's inbox. */
  pointRefusingProfileAtStranger: Stream<PointElsewhereRequest>;

  /** Creates one of `replacingHome`'s profiles. */
  createReplacingProfile: Stream<void>;

  /** Points one of `replacingHome`'s profiles at the stranger's inbox. */
  pointReplacingProfileAtStranger: Stream<PointElsewhereRequest>;

  /** Replaces the inbox `replacingHome` was refused. */
  replaceReplacingInbox: Stream<void>;

  /** Creates one of `racingHome`'s profiles. */
  createRacingProfile: Stream<void>;

  /**
   * Points one of `racingHome`'s profiles at the loom-shaped inbox, only while
   * it points at none.
   */
  pointRacingProfileAtLoomIfUnset: Stream<PointElsewhereRequest>;

  /**
   * Points one of `racingHome`'s profiles at the other inbox, only while it
   * points at none.
   */
  pointRacingProfileAtOtherIfUnset: Stream<PointElsewhereRequest>;

  /** Creates one of `ownSpaceHome`'s profiles. */
  createOwnSpaceProfile: Stream<void>;

  /** Points one of `ownSpaceHome`'s profiles at the private inbox. */
  pointOwnSpaceProfileAtPrivateInbox: Stream<PointElsewhereRequest>;

  /** Ensures `ownSpaceHome`'s inbox, with the event the host sends. */
  ensureOwnSpace: Stream<EnsurePrivateInboxEvent>;

  /** Records in `ownSpaceHome` a refusal of the private inbox. */
  refuseOwnSpaceInbox: Stream<void>;

  /** Replaces the inbox `ownSpaceHome` was refused. */
  replaceOwnSpaceInbox: Stream<void>;

  /**
   * Creates an inbox in a space of its own that grants the event's `reader`
   * `READ`, kept in `unreadableInbox`; the sender owns the space.
   */
  createUnreadableInbox: Stream<ReaderRequest>;

  /** Revokes the event's `reader`'s access to `unreadableInbox`'s space. */
  revokeUnreadableInbox: Stream<ReaderRequest>;

  /** Creates one of `unreadableRefusedHome`'s profiles. */
  createUnreadableRefusedProfile: Stream<void>;

  /** Points one of `unreadableRefusedHome`'s profiles at `unreadableInbox`. */
  pointUnreadableRefusedProfile: Stream<PointElsewhereRequest>;

  /** Replaces the inbox `unreadableRefusedHome` was refused. */
  replaceUnreadableRefusedInbox: Stream<void>;

  /** Creates an inbox as `createLoomInbox` does, kept in `cureInbox`. */
  createCureInbox: Stream<void>;

  /** Creates one of `curedHome`'s profiles. */
  createCuredProfile: Stream<void>;

  /** Points one of `curedHome`'s profiles at the stranger's inbox. */
  pointCuredProfileAtStranger: Stream<PointElsewhereRequest>;

  /** Points one of `curedHome`'s profiles at the inbox in `cureInbox`. */
  pointCuredProfileAtCure: Stream<PointElsewhereRequest>;

  /** Creates one of `creatingHome`'s profiles. */
  createCreatingProfile: Stream<void>;

  /** Points one of `creatingHome`'s profiles at the stranger's inbox. */
  pointCreatingProfileAtStranger: Stream<PointElsewhereRequest>;

  /** Empties `creatingHome`'s profile list. */
  dropCreatingProfiles: Stream<void>;

  /** Creates one of `olderHome`'s profiles. */
  createOlderProfile: Stream<void>;

  /** Points one of `olderHome`'s profiles at the stranger's inbox. */
  pointOlderProfileAtStranger: Stream<PointElsewhereRequest>;

  /**
   * Creates an inbox as `createLoomInbox` does, kept in `readoptLoomInbox`.
   */
  createReadoptLoomInbox: Stream<void>;

  /** Creates one of `readoptingHome`'s profiles. */
  createReadoptingProfile: Stream<void>;

  /**
   * Points one of `readoptingHome`'s profiles at the inbox in
   * `readoptLoomInbox`, through the profile's own `setInbox`, whatever it
   * pointed at before, as a loom daemon points it.
   */
  pointReadoptingProfileAtLoom: Stream<PointElsewhereRequest>;

  /**
   * Sends an offer through the `readoptingHome` profile the request names, its
   * first by default.
   */
  offerToReadopting: Stream<OfferRequest>;

  /** Makes one of `readoptingHome`'s profiles its default. */
  setReadoptingDefault: Stream<PointElsewhereRequest>;

  /** Sends an offer through the owner's first profile. */
  offer: Stream<OfferRequest>;

  /**
   * Sends an offer to the inbox the owner's first profile points at, from a
   * handler this stream's handler queues.
   */
  queuedOffer: Stream<OfferRequest>;

  /** Copies the private inbox's offers into this piece. */
  copyOffers: Stream<void>;

  /**
   * Creates one of the owner's profiles the way the profile-create surface
   * does, handing it the private inbox.
   */
  createProfileThroughSurface: Stream<{ name?: string }>;

  /** A Home whose profile keeps its pointer per user. */
  unreadableHome: HomeStandInOutput;

  /** Creates a profile keeping its pointer per user in `unreadableHome`. */
  createUnreadableProfile: Stream<void>;

  /** Points a profile of `unreadableHome` at the loom-shaped inbox. */
  pointUnreadableProfileAtLoom: Stream<PointElsewhereRequest>;

  /** Ensures `unreadableHome`'s inbox, with the event the host sends. */
  ensureUnreadable: Stream<EnsurePrivateInboxEvent>;

  /** A Home whose inbox a client requests, as a loom daemon does. */
  requestingHome: HomeStandInOutput;

  /** Creates one of `requestingHome`'s profiles. */
  createRequestingProfile: Stream<void>;

  /** Creates a profile of `requestingHome`'s without `setInbox`. */
  createRequestingPointerOnlyProfile: Stream<void>;

  /** Points one of `requestingHome`'s profiles at the loom-shaped inbox. */
  pointRequestingProfileAtLoom: Stream<PointElsewhereRequest>;

  /** A Home with no profiles, whose inbox a client requests. */
  profilelessHome: HomeStandInOutput;

  /** A Home whose first profile leaves its list once its inbox is requested. */
  leavingHome: HomeStandInOutput;

  /** Creates one of `leavingHome`'s profiles. */
  createLeavingProfile: Stream<void>;

  /** Points one of `leavingHome`'s profiles at the loom-shaped inbox. */
  pointLeavingProfileAtLoom: Stream<PointElsewhereRequest>;

  /** Takes `leavingHome`'s first profile out of its list. */
  dropLeavingFirstProfile: Stream<void>;

  /**
   * A Home holding an inbox it did not make, whose profile points at another
   * it did not make.
   */
  holdingHome: HomeStandInOutput;

  /** The inbox `holdingHome` holds, shaped as a loom daemon's. */
  holdingHeldInbox: PrivateInboxHolder;

  /** The inbox `holdingHome`'s profile points at, shaped as a loom daemon's. */
  holdingDecidingInbox: PrivateInboxHolder;

  /** Creates one of `holdingHome`'s profiles. */
  createHoldingProfile: Stream<void>;

  /** Creates an inbox as `createLoomInbox` does, kept in `holdingHeldInbox`. */
  createHoldingHeldInbox: Stream<void>;

  /**
   * Creates an inbox as `createLoomInbox` does, kept in
   * `holdingDecidingInbox`.
   */
  createHoldingDecidingInbox: Stream<void>;

  /** Has `holdingHome` hold the inbox in `holdingHeldInbox`. */
  holdHoldingInbox: Stream<void>;

  /** Points one of `holdingHome`'s profiles at `holdingDecidingInbox`'s. */
  pointHoldingProfileAtDeciding: Stream<PointElsewhereRequest>;

  /** Sends an offer through `holdingHome`'s first profile. */
  offerToHolding: Stream<OfferRequest>;

  /**
   * A Home holding an inbox it did not make, which its profile points at
   * through a pointer carrying the owner's label, as a pointer can come to
   * carry its inbox's.
   */
  labeledHoldingHome: HomeStandInOutput;

  /** The inbox `labeledHoldingHome` holds, shaped as a loom daemon's. */
  labeledHoldingInbox: PrivateInboxHolder;

  /**
   * Creates one of `labeledHoldingHome`'s profiles, its pointer carrying the
   * owner's label.
   */
  createLabeledHoldingProfile: Stream<void>;

  /**
   * Creates an inbox as `createLoomInbox` does, kept in
   * `labeledHoldingInbox`.
   */
  createLabeledHoldingInbox: Stream<void>;

  /**
   * Has `labeledHoldingHome` hold the inbox its first profile points at,
   * through the labeled pointer.
   */
  holdLabeledHoldingInbox: Stream<void>;

  /**
   * Points one of `labeledHoldingHome`'s profiles at `labeledHoldingInbox`'s.
   */
  pointLabeledHoldingProfile: Stream<PointElsewhereRequest>;
}

export default pattern<MainInput, MainOutput>((
  { privateInbox, profiles, otherInbox, copiedOffers },
) => {
  const loomInbox = new Writable<PrivateInboxHolder>({}).for("loomInbox");
  const homeMadeInbox = new Writable<PrivateInboxHolder>({}).for(
    "homeMadeInbox",
  );
  const strangerInbox = new Writable<PrivateInboxHolder>({}).for(
    "strangerInbox",
  );
  const readoptLoomInbox = new Writable<PrivateInboxHolder>({}).for(
    "readoptLoomInbox",
  );
  const cureInbox = new Writable<PrivateInboxHolder>({}).for("cureInbox");
  const unreadableInbox = new Writable<PrivateInboxHolder>({}).for(
    "unreadableInbox",
  );
  const retainedPrivateInboxes = new Writable<RetainedPrivateInboxes>([]).for(
    "retainedPrivateInboxes",
  );
  const privateInboxRefusal = new Writable<PrivateInboxRefusalHolder>({}).for(
    "privateInboxRefusal",
  );
  const adoptingHome = HomeStandIn({ label: "Adopting Home" });
  const refusingHome = HomeStandIn({ label: "Refusing Home" });
  const curedHome = HomeStandIn({ label: "Cured Home" });
  const creatingHome = HomeStandIn({ label: "Creating Home" });
  const olderHome = OlderHomeStandIn({});
  const readoptingHome = HomeStandIn({ label: "Home adopting again" });
  const replacingHome = HomeStandIn({ label: "Replacing Home" });
  const racingHome = HomeStandIn({ label: "Home pointed twice at once" });
  const ownSpaceHome = HomeStandIn({ label: "Home refused its own inbox" });
  const unreadableRefusedHome = HomeStandIn({
    label: "Home refused an inbox it cannot read",
  });
  const unreadableHome = HomeStandIn({
    label: "Home of an unreadable profile",
  });
  const requestingHome = HomeStandIn({ label: "Requested Home" });
  const profilelessHome = HomeStandIn({ label: "Home with no profiles" });
  const leavingHome = HomeStandIn({ label: "Home losing a profile" });
  const holdingHome = HomeStandIn({ label: "Home holding a loom's inbox" });
  const holdingHeldInbox = new Writable<PrivateInboxHolder>({}).for(
    "holdingHeldInbox",
  );
  const holdingDecidingInbox = new Writable<PrivateInboxHolder>({}).for(
    "holdingDecidingInbox",
  );
  const labeledHoldingHome = HomeStandIn({
    label: "Home holding a loom's inbox through a labeled pointer",
  });
  const labeledHoldingInbox = new Writable<PrivateInboxHolder>({}).for(
    "labeledHoldingInbox",
  );
  const ownPrivateInbox = new Writable<PrivateInboxHolder>({}).for(
    "ownPrivateInbox",
  );
  const mainPointProfiles = pointProfilesAtPrivateInbox({
    privateInbox,
    retainedPrivateInboxes,
    // deno-lint-ignore no-explicit-any
    profiles: profiles as any,
  });
  return {
    [NAME]: "Private inbox fixture",
    [UI]: <div>private inbox fixture</div>,
    privateInbox,
    profiles,
    otherInbox,
    loomInbox,
    homeMadeInbox,
    strangerInbox,
    readoptLoomInbox,
    cureInbox,
    unreadableInbox,
    adoptingHome,
    refusingHome,
    curedHome,
    creatingHome,
    readoptingHome,
    replacingHome,
    racingHome,
    ownSpaceHome,
    unreadableRefusedHome,
    olderHome,
    requestingHome,
    profilelessHome,
    leavingHome,
    holdingHome,
    holdingHeldInbox,
    holdingDecidingInbox,
    labeledHoldingHome,
    labeledHoldingInbox,
    copiedOffers,
    ownPrivateInbox,
    retainedPrivateInboxes,
    privateInboxRefusal,
    ensurePrivateInbox: ensurePrivateInbox({
      privateInbox,
      ownPrivateInbox,
      retainedPrivateInboxes,
      privateInboxRefusal,
      // deno-lint-ignore no-explicit-any
      profiles: profiles as any,
      pointProfiles: mainPointProfiles,
      createOwn: createOwnPrivateInbox({
        ownPrivateInbox,
        ensure: ensurePrivateInboxOnly({
          privateInbox,
          ownPrivateInbox,
          retainedPrivateInboxes,
          privateInboxRefusal,
          // deno-lint-ignore no-explicit-any
          profiles: profiles as any,
          pointProfiles: mainPointProfiles,
        }),
      }),
    }),
    createOwnPrivateInbox: createOwnPrivateInboxOnly({ ownPrivateInbox }),
    createProfile: createProfile({
      profiles,
      seedName: seedProfileName({}),
    }),
    createEarlierProfile: createEarlierProfile({ profiles }),
    createOtherInbox: createOtherInbox({ otherInbox }),
    pointProfileElsewhere: pointProfileAt({ profiles, inbox: otherInbox }),
    createLoomInbox: createSharedInbox({ inbox: loomInbox }),
    createStrangerInbox: createSharedInbox({ inbox: strangerInbox }),
    createAdoptingProfile: adoptingHome.createProfile,
    createAdoptingEarlierProfile: adoptingHome.createEarlierProfile,
    createHomeMadeInbox: createHomeMadeInbox({ inbox: homeMadeInbox }),
    pointAdoptingProfileAtHomeMade: pointProfileAt({
      profiles: adoptingHome.profiles,
      inbox: homeMadeInbox,
    }),
    pointAdoptingProfileAtOther: pointProfileAt({
      profiles: adoptingHome.profiles,
      inbox: otherInbox,
    }),
    createRefusingProfile: refusingHome.createProfile,
    pointRefusingProfileAtStranger: pointProfileAt({
      profiles: refusingHome.profiles,
      inbox: strangerInbox,
    }),
    createReplacingProfile: replacingHome.createProfile,
    pointReplacingProfileAtStranger: pointProfileAt({
      profiles: replacingHome.profiles,
      inbox: strangerInbox,
    }),
    replaceReplacingInbox: replacingHome.replaceRefusedPrivateInbox,
    createRacingProfile: racingHome.createProfile,
    pointRacingProfileAtLoomIfUnset: pointProfileAtIfUnset({
      profiles: racingHome.profiles,
      inbox: loomInbox,
    }),
    pointRacingProfileAtOtherIfUnset: pointProfileAtIfUnset({
      profiles: racingHome.profiles,
      inbox: otherInbox,
    }),
    createOwnSpaceProfile: ownSpaceHome.createProfile,
    pointOwnSpaceProfileAtPrivateInbox: pointProfileAt({
      profiles: ownSpaceHome.profiles,
      inbox: privateInbox,
    }),
    ensureOwnSpace: ownSpaceHome.ensurePrivateInbox,
    refuseOwnSpaceInbox: recordRefusalOf({
      inbox: privateInbox,
      refusal: ownSpaceHome.privateInboxRefusal,
    }),
    replaceOwnSpaceInbox: ownSpaceHome.replaceRefusedPrivateInbox,
    createUnreadableInbox: createReadableByInbox({ inbox: unreadableInbox }),
    revokeUnreadableInbox: revokeReader({ inbox: unreadableInbox }),
    createUnreadableRefusedProfile: unreadableRefusedHome.createProfile,
    pointUnreadableRefusedProfile: pointProfileAt({
      profiles: unreadableRefusedHome.profiles,
      inbox: unreadableInbox,
    }),
    replaceUnreadableRefusedInbox:
      unreadableRefusedHome.replaceRefusedPrivateInbox,
    createCureInbox: createSharedInbox({ inbox: cureInbox }),
    createCuredProfile: curedHome.createProfile,
    pointCuredProfileAtStranger: pointProfileAt({
      profiles: curedHome.profiles,
      inbox: strangerInbox,
    }),
    pointCuredProfileAtCure: pointProfileAt({
      profiles: curedHome.profiles,
      inbox: cureInbox,
    }),
    createCreatingProfile: creatingHome.createProfile,
    pointCreatingProfileAtStranger: pointProfileAt({
      profiles: creatingHome.profiles,
      inbox: strangerInbox,
    }),
    dropCreatingProfiles: dropProfiles({ profiles: creatingHome.profiles }),
    createOlderProfile: olderHome.createProfile,
    pointOlderProfileAtStranger: pointProfileAt({
      profiles: olderHome.profiles,
      inbox: strangerInbox,
    }),
    createReadoptLoomInbox: createSharedInbox({ inbox: readoptLoomInbox }),
    createReadoptingProfile: readoptingHome.createProfile,
    pointReadoptingProfileAtLoom: pointProfileAt({
      profiles: readoptingHome.profiles,
      inbox: readoptLoomInbox,
    }),
    offerToReadopting: offer({ profiles: readoptingHome.profiles }),
    setReadoptingDefault: readoptingHome.setDefaultProfile,
    offer: offer({ profiles }),
    queuedOffer: queueOffer({ send: sendToPointedInbox({ profiles }) }),
    copyOffers: copyOffers({ privateInbox, copiedOffers }),
    unreadableHome,
    createUnreadableProfile: createUserScopedProfile({
      profiles: unreadableHome.profiles,
    }),
    pointUnreadableProfileAtLoom: pointProfileAt({
      profiles: unreadableHome.profiles,
      inbox: loomInbox,
    }),
    ensureUnreadable: unreadableHome.ensurePrivateInbox,
    createRequestingProfile: requestingHome.createProfile,
    createLeavingProfile: leavingHome.createProfile,
    pointLeavingProfileAtLoom: pointProfileAt({
      profiles: leavingHome.profiles,
      inbox: loomInbox,
    }),
    dropLeavingFirstProfile: dropFirstProfile({
      profiles: leavingHome.profiles,
    }),
    createHoldingProfile: holdingHome.createProfile,
    createHoldingHeldInbox: createSharedInbox({ inbox: holdingHeldInbox }),
    createHoldingDecidingInbox: createSharedInbox({
      inbox: holdingDecidingInbox,
    }),
    holdHoldingInbox: holdInbox({
      privateInbox: holdingHome.privateInbox,
      inbox: holdingHeldInbox,
    }),
    pointHoldingProfileAtDeciding: pointProfileAt({
      profiles: holdingHome.profiles,
      inbox: holdingDecidingInbox,
    }),
    offerToHolding: offer({ profiles: holdingHome.profiles }),
    createLabeledHoldingProfile: createLabeledProfile({
      profiles: labeledHoldingHome.profiles,
      seedName: seedProfileName({}),
    }),
    createLabeledHoldingInbox: createSharedInbox({
      inbox: labeledHoldingInbox,
    }),
    holdLabeledHoldingInbox: holdFirstProfileInbox({
      privateInbox: labeledHoldingHome.privateInbox,
      profiles: labeledHoldingHome.profiles,
    }),
    pointLabeledHoldingProfile: pointProfileAt({
      profiles: labeledHoldingHome.profiles,
      inbox: labeledHoldingInbox,
    }),
    createRequestingPointerOnlyProfile: createPointerOnlyProfile({
      profiles: requestingHome.profiles,
    }),
    pointRequestingProfileAtLoom: pointProfileAt({
      profiles: requestingHome.profiles,
      inbox: loomInbox,
    }),
    createProfileThroughSurface: ProfileCreate({
      // deno-lint-ignore no-explicit-any
      profiles: profiles as any,
      // deno-lint-ignore no-explicit-any
      privateInbox: privateInbox as any,
    }).createProfile,
  };
});
