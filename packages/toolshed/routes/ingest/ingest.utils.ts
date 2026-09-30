import { sha256 } from "@commonfabric/content-hash";
import type { JSONSchema, MemorySpace, Runtime } from "@commonfabric/runner";
import { isLink } from "@commonfabric/runner";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import {
  custodyIngest,
  durableSet,
  type VouchedChannel,
} from "@/lib/custody-ingest.ts";

// The `journal` sink of a vouched ingest channel: a durable, append-only,
// ExternalIngest-marked record log. This is the generic capability — location
// is one consumer of it (its beacon POSTs `location.point` records; loom wraps
// them into `loom.source-record.v1` envelopes on READ). Nothing here knows about
// location or loom's schema; records are stored verbatim and the read side is
// the single schema authority.
//
// This module owns the DATA plane (ingest) and the shared registry helpers. The
// CONTROL plane — self-serve mint/list/rotate/revoke — lives in
// routes/ingest-channels/, gated on a first-party request proof plus an explicit
// OWNER grant on the target space's ACL (lib/space-authority.ts). The operator
// command (scripts/provision-ingest-channel.ts) still works and remains the
// break-glass path. All registry helpers take `runtime` explicitly so both the
// script and the control plane can reuse them without booting the server. See
// docs/features/self-serve-ingest-channels.md.

const INGEST_SECRET_BYTES = 32;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Max records accepted in one POST (on top of the 1 MB body limit). */
export const MAX_BATCH = 1000;

// A single clean cause segment. Used for BOTH halves of the cell cause
// `${causePrefix}/${partition}`. Charset + length bounded, and never `.`/`..`
// (which pass the charset but would address a cell loom's date enumerator never
// reads — a silent write-to-nowhere).
//
// For the cause halves this is a SHAPE contract, not a security boundary: the
// write is confined to the channel's registered space + causePrefix regardless
// of the value; the constraint exists so labs and loom derive the same cell id.
//
// For `installId` it IS a security boundary, and deliberately so. Under
// self-serve minting the caller chooses `installId`, and it becomes the
// `audience` recorded on every ExternalIngest mark. The token-less integration
// channels use audiences of the form `did:web:commonfabric.org#oauth2` /
// `#plaid` (oauth2-common.utils.ts, plaid-oauth.utils.ts). Excluding `:` and `#`
// is what keeps a user-minted audience out of that namespace, so a minted
// channel cannot produce marks that read as an OAuth or Plaid ingest. Do not
// widen this charset without namespacing minted audiences first.
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const isValidSegment = (s: string): boolean =>
  SEGMENT_RE.test(s) && s !== "." && s !== "..";

/**
 * Does this value contain anything the runtime would treat as a LINK?
 *
 * Records are opaque JSON, but opaque is not the same as inert. The runtime
 * decides on WRITE whether a value is a link — `data-updating.ts` tests the
 * incoming value with `isPrimitiveCellLink` — so a body carrying
 * `{"/": {"link@1": …}}` does not store that text, it stores a live reference.
 * Nothing else on this path would catch it: the shape is a non-null,
 * non-array object, which is the entire record contract.
 *
 * Three guarantees break at once if one lands:
 *   - The journal stops being append-only. A link's target can be changed
 *     afterwards, so a historical record mutates with no ingest touching it.
 *   - The ExternalIngest mark attests to the wrong bytes. Its digest binds the
 *     sigil, not what a reader resolves through it, so provenance vouches for
 *     content nobody ingested.
 *   - The record can address a document the channel was never authorized to
 *     write, which the space's owner then reads as their own captured data.
 *
 * Uses the runtime's own predicate rather than matching the envelope here, so
 * this cannot drift from what the writer actually interprets.
 *
 * Rejected rather than stripped: silently rewriting a record would break the
 * verbatim-storage contract from the other side, and a client sending one is
 * either malfunctioning or hostile — both should hear about it.
 *
 * Iterative, because the walk is over attacker-controlled nesting.
 */
export const containsLink = (value: unknown): boolean => {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (isLink(current)) return true;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
    } else if (isObjectOrArray(current)) {
      for (const item of Object.values(current)) stack.push(item);
    }
  }
  return false;
};

export const isValidPartition = isValidSegment;

export interface IngestRegistration {
  id: string;
  name: string;

  /** The space partition cells are written into (the end user's space). */
  space: string;

  /** Cell-cause prefix; a partition cell's cause is `${causePrefix}/${partition}`. */
  causePrefix: string;

  /** Stable source identifier: recorded on the mark + the cross-repo join key. */
  installId: string;

  /**
   * The sink discriminator. Only `"journal"` (durable, append-only, marked)
   * exists in iteration 1; `"stream"` (today's webhook dispatch) joins the union
   * when webhooks are subsumed onto ingest channels. Required so a future
   * stream-channel id can never silently be given journal semantics here.
   */
  sink: "journal";

  secretHash: string;

  /**
   * The hash of the token this channel most recently rotated AWAY from.
   *
   * It authorizes NOTHING — it exists purely so a device still holding the old
   * token can be told "re-pair" instead of getting the equalized 401, which is
   * indistinguishable from "unknown channel" and leaves the device choosing
   * between dropping its buffer and retrying forever. Rotation replaces
   * `secretHash`, so without this the re-pair signal is structurally
   * unreachable for the very case that motivated it. Matching it is still
   * proof-of-possession, so nothing leaks to a guesser.
   */
  previousSecretHash?: string;

  createdBy: string;
  createdAt: string;
  enabled: boolean;

