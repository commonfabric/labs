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

/** Creates one of the owner's profiles, in a space of its own. */
const createProfile = handler<
  void,
  { profiles: Writable<ProfileHomeOutput[]> }
>((_event, { profiles }) => {
  profiles.push(
    ProfileHome.inSpace(undefined, { grants: { "*": "READ" } })({
      initialName: "Owner",
    }) as ProfileHomeOutput,
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

/** Points the owner's second profile at the other inbox. */
const pointSecondProfileElsewhere = handler<
  void,
  {
    profiles: Writable<ProfileHomeOutput[]>;
    otherInbox: Writable<PrivateInboxHolder>;
  }
>((_event, { profiles, otherInbox }) => {
  profiles.key(1).resolveAsCell().key("setInbox").send({
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

  /** Creates an inbox other than the private inbox. */
  createOtherInbox: Stream<void>;

  /** Points the owner's second profile at the other inbox. */
  pointSecondProfileElsewhere: Stream<void>;

  /** Sends an offer through the owner's first profile. */
  offer: Stream<OfferRequest>;

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
  createOtherInbox: createOtherInbox({ otherInbox }),
  pointSecondProfileElsewhere: pointSecondProfileElsewhere({
    profiles,
    otherInbox,
  }),
  offer: offer({ profiles }),
  copyOffers: copyOffers({ privateInbox, copiedOffers }),
}));
