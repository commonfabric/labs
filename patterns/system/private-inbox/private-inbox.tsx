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
  type AnyCell,
  type Cell,
  computed,
  type Confidential,
  type CurrentPrincipal,
  currentPrincipal,
  Default,
  entityRefToString,
  equals,
  getEntityId,
  handler,
  isWellFormedDID,
  type JSONValue,
  NAME,
  pattern,
  spaceOf,
  type Stream,
  type TrustedActionWrite,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  type InboxPointable,
  pointAtInboxIfUnset,
  pointAtInboxInPlaceOf,
  type ProfileInbox,
  type ShareInboxPiece,
} from "../profile-home/profile-home.tsx";

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

/**
 * The longest refusal code Home records; a longer one is cut to this length.
 */
export const REFUSAL_REASON_MAX_LENGTH = 64;

/** The `kind` an offer that names none is kept with. */
export const OFFER_DEFAULT_KIND = "loom";

/** The name, in Home's space, of the space Home's private inbox lives in. */
export const PRIVATE_INBOX_SPACE_NAME = "private-inbox";

/**
 * The trusted surface Home renders its private-inbox refusal notice on, which
 * carries the button that replaces the refused inbox.
 */
export const TRUSTED_PRIVATE_INBOX_REFUSAL_SURFACE =
  "PrivateInboxRefusalSurface";

/** The action of the button that replaces the refused inbox. */
export const TRUSTED_REPLACE_REFUSED_INBOX_ACTION =
  "ReplaceRefusedPrivateInbox";

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

  /**
   * The recipient's profile the offer is for, by its space DID. Every profile
   * of one principal points at the same inbox, so this is what tells the
   * recipient which of their profiles was offered the thing. Absent, `null`,
   * or naming no `space`, the offer is to the person. It is taken as the
   * sender sent it, `{ space }` or anything else, so that the inbox keeps a
   * claim it cannot read as no claim at all rather than as one to the person
   * (`keptRecipient()`).
   */
  toProfile?: JSONValue;
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

  /**
   * The recipient's profile the offer names as the one it is for, by its space
   * DID, when the sender named a well-formed one, or `null` when the sender
   * named none, so that the offer is to the person. Like `from`, it is the
   * sender's claim; a reader acts on it only for a profile that is its own.
   * The inbox writes it on every offer it keeps but one whose sender named a
   * profile by something other than a well-formed DID, so a reader finding no
   * `toProfile` at all cannot tell whom the offer is for: its sender named a
   * malformed profile, or an earlier inbox that did not keep the field
   * received it.
   */
  toProfile?: { space: string } | null;
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

/**
 * The inboxes Home reads besides the one it holds, as links, in the order it
 * took each on, and none of them the one it holds: each inbox Home gave up,
 * when it adopted the deciding profile's inbox in its place, whatever other
 * profiles still point at, and each it replaced with its own, whether Home held
 * it or only a profile advertised it. Home keeps the links so that the offers
 * senders delivered to those inboxes stay readable.
 */
export type RetainedPrivateInboxes = Cell<PrivateInboxPiece>[];

/**
 * The host's refusal of the inbox the deciding profile points at, as Home
 * records it.
 */
export type PrivateInboxRefusal = {
  /**
   * The host's code for why it refused the inbox, as the event named it,
   * trimmed and cut to `REFUSAL_REASON_MAX_LENGTH`. Today the host sends one
   * of `InboxAdoptionRefusal`'s codes, from
   * `runtime/piece/src/ops/private-inbox.ts`, such as
   * `inbox-adoption-acl-mismatch`.
   */
  reason: string;

  /** The inbox refused, which the deciding profile points at. */
  inbox: Cell<PrivateInboxPiece>;

  /**
   * When Home first recorded this refusal, of this inbox for this reason, in
   * milliseconds since the epoch. A handler's clock reads to the second.
   */
  refusedAt: number;
};

/**
 * Where Home records the host's refusal of the inbox the deciding profile
 * points at: the refusal, absent while there is none to report.
 */
export type PrivateInboxRefusalHolder = {
  /** The refusal. */
  refusal?: PrivateInboxRefusal;
};

/**
 * The refusal the owner acted on when they had Home replace the refused inbox,
 * as Home records it.
 */
export type PrivateInboxReplacement = {
  /** The refused inbox, which the profiles pointing at it no longer advertise. */
  inbox: Cell<PrivateInboxPiece>;

  /** The host's code for why it refused that inbox, as the refusal held it. */
  reason: string;

  /** When Home first recorded the refusal, as the refusal held it. */
  refusedAt: number;

  /**
   * When the owner had Home replace the inbox, in milliseconds since the epoch.
   * A handler's clock reads to the second.
   */
  replacedAt: number;
};

