/**
 * The host's half of giving Home its private inbox: it finds the inbox a
 * profile already advertises, vets it, and sends Home's `ensurePrivateInbox`
 * with the inbox to adopt, if any. Vetting reads the inbox's access list and
 * two of its members, in the inbox's own space, which a Home handler cannot
 * do. It is also the client that requests the inbox from Home, as a loom
 * daemon does, and reads Home's answer; `docs/features/private-inbox.md`
 * describes the whole arrangement.
 */

import type { JSONSchema } from "@commonfabric/api";
import { debugStr } from "@commonfabric/data-model";
import type { DID } from "@commonfabric/identity";
import { hasConcreteOwner, isACL } from "@commonfabric/memory/acl";
import {
  ACLManager,
  type Cancel,
  type Cell,
  isCell,
  isStream,
  loadDocument,
  type NormalizedFullLink,
  orderProfileCandidates,
  profileCellIsValid,
  readDurable,
  type Runtime,
  sendEvent,
  transactionFailureMessage,
} from "@commonfabric/runner";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { accessRefused } from "./space-access.ts";

const logger = getLogger("piece.private-inbox");

/** Every code for why an advertised inbox is not adopted. */
export const INBOX_ADOPTION_REFUSALS = [
  "inbox-home-space",
  "inbox-profile-space",
  "inbox-access-refused",
  "inbox-adoption-acl-mismatch",
  "inbox-offers-invalid",
  "inbox-receive-missing",
] as const;

/** Why an advertised inbox is not adopted. */
export type InboxAdoptionRefusal = typeof INBOX_ADOPTION_REFUSALS[number];

/**
 * What {@link ensurePrivateInboxOf} found, and so what it sent: `held` when
 * Home keeps the inbox it holds, the deciding profile advertising it or no
 * profile advertising any; `none-advertised` when Home holds none and no
 * profile advertises one; `adopt` when the deciding profile's inbox passed
 * vetting; `refused` when it failed, for `reason`. `profile` is the deciding
 * profile, which `held` names only when that profile advertises the held
 * inbox. `abandoned` is an ensure stopped before its send, which sent nothing,
 * and `unavailable` one over a Home without the stream.
 */
export type PrivateInboxEnsure =
  | { outcome: "unavailable" }
  | { outcome: "abandoned" }
  | { outcome: "held"; profile?: Cell<unknown> }
  | { outcome: "none-advertised" }
  | { outcome: "adopt"; inbox: Cell<unknown>; profile: Cell<unknown> }
  | {
    outcome: "refused";
    reason: InboxAdoptionRefusal;
    inbox: Cell<unknown>;
    profile: Cell<unknown>;
  };

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
 * Sends `home`'s `ensurePrivateInbox`, after vetting the inbox the deciding
 * profile points at. `home` is a Home result: its `privateInbox`, `profiles`,
 * `defaultProfile`, `legacyDefaultProfile`, `mru` and `ensurePrivateInbox` are
 * read and sent as Home's are, and `identity` is the identity it belongs to.
 * The deciding profile is the first, in the order `#profile` answers in
 * (`orderProfileCandidates()`), that points at an inbox.
 *
 * The event names the deciding profile's inbox to adopt, and that profile,
 * when the inbox passes every check and Home holds none, or holds another.
 * When the inbox fails a check, the event names the refusal instead, with its
 * reason, the refused inbox and the deciding profile, for Home to record, and
 * the refusal is logged as a warning too; Home neither adopts nor replaces
 * that inbox. When the deciding profile advertises the inbox Home holds, the
 * event names that profile and nothing else, which Home takes as the end of a
 * refusal it recorded. When no profile advertises an inbox, the event names
 * nothing, and Home creates an inbox only if it holds none. A Home without the
 * stream is left as it is.
 *
 * Resolves once Home's handler has run on the event and its run has
 * committed, on the server that runs it under server execution, so that a
 * caller waiting on the ensure waits for Home's handling of it too. Rejects
 * when that handling fails.
 * Rejects, sending nothing, when a profile ordered ahead of the deciding one
 * cannot be loaded, since which profile decides is then unknown. Sends
 * nothing, and returns `abandoned`, when `signal` has aborted or `runtime`
 * has begun disposal by the time the reads are done, so that an ensure its
 * caller has stopped waiting for sends no event after teardown.
 */
