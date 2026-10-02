/**
 * The data plane of Gmail push ingest, and the store of mailbox bindings it
 * reads.
 *
 * Gmail's `users.watch` publishes to a Cloud Pub/Sub topic whenever a watched
 * mailbox changes, and a push subscription delivers each message here as a
 * POST carrying a Google-signed OIDC token. A message names the mailbox and
 * its latest history id and nothing more, so what reaches the user's space is
 * a wake-up signal: the reader resyncs the mailbox from its own cursor. A
 * mailbox reaches a space through a binding from its address to an ingest
 * channel, which the channel's owner makes on the control plane
 * (`routes/ingest-channels`), and each notification appends one record to
 * the journal of every live channel bound to its mailbox. See
 * `docs/features/gmail-push-ingest.md`.
 */

import { errors, jwtVerify, type JWTVerifyGetKey } from "@panva/jose";
import { sha256 } from "@commonfabric/content-hash";
import type { JSONSchema, MemorySpace, Runtime } from "@commonfabric/runner";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import { isObjectNotArray } from "@commonfabric/utils/types";

import {
  appendToJournal,
  channelRefusal,
  type ClaimCheck,
  type ClaimRequest,
  ClaimStoreFullError,
  getRegistration,
  type IngestLogger,
  recordLastSeen,
  RequestAlreadyClaimedError,
  requestClaim,
} from "@/routes/ingest/ingest.utils.ts";

/** How many channels one mailbox may be bound to at once. */
export const MAX_CHANNELS_PER_MAILBOX = 8;

/** Where Google publishes the keys that sign Pub/Sub push tokens. */
export const GOOGLE_OIDC_JWKS_URL =
  "https://www.googleapis.com/oauth2/v3/certs";

/** Gmail's profile endpoint, which names the mailbox an access token reads. */
export const GMAIL_PROFILE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/profile";

/** The `iss` values Google puts on the OIDC tokens it signs. */
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

// Addresses are bounded the way SMTP bounds them, and must carry an `@`. That
// is a shape check on text headed for a cell id's hash, not validation of
// the address: Gmail is the authority on which addresses exist.
const MAX_ADDRESS_LENGTH = 320;

// A history id is an unsigned 64-bit integer. It is recorded as a decimal
// string, because a JSON number that large loses precision.
const HISTORY_ID_RE = /^[0-9]{1,20}$/;

const ChannelListSchema = {
  type: "array",
  items: { type: "string" },
} as const satisfies JSONSchema;

const ChannelBindingSchema = {
  type: "object",
  properties: { mailbox: { type: "string" } },
} as const satisfies JSONSchema;

/** What a channel is bound to. An empty object is a channel since unbound. */
interface ChannelBinding {
  /** The key of the bound mailbox, as `mailboxKey()` derives it. */
  mailbox?: string;
}

/** Thrown when a mailbox already has as many live channels as it may. */
export class MailboxBindingFullError extends Error {
  constructor() {
    super(`mailbox already has ${MAX_CHANNELS_PER_MAILBOX} bound channels`);
    this.name = "MailboxBindingFullError";
  }
}

/** Thrown when a channel's binding moved while a bind or unbind was running. */
export class BindingConflictError extends Error {
  constructor() {
    super("channel binding changed concurrently");
    this.name = "BindingConflictError";
  }
}

/** The outcome of asking Gmail which mailbox an access token reads. */
export type MailboxLookup =
  /** The token reads this mailbox. */
  | { ok: true; emailAddress: string }
  /** Gmail refused the token, or answered with something unusable. */
  | { ok: false; reason: "rejected" | "unavailable" };

/** Everything the push handler needs besides the request itself. */
export interface GmailPushDeps {
  runtime: Runtime;

  /** The toolshed's own space, where registrations and bindings live. */
  serviceSpace: string;

  /** Resolves the key that signed a push token. */
  keys: JWTVerifyGetKey;

