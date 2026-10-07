/**
 * The host's half of giving Home its private inbox: it finds the inbox a
 * profile already advertises, vets it, and sends Home's `ensurePrivateInbox`
 * with the inbox to adopt, if any. Vetting reads the inbox's access list and
 * two of its members, in the inbox's own space, which a Home handler cannot
 * do; `docs/features/private-inbox.md` describes the whole arrangement.
 */

import type { JSONSchema } from "@commonfabric/api";
import type { DID } from "@commonfabric/identity";
import { hasConcreteOwner, isACL } from "@commonfabric/memory/acl";
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

/**
 * What {@link ensurePrivateInboxOf} found, and so what it sent: `held` when
 * Home keeps the inbox it holds, a profile advertising it or none advertising
 * any; `none-advertised` when Home holds none and no profile advertises one;
 * `adopt` when the advertised inbox passed vetting; `refused` when it failed,
 * for `reason`.
 */
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

/**
 * The link the host reads an inbox pointer through: a link to a piece naming
 * its name and nothing else, as `ShareInboxPiece` in
 * `packages/patterns/system/profile-home.tsx` types it. A pointer read through
 * an untyped link joins the inbox's confidentiality label, which is what
 * `docs/features/private-inbox.md` says every reader avoids.
 */
export const inboxPieceLinkSchema = {
  type: "object",
  properties: { $NAME: { type: "string" } },
  asCell: ["cell"],
} as const satisfies JSONSchema;

const pointerSchema = {
  type: "object",
  properties: { piece: inboxPieceLinkSchema },
} as const satisfies JSONSchema;

/**
 * Sends `home`'s `ensurePrivateInbox`, after vetting the inbox the first of
 * `home`'s profiles that points at one points at. `home` is a Home result:
 * its `privateInbox`, `profiles` and `ensurePrivateInbox` are read and sent as
 * Home's are, and `identity` is the identity it belongs to.
 *
 * The event names the inbox to adopt when the advertised inbox passes every
 * check and Home holds none, or holds one that no profile advertises; it names
 * none otherwise. Given none, Home creates an inbox only when it holds none and
 * no profile advertises one, so an advertised inbox that fails a check is
 * neither adopted nor replaced; that refusal is logged as a warning. A Home
 * without the stream is left as it is.
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
 * Decides which inbox, if any, `home` adopts. Home keeps an inbox it holds
 * while some profile in its list advertises that inbox, or while no profile
 * advertises one. Otherwise the inbox to vet is the one the first profile in
 * the list that points at an inbox points at, adopted if it passes every
 * check. A profile whose stored pointer is not an object holding a link
 * advertises nothing.
 */
async function vetAdvertisedInbox(
  runtime: Runtime,
  home: Cell<unknown>,
  identity: DID,
): Promise<Exclude<PrivateInboxEnsure, { outcome: "unavailable" }>> {
  const held = await storedPointer(home.key("privateInbox"));
  const profiles = await home.key("profiles").asSchema(profilesSchema).pull();
  let first: { piece: Cell<unknown>; profile: Cell<unknown> } | undefined;
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (!isCell(profile)) continue;
    const piece = await storedPointer(profile.key("inbox"));
    if (piece === undefined) continue;
    if (held !== undefined && await isSameDocument(piece, held)) {
      return { outcome: "held" };
    }
    first ??= { piece, profile };
    // Only a held inbox needs every profile read, to learn whether any of
    // them advertises it.
    if (held === undefined) break;
  }
  if (first === undefined) {
    return { outcome: held === undefined ? "none-advertised" : "held" };
  }
  const inbox = first.piece.resolveAsCell();
  const reason = await refusalOf(runtime, inbox, {
    home: home.space,
    profile: first.profile.resolveAsCell().space,
    identity,
  });
  return reason === undefined
    ? { outcome: "adopt", inbox }
    : { outcome: "refused", reason, inbox };
}

/**
 * Whether links `a` and `b` reach one document, as Home's handler compares
 * them, once the documents they name have loaded.
 */
async function isSameDocument(
  a: Cell<unknown>,
  b: Cell<unknown>,
): Promise<boolean> {
  await Promise.all([a.sync(), b.sync()]);
  return a.equals(b);
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
  let stored;
  let offers;
  let receive;
  try {
    stored = await new ACLManager(runtime, inbox.space).getStored();
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
  // An access list that is malformed or names no concrete owner is one this
  // identity does not own.
  const acl = isACL(stored) && hasConcreteOwner(stored) ? stored : undefined;
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