  /**
   * The VERIFIED DID that minted this channel — a first-party request proof,
   * checked against an explicit OWNER grant on `space` (lib/space-authority.ts).
   * Distinct from `createdBy`, which under operator provisioning records the
   * operator's own DID and so identifies nobody. Absent on channels minted by
   * the operator script before self-serve existed.
   */
  owner?: string;

  /**
   * Hard expiry, enforced on the data plane by `processIngest` — not merely
   * stored. A minted token otherwise outlives any later ACL change (the
   * authorization is checked once, at mint), so this is the bound on that.
   */
  expiresAt?: string;

  /**
   * CURRENT revocation state — present iff the channel is revoked right now.
   * Revocation is a soft disable, not a deletion, diverging deliberately from
   * webhooks (which hard-delete by writing `null`): a webhook registration is
   * dispatch config, while this one records who was authorized to write
   * provenance-marked data into a user's space.
   *
   * The owner re-authorizing the channel (mint or rotate) CLEARS this, because
   * it is liveness state — the data plane refuses a POST while it is set, so
   * carrying it forward across a re-mint would hand back a token that is dead
   * on arrival. The history below is what preserves the audit trail.
   */
  revoked?: { at: string; by: string };

  /**
   * Past revocations, oldest first, bounded. Keeping this separate from
   * `revoked` is what lets re-minting restore service without erasing the
   * record that the channel was once revoked, and by whom.
   */
  revocations?: { at: string; by: string }[];

  /**
   * Monotonic version, bumped on every write. It exists so lifecycle mutations
   * can be optimistic: a caller states the revision its decisions were based
   * on, and the write is refused if the registration moved underneath it.
   * Without it, a concurrent rotate and revoke both read one snapshot and
   * blind-write — leaving revoke reporting success on a channel that is live
   * again, or rotate handing back an already-dead token.
   */
  revision?: number;
}

/**
 * Thrown when an owner has more live request claims than the store retains, so
 * a new claim cannot be recorded without discarding one that still proves a
 * replay.
 */
export class ClaimStoreFullError extends Error {
  constructor() {
    super("too many recent requests");
    this.name = "ClaimStoreFullError";
  }
}

/** Thrown when a lifecycle write loses an optimistic precondition. */
export class RegistrationConflictError extends Error {
  constructor() {
    super("registration changed concurrently");
    this.name = "RegistrationConflictError";
  }
}

/** Thrown when a mint would push an owner past their live-channel limit. */
export class LiveChannelCapError extends Error {
  constructor(readonly live: number) {
    super(`owner already holds ${live} live channels`);
    this.name = "LiveChannelCapError";
  }
}

/**
 * Thrown when an owner has created their lifetime allowance of channels.
 * Revoking does not refund it: the registration and its audit entry are kept
 * forever, so what this bounds is state the owner can never release.
 */
export class LifetimeChannelCapError extends Error {
  constructor(readonly created: number) {
    super(`owner has created ${created} channels`);
    this.name = "LifetimeChannelCapError";
  }
}

/**
 * Thrown when a SPACE has had its lifetime allowance of channels created
 * against it. This is the bound that survives key churn: a per-owner quota
 * bounds a keypair, and keypairs are free.
 */
export class SpaceLifetimeChannelCapError extends Error {
  constructor(readonly created: number) {
    super(`space has had ${created} channels created against it`);
    this.name = "SpaceLifetimeChannelCapError";
  }
}

/** Bound on {@link IngestRegistration.revocations}; oldest entries drop. */
export const MAX_REVOCATION_HISTORY = 10;

const RegistrationSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    space: { type: "string" },
    causePrefix: { type: "string" },
    installId: { type: "string" },
    sink: { type: "string" },
    secretHash: { type: "string" },
    createdBy: { type: "string" },
    createdAt: { type: "string" },
    enabled: { type: "boolean" },
    owner: { type: "string" },
    expiresAt: { type: "string" },
    previousSecretHash: { type: "string" },
    revoked: {
      type: "object",
      properties: { at: { type: "string" }, by: { type: "string" } },
      required: ["at", "by"],
    },
    revision: { type: "number" },
    revocations: {
      type: "array",
      items: {
        type: "object",
        properties: { at: { type: "string" }, by: { type: "string" } },
        required: ["at", "by"],
      },
    },
  },
  required: [
    "id",
    "name",
    "space",
    "causePrefix",
    "installId",
    "sink",
    "secretHash",
    "createdBy",
    "createdAt",
    "enabled",
  ],
} as const satisfies JSONSchema;

// Records are stored value-for-value as parsed from the wire (no labs-added
// fields; values round-trip through JSON unchanged — e.g. lat/lng decimal
// strings stay strings, not reparsed to float) so the read side is the single
// schema authority. NOT raw-byte-identical: the handler parses JSON and the
// provenance digest is over the JSON serialization, not the request bytes
// (binding raw bytes is a future hardening). Crucially there is NO `default`: a
// never-written partition cell must read back as `undefined` (ABSENT — "never
// captured"), distinct from `[]` (EMPTY — "no signal"), per the loom read side.
export const JournalSchema = {
  type: "array",
  items: { type: "object", additionalProperties: true },
} as const satisfies JSONSchema;

// Service-space bookkeeping schemas (no `default`, so absent reads as undefined).
const IndexSchema = {
  type: "array",
  items: { type: "string" },
} as const satisfies JSONSchema;

const CountSchema = { type: "number" } as const satisfies JSONSchema;
const TimestampSchema = { type: "string" } as const satisfies JSONSchema;