  /** The audience the push subscriptions put on their tokens. */
  audience: string;

  /** The service accounts whose push tokens are accepted. */
  serviceAccounts: readonly string[];

  logger?: IngestLogger;
}

/**
 * The response to a push delivery. Pub/Sub acknowledges a message on any
 * `2xx` and redelivers it otherwise, which is what decides each status: a
 * delivery that can never succeed is acknowledged and dropped, and one that
 * failed on storage is not.
 */
export type GmailPushResult =
  /** Acknowledged, having appended to `delivered` channels. */
  | { status: 200; body: { delivered: number } }
  /** No token, or one that is not a push token from an accepted account. */
  | { status: 401; body: { error: string } }
  /** A lookup or an append failed; Pub/Sub redelivers the message. */
  | { status: 502; body: { error: string } };

/** A Gmail notification, as decoded from a push envelope. */
interface GmailNotification {
  emailAddress: string;
  historyId: string;
  messageId: string;
  publishTime: string;
}

/**
 * Returns whether `address` has the shape of a mail address: bounded in
 * length, with an `@` that is neither its first nor its last character.
 */
export function isPlausibleAddress(address: string): boolean {
  const at = address.indexOf("@");
  return address.length <= MAX_ADDRESS_LENGTH && at > 0 &&
    at < address.length - 1;
}

/**
 * Derives the key a mailbox's bindings are stored under. Addresses compare
 * case-insensitively and ignoring surrounding whitespace, and the key is a
 * hash so that no address appears in a cell id.
 */
export function mailboxKey(address: string): string {
  const canonical = address.trim().toLowerCase();
  return toUnpaddedBase64url(
    sha256(new TextEncoder().encode(`gmail-push\n${canonical}`)),
  );
}

// The ids of the channels a mailbox is bound to.
const mailboxChannelsCell = (
  runtime: Runtime,
  serviceSpace: string,
  key: string,
) =>
  runtime.getCell<string[]>(
    serviceSpace as MemorySpace,
    `cf:ingest:gmail-push:mailbox:${key}`,
    ChannelListSchema,
  );

// The reverse of `mailboxChannelsCell`, so a channel can be unbound or moved
// without its owner naming the mailbox it was bound to.
const channelBindingCell = (
  runtime: Runtime,
  serviceSpace: string,
  id: string,
) =>
  runtime.getCell<ChannelBinding>(
    serviceSpace as MemorySpace,
    `cf:ingest:gmail-push:channel:${id}`,
    ChannelBindingSchema,
  );

/** Returns the ids of the channels bound to the mailbox at `address`. */
export async function getMailboxChannels(
  runtime: Runtime,
  serviceSpace: string,
  address: string,
): Promise<string[]> {
  const cell = mailboxChannelsCell(runtime, serviceSpace, mailboxKey(address));
  await cell.sync();
  await runtime.storageManager.synced();
  return [...((cell.get() as string[] | undefined) ?? [])];
}

/**
 * Binds channel `id` to the mailbox at `address`, moving it off any mailbox it
 * was bound to before. Binding a channel to the mailbox it is already bound to
 * changes nothing.
 *
 * A bound channel that no longer resolves, or can no longer take a write,
 * gives up its place in the mailbox's list here, so that dead channels do not
 * hold the mailbox at its cap.
 *
 * With `claim`, the request id is recorded in the transaction that writes the
 * binding, so a second request carrying the same id binds nothing.
 *
 * @throws MailboxBindingFullError when the mailbox is already at
 *   `MAX_CHANNELS_PER_MAILBOX` live channels.
 * @throws BindingConflictError when the channel's binding changed while this
 *   ran; the caller may try again.
 * @throws RequestAlreadyClaimedError when `claim` names a request id already
 *   used.
 * @throws ClaimStoreFullError when the caller has too many recent claims for
 *   another to be recorded.
 */
