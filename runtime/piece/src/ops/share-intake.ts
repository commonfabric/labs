/**
 * The host's share intake: it follows the offers in the private inboxes Home
 * holds and retains, vets each one as the owner, and registers each offer that
 * passes in Home's shared-space catalog through Home's `registerSharedSpace`
 * stream, then has Home's chat manager accept each room it newly registers.
 * Vetting reads the offered space's access list, the kind it declares, and its
 * root, which a Home handler cannot do; `docs/features/private-inbox.md`
 * describes the whole arrangement.
 */

import type { DID } from "@commonfabric/identity";
import { isWellFormedDID } from "@commonfabric/identity/did";
import {
  type Cancel,
  type Cell,
  isCell,
  type NormalizedFullLink,
  normalizeSpaceHost,
  type Runtime,
  sendEvent,
} from "@commonfabric/runner";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { inboxPieceLinkSchema } from "./private-inbox.ts";
import {
  CHAT_ROOM_SPACE_KIND,
  followSpaceState,
  isWriter,
  LOOM_SPACE_KIND,
  type SpaceRefusal,
  vetSpace,
} from "./space-vetting.ts";

const logger = getLogger("piece.share-intake");

/**
 * The kinds of offer the intake admits, each a kind of space, as
 * `docs/features/space-kinds.md` lists them. An offer of a kind not here is
 * refused and left in its inbox, and so is one whose space declares another
 * kind. What each asks of the space's root is the kind's contract, which
 * `vetSpace()` holds the space to.
 *
 * - `fabrichat-room`, a standalone FabriChat room's own space, whose root is
 *   the room, at the address the space's genesis commit reserves for it.
 * - `loom`, a social Loom's own space, whose root is a Loom, wherever the
 *   space links it. A Loom space created before the kind was declared
 *   declares none, and is admitted by the same root check.
 */
export const ADMITTED_SPACE_KINDS: ReadonlySet<string> = new Set([
  CHAT_ROOM_SPACE_KIND,
  LOOM_SPACE_KIND,
]);

/** Why an offer is not registered. */
export type OfferRefusal =
  | "offer-malformed"
  | "offer-kind-unknown"
  | "offer-foreign-host"
  | "sender-not-member"
  | SpaceRefusal;

/**
 * What an instance decided about an offer: `sent` to Home's
 * `registerSharedSpace`, skipped as `received` because the catalog holds its
 * receipt, or refused, for the reason given.
 */
export type OfferDecision = "sent" | "received" | OfferRefusal;

/** An offer whose envelope is well formed, as the intake registers it. */
interface VettableOffer {
  kind: string;
  id: string;
  space: DID;
  host: string;
  title: string;
  from: DID;

  /** The space DID of the recipient's profile the offer names, if any. */
  profile?: DID;
}

const pointerSchema = {
  type: "object",
  properties: { piece: inboxPieceLinkSchema },
} as const;

const retainedSchema = {
  type: "array",
  items: inboxPieceLinkSchema,
} as const;

// Every field of every row, as stored, so that a malformed field reaches the
// vetting rather than being projected away.
const offersSchema = {
  type: "array",
  items: { type: "object", additionalProperties: true },
} as const;

const catalogSchema = {
  type: "object",
  properties: { offers: { type: "object", additionalProperties: true } },
} as const;

// Home's observation of its profile records, read loosely, since the intake
// only asks which spaces Home records no profile for and which profiles it
// can record.
const profilesSchema = {
  type: "object",
  properties: {
    status: { type: "string" },
    spaces: { type: "object", additionalProperties: true },
    live: { type: "array", items: { type: "string" } },
  },
} as const;

/**
 * What the intake reads of Home before deciding the rows of an inbox: the
 * offers its catalog holds receipts for, by {@link offerIdentity}, with the
 * `profileConflict` each receipt carries, if any, the spaces Home records no
 * profile for, and the spaces of the profiles a registration can record.
 */
interface HomeReceipts {
  received: Map<string, unknown>;
  unrecorded: Set<string>;
  live: Set<string>;
}

/**
 * Starts following the offers in `home`'s private inboxes, the one it holds
 * and the ones it retains, and registers in its shared-space catalog each
 * offer that passes vetting, as {@link ShareIntake} describes. `home` is a
 * Home result, and `identity` the identity it belongs to. Returns `undefined`,
 * starting nothing, for a Home without a `registerSharedSpace` stream.
 */
export function startShareIntakeOf(
  runtime: Runtime,
  home: Cell<unknown>,
  identity: DID,
  signal?: AbortSignal,
): ShareIntake | undefined {
  if (home.key("registerSharedSpace").getRaw() === undefined) return undefined;
  return new ShareIntake(runtime, home, identity, signal);
}

