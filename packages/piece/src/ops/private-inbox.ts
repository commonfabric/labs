/**
 * The host's half of giving Home its private inbox: it finds the inbox a
 * profile already advertises, vets it, and sends Home's `ensurePrivateInbox`
 * with the inbox to adopt, if any. Vetting reads the inbox's access list and
 * two of its members, in the inbox's own space, which a Home handler cannot
 * do; `docs/features/private-inbox.md` describes the whole arrangement.
 */

import type { DID } from "@commonfabric/identity";
import {
  ACLManager,
  type Cell,
  isCell,
  isStream,
  type Runtime,
} from "@commonfabric/runner";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray } from "@commonfabric/utils/types";

const logger = getLogger("piece.private-inbox");

/** Why an advertised inbox is not adopted. */
export type InboxAdoptionRefusal =
  | "inbox-home-space"
  | "inbox-profile-space"
  | "inbox-access-refused"
  | "inbox-adoption-acl-mismatch"
  | "inbox-offers-invalid"
  | "inbox-receive-missing";

/** What {@link ensurePrivateInboxOf} found, and so what it sent. */
export type PrivateInboxEnsure =
  | { outcome: "unavailable" }
  | { outcome: "held" }
  | { outcome: "none-advertised" }
  | { outcome: "adopt"; inbox: Cell<unknown> }
  | { outcome: "refused"; reason: InboxAdoptionRefusal; inbox: Cell<unknown> };

const profilesSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
} as const;

const pointerSchema = {
  type: "object",
  properties: { piece: { type: "unknown", asCell: ["cell"] } },
} as const;

/**
 * Sends `home`'s `ensurePrivateInbox`, after vetting the inbox the first of
 * `home`'s profiles that points at one points at. `home` is a Home result:
 * its `privateInbox`, `profiles` and `ensurePrivateInbox` are read and sent as
 * Home's are, and `identity` is the identity it belongs to.
 *
 * The event names the inbox to adopt when Home holds none and the advertised
 * inbox passes every check, and names none otherwise. Given none, Home creates
 * an inbox only when no profile advertises one, so an advertised inbox that
 * fails a check is neither adopted nor replaced; that refusal is logged as a
 * warning. A Home without the stream is left as it is.
 *
 * Resolves once the event is sent, which is before Home's handler runs.
 */
export async function ensurePrivateInboxOf(
  runtime: Runtime,
  home: Cell<unknown>,
  identity: DID,
): Promise<PrivateInboxEnsure> {
  const ensure = home.key("ensurePrivateInbox");
  if (ensure.getRaw() === undefined) return { outcome: "unavailable" };
  const found = await vetAdvertisedInbox(runtime, home, identity);
  if (found.outcome === "refused") {
    logger.warn("adoption-refused", () => [
      `Not adopting the inbox a profile advertises (${found.reason}):`,
      found.inbox.getAsNormalizedFullLink(),
    ]);
  }
  await ensure.send(found.outcome === "adopt" ? { adopt: found.inbox } : {});
  return found;
}

/**
 * Decides which inbox, if any, `home` adopts: none when Home holds one or no
 * profile advertises one, and otherwise the inbox the first profile in Home's
 * list that points at one points at, if it passes every check. A profile whose
 * stored pointer is not an object holding a link advertises nothing.
 */
async function vetAdvertisedInbox(
  runtime: Runtime,
  home: Cell<unknown>,
  identity: DID,
): Promise<Exclude<PrivateInboxEnsure, { outcome: "unavailable" }>> {
  if (await storedPointer(home.key("privateInbox")) !== undefined) {
    return { outcome: "held" };
  }
  const profiles = await home.key("profiles").asSchema(profilesSchema).pull();
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (!isCell(profile)) continue;
    const piece = await storedPointer(profile.key("inbox"));
    if (piece === undefined) continue;
    const inbox = piece.resolveAsCell();
    const reason = await refusalOf(runtime, inbox, {
      home: home.space,
      profile: profile.resolveAsCell().space,
      identity,
    });
    return reason === undefined
      ? { outcome: "adopt", inbox }
      : { outcome: "refused", reason, inbox };
  }
  return { outcome: "none-advertised" };
}

/**
 * The link a pointer holder, Home's `privateInbox` or a profile's `inbox`,
 * holds under `piece`, or `undefined` when it holds none. A holder whose stored
 * value is not an object, or whose `piece` is not a link, holds none.
 */
async function storedPointer(
  holder: Cell<unknown>,
): Promise<Cell<unknown> | undefined> {
  const container = await holder.asSchema({ asCell: ["cell"] }).pull();
  const stored = isCell(container) ? container.getRaw() : container;
  if (!isObjectNotArray(stored) || !isObjectNotArray(stored.piece)) {
    return undefined;
  }
  const pointer = await holder.asSchema(pointerSchema).pull();
  return isCell(pointer?.piece) ? pointer.piece : undefined;
}

/**
 * Why `inbox` cannot become Home's, or `undefined` when it can: it lives in a
 * space of its own, neither Home's nor the advertising profile's, which grants
 * `identity` `OWNER` and every principal `WRITE`, and it holds a list of offers
 * and a `receive` stream.
 */
async function refusalOf(
  runtime: Runtime,
  inbox: Cell<unknown>,
  spaces: { home: DID; profile: DID; identity: DID },
): Promise<InboxAdoptionRefusal | undefined> {
  if (inbox.space === spaces.home || inbox.space === spaces.identity) {
    return "inbox-home-space";
  }
  if (inbox.space === spaces.profile) return "inbox-profile-space";
  let acl;
  let offers;
  let receive;
  try {
    acl = await new ACLManager(runtime, inbox.space).get();
    // The stored list rather than a projection of it: an array schema would
    // project malformed data into an empty list. A stream is read without a
    // schema, since a stream schema answers a stream at any path.
    offers = await storedValue(inbox.key("offers"));
    receive = await inbox.key("receive").pull();
  } catch (error) {
    if (accessRefused(runtime, inbox.space)) return "inbox-access-refused";
    throw error;
  }
  if (accessRefused(runtime, inbox.space)) return "inbox-access-refused";
  if (acl?.[spaces.identity] !== "OWNER" || acl?.["*"] !== "WRITE") {
    return "inbox-adoption-acl-mismatch";
  }
  if (!Array.isArray(offers)) return "inbox-offers-invalid";
  if (!isStream(receive)) return "inbox-receive-missing";
  return undefined;
}

/** Whether this runtime has been refused access to `space`. */
function accessRefused(runtime: Runtime, space: DID): boolean {
  return Boolean(
    runtime.storageManager.spaceAccessError?.(space) ??
      runtime.storageManager.authorizationError?.(space),
  );
}

/** The value stored where `cell` leads, following the links on the way. */
async function storedValue(cell: Cell<unknown>): Promise<unknown> {
  await cell.sync();
  const target = cell.resolveAsCell();
  await target.sync();
  return target.getRaw();
}