function randomBase62(length: number): string {
  // Rejection sampling to avoid modulo bias (256 % 62 != 0); discard >= 248.
  const LIMIT = 248;
  let result = "";
  while (result.length < length) {
    const bytes = crypto.getRandomValues(
      new Uint8Array((length - result.length) * 2),
    );
    for (const byte of bytes) {
      if (byte < LIMIT) {
        result += BASE62[byte % 62];
        if (result.length === length) break;
      }
    }
  }
  return result;
}

// Canonical content-addressed hashing — cf-review: never fork SHA-256 via
// @std/crypto or a local wrapper; the canonical home is @commonfabric/
// content-hash (sync, bytes -> bytes). base64url gives a compact string form
// used only for internal token hashing + the derived channel id.
const hashSecret = (value: string): string =>
  toUnpaddedBase64url(sha256(new TextEncoder().encode(value)));

/**
 * A channel's id is DERIVED from (space, installId), not random — so
 * re-provisioning the same install rotates the token in place (overwrites the
 * one registration) instead of leaving a second live token behind. The id is
 * not a credential (the bearer token is), so a derivable, non-secret id is fine.
 */
export function channelId(space: string, installId: string): string {
  return `ing_${hashSecret(`${space}\n${installId}`)}`;
}

export function generateIngestSecret(): { secret: string; secretHash: string } {
  const secret = `ingsec_${randomBase62(INGEST_SECRET_BYTES)}`;
  return { secret, secretHash: hashSecret(secret) };
}

export function verifyIngestSecret(
  provided: string,
  storedHash: string,
): boolean {
  const a = new TextEncoder().encode(hashSecret(provided));
  const b = new TextEncoder().encode(storedHash);
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
  return result === 0;
}

// Registrations live in the toolshed's OWN service space (keyed by the operator
// identity's DID), NOT in the user's space — only the per-day records land in
// the user's space.
const registrationCell = (runtime: Runtime, serviceSpace: string, id: string) =>
  runtime.getCell<IngestRegistration>(
    serviceSpace as MemorySpace,
    `cf:ingest:${id}`,
    RegistrationSchema,
  );

// The service-space audit inventory: every channel id ever provisioned, so
// channels are enumerable (content-addressed registration cells have no listing
// otherwise) and a trust-condition sweep has something to enumerate.
//
// SHARDED BY UTC MONTH, because unlike the owner and space indexes this one is
// never pruned — a revoked channel stays in the audit forever, which is the
// point. A single array would then be an unbounded document that every
// provision rewrites in full: one authenticated owner minting in a loop grows a
// deployment-wide cell without limit, and each write costs the whole array. The
// shard key comes from the registration's `createdAt`, so it is stable across
// re-mints of the same id and membership is decidable against one shard.
//
// This mirrors the data plane, where records live in per-UTC-day partition
// cells for the same reason.
const auditMonth = (createdAt: string): string => {
  const at = new Date(createdAt);
  // A registration whose createdAt does not parse still has to be auditable.
  // "unknown" is a real shard, enumerated like any other.
  if (Number.isNaN(at.getTime())) return "unknown";
  return at.toISOString().slice(0, 7);
};

const auditShardCell = (
  runtime: Runtime,
  serviceSpace: string,
  month: string,
) =>
  runtime.getCell<string[]>(
    serviceSpace as MemorySpace,
    `cf:ingest:index:${month}`,
    IndexSchema,
  );

// The shard directory: which months have a shard. Grows by one entry per month
// in which anything was minted, so it is bounded by calendar time rather than
// by traffic — the property the flat index lacked.
const auditShardListCell = (runtime: Runtime, serviceSpace: string) =>
  runtime.getCell<string[]>(
    serviceSpace as MemorySpace,
    "cf:ingest:index:months",
    IndexSchema,
  );

// The pre-sharding flat index. Read, never written: channels provisioned before
// sharding must stay enumerable, and a sweep that silently skipped them would
// report a live channel as retired.
const legacyIndexCell = (runtime: Runtime, serviceSpace: string) =>
  runtime.getCell<string[]>(
    serviceSpace as MemorySpace,
    "cf:ingest:index",
    IndexSchema,
  );

// A monotone per-owner count of channel ids ever created. The live cap alone
// bounds nothing durable: revoking frees a live slot but leaves the registration
// cell and its audit entry behind forever, so mint/revoke in a loop is unbounded
// growth of deployment-wide state by one authenticated user. This is the
// lifetime quota that actually stops it. A counter, not a list — the thing being
// bounded must not itself be an unbounded array.
const lifetimeCountCell = (
  runtime: Runtime,
  serviceSpace: string,
  owner: string,
) =>
  runtime.getCell<number>(
    serviceSpace as MemorySpace,
    `cf:ingest:lifetime:${owner}`,
    CountSchema,
  );

// The SAME meter, per target space.
//
// A per-owner quota bounds a KEY, not a person: a DID is a freshly generated
// keypair, so one human with one space can grant OWNER to as many keys as they
// like and spend a fresh allowance from each. Worse, every new owner DID mints
// its own permanent `by-owner`, `lifetime` and `requests` cells — so the
// mechanism introduced to bound growth would itself be an unbounded cell family
// in the same dimension.
//
// The space is what an attacker cannot mint for free WITHIN this feature's
// reach: a channel must name a space the caller holds an explicit OWNER grant
// on, and that grant is recorded in the space's own ACL. Metering the space
// therefore bounds the whole per-key cell family too — once the space's
// allowance is gone, a fresh key creates nothing, so it writes no cells.
//
// Creating unlimited SPACES is a real remaining axis, but it is the
// deployment's admission-control problem — every space is already a memory
// store it hosts — and not one this feature can or should solve.
const spaceLifetimeCountCell = (
  runtime: Runtime,
  serviceSpace: string,
  space: string,
) =>
  runtime.getCell<number>(
    serviceSpace as MemorySpace,
    `cf:ingest:lifetime-space:${space}`,
    CountSchema,
  );

