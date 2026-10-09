// The transport-independent core of the ingest-channel control plane.
//
// Split out from the Hono handlers for the same reason `processIngest` was
// (ingest.utils.ts): the handlers import the `runtime` singleton from
// `@/index.ts`, which is uninitialized under test, so anything that reaches
// storage can only ever be smoke-tested. Everything security-relevant —
// ownership enforcement, the rotate/revoke IDOR invariant, replay idempotency,
// and "a secret hash never leaves the server" — lives here and is exercised
// against a real runtime.
//
// The ORDER inside each verb is load-bearing:
//   1. validate shape
//   2. resolve the target space — for rotate/revoke from the STORED
//      registration, NEVER from caller input
//   3. authorize: an explicit OWNER grant, plus a check that this deployment
//      could actually write there
//   4. claim the request id (replay defense)
//   5. only then mint or mutate

import { parseLink, type Runtime } from "@commonfabric/runner";
import {
  authorizeSpaceOwner,
  isValidSpaceDid,
  NOT_OWNER_MESSAGE,
  type SpaceAuthority,
} from "@/lib/space-authority.ts";
import {
  type CellTarget,
  cellTargetOf,
  channelId,
  ClaimStoreFullError,
  generateIngestSecret,
  getLastSeen,
  getOwnerRegistrationIndex,
  getRegistration,
  getSpaceLifetimeChannelCount,
  getSpaceRegistrationIndex,
  type IngestChannelKind,
  type IngestRegistration,
  ingestUrl,
  isValidRequestId,
  isValidSegment,
  LifetimeChannelCapError,
  LiveChannelCapError,
  MAX_REVOCATION_HISTORY,
  peekMintRequest,
  RegistrationConflictError,
  RequestAlreadyClaimedError,
  saveRegistration,
  SpaceLifetimeChannelCapError,
} from "@/routes/ingest/ingest.utils.ts";
import {
  BindingConflictError,
  bindMailbox,
  MailboxBindingFullError,
  type MailboxLookup,
  MAX_CHANNELS_PER_MAILBOX,
} from "@/routes/ingest-push/gmail-push.utils.ts";

const DEFAULT_CAUSE_PREFIX = "location";

/**
 * Ceiling on a requested ttl. A decade-long token is finite only on paper: the
 * expiry is one of the two things bounding the window between an owner losing
 * their grant and their credential ceasing to work, and a year is long enough
 * for a device that is genuinely in service.
 */
export const MAX_TTL_DAYS = 365;

/**
 * Every self-serve credential is finite-lived. `ttlDays` is optional on the
 * wire but never absent at rest: an unbounded token means the only bound on a
 * revoked owner's access is somebody noticing, and the mint-time ACL check is
 * a point-in-time claim that nothing else re-verifies.
 */
export const DEFAULT_TTL_DAYS = 90;

/** Bounds `processList`'s serial resolves — see `ownerIndexCell` for why. */
export const MAX_CHANNELS_PER_OWNER = 200;

/**
 * How many channels one owner may ever CREATE. Revoking does not refund it.
 *
 * The live cap bounds only what is currently active, and everything a mint
 * writes outlives revocation on purpose: the registration cell stays so a
 * retired token can be told apart from an unknown one, and the audit entry
 * stays so a trust-condition sweep can still enumerate it. Mint → revoke →
 * mint is therefore unbounded growth of deployment-wide state driven by a
 * single authenticated user. This is the bound on it.
 *
 * Generous by design — it is a runaway stop, not a product limit. An owner who
 * legitimately reaches it has a story worth an operator conversation.
 */
export const MAX_LIFETIME_CHANNELS_PER_OWNER = 1_000;

/**
 * How many channels may ever be created against one SPACE.
 *
 * The per-owner quota above bounds a KEYPAIR, and keypairs are free: one person
 * with one space can grant OWNER to as many fresh DIDs as they like and spend a
 * new allowance from each, while every new DID also mints its own permanent
 * `by-owner`, `lifetime` and `requests` cells. A per-owner bound alone is
 * therefore not a bound at all.
 *
 * A space is the thing a channel must name and hold a recorded ACL grant on, so
 * metering it closes key churn — and closes the per-key cell family with it,
 * since a refused mint writes nothing. Creating unlimited spaces remains an
 * axis, but that is the deployment's admission control, not this feature's.
 */
export const MAX_LIFETIME_CHANNELS_PER_SPACE = 500;

export interface ControlDeps {
  runtime: Runtime;

  /** The toolshed's own space — where registrations live. */
  serviceSpace: string;

  operatorDid: string;
  serviceDids: readonly string[];
  hostsSpace: (space: string) => boolean;

  /** See SpaceAuthorityDeps.aclMode — gates the operator-write prediction only. */
  aclMode?: "off" | "observe" | "enforce";

  /** Overridable so a test can reach the cap without minting the whole limit. */
  maxChannelsPerOwner?: number;

  maxLifetimeChannelsPerOwner?: number;
  maxLifetimeChannelsPerSpace?: number;
  apiUrl: string;

  /**
   * How a mint proves the mailbox it binds. Absent where Gmail push is not
   * configured, and a mint carrying a proof is then refused.
   */
  gmail?: GmailProofDeps;
  logger?: {
    warn: (obj: unknown, msg: string) => void;
    info: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
}

/** What a mint asks of Google to learn which mailbox a token is for. */
export interface GmailProofDeps {
  /** Asks Gmail which mailbox an access token reads. */
  fetchMailbox: (accessToken: string) => Promise<MailboxLookup>;