export async function bindMailbox(
  runtime: Runtime,
  serviceSpace: string,
  id: string,
  address: string,
  claim?: ClaimRequest,
): Promise<void> {
  const key = mailboxKey(address);
  const target = mailboxChannelsCell(runtime, serviceSpace, key);
  const binding = channelBindingCell(runtime, serviceSpace, id);
  const pendingClaim = claim === undefined
    ? undefined
    : requestClaim(runtime, serviceSpace, claim);
  await target.sync();
  await binding.sync();
  await pendingClaim?.cell.sync();
  await runtime.storageManager.synced();

  const previousKey = (binding.get() as ChannelBinding | undefined)?.mailbox;
  const previous = previousKey !== undefined && previousKey !== key
    ? mailboxChannelsCell(runtime, serviceSpace, previousKey)
    : undefined;
  if (previous !== undefined) {
    await previous.sync();
    await runtime.storageManager.synced();
  }

  // Decided before the transaction because reading a registration is
  // asynchronous. A channel retired between here and the commit keeps its
  // place until the next bind to this mailbox.
  const retired = new Set<string>();
  for (const other of (target.get() as string[] | undefined) ?? []) {
    if (other === id) continue;
    const registration = await getRegistration(runtime, serviceSpace, other);
    if (registration === null || channelRefusal(registration) !== null) {
      retired.add(other);
    }
  }

  let full = false;
  let moved = false;
  let claimed: ClaimCheck | undefined;
  const result = await runtime.editWithRetry((tx) => {
    full = false;
    moved = false;

    // Every check runs before any write, because `editWithRetry` commits
    // whatever the closure wrote even when it returns early. That holds for
    // the claim too: a request id is recorded only by a bind that lands.
    claimed = pendingClaim?.check(tx);
    if (claimed !== undefined && claimed.kind !== "fresh") return;
    const boundBinding = binding.withTx(tx);
    const currentKey = (boundBinding.get() as ChannelBinding | undefined)
      ?.mailbox;
    if (currentKey !== previousKey) {
      moved = true;
      return;
    }
    const boundTarget = target.withTx(tx);
    const ids = ((boundTarget.get() as string[] | undefined) ?? [])
      .filter((other) => !retired.has(other));
    if (!ids.includes(id)) {
      if (ids.length >= MAX_CHANNELS_PER_MAILBOX) {
        full = true;
        return;
      }
      ids.push(id);
    }

    claimed?.record();
    if (previous !== undefined) {
      const boundPrevious = previous.withTx(tx);
      const previousIds = (boundPrevious.get() as string[] | undefined) ?? [];
      boundPrevious.set(previousIds.filter((other) => other !== id));
    }
    boundTarget.set(ids);
    boundBinding.set({ mailbox: key });
  });
  if (result.error) {
    throw new Error(result.error.message, { cause: result.error });
  }
  throwOnRefusedClaim(claimed);
  if (moved) throw new BindingConflictError();
  if (full) throw new MailboxBindingFullError();
}

/**
 * Unbinds channel `id` from whatever mailbox it is bound to, and returns
 * whether it was bound to one.
 *
 * With `claim`, the request id is recorded even when the channel was bound to
 * nothing, so that a second request carrying the same id cannot clear a
 * binding made in between.
 *
 * @throws BindingConflictError when the channel's binding changed while this
 *   ran; the caller may try again.
 * @throws RequestAlreadyClaimedError when `claim` names a request id already
 *   used.
 * @throws ClaimStoreFullError when the caller has too many recent claims for
 *   another to be recorded.
 */