export async function ensurePrivateInboxOf(
  runtime: Runtime,
  home: Cell<unknown>,
  identity: DID,
  signal?: AbortSignal,
): Promise<PrivateInboxEnsure> {
  const ensure = home.key("ensurePrivateInbox");
  if (ensure.getRaw() === undefined) return { outcome: "unavailable" };
  const found = await vetAdvertisedInbox(runtime, home, identity);
  if (signal?.aborted || runtime.writeTeardownSignal.aborted) {
    return { outcome: "abandoned" };
  }
  if (found.outcome === "refused") {
    logger.warn("adoption-refused", () => [
      `Not adopting the inbox a profile advertises (${found.reason}):`,
      found.inbox.getAsNormalizedFullLink(),
    ]);
  }
  await new Promise<void>((resolve, reject) =>
    sendEvent(ensure, ensureEventOf(found), (tx) => {
      const status = tx.status();
      if (status.status === "error") {
        reject(new Error(transactionFailureMessage(status.error)));
      } else resolve();
    })
  );
  return found;
}

/**
 * What {@link requestPrivateInboxOf} learned from Home: `ensured` once the
 * profile the request named points at the inbox Home holds, which `inbox`
 * links as the profile's pointer does; `unlisted` when that profile is not in
 * Home's list; `unpointable` when it has no `setInbox`, so Home never points
 * it; `not-held` when it points at an inbox Home does not hold, or Home holds
 * none and creates none because another profile advertises one.
 * `unavailable` is a Home without the stream, which is sent nothing, and
 * `abandoned` a request whose caller stopped waiting before Home answered.
 */
export type PrivateInboxRequestOutcome =
  | { status: "unavailable" }
  | { status: "abandoned" }
  | { status: "ensured"; inbox: Cell<unknown> }
  | { status: "unlisted" }
  | { status: "unpointable" }
  | { status: "not-held" };

/** How {@link requestPrivateInboxOf} reads Home's answer in its receipt. */
const answerSchema = {
  type: "object",
  properties: { status: { type: "string" } },
} as const satisfies JSONSchema;

/**
 * Sends `home`'s `requestPrivateInbox`, naming `profile`, and resolves with
 * Home's answer once it is no longer `pending`, so that an `ensured` answer
 * arrives only once `profile` points at the inbox Home holds. `home` is a Home
 * result, and `profile` the profile the caller finds the owner by, the one
 * `#profile` answers with. Home ensures its inbox as an event naming nothing
 * has its `ensurePrivateInbox` do, so it creates one only when it holds none
 * and no profile advertises one, and adopts none.
 *
 * Home answers in the handling's receipt, whose address the send's completion
 * carries: a final answer, or a link to Home's answer for the profile, which
 * changes as Home's holder and the profile's pointer do. This subscribes to
 * the receipt, through the link, and settles on the first answer that is not
 * `pending`; for `ensured`, it then reads the inbox from the profile's pointer,
 * waiting for it to name one. It reads both past this runtime's own
 * speculation, so under server execution it settles on what the server wrote,
 * never on this runtime's preview of Home's answer. Returns `unavailable`,
 * sending nothing, for a Home without the stream, and `abandoned` once
 * `signal` aborts: sending nothing when it has aborted already, and otherwise
 * at whatever point it is waiting, Home's handling of a request already sent
 * going on regardless.
 *
 * @throws When the send fails, when Home's handling of it fails or writes no
 *   receipt, or when Home answers with a status this host does not know.
 */