  /** Verifies a Google ID token and reads the mailbox it names. */
  verifyIdToken: (idToken: string) => Promise<MailboxLookup>;
}

/**
 * Proof that the caller holds a Gmail mailbox, carried on a mint to bind the
 * channel to that mailbox: a Google access token that reads it, used for one
 * profile lookup and kept nowhere, or a Google ID token naming it, which
 * grants nothing and is the proof to prefer. Exactly one of the two.
 */
export interface GmailProof {
  accessToken?: string;
  idToken?: string;
}

/** The one-time mint/rotate view. `token` is shown here and nowhere else. */
export interface MintedChannel {
  id: string;

  /**
   * Where a device POSTs records, with `token` as its bearer secret. A
   * device channel has both; a gmail channel, which nothing POSTs to, has
   * neither.
   */
  url?: string;
  space: string;

  /** A device channel's cause prefix; absent on a `gmail` channel. */
  causePrefix?: string;

  /** A `gmail` channel's cell; absent on a device channel. */
  target?: CellTarget;
  installId: string;
  expiresAt?: string;
  token?: string;

  /** The mailbox the channel was bound to, when the mint carried a proof. */
  emailAddress?: string;
}

export interface ChannelView {
  id: string;
  name: string;
  space: string;
  causePrefix?: string;
  target?: CellTarget;
  installId: string;
  kind: IngestChannelKind;
  createdAt: string;
  enabled: boolean;
  owner?: string;
  expiresAt?: string;
  revoked?: { at: string; by: string };
  revocations?: { at: string; by: string }[];
  lastSeenAt: string | null;

