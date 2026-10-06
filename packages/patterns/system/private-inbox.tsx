/**
 * The private inbox: one piece per identity, in a space of its own, where other
 * principals deliver offers to the identity, such as a chat room to join. Home
 * holds the identity's inbox, and each of the identity's profiles points at it
 * through its `inbox` field, which is how a sender finds it.
 *
 * The list and each offer in it carry a confidentiality label for the
 * principal who created the inbox, so a runtime holding the inbox refuses to
 * let another principal's code copy them out. It does not stop that code
 * reading them: `receive` itself reads every offer, in the sender's runtime
 * when server execution is off. The space grants every principal `WRITE`, so
 * anyone holding a memory client can read, rewrite or remove the offers, label
 * or no label, and a row's `from` is a claim a reader checks for itself.
 * `docs/features/private-inbox.md` describes the whole arrangement.
 */

import {
  type Cell,
  type Confidential,
  type CurrentPrincipal,
  currentPrincipal,
  Default,
  handler,
  isWellFormedDID,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  type InboxPointable,
  pointAtInboxIfUnset,
  type ShareInboxPiece,
} from "./profile-home.tsx";

/** The longest `kind` an offer keeps; a longer one is cut to this length. */
export const OFFER_KIND_MAX_LENGTH = 32;

/** The longest `id` an offer keeps; a longer one is cut to this length. */
export const OFFER_ID_MAX_LENGTH = 320;

/** The longest `title` an offer keeps; a longer one is cut to this length. */
export const OFFER_TITLE_MAX_LENGTH = 200;

/**
 * The length `space`, `host`, `from` and `ownerOrigin` are cut to before they
 * are checked.
 */
export const OFFER_ADDRESS_MAX_LENGTH = 256;

/** The `kind` an offer that names none is kept with. */
export const OFFER_DEFAULT_KIND = "loom";

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

/**
 * An offer as a sender sends it to `receive`: the envelope a loom share inbox
 * takes. Every field is optional here, and `receive` decides what it keeps.
 */
export interface OfferEvent {
  /**
   * What is offered, such as `loom` or `fabrichat-room`. A reader acts only on
   * the kinds it knows.
   */
  kind?: string;

  /**
   * The sender's key for the offer, the same on every resend of it. The inbox
   * keeps one offer per sender and `id`.
   */
  id?: string;

  /** The DID of the space the offered thing lives in. */
  space?: string;

  /** The origin of the host serving that space, such as `https://example.com`. */
  host?: string;

  /** The origin of the sender's own host, if it names one. */
  ownerOrigin?: string;

  /** What the sender calls the offered thing. */
  title?: string;

  /** The DID of the sender, which must be the principal sending the event. */
  from?: string;

  /** When the sender shared the offer, in milliseconds since the epoch. */
  sharedAt?: number;
}

/** An offer as the inbox holds it: every field of the envelope, and more. */
export interface Offer {
  /** What is offered, such as `loom` or `fabrichat-room`. */
  kind: string;

  /**
   * The sender's key for the offer; no two offers in the inbox from one sender
   * share one.
   */
  id: string;

  /** The DID of the space the offered thing lives in. */
  space: string;

  /** The origin of the host serving that space. */
  host: string;

  /** The origin of the sender's own host, or empty. */
  ownerOrigin: string;

  /** What the sender calls the offered thing, or empty. */
  title: string;

  /**
   * The DID the offer names as its sender. `receive` keeps an offer only when
   * this is the event's actor, but any principal may write the list without
   * `receive`, so to a reader this is the sender's claim, which it checks for
   * itself before trusting it.
   */
  from: string;

  /**
   * When the sender shared the offer, in milliseconds since the epoch, by the
   * sender's clock, or by the inbox's when the sender named no time.
   */
  sharedAt: number;

