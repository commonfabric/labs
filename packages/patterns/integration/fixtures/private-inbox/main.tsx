/**
 * Stands in for Home around the system private inbox: it holds the inbox and
 * the owner's profiles, and gives a sender and a stranger handlers of their
 * own that reach the inbox through a profile. Four more stand-ins,
 * `adoptingHome`, `refusingHome`, `curedHome` and `creatingHome`, are Homes
 * whose profiles already point at inboxes when the host first ensures their
 * own, and a fifth, `readoptingHome`, is one whose default profile is pointed
 * elsewhere after it holds an inbox. `olderHome` stands in for a Home of the vintage
 * whose ensure takes no refusal. Fixture for
 * `private-inbox-multi-runtime.test.ts`.
 */

import {
  type Cell,
  currentPrincipal,
  Default,
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import EarlierProfile from "./earlier-profile.tsx";
import ProfileCreate from "../../../system/profile-create.tsx";
import ProfileHome, {
  type ProfileHomeOutput,
} from "../../../system/profile-home.tsx";
import PrivateInbox, {
  ensurePrivateInbox,
  type EnsurePrivateInboxEvent,
  type Offer,
  type OfferEvent,
  pointProfilesAtPrivateInbox,
  type PointTarget,
  type PrivateInboxHolder,
  type PrivateInboxOutput,
  type PrivateInboxPiece,
  type PrivateInboxRefusalHolder,
  type RetainedPrivateInboxes,
} from "../../../system/private-inbox.tsx";

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
}

/**
 * The envelope a sender sends for `request`, from the principal sending the
 * event.
 */
