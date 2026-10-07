/**
 * The host's share intake: it follows the offers in the private inboxes Home
 * holds and retains, vets each one as the owner, and registers each offer that
 * passes in Home's shared-space catalog through Home's `registerSharedSpace`
 * stream. Vetting reads the offered space's access list and root, and the
 * result schema stored on the root's document, which a Home handler cannot do;
 * `docs/features/private-inbox.md` describes the whole arrangement.
 */

import type { DID } from "@commonfabric/identity";
import { isWellFormedDID } from "@commonfabric/identity/did";
import { hasConcreteOwner, isACL } from "@commonfabric/memory/acl";
import {
  ACLManager,
  type Cancel,
  type Cell,
  isCell,
  type NormalizedFullLink,
  normalizeSpaceHost,
  readResultSchemaMeta,
  type Runtime,
  sendEvent,
} from "@commonfabric/runner";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { inboxPieceLinkSchema } from "./private-inbox.ts";
import { accessRefused } from "./space-access.ts";

const logger = getLogger("piece.share-intake");

/** The `kind` of the offers a loom daemon admits, which this intake skips. */
export const LOOM_OFFER_KIND = "loom";

/**
 * The kinds of offer the intake admits, each with the members a root of that
 * kind declares in its result schema. An offer of a kind not here is refused
 * and left in its inbox, and one whose space's root declares fewer members is
 * refused as not of its kind. The members are the ones a kind's contract
 * fixes, and that no other kind's root is expected to declare all of.
 *
 * - `fabrichat-room`, a FabriChat room, whose root's result is a
 *   `ChatRoomOutput` (`docs/specs/fabrichat/ChatRoomOutput.md`): `about`,
 *   `messages`, `sendMessage` and `recentActivity`.
 */
export const ADMITTED_OFFER_KINDS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  "fabrichat-room": Object.freeze([
    "about",
    "messages",
    "sendMessage",
    "recentActivity",
  ]),
});