// Per-channel last-seen timestamp, in its OWN cell (not a registration field) so
// a per-POST status bump never contends with token rotation on one document.
const lastSeenCell = (runtime: Runtime, serviceSpace: string, id: string) =>
  runtime.getCell<string>(
    serviceSpace as MemorySpace,
    `cf:ingest:last-seen:${id}`,
    TimestampSchema,
  );

// A PER-OWNER index, so listing your channels never touches a space you do not
// own. Listing off the global index would force an ACL read per distinct space,
// and every `ACLManager.get()` awaits `storageManager.synced()` — a global
// barrier across every mounted provider that `processIngest` itself awaits three
// times per POST. One authenticated list call would then mount a replica for
// every space that ever had a channel and degrade ingest for every live beacon.
const ownerIndexCell = (
  runtime: Runtime,
  serviceSpace: string,
  owner: string,
) =>
  runtime.getCell<string[]>(
    serviceSpace as MemorySpace,
    `cf:ingest:by-owner:${owner}`,
    IndexSchema,
  );

// A per-SPACE index. The owner index answers "what did I mint"; this answers
// "what can write into this space", which is the question a space's CURRENT
// owner needs and the one that makes a channel revocable by whoever owns the
// resource now. Without it, a channel minted by someone whose grant has since
// been removed is invisible to the person who owns the space — live, and
// undiscoverable by the only party entitled to revoke it.
const spaceIndexCell = (
  runtime: Runtime,
  serviceSpace: string,
  space: string,
) =>
  runtime.getCell<string[]>(
    serviceSpace as MemorySpace,
    `cf:ingest:by-space:${space}`,
    IndexSchema,
  );

/** The channel ids targeting a space, whoever minted them. */
export async function getSpaceRegistrationIndex(
  runtime: Runtime,
  serviceSpace: string,
  space: string,
): Promise<string[]> {
  const cell = spaceIndexCell(runtime, serviceSpace, space);
  await cell.sync();
  await runtime.storageManager.synced();
  return (cell.get() as string[] | undefined) ?? [];
}

// Idempotency for mint/rotate. Without it, replaying a captured first-party
// request inside its ≤300s freshness window mints a FRESH secret and returns it
// to the replayer — turning a bounded replay window into a permanent append
// capability, and silently killing the victim's live token. There is no replay
// cache on request proofs (docs/specs/toolshed-access-control.md), so this is
// durable and per-request rather than an in-memory cache with a timer.

/**
 * Replay defense only has to span the first-party proof's freshness window, so
 * claims older than it can be forgotten. `DEFAULT_MAX_PROOF_AGE_SECONDS` in
 * toolshed-http-auth is 300; this is deliberately generous against clock skew.
 */
const CLAIM_RETENTION_MS = 30 * 60_000;

/** Hard ceiling on retained claims per owner, so a burst cannot grow the cell. */
const MAX_RETAINED_CLAIMS = 500;

// ONE compacted cell per owner rather than one permanent cell per request id.
// A cell per id is unbounded durable bookkeeping: every rotate mints another
// one, forever, and nothing ever reads them again once the window passes.
//
// Scoped to the CALLER, not global. Claiming happens after authorization, so a
// stranger can never burn ids — but with a global namespace any principal who
// owns a space could squat ids in a shared keyspace. Harmless against
// `crypto.randomUUID()`, fatal the day a client derives one from something
// guessable.
const ClaimsSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      at: { type: "number" },
      channel: { type: "string" },
    },
    required: ["id", "at", "channel"],
  },
} as const satisfies JSONSchema;

const mintRequestCell = (
  runtime: Runtime,
  serviceSpace: string,
  owner: string,
) =>
  runtime.getCell<{ id: string; at: number; channel: string }[]>(
    serviceSpace as MemorySpace,
    `cf:ingest:requests:${owner}`,
    ClaimsSchema,
  );

/** A mint/rotate request id must be a single clean segment, like a partition. */
export const isValidRequestId = isValidSegment;

/**
 * Atomically reserve `requestId` for `channel`, or report the channel a
 * previous call already used it for. Returns `null` when the reservation is
 * fresh.
 *
 * The check MUST happen inside the transaction. A read outside it (the obvious
 * spelling) puts no entry in the transaction's read set, so `durableSet`'s
 * blind write has nothing to conflict on: two concurrent replays would both
 * observe `undefined`, both mint, and both receive a live-looking token while
 * the loser's is silently dead. `durableUpdate` calls `bound.get()` inside the
 * transaction, so the read joins the read set and `editWithRetry` sees the
 * conflict — which is the whole basis of the claim that a replay can never
 * reach `generateIngestSecret`.
 */

/** The claim a lifecycle write records, atomically with the write itself. */
export interface ClaimRequest {
  owner: string;
  requestId: string;
  channel: string;
  now?: number;
}

/** Thrown when a request id was already used; carries the channel it was for. */
export class RequestAlreadyClaimedError extends Error {
  constructor(readonly channel: string) {
    super(`request already used for channel ${channel}`);
    this.name = "RequestAlreadyClaimedError";
  }
}

const liveClaims = (
  current: readonly { id: string; at: number; channel: string }[] | undefined,
  now: number,
) =>
  // Rebuilt as plain objects, not re-embedded: values read back from a cell are
  // deep-frozen and do not round-trip inside a new array.
  (current ?? [])
    .filter((entry) => now - entry.at < CLAIM_RETENTION_MS)
    .map((entry) => ({ id: entry.id, at: entry.at, channel: entry.channel }));