export async function unbindChannel(
  runtime: Runtime,
  serviceSpace: string,
  id: string,
  claim?: ClaimRequest,
): Promise<boolean> {
  const binding = channelBindingCell(runtime, serviceSpace, id);
  const pendingClaim = claim === undefined
    ? undefined
    : requestClaim(runtime, serviceSpace, claim);
  await binding.sync();
  await pendingClaim?.cell.sync();
  await runtime.storageManager.synced();
  const key = (binding.get() as ChannelBinding | undefined)?.mailbox;
  if (key === undefined && pendingClaim === undefined) return false;

  const channels = key === undefined
    ? undefined
    : mailboxChannelsCell(runtime, serviceSpace, key);
  if (channels !== undefined) {
    await channels.sync();
    await runtime.storageManager.synced();
  }

  let moved = false;
  let claimed: ClaimCheck | undefined;
  const result = await runtime.editWithRetry((tx) => {
    moved = false;
    claimed = pendingClaim?.check(tx);
    if (claimed !== undefined && claimed.kind !== "fresh") return;
    const boundBinding = binding.withTx(tx);
    if ((boundBinding.get() as ChannelBinding | undefined)?.mailbox !== key) {
      moved = true;
      return;
    }

    claimed?.record();
    if (channels !== undefined) {
      const boundChannels = channels.withTx(tx);
      const ids = (boundChannels.get() as string[] | undefined) ?? [];
      boundChannels.set(ids.filter((other) => other !== id));
      boundBinding.set({});
    }
  });
  if (result.error) {
    throw new Error(result.error.message, { cause: result.error });
  }
  throwOnRefusedClaim(claimed);
  if (moved) throw new BindingConflictError();
  return key !== undefined;
}

/**
 * Helper for `bindMailbox()` and `unbindChannel()`, which throws the error for
 * a claim check that found the request id used or the claim store full.
 */
function throwOnRefusedClaim(claimed: ClaimCheck | undefined): void {
  if (claimed?.kind === "used") {
    throw new RequestAlreadyClaimedError(claimed.channel);
  }
  if (claimed?.kind === "full") throw new ClaimStoreFullError();
}

/**
 * Asks Gmail which mailbox `accessToken` reads. Holding a token Gmail accepts
 * for a mailbox is what entitles a caller to bind that mailbox.
 */
export async function fetchGmailMailbox(
  accessToken: string,
): Promise<MailboxLookup> {
  let response: Response;
  try {
    response = await fetch(GMAIL_PROFILE_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    return { ok: false, reason: "rejected" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, reason: "unavailable" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  const emailAddress = isObjectNotArray(body) ? body.emailAddress : undefined;
  if (typeof emailAddress !== "string" || !isPlausibleAddress(emailAddress)) {
    return { ok: false, reason: "unavailable" };
  }
  return { ok: true, emailAddress };
}

/**
 * Helper for `isAcceptedPushToken()`, which returns whether `error` is `jose`
 * failing to fetch or read Google's keys rather than refusing a token. `jose`
 * reports a key request that timed out as `JWKSTimeout`, a fetched body that
 * is not a key set as `JWKSInvalid`, and one that answered with an error
 * status or a body that is not JSON as a bare `JOSEError`; every refusal of a
 * token is some other subclass.
 */
function isKeyFetchFailure(error: unknown): boolean {
  return error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid ||
    (error instanceof errors.JOSEError &&
      error.constructor === errors.JOSEError);
}

/**
 * Helper for `processGmailPush()`, which returns whether `authorization`
 * carries a push token Google signed for this deployment's audience, on
 * behalf of one of the accepted service accounts. A failure to fetch Google's
 * keys is thrown rather than read as a bad token.
 */
async function isAcceptedPushToken(
  deps: GmailPushDeps,
  authorization: string | undefined,
): Promise<boolean> {
  if (!authorization?.startsWith("Bearer ")) return false;
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(authorization.slice(7), deps.keys, {
      issuer: GOOGLE_ISSUERS,
      audience: deps.audience,
      algorithms: ["RS256"],
    }));
  } catch (error) {
    if (isKeyFetchFailure(error)) throw error;
    if (error instanceof errors.JOSEError) return false;
    throw error;
  }
  return payload.email_verified === true &&
    typeof payload.email === "string" &&
    deps.serviceAccounts.includes(payload.email);
}

/**
 * Helper for `processGmailPush()`, which decodes a Pub/Sub push envelope
 * carrying a Gmail notification, or returns `null` when `rawBody` is not one.
 */
function decodeNotification(rawBody: string): GmailNotification | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const message = isObjectNotArray(envelope) ? envelope.message : undefined;
  if (!isObjectNotArray(message)) return null;
  const { data, messageId, publishTime } = message;
  if (
    typeof data !== "string" || typeof messageId !== "string" ||
    typeof publishTime !== "string"
  ) {
    return null;
  }

  let notification: unknown;
  try {
    const bytes = Uint8Array.fromBase64(data);
    notification = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!isObjectNotArray(notification)) return null;
  const { emailAddress, historyId } = notification;
  if (typeof emailAddress !== "string" || !isPlausibleAddress(emailAddress)) {
    return null;
  }
  const history = Number.isSafeInteger(historyId)
    ? String(historyId)
    : historyId;
  if (typeof history !== "string" || !HISTORY_ID_RE.test(history)) {
    return null;
  }
  return { emailAddress, historyId: history, messageId, publishTime };
}