export async function requestPrivateInboxOf(
  runtime: Runtime,
  home: Cell<unknown>,
  profile: Cell<unknown>,
  signal?: AbortSignal,
): Promise<PrivateInboxRequestOutcome> {
  const request = home.key("requestPrivateInbox");
  if (request.getRaw() === undefined) return { status: "unavailable" };
  if (signal?.aborted) return { status: "abandoned" };
  const handled = new Promise<NormalizedFullLink>((resolve, reject) =>
    sendEvent(request, { from: profile }, (tx) => {
      const status = tx.status();
      if (status.status === "error") {
        reject(new Error(transactionFailureMessage(status.error)));
      } else if (tx.handlingReceiptLink === undefined) {
        reject(new Error("Home's handling of the request wrote no receipt"));
      } else resolve(tx.handlingReceiptLink);
    })
  );
  const receipt = await untilAborted(handled, signal);
  if (receipt === undefined) return { status: "abandoned" };
  const status = await firstPicked(
    runtime,
    runtime.getCellFromLink(receipt, answerSchema),
    (answer) =>
      answer?.status === undefined || answer.status === "pending"
        ? undefined
        : answer.status,
    signal,
  );
  switch (status) {
    case undefined:
      return { status: "abandoned" };
    case "unlisted":
    case "unpointable":
    case "not-held":
      return { status };
    case "ensured": {
      const inbox = await firstPicked(
        runtime,
        profile.key("inbox").asSchema(pointerSchema),
        // The read's transaction closes once the read is done, so the cell
        // handed back is detached from it.
        (pointer) =>
          isCell(pointer?.piece) ? pointer.piece.withTx() : undefined,
        signal,
      );
      return inbox === undefined
        ? { status: "abandoned" }
        : { status: "ensured", inbox };
    }
    default:
      throw new Error(debugStr`Home answered the request with $quote${status}`);
  }
}

/**
 * Helper for {@link requestPrivateInboxOf}, which resolves as `promise` does,
 * or with `undefined` once `signal` aborts, whichever comes first.
 */
function untilAborted<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T | undefined> {
  if (signal === undefined) return promise;
  const { promise: aborted, resolve } = Promise.withResolvers<undefined>();
  const abandon = () => resolve(undefined);
  signal.addEventListener("abort", abandon);
  return Promise.race([promise, aborted]).finally(() =>
    signal.removeEventListener("abort", abandon)
  );
}

/**
 * Helper for {@link requestPrivateInboxOf}, which resolves with what `pick`
 * makes of the first of `cell`'s durable values that `pick` makes anything of,
 * or with `undefined` once `signal` aborts. A durable value is one read past
 * this runtime's speculation overlay (`readDurable()`), so under server
 * execution it is what the server wrote, never this runtime's own preview of
 * it, which can mix values from different moments. It reads again on each
 * change a subscription to `cell` delivers, and once the speculation layers
 * over what it read have settled, since a change beneath a layer delivers
 * nothing.
 */
function firstPicked<T, R>(
  runtime: Runtime,
  cell: Cell<T>,
  pick: (value: Readonly<T>) => R | undefined,
  signal?: AbortSignal,
): Promise<R | undefined> {
  const { promise, resolve } = Promise.withResolvers<R | undefined>();
  // Where `sink()`'s cancel is kept: a callback can run before it returns.
  const subscription: { cancel?: Cancel } = {};
  let settled = false;
  const settle = (picked: R | undefined) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", abandon);
    subscription.cancel?.();
    resolve(picked);
  };
  const abandon = () => settle(undefined);
  const check = () => {
    if (settled) return;
    const { value, speculationSettled } = readDurable(
      runtime,
      (tx) => pick(cell.withTx(tx).get()),
    );
    if (value !== undefined) settle(value);
    else speculationSettled?.then(check);
  };
  if (signal?.aborted) {
    abandon();
    return promise;
  }
  signal?.addEventListener("abort", abandon);
  subscription.cancel = cell.sink(check);
  if (settled) subscription.cancel();
  return promise;
}

/** The event {@link ensurePrivateInboxOf} sends Home for what it `found`. */
function ensureEventOf(
  found: Exclude<PrivateInboxEnsure, { outcome: "unavailable" | "abandoned" }>,
): Record<string, unknown> {
  switch (found.outcome) {
    case "adopt":
      return { adopt: found.inbox, from: found.profile };
    case "refused":
      return {
        from: found.profile,
        refused: { reason: found.reason, inbox: found.inbox },
      };
    case "held":
      return found.profile === undefined ? {} : { from: found.profile };
    case "none-advertised":
      return {};
  }
}