/**
 * Where Home records the last refusal the owner had it replace: the
 * replacement, absent until the first.
 */
export type PrivateInboxReplacementRecord = {
  /** The replacement. */
  replacement?: PrivateInboxReplacement;
};

/**
 * {@link PrivateInboxReplacementRecord} as Home holds it: only
 * {@link replaceRefusedPrivateInbox} writes it, and only for a click on the
 * button Home renders on {@link TRUSTED_PRIVATE_INBOX_REFUSAL_SURFACE}, so a
 * run that writes it otherwise, and the rest of that run, is refused.
 */
export type PrivateInboxReplacementHolder = TrustedActionWrite<
  PrivateInboxReplacementRecord,
  typeof replaceRefusedPrivateInbox,
  typeof TRUSTED_REPLACE_REFUSED_INBOX_ACTION,
  typeof TRUSTED_PRIVATE_INBOX_REFUSAL_SURFACE
>;

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
 * not an origin is kept empty. A `toProfile` naming a well-formed DID as its
 * `space` is kept as `{ space }`, one naming no profile (`keptRecipient()`)
 * as `null`, and any other is left out.
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
    ...keptRecipient(event?.toProfile),
  };
}

/**
 * The `toProfile` the inbox keeps for an envelope naming `named`, as
 * {@link admissibleOffer} says: `null` for a profile not named, which is
 * `named` absent or `null`, or its `space` absent, `null` or empty once
 * trimmed; `{ space }`, trimmed and cut, for a `space` that is a well-formed
 * DID; and nothing for anything else, which is a claim the inbox cannot read
 * and so must not keep as one to the person.
 */