/**
 * Follows the offers in a Home's private inboxes and registers the ones that
 * pass vetting in its shared-space catalog. It subscribes to Home's
 * `privateInbox` and `retainedPrivateInboxes` and to each inbox's `offers`, so
 * that an inbox Home comes to hold or retain, and an offer arriving in any of
 * them, is taken up as it lands.
 *
 * An offer is skipped, without being vetted, when the catalog already holds a
 * receipt for its sender and `id`, unless the offer names a `toProfile`,
 * Home's `sharedSpaces.profiles` says Home records no profile for its space,
 * as it does for a space registered by a registration that named none, and
 * the receipt either does not say Home refused the profile
 * (`profileConflict`) or says it was not one of the person's live profiles
 * (`unknown-profile`) and `sharedSpaces.profiles` now lists it as one
 * (`live`). The instance also subscribes to `sharedSpaces.profiles`, and a
 * change there has it consider again every row of every inbox it follows,
 * so an offer refused while its profile was not yet the person's own, or
 * while the profile was retired or not yet listed, is sent again once it is
 * one of the person's live profiles, and Home records it. While that view
 * cannot be read, the scan fails and its rows are taken up again at the
 * next change, or when a lost connection to the host comes back, as below.
 * Any other offer is registered, with its sender and `id`, its `kind`, `host` and
 * `title`, and as `profile` the space of the profile its `toProfile` names,
 * if it names one, when:
 *
 * - its envelope is well formed: `space` and `from` are well-formed DIDs,
 *   `host` and a nonempty `ownerOrigin` are each an origin, as
 *   `normalizeSpaceHost()` reads one, a `toProfile` other than `null`, which
 *   says the sender named no profile, names a well-formed DID as its
 *   `space`, and every string fits the bounds the inbox cuts to;
 * - its `kind` is one of {@link ADMITTED_SPACE_KINDS};
 * - its `host` is this runtime's own, compared as `normalizeSpaceHost()`
 *   normalizes both, since that is the host whose memory this one reads;
 * - `from` holds a `WRITE` or `OWNER` entry of its own in the space's access
 *   list, a grant to every principal (`"*"`) not counting;
 * - the identity can open the space, holding `WRITE` or `OWNER` there, its own
 *   or every principal's;
 * - the space declares `kind` as its own kind, as `Runtime.spaceKind()` reads
 *   it from the space's genesis commit, or, for a `loom` offer, declares no
 *   kind. That kind is what the space's creator declared, so it classifies
 *   the space by its creator's claim;
 * - the space has a root, a piece of the space itself, and the root is what
 *   the kind's contract asks for, as `vetSpace()` holds it: for a
 *   `fabrichat-room`, the document at the address the space's genesis commit
 *   reserves for an `inSpace(..., { root: true })` root, the address
 *   `inSpaceRootCause()` derives in the space, so that a root a member with
 *   `WRITE` has linked in place of that one is refused; for a `loom`, a piece
 *   whose stored result schema is a Loom's composition.
 *
 * No code of the space's is loaded or run to vet an offer.
 *
 * Each row of an inbox is decided by its whole content, so a row naming
 * another offer's sender and `id` decides nothing about that offer. A row
 * refused for something in the row itself (its envelope, its `kind` or its
 * `host`) or for the kind its space declares, which never changes, is decided
 * for the life of the instance, and so is one sent or skipped for its
 * receipt, unless it is sent again for its profile as above. A row refused
 * for the state of its space (its access list, its root, or the result schema
 * its root stores) is vetted again when that state changes, as the instance
 * follows it (`followSpaceState`) while an inbox it follows holds a row
 * waiting on it, when the host's verdict on this identity's access to the
 * space changes (`subscribeSpaceAccessChange`), and the next time its inbox's
 * offers change. A refusal is logged once per row, under
 * `piece.share-intake`, with its reason, and so is a `conflict` Home's handler
 * returns for a row it was sent. A failure to read what vetting needs, other
 * than a refusal of access, and a send to Home that throws, leave the row
 * undecided, and so does a space whose kind the host cannot tell, or a scan
 * that fails before reaching the row. When a lost connection to the host comes
 * back (`subscribeConnectionRestored`), the instance reads again which inboxes
 * Home holds and retains and considers every row of each, so each row left
 * undecided while it was down is taken up then, or when its inbox next
 * changes. So a lone offer is taken up once what kept it waiting changes, with
 * no other offer, profile change or restart. A row sent to Home is logged at
 * info (`offer-sent`), so the logger's counts tell a send from a scan that
 * sent nothing. Nothing consumes an offer or deletes it.
 *
 * Registration is Home's handler's, so an offer already registered under
 * another sender or `id` leaves the entry as it is, archived or not, and adds
 * a receipt for this offer. Home records the offer's profile as the one
 * acting in the space when it records none for the space, and keeps the one
 * it records when the offer names that one or none. When the offer names
 * another, or a profile that is not one of the person's live profiles, Home
 * registers the offer all the same, records the conflict in its receipt as
 * `profileConflict`, and returns a `conflict`, which the intake logs. When
 * reading whether the profile is the person's fails, the registration fails
 * and writes no receipt, so a later intake sends the offer again.
 *
 * Once Home's handler returns `registered`, a new entry, or a `conflict`
 * over the offer's profile whose `registration` is `registered`, for a
 * `fabrichat-room` offer, the intake sends the space's root to Home's
 * `chatManager.accept`, when Home has one, with `keepArchived` set, so that
 * the manager records the room as an acceptance from the room itself would,
 * and an entry archived since it was registered stays archived. An entry
 * already there gets no acceptance, and neither does a `loom` entry, whose
 * registration is the whole of the Loom's arrival.
 */