/**
 * Decides which inbox, if any, `home` adopts. Home keeps an inbox it holds
 * while the deciding profile advertises it, or while no profile advertises
 * one. Otherwise the inbox to vet is the deciding profile's, adopted if it
 * passes every check. A profile whose stored pointer is not an object holding
 * a link advertises nothing.
 */
async function vetAdvertisedInbox(
  runtime: Runtime,
  home: Cell<unknown>,
  identity: DID,
): Promise<
  Exclude<PrivateInboxEnsure, { outcome: "unavailable" | "abandoned" }>
> {
  const held = await storedPointer(home.key("privateInbox"));
  const deciding = await decidingProfile(runtime, home);
  if (deciding === undefined) {
    return { outcome: held === undefined ? "none-advertised" : "held" };
  }
  const { profile, piece } = deciding;
  if (held !== undefined && await isSameDocument(piece, held)) {
    return { outcome: "held", profile };
  }
  const inbox = piece.resolveAsCell();
  const reason = await refusalOf(runtime, inbox, {
    home: home.space,
    profile: profile.space,
    identity,
  });
  return reason === undefined
    ? { outcome: "adopt", inbox, profile }
    : { outcome: "refused", reason, inbox, profile };
}

/**
 * The first of `home`'s profiles, in the order `#profile` answers in, that
 * points at an inbox, with the link it holds; `undefined` when none does.
 * Loads what `orderProfileCandidates()` reads first. A profile whose document
 * is absent is left out, as `#profile` leaves it out, and one whose document
 * failed to load is ordered with the rest, as `#profile` orders it.
 *
 * @throws When a profile ordered ahead of the one found failed to load, since
 *   whether it advertises an inbox is then unknown.
 */
async function decidingProfile(
  runtime: Runtime,
  home: Cell<unknown>,
): Promise<{ profile: Cell<unknown>; piece: Cell<unknown> } | undefined> {
  const list = await home.key("profiles").asSchema(profilesSchema).pull();
  const length = Array.isArray(list) ? list.length : 0;
  if (length === 0) return undefined;
  const profilesCell = home.key("profiles").resolveAsCell();
  const unreadable = new Map<Cell<unknown>, unknown>();
  const loaded = await Promise.all(
    Array.from({ length }, async (_, index) => {
      const entry = profilesCell.key(index);
      const profile = entry.resolveAsCell();
      const valid = profileCellIsValid(
        profile,
        entry.getRaw() !== undefined,
        home.space,
      );
      if (!valid) return undefined;
      try {
        if (!await loadDocument(runtime, profile)) return undefined;
      } catch (error) {
        unreadable.set(profile, error);
        return profile;
      }
      if (accessRefused(runtime, profile.space)) {
        unreadable.set(profile, new Error("access refused"));
      }
      return profile;
    }),
  );
  const candidates = loaded.filter((each) => each !== undefined);
  if (candidates.length === 0) return undefined;
  await Promise.all(
    ["defaultProfile", "legacyDefaultProfile", "mru"].map((key) =>
      home.key(key).resolveAsCell().sync()
    ),
  );
  const { ordered } = orderProfileCandidates(
    runtime,
    home,
    home.space,
    candidates,
  );
  for (const profile of ordered) {
    if (unreadable.has(profile)) {
      throw new Error(
        `Cannot read the profile that decides Home's private inbox: ${profile.space}`,
        { cause: unreadable.get(profile) },
      );
    }
    const piece = await storedPointer(profile.key("inbox"));
    if (piece !== undefined) return { profile, piece };
  }
  return undefined;
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

/** The value stored where `cell` leads, following the links on the way. */
async function storedValue(cell: Cell<unknown>): Promise<unknown> {
  await cell.sync();
  const target = cell.resolveAsCell();
  await target.sync();
  return target.getRaw();
}