  /**
   * When the inbox received the offer, in milliseconds since the epoch. A
   * handler's clock reads to the second, so two offers can share it.
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

  /** The offers received, labeled readable by the inbox's owner alone. */
  offers: Offers;

  /** Appends an offer from the principal sending it, unless it is refused. */
  receive: Stream<OfferEvent>;
}

/**
 * What Home and a profile know of the inbox piece: its name, at most. A
 * profile types any inbox it points at this way, this one or a loom daemon's,
 * so the type is the profile's own.
 */
export type PrivateInboxPiece = ShareInboxPiece;

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
export type PointTarget = InboxPointable;

/**
 * Whether `value` is an `http` or `https` origin written as its own canonical
 * origin: it parses as a URL whose origin is `value` itself, so it holds no
 * user information, path, query or fragment, names no default port, has a
 * lowercase host and scheme, and no port out of range.
 */
function isOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "https:" || url.protocol === "http:") &&
    url.origin === value;
}

/**
 * The message an append to a cell starts with when what the cell holds is not
 * a list.
 */
const NON_LIST_APPEND_MESSAGE =
  "Cell.push() or Cell.pushAll() requires transaction and array value";

/**
 * Whether `error` is an append's refusal of a cell that holds something other
 * than a list. The runtime gives that refusal no type of its own, so its
 * message is the signal; the same message also covers an append made outside
 * a transaction, which cannot happen in a handler.
 */
export function isNonListAppendRefusal(error: unknown): boolean {
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" &&
    message.startsWith(NON_LIST_APPEND_MESSAGE);
}

/** `value` trimmed and cut to `max` characters, or empty if not a string. */
function trimmedText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Returns the offer the inbox keeps for `event`, received at `now` by its
 * clock, or `undefined` when the event is refused. Every string is trimmed and
 * cut to its length. The event is refused unless `space` and `from` are
 * well-formed DIDs, by `isWellFormedDID()`, and `host` is an origin, by
 * {@link isOrigin}. An event with no `kind` is kept as
 * {@link OFFER_DEFAULT_KIND}, one with no `id` as `<space>@<sharedAt>`, one
 * with no positive `sharedAt` as shared at `now`, and an `ownerOrigin` that is
 * not an origin is kept empty.
 */
function admissibleOffer(event: OfferEvent, now: number): Offer | undefined {
  const space = trimmedText(event?.space, OFFER_ADDRESS_MAX_LENGTH);
  const host = trimmedText(event?.host, OFFER_ADDRESS_MAX_LENGTH);
  const from = trimmedText(event?.from, OFFER_ADDRESS_MAX_LENGTH);
  if (
    !isWellFormedDID(space) || !isOrigin(host) || !isWellFormedDID(from)
  ) {
    return undefined;
  }
  const claimed = Number(event?.sharedAt);
  const sharedAt = Number.isFinite(claimed) && claimed > 0
    ? Math.floor(claimed)
    : Math.floor(now);
  const ownerOrigin = trimmedText(event?.ownerOrigin, OFFER_ADDRESS_MAX_LENGTH);
  return {
    kind: trimmedText(event?.kind, OFFER_KIND_MAX_LENGTH) || OFFER_DEFAULT_KIND,
    id: trimmedText(event?.id, OFFER_ID_MAX_LENGTH) || `${space}@${sharedAt}`,
    space,
    host,
    ownerOrigin: isOrigin(ownerOrigin) ? ownerOrigin : "",
    title: trimmedText(event?.title, OFFER_TITLE_MAX_LENGTH),
    from,
    sharedAt,
    receivedAt: Math.floor(now),
  };
}

/**
 * Appends the offer `event` describes, as {@link admissibleOffer} keeps it.
 * Nothing is appended for a refused event, for one whose `from` is not the
 * event's actor, or for one whose sender already has an offer in the inbox
 * under its `id`. Keying on the sender too means no writer can take another
 * sender's `id` first. Nothing is appended either while `offers` holds
 * something other than a list, which is left as it is.
 */
