/**
 * Stands in for Home around the system private inbox: it holds the inbox and
 * the owner's profiles, and gives a sender and a stranger handlers of their
 * own that reach the inbox through a profile. Fixture for
 * `private-inbox-multi-runtime.test.ts`.
 */

import {
  type Cell,
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
import ProfileHome, {
  type ProfileHomeOutput,
} from "../../../system/profile-home.tsx";
import PrivateInbox, {
  ensurePrivateInbox,
  type Offer,
  pointProfilesAtPrivateInbox,
  type PrivateInboxHolder,
  type PrivateInboxOutput,
  type PrivateInboxPiece,
} from "../../../system/private-inbox.tsx";

/** An offer a sender's handler sends on to the owner's inbox. */
export interface OfferRequest {
  /** The DID of the space offered. */
  space: string;

  /** What the sender calls it. */
  title: string;
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

/** Which of the owner's profiles to point at the other inbox. */
export interface PointElsewhereRequest {
  /** The profile's position in the owner's list. */
  index: number;
}

/** Points one of the owner's profiles at the other inbox. */
const pointProfileElsewhere = handler<
  PointElsewhereRequest,
  {
    profiles: Writable<ProfileHomeOutput[]>;
    otherInbox: Writable<PrivateInboxHolder>;
  }
>((event, { profiles, otherInbox }) => {
  profiles.key(event.index).resolveAsCell().key("setInbox").send({
    inbox: otherInbox.get().piece?.resolveAsCell(),
  });
});

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
  inbox.key("receive").send({
    kind: "fabrichat-room",
    space: event.space,
    title: event.title,
  });
});

/**
 * Queues `send` with the request, so the offer leaves from a handler that
 * another handler's run emitted, as an offer leaves a room's creation.
 */
const queueOffer = handler<OfferRequest, { send: Stream<OfferRequest> }>(
  (event, { send }) => {
    send.send({ space: event.space, title: event.title });
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
  inboxOf(pointer.resolveAsCell()).key("receive").send({
    kind: "fabrichat-room",
    space: event.space,
    title: event.title,
  });
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
  copiedOffers: CopiedOffer[];

  /** Creates the private inbox if there is none, and points profiles at it. */
  ensurePrivateInbox: Stream<void>;

  /** Creates one of the owner's profiles. */
  createProfile: Stream<void>;

  /** Creates a profile of an earlier vintage. */
  createEarlierProfile: Stream<void>;

  /** Creates an inbox other than the private inbox. */
  createOtherInbox: Stream<void>;

  /** Points one of the owner's profiles at the other inbox. */
  pointProfileElsewhere: Stream<PointElsewhereRequest>;

  /** Sends an offer through the owner's first profile. */
  offer: Stream<OfferRequest>;

  /**
   * Sends an offer to the inbox the owner's first profile points at, from a
   * handler this stream's handler queues.
   */
  queuedOffer: Stream<OfferRequest>;

  /** Copies the private inbox's offers into this piece. */
  copyOffers: Stream<void>;
}

export default pattern<MainInput, MainOutput>((
  { privateInbox, profiles, otherInbox, copiedOffers },
) => ({
  [NAME]: "Private inbox fixture",
  [UI]: <div>private inbox fixture</div>,
  privateInbox,
  profiles,
  otherInbox,
  copiedOffers,
  ensurePrivateInbox: ensurePrivateInbox({
    privateInbox,
    pointProfiles: pointProfilesAtPrivateInbox({
      privateInbox,
      // deno-lint-ignore no-explicit-any
      profiles: profiles as any,
    }),
  }),
  createProfile: createProfile({ profiles }),
  createEarlierProfile: createEarlierProfile({ profiles }),
  createOtherInbox: createOtherInbox({ otherInbox }),
  pointProfileElsewhere: pointProfileElsewhere({ profiles, otherInbox }),
  offer: offer({ profiles }),
  queuedOffer: queueOffer({ send: sendToPointedInbox({ profiles }) }),
  copyOffers: copyOffers({ privateInbox, copiedOffers }),
}));
