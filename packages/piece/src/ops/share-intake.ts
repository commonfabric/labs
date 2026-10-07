/**
 * The host's share intake: it follows the offers in the private inboxes Home
 * holds and retains, vets each one as the owner, and registers each offer that
 * passes in Home's shared-space catalog through Home's `registerSharedSpace`
 * stream. Vetting reads the offered space's access list and root, in that
 * space, which a Home handler cannot do; `docs/features/private-inbox.md`
 * describes the whole arrangement.
 */

import type { DID } from "@commonfabric/identity";
import { isWellFormedDID } from "@commonfabric/identity/did";
import { hasConcreteOwner, isACL } from "@commonfabric/memory/acl";
import {
  ACLManager,
  type Cancel,
  type Cell,
  isCell,
  type Runtime,
} from "@commonfabric/runner";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { inboxPieceLinkSchema } from "./private-inbox.ts";

const logger = getLogger("piece.share-intake");

/** The `kind` of the offers a loom daemon admits, which this intake skips. */
export const LOOM_OFFER_KIND = "loom";

/** Why an offer is not registered. */
export type OfferRefusal =
  | "offer-malformed"
  | "offer-foreign-host"
  | "sender-not-member"
  | "recipient-access-refused"
  | "space-root-missing";

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
 *   `host` and a nonempty `ownerOrigin` are each their own origin, and every
 *   string fits the bounds the inbox cuts to;
 * - its `host` is this runtime's own, whose memory is the one this host can
 *   read;
 * - `from` holds a `WRITE` or `OWNER` entry of its own in the space's access
 *   list, a grant to every principal (`"*"`) not counting;
 * - the identity can open the space, holding `WRITE` or `OWNER` there, its own
 *   or every principal's;
 * - the space has a root.
 *
 * A refused offer is logged once, under `piece.share-intake`, with its reason.
 * Each offer is decided once per instance: an offer refused, or sent, is not
 * vetted again, though a failure to read what vetting needs, other than a
 * refusal of access, leaves it to be vetted when an inbox next changes.
 * Nothing consumes an offer or deletes it.
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
  #decided = new Map<string, OfferDecision>();
  #dirty = false;
  #draining = false;
  #drained: Promise<void> = Promise.resolve();
  #stopped = false;

  /**
   * Constructs an instance following `home`'s inboxes on `runtime`, as
   * `identity`, until {@link stop} is called or `signal` aborts.
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
    this.#host = new URL(runtime.apiUrl).origin;
    signal?.addEventListener("abort", () => this.stop(), { once: true });
    if (signal?.aborted) {
      this.#stopped = true;
      return;
    }
    // Each subscription is kept as it is made, so that `signal` ends the
    // first even when making the second throws.
    const poke = () => this.#poke();
    this.#holders.push(
      home.key("privateInbox").asSchema(pointerSchema).sink(poke),
    );
    this.#holders.push(
      home.key("retainedPrivateInboxes").asSchema(retainedSchema).sink(poke),
    );
  }

  /**
   * What the instance has decided about each offer, by the offer's receipt
   * key, which a test reads to tell one refusal from another.
   */
  get accessForTestingOnly(): {
    readonly decided: ReadonlyMap<string, OfferDecision>;
  } {
    return { decided: this.#decided };
  }

  /**
   * Resolves once every change the instance has been told of so far has been
   * taken up: each offer then in an inbox decided or left for the next change.
   */
  idle(): Promise<void> {
    return this.#drained;
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
   * Notes that something the intake follows changed, and takes it up once the
   * scan under way, if any, is done. Changes arriving during a scan are taken
   * up by one more scan.
   */
  #poke(): void {
    this.#dirty = true;
    if (this.#draining) return;
    this.#draining = true;
    this.#drained = this.#drain();
  }

  /** Helper for {@link #poke}, which scans until nothing has changed since. */
  async #drain(): Promise<void> {
    try {
      while (this.#dirty && !this.#halted) {
        this.#dirty = false;
        try {
          await this.#scan();
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
   * Subscribes to each inbox Home holds or retains, and decides each offer in
   * them not yet decided.
   */
  async #scan(): Promise<void> {
    const inboxes = await this.#currentInboxes();
    if (this.#halted) return;
    this.#follow(inboxes);
    const receipts = await this.#receipts();
    for (const inbox of inboxes.values()) {
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
        inbox.key("offers").asSchema(offersSchema).sink(() => this.#poke()),
      );
    }
  }

  /**
   * The keys of the receipts Home's catalog holds, or none while the catalog
   * cannot be read, since Home's handler refuses a duplicate in any case.
   */
  async #receipts(): Promise<Set<string>> {
    const catalog = await this.#home.key("sharedSpaceCatalog").asSchema(
      catalogSchema,
    ).pull();
    return new Set(
      isObjectNotArray(catalog?.offers) ? Object.keys(catalog.offers) : [],
    );
  }

  /** Decides `raw`, a row of an inbox's offers, unless it is decided already. */
  async #consider(raw: unknown, receipts: Set<string>): Promise<void> {
    if (!isObjectNotArray(raw) || raw.kind === LOOM_OFFER_KIND) return;
    const key = JSON.stringify([raw.from ?? null, raw.id ?? null]);
    if (this.#decided.has(key)) return;
    if (receipts.has(key)) {
      this.#decided.set(key, "received");
      return;
    }
    const offer = wellFormedOffer(raw);
    let refusal: OfferRefusal | undefined;
    try {
      refusal = offer === undefined
        ? "offer-malformed"
        : await this.#refusalOf(offer);
    } catch (error) {
      logger.warn("vetting-failed", () => [
        `Vetting the offer ${key}:`,
        error,
      ]);
      return;
    }
    if (this.#halted) return;
    this.#decided.set(key, refusal ?? "sent");
    if (refusal !== undefined || offer === undefined) {
      logger.warn("offer-refused", () => [
        `Not registering the offer ${key} (${refusal}) of`,
        raw.space,
        "at",
        raw.host,
      ]);
      return;
    }
    await this.#home.key("registerSharedSpace").send({
      space: offer.space,
      host: offer.host,
      kind: offer.kind,
      ...(offer.title === "" ? {} : { title: offer.title }),
      offer: { from: offer.from, id: offer.id },
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
    if (
      !isCell(root) || root.space !== offer.space ||
      root.getAsNormalizedFullLink().path.length !== 0
    ) return "space-root-missing";
    return undefined;
  }
}

/** The longest `kind` an offer may carry, as the inbox cuts it. */
const KIND_MAX_LENGTH = 32;

/** The longest `id` an offer may carry, as the inbox cuts it. */
const ID_MAX_LENGTH = 320;

/** The longest `title` an offer may carry, as the inbox cuts it. */
const TITLE_MAX_LENGTH = 200;

/** The longest address an offer may carry, as the inbox cuts it. */
const ADDRESS_MAX_LENGTH = 256;

/**
 * `raw` as an offer the intake can vet, or `undefined` when its envelope is
 * malformed, as {@link ShareIntake} says.
 */
function wellFormedOffer(
  raw: Record<string, unknown>,
): VettableOffer | undefined {
  const { kind, id, space, host, ownerOrigin, title, from, sharedAt } = raw;
  if (
    !boundedString(kind, KIND_MAX_LENGTH) ||
    !boundedString(id, ID_MAX_LENGTH) ||
    !boundedString(title, TITLE_MAX_LENGTH, true) ||
    !boundedString(space, ADDRESS_MAX_LENGTH) || !isWellFormedDID(space) ||
    !boundedString(from, ADDRESS_MAX_LENGTH) || !isWellFormedDID(from) ||
    !boundedString(host, ADDRESS_MAX_LENGTH) || !isOrigin(host) ||
    !boundedString(ownerOrigin, ADDRESS_MAX_LENGTH, true) ||
    (ownerOrigin !== "" && !isOrigin(ownerOrigin)) ||
    typeof sharedAt !== "number" || !Number.isSafeInteger(sharedAt) ||
    sharedAt < 0
  ) return undefined;
  return { kind, id, space, host, title, from };
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
 * Whether `value` is an `http` or `https` origin written as its own origin, as
 * the inbox's `receive` requires of `host`.
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

/** Whether an access-list grant lets its holder write. */
function isWriter(grant: unknown): boolean {
  return grant === "WRITE" || grant === "OWNER";
}

/** Whether this runtime has been refused access to `space`. */
function accessRefused(runtime: Runtime, space: DID): boolean {
  return Boolean(
    runtime.storageManager.spaceAccessError?.(space) ??
      runtime.storageManager.authorizationError?.(space),
  );
}
