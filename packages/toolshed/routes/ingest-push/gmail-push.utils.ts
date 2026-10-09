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
 * channel, which the channel's owner makes by minting the channel with a
 * proof of the mailbox (`routes/ingest-channels`), and each notification
 * replaces the record in the one cell of every live gmail channel bound to
 * its mailbox, unless the cell already holds a newer history id. See
 * `docs/features/gmail-push-ingest.md`.
 */

import { errors, jwtVerify, type JWTVerifyGetKey } from "@panva/jose";
import { sha256 } from "@commonfabric/content-hash";
import type { JSONSchema, MemorySpace, Runtime } from "@commonfabric/runner";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import { isObjectNotArray } from "@commonfabric/utils/types";

import {
  channelRefusal,
  getRegistration,
  type IngestLogger,
  type IngestRegistration,
  recordLastSeen,
  registrationCell,
  writeLatest,
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
const MAX_HISTORY_ID = (1n << 64n) - 1n;

/** Returns whether `value` is a history id: decimal digits within 64 bits. */
function isHistoryId(value: unknown): value is string {
  return typeof value === "string" && HISTORY_ID_RE.test(value) &&
    BigInt(value) <= MAX_HISTORY_ID;
}

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

/** Thrown when a channel's binding moved while a bind was running. */
export class BindingConflictError extends Error {
  constructor() {
    super("channel binding changed concurrently");
    this.name = "BindingConflictError";
  }
}

/** The outcome of proving which mailbox a Google token is for. */
export type MailboxLookup =
  /** The token is for this mailbox. */
  | { ok: true; emailAddress: string }
  /**
   * Google refused the token or answered with something unusable
   * (`rejected`), could not be reached (`unavailable`), or the proof is of a
   * kind this deployment does not accept (`unsupported`).
   */
  | { ok: false; reason: "rejected" | "unavailable" | "unsupported" };

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
  /** Acknowledged, having reached `delivered` live channels. */
  | { status: 200; body: { delivered: number } }
  /** No token, or one that is not a push token from an accepted account. */
  | { status: 401; body: { error: string } }
  /** A lookup or a write failed; Pub/Sub redelivers the message. */
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

/** Returns the key of the mailbox channel `id` is bound to, or `undefined`. */
export async function getChannelMailbox(
  runtime: Runtime,
  serviceSpace: string,
  id: string,
): Promise<string | undefined> {
  const cell = channelBindingCell(runtime, serviceSpace, id);
  await cell.sync();
  await runtime.storageManager.synced();
  return (cell.get() as ChannelBinding | undefined)?.mailbox;
}

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
 * With `expectedRevision`, the binding is written only while the channel's
 * registration is still at that revision. A mint writes its registration and
 * then its binding, and a mint of the same channel that landed in between
 * owns the registration now; its binding is the one to keep.
 *
 * @throws MailboxBindingFullError when the mailbox is already at
 *   `MAX_CHANNELS_PER_MAILBOX` live channels.
 * @throws BindingConflictError when the channel's binding changed while this
 *   ran, or its registration is not at `expectedRevision`; the caller may
 *   try again, or has been superseded.
 */
export function bindMailbox(
  runtime: Runtime,
  serviceSpace: string,
  id: string,
  address: string,
  expectedRevision?: number,
): Promise<void> {
  return bindMailboxKey(
    runtime,
    serviceSpace,
    id,
    mailboxKey(address),
    expectedRevision,
  );
}

/**
 * Puts channel `id` back in the list of the mailbox its binding names, when
 * it has fallen out of it: a channel retired at the time another channel
 * bound the mailbox gave up its place, and minting it again without a proof
 * is what brings it back. Returns whether the channel is bound to a mailbox
 * at all. Throws what `bindMailbox()` throws.
 */
export async function restoreBinding(
  runtime: Runtime,
  serviceSpace: string,
  id: string,
  expectedRevision?: number,
): Promise<boolean> {
  const binding = channelBindingCell(runtime, serviceSpace, id);
  await binding.sync();
  await runtime.storageManager.synced();
  const key = (binding.get() as ChannelBinding | undefined)?.mailbox;
  if (key === undefined) return false;
  await bindMailboxKey(runtime, serviceSpace, id, key, expectedRevision);
  return true;
}

/** Helper for `bindMailbox()` and `restoreBinding()`: the bind, by mailbox key. */
async function bindMailboxKey(
  runtime: Runtime,
  serviceSpace: string,
  id: string,
  key: string,
  expectedRevision?: number,
): Promise<void> {
  const target = mailboxChannelsCell(runtime, serviceSpace, key);
  const binding = channelBindingCell(runtime, serviceSpace, id);
  const registration = registrationCell(runtime, serviceSpace, id);
  await target.sync();
  await binding.sync();
  await registration.sync();
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
  const result = await runtime.editWithRetry((tx) => {
    full = false;
    moved = false;

    // Every check runs before any write, because `editWithRetry` commits
    // whatever the closure wrote even when it returns early. The registration
    // joins the read set, so a mint committing a new revision between this
    // read and the commit retries the transaction rather than racing it.
    if (expectedRevision !== undefined) {
      const current = registration.withTx(tx).get() as
        | IngestRegistration
        | undefined;
      if ((current?.revision ?? 0) !== expectedRevision) {
        moved = true;
        return;
      }
    }
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
  if (moved) throw new BindingConflictError();
  if (full) throw new MailboxBindingFullError();
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
 * Returns whether an address an ID token names is one Google is the
 * authority on: a Gmail address, or a Workspace address whose domain the
 * token's `hd` claim vouches for. A Google account can carry a third-party
 * address, which `email_verified` says was verified once and which may since
 * have changed hands; Google's own guidance is to trust it only with `hd`.
 * Such an account has no Gmail mailbox for a push to come from anyway.
 *
 * The claims and what each one establishes are set out in
 * https://developers.google.com/identity/sign-in/web/backend-auth#verify-the-integrity-of-the-id-token
 */
function isGoogleHostedAddress(
  email: string,
  hostedDomain: unknown,
): boolean {
  const domain = email.slice(email.indexOf("@") + 1).toLowerCase();
  if (domain === "gmail.com") return true;
  return typeof hostedDomain === "string" &&
    hostedDomain.toLowerCase() === domain;
}

/**
 * Proves a mailbox with a Google ID token: one signed by Google for one of
 * the `clientIds`, carrying a verified address that Google is the authority
 * on. An ID token grants no access to anything, so it is the proof to prefer
 * where a consent requested the `openid` scope. With no `clientIds`
 * configured the proof is `unsupported`.
 */
export async function verifyGmailIdToken(
  keys: JWTVerifyGetKey,
  clientIds: readonly string[],
  idToken: string,
): Promise<MailboxLookup> {
  if (clientIds.length === 0) return { ok: false, reason: "unsupported" };
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(idToken, keys, {
      issuer: GOOGLE_ISSUERS,
      audience: [...clientIds],
      algorithms: ["RS256"],
    }));
  } catch (error) {
    if (isKeyFetchFailure(error)) return { ok: false, reason: "unavailable" };
    if (error instanceof errors.JOSEError) {
      return { ok: false, reason: "rejected" };
    }
    throw error;
  }
  const { email } = payload;
  if (
    payload.email_verified !== true || typeof email !== "string" ||
    !isPlausibleAddress(email) || !isGoogleHostedAddress(email, payload.hd)
  ) {
    return { ok: false, reason: "rejected" };
  }
  return { ok: true, emailAddress: email };
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
  // `fetch` itself reports a network failure as a `TypeError`, which `jose`
  // lets through unwrapped.
  return error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid ||
    error instanceof TypeError ||
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
  if (!isHistoryId(history)) return null;
  return { emailAddress, historyId: history, messageId, publishTime };
}

/**
 * Helper for `processGmailPush()`, which returns whether `next` carries a
 * newer history id than `current`. History ids order notifications of one
 * mailbox only, so a record for another mailbox, which a channel's cell holds
 * after the channel is rebound, is superseded whatever its id; so is a record
 * with no readable history id or no readable address, so a cell holding one
 * is not stuck.
 */
function supersedes(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  const held = current.historyId;
  const incoming = next.historyId;
  if (!isHistoryId(incoming)) return false;
  if (!isHistoryId(held)) return true;
  const heldAddress = current.emailAddress;
  if (
    typeof heldAddress !== "string" ||
    typeof next.emailAddress !== "string" ||
    mailboxKey(heldAddress) !== mailboxKey(next.emailAddress)
  ) {
    return true;
  }
  return BigInt(incoming) > BigInt(held);
}

/**
 * The transport-independent core of the push handler. Verifies the push
 * token, then writes the notification to the cell of every live gmail
 * channel bound to its mailbox, where it replaces whatever the cell held
 * unless that carries a newer history id.
 *
 * A notification for a mailbox nobody has bound, and a body that is not a
 * Gmail notification at all, are both acknowledged: Pub/Sub would otherwise
 * redeliver them for as long as the subscription retains them. A write that
 * fails partway through is redelivered in full, which is harmless: a
 * redelivery carries the history id the cell already holds, and changes
 * nothing. `delivered` counts the live channels the notification reached,
 * whether or not it was newer than what each held.
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
  // would let anyone with the logs test a guess at it. The record leaves out
  // Pub/Sub's message id, which names the delivery rather than any mail.
  const { messageId, emailAddress, historyId, publishTime } = notification;
  const record = { type: "gmail.push", emailAddress, historyId, publishTime };
  let delivered = 0;
  try {
    const key = mailboxKey(emailAddress);
    const ids = await getMailboxChannels(runtime, serviceSpace, emailAddress);
    for (const id of ids) {
      const registration = await getRegistration(runtime, serviceSpace, id);
      if (
        registration === null || registration.kind !== "gmail" ||
        channelRefusal(registration, now) !== null
      ) {
        continue;
      }
      // The list was read before this channel's write, and a rebind may have
      // moved the channel to another mailbox in between. Re-reading the
      // binding here narrows that window; it does not close it, since the
      // binding lives in the service space and the cell in the user's, and a
      // write of the old mailbox's record that slips through is replaced by
      // the new mailbox's first notification, whatever its history id.
      if (await getChannelMailbox(runtime, serviceSpace, id) !== key) continue;
      await writeLatest(runtime, registration, record, supersedes);
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