/**
 * The channel a request id was already used for, or `null` if it is unused.
 *
 * A read-only fast path so a replay is rejected before a secret is generated.
 * It is NOT the guarantee — `saveRegistration` re-checks inside the transaction
 * that records the claim, which is what makes the check and the write atomic.
 */
export async function peekMintRequest(
  runtime: Runtime,
  serviceSpace: string,
  owner: string,
  requestId: string,
  now: number = Date.now(),
): Promise<string | null> {
  const cell = mintRequestCell(runtime, serviceSpace, owner);
  await cell.sync();
  await runtime.storageManager.synced();
  const seen = liveClaims(cell.get(), now).find((e) => e.id === requestId);
  return seen?.channel ?? null;
}

export async function getRegistration(
  runtime: Runtime,
  serviceSpace: string,
  id: string,
): Promise<IngestRegistration | null> {
  const cell = registrationCell(runtime, serviceSpace, id);
  await cell.sync();
  await runtime.storageManager.synced();
  return (cell.get() as IngestRegistration | undefined) ?? null;
}

/**
 * Every provisioned channel id in this service space: the audit inventory a
 * trust-condition sweep enumerates. Reads the pre-sharding flat index as well
 * as every month shard, so nothing provisioned before sharding goes missing.
 */
export async function getRegistrationIndex(
  runtime: Runtime,
  serviceSpace: string,
): Promise<string[]> {
  const legacy = legacyIndexCell(runtime, serviceSpace);
  const list = auditShardListCell(runtime, serviceSpace);
  await legacy.sync();
  await list.sync();
  await runtime.storageManager.synced();

  const months = (list.get() as string[] | undefined) ?? [];
  const shards = months.map((m) => auditShardCell(runtime, serviceSpace, m));
  for (const shard of shards) await shard.sync();
  await runtime.storageManager.synced();

  // Deduped: an id appears in at most one shard, but a channel provisioned
  // before sharding and re-minted after it appears in both the flat index and
  // its month shard.
  const seen = new Set<string>((legacy.get() as string[] | undefined) ?? []);
  for (const shard of shards) {
    for (const id of (shard.get() as string[] | undefined) ?? []) seen.add(id);
  }
  return [...seen];
}

/** How many channels this owner has ever taken on (the lifetime quota meter). */
export async function getLifetimeChannelCount(
  runtime: Runtime,
  serviceSpace: string,
  owner: string,
): Promise<number> {
  const cell = lifetimeCountCell(runtime, serviceSpace, owner);
  await cell.sync();
  await runtime.storageManager.synced();
  return (cell.get() as number | undefined) ?? 0;
}

/**
 * How many channel ACQUISITIONS this space has seen — creations plus ownership
 * changes. Both are an identity taking on durable state against the space;
 * counting only creations would leave takeover as a way around the bound.
 */
export async function getSpaceLifetimeChannelCount(
  runtime: Runtime,
  serviceSpace: string,
  space: string,
): Promise<number> {
  const cell = spaceLifetimeCountCell(runtime, serviceSpace, space);
  await cell.sync();
  await runtime.storageManager.synced();
  return (cell.get() as number | undefined) ?? 0;
}

/** The last time a channel successfully ingested, or null if never. */
export async function getLastSeen(
  runtime: Runtime,
  serviceSpace: string,
  id: string,
): Promise<string | null> {
  const cell = lastSeenCell(runtime, serviceSpace, id);
  await cell.sync();
  await runtime.storageManager.synced();
  return (cell.get() as string | undefined) ?? null;
}