export class ShareIntake {
  #runtime: Runtime;
  #home: Cell<unknown>;
  #identity: DID;
  #signal: AbortSignal | undefined;
  #host: string;
  #holders: Cancel[] = [];
  #inboxes = new Map<string, Cancel>();
  #current = new Map<string, Cell<unknown>>();
  #settled = new Map<string, OfferDecision>();
  #latest = new Map<string, RowDecision>();
  /**
   * The rows refused for the state of their space, by the address of each
   * inbox holding one, each with that space, which a change to that state
   * takes up. A row two inboxes hold waits in both.
   */
  #waiting = new Map<string, Map<string, DID>>();
  /** What follows the state of each space a row of {@link #waiting} names. */
  #spaces = new Map<DID, Cancel>();
  #logged = new Set<string>();
  #holdersChanged = false;
  #everyInbox = false;
  #changedInboxes = new Set<string>();
  #draining = false;
  #drained: Promise<void> = Promise.resolve();
  #pending = new Set<Promise<void>>();
  #stopped = false;

  /**
   * Constructs an instance following `home`'s inboxes on `runtime`, as
   * `identity`, until {@link stop} is called or `signal` aborts.
   *
   * @throws When subscribing to Home fails, having stopped what it started.
   */
  constructor(
    runtime: Runtime,
    home: Cell<unknown>,
    identity: DID,
    signal?: AbortSignal,
  ) {
    this.#runtime = runtime;
    this.#home = home;
    this.#identity = identity;
    this.#signal = signal;
    this.#host = normalizeSpaceHost(new URL(runtime.apiUrl).origin).origin;
    signal?.addEventListener("abort", () => this.stop(), { once: true });
    if (signal?.aborted) {
      this.#stopped = true;
      return;
    }
    // A sink publishes the value it starts from at once, so the first one has
    // started a scan by the time the second is made. A failure to make the
    // second stops that scan with the rest.
    const poke = () => this.#poke();
    try {
      this.#holders.push(
        home.key("privateInbox").asSchema(pointerSchema).sink(poke),
      );
      this.#holders.push(
        home.key("retainedPrivateInboxes").asSchema(retainedSchema).sink(poke),
      );
      this.#holders.push(
        home.key("sharedSpaces").key("profiles").asSchema(profilesSchema).sink(
          () => this.#poke(EVERY_INBOX),
        ),
      );
      // A read that failed while the connection was down may succeed once it
      // is back, and nothing else says when to ask again. Which reads failed
      // is not kept: what Home holds is read again, and every row of every
      // inbox considered, a decided row costing no more than its key.
      const restored = runtime.storageManager.subscribeConnectionRestored?.(
        () => {
          this.#poke();
          this.#poke(EVERY_INBOX);
        },
      );
      if (restored !== undefined) this.#holders.push(restored);
      // A space refused to this identity reads nothing until access comes
      // back, which its followed state alone may not say.
      const access = runtime.storageManager.subscribeSpaceAccessChange?.(
        (space) => this.#pokeWaitingOn(space),
      );
      if (access !== undefined) this.#holders.push(access);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  /**
   * What the instance last decided about each row naming `from` and `id`, for
   * a test to tell one refusal from another, and how many inboxes it follows.
   */
  get accessForTestingOnly(): {
    decisionsFor(from: string, id: string): OfferDecision[];
    readonly followedInboxes: number;
    readonly followedSpaces: number;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get followedInboxes() {
        return outerThis.#inboxes.size;
      },
      get followedSpaces() {
        return outerThis.#spaces.size;
      },
      decisionsFor: (from, id) =>
        [...this.#latest.values()]
          .filter((each) => each.from === from && each.id === id)
          .map((each) => each.decision),
    };
  }

  /**
   * Resolves once every change the instance has been told of so far has been
   * taken up: each offer then in an inbox decided or left for the next change,
   * and each registration sent to Home handled and its receipt read. A
   * registration whose handling never settles holds it.
   */
  async idle(): Promise<void> {
    await this.#drained;
    await Promise.all(this.#pending);
  }

  /**
   * Whether {@link idle} has nothing to wait for right now: no change is
   * being taken up and no registration is awaiting its handling. A caller
   * that awaits `idle()` and then something else checks this afterwards,
   * since a change arriving during the second wait is one the first had
   * stopped watching.
   */
  isIdle(): boolean {
    return !this.#draining && this.#pending.size === 0;
  }

  /** Stops following the inboxes; an offer being vetted is not sent. */
  stop(): void {
    this.#stopped = true;
    for (const cancel of this.#holders) cancel();
    for (const cancel of this.#inboxes.values()) cancel();
    for (const cancel of this.#spaces.values()) cancel();
    this.#holders = [];
    this.#inboxes.clear();
    this.#spaces.clear();
  }

  /** Whether this instance has stopped, or its runtime begun disposal. */
  get #halted(): boolean {
    return this.#stopped || this.#signal?.aborted === true ||
      this.#runtime.writeTeardownSignal.aborted;
  }

  /**
   * Notes that the offers of the inbox at `address` changed, or, with no
   * address, that which inboxes Home holds and retains may have, or, with
   * {@link EVERY_INBOX}, that every row of every inbox followed is to be
   * considered again, and takes it up once the scan under way, if any, is
   * done. Changes arriving during a scan are taken up by one more.
   */
  #poke(address?: string | typeof EVERY_INBOX): void {
    if (address === undefined) this.#holdersChanged = true;
    else if (address === EVERY_INBOX) this.#everyInbox = true;
    else this.#changedInboxes.add(address);
    if (this.#draining) return;
    this.#draining = true;
    this.#drained = this.#drain();
  }

  /** {@link #poke}s each inbox at `addresses`, once each. */
  #pokeEach(addresses: Iterable<string>): void {
    for (const address of new Set(addresses)) this.#poke(address);
  }

  /** Helper for {@link #poke}, which scans until nothing has changed since. */
  async #drain(): Promise<void> {
    try {
      while (
        (this.#holdersChanged || this.#everyInbox ||
          this.#changedInboxes.size > 0) &&
        !this.#halted
      ) {
        const holdersChanged = this.#holdersChanged;
        const everyInbox = this.#everyInbox;
        const changed = [...this.#changedInboxes];
        this.#holdersChanged = false;
        this.#everyInbox = false;
        this.#changedInboxes.clear();
        try {
          await this.#scan(holdersChanged, everyInbox, changed);
        } catch (error) {
          if (this.#halted) return;
          logger.warn("scan-failed", () => [
            "Reading Home's private inboxes for offers:",
            error,
          ]);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  /**
   * Follows the inboxes Home holds and retains, when `holdersChanged`, and
   * decides each row not yet decided in the inboxes at `changed`, or in every
   * inbox followed, when `everyInbox`. An inbox newly followed reports its
   * offers through its own subscription. A row waiting in a scanned inbox
   * that the inbox no longer holds waits there no more.
   */
  async #scan(
    holdersChanged: boolean,
    everyInbox: boolean,
    changed: string[],
  ): Promise<void> {
    if (holdersChanged) {
      const inboxes = await this.#currentInboxes();
      if (this.#halted) return;
      this.#current = inboxes;
      this.#follow(inboxes);
    }
    const addresses = everyInbox ? [...this.#current.keys()] : changed;
    const inboxes = addresses.flatMap((address) => {
      const inbox = this.#current.get(address);
      return inbox === undefined ? [] : [{ address, inbox }];
    });
    if (inboxes.length === 0) return;
    const receipts = await this.#homeReceipts();
    for (const { address, inbox } of inboxes) {
      const offers = await inbox.key("offers").asSchema(offersSchema).pull();
      if (this.#halted) return;
      const rows = Array.isArray(offers) ? offers : [];
      this.#keepWaiting(
        address,
        new Set(rows.filter(isObjectNotArray).map(rowKey)),
      );
      for (const raw of rows) {
        if (this.#halted) return;
        await this.#consider(raw, receipts, address);
      }
    }
  }

  /**
   * The inboxes Home holds and retains, by the address of the document each
   * names, read as typed links.
   */
  async #currentInboxes(): Promise<Map<string, Cell<unknown>>> {
    const held = await this.#home.key("privateInbox").asSchema(pointerSchema)
      .pull();
    const retained = await this.#home.key("retainedPrivateInboxes").asSchema(
      retainedSchema,
    ).pull();
    const links = [
      held?.piece,
      ...(Array.isArray(retained) ? retained : []),
    ].filter(isCell);
    const inboxes = new Map<string, Cell<unknown>>();
    for (const link of links) {
      const inbox = link.resolveAsCell();
      const { space, id } = inbox.getAsNormalizedFullLink();
      inboxes.set(`${space}/${id}`, inbox);
    }
    return inboxes;
  }

  /**
   * Subscribes to the offers of each of `inboxes` not yet followed, and stops
   * following any inbox no longer among them.
   */
  #follow(inboxes: Map<string, Cell<unknown>>): void {
    for (const [address, cancel] of this.#inboxes) {
      if (inboxes.has(address)) continue;
      cancel();
      this.#inboxes.delete(address);
      this.#forgetInbox(address);
    }
    for (const [address, inbox] of inboxes) {
      if (this.#inboxes.has(address)) continue;
      this.#inboxes.set(
        address,
        inbox.key("offers").asSchema(offersSchema).sink(() =>
          this.#poke(address)
        ),
      );
    }
  }

  /**
   * The offers Home's catalog holds receipts for, the spaces Home records no
   * profile for, and the profiles it can record, as {@link HomeReceipts}
   * holds them.
   */
  async #homeReceipts(): Promise<HomeReceipts> {
    return {
      received: await this.#receipts(),
      ...await this.#profileRecords(),
    };
  }

  /**
   * The spaces Home's `sharedSpaces.profiles` says Home records no profile
   * for, and those of the profiles it says a registration can record, or
   * none of either while that observation is unavailable or absent, since
   * then there is nothing to tell an offer's registration from one that
   * recorded its profile.
   *
   * @throws When the observation cannot be read, which fails the scan, so
   *   that its inboxes are taken up again when they or the observation next
   *   change rather than decided as if Home recorded nothing.
   */
  async #profileRecords(): Promise<Pick<HomeReceipts, "unrecorded" | "live">> {
    const view = await this.#home.key("sharedSpaces").key("profiles")
      .asSchema(profilesSchema).pull();
    const unrecorded = new Set<string>();
    if (view?.status !== "ready" || !isObjectNotArray(view.spaces)) {
      return { unrecorded, live: new Set() };
    }
    for (const [space, profile] of Object.entries(view.spaces)) {
      if (isObjectNotArray(profile) && profile.status === "unrecorded") {
        unrecorded.add(space);
      }
    }
    return { unrecorded, live: new Set(view.live ?? []) };
  }

  /**
   * The offers Home's catalog holds receipts for, by {@link offerIdentity},
   * each with the `profileConflict` its receipt carries, or none while the
   * catalog cannot be read, since Home's handler refuses a duplicate in any
   * case. Each is read from the `from` and `id` its receipt stores, whatever
   * the key the catalog files it under, and a receipt that stores no such
   * pair is passed over.
   */
  async #receipts(): Promise<HomeReceipts["received"]> {
    let catalog;
    try {
      catalog = await this.#home.key("sharedSpaceCatalog").asSchema(
        catalogSchema,
      ).pull();
    } catch (error) {
      if (!this.#halted) {
        logger.warn("catalog-unreadable", () => [
          "Reading the receipts in Home's catalog:",
          error,
        ]);
      }
      return new Map();
    }
    const received = new Map<string, unknown>();
    if (!isObjectNotArray(catalog?.offers)) return received;
    for (const receipt of Object.values(catalog.offers)) {
      if (
        !isObjectNotArray(receipt) || typeof receipt.from !== "string" ||
        typeof receipt.id !== "string"
      ) continue;
      received.set(
        offerIdentity(receipt.from, receipt.id),
        receipt.profileConflict,
      );
    }
    return received;
  }

  /** Decides `raw`, a row of an inbox's offers, unless it is decided already. */
  async #consider(
    raw: unknown,
    receipts: HomeReceipts,
    address: string,
  ): Promise<void> {
    if (!isObjectNotArray(raw)) return;
    const row = rowKey(raw);
    const receipt = offerIdentity(raw.from, raw.id);
    const offer = wellFormedOffer(raw);
    const conflict = receipts.received.get(receipt);
    const received = receipts.received.has(receipt);
    // A receipt for an offer naming a profile Home has not recorded for its
    // space, and has not refused or can record now, leaves it to be sent.
    const resend = received && offer?.profile !== undefined &&
      receipts.unrecorded.has(offer.space) &&
      (conflict === undefined ||
        (conflict === "unknown-profile" && receipts.live.has(offer.profile)));
    const settled = this.#settled.get(row);
    if (
      settled !== undefined &&
      !(resend && (settled === "sent" || settled === "received"))
    ) return;
    if (received && !resend) {
      this.#decide(row, raw, "received", address);
      return;
    }
    let refusal: OfferRefusal | undefined;
    let root: Cell<unknown> | undefined;
    try {
      const vetted = offer === undefined
        ? "offer-malformed"
        : await this.#refusalOf(offer);
      if (isCell(vetted)) root = vetted;
      else refusal = vetted;
    } catch (error) {
      if (this.#halted) return;
      logger.warn("vetting-failed", () => [
        `Vetting the offer ${receipt}:`,
        error,
      ]);
      return;
    }
    if (this.#halted) return;
    if (refusal !== undefined || offer === undefined) {
      this.#decide(row, raw, refusal ?? "offer-malformed", address);
      this.#logOnce(row, () => {
        logger.warn("offer-refused", () => [
          `Not registering the offer ${receipt} (${refusal}) of`,
          raw.space,
          "at",
          raw.host,
        ]);
      });
      return;
    }
    // The handling is tracked from before the send, so that `idle()` waits
    // for it however soon the send settles.
    const handled = Promise.withResolvers<NormalizedFullLink | undefined>();
    const room = offer.kind === CHAT_ROOM_SPACE_KIND ? root : undefined;
    const pending = handled.promise.then((link) =>
      link === undefined
        ? undefined
        : this.#afterRegistration(row, receipt, link, room)
    );
    try {
      sendEvent(
        this.#home.key("registerSharedSpace"),
        {
          space: offer.space,
          host: offer.host,
          kind: offer.kind,
          ...(offer.title === "" ? {} : { title: offer.title }),
          offer: { from: offer.from, id: offer.id },
          ...(offer.profile === undefined ? {} : { profile: offer.profile }),
        },
        (tx) => handled.resolve(tx.handlingReceiptLink),
      );
    } catch (error) {
      // The row is left undecided, to be vetted again when its inbox next
      // changes or a lost connection to the host comes back.
      logger.warn("send-failed", () => [
        `Sending Home the offer ${receipt}:`,
        error,
      ]);
      return;
    }
    logger.info("offer-sent", () => [`Sent Home the offer ${receipt}`]);
    this.#decide(row, raw, "sent", address);
    this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending));
  }

  /**
   * Records `decision` for the row keyed `row`, in the inbox at `address`,
   * and settles it for the life of the instance, unless it is a refusal for
   * the state of the row's space, which leaves it waiting on a change to that
   * state (`followSpaceState`).
   */
  #decide(
    row: string,
    raw: Record<string, unknown>,
    decision: OfferDecision,
    address: string,
  ): void {
    this.#latest.set(row, { from: raw.from, id: raw.id, decision });
    if (STATE_REFUSALS.has(decision)) {
      // A refusal for a space's state is only ever made of a well-formed
      // offer, whose space is a DID.
      if (isWellFormedDID(raw.space)) this.#waitOn(row, raw.space, address);
      return;
    }
    this.#settled.set(row, decision);
    this.#stopWaiting(row);
  }

  /**
   * Has the row keyed `row`, in the inbox at `address`, taken up again when
   * the state of `space` changes, following that state if nothing yet does.
   */
  #waitOn(row: string, space: DID, address: string): void {
    const rows = this.#waiting.get(address) ?? new Map<string, DID>();
    rows.set(row, space);
    this.#waiting.set(address, rows);
    if (this.#spaces.has(space)) return;
    // The sinks call back at once; that pokes the row's inbox, which the scan
    // under way takes up after it.
    this.#spaces.set(
      space,
      followSpaceState(this.#runtime, space, () => this.#pokeWaitingOn(space)),
    );
  }

  /** {@link #poke}s each inbox a row of {@link #waiting} naming `space` waits in. */
  #pokeWaitingOn(space: string): void {
    this.#pokeEach(
      [...this.#waiting]
        .filter(([, rows]) => [...rows.values()].some((each) => each === space))
        .map(([address]) => address),
    );
  }

  /** Takes the row keyed `row`, decided, out of every inbox it waits in. */
  #stopWaiting(row: string): void {
    for (const rows of this.#waiting.values()) rows.delete(row);
    this.#releaseSpaces();
  }

  /**
   * Keeps waiting in the inbox at `address` only the rows whose keys `held`
   * holds, those its offers hold now.
   */
  #keepWaiting(address: string, held: Set<string>): void {
    const rows = this.#waiting.get(address);
    if (rows === undefined) return;
    for (const row of rows.keys()) {
      if (!held.has(row)) rows.delete(row);
    }
    this.#releaseSpaces();
  }

  /** Forgets every row waiting in the inbox at `address`, no longer followed. */
  #forgetInbox(address: string): void {
    this.#waiting.delete(address);
    this.#releaseSpaces();
  }

  /**
   * Stops following the state of each space no row of {@link #waiting} names
   * any longer, and drops each inbox no row waits in.
   */
  #releaseSpaces(): void {
    const named = new Set<DID>();
    for (const [address, rows] of this.#waiting) {
      if (rows.size === 0) this.#waiting.delete(address);
      for (const space of rows.values()) named.add(space);
    }
    for (const [space, cancel] of this.#spaces) {
      if (named.has(space)) continue;
      cancel();
      this.#spaces.delete(space);
    }
  }

  /** Calls `log` the first time it is asked to for the row keyed `row`. */
  #logOnce(row: string, log: () => void): void {
    if (this.#logged.has(row)) return;
    this.#logged.add(row);
    log();
  }

  /**
   * Acts on the result of Home's handling of the row keyed `row`, in the
   * receipt at `link`: has Home's chat manager accept `room`, the vetted root
   * of the row's space when that space is a room's, when the handler
   * registered a new entry, and logs, once for the row, a `conflict` the
   * handler returned. A receipt that cannot be read is left unreported, and
   * leads to no acceptance, since the handling it describes has committed
   * either way.
   */
  async #afterRegistration(
    row: string,
    receipt: string,
    link: NormalizedFullLink,
    room: Cell<unknown> | undefined,
  ): Promise<void> {
    let result: unknown;
    try {
      result = await this.#runtime.getCellFromLink(link).pull();
    } catch {
      return;
    }
    if (this.#halted || !isObjectNotArray(result)) return;
    // A conflict over the profile the offer named registered the space all
    // the same, saying whether that admitted a new entry.
    const admitted = result.status === "registered" ||
      (result.status === "conflict" && result.registration === "registered");
    if (admitted && room !== undefined) {
      const accept = this.#home.key("chatManager").key("accept");
      if (accept.getRaw() !== undefined) {
        try {
          sendEvent(accept, { room, keepArchived: true });
        } catch (error) {
          logger.warn("accept-failed", () => [
            `Sending the chat manager the offer ${receipt}:`,
            error,
          ]);
        }
      }
    }
    if (result.status !== "conflict") return;
    const reason = result.reason;
    this.#logOnce(`conflict:${row}`, () => {
      logger.warn("registration-conflict", () => [
        `Home's catalog refused the offer ${receipt} (${reason})`,
      ]);
    });
  }

  /**
   * Why `offer` is not registered, or, when it is, its space's root, as
   * {@link ShareIntake} lists the checks.
   *
   * @throws When reading the space's access list or root fails other than by
   *   a refusal of access, or when the host cannot tell the space's kind.
   */
  async #refusalOf(
    offer: VettableOffer,
  ): Promise<OfferRefusal | Cell<unknown>> {
    if (!ADMITTED_SPACE_KINDS.has(offer.kind)) return "offer-kind-unknown";
    if (offer.host !== this.#host) return "offer-foreign-host";
    return await vetSpace(
      this.#runtime,
      offer.space,
      this.#identity,
      offer.kind,
      (acl) => isWriter(acl?.[offer.from]) ? undefined : "sender-not-member",
    );
  }
}