  /**
   * The generation of this registration. Surfaced because `revoke` requires
   * it: it is what binds a revoke to the credential the caller actually looked
   * at, so a captured request cannot land on a later one.
   */
  revision: number;
}

/**
 * Mirrors `IngestResult` (ingest.utils.ts): the success body is discriminated
 * by status, so handlers hand it to `c.json` without a cast. A single
 * `Record<string, unknown>` body would push five `as any` into the handlers —
 * the ambiguous-type antipattern in docs/development/DEVELOPMENT.md.
 */
export type ControlResult<T> =
  | { status: 200; body: T }
  | { status: 400 | 403 | 409 | 429 | 502; body: { error: string } };

// The denial sentence is owned by space-authority.ts, which decides denials.
// A local copy drifts silently: the two are only ever compared against each
// other, never against the text a caller actually receives.
const forbidden = (): ControlResult<never> => ({
  status: 403,
  body: { error: NOT_OWNER_MESSAGE },
});

const bad = (error: string): ControlResult<never> => ({
  status: 400,
  body: { error },
});
const conflict = (error: string): ControlResult<never> => ({
  status: 409,
  body: { error },
});

/** `not-owner` is the opaque 403; the operator problems are actionable 409s. */
const fromAuthority = (
  authority: Extract<SpaceAuthority, { ok: false }>,
): ControlResult<never> =>
  authority.kind === "not-owner"
    ? { status: 403, body: { error: authority.message } }
    : { status: 409, body: { error: authority.message } };

const authorize = async (
  deps: ControlDeps,
  space: string,
  callerDid: string,
): Promise<SpaceAuthority> => {
  const authority = await authorizeSpaceOwner(
    {
      runtime: deps.runtime,
      operatorDid: deps.operatorDid,
      serviceDids: deps.serviceDids,
      hostsSpace: deps.hostsSpace,
      aclMode: deps.aclMode,
    },
    space,
    callerDid,
  );
  if (!authority.ok) {
    deps.logger?.warn(
      { space, callerDid, kind: authority.kind, detail: authority.logDetail },
      "ingest-channels: authorization denied",
    );
  }
  return authority;
};

/**
 * Rebuild revocation entries as plain objects.
 *
 * Values read back from a cell are deep-frozen `FabricValue`s, and re-embedding
 * one into a NEW array does not round-trip — the array reads back absent, with
 * no error. Every site that writes a stored registration back has to do this;
 * the two that matter are `persist` and `processRevoke`.
 */
export const plainRevocations = (
  entries: readonly { at: string; by: string }[] | undefined,
): { at: string; by: string }[] | undefined =>
  entries?.map((r) => ({ at: r.at, by: r.by }));

/** The caller-safe view of a registration. `secretHash` is never included. */
export const channelSummary = (
  r: IngestRegistration,
): Omit<ChannelView, "lastSeenAt"> => ({
  id: r.id,
  name: r.name,
  space: r.space,
  ...(r.causePrefix !== undefined ? { causePrefix: r.causePrefix } : {}),
  ...(r.target !== undefined ? { target: r.target } : {}),
  installId: r.installId,
  kind: r.kind,
  createdAt: r.createdAt,
  enabled: r.enabled,
  ...(r.owner !== undefined ? { owner: r.owner } : {}),
  ...(r.expiresAt !== undefined ? { expiresAt: r.expiresAt } : {}),
  ...(r.revoked !== undefined ? { revoked: r.revoked } : {}),
  // Surfaced deliberately: the whole justification for a soft revoke rather
  // than webhooks' hard delete is that the trail survives. A trail the owner
  // cannot read would not have justified anything.
  ...(r.revocations !== undefined ? { revocations: r.revocations } : {}),
  revision: r.revision ?? 0,
});

/** Mint a fresh secret, persist, and build the ONE-TIME response. */
const persist = async (
  deps: ControlDeps,
  params: {
    id: string;
    name: string;
    space: string;
    installId: string;

    /** A device channel with its cause prefix, or a gmail channel with its cell. */
    writes: { kind: "device"; causePrefix: string } | {
      kind: "gmail";
      target: CellTarget;
    };
    existing: IngestRegistration | null;
    callerDid: string;
    ttlDays?: number;

    /** The hash being rotated away from, so a stale device can be told to re-pair. */
    rotatedFrom?: string;

    /** Consumed atomically with this write, or not at all. */
    requestId: string;
  },
): Promise<ControlResult<MintedChannel>> => {
  const { secret, secretHash } = generateIngestSecret();
  const now = new Date();
  // Bounded before arithmetic: `new Date(huge).toISOString()` throws RangeError,
  // and this runs outside the try below, so an unbounded ttl escapes the handler
  // as an uncaught 500. The schema caps it too; this is the belt for callers
  // that reach the core directly.
  // Always finite, and always still open. An explicit ttl wins; otherwise a
  // re-mint keeps the window it has left, and a first mint — or one whose
  // window has already lapsed — takes the default.
  //
  // Inheriting a LAPSED expiry would hand back a token the data plane refuses
  // on its first POST, which is the shape a re-pair is meant to escape: mint
  // and rotate are exactly what an owner reaches for when a channel stopped
  // working. An unparseable value fails the comparison and is treated as
  // lapsed, so a corrupt expiry cannot be inherited either.
  const openExpiry = params.existing?.expiresAt !== undefined &&
      Date.parse(params.existing.expiresAt) > now.getTime()
    ? params.existing.expiresAt
    : undefined;
  const ttlDays = params.ttlDays ??
    (openExpiry === undefined ? DEFAULT_TTL_DAYS : undefined);
  const expiresAt = ttlDays === undefined ? openExpiry : new Date(
    now.getTime() + Math.min(Math.max(ttlDays, 1), MAX_TTL_DAYS) * 86_400_000,
  ).toISOString();

  // Minting and rotating are both the owner RE-AUTHORIZING the channel, so both
  // clear `revoked`. Carrying it forward would return a fresh token that the
  // data plane refuses on the very next POST — a token dead on arrival, with a
  // success message. The audit trail moves to `revocations` instead, so nothing
  // is erased.
  // Rebuilt as plain objects rather than re-embedding the entries read back
  // from storage: those are deep-frozen `FabricValue`s, and writing them back
  // inside a new array does not round-trip — the history silently vanishes.
  // Pinned by the re-mint-after-revoke test.
  const revocations = params.existing?.revoked !== undefined
    ? [
      ...(plainRevocations(params.existing.revocations) ?? []),
      { at: params.existing.revoked.at, by: params.existing.revoked.by },
    ].slice(-MAX_REVOCATION_HISTORY)
    : plainRevocations(params.existing?.revocations);

  const registration: IngestRegistration = {
    id: params.id,
    name: params.name,
    space: params.space,
    ...(params.writes.kind === "device"
      ? { causePrefix: params.writes.causePrefix }
      : { target: params.writes.target }),
    installId: params.installId,
    kind: params.writes.kind,
    secretHash,
    createdBy: deps.operatorDid,
    createdAt: params.existing?.createdAt ?? now.toISOString(),
    enabled: true,
    owner: params.callerDid,
    revision: (params.existing?.revision ?? 0) + 1,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(revocations !== undefined && revocations.length > 0
      ? { revocations }
      : {}),
    // Only a ROTATION records a superseded hash. A first mint has none, and a
    // re-mint of a channel whose token was never handed out does not need one.
    ...(params.existing !== undefined && params.existing !== null &&
        params.rotatedFrom !== undefined
      ? { previousSecretHash: params.rotatedFrom }
      : {}),
  };

  try {
    await saveRegistration(
      deps.runtime,
      deps.serviceSpace,
      registration,
      // The registration must still be exactly what this call read. Otherwise a
      // concurrent rotate/revoke has already moved it and our decisions —
      // takeover guard, cap check, revocation history — were made against a
      // snapshot that is no longer current.
      params.existing === null ? null : (params.existing.revision ?? 0),
      {
        owner: params.callerDid,
        requestId: params.requestId,
        channel: params.id,
      },
      {
        live: deps.maxChannelsPerOwner ?? MAX_CHANNELS_PER_OWNER,
        lifetime: deps.maxLifetimeChannelsPerOwner ??
          MAX_LIFETIME_CHANNELS_PER_OWNER,
        spaceLifetime: deps.maxLifetimeChannelsPerSpace ??
          MAX_LIFETIME_CHANNELS_PER_SPACE,
      },
    );
  } catch (error) {
    if (error instanceof RequestAlreadyClaimedError) {
      return conflict(
        `requestId already used for channel ${error.channel}. A replay never ` +
          `returns a token; retry with a fresh requestId.`,
      );
    }
    if (error instanceof LiveChannelCapError) {
      return conflict(
        `You already hold ${error.live} active ingest channels (limit ` +
          `${deps.maxChannelsPerOwner ?? MAX_CHANNELS_PER_OWNER}). Revoke ` +
          `some before minting more.`,
      );
    }
    if (error instanceof SpaceLifetimeChannelCapError) {
      return conflict(
        `${error.created} ingest channels have been created against this ` +
          `space, its lifetime limit. Revoking does not free capacity, and ` +
          `neither does using a different key — contact an operator.`,
      );
    }
    if (error instanceof LifetimeChannelCapError) {
      // Deliberately NOT phrased as "revoke some": revoking frees nothing here,
      // and telling the user otherwise sends them round a loop that cannot
      // succeed.
      return conflict(
        `You have created ${error.created} ingest channels, the lifetime ` +
          `limit for one identity. Revoking does not free capacity — contact ` +
          `an operator.`,
      );
    }
    if (error instanceof ClaimStoreFullError) {
      return {
        status: 429,
        body: { error: "Too many recent requests — retry in a few minutes" },
      };
    }
    if (error instanceof RegistrationConflictError) {
      // The id was NOT consumed: the claim is written in the same transaction,
      // so a lost precondition rolls it back with everything else. Retrying
      // with the same id is safe and is the right advice.
      return conflict(
        `Channel ${params.id} changed while this request was in flight. Retry.`,
      );
    }
    deps.logger?.error(
      { error, id: params.id },
      "ingest-channels: save failed",
    );
    return { status: 502, body: { error: "Storage failure" } };
  }

  // The data plane refuses a gmail channel, so its URL and secret would only
  // mislead whoever reads the response. The secret is still minted and its
  // hash stored: a registration has one whatever its kind.
  const devicePath = registration.kind === "device"
    ? {
      url: ingestUrl(deps.apiUrl, registration.space, registration.id),
      // Shown once, here only. Only the hash is ever stored.
      token: secret,
    }
    : {};
  return {
    status: 200,
    body: {
      id: registration.id,
      space: registration.space,
      ...(registration.causePrefix !== undefined
        ? { causePrefix: registration.causePrefix }
        : {}),
      ...(registration.target !== undefined
        ? { target: registration.target }
        : {}),
      installId: registration.installId,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...devicePath,
    },
  };
};

export interface MintInput {
  space: string;
  installId: string;