export async function saveRegistration(
  runtime: Runtime,
  serviceSpace: string,
  registration: IngestRegistration,
  /**
   * Optimistic precondition. `null` means "must not exist yet" (a first mint);
   * a number means the stored `revision` must still equal it. Omitted means an
   * unconditional write — the operator scripts, which are not racing a user.
   */
  expectedRevision?: number | null,
  /**
   * Recorded in the SAME transaction as the registration and its indexes, so a
   * request id is only ever consumed by a write that actually landed. Claiming
   * separately beforehand burns the id whenever the write then fails — turning
   * the idempotency key into the one thing that does not survive the failure it
   * exists to make retryable.
   */
  claim?: ClaimRequest,
  /**
   * Admission limits, enforced INSIDE the transaction that updates the owner
   * index and the lifetime counter. Checking either beforehand is advisory
   * only: concurrent distinct mints all read the same pre-transaction count and
   * all pass, so the cap is exceeded by however many requests are in flight.
   * Reading them in the closure joins them to the read set, which is what makes
   * the limit hold. Omitted for operator scripts, which are not the thing being
   * bounded.
   */
  limits?: { live?: number; lifetime?: number; spaceLifetime?: number },
): Promise<void> {
  // Every index is written with the registration, and none of them is
  // best-effort.
  //
  // Each index is the sole answer to a question that must not go unanswered
  // while a live token exists:
  //   - owner index  -> "what did I mint" (the user's own list)
  //   - space index  -> "what can write into this space" (the current owner's
  //                     inventory, and their only path to revoking a channel
  //                     minted by someone whose grant has since been removed)
  //   - global index -> the operator audit, which is what
  //                     `retire-ingest-channels` enumerates during a
  //                     trust-condition cutover
  //
  // None of them may be swallowed: the global index is the recovery inventory a
  // trust-condition sweep enumerates, so a lost write means a live channel that
  // the sweep reports as retired.
  //
  // Readers skip ids that do not resolve, so a reader is never broken by an
  // index it disagrees with.
  // ONE transaction over the registration and every index, so a mint cannot
  // leave indexes updated with no registration (or the reverse) and two
  // concurrent lifecycle calls cannot interleave. `editWithRetry` re-runs this
  // closure after a conflict, and the reads inside it join the transaction's
  // read set, which is what makes the precondition enforced rather than
  // advisory.
  const cell = registrationCell(runtime, serviceSpace, registration.id);
  const month = auditMonth(registration.createdAt);
  const auditIndex = auditShardCell(runtime, serviceSpace, month);
  const shardList = auditShardListCell(runtime, serviceSpace);
  const claimsCell = claim === undefined
    ? undefined
    : mintRequestCell(runtime, serviceSpace, claim.owner);
  const ownerIndex = registration.owner === undefined
    ? undefined
    : ownerIndexCell(runtime, serviceSpace, registration.owner);
  const lifetimeCell = registration.owner === undefined
    ? undefined
    : lifetimeCountCell(runtime, serviceSpace, registration.owner);
  const spaceLifetimeCell = spaceLifetimeCountCell(
    runtime,
    serviceSpace,
    registration.space,
  );
  const spaceIndex = spaceIndexCell(runtime, serviceSpace, registration.space);
  const indexes = [spaceIndex, auditIndex, ...(ownerIndex ? [ownerIndex] : [])];
  for (
    const c of [
      cell,
      ...indexes,
      shardList,
      ...(claimsCell ? [claimsCell] : []),
      ...(lifetimeCell ? [lifetimeCell] : []),
      spaceLifetimeCell,
    ]
  ) {
    await c.sync();
  }
  await runtime.storageManager.synced();

  let conflicted = false;
  let claimedBy: string | undefined;
  let claimsFull = false;
  let overLive: number | undefined;
  let overLifetime: number | undefined;
  let overSpaceLifetime: number | undefined;
  const result = await runtime.editWithRetry((tx) => {
    conflicted = false;
    claimedBy = undefined;
    claimsFull = false;
    overLive = undefined;
    overLifetime = undefined;
    overSpaceLifetime = undefined;

    // EVERY check runs before ANY write. `editWithRetry` commits whatever the
    // closure did to the transaction, so a write followed by an early return
    // still lands — which would consume a request id on a write that was then
    // refused, the exact failure this atomicity exists to prevent.
    let pendingClaim:
      | { id: string; at: number; channel: string }[]
      | undefined;
    if (claim !== undefined && claimsCell !== undefined) {
      const now = claim.now ?? Date.now();
      const live = liveClaims(claimsCell.withTx(tx).get(), now);
      const seen = live.find((entry) => entry.id === claim.requestId);
      if (seen !== undefined) {
        // The channel the claim was MADE for, not the one now being asked for.
        claimedBy = seen.channel;
        return;
      }
      // Full: refuse rather than evict. Dropping the oldest entry would discard
      // a claim still inside the replay window — the entry that proves a replay
      // — so a flood of fresh ids would buy a second live token for a used id.
      if (live.length >= MAX_RETAINED_CLAIMS) {
        claimsFull = true;
        return;
      }
      pendingClaim = [
        ...live,
        { id: claim.requestId, at: now, channel: claim.channel },
      ];
    }

    const bound = cell.withTx(tx);
    const current = bound.get() as IngestRegistration | undefined;
    if (expectedRevision !== undefined) {
      const currentRevision = current === undefined
        ? null
        : (current.revision ?? 0);
      if (currentRevision !== expectedRevision) {
        conflicted = true;
        return;
      }
    }
    // Live now, or being made live by this write.
    const live = registration.enabled && registration.revoked === undefined;

    // Creating a channel id that has never existed. The lifetime meter counts
    // these, so a re-mint or a rotate of an existing id is free.
    const creating = current === undefined;

    // What BOTH meters charge: bringing a channel under a new identity's
    // control. Not just creation — a takeover (re-minting a revoked channel
    // that belonged to someone else) leaves `current` defined.
    //
    // Charging only creation makes the space meter useless as a bound on key
    // churn, which is its entire purpose: a fresh DID refused a new channel can
    // instead revoke an existing one and re-mint it, acquiring a channel — and
    // minting its own permanent `by-owner`, `lifetime` and `requests` cells —
    // while the space meter never moves. Every ownership change is a new
    // identity taking on durable state, so every ownership change is charged.
    const acquiring = creating ||
      (registration.owner !== undefined &&
        current?.owner !== registration.owner);

    if (limits !== undefined && ownerIndex !== undefined) {
      // The owner index holds LIVE ids only, so its length IS the live count —
      // no per-id resolve, and no window between counting and committing.
      const ownedLive = (ownerIndex.withTx(tx).get() as string[] | undefined) ??
        [];
      if (
        limits.live !== undefined && live &&
        !ownedLive.includes(registration.id) &&
        ownedLive.length >= limits.live
      ) {
        overLive = ownedLive.length;
        return;
      }
      if (limits.lifetime !== undefined && acquiring && lifetimeCell) {
        const ever = (lifetimeCell.withTx(tx).get() as number | undefined) ?? 0;
        if (ever >= limits.lifetime) {
          overLifetime = ever;
          return;
        }
      }
    }

    // Checked even when the registration carries no owner, and outside the
    // block above: this is the bound that survives key churn, so it must not
    // depend on there being an owner index to read.
    if (limits?.spaceLifetime !== undefined && acquiring) {
      const ever = (spaceLifetimeCell.withTx(tx).get() as number | undefined) ??
        0;
      if (ever >= limits.spaceLifetime) {
        overSpaceLifetime = ever;
        return;
      }
    }

    if (pendingClaim !== undefined && claimsCell !== undefined) {
      claimsCell.withTx(tx).set(pendingClaim);
    }

    if (acquiring && lifetimeCell !== undefined) {
      const ever = (lifetimeCell.withTx(tx).get() as number | undefined) ?? 0;
      lifetimeCell.withTx(tx).set(ever + 1);
    }

    if (acquiring) {
      const bound = spaceLifetimeCell.withTx(tx);
      bound.set(((bound.get() as number | undefined) ?? 0) + 1);
    }

    // Register the month shard in the directory the sweep enumerates. A shard
    // that exists but is not listed is a set of channels no audit can see.
    const boundList = shardList.withTx(tx);
    const months = (boundList.get() as string[] | undefined) ?? [];
    if (!months.includes(month)) boundList.set([...months, month]);

    // The owner and space indexes track what is LIVE; the global index is the
    // permanent audit inventory. Revoking therefore removes the id from the
    // first two and leaves it in the third.
    //
    // That is what bounds them: without it they only ever grow, so a
    // mint-and-revoke loop inflates a per-owner list that `processList` walks
    // serially — each entry costing a global `synced()` barrier — while the
    // live-channel cap never engages, leaving "revoke some before minting
    // more" a remedy that frees nothing.
    for (const index of indexes) {
      const boundIndex = index.withTx(tx);
      const ids = (boundIndex.get() as string[] | undefined) ?? [];
      // The OWNER index is the only one pruned on revoke, because its length is
      // load-bearing: it IS the live count the per-owner cap reads.
      //
      // The space index keeps revoked ids. It has no cap reading it, and it is
      // the only way a caller can see a revoked channel at all — which is not
      // cosmetic, because `revoke` requires the channel's current generation
      // and `list` is the only place a generation is published. Pruning it left
      // a revoked channel unlistable, so its generation was unknowable, so
      // every later revoke of it answered 409 telling the caller to go list
      // something that would never appear. Bounded by the per-space lifetime
      // quota, which counts exactly the ids that can land here.
      const keepsRevoked = index === auditIndex || index === spaceIndex;
      const wanted = live || keepsRevoked;
      if (wanted && !ids.includes(registration.id)) {
        boundIndex.set([...ids, registration.id]);
      } else if (!wanted && ids.includes(registration.id)) {
        boundIndex.set(ids.filter((id) => id !== registration.id));
      }
    }
    // Operator write, not ingest — no ExternalIngest mark.
    bound.set(registration);
  });
  if (result.error) {
    throw new Error(result.error.message, { cause: result.error });
  }
  if (claimedBy !== undefined) throw new RequestAlreadyClaimedError(claimedBy);
  if (claimsFull) throw new ClaimStoreFullError();
  if (overLive !== undefined) throw new LiveChannelCapError(overLive);
  if (overLifetime !== undefined) {
    throw new LifetimeChannelCapError(overLifetime);
  }
  if (overSpaceLifetime !== undefined) {
    throw new SpaceLifetimeChannelCapError(overSpaceLifetime);
  }
  if (conflicted) throw new RegistrationConflictError();
}