/**
 * What {@link ShareIntake}'s `#poke` is passed to have every row of every
 * inbox followed considered again: when Home's profile records observation
 * changes, and when a lost connection to the host comes back.
 */
const EVERY_INBOX: unique symbol = Symbol("every inbox");

/** What an instance last decided about one row, and the offer it names. */
interface RowDecision {
  /** The row's `from`, as stored. */
  from: unknown;

  /** The row's `id`, as stored. */
  id: unknown;

  /** What was decided. */
  decision: OfferDecision;
}

/**
 * The refusals that turn on state of an offer's space that can change, rather
 * than on the row itself or on the kind its space declares, which a row is
 * vetted for again when its inbox changes.
 */
const STATE_REFUSALS: ReadonlySet<OfferDecision> = new Set([
  "sender-not-member",
  "recipient-access-refused",
  "space-root-missing",
  "space-root-misplaced",
  "space-root-mismatch",
]);

/**
 * The intake's own key for the offer a sender named `from` keyed `id`, by
 * which a row is matched against the receipts in Home's catalog, and named in
 * a log.
 */
function offerIdentity(from: unknown, id: unknown): string {
  return JSON.stringify([from ?? null, id ?? null]);
}

/**
 * The key a row is decided by: its whole content, with its fields in a fixed
 * order, so two rows differing in any field are decided apart.
 */