/** Why an offer is not registered. */
export type OfferRefusal =
  | "offer-malformed"
  | "offer-kind-unknown"
  | "offer-foreign-host"
  | "sender-not-member"
  | "recipient-access-refused"
  | "space-root-missing"
  | "space-root-wrong-kind";

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
 * An offer is skipped, without being vetted, when its `kind` is `loom`, which
 * a loom daemon admits, or when the catalog already holds a receipt for its
 * sender and `id`. Any other offer is registered, with its sender and `id`, its
 * `kind`, `host` and `title`, when:
 *
 * - its envelope is well formed: `space` and `from` are well-formed DIDs,
 *   `host` and a nonempty `ownerOrigin` are each an origin, as
 *   `normalizeSpaceHost()` reads one, and every string fits the bounds the
 *   inbox cuts to;
 * - its `kind` is one of {@link ADMITTED_OFFER_KINDS};
 * - its `host` is this runtime's own, compared as `normalizeSpaceHost()`
 *   normalizes both, since that is the host whose memory this one reads;
 * - `from` holds a `WRITE` or `OWNER` entry of its own in the space's access
 *   list, a grant to every principal (`"*"`) not counting;
 * - the identity can open the space, holding `WRITE` or `OWNER` there, its own
 *   or every principal's;
 * - the space has a root, and the result schema stored on the root's document
 *   declares every member {@link ADMITTED_OFFER_KINDS} lists for the kind. That
 *   schema is what the root's creator wrote, so it classifies the root by its
 *   creator's claim; no code of the root's is loaded or run to read it.
 *
 * Each row of an inbox is decided by its whole content, so a row naming
 * another offer's sender and `id` decides nothing about that offer. A row
 * that is sent, skipped for its receipt, or refused for something in the row
 * itself (its envelope, its `kind` or its `host`) is decided for the life of
 * the instance. A row refused for the state of its space (an access list or a
 * root) is vetted again the next time its inbox's offers change; a change to
 * the space alone does not bring that about. A refusal is logged once per
 * row, under `piece.share-intake`, with its reason, and so is a `conflict`
 * Home's handler returns for a row it was sent. A failure to read what
 * vetting needs, other than a refusal of access, leaves the row to be vetted
 * when its inbox next changes. Nothing consumes an offer or deletes it.
 *
 * Registration is Home's handler's, so an offer already registered under
 * another sender or `id` leaves the entry as it is, archived or not, and adds
 * a receipt for this offer.
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
  #logged = new Set<string>();
  #holdersChanged = false;
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
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get followedInboxes() {
        return outerThis.#inboxes.size;
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

  /** Stops following the inboxes; an offer being vetted is not sent. */
  stop(): void {
    this.#stopped = true;
    for (const cancel of this.#holders) cancel();
    for (const cancel of this.#inboxes.values()) cancel();
    this.#holders = [];
    this.#inboxes.clear();
  }

  /** Whether this instance has stopped, or its runtime begun disposal. */
  get #halted(): boolean {
    return this.#stopped || this.#signal?.aborted === true ||
      this.#runtime.writeTeardownSignal.aborted;
  }

  /**
   * Notes that the offers of the inbox at `address` changed, or, with no
   * address, that which inboxes Home holds and retains may have, and takes it
   * up once the scan under way, if any, is done. Changes arriving during a
   * scan are taken up by one more.
   */
  #poke(address?: string): void {
    if (address === undefined) this.#holdersChanged = true;
    else this.#changedInboxes.add(address);
    if (this.#draining) return;
    this.#draining = true;
    this.#drained = this.#drain();
  }

  /** Helper for {@link #poke}, which scans until nothing has changed since. */
  async #drain(): Promise<void> {
    try {
      while (
        (this.#holdersChanged || this.#changedInboxes.size > 0) &&
        !this.#halted
      ) {
        const holdersChanged = this.#holdersChanged;
        const changed = [...this.#changedInboxes];
        this.#holdersChanged = false;
        this.#changedInboxes.clear();
        try {
          await this.#scan(holdersChanged, changed);
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
   * decides each row not yet decided in the inboxes at `changed`. An inbox
   * newly followed reports its offers through its own subscription.
   */
  async #scan(holdersChanged: boolean, changed: string[]): Promise<void> {
    if (holdersChanged) {
      const inboxes = await this.#currentInboxes();
      if (this.#halted) return;
      this.#current = inboxes;
      this.#follow(inboxes);
    }
    const inboxes = changed.flatMap((address) => {
      const inbox = this.#current.get(address);
      return inbox === undefined ? [] : [inbox];
    });
    if (inboxes.length === 0) return;
    const receipts = await this.#receipts();
    for (const inbox of inboxes) {
      const offers = await inbox.key("offers").asSchema(offersSchema).pull();
      for (const raw of Array.isArray(offers) ? offers : []) {
        if (this.#halted) return;
        await this.#consider(raw, receipts);
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
   * The offers Home's catalog holds receipts for, by {@link offerIdentity}, or
   * none while the catalog cannot be read, since Home's handler refuses a
   * duplicate in any case. Each is read from the `from` and `id` its receipt
   * stores, whatever the key the catalog files it under, and a receipt that
   * stores no such pair is passed over.
   */
  async #receipts(): Promise<Set<string>> {
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
      return new Set();
    }
    const received = new Set<string>();
    if (!isObjectNotArray(catalog?.offers)) return received;
    for (const receipt of Object.values(catalog.offers)) {
      if (
        isObjectNotArray(receipt) && typeof receipt.from === "string" &&
        typeof receipt.id === "string"
      ) received.add(offerIdentity(receipt.from, receipt.id));
    }
    return received;
  }

  /** Decides `raw`, a row of an inbox's offers, unless it is decided already. */
  async #consider(raw: unknown, receipts: Set<string>): Promise<void> {
    if (!isObjectNotArray(raw) || raw.kind === LOOM_OFFER_KIND) return;
    const row = rowKey(raw);
    if (this.#settled.has(row)) return;
    const receipt = offerIdentity(raw.from, raw.id);
    if (receipts.has(receipt)) {
      this.#decide(row, raw, "received");
      return;
    }
    const offer = wellFormedOffer(raw);
    let refusal: OfferRefusal | undefined;
    try {
      refusal = offer === undefined
        ? "offer-malformed"
        : await this.#refusalOf(offer);
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
      this.#decide(row, raw, refusal ?? "offer-malformed");
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
    const pending = handled.promise.then((link) =>
      link === undefined ? undefined : this.#reportConflict(row, receipt, link)
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
        },
        (tx) => handled.resolve(tx.handlingReceiptLink),
      );
    } catch (error) {
      // The row is left undecided, to be vetted again when its inbox next
      // changes.
      logger.warn("send-failed", () => [
        `Sending Home the offer ${receipt}:`,
        error,
      ]);
      return;
    }
    this.#decide(row, raw, "sent");
    this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending));
  }

  /**
   * Records `decision` for the row keyed `row`, and settles it for the life
   * of the instance unless it is a refusal for the state of the row's space.
   */
  #decide(
    row: string,
    raw: Record<string, unknown>,
    decision: OfferDecision,
  ): void {
    this.#latest.set(row, { from: raw.from, id: raw.id, decision });
    if (!STATE_REFUSALS.has(decision)) this.#settled.set(row, decision);
  }

  /** Calls `log` the first time it is asked to for the row keyed `row`. */
  #logOnce(row: string, log: () => void): void {
    if (this.#logged.has(row)) return;
    this.#logged.add(row);
    log();
  }

  /**
   * Logs, once for the row keyed `row`, a `conflict` that Home's handler
   * returned in the receipt at `link`. A receipt that cannot be read is left
   * unreported, since the handling it describes has committed either way.
   */
  async #reportConflict(
    row: string,
    receipt: string,
    link: NormalizedFullLink,
  ): Promise<void> {
    let result: unknown;
    try {
      result = await this.#runtime.getCellFromLink(link).pull();
    } catch {
      return;
    }
    if (
      this.#halted || !isObjectNotArray(result) ||
      result.status !== "conflict"
    ) return;
    const reason = result.reason;
    this.#logOnce(`conflict:${row}`, () => {
      logger.warn("registration-conflict", () => [
        `Home's catalog refused the offer ${receipt} (${reason})`,
      ]);
    });
  }

  /**
   * Why `offer` is not registered, or `undefined` when it is, as
   * {@link ShareIntake} lists the checks.
   *
   * @throws When reading the space's access list or root fails other than by
   *   a refusal of access.
   */
  async #refusalOf(offer: VettableOffer): Promise<OfferRefusal | undefined> {
    const members = Object.hasOwn(ADMITTED_OFFER_KINDS, offer.kind)
      ? ADMITTED_OFFER_KINDS[offer.kind]
      : undefined;
    if (members === undefined) return "offer-kind-unknown";
    if (offer.host !== this.#host) return "offer-foreign-host";
    const runtime = this.#runtime;
    let stored;
    let root;
    try {
      stored = await new ACLManager(runtime, offer.space).getStored();
      root = await runtime.getSpaceCell(offer.space).key("defaultPattern")
        .pull();
    } catch (error) {
      if (accessRefused(runtime, offer.space)) {
        return "recipient-access-refused";
      }
      throw error;
    }
    if (accessRefused(runtime, offer.space)) return "recipient-access-refused";
    // An access list that is malformed or names no concrete owner grants
    // nobody anything.
    const acl = isACL(stored) && hasConcreteOwner(stored) ? stored : undefined;
    if (!isWriter(acl?.[offer.from])) return "sender-not-member";
    if (!isWriter(acl?.[this.#identity] ?? acl?.["*"])) {
      return "recipient-access-refused";
    }
    // When the pointer reaches no document of the space, this read returns
    // the space cell's own `defaultPattern` key, so the path check is what
    // refuses a pointer into another space. The space check covers a read that
    // follows such a pointer; no test reaches it, since this read does not.
    if (
      !isCell(root) || root.space !== offer.space ||
      root.getAsNormalizedFullLink().path.length !== 0
    ) return "space-root-missing";
    const declared = await declaredResultMembers(root);
    if (!members.every((member) => declared.has(member))) {
      return "space-root-wrong-kind";
    }
    return undefined;
  }
}

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
 * The refusals that turn on the state of an offer's space rather than on the
 * row itself, which a row is vetted for again when its inbox changes.
 */
const STATE_REFUSALS: ReadonlySet<OfferDecision> = new Set([
  "sender-not-member",
  "recipient-access-refused",
  "space-root-missing",
  "space-root-wrong-kind",
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
 * The members the result schema stored on `root`'s document declares, or
 * none when it stores none or names none. The schema is read from the
 * document itself, so no code of the root's is loaded or run. A schema stored
 * as a reference whose documents have not arrived declares none.
 */
async function declaredResultMembers(
  root: Cell<unknown>,
): Promise<Set<string>> {
  // Loads the root's document, and with it the schema stored on it, and none
  // of its result.
  await root.asSchema({ type: "object", properties: {} }).pull();
  const schema = readResultSchemaMeta(root);
  return new Set(
    isObjectNotArray(schema) && isObjectNotArray(schema.properties)
      ? Object.keys(schema.properties)
      : [],
  );
}

/**
 * The longest `kind` an offer may carry, as the inbox cuts it: the inbox's
 * `OFFER_KIND_MAX_LENGTH`, in `packages/patterns/system/private-inbox.tsx`,
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
    sharedAt < 0
  ) return undefined;
  return { kind, id, space, host: origin, title, from };
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

/** Whether an access-list grant lets its holder write. */
function isWriter(grant: unknown): boolean {
  return grant === "WRITE" || grant === "OWNER";
}