/** The channel ids a given owner has minted (the self-serve list view). */
export async function getOwnerRegistrationIndex(
  runtime: Runtime,
  serviceSpace: string,
  owner: string,
): Promise<string[]> {
  const cell = ownerIndexCell(runtime, serviceSpace, owner);
  await cell.sync();
  await runtime.storageManager.synced();
  return (cell.get() as string[] | undefined) ?? [];
}

/** The partition cell for a channel — `${causePrefix}/${partition}` in the user's space. */
export function journalCell(
  runtime: Runtime,
  registration: IngestRegistration,
  partition: string,
) {
  return runtime.getCell<Record<string, unknown>[]>(
    registration.space as MemorySpace,
    `${registration.causePrefix}/${partition}`,
    JournalSchema,
  );
}

/**
 * Durably append a batch of opaque records to the channel's partition cell,
 * minting one ExternalIngest mark per POST. The read-append runs inside
 * `custodyIngest.update`'s retry, so concurrent POSTs to the same partition
 * don't lose each other. No dedup here — idempotency on the record key is the
 * read side's (loom's) job. Returns the number of records appended.
 */
export async function appendToJournal(
  runtime: Runtime,
  registration: IngestRegistration,
  partition: string,
  records: Record<string, unknown>[],
): Promise<number> {
  const cell = journalCell(runtime, registration, partition);
  await cell.sync();
  await runtime.storageManager.synced();
  const channel: VouchedChannel = {
    channel: registration.space,
    audience: registration.installId,
  };
  await custodyIngest.update(
    cell,
    (current) => [...(current ?? []), ...records],
    channel,
  );
  return records.length;
}

const DUMMY_HASH = hashSecret("");

/** A minimal logger shape so processIngest is testable without a pino instance. */
interface IngestLogger {
  error: (obj: unknown, msg: string) => void;
  info: (obj: unknown, msg: string) => void;
}

export type IngestResult =
  | { status: 200; body: { received: number; appended: number } }
  | { status: 400 | 401 | 403 | 413 | 502; body: { error: string } };

/**
 * The transport-independent core of the ingest handler — everything after the
 * bearer token and JSON body have been pulled off the request. Split out from
 * the Hono handler so the full auth contract (bearer lookup, dummy-hash-
 * equalized 401 for missing/disabled/wrong-token, 502-vs-401, hostile-partition
 * 400, batch cap) is unit-testable against a real runtime. `rawBody` is the raw
 * request body text; it is parsed only AFTER auth succeeds, so a bad/unknown/
 * disabled/wrong-sink token gets a uniform 401 regardless of body validity.
 */