  /** A device channel's cause prefix, `location` unless named. Not for a gmail channel. */
  causePrefix?: string;
  name?: string;
  ttlDays?: number;

  /**
   * The cell a gmail channel writes, as a link the caller names, in the space
   * the mint is addressed to. Comes with `gmail`, and the two together make
   * the channel a gmail channel; a mint without them makes a device channel.
   */
  target?: unknown;

  /**
   * Binds the channel to the Gmail mailbox the proof is for, in the same
   * mint. Minting again with a proof for another mailbox moves the channel;
   * minting again without one leaves the binding as it is.
   */
  gmail?: GmailProof;
  requestId: string;
}

export async function processMint(
  deps: ControlDeps,
  callerDid: string,
  input: MintInput,
): Promise<ControlResult<MintedChannel>> {
  // A proof and a target come together: the proof says which mailbox wakes
  // the channel, the target says which cell it wakes. Neither alone means
  // anything, and together they make the channel a gmail channel. A mint with
  // neither is a device channel, or a re-mint of whatever the channel is.
  if ((input.gmail === undefined) !== (input.target === undefined)) {
    return bad(
      input.gmail === undefined
        ? "A target cell is minted with a mailbox proof"
        : "A mailbox proof needs a target cell to write to",
    );
  }
  let target: CellTarget | undefined;
  if (input.gmail !== undefined) {
    const proofs = [input.gmail.accessToken, input.gmail.idToken]
      .filter((proof) => proof !== undefined);
    if (proofs.length !== 1) {
      return bad("A mailbox proof is one access token or one ID token");
    }
    if (input.causePrefix !== undefined) {
      return bad("A gmail channel has a target cell, not a cause prefix");
    }
    const link = parseLink(input.target);
    if (
      link === undefined || link.id === undefined || link.space === undefined
    ) {
      return bad("The target is not a complete cell link");
    }
    target = cellTargetOf(link);
    // The mint is addressed to one space and authorized against it, so a cell
    // elsewhere is refused outright rather than written under another
    // space's grant.
    if (target.space !== input.space) {
      return bad(
        "The target cell is in another space than the one minted into",
      );
    }
  }

  // A malformed space DID shares the ownership denial rather than getting its
  // own 400: a distinguishable shape error is a free probe.
  if (!isValidSpaceDid(input.space)) return forbidden();
  // `installId` is caller-supplied under self-serve and lands in the provenance
  // mark's `audience`. Its charset is what keeps a minted audience from
  // impersonating the token-less integration audiences
  // (`did:web:commonfabric.org#oauth2`, `#plaid`), which contain `:` and `#`.
  if (!isValidSegment(input.installId)) return bad("Invalid installId");
  if (input.causePrefix !== undefined && !isValidSegment(input.causePrefix)) {
    return bad("Invalid causePrefix");
  }
  if (!isValidRequestId(input.requestId)) return bad("Invalid requestId");

  const authority = await authorize(deps, input.space, callerDid);
  if (!authority.ok) return fromAuthority(authority);

  const id = channelId(input.space, input.installId);

  let existing: IngestRegistration | null;
  try {
    existing = await getRegistration(deps.runtime, deps.serviceSpace, id);
  } catch (error) {
    deps.logger?.error({ error, id }, "ingest-channels: lookup failed");
    return { status: 502, body: { error: "Storage failure" } };
  }

  // A device channel's cause prefix is `location` unless named; a gmail
  // channel has none, and a re-mint of one that names no prefix keeps it so.
  const causePrefix = target !== undefined ? undefined : input.causePrefix ??
    (existing?.kind === "gmail" ? undefined : DEFAULT_CAUSE_PREFIX);

  if (existing) {
    // Re-minting is how an owner re-pairs their own device, but the id derives
    // from (space, installId) alone — so a DIFFERENT principal minting the same
    // installId would silently replace the owner and kill the incumbent's live
    // token with no revocation record. Both parties hold OWNER on the space, so
    // this is not an escalation, but it must be deliberate and auditable:
    // require an explicit revoke first. `installId` is caller-chosen and
    // low-entropy ("phone-1"), so an accidental collision between co-owners is
    // entirely plausible.
    //
    // An UNOWNED channel (minted by the operator script, which records no
    // verified owner) may be adopted by a space owner — that is the migration
    // path off the script.
    // Gated on the REVOKED state, not on ownership alone. `owner` is
    // attribution and survives revocation, and there is no delete path, so an
    // ownership-only gate would lock a channel to one DID permanently and the
    // message below would name a remedy that cannot be carried out. Takeover is
    // therefore a deliberate, auditable two-step — revoke, which is recorded in
    // `revocations`, then mint — and both steps require OWNER on the space.
    //
    // It is also the recovery path for a user who re-keys: the new DID revokes
    // the channel the old DID minted, then mints it back.
    if (
      existing.owner !== undefined && existing.owner !== callerDid &&
      existing.revoked === undefined
    ) {
      return conflict(
        `Channel ${id} is registered to a different owner. Revoke it first if ` +
          `you intend to take it over (the revocation is recorded).`,
      );
    }
    // Where a channel writes is immutable for the life of the (space,
    // installId) pair: changing it would move where data lands and orphan the
    // existing read path. Revoking does NOT free it — the registration is
    // retained deliberately — so the only honest remedy is a different
    // installId. A device channel's cause prefix and a gmail channel's
    // target cell are each held to that, and so is the kind itself.
    if (input.gmail !== undefined && existing.kind !== "gmail") {
      return bad(
        `Channel ${id} is a device channel, and a mailbox binds to a gmail ` +
          `channel. Use a different --install-id.`,
      );
    }
    if (input.causePrefix !== undefined && existing.kind === "gmail") {
      return conflict(
        `Channel ${id} is a gmail channel, which has a target cell and no ` +
          `cause prefix. Use a different --install-id for a device channel.`,
      );
    }
    if (causePrefix !== undefined && existing.causePrefix !== causePrefix) {
      return conflict(
        `Channel ${id} is registered with cause-prefix ` +
          `'${existing.causePrefix}', and a channel's cause-prefix cannot ` +
          `change (it would orphan the existing read path). Use a different ` +
          `--install-id to get a channel with cause-prefix '${causePrefix}'.`,
      );
    }
    if (
      target !== undefined && existing.target !== undefined &&
      !sameTarget(existing.target, target)
    ) {
      return conflict(
        `Channel ${id} writes the cell ${existing.target.id}, and a ` +
          `channel's target cell cannot change (it would orphan the existing ` +
          `reader). Use a different --install-id for a channel writing ` +
          `${target.id}.`,
      );
    }
  }

  // The live-channel and lifetime caps are NOT checked here. They are enforced
  // inside `saveRegistration`'s transaction, where the owner index and the
  // lifetime counter join the read set. A pre-transaction count is advisory:
  // N concurrent mints all read the same under-cap number and all commit, so
  // the cap is exceeded by the width of the burst. It was also O(live) resolves
  // per mint, each an awaited global `synced()` barrier.

  // AFTER authorization (a stranger must not be able to burn or probe request
  // ids) and BEFORE minting (a replay must never reach generateIngestSecret).
  const replay = await peekReplay(deps, callerDid, input.requestId);
  if (replay) return replay;

  // After the replay check, so that a replay costs no request to Google, and
  // before the mint, so that a refused proof mints nothing.
  let mailbox: string | undefined;
  if (input.gmail !== undefined) {
    const proven = await proveMailbox(deps, input.gmail);
    if (!proven.ok) return proven.result;
    mailbox = proven.emailAddress;
  }

  const minted = await persist(deps, {
    id,
    requestId: input.requestId,
    name: input.name ?? `ingest-${input.installId}`,
    space: input.space,
    installId: input.installId,
    writes: writesOf({ causePrefix, target }, existing),
    existing,
    callerDid,
    ttlDays: input.ttlDays,
    // Re-minting an existing channel replaces its secret, so it IS a rotation
    // — and it is the flow a user reaches for to re-pair a device. Without
    // this the old device gets the blank 401 that decision #1 exists to
    // remove, on the single most likely path to reach it.
    ...(existing ? { rotatedFrom: existing.secretHash } : {}),
  });
  if (minted.status !== 200 || mailbox === undefined) return minted;

  // The binding is a second write, after the registration's. A binding that
  // fails leaves a minted channel bound to nothing, and the caller mints
  // again with the same install id and proof to bind it.
  try {
    await bindMailbox(deps.runtime, deps.serviceSpace, id, mailbox);
  } catch (error) {
    if (error instanceof MailboxBindingFullError) {
      return conflict(
        `Channel ${id} is minted but not bound: the mailbox already has ` +
          `${MAX_CHANNELS_PER_MAILBOX} bound channels. Revoke one, then ` +
          `mint again.`,
      );
    }
    if (error instanceof BindingConflictError) {
      return conflict(
        `Channel ${id} is minted but not bound: its binding changed ` +
          `concurrently. Mint again.`,
      );
    }
    deps.logger?.error({ error, id }, "ingest-channels: bind failed");
    return { status: 502, body: { error: "Storage failure" } };
  }
  deps.logger?.info({ id }, "ingest-channels: bound a mailbox");
  return {
    status: 200,
    body: { ...minted.body, emailAddress: mailbox },
  };
}

/** Returns whether two cell targets name the same cell. */
function sameTarget(a: CellTarget, b: CellTarget): boolean {
  return a.space === b.space && a.id === b.id &&
    a.path.length === b.path.length &&
    a.path.every((segment, i) => segment === b.path[i]);
}

/**
 * Helper for `processMint()` and `processRotate()`, which returns what the
 * registration will say it writes: the target the mint named, or the cause
 * prefix it named, or else what the existing registration already carries.
 * Throws for an existing registration carrying neither, which no mint writes.
 */
function writesOf(
  named: { causePrefix?: string; target?: CellTarget },
  existing: IngestRegistration | null,
): { kind: "device"; causePrefix: string } | {
  kind: "gmail";
  target: CellTarget;
} {
  if (named.target !== undefined) {
    return { kind: "gmail", target: named.target };
  }
  if (named.causePrefix !== undefined) {
    return { kind: "device", causePrefix: named.causePrefix };
  }
  if (existing?.kind === "gmail" && existing.target !== undefined) {
    return { kind: "gmail", target: existing.target };
  }
  if (existing?.causePrefix !== undefined) {
    return { kind: "device", causePrefix: existing.causePrefix };
  }
  throw new Error(
    `channel ${existing?.id} carries neither a cause prefix nor a target`,
  );
}

/**
 * Helper for `processMint()`, which learns the mailbox a proof is for, or the
 * refusal to answer with: 400 for a proof Google rejects or a kind this
 * deployment does not accept, 502 for Google being unreachable.
 */
async function proveMailbox(
  deps: ControlDeps,
  proof: GmailProof,
): Promise<
  | { ok: true; emailAddress: string }
  | { ok: false; result: ControlResult<never> }
> {
  if (deps.gmail === undefined) {
    return {
      ok: false,
      result: bad("Gmail push is not configured on this deployment"),
    };
  }
  let lookup: MailboxLookup;
  try {
    lookup = proof.idToken !== undefined
      ? await deps.gmail.verifyIdToken(proof.idToken)
      : await deps.gmail.fetchMailbox(proof.accessToken ?? "");
  } catch (error) {
    deps.logger?.error({ error }, "ingest-channels: mailbox proof failed");
    return {
      ok: false,
      result: { status: 502, body: { error: "Google could not be reached" } },
    };
  }
  if (lookup.ok) return lookup;
  switch (lookup.reason) {
    case "rejected":
      return { ok: false, result: bad("Google did not accept the token") };
    case "unsupported":
      return {
        ok: false,
        result: bad(
          "This deployment accepts no ID tokens; prove the mailbox with an " +
            "access token",
        ),
      };
    case "unavailable":
      return {
        ok: false,
        result: { status: 502, body: { error: "Google could not be reached" } },
      };
  }
}

/**
 * Reject an obvious replay before any work. Read-only and therefore advisory —
 * the authoritative check runs inside the transaction that records the claim
 * (`saveRegistration`). This exists so a replay does not reach
 * `generateIngestSecret`, not to decide the outcome.
 */
const peekReplay = async (
  deps: ControlDeps,
  callerDid: string,
  requestId: string,
): Promise<ControlResult<never> | null> => {
  let claimed: string | null;
  try {
    claimed = await peekMintRequest(
      deps.runtime,
      deps.serviceSpace,
      callerDid,
      requestId,
    );
  } catch (error) {
    deps.logger?.error(
      { error, requestId },
      "ingest-channels: claim read failed",
    );
    return { status: 502, body: { error: "Storage failure" } };
  }
  if (claimed === null) return null;
  return conflict(
    `requestId already used for channel ${claimed}. A replay never returns a ` +
      `token; retry with a fresh requestId.`,
  );
};

export async function processRotate(
  deps: ControlDeps,
  callerDid: string,
  input: { id: string; requestId: string; ttlDays?: number; space?: string },
): Promise<ControlResult<MintedChannel>> {
  if (!isValidRequestId(input.requestId)) return bad("Invalid requestId");

  const existing = await loadOwned(deps, callerDid, input.id, input.space);
  if (!existing.ok) return existing.result;
  // A gmail channel has no token anything uses, so there is nothing to
  // rotate; what a rotate would incidentally do, re-enable the channel or
  // extend it, a mint does on purpose and with the mailbox proof.
  if (existing.registration.kind === "gmail") {
    return bad(
      `Channel ${input.id} is a gmail channel, which has no token to ` +
        `rotate. Mint it again to re-enable or extend it.`,
    );
  }

  // The SAME takeover protocol mint enforces. `loadOwned` only proves the
  // caller owns the target space, so without this a co-owner could rotate a
  // channel someone else minted: the secret is replaced, `persist` reassigns
  // `owner` to the caller, the incumbent's device dies, the channel vanishes
  // from the incumbent's list, and no revocation record explains any of it.
  // Taking a channel over stays a deliberate, auditable revoke-then-mint.
  if (
    existing.registration.owner !== undefined &&
    existing.registration.owner !== callerDid
  ) {
    return conflict(
      `Channel ${input.id} is registered to a different owner. Revoke it ` +
        `first if you intend to take it over (the revocation is recorded).`,
    );
  }

  const replay = await peekReplay(deps, callerDid, input.requestId);
  if (replay) return replay;

  return await persist(deps, {
    id: input.id,
    requestId: input.requestId,
    name: existing.registration.name,
    space: existing.registration.space,
    installId: existing.registration.installId,
    writes: writesOf({}, existing.registration),
    existing: existing.registration,
    callerDid,
    ttlDays: input.ttlDays,
    // So a device still holding the old token learns to re-pair instead of
    // getting a blank 401 it cannot act on.
    rotatedFrom: existing.registration.secretHash,
  });
}

export async function processRevoke(
  deps: ControlDeps,
  callerDid: string,
  input: {
    id: string;
    requestId: string;
    expectedRevision: number;
    space?: string;
  },
): Promise<ControlResult<{ id: string; revokedAt: string; revision: number }>> {
  if (!isValidRequestId(input.requestId)) return bad("Invalid requestId");

  const existing = await loadOwned(deps, callerDid, input.id, input.space);
  if (!existing.ok) return existing.result;

  // The caller must name the generation they looked at. This is enforced again
  // inside the write transaction — checking it here only buys a better message.
  const current = existing.registration.revision ?? 0;
  if (input.expectedRevision !== current) {
    return conflict(
      `Channel ${input.id} is at revision ${current}, not ` +
        `${input.expectedRevision}. It changed since you looked at it — list ` +
        `it again and re-issue the revoke against what you see.`,
    );
  }

  const replay = await peekReplay(deps, callerDid, input.requestId);
  if (replay) return replay;

  return await writeRevocation(deps, callerDid, input, existing.registration, {
    claim: true,
  });
}

/**
 * The revocation write itself, separated so it can be retried without the
 * idempotency claim when the claim store is full (see the handler below).
 */
const writeRevocation = async (
  deps: ControlDeps,
  callerDid: string,
  input: { id: string; requestId: string; expectedRevision: number },
  registration: IngestRegistration,
  opts: { claim: boolean },
): Promise<
  ControlResult<{ id: string; revokedAt: string; revision: number }>
> => {
  // Already revoked: keep the ORIGINAL revocation rather than overwriting it.
  // Any owner of the space may revoke, so an overwrite would let a later caller
  // replace an operator retirement's attribution with their own.
  //
  // It still WRITES, and the write is what makes the answer trustworthy. A
  // read-only fast path here would decide "already revoked" from a registration
  // read before the transaction — and a re-mint landing in that window would
  // leave this reporting success while a freshly minted credential is live.
  // Going through the transaction means `expectedRevision` is enforced against
  // what is actually stored, so that case answers 409.
  //
  // The revision advances even though nothing else does. That is deliberate: it
  // makes the write self-limiting. A revoked channel at a STABLE revision has a
  // precondition that never stops matching, so the same request could be
  // replayed for unlimited 200-returning durable transactions. Advancing it
  // means a repeat must go read the new generation first.
  const alreadyRevoked = registration.revoked !== undefined;
  const revokedAt = alreadyRevoked
    ? registration.revoked!.at
    : new Date().toISOString();
  try {
    const history = plainRevocations(registration.revocations);
    await saveRegistration(
      deps.runtime,
      deps.serviceSpace,
      {
        ...registration,
        enabled: false,
        revoked: alreadyRevoked
          ? { at: registration.revoked!.at, by: registration.revoked!.by }
          : { at: revokedAt, by: callerDid },
        revision: (registration.revision ?? 0) + 1,
        // Rebuilt, not carried through the spread: see plainRevocations.
        // Without this the history vanishes on the SECOND revoke.
        ...(history !== undefined ? { revocations: history } : {}),
      },
      input.expectedRevision,
      opts.claim
        ? { owner: callerDid, requestId: input.requestId, channel: input.id }
        : undefined,
    );
  } catch (error) {
    if (error instanceof RequestAlreadyClaimedError) {
      return conflict(
        `requestId already used for channel ${error.channel}. Retry with a ` +
          `fresh requestId.`,
      );
    }
    if (error instanceof ClaimStoreFullError && opts.claim) {
      // NOT a 429 on this verb. Refusing a revoke because a bookkeeping cell is
      // full fails OPEN with respect to the credential: the token the caller is
      // trying to kill stays live. Mint and rotate can be refused safely —
      // nothing dangerous happens if they do not run — but revoke is the one
      // verb where "try again later" is the wrong answer.
      //
      // Safe to proceed without the claim because the request id is no longer
      // what binds a revoke to its target: `expectedRevision` is, and that is
      // enforced in the write transaction either way. Dropping at-most-once
      // delivery here costs a redundant no-op write, never a wrong revocation.
      deps.logger?.warn(
        { id: input.id, owner: callerDid },
        "ingest-channels: claim store full; revoking without idempotency",
      );
      return await writeRevocation(deps, callerDid, input, registration, {
        claim: false,
      });
    }
    if (error instanceof RegistrationConflictError) {
      return conflict(
        `Channel ${input.id} changed while this request was in flight. List ` +
          `it again and re-issue the revoke against what you see.`,
      );
    }
    deps.logger?.error(
      { error, id: input.id },
      "ingest-channels: revoke failed",
    );
    return { status: 502, body: { error: "Storage failure" } };
  }
  return {
    status: 200,
    body: { id: input.id, revokedAt, revision: input.expectedRevision + 1 },
  };
};

export async function processList(
  deps: ControlDeps,
  callerDid: string,
  input: { space?: string } = {},
): Promise<ControlResult<{ channels: ChannelView[] }>> {
  // TWO MODES, because "what did I mint" and "what can write into my space" are
  // different questions and only the second is a revocation path.
  //
  // Without `space`: the caller's own index — cheap, reads no foreign ACL.
  //
  // With `space`: the caller must currently own it, and then sees EVERY channel
  // targeting it, whoever minted it. That is the case that matters. A channel
  // minted by someone whose grant has since been removed stays live, and the
  // owner index would never show it to the person who now owns the space — so
  // the only party entitled to revoke it could not discover its id. The
  // resource is the space, not the minting key; list has to agree with that.
  const scoped = input.space !== undefined;
  // Shape-checked before it reaches storage, so an arbitrary string never
  // becomes a cell cause. Shares the ownership denial, as mint does.
  if (scoped && !isValidSpaceDid(input.space!)) return forbidden();

  let ids: string[];
  try {
    if (scoped) {
      // Read the index FIRST. It lives in the operator's own service space, so
      // it mounts nothing foreign — whereas authorizing reads the target
      // space's ACL, which mounts a replica of it that is never evicted. Doing
      // that for any caller-named space would let anyone grow the provider set
      // one space at a time, and `synced()` is a global barrier over all of
      // them.
      //
      // A space that has NEVER had a channel answers with the same opaque
      // denial as one the caller does not own. Returning an empty list instead
      // would say "this space is hosted and has none", which is exactly the
      // existence oracle the denials are collapsed to avoid.
      //
      // Gated on the lifetime counter, not on the live index. The index holds
      // live ids only, so gating on it told a legitimate owner who had just
      // revoked their last channel "not authorized for that space" — a denial
      // that is simply false, on the path they would walk to confirm the
      // revoke worked. The counter never decreases, so "has ever had a
      // channel" survives revocation while leaking no more than before.
      //
      // Two sources, because neither alone covers every channel. The counter
      // only starts moving at this change, so a channel provisioned before it
      // and never re-minted leaves the space reading zero — and its owner would
      // get the denial for a space that demonstrably has one. The live index
      // covers those; the counter covers the ones the index has since dropped.
      ids = await getSpaceRegistrationIndex(
        deps.runtime,
        deps.serviceSpace,
        input.space!,
      );
      const everHadChannels = ids.length > 0 ||
        (await getSpaceLifetimeChannelCount(
            deps.runtime,
            deps.serviceSpace,
            input.space!,
          )) > 0;
      if (!everHadChannels) return forbidden();
      const authority = await authorize(deps, input.space!, callerDid);
      if (!authority.ok) return fromAuthority(authority);
    } else {
      ids = await getOwnerRegistrationIndex(
        deps.runtime,
        deps.serviceSpace,
        callerDid,
      );
    }
  } catch (error) {
    deps.logger?.error({ error, callerDid }, "ingest-channels: list failed");
    return { status: 502, body: { error: "Storage failure" } };
  }

  const channels: ChannelView[] = [];
  for (const id of ids) {
    const r = await getRegistration(deps.runtime, deps.serviceSpace, id);
    if (!r) continue;
    // Unscoped: only rows this caller owns, even if the index were polluted.
    // Scoped: ownership of the SPACE was just proven, so every row belongs.
    if (scoped ? r.space !== input.space : r.owner !== callerDid) continue;
    channels.push({
      ...channelSummary(r),
      lastSeenAt: await getLastSeen(deps.runtime, deps.serviceSpace, id),
    });
  }
  return { status: 200, body: { channels } };
}

/**
 * Load a registration by id and authorize the caller against ITS STORED SPACE.
 *
 * This is the rotate/revoke IDOR invariant, in one place so it cannot drift:
 * registrations are keyed purely by id in the operator's service space, so
 * authorizing against any caller-supplied space while acting on a
 * caller-supplied id would be a one-line confused deputy. A missing
 * registration answers exactly like an unowned one.
 *
 * `addressedSpace` is the space a request was addressed to, for a caller that
 * has one. It narrows and never widens: a channel writing into any other
 * space answers exactly like a missing one, and the authorization is still
 * made against the stored space.
 */
export const loadOwned = async (
  deps: ControlDeps,
  callerDid: string,
  id: string,
  addressedSpace?: string,
): Promise<
  | { ok: true; registration: IngestRegistration }
  | { ok: false; result: ControlResult<never> }
> => {
  // The id becomes a cell cause in the operator's service space, so bound its
  // shape the way every other caller-supplied value here is bounded. A
  // malformed id shares the ownership denial, so this adds no oracle.
  if (!/^ing_[A-Za-z0-9_-]{16,128}$/.test(id)) {
    return { ok: false, result: forbidden() };
  }

  let registration: IngestRegistration | null;
  try {
    registration = await getRegistration(deps.runtime, deps.serviceSpace, id);
  } catch (error) {
    deps.logger?.error({ error, id }, "ingest-channels: lookup failed");
    return {
      ok: false,
      result: { status: 502, body: { error: "Storage failure" } },
    };
  }
  if (!registration) return { ok: false, result: forbidden() };
  // Ahead of the authorization, so that a request addressed to the wrong
  // space reads no access list at all.
  if (addressedSpace !== undefined && registration.space !== addressedSpace) {
    return { ok: false, result: forbidden() };
  }

  const authority = await authorize(deps, registration.space, callerDid);
  if (!authority.ok) return { ok: false, result: fromAuthority(authority) };
  return { ok: true, registration };
};