function rowKey(raw: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(raw).sort().map((field) => [field, raw[field]]),
  );
}

/**
 * The longest `kind` an offer may carry, as the inbox cuts it: the inbox's
 * `OFFER_KIND_MAX_LENGTH`, in `patterns/system/private-inbox/private-inbox.tsx`,
 * which host code cannot import, so the two are kept in step by hand.
 */
const KIND_MAX_LENGTH = 32;

/**
 * The longest `id` an offer may carry, as the inbox cuts it: the inbox's
 * `OFFER_ID_MAX_LENGTH`, kept in step as {@link KIND_MAX_LENGTH} is.
 */
const ID_MAX_LENGTH = 320;

/**
 * The longest `title` an offer may carry, as the inbox cuts it: the inbox's
 * `OFFER_TITLE_MAX_LENGTH`, kept in step as {@link KIND_MAX_LENGTH} is.
 */
const TITLE_MAX_LENGTH = 200;

/**
 * The longest address an offer may carry, as the inbox cuts it: the inbox's
 * `OFFER_ADDRESS_MAX_LENGTH`, kept in step as {@link KIND_MAX_LENGTH} is.
 */
const ADDRESS_MAX_LENGTH = 256;

/**
 * `raw` as an offer the intake can vet, or `undefined` when its envelope is
 * malformed, as {@link ShareIntake} says.
 */
