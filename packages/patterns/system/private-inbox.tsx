/**
 * The private inbox: one piece per identity, in a space of its own, where other
 * principals deliver offers to the identity, such as a chat room to join. Home
 * holds the identity's inbox, and each of the identity's profiles points at it
 * through its `inbox` field, which is how a sender finds it.
 *
 * The offers are readable by the inbox's owner alone. The list and each offer
 * in it carry a confidentiality label for the principal who created the
 * inbox, so a runtime holding the inbox refuses to let another principal's
 * code read them or copy them out. The space's access list decides who may
 * write to it: the owner alone where server execution is on, since the
 * serving loop makes a sender's write, and every principal where it is not,
 * since a sender's own runtime makes the write. In the second case the space
 * is also readable by anyone holding a memory client, label or no label.
 * `docs/features/private-inbox.md` describes the whole arrangement.
 */

import {
  type Cell,
  type Confidential,
  type CurrentPrincipal,
  currentPrincipal,
  Default,
  eventKey,
  handler,
  isWellFormedDID,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import type { SetProfileInboxEvent } from "./profile-home.tsx";

/** The longest `kind` an offer may name. */
export const OFFER_KIND_MAX_LENGTH = 64;

/** The longest `title` an offer keeps; a longer one is cut to this length. */
export const OFFER_TITLE_MAX_LENGTH = 200;

/** The longest `host` an offer may name. */
export const OFFER_HOST_MAX_LENGTH = 256;

/** The name, in Home's space, of the space Home's private inbox lives in. */
export const PRIVATE_INBOX_SPACE_NAME = "private-inbox";

/** A value readable only by the principal who creates the inbox. */
export type OwnerPrivate<T> = Confidential<
  T,
  readonly [{
    type: "https://commonfabric.org/cfc/atom/User";
    subject: CurrentPrincipal;
  }]
>;

/** What an offer knows of the piece it offers: its name, at most. */
export type OfferEntry = {
  [NAME]?: string;
};

/** An offer as a sender sends it to `receive`. */
export interface OfferEvent {
  /**
   * What is offered, as lowercase words joined by hyphens, such as
   * `fabrichat-room`. A reader acts only on the kinds it knows.
   */
  kind: string;

  /**
   * The DID of the space the offered thing lives in. It may be left out when
   * `entry` is given, since a link names the space it reaches into.
   */
  space?: string;

  /**
   * The origin of the host serving the offered thing's space, such as
   * `https://example.com`; absent for the host the inbox is read from.
   */
  host?: string;

  // `Cell<…>` is written out rather than reached through an alias: the
  // handler's event schema marks a reference position only where the wrapper
  // is written in the event type.
  /**
   * The piece offered. A value sent here that is not a link arrives as a link
   * to the event's own copy of that value, so what it reaches is the sender's
   * claim, to be checked like any other.
   */
  entry?: Cell<OfferEntry>;

  /** What the sender calls the offered thing, cut to the longest kept. */
  title?: string;
}

/** An offer as the inbox holds it. */
export interface Offer {
  /**
   * What is offered, as lowercase words joined by hyphens, such as
   * `fabrichat-room`. A reader acts only on the kinds it knows.
   */
  kind: string;

  /** The DID of the space the offered thing lives in, if the sender named it. */
  space?: string;

  /**
   * The origin of the host serving the offered thing's space, if the sender
   * named one.
   */
  host?: string;

  /** The piece offered, if the sender named one. */
  entry?: Cell<OfferEntry>;

  /** What the sender calls the offered thing, if anything. */
  title?: string;

  /**
   * The DID of the principal who sent the offer: the actor of the event that
   * delivered it, which nothing in the event's payload can choose. Where
   * server execution is on, the serving loop stamps it; where it is not, the
   * sender's own runtime does.
   */
  from: string;

  /**
   * The offer's id: the event key of the event that delivered it, which
   * differs for every other delivery and which nothing in the event's payload
   * can choose. Every run of one delivery stamps the same id.
   */
  id: string;

  /**
   * When the inbox received the offer, in milliseconds since the epoch. A
   * handler's clock reads to the second, so two offers can share it; `id`
   * tells them apart.
   */
  receivedAt: number;
}

/** The inbox's offers, oldest first. */
export type Offers = OwnerPrivate<OwnerPrivate<Offer>[]>;

/** Arguments for {@link PrivateInbox}. */
export interface PrivateInboxInput {
  /** The offers received so far. */
  offers: Writable<Default<Offers, []>>;
}

/** The result of {@link PrivateInbox}. */
export interface PrivateInboxOutput {
  [NAME]: string;
  [UI]: VNode;

  /** The offers received, readable by the inbox's owner alone. */
  offers: Offers;

  /** Appends an offer, whoever sends it, unless it is malformed. */
  receive: Stream<OfferEvent>;
}

/** What Home and a profile know of the inbox piece: its name, at most. */
export type PrivateInboxPiece = {
  [NAME]?: string;
};

/**
 * Where Home keeps its private inbox: a link to the inbox piece, absent until
 * the inbox exists. The link sits under a key because a write to a cell whose
 * document root holds a link goes through the link into the piece it names.
 */
export type PrivateInboxHolder = {
  /** The inbox piece. */
  piece?: Cell<PrivateInboxPiece>;
};

/** What the pointing step needs of each profile in Home's list. */
export type PointTarget = {
  // The pointer is a typed link. The inbox labels its offers confidential to
  // its owner, and the link carries that label; read as an untyped link, it
  // joins that label from another space into this run, and the run is
  // refused. `private-inbox.pointer-type.test.ts` pins the type.
  inbox?: { piece?: Cell<PrivateInboxPiece> };
  setInbox: Stream<SetProfileInboxEvent>;
};

/**
 * Returns whether `kind` is a well-formed offer kind: lowercase letters and
 * digits in words joined by single hyphens, at most
 * {@link OFFER_KIND_MAX_LENGTH} characters.
 */
function isOfferKind(kind: unknown): kind is string {
  return typeof kind === "string" && kind.length <= OFFER_KIND_MAX_LENGTH &&
    /^[a-z0-9]+(-[a-z0-9]+)*$/.test(kind);
}

/**
 * Returns whether `host` is absent or a well-formed origin: `http` or `https`
 * and an authority, with no path, at most {@link OFFER_HOST_MAX_LENGTH}
 * characters.
 */
function isOfferHost(host: unknown): boolean {
  return host === undefined ||
    (typeof host === "string" && host.length <= OFFER_HOST_MAX_LENGTH &&
      /^https?:\/\/[^\s/?#@]+$/.test(host));
}

/**
 * Appends the offer `event` describes, stamped with the event's actor, its
 * event key as the offer's id, and the time. An event with no actor, with a malformed `kind` or `host`, with a
 * `space` that is not a DID, or with neither a `space` nor an `entry`, appends
 * nothing.
 */
const receive = handler<OfferEvent, { offers: Writable<Offers> }>(
  (event, { offers }) => {
    const from = currentPrincipal();
    if (
      from === undefined || !isOfferKind(event?.kind) ||
      !isOfferHost(event.host) ||
      (event.space === undefined
        ? event.entry === undefined
        : !isWellFormedDID(event.space))
    ) {
      return;
    }
    const title = typeof event.title === "string"
      ? event.title.slice(0, OFFER_TITLE_MAX_LENGTH)
      : undefined;
    offers.push({
      kind: event.kind,
      ...(event.space !== undefined ? { space: event.space } : {}),
      ...(event.host !== undefined ? { host: event.host } : {}),
      ...(event.entry !== undefined ? { entry: event.entry } : {}),
      ...(title !== undefined ? { title } : {}),
      from,
      id: eventKey(),
      receivedAt: Date.now(),
    });
  },
);

/** A private inbox: an owner-readable list of offers anyone may append to. */
const PrivateInbox = pattern<PrivateInboxInput, PrivateInboxOutput>((
  { offers },
) => ({
  [NAME]: "Private inbox",
  [UI]: (
    <cf-vstack gap="2" style={{ padding: "1rem" }}>
      <h2 style={{ margin: 0, fontSize: "16px" }}>Private inbox</h2>
      <span style={{ fontSize: "13px", color: "#666" }}>
        What others have offered you arrives here. Only you can read it.
      </span>
    </cf-vstack>
  ),
  offers,
  receive: receive({ offers }),
}));

/**
 * An inbox's result, as the link Home and a profile hold. The inbox is
 * created where the link can't be typed as a cell, and stored as a link to it.
 */
function inboxLinkOf(inbox: unknown): Cell<PrivateInboxPiece>;
function inboxLinkOf(inbox: unknown): unknown {
  return inbox;
}

/**
 * Creates Home's private inbox if Home holds none, then has each profile in
 * Home's list that points at no inbox point at Home's. Running it again
 * creates nothing and re-points nothing.
 *
 * The inbox's space is named in Home's own space, so one identity gets one
 * such space however many times, and from however many runtimes, this runs.
 * The space admits its owner alone where server execution is on, and every
 * principal's writes as well where it is not; see
 * `InSpaceOptions.grantsWithoutServerExecution`.
 *
 * The pointing is a second step, queued behind this one. A profile is given
 * the inbox's own result document, which this handler's run creates, so the
 * profiles are pointed in an event of its own, once this run has committed.
 */
export const ensurePrivateInbox = handler<
  void,
  {
    privateInbox: Writable<PrivateInboxHolder>;
    pointProfiles: Stream<void>;
  }
>((_event, { privateInbox, pointProfiles }) => {
  if (privateInbox.get()?.piece === undefined) {
    const piece = inboxLinkOf(
      PrivateInbox.inSpace(PRIVATE_INBOX_SPACE_NAME, {
        grantsWithoutServerExecution: { "*": "WRITE" },
      })({ offers: [] }),
    );
    privateInbox.set({ piece });
  }
  pointProfiles.send();
});

/**
 * Has each profile in `profiles` whose `inbox` points at nothing point at
 * Home's private inbox, through the profile's own `setInbox`. A profile that
 * points at an inbox already, whichever inbox it is, is left as it is.
 *
 * The list is bound as a value: the runner resolves it before the body runs,
 * and withdraws the dispatch until every profile it names has loaded, so an
 * unloaded profile is never taken for one with no inbox. The read and the
 * `setInbox` it leads to are two transactions in two spaces, so a pointer
 * set between them is replaced.
 */
export const pointProfilesAtPrivateInbox = handler<
  void,
  {
    privateInbox: PrivateInboxHolder;
    profiles: PointTarget[];
  }
>((_event, { privateInbox, profiles }) => {
  // The holder's link reaches the inbox through the cell the creating handler
  // wrote. A link written into a profile's labeled `inbox` takes its label from
  // the document it names, and only the inbox's own result document carries
  // the schema that label comes from, so the profile is given that document.
  const inbox = privateInbox?.piece?.resolveAsCell();
  if (inbox === undefined) return;
  for (const profile of profiles ?? []) {
    if (profile === undefined || profile.inbox?.piece !== undefined) continue;
    profile.setInbox.send({ inbox });
  }
});

export default PrivateInbox;