export async function processIngest(
  runtime: Runtime,
  serviceSpace: string,
  id: string,
  token: string,
  rawBody: string,
  logger?: IngestLogger,
): Promise<IngestResult> {
  // Storage errors must 502, not masquerade as 401.
  let registration: IngestRegistration | null;
  try {
    registration = await getRegistration(runtime, serviceSpace, id);
  } catch (error) {
    logger?.error(
      { error, id },
      "ingest: storage error looking up registration",
    );
    return { status: 502, body: { error: "Failed to process request" } };
  }

  // EXACTLY TWO compares on every path — current, then previous-or-dummy — so
  // unknown / wrong / rotated are indistinguishable by timing. A missing
  // channel burns both against the dummy.
  if (!registration) {
    verifyIngestSecret(token, DUMMY_HASH);
    verifyIngestSecret(token, DUMMY_HASH);
    return { status: 401, body: { error: "Invalid request" } };
  }
  const matchesCurrent = verifyIngestSecret(token, registration.secretHash);
  const matchesPrevious =
    verifyIngestSecret(token, registration.previousSecretHash ?? DUMMY_HASH) &&
    // The compare above always RUNS (constant time), but its result only counts
    // when there really is a previous hash. Without this guard an empty token
    // — reachable, since `Bearer ` slices to "" — would match DUMMY_HASH and
    // turn the 403 into an existence oracle.
    registration.previousSecretHash !== undefined;

  if (!matchesCurrent) {
    if (matchesPrevious) {
      // Proof-of-possession of the SUPERSEDED token. It authorizes nothing; it
      // only earns the device an actionable answer instead of a blank 401.
      return {
        status: 403,
        body: { error: "Channel rotated — re-pair this device" },
      };
    }
    return { status: 401, body: { error: "Invalid request" } };
  }
  // A wrong-sink channel stays opaque even to a valid token holder, so a
  // stream-channel id POSTed here can never acquire journal semantics.
  if (registration.sink !== "journal") {
    return { status: 401, body: { error: "Invalid request" } };
  }

  // Past this point the caller has PROVEN it holds this channel's secret, so a
  // distinguishable answer leaks nothing to a guesser — you cannot reach it
  // without already holding a valid token. Under self-serve, rotation and
  // revocation become routine, and a beacon that was offline across one
  // otherwise sees a 401 identical to "unknown channel": it cannot tell
  // "re-pair me" from "server is broken", so it either drops buffered records
  // or retries forever. This is the one deliberate departure from the blanket
  // 401 equalization, and it is confined to correct-token cases.
  if (!registration.enabled || registration.revoked) {
    // Logged, not silent: a mass retirement (scripts/retire-ingest-channels.ts)
    // shows up here as a burst, and an operator needs to be able to see which
    // devices are still presenting retired tokens — and that the refusals are
    // deliberate rather than a broken deployment.
    logger?.info(
      { id, space: registration.space, revokedBy: registration.revoked?.by },
      "ingest: refused a valid token for a revoked channel",
    );
    return {
      status: 403,
      body: { error: "Channel revoked or rotated — re-pair this device" },
    };
  }
  if (registration.expiresAt !== undefined) {
    // Fail CLOSED on an unparseable value. `Date.parse` returns NaN for garbage
    // and every comparison against NaN is false, so the natural spelling
    // (`parsed <= now`) would treat a corrupted expiry as "not expired" and
    // silently grant an unbounded token — the exact opposite of this field's
    // purpose.
    const expiresAt = Date.parse(registration.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return {
        status: 403,
        body: { error: "Channel expired — re-pair this device" },
      };
    }
  }

  // Parse the body only AFTER auth — a bad token must stay opaque (uniform 401)
  // even when the body is malformed, so there is no 400-vs-401 oracle.
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "Invalid JSON body" } };
  }

  const partition = (body as { partition?: unknown } | null)?.partition;
  const records = (body as { records?: unknown } | null)?.records;

  if (typeof partition !== "string" || !isValidPartition(partition)) {
    return { status: 400, body: { error: "Invalid or missing partition" } };
  }
  if (
    !Array.isArray(records) ||
    records.length === 0 ||
    !records.every(
      (r) => isObjectNotArray(r),
    )
  ) {
    return {
      status: 400,
      body: { error: "records must be a non-empty array of objects" },
    };
  }
  if (records.some(containsLink)) {
    return {
      status: 400,
      body: {
        error: "records must not contain cell links",
      },
    };
  }
  if (records.length > MAX_BATCH) {
    return {
      status: 413,
      body: { error: `Batch too large (max ${MAX_BATCH} records)` },
    };
  }

  try {
    const appended = await appendToJournal(
      runtime,
      registration,
      partition,
      records as Record<string, unknown>[],
    );
    // Best-effort last-seen bump (operator status, not ingest — no mark) so a
    // dead beacon is visible. Failure must not fail the POST.
    try {
      const seen = lastSeenCell(runtime, serviceSpace, id);
      await seen.sync();
      await runtime.storageManager.synced();
      await durableSet(seen, new Date().toISOString());
    } catch (error) {
      logger?.error({ error, id }, "ingest: failed to bump last-seen");
    }
    logger?.info({ id, partition, appended }, "ingest: appended records");
    // received === appended in v1 (no server dedup); `appended` is a distinct
    // field only to leave room for a future dedup story without a wire change.
    return { status: 200, body: { received: records.length, appended } };
  } catch (error) {
    logger?.error({ error, id, partition }, "ingest: failed to append records");
    return { status: 502, body: { error: "Failed to write records" } };
  }
}