function wellFormedOffer(
  raw: Record<string, unknown>,
): VettableOffer | undefined {
  const { kind, id, space, host, ownerOrigin, title, from, sharedAt } = raw;
  const origin = boundedString(host, ADDRESS_MAX_LENGTH)
    ? originOf(host)
    : undefined;
  // A `toProfile` of `null` is the inbox saying the sender named no profile,
  // so the offer is to the person, as it is with no `toProfile` at all.
  const profile = raw.toProfile === undefined || raw.toProfile === null
    ? undefined
    : isObjectNotArray(raw.toProfile)
    ? raw.toProfile.space ?? null
    : null;
  if (
    origin === undefined ||
    !boundedString(kind, KIND_MAX_LENGTH) ||
    !boundedString(id, ID_MAX_LENGTH) ||
    !boundedString(title, TITLE_MAX_LENGTH, true) ||
    !boundedString(space, ADDRESS_MAX_LENGTH) || !isWellFormedDID(space) ||
    !boundedString(from, ADDRESS_MAX_LENGTH) || !isWellFormedDID(from) ||
    !boundedString(ownerOrigin, ADDRESS_MAX_LENGTH, true) ||
    (ownerOrigin !== "" && originOf(ownerOrigin) === undefined) ||
    typeof sharedAt !== "number" || !Number.isSafeInteger(sharedAt) ||
    sharedAt < 0 ||
    (profile !== undefined &&
      !(boundedString(profile, ADDRESS_MAX_LENGTH) && isWellFormedDID(profile)))
  ) return undefined;
  return {
    kind,
    id,
    space,
    host: origin,
    title,
    from,
    ...(profile === undefined ? {} : { profile }),
  };
}

/** Whether `value` is a string no longer than `max`, and nonempty unless `empty`. */
function boundedString(
  value: unknown,
  max: number,
  empty = false,
): value is string {
  return typeof value === "string" && (empty || value.length > 0) &&
    value.length <= max;
}

/**
 * The origin `value` names, as `normalizeSpaceHost()` normalizes it, or
 * `undefined` when it refuses `value`, as one holding a path, a query, a
 * fragment or credentials.
 */
function originOf(value: string): string | undefined {
  // Throwing is how `normalizeSpaceHost()` refuses a value, and the refusal is
  // the answer here.
  try {
    return normalizeSpaceHost(value).origin;
  } catch {
    return undefined;
  }
}