function envelopeOf(request: OfferRequest): OfferEvent {
  return {
    kind: "fabrichat-room",
    id: request.id,
    space: request.space,
    host: OFFER_HOST,
    ownerOrigin: OFFER_HOST,
    title: request.title,
    from: currentPrincipal(),
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
 * anyone `WRITE`, as `profile-create.tsx` does.
 */
const createProfile = handler<
  void,
  { profiles: Writable<ProfileHomeOutput[]> }
>((_event, { profiles }) => {
  profiles.push(
    ProfileHome.inSpace(undefined, { grants: { "*": "WRITE" } })({
      initialName: "Owner",
    }) as ProfileHomeOutput,
  );
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
  profiles.key(event.index).resolveAsCell().key("setInbox").send({
    inbox: inbox.get().piece?.resolveAsCell(),
  });
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
  retainedPrivateInboxes: RetainedPrivateInboxes;
  privateInboxRefusal: PrivateInboxRefusalHolder;
  profiles: ProfileHomeOutput[];
  defaultProfile: DefaultProfileSlot;

  /** Makes one of the Home's profiles its default. */
  setDefaultProfile: Stream<PointElsewhereRequest>;

  /** Gives the Home a private inbox, as Home's own stream does. */
  ensurePrivateInbox: Stream<EnsurePrivateInboxEvent>;

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
    const retainedPrivateInboxes = new Writable<RetainedPrivateInboxes>([])
      .for("retainedPrivateInboxes");
    const privateInboxRefusal = new Writable<PrivateInboxRefusalHolder>({})
      .for("privateInboxRefusal");
    const profiles = new Writable<ProfileHomeOutput[]>([]).for("profiles");
    const defaultProfile = new Writable<DefaultProfileSlot>({}).for(
      "defaultProfileSlot",
    );
    return {
      [NAME]: label,
      privateInbox,
      retainedPrivateInboxes,
      privateInboxRefusal,
      profiles,
      defaultProfile,
      setDefaultProfile: setDefaultProfile({ profiles, defaultProfile }),
      ensurePrivateInbox: ensurePrivateInbox({
        privateInbox,
        retainedPrivateInboxes,
        privateInboxRefusal,
        // deno-lint-ignore no-explicit-any
        profiles: profiles as any,
        pointProfiles: pointProfilesAtPrivateInbox({
          privateInbox,
          // deno-lint-ignore no-explicit-any
          profiles: profiles as any,
        }),
      }),
      createProfile: createProfile({ profiles }),
      createEarlierProfile: createEarlierProfile({ profiles }),
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
      createProfile: createProfile({ profiles }),
    };
  },
);

/**
 * Sends an offer to the inbox the owner's first profile points at, from the
 * event's actor's own handler.
 */
const offer = handler<
  OfferRequest,
  { profiles: Writable<ProfileHomeOutput[]> }
>((event, { profiles }) => {
  const inbox = inboxOf(
    profiles.key(0).resolveAsCell().key("inbox").key("piece").resolveAsCell(),
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
  strangerInbox: PrivateInboxHolder;
  readoptLoomInbox: PrivateInboxHolder;
  cureInbox: PrivateInboxHolder;
  adoptingHome: HomeStandInOutput;
  refusingHome: HomeStandInOutput;
  curedHome: HomeStandInOutput;
  creatingHome: HomeStandInOutput;
  readoptingHome: HomeStandInOutput;
  olderHome: OlderHomeStandInOutput;
  copiedOffers: CopiedOffer[];
  retainedPrivateInboxes: RetainedPrivateInboxes;
  privateInboxRefusal: PrivateInboxRefusalHolder;

  /**
   * Gives the stand-in Home the private inbox its profiles advertise, or one of
   * its own, and points profiles at it.
   */
  ensurePrivateInbox: Stream<EnsurePrivateInboxEvent>;

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

  /** Points one of `adoptingHome`'s profiles at the loom-shaped inbox. */
  pointAdoptingProfileAtLoom: Stream<PointElsewhereRequest>;

  /** Points one of `adoptingHome`'s profiles at the other inbox. */
  pointAdoptingProfileAtOther: Stream<PointElsewhereRequest>;

  /** Creates one of `refusingHome`'s profiles. */
  createRefusingProfile: Stream<void>;

  /** Points one of `refusingHome`'s profiles at the stranger's inbox. */
  pointRefusingProfileAtStranger: Stream<PointElsewhereRequest>;

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

  /** Sends an offer through `readoptingHome`'s first profile. */
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
}

export default pattern<MainInput, MainOutput>((
  { privateInbox, profiles, otherInbox, copiedOffers },
) => {
  const loomInbox = new Writable<PrivateInboxHolder>({}).for("loomInbox");
  const strangerInbox = new Writable<PrivateInboxHolder>({}).for(
    "strangerInbox",
  );
  const readoptLoomInbox = new Writable<PrivateInboxHolder>({}).for(
    "readoptLoomInbox",
  );
  const cureInbox = new Writable<PrivateInboxHolder>({}).for("cureInbox");
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
  return {
    [NAME]: "Private inbox fixture",
    [UI]: <div>private inbox fixture</div>,
    privateInbox,
    profiles,
    otherInbox,
    loomInbox,
    strangerInbox,
    readoptLoomInbox,
    cureInbox,
    adoptingHome,
    refusingHome,
    curedHome,
    creatingHome,
    readoptingHome,
    olderHome,
    copiedOffers,
    retainedPrivateInboxes,
    privateInboxRefusal,
    ensurePrivateInbox: ensurePrivateInbox({
      privateInbox,
      retainedPrivateInboxes,
      privateInboxRefusal,
      // deno-lint-ignore no-explicit-any
      profiles: profiles as any,
      pointProfiles: pointProfilesAtPrivateInbox({
        privateInbox,
        // deno-lint-ignore no-explicit-any
        profiles: profiles as any,
      }),
    }),
    createProfile: createProfile({ profiles }),
    createEarlierProfile: createEarlierProfile({ profiles }),
    createOtherInbox: createOtherInbox({ otherInbox }),
    pointProfileElsewhere: pointProfileAt({ profiles, inbox: otherInbox }),
    createLoomInbox: createSharedInbox({ inbox: loomInbox }),
    createStrangerInbox: createSharedInbox({ inbox: strangerInbox }),
    createAdoptingProfile: adoptingHome.createProfile,
    createAdoptingEarlierProfile: adoptingHome.createEarlierProfile,
    pointAdoptingProfileAtLoom: pointProfileAt({
      profiles: adoptingHome.profiles,
      inbox: loomInbox,
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
    createProfileThroughSurface: ProfileCreate({
      // deno-lint-ignore no-explicit-any
      profiles: profiles as any,
      // deno-lint-ignore no-explicit-any
      privateInbox: privateInbox as any,
    }).createProfile,
  };
});