function keptRecipient(
  named: JSONValue | undefined,
): { toProfile?: { space: string } | null } {
  if (named === undefined || named === null) return { toProfile: null };
  if (typeof named !== "object" || Array.isArray(named)) return {};
  if (!("space" in named)) return { toProfile: null };
  const space = named.space;
  if (space === undefined || space === null) return { toProfile: null };
  if (typeof space !== "string") return {};
  const kept = trimmedText(space, OFFER_ADDRESS_MAX_LENGTH);
  if (kept === "") return { toProfile: null };
  return isWellFormedDID(kept) ? { toProfile: { space: kept } } : {};
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
 * Creates Home's own private inbox, in the space named
 * {@link PRIVATE_INBOX_SPACE_NAME} in Home's space, and returns the link Home
 * holds it by. {@link createOwnPrivateInbox} is its one caller. The space grants
 * every principal `WRITE`, so a sender's write is admitted whether the sender's
 * own runtime makes it or the space's server does.
 */
function createPrivateInbox(): Cell<PrivateInboxPiece> {
  return inboxLinkOf(
    PrivateInbox.inSpace(PRIVATE_INBOX_SPACE_NAME, {
      grants: { "*": "WRITE" },
    })({ offers: [] }),
  );
}

/**
 * The link the first profile in `profiles` that points at an inbox holds, or
 * `undefined` when none does. Call it from a handler, with `profiles` bound as
 * a value of type {@link PointTarget}, so that each pointer is read as a typed
 * link. A profile whose stored pointer is not an object holding a link points
 * at none, as the pointer type reads it.
 */
export function advertisedInbox(
  profiles: readonly ({ inbox?: ProfileInbox } | undefined)[] | undefined,
): Cell<PrivateInboxPiece> | undefined {
  return (profiles ?? []).find((profile) => profile?.inbox?.piece !== undefined)
    ?.inbox?.piece;
}

/**
 * The link the profile in `profiles` that `profile` names holds, or `undefined`
 * when no profile in the list is that one or it points at no inbox. Call it as
 * {@link advertisedInbox} is called.
 */
function pointerOfListed(
  profiles: readonly (PointTarget | undefined)[] | undefined,
  profile: Cell<PointTarget>,
): Cell<PrivateInboxPiece> | undefined {
  return (profiles ?? []).find((each) =>
    each !== undefined && equals(each, profile)
  )?.inbox?.piece;
}

/**
 * Helper for {@link ensurePrivateInbox}, which records in `retained` that Home
 * is giving up `held` for `adopted`. `held` goes at the end, once, and an entry
 * for `adopted` is dropped, since Home holds that one again.
 */
function retainInbox(
  retained: Writable<RetainedPrivateInboxes>,
  held: Cell<PrivateInboxPiece>,
  adopted: Cell<PrivateInboxPiece>,
): void {
  const earlier = (retained.get() ?? []).filter((each) =>
    each !== undefined && !equals(each, held) && !equals(each, adopted)
  );
  retained.set([...earlier, held]);
}

/**
 * Helper for {@link ensurePrivateInbox}, which records in `retained` that Home
 * reads `inbox` without holding it: it goes at the end, unless the list holds
 * it already.
 */
function retainOnce(
  retained: Writable<RetainedPrivateInboxes>,
  inbox: Cell<PrivateInboxPiece>,
): void {
  const earlier = (retained.get() ?? []).filter((each) => each !== undefined);
  if (earlier.some((each) => equals(each, inbox))) return;
  retained.set([...earlier, inbox]);
}

/**
 * Helper for {@link ensurePrivateInbox}, which records in `retained` that Home
 * holds `inbox` again: an entry for it is dropped, since the list never holds
 * the inbox Home holds.
 */
function releaseRetained(
  retained: Writable<RetainedPrivateInboxes>,
  inbox: Cell<PrivateInboxPiece>,
): void {
  const earlier = (retained.get() ?? []).filter((each) => each !== undefined);
  if (!earlier.some((each) => equals(each, inbox))) return;
  retained.set(earlier.filter((each) => !equals(each, inbox)));
}

/** What the host sends Home's `ensurePrivateInbox`. */
export type EnsurePrivateInboxEvent = {
  /**
   * The inbox the deciding profile advertises, which the host has vetted for
   * Home to adopt, one Home made; absent when the host vetted none.
   */
  adopt?: Cell<PrivateInboxPiece>;

  /**
   * The inboxes Home did not make, which the host has Home replace with one of
   * its own: the inbox Home holds, and the inbox the deciding profile
   * advertises, which the host has vetted, either or both. Absent when there
   * is none.
   */
  replace?: Cell<PrivateInboxPiece>[];

  /**
   * The deciding profile: the first, in the order `#profile` answers in, that
   * points at an inbox. Absent from a host that names none, which Home takes
   * as the first profile in its list that points at an inbox.
   */
  from?: Cell<PointTarget>;

  /**
   * The host's refusal of the inbox the deciding profile advertises, for Home
   * to record, beside an inbox Home holds to replace or alone; absent when the
   * host refused none.
   */
  refused?: {
    /** Why the host refused it, by its code. */
    reason: string;

    /** The inbox refused. */
    inbox: Cell<PrivateInboxPiece>;
  };
};

/**
 * Gives Home the private inbox the host names, or its own when no profile
 * advertises one, then has each profile in Home's list that points at no inbox
 * point at Home's. Which inbox Home should hold is the host's decision
 * (`ensurePrivateInboxOf()` in `runtime/piece`), which this handler checks
 * rather than repeats. Home adopts the inbox the event names only when the
 * profile the event names is in Home's list and still points at that inbox; an
 * inbox Home held until then goes into `retainedPrivateInboxes`. An event
 * naming no inbox leaves Home with what it holds, and Home takes its own inbox
 * only when it holds none and no profile points at an inbox. So when the host
 * vetted none, or names a profile that has since moved, Home keeps what it
 * holds, or holds none.
 *
 * An event naming inboxes to replace, ones Home did not make, gives each way to
 * Home's own inbox when Home holds it, or when the profile the event names is
 * in Home's list and still points at it: Home takes its own inbox if it holds
 * one of those or none, keeps the one it holds otherwise, and puts each
 * replaced inbox in `retainedPrivateInboxes`, so the offers delivered to it
 * stay readable. A profile pointing at an inbox Home retains is then pointed at
 * Home's, by the second step; a profile pointing at any other inbox keeps its
 * pointer. Taking its own inbox takes it out of `retainedPrivateInboxes`, which
 * never holds the inbox Home holds. Running it again re-points and retains
 * nothing.
 *
 * Home's own inbox is the one `ownPrivateInbox` holds, which only
 * {@link createOwnPrivateInbox} creates. This handler creates none: it reads
 * the owner's labeled state, the links Home's holder and the profiles keep
 * among it, and an inbox created in a run that has read that would carry the
 * owner's label to every sender that reads the inbox, which the write gate
 * refuses. The host has Home's `createOwnPrivateInbox` create it first, and
 * waits for that, when Home may need it. For a sender that has not, when Home
 * has no inbox of its own, the event names none to adopt, and either the event
 * names inboxes to replace or Home holds none, this handler does nothing but
 * send the event to `createOwn`. That step creates Home's inbox and hands the
 * event on to an ensure bound without `createOwn`, which decides as above. Whether to send depends only on the host's event,
 * `ownPrivateInbox` and whether Home holds an inbox, never on which inbox Home
 * or a profile names. An ensure bound without `createOwn`, while Home has no
 * inbox of its own, neither replaces an inbox nor takes one.
 *
 * `privateInboxRefusal` holds the host's refusal of the deciding profile's
 * inbox. A refusal the event names is recorded, in place of a different one
 * recorded before, under the same check as an adoption: the profile the event
 * names is in Home's list and still points at the refused inbox, which is not
 * the inbox Home holds. Otherwise the record is cleared when Home adopts an
 * inbox or takes its own, when it replaces the inbox the record names, when the
 * profile the event names is in Home's list and points at the inbox Home
 * holds, and, on an event recording no refusal, when no profile in Home's list
 * points at the refused inbox. `replaceRefusedPrivateInbox` clears it too,
 * when the owner replaces the refused inbox. A repeat of the recorded refusal,
 * of the same inbox for the same reason, keeps the time it was first recorded.
 *
 * The check is list membership and the profile's pointer, not order: which
 * profile decides is the host's alone. So an event the owner's own code sends,
 * naming another profile in the list, can move Home between two inboxes its
 * profiles advertise. Each move retains the inbox given up and drops the one
 * adopted from the retained list, so that list holds each inbox at most once.
 * Such an event can likewise record a refusal of any listed profile's inbox,
 * with any code, or clear the record.
 *
 * The list is bound as a value: the runner resolves it before the body runs,
 * and withdraws the dispatch until every profile it names has loaded, so an
 * unloaded profile is never taken for one that advertises no inbox.
 *
 * The pointing is a second step, queued behind this one, so that it points the
 * profiles at the inbox this run leaves Home holding once the run has
 * committed.
 */
export const ensurePrivateInbox = handler<
  EnsurePrivateInboxEvent,
  {
    privateInbox: Writable<PrivateInboxHolder>;
    ownPrivateInbox: PrivateInboxHolder;
    retainedPrivateInboxes: Writable<RetainedPrivateInboxes>;
    privateInboxRefusal: Writable<PrivateInboxRefusalHolder>;
    profiles: PointTarget[];
    pointProfiles: Stream<void>;
    /**
     * Absent from the ensure {@link createOwnPrivateInbox} hands its event to,
     * which never asks for an inbox.
     */
    createOwn?: Stream<EnsurePrivateInboxEvent>;
  }
>((
  event,
  {
    privateInbox,
    ownPrivateInbox,
    retainedPrivateInboxes,
    privateInboxRefusal,
    profiles,
    pointProfiles,
    createOwn,
  },
) => {
  const held = privateInbox.get()?.piece;
  const own = ownPrivateInbox?.piece;
  const adopt = event?.adopt;
  if (
    createOwn !== undefined && own === undefined && adopt === undefined &&
    ((event?.replace ?? []).length > 0 || held === undefined)
  ) {
    createOwn.send(event ?? {});
    return;
  }
  const advertised = advertisedInbox(profiles);
  // The deciding profile's pointer, when the event names a profile in the
  // list. Comparisons of links, which read only link shape in the inbox's
  // space.
  const deciding = event?.from !== undefined
    ? pointerOfListed(profiles, event.from)
    : undefined;
  // The inbox Home holds once this run commits.
  let holding = held;
  let replaced = false;
  // An inbox Home holds, or one the profile the event names still points at,
  // gives way to Home's own, and Home keeps reading it. Without an inbox of
  // its own, Home replaces none.
  const replacing = adopt !== undefined || own === undefined
    ? []
    : (event?.replace ?? []).filter((each) =>
      each !== undefined &&
      ((held !== undefined && equals(held, each)) ||
        (deciding !== undefined && equals(each, deciding)))
    );
  if (own !== undefined && replacing.length > 0) {
    for (const each of replacing) retainOnce(retainedPrivateInboxes, each);
    if (held === undefined || replacing.some((each) => equals(held, each))) {
      holding = own;
      privateInbox.set({ piece: own });
      releaseRetained(retainedPrivateInboxes, own);
      replaced = true;
    }
  } else if (adopt !== undefined) {
    const pointer = event?.from !== undefined
      ? deciding
      : held === undefined
      ? advertised
      : undefined;
    if (
      pointer !== undefined && equals(adopt, pointer) &&
      (held === undefined || !equals(held, adopt))
    ) {
      if (held !== undefined) retainInbox(retainedPrivateInboxes, held, adopt);
      holding = adopt;
      privateInbox.set({ piece: holding });
      replaced = true;
    }
  } else if (
    own !== undefined && held === undefined && advertised === undefined
  ) {
    holding = own;
    privateInbox.set({ piece: own });
    releaseRetained(retainedPrivateInboxes, own);
    replaced = true;
  }
  const refused = event?.refused;
  const recorded = privateInboxRefusal.get()?.refusal;
  if (
    refused !== undefined && deciding !== undefined &&
    equals(refused.inbox, deciding) &&
    (holding === undefined || !equals(holding, refused.inbox))
  ) {
    const reason = trimmedText(refused.reason, REFUSAL_REASON_MAX_LENGTH);
    // The same refusal again keeps the time it was first recorded, and
    // writes nothing.
    if (
      recorded === undefined || recorded.reason !== reason ||
      !equals(recorded.inbox, refused.inbox)
    ) {
      privateInboxRefusal.set({
        refusal: { reason, inbox: refused.inbox, refusedAt: Date.now() },
      });
    }
  } else if (
    replaced ||
    (recorded !== undefined &&
      replacing.some((each) => equals(each, recorded.inbox)))
  ) {
    privateInboxRefusal.set({});
  } else if (
    deciding !== undefined && held !== undefined && equals(held, deciding)
  ) {
    privateInboxRefusal.set({});
  } else if (
    // A recorded refusal says the deciding profile points at the refused
    // inbox, so it ends once no profile in the list points there.
    recorded !== undefined &&
    !(profiles ?? []).some((profile) =>
      profile?.inbox?.piece !== undefined &&
      equals(profile.inbox.piece, recorded.inbox)
    )
  ) {
    privateInboxRefusal.set({});
  }
  pointProfiles.send();
});

/**
 * Creates Home's own private inbox when `ownPrivateInbox` holds none, and
 * records it there. Nothing else creates an inbox for Home. Home binds it
 * twice:
 *
 * - As Home's `createOwnPrivateInbox` stream, with no `ensure`. The host sends
 *   it when its vetting finds that Home may need an inbox of its own and has
 *   none, and waits for the run to commit before it sends the ensure, so a
 *   creation that fails fails the host's ensure, and the next bring-up tries
 *   again.
 * - As the step {@link ensurePrivateInbox} sends its event to when Home may
 *   need an inbox and has none of its own, for a sender of the ensure that
 *   has not had one created first, such as `requestPrivateInbox`. This binding
 *   hands `event` on to `ensure`, which decides what Home holds now that it has
 *   an inbox of its own. Nothing waits for it: a sender of the ensure learns of
 *   the ensure's own run, not of this one.
 *
 * Before the creation the run reads nothing but `ownPrivateInbox`, which only
 * this step writes, and its event, which carries no label. That is the point
 * of the step. The documents a creation writes take on the confidentiality its
 * run has read, so after a read of the owner's labeled state, such as the
 * links Home's holder and its profiles keep, the write gate refuses the
 * creation; and an inbox carrying the owner's label would pass it into the run
 * of every sender that reads the inbox.
 *
 * Two runs racing to create the inbox both read `ownPrivateInbox` empty, and
 * the one that commits second finds its commit stale, runs again, and creates
 * nothing. What its first attempt wrote in the inbox's space, which commits
 * before Home's, may be left there: an empty inbox no profile and nothing of
 * Home's names.
 *
 * The inbox's space is named in Home's own space, so one identity gets one such
 * space however many times, and from however many runtimes, this runs.
 */
export const createOwnPrivateInbox = handler<
  EnsurePrivateInboxEvent,
  {
    ownPrivateInbox: Writable<PrivateInboxHolder>;
    /** Absent from the binding the host sends, which hands nothing on. */
    ensure?: Stream<EnsurePrivateInboxEvent>;
  }
>((event, { ownPrivateInbox, ensure }) => {
  if (ownPrivateInbox.get()?.piece === undefined) {
    ownPrivateInbox.set({ piece: createPrivateInbox() });
  }
  ensure?.send(event ?? {});
});

/**
 * Points each profile in `profiles` that points at no inbox at Home's private
 * inbox, as `pointAtInboxIfUnset()` does, and each that points at an inbox in
 * `retainedPrivateInboxes`, one Home gave up or replaced, at Home's in its
 * place, as `pointAtInboxInPlaceOf()` does. So every profile that advertised
 * an inbox Home held or replaced advertises the one Home holds, and a sender
 * delivers there.
 *
 * The list is bound as a value: the runner resolves it before the body runs,
 * and withdraws the dispatch until every profile it names has loaded, so an
 * unloaded profile is never taken for one with no inbox.
 */
export const pointProfilesAtPrivateInbox = handler<
  void,
  {
    privateInbox: PrivateInboxHolder;
    /** Absent from a binding that names none, which re-points nothing. */
    retainedPrivateInboxes?: RetainedPrivateInboxes;
    profiles: PointTarget[];
  }
>((_event, { privateInbox, retainedPrivateInboxes, profiles }) => {
  for (const profile of profiles ?? []) {
    const pointer = profile?.inbox?.piece;
    // The retained list never holds the inbox Home holds.
    const given = pointer === undefined
      ? undefined
      : (retainedPrivateInboxes ?? []).find((each) =>
        each !== undefined && equals(each, pointer)
      );
    if (given === undefined) pointAtInboxIfUnset(profile, privateInbox);
    else pointAtInboxInPlaceOf(profile, given, privateInbox);
  }
});

/** What a client sends Home's `requestPrivateInbox`. */
export type PrivateInboxRequest = {
  /**
   * The profile the client finds the owner by, which is to advertise Home's
   * inbox: the one `#profile` answers with.
   */
  from?: Cell<PointTarget>;
};

/**
 * Where a request for Home's private inbox stands, for the profile it names:
 *
 * - `pending` while Home is giving the profile its inbox: Home holds an inbox
 *   the profile does not point at yet, or holds none and is taking its own.
 * - `ensured` once the profile points at the inbox Home holds.
 * - `unlisted` when the request names no profile in Home's list, which Home
 *   never points.
 * - `unpointable` when the profile has no `setInbox`, through which alone Home
 *   points it.
 * - `not-held` when the profile advertises an inbox other than the one Home
 *   holds, as when something other than Home sets its pointer first, which
 *   Home never replaces, or Home holds none and takes none, because a
 *   profile advertises an inbox that awaits the host's vetting.
 */
export type PrivateInboxAnswerStatus =
  | "pending"
  | "ensured"
  | "unlisted"
  | "unpointable"
  | "not-held";

/** How Home answers a request for its private inbox, for one profile. */
export type PrivateInboxAnswer = {
  /**
   * Where the request stands. Once it is `ensured`, the inbox is the one the
   * profile's own pointer names. The answer holds no link to it, which a run
   * reading Home's answers could follow, untyped, into the label the inbox
   * gives its offers.
   */
  status: PrivateInboxAnswerStatus;
};

/**
 * The result of Home's handling of a request for its inbox, which is its
 * receipt: a link to one of Home's {@link PrivateInboxAnswers}.
 */
export type PrivateInboxReceipt = Cell<PrivateInboxAnswer>;

/**
 * Every answer Home gives a request for its inbox, which a request's receipt
 * links to one of: one for each profile a request has named, keyed by the
 * profile's document as {@link profileKeyOf} keys it, and one each for a
 * request naming no profile in the list and for one naming a profile without
 * `setInbox`.
 */
export type PrivateInboxAnswers = {
  /**
   * The answer for each profile a request has named, by the profile's entity,
   * as {@link profileKeyOf} keys it: `unlisted` once the profile has left
   * Home's list.
   */
  profiles: Record<string, PrivateInboxAnswer>;

  /** The answer for a request naming no profile in Home's list. */
  unlisted: PrivateInboxAnswer;

  /** The answer for a request naming a profile without `setInbox`. */
  unpointable: PrivateInboxAnswer;
};

/**
 * A profile in Home's list as a request reads it: its pointer, and its
 * `setInbox` as stored, which is absent from a profile of a vintage without
 * one, so that Home can tell it never points such a profile. A `Stream` type
 * would read as a stream whether or not the profile holds one.
 */
export type AnswerTarget = {
  // The pointer is a typed link, for the reason `InboxPointable` gives.
  inbox?: ProfileInbox;
  setInbox?: unknown;
};

/**
 * The key Home files its answer for `profile` under: the space of the
 * profile's own document and the entity that document is, which together name
 * one document wherever the profile sits in Home's list. `profile` is a
 * profile as a handler or a computation reads it, a cell or the value a cell
 * reads as. `undefined` for a profile that names no entity. Call it in a
 * handler or a reactive computation, where `spaceOf()` can be called.
 */
export function profileKeyOf(profile: unknown): string | undefined {
  const ref = getEntityId(profile);
  // `spaceOf()` takes a cell or the value a cell reads as, as its own
  // documentation says, though its declared type names only the cell.
  const space = spaceOf(profile as AnyCell<unknown> | undefined);
  return ref === undefined || space === undefined
    ? undefined
    : `${space}/${entityRefToString(ref)}`;
}

/**
 * Returns Home's answer for each profile `requested` names, by
 * {@link profileKeyOf}, given the inbox Home holds and the profiles in its
 * list; Home's request handler links a request's receipt to the entry for the
 * profile it names. A profile no longer in `profiles` is `unlisted`, so a
 * receipt answers for its own profile whatever else leaves the list, and ends
 * when that profile does. Otherwise an answer is `pending` only while Home
 * is still to point the profile at the inbox it holds, so a pointer that comes
 * to name anything else is a final status:
 *
 * - The profile points at an inbox other than the one Home holds, or Home
 *   holds none: `not-held`, since Home points only a profile that points at
 *   none.
 * - The profile points at no inbox, Home holds none, and another profile
 *   advertises one, so Home takes none: `not-held`.
 */
export function privateInboxAnswersOf(
  held: Cell<PrivateInboxPiece> | undefined,
  profiles: readonly ({ inbox?: ProfileInbox } | undefined)[] | undefined,
  requested: Readonly<Record<string, boolean>> | undefined,
): PrivateInboxAnswers {
  const advertised = advertisedInbox(profiles);
  const listed = new Map<string, { inbox?: ProfileInbox }>();
  for (const profile of profiles ?? []) {
    const key = profileKeyOf(profile);
    if (profile !== undefined && key !== undefined) listed.set(key, profile);
  }
  const answerFor = (
    profile: { inbox?: ProfileInbox } | undefined,
  ): PrivateInboxAnswer => {
    if (profile === undefined) return { status: "unlisted" };
    const pointer = profile.inbox?.piece;
    if (pointer === undefined) {
      return held === undefined && advertised !== undefined
        ? { status: "not-held" }
        : { status: "pending" };
    }
    return held !== undefined && equals(pointer, held)
      ? { status: "ensured" }
      : { status: "not-held" };
  };
  const answers: Record<string, PrivateInboxAnswer> = {};
  for (const key of Object.keys(requested ?? {})) {
    answers[key] = answerFor(listed.get(key));
  }
  return {
    profiles: answers,
    unlisted: { status: "unlisted" },
    unpointable: { status: "unpointable" },
  };
}

/** Arguments for {@link PrivateInboxAnswering}. */
export type PrivateInboxAnsweringInput = {
  /** Home's holder of its inbox. */
  privateInbox: PrivateInboxHolder;

  /** Home's profiles, as any vintage of profile can be read. */
  profiles: PointTarget[];

  /**
   * The profiles requests have named, by {@link profileKeyOf}, which
   * {@link requestPrivateInbox} records.
   */
  requested: Record<string, boolean>;
};

/** The result of {@link PrivateInboxAnswering}. */
export type PrivateInboxAnsweringOutput = {
  /** Home's answers, as {@link privateInboxAnswersOf} computes them. */
  answers: PrivateInboxAnswers;
};

/**
 * Computes Home's answers to requests for its inbox, once for all the
 * profiles requests have named. The list is read through {@link PointTarget},
 * which a profile of any vintage satisfies.
 */
export const PrivateInboxAnswering = pattern<
  PrivateInboxAnsweringInput,
  PrivateInboxAnsweringOutput
>(({ privateInbox, profiles, requested }) => ({
  answers: computed(() =>
    privateInboxAnswersOf(privateInbox?.piece, profiles, requested)
  ),
}));

/**
 * Has Home ensure its private inbox, as an event naming nothing has
 * {@link ensurePrivateInbox} do, and answers with Home's answer for the
 * profile the request names, which is `ensured` once that profile points at
 * the inbox Home holds. Home keeps the inbox it holds, takes its own when it
 * holds none and no profile advertises one, and points each profile in its
 * list that points at no inbox at its own; it adopts nothing, since adopting
 * an inbox a profile advertises waits on the host's vetting.
 *
 * The answer is this handling's result, and so its receipt, which a client
 * reads from the receipt link its send's completion carries. For a profile in
 * Home's list it is a link to that profile's entry in `answers`, by the
 * profile's entity, which this handler records in `requested`; Home computes
 * an entry for every profile so recorded, with {@link PrivateInboxAnswering}.
 * So a request leaves nothing running, and the entry goes on changing as
 * Home's holder and the profile's pointer do: `pending` until the profile
 * points at the inbox Home holds, then `ensured`, or a final status saying
 * why it never will, `unlisted` among them once the profile leaves Home's
 * list. The profile is pointed in events of their own, in Home's space and
 * then in the profile's, after this run, which is why the answer is a link
 * rather than a value. The receipt of a request naming no profile in the list
 * links to the `unlisted` answer, and that of one naming a profile without
 * `setInbox`, which Home never points, to the `unpointable` one, so every
 * receipt is a link into Home's answers.
 *
 * The list is bound as a value, for the reason it is in
 * {@link ensurePrivateInbox}.
 */
export const requestPrivateInbox = handler<
  PrivateInboxRequest,
  {
    profiles: AnswerTarget[];
    requested: Writable<Record<string, boolean>>;
    answers: Writable<PrivateInboxAnswers>;
    ensure: Stream<EnsurePrivateInboxEvent>;
  },
  PrivateInboxReceipt
>((event, { profiles, requested, answers, ensure }) => {
  ensure.send({});
  const profile = event?.from;
  const listed = profile === undefined ? undefined : (profiles ?? []).find(
    (each) => each !== undefined && equals(each, profile),
  );
  const key = listed === undefined || profile === undefined
    ? undefined
    : profileKeyOf(profile.resolveAsCell());
  if (listed === undefined || key === undefined) {
    return answers.key("unlisted");
  }
  if (listed.setInbox === undefined) return answers.key("unpointable");
  if (requested.get()?.[key] !== true) requested.key(key).set(true);
  return answers.key("profiles").key(key);
});

/**
 * Replaces the inbox Home's refusal record names, for the owner, from the
 * button Home's refusal notice carries: Home keeps the inbox it holds, or
 * takes its own when it holds none, clears the refusal, records it as replaced
 * in `privateInboxReplacement`, and then has each profile in Home's list that
 * points at the refused inbox point at Home's instead. Profiles pointing at any
 * other inbox, or at none, are left to the ensure. Does nothing while Home
 * records no refusal. The refused inbox does not go into
 * `retainedPrivateInboxes`: Home never held it.
 *
 * It creates no inbox, for the reason {@link createOwnPrivateInbox} gives:
 * this run reads the refusal record first. {@link ensurePrivateInbox} has
 * Home's own created whenever Home holds none, which is when a refusal leaves
 * Home without one, so the notice's button finds it. While Home holds none and
 * has none of its own, this does nothing, and the refusal stays recorded for
 * the next click, after the next ensure; nor does it take Home's own when that
 * is the refused inbox.
 *
 * `privateInboxReplacement` admits a write only from this handler, and only
 * for an event the renderer marks as a click on
 * {@link TRUSTED_PRIVATE_INBOX_REFUSAL_SURFACE}; any other send of it is
 * refused, with everything else the run writes and sends.
 *
 * The re-pointing is a second step, queued behind this one, for the reason
 * {@link ensurePrivateInbox}'s pointing is.
 */
export const replaceRefusedPrivateInbox = handler<
  void,
  {
    privateInbox: Writable<PrivateInboxHolder>;
    ownPrivateInbox: PrivateInboxHolder;
    privateInboxRefusal: Writable<PrivateInboxRefusalHolder>;
    privateInboxReplacement: Writable<PrivateInboxReplacementRecord>;
    repointProfiles: Stream<void>;
  }
>((
  _event,
  {
    privateInbox,
    ownPrivateInbox,
    privateInboxRefusal,
    privateInboxReplacement,
    repointProfiles,
  },
) => {
  const refusal = privateInboxRefusal.get()?.refusal;
  if (refusal === undefined) return;
  if (privateInbox.get()?.piece === undefined) {
    const own = ownPrivateInbox?.piece;
    if (own === undefined || equals(own, refusal.inbox)) return;
    privateInbox.set({ piece: own });
  }
  privateInboxRefusal.set({});
  // TODO(danfuzz): With server execution off, a runtime of the owner's started
  // after the refused inbox's space revoked the owner's `READ` can't commit
  // this typed link to the refused inbox, so CFC refuses the replacement and
  // nothing changes. Record the replaced inbox without the typed link.
  privateInboxReplacement.set({
    replacement: {
      inbox: refusal.inbox,
      reason: refusal.reason,
      refusedAt: refusal.refusedAt,
      replacedAt: Date.now(),
    },
  });
  repointProfiles.send();
});

/**
 * Points each profile in `profiles` that points at the inbox
 * `privateInboxReplacement` records as replaced at Home's private inbox, as
 * `pointAtInboxInPlaceOf()` does. It reads the replaced inbox from that record
 * rather than from its event, so a send of it can only repeat a replacement
 * the owner made.
 *
 * The list is bound as a value, for the reason it is in
 * {@link pointProfilesAtPrivateInbox}.
 */
export const repointProfilesFromReplacedInbox = handler<
  void,
  {
    privateInbox: PrivateInboxHolder;
    privateInboxReplacement: PrivateInboxReplacementRecord;
    profiles: PointTarget[];
  }
>((_event, { privateInbox, privateInboxReplacement, profiles }) => {
  const replaced = privateInboxReplacement?.replacement?.inbox;
  if (replaced === undefined) return;
  for (const profile of profiles ?? []) {
    pointAtInboxInPlaceOf(profile, replaced, privateInbox);
  }
});

export default PrivateInbox;