/**
 * Helper for `processGmailPush()`, which names the journal partition a
 * notification belongs in: the UTC day it was published, or today when its
 * publish time does not parse.
 */
function partitionFor(publishTime: string, now: number): string {
  const published = Date.parse(publishTime);
  const at = Number.isFinite(published) ? published : now;
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * The transport-independent core of the push handler. Verifies the push
 * token, then appends the notification to the journal of every live channel
 * bound to its mailbox.
 *
 * A notification for a mailbox nobody has bound, and a body that is not a
 * Gmail notification at all, are both acknowledged: Pub/Sub would otherwise
 * redeliver them for as long as the subscription retains them. An append
 * that fails partway through is redelivered in full, so a channel may
 * receive the same notification more than once; a reader compares history
 * ids, which makes that harmless.
 */
export async function processGmailPush(
  deps: GmailPushDeps,
  authorization: string | undefined,
  rawBody: string,
  now: number = Date.now(),
): Promise<GmailPushResult> {
  const { runtime, serviceSpace, logger } = deps;
  let accepted: boolean;
  try {
    accepted = await isAcceptedPushToken(deps, authorization);
  } catch (error) {
    logger?.error({ error }, "gmail-push: could not verify a push token");
    return { status: 502, body: { error: "Failed to verify request" } };
  }
  if (!accepted) return { status: 401, body: { error: "Invalid request" } };

  const notification = decodeNotification(rawBody);
  if (notification === null) {
    logger?.info({}, "gmail-push: acknowledged an undecodable message");
    return { status: 200, body: { delivered: 0 } };
  }

  // The address is left out of every log line, and so is its key, which
  // would let anyone with the logs test a guess at it.
  const { messageId } = notification;
  const partition = partitionFor(notification.publishTime, now);
  const record = { type: "gmail.push", ...notification };
  let delivered = 0;
  try {
    const ids = await getMailboxChannels(
      runtime,
      serviceSpace,
      notification.emailAddress,
    );
    for (const id of ids) {
      const registration = await getRegistration(runtime, serviceSpace, id);
      if (
        registration === null || registration.sink !== "journal" ||
        channelRefusal(registration, now) !== null
      ) {
        continue;
      }
      await appendToJournal(runtime, registration, partition, [record]);
      await recordLastSeen(runtime, serviceSpace, id, logger);
      delivered++;
    }
  } catch (error) {
    logger?.error(
      { error, messageId, delivered },
      "gmail-push: failed to deliver a notification",
    );
    return { status: 502, body: { error: "Failed to write records" } };
  }
  logger?.info({ messageId, delivered }, "gmail-push: delivered");
  return { status: 200, body: { delivered } };
}