const receive = handler<OfferEvent, { offers: Writable<Offers> }>(
  (event, { offers }) => {
    const offer = admissibleOffer(event, Date.now());
    if (offer === undefined || offer.from !== currentPrincipal()) return;
    // The explicit read keeps the append in the conflict set, so two
    // deliveries of one offer racing to append conflict, and the second sees
    // the first.
    if (
      (offers.get() ?? []).some((held) =>
        held?.from === offer.from && held?.id === offer.id
      )
    ) {
      return;
    }
    // A writer bypassing `receive` can replace `offers` with something other
    // than a list. The typed read above presents that as an empty list, and
    // the append refuses it by throwing; the value is left as it is, and
    // nothing is kept. Any other failure of the append propagates.
    try {
      offers.push(offer);
    } catch (error) {
      if (!isNonListAppendRefusal(error)) throw error;
    }
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
        What others have offered you arrives here.
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
 * The inbox the first profile in `profiles` that points at one points at, or
 * `undefined` when none does. Call it from a handler, with `profiles` bound as
 * a value of type {@link PointTarget}, so that each pointer is read as a typed
 * link.
 */
export function advertisedInbox(
  profiles: readonly (PointTarget | undefined)[] | undefined,
): Cell<PrivateInboxPiece> | undefined {
  for (const profile of profiles ?? []) {
    const piece = profile?.inbox?.piece;
    if (piece !== undefined) return piece.resolveAsCell();
  }
  return undefined;
}

/**
 * Gives Home a private inbox if it holds none, then has each profile in Home's
 * list that points at no inbox point at Home's. An inbox Home holds is kept.
 * Otherwise Home adopts the inbox a profile already advertises, the first in
 * list order that points at one, whether Home created it or a loom daemon did,
 * and creates an inbox only when no profile points at one. A profile pointing
 * at another inbox keeps its pointer. Running it again creates nothing and
 * re-points nothing.
 *
 * The inbox's space is named in Home's own space, so one identity gets one
 * such space however many times, and from however many runtimes, this runs.
 * The space grants every principal `WRITE`, so a sender's write is admitted
 * whether the sender's own runtime makes it or the space's server does.
 *
 * The list is bound as a value: the runner resolves it before the body runs,
 * and withdraws the dispatch until every profile it names has loaded, so an
 * unloaded profile is never taken for one that advertises no inbox.
 *
 * The pointing is a second step, queued behind this one. A profile is given
 * the inbox's own result document, which this handler's run may create, so the
 * profiles are pointed in an event of its own, once this run has committed.
 */
export const ensurePrivateInbox = handler<
  void,
  {
    privateInbox: Writable<PrivateInboxHolder>;
    profiles: PointTarget[];
    pointProfiles: Stream<void>;
  }
>((_event, { privateInbox, profiles, pointProfiles }) => {
  if (privateInbox.get()?.piece === undefined) {
    const piece = advertisedInbox(profiles) ?? inboxLinkOf(
      PrivateInbox.inSpace(PRIVATE_INBOX_SPACE_NAME, {
        grants: { "*": "WRITE" },
      })({ offers: [] }),
    );
    privateInbox.set({ piece });
  }
  pointProfiles.send();
});

/**
 * Points each profile in `profiles` that points at no inbox at Home's private
 * inbox, as `pointAtInboxIfUnset()` does.
 *
 * The list is bound as a value: the runner resolves it before the body runs,
 * and withdraws the dispatch until every profile it names has loaded, so an
 * unloaded profile is never taken for one with no inbox.
 */
export const pointProfilesAtPrivateInbox = handler<
  void,
  {
    privateInbox: PrivateInboxHolder;
    profiles: PointTarget[];
  }
>((_event, { privateInbox, profiles }) => {
  for (const profile of profiles ?? []) {
    pointAtInboxIfUnset(profile, privateInbox);
  }
});

export default PrivateInbox;
