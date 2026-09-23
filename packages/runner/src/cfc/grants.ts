import {
  type FabricValue,
  hashStringOf,
  isFabricPlainObject,
} from "@commonfabric/data-model";
import { isDID } from "@commonfabric/identity/did";
import type { CfcAtom } from "@commonfabric/api/cfc";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import type { URI } from "@commonfabric/memory/interface";
import { getCommitPreconditionsConfig } from "@commonfabric/memory/v2";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";
import { internalVerifierRead } from "../storage/reactivity-log.ts";
import { type AtomPattern, isAtomPattern } from "./atom-pattern.ts";
import { FORBIDDEN_OR_CLAUSE_ALTERNATIVE_TYPES, isOrClause } from "./clause.ts";
import type {
  CfcGrantResolver,
  CfcGrantResolverQuery,
} from "./exchange-eval.ts";

/**
 * CFC grant records (spec §8.12.7 route 2a; design
 * docs/specs/cfc-persisted-declassification.md §2): durable, revocable
 * release decisions persisted as content-addressed documents at a reserved
 * namespace, written only through the trusted policy-writer path
 * (`IExtendedStorageTransaction.writeCfcGrant`) and consumed at access time
 * by `policyState`-guarded exchange rules. The stored label of the released
 * value never changes — monotonicity is untouched; revocation is the grant's
 * lifecycle (mark revoked / expire); "disjunctions arise at access time"
 * stays true.
 *
 * ## Addressing decision (the design doc's one open point)
 *
 * A grant document's entity id derives deterministically from its RELEASE
 * SCOPE — `{ space, kind, owner, resource }` — hashed under a versioned
 * `cfcGrant` wrapper and carried under the reserved `grant:cfc:` id scheme
 * (the `cid:` schema-doc precedent: a distinct URI scheme IS the reserved
 * namespace, recognizable by the S18-class write gate without any registry):
 *
 *   id = `grant:cfc:` + hashStringOf({ cfcGrant:
 *          { version, space, kind, owner, resource } })
 *
 * Why these four fields and not the full record:
 *
 * - **Point-query-able (§4.9.3 discipline, never enumeration).** A consuming
 *   rule's guard binds `owner` from the label atom its `appliesTo` matched
 *   (a label-carried discovery) and names `kind`/`resource` concretely (or
 *   through already-bound variables), so the resolver can COMPUTE the one
 *   candidate address from `(kind + bound fields)` and point-read it. Fields
 *   that stay free in the guard — the audience being resolved — must
 *   therefore not participate in the address.
 * - **Revocable in place.** `audience`, `expiresAt` and `revoked` live in the
 *   document VALUE, not the address: revoking (or extending) a grant updates
 *   the same document, and consumers stop resolving it on the next
 *   evaluation. Hashing the full record would give a revocation a NEW
 *   address while the old address kept resolving the un-revoked content —
 *   exactly backwards.
 * - **One decision per scope.** Two grants by the same owner over the same
 *   resource under the same kind are the SAME durable decision (audience is
 *   the decision's current extent) — matching the §4.9.3 ACL precedent (one
 *   ACL doc per space whose value maps principals to capabilities; here: one
 *   grant doc per release scope whose value lists the audience).
 * - **Verified on read.** The stored value repeats the identity fields; the
 *   resolver recomputes the address from them and refuses a document that
 *   does not hash to the address it sits at (a forgery/corruption), before
 *   any lifecycle or audience check. Fail closed throughout.
 *
 * The GOVERNING SPACE is the owner's identity space (`space === owner`):
 * only the owner (and their runtime) holds write authority there, so a
 * verified document at the derived address carries the owner's release
 * authority implicitly — the same way the space ACL document is owner-gated
 * by living in the space it governs. Grants hosted in shared spaces (a team
 * space's policy root) need per-document write-attribution verification —
 * future work on its own track: the B2b space-hosted policy-doc plan this
 * was once coupled to is descoped (SC-28: attestation covers deployment
 * config; policy records stay in `RuntimeOptions.cfcPolicyRecords`), which
 * leaves grants as the one space-hosted policy state.
 */

/** Reserved id scheme for grant documents. The whole document is policy
 * state: any unprivileged write at any path under an id with this prefix is
 * recorded and fails closed (S18-class, `noteSystemWrite`). */
export const CFC_GRANT_ID_PREFIX = "grant:cfc:";

/** Version stamped into both the address derivation and the stored value. */
export const CFC_GRANT_VERSION = 1;

/** Digest marker recorded for a consulted candidate address that resolved to
 * no document — binding "we looked and found nothing" into the prepared
 * digest, so a grant appearing between prepare and commit changes it. */
export const CFC_GRANT_ABSENT_DIGEST = "absent";

/** The identity (address-determining) fields of a grant. */
export type CfcGrantIdentity = {
  /** Governing space the document lives in (== `owner` in this PR). */
  readonly space: string;

  /** Grant kind matched by `policyState` guards ("ShareGrant", …). */
  readonly kind: string;

  /** DID whose release authority this grant spends. */
  readonly owner: string;

  /** What it releases: a doc reference (URI string) or an atom-pattern
   * scope record (design §2.1 `Reference | AtomPattern`). */
  readonly resource: AtomPattern;
};

/** A verified grant record (design doc §2.1 shape). */
export type CfcGrant = CfcGrantIdentity & {
  readonly version: typeof CFC_GRANT_VERSION;

  /** Principal-like atoms (§3.1.8-validated) the release extends to. */
  readonly audience: readonly unknown[];

  readonly grantedAt: number;
  readonly expiresAt?: number;

  /** §6 intent attribution once the intent substrate exists. */
  readonly sourceIntentId?: string;

  readonly revoked?: { readonly at: number; readonly by: string };

  /**
   * Single-use release (design §2.2 "Single-use releases", spec §6.5.1-.2):
   * the grant satisfies a `policyState` guard only while its consumption
   * receipt (`cfcGrantConsumedReceiptId`) does not exist, and only in a
   * CONSUMING evaluation context — the releasing transaction claims the
   * receipt atomically with the release. Exactly boolean-true or absent:
   * "standing" has one spelling (absent), validated at write AND on read, so
   * a present-but-false marker can never be read as a third state. Lives in
   * the document VALUE like audience/lifecycle — the address (identity =
   * release scope) is unchanged, so converting a standing grant to
   * single-use is an in-place update of the same durable decision.
   */
  readonly singleUse?: true;
};

/** Authoring input for the trusted policy-writer path. */
export type CfcGrantWriteInput = {
  readonly kind: string;
  readonly owner: string;
  readonly resource: AtomPattern;
  readonly audience: readonly unknown[];

  /** Defaults to `owner` — the v1 governing-space posture (module doc). */
  readonly space?: string;

  /** Defaults to the runner clock at write time. */
  readonly grantedAt?: number;

  readonly expiresAt?: number;
  readonly sourceIntentId?: string;
  readonly revoked?: { readonly at: number; readonly by: string };

  /** See {@link CfcGrant.singleUse}: boolean-true or absent, else refused. */
  readonly singleUse?: true;
};

/** The derived grant-document id for a release scope (module doc). */
export const cfcGrantDocId = (identity: CfcGrantIdentity): URI =>
  `${CFC_GRANT_ID_PREFIX}${
    hashStringOf({
      cfcGrant: {
        version: CFC_GRANT_VERSION,
        space: identity.space,
        kind: identity.kind,
        owner: identity.owner,
        resource: identity.resource,
      },
    })
  }` as URI;

/**
 * The consumption-receipt document id for a single-use grant (design §2.2;
 * spec §6.5.1 `consumedCellId`).
 *
 * ## Derivation decision
 *
 * Spec §6.5.1 derives an intent's consumption cell as
 * `refer({ intentConsumed: { intentOnceId } })`; the runner's shipped event
 * receipts derive theirs as `runtime.getCell(space, { resultFor: cause })` —
 * `createRef` over the cause record, minting an ordinary `of:` entity id.
 * This receipt instead follows the §6.5.1 SHAPE (`{ grantConsumed:
 * { grantId } }`, one receipt per grant id) realized with the #4627 ADDRESS
 * IDIOM (the reserved `grant:cfc:` URI scheme + a versioned `hashStringOf`
 * wrapper, exactly like `cfcGrantDocId`) rather than `createRef`, because:
 *
 * - **The receipt is policy state and must live in the reserved namespace.**
 *   `noteSystemWrite` records ANY unprivileged write at ANY path under a
 *   `grant:cfc:` id as an S18-class violation. An `of:` receipt would sit
 *   outside that gate: forging one is merely fail-closed (a denied live
 *   grant), but unprivileged DELETION/overwrite of a spent receipt would
 *   RE-ARM a consumed single-use grant — fail open. The reserved scheme
 *   covers both directions with the gate that already exists.
 * - **Point-derivable from the grant id alone** (the §4.9.3 discipline): the
 *   resolver computes the one candidate receipt address from the grant it
 *   just verified — no enumeration, no cell machinery, readable under
 *   `internalVerifierRead` like every other policy lookup.
 * - **Same space as the grant**: the receipt is part of the grant's
 *   lifecycle state and rides the owner-space write authority the v1
 *   governing-space posture already establishes (module doc).
 *
 * Enforcement reads PRESENCE only: any document at this address — even a
 * malformed one — means the grant is consumed (a receipt cannot be forged
 * into absence; fail closed). The stored {@link CfcGrantConsumptionReceipt}
 * value is audit content, not the enforcement signal.
 */
export const cfcGrantConsumedReceiptId = (grantId: string): URI =>
  `${CFC_GRANT_ID_PREFIX}${
    hashStringOf({
      cfcGrantConsumed: {
        version: CFC_GRANT_VERSION,
        grantConsumed: { grantId },
      },
    })
  }` as URI;

/** The audit value a consuming release writes at the receipt address. */
export type CfcGrantConsumptionReceipt = {
  readonly version: typeof CFC_GRANT_VERSION;
  readonly grantConsumed: { readonly grantId: string };

  /** Governing space (== the grant's space; the receipt lives beside it). */
  readonly space: string;

  /** Runner clock at claim time — captured once per transaction so repeated
   * prepares of the same tx stage a byte-identical receipt. */
  readonly consumedAt: number;
};

/** One consumption claim staged by boundary evaluation in a transaction. */
type PendingGrantConsumptionClaim = {
  readonly space: string;
  readonly receiptId: URI;
  readonly grantId: string;
  readonly consumedAt: number;
};

/**
 * Pending single-use consumption claims, keyed by transaction and receipt id.
 *
 * Deliberately a module-private WeakMap rather than a field on `CfcTxState`
 * or a method on the transaction interface: a claim staged here is written
 * into the reserved `grant:cfc:` namespace INSIDE the privileged scope by
 * `flushCfcGrantConsumptionClaims` (called from `prepareBoundaryCommit`), so
 * a registration surface reachable from handler code via `(cell.tx as any)`
 * would launder unprivileged receipt forgeries — spending any grant the
 * caller can name — through the runtime's own privileged flush, bypassing
 * the S18 gate that blocks direct writes. Module privacy keeps the ONLY
 * writers the resolver below (which registers a claim exclusively for a
 * verified, live, receipt-absent grant it just resolved in a consuming
 * context) and the flush (which stages exactly what was registered).
 *
 * The registry is PER-TRANSACTION and survives re-prepares on purpose: it is
 * how a re-evaluation recognizes the receipt now sitting in its own journal
 * as "claimed by this transaction" (the same consumption, not a competing
 * one) — see the own-claim arm in the resolver.
 */
const pendingGrantConsumptionClaims = new WeakMap<
  IExtendedStorageTransaction,
  Map<string, PendingGrantConsumptionClaim>
>();

const claimsFor = (
  tx: IExtendedStorageTransaction,
): Map<string, PendingGrantConsumptionClaim> => {
  let claims = pendingGrantConsumptionClaims.get(tx);
  if (claims === undefined) {
    claims = new Map();
    pendingGrantConsumptionClaims.set(tx, claims);
  }
  return claims;
};

/**
 * Receipts are available only when the exactly-once substrate is on: the
 * ambient `experimental.commitPreconditions` flag (set by the Runtime at
 * construction) gates whether the storage commit EMITS entity-absent
 * preconditions at all — without it a `markCreateOnly` mark is silently
 * dropped at commit and the create-only race protection vanishes, so a
 * single-use grant MUST be unsatisfiable everywhere (never silently
 * multi-use, design §2.2 / spec §6.5.2 fail-closed posture).
 */
const cfcGrantReceiptsAvailable = (): boolean =>
  getCommitPreconditionsConfig() === true;

/**
 * Stages every consumption claim this transaction's boundary evaluation
 * registered: writes the receipt document and marks it create-only, so
 * consumption commits ATOMICALLY with the release it justifies —
 * no-consume-on-failure (spec §6.5.2) holds because the receipt write rides
 * the same transaction as the released write/egress decision, and a racing
 * second release loses the create-only race (`receipt-exists`, a permanent
 * rejection the scheduler never retries).
 *
 * Called at the END of `prepareBoundaryCommit` — inside the privileged
 * system-write scope `prepareCfc` wraps it in, after every gate has run (so
 * all resolutions are registered) — and idempotent across re-prepares (the
 * re-write is byte-identical; the create-only mark is a set). Returns
 * fail-closed reasons for claims that could not be staged (a read-only
 * transaction, a receipt space outside this transaction's write space —
 * cross-space consumption arrives with B2b): an unstageable claim means the
 * release's exactly-once witness cannot commit, so the release must not.
 */
export const flushCfcGrantConsumptionClaims = (
  tx: IExtendedStorageTransaction,
): string[] => {
  const claims = pendingGrantConsumptionClaims.get(tx);
  if (claims === undefined || claims.size === 0) return [];
  const reasons: string[] = [];
  for (const claim of claims.values()) {
    try {
      // The exactly-once witness FIRST: without the mark two racing releases
      // would both commit (last write wins on the receipt document), so the
      // optional method is a hard requirement — fail closed if absent — and
      // marking before writing means a refused mark (unsupported storage,
      // cross-space write isolation, read-only) never leaves an unguarded
      // receipt value in the journal.
      if (typeof tx.markCreateOnly !== "function") {
        throw new Error("storage transaction does not support markCreateOnly");
      }
      tx.markCreateOnly({
        space: claim.space as MemorySpace,
        id: claim.receiptId,
      });
      const receipt: CfcGrantConsumptionReceipt = {
        version: CFC_GRANT_VERSION,
        grantConsumed: { grantId: claim.grantId },
        space: claim.space,
        consumedAt: claim.consumedAt,
      };
      tx.writeOrThrow({
        space: claim.space as MemorySpace,
        id: claim.receiptId,
        type: "application/json",
        path: ["value"],
      }, receipt);
    } catch (error) {
      reasons.push(
        `cfc-grant: staging consumption receipt for single-use grant ` +
          `${claim.grantId} failed (${
            error instanceof Error ? error.message : String(error)
          })`,
      );
    }
  }
  return reasons;
};

// `var` is the atom-pattern placeholder key (atom-pattern.ts reserved-key
// discipline). An audience entry carrying one anywhere would interact with
// pattern matching when the entry later lands in a clause — refuse at write.
const containsVarKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsVarKey);
  if (!isObjectOrArray(value)) return false;
  if (Object.hasOwn(value, "var")) return true;
  return Object.values(value).some(containsVarKey);
};

/**
 * §3.1.8 principal-like validation for one audience entry — the same
 * discipline `disallowedAuthoredClauseReason` applies to authored OR-clause
 * alternatives (a grant audience entry IS a future clause alternative, added
 * by the consuming rule's postcondition). Returns a reason, or undefined
 * when the entry is admissible.
 */
export const disallowedGrantAudienceEntryReason = (
  entry: unknown,
): string | undefined => {
  if (!isObjectNotArray(entry)) {
    return "audience entries must be principal-like atom records";
  }
  if (isOrClause(entry)) {
    return "audience entries must be atoms, not anyOf clauses";
  }
  if (containsVarKey(entry)) {
    return "audience entries must not carry pattern placeholders (var)";
  }
  const type = (entry as { type?: unknown }).type;
  if (typeof type !== "string" || type.length === 0) {
    return "audience entries need a string type";
  }
  if (FORBIDDEN_OR_CLAUSE_ALTERNATIVE_TYPES.has(type)) {
    return `audience entries of type ${type} are not permitted ` +
      `(spec §3.1.8: alternatives must be principal-like; ` +
      `Expires/Caveat forbidden as alternatives)`;
  }
  return undefined;
};

/**
 * Validates a grant-write input into the exact document value + derived
 * address, throwing on any violation (the trusted policy-writer is
 * fail-closed config-style: a refused grant is an error the caller must
 * see, never a silently skipped write).
 *
 * Release-authority check for THIS PR: `owner` must equal the transaction's
 * acting principal (from the trust snapshot) — an owner grants only their own
 * authority, and a revocation must be attributed to that same principal. The
 * fuller §13.4.3 evidence chain (rendered-state match, trusted share surface,
 * intent consumption) strengthens this when the §6 intent substrate lands.
 */
export const prepareCfcGrantWrite = (
  input: CfcGrantWriteInput,
  actingPrincipal: string | undefined,
  now: number = Date.now(),
): { space: MemorySpace; id: URI; value: CfcGrant } => {
  if (!isObjectNotArray(input)) {
    throw new Error("cfc-grant: write input must be an object");
  }
  const { kind, owner, resource, audience } = input;
  if (typeof kind !== "string" || kind.length === 0) {
    throw new Error("cfc-grant: kind must be a non-empty string");
  }
  if (!isDID(owner)) {
    throw new Error("cfc-grant: owner must be a DID");
  }
  if (!isDID(actingPrincipal) || owner !== actingPrincipal) {
    throw new Error(
      "cfc-grant: owner must equal the transaction's acting principal " +
        "(release authority; §13.4.3 verification list, intent evidence " +
        "deferred)",
    );
  }
  const space = input.space ?? owner;
  if (space !== owner) {
    // v1 governing-space posture (module doc): grants live in the owner's
    // identity space. Shared-space grant roots need per-document
    // write-attribution verification (future work; no longer coupled to the
    // descoped B2b policy-doc storage — SC-28).
    throw new Error(
      "cfc-grant: space must equal owner (grants live in the owner's " +
        "identity space; shared-space grant roots are future work)",
    );
  }
  if (
    resource === undefined || resource === null ||
    (typeof resource === "string" && resource.length === 0)
  ) {
    throw new Error("cfc-grant: resource must name what the grant releases");
  }
  if (!isAtomPattern(resource)) {
    throw new Error("cfc-grant: resource must be a `FabricValue`");
  }
  if (!Array.isArray(audience) || audience.length === 0) {
    throw new Error("cfc-grant: audience must be a non-empty array");
  }
  for (const entry of audience) {
    const reason = disallowedGrantAudienceEntryReason(entry);
    if (reason !== undefined) {
      throw new Error(`cfc-grant: ${reason}`);
    }
  }
  const grantedAt = input.grantedAt ?? now;
  if (typeof grantedAt !== "number" || !Number.isFinite(grantedAt)) {
    throw new Error("cfc-grant: grantedAt must be a finite number");
  }
  if (
    input.expiresAt !== undefined &&
    (typeof input.expiresAt !== "number" || !Number.isFinite(input.expiresAt))
  ) {
    throw new Error("cfc-grant: expiresAt must be a finite number");
  }
  if (
    input.sourceIntentId !== undefined &&
    typeof input.sourceIntentId !== "string"
  ) {
    throw new Error("cfc-grant: sourceIntentId must be a string");
  }
  if (input.revoked !== undefined) {
    const revoked = input.revoked;
    if (
      !isObjectOrArray(revoked) || typeof revoked.at !== "number" ||
      !Number.isFinite(revoked.at) || !isDID(revoked.by)
    ) {
      throw new Error("cfc-grant: revoked must be { at: number, by: DID }");
    }
    if (revoked.by !== actingPrincipal) {
      throw new Error(
        "cfc-grant: revoked.by must equal the transaction's acting principal",
      );
    }
  }
  if (input.singleUse !== undefined && input.singleUse !== true) {
    // Exactly boolean-true or absent (CfcGrant.singleUse): a `false`/truthy
    // spelling is refused so "standing" keeps its single spelling and no
    // consumer can ever read a present-but-non-true marker as a third state.
    throw new Error(
      "cfc-grant: singleUse must be boolean true or absent",
    );
  }
  const value: CfcGrant = {
    version: CFC_GRANT_VERSION,
    space,
    kind,
    owner,
    resource,
    audience: [...audience],
    grantedAt,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.sourceIntentId !== undefined
      ? { sourceIntentId: input.sourceIntentId }
      : {}),
    ...(input.revoked !== undefined
      ? { revoked: { at: input.revoked.at, by: input.revoked.by } }
      : {}),
    ...(input.singleUse === true ? { singleUse: true as const } : {}),
  };
  return {
    space: space as MemorySpace,
    id: cfcGrantDocId(value),
    value,
  };
};

/**
 * Verify-on-read (the grants storage discipline): a stored value is a grant only if
 * it is shape-valid AND its identity fields re-derive the exact address it
 * was read from AND its audience passes the §3.1.8 principal-like validation
 * (defense in depth — a document written by a client that skipped the write
 * gate must still not resolve). Anything else → `undefined`, fail closed.
 */
export const verifyCfcGrantDocument = (
  space: string,
  id: string,
  value: FabricValue,
): CfcGrant | undefined => {
  if (!isFabricPlainObject(value)) return undefined;
  const candidate = value as Partial<CfcGrant> & Record<string, unknown>;
  if (candidate.version !== CFC_GRANT_VERSION) return undefined;
  if (
    typeof candidate.kind !== "string" || !isDID(candidate.owner) ||
    typeof candidate.space !== "string" || candidate.space !== space
  ) {
    return undefined;
  }
  if (!Array.isArray(candidate.audience) || candidate.audience.length === 0) {
    return undefined;
  }
  if (
    candidate.audience.some((entry) =>
      disallowedGrantAudienceEntryReason(entry) !== undefined
    )
  ) {
    return undefined;
  }
  if (
    typeof candidate.grantedAt !== "number" ||
    !Number.isFinite(candidate.grantedAt)
  ) {
    return undefined;
  }
  if (
    candidate.expiresAt !== undefined &&
    typeof candidate.expiresAt !== "number"
  ) {
    return undefined;
  }
  if (candidate.revoked !== undefined) {
    const revoked = candidate.revoked;
    if (
      !isObjectOrArray(revoked) || typeof revoked.at !== "number" ||
      !isDID((revoked as { by?: unknown }).by)
    ) {
      return undefined;
    }
  }
  // Boolean-true or absent (CfcGrant.singleUse) — defense in depth against a
  // document written past the writer gate: a malformed marker must fail the
  // WHOLE grant closed, never degrade to standing (silently multi-use).
  if (candidate.singleUse !== undefined && candidate.singleUse !== true) {
    return undefined;
  }
  // The content-address check: identity fields must re-derive the address.
  if (
    cfcGrantDocId({
      space: candidate.space,
      kind: candidate.kind,
      owner: candidate.owner,
      resource: candidate.resource,
    }) !== id
  ) {
    return undefined;
  }
  return candidate as CfcGrant;
};

/** Unrevoked and unexpired at `now` (revocation/expiry honored at
 * RESOLUTION — spec §8.12.7 2a: "revocation is the grant's lifecycle"). */
export const cfcGrantIsLive = (grant: CfcGrant, now: number): boolean =>
  grant.revoked === undefined &&
  (grant.expiresAt === undefined || now < grant.expiresAt);

/**
 * Expands a verified live grant into its match-pool FACTS: one record per
 * audience entry, carrying the grant's scalar fields plus that single entry
 * under `audience`. `policyState` guard patterns match these facts (subset
 * field semantics), so a guard binding `audience: {var: "$recipient"}` (or a
 * nested `{type: User, subject: {var}}` pattern) enumerates the §4.3.4
 * disjunction of all audience matches — one rule firing per released
 * principal. Fact order follows the stored audience array (content-
 * determined, deterministic).
 */
export const expandCfcGrantFacts = (grant: CfcGrant): readonly CfcAtom[] =>
  grant.audience.map((entry) => ({
    kind: grant.kind,
    space: grant.space,
    owner: grant.owner,
    resource: grant.resource,
    audience: entry,
    grantedAt: grant.grantedAt,
    ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}),
    ...(grant.sourceIntentId !== undefined
      ? { sourceIntentId: grant.sourceIntentId }
      : {}),
    // Conditional spread keeps standing-grant facts byte-identical to #4627;
    // a guard pattern MAY bind on `singleUse: true` if a rule wants to scope
    // itself to single-use releases.
    ...(grant.singleUse === true ? { singleUse: true as const } : {}),
  } as CfcAtom));

const INTERNAL_VERIFIER_META = { ...internalVerifierRead };

/**
 * Resolves a verified, live, SINGLE-USE grant (design §2.2; spec §6.5.1-.2):
 * facts only in a consuming context, with receipts available, while the
 * consumption receipt does not exist — and registers the atomic claim.
 *
 * - **Observing context → unsatisfiable.** A single-use grant consumed by a
 *   read-path evaluation (render ceiling, observe-dial diagnostics) would be
 *   spent by looking at it; and resolving WITHOUT consuming there would make
 *   "single use" advisory. So it resolves ONLY where resolution is
 *   atomically coupled to the receipt claim — the consuming boundary gates.
 *   (Consequence, stated for the observe dial: its diagnostics never show a
 *   would-be single-use release, because observe decides on the raw label
 *   and must not spend the grant.)
 * - **Receipts unavailable → unsatisfiable everywhere** (never silently
 *   multi-use): see `cfcGrantReceiptsAvailable`.
 * - **Receipt present → does not resolve** (guard unsatisfied, fail closed,
 *   exactly like revoked/expired). PRESENCE is the signal — malformed
 *   content still counts as consumed. The receipt's resolution-time state
 *   joins `consultedGrants` (present → content digest, absent →
 *   `CFC_GRANT_ABSENT_DIGEST`), so it binds into the prepared digest with
 *   the same invalidation discipline as the grant itself.
 * - **Own claim → resolves.** The registry remembers receipts THIS
 *   transaction claimed, so a re-prepare that finds its own staged receipt
 *   in the journal recognizes the same consumption instead of failing
 *   itself. If another release committed a receipt in between, this
 *   transaction's create-only mark still dies at commit (`receipt-exists`)
 *   — the race backstop makes the shortcut safe.
 *
 * Consumption attaches at RESOLUTION: the grant's facts entered the
 * decision basis of a consuming gate. Whether a specific rule firing then
 * used them — or changed the final decision — is not reconstructable at
 * staging time, and erring toward consumption is the fail-closed direction
 * (a spent grant releases nothing; an unspent-but-used grant would be a
 * replay). A resolved-but-rejected commit still consumes nothing: the
 * receipt rides the rejected transaction.
 */
const resolveSingleUseGrant = (
  tx: IExtendedStorageTransaction,
  grant: CfcGrant,
  grantId: URI,
  consumption: CfcGrantResolverQuery["consumption"],
  now: () => number,
): readonly CfcAtom[] => {
  if (consumption !== "consuming") return [];
  if (!cfcGrantReceiptsAvailable()) {
    tx.noteCfcDiagnostic(
      `cfc-grant: single-use grant ${grantId} requires ` +
        `experimental.commitPreconditions (receipts unavailable; fail closed)`,
    );
    return [];
  }
  const receiptId = cfcGrantConsumedReceiptId(grantId);
  const claims = claimsFor(tx);
  const own = claims.get(receiptId);
  if (own === undefined) {
    // Read the document ROOT, not the ["value"] subpath: presence of the
    // receipt DOCUMENT is the consumption signal, and a Memory v2 document
    // can exist with no value (a metadata-only write). A value-subpath read
    // would report `undefined` for such a document and re-arm the grant at
    // evaluation time (cubic P1 on #4649) — the create-only backstop would
    // still kill the release at commit (any prior set on the entity fails
    // the entity-absent precondition), but resolution must already fail
    // closed. Grant documents keep their ["value"] reads: there ABSENCE is
    // the fail-closed direction (a value-less grant doc must not resolve).
    const receiptDoc = tx.readOrThrow({
      space: grant.space as MemorySpace,
      id: receiptId,
      type: "application/json",
      path: [],
    }, { meta: INTERNAL_VERIFIER_META });
    tx.recordCfcConsultedGrant({
      space: grant.space as MemorySpace,
      id: receiptId,
      digest: receiptDoc === undefined
        ? CFC_GRANT_ABSENT_DIGEST
        : hashStringOf(receiptDoc),
    });
    if (receiptDoc !== undefined) {
      // Consumed (or unreadable garbage at the receipt address — same
      // outcome): the durable decision was already spent.
      return [];
    }
    claims.set(receiptId, {
      space: grant.space,
      receiptId,
      grantId,
      consumedAt: now(),
    });
  } else {
    // Re-evaluation within the claiming transaction: the durable state the
    // decision consumes is still "receipt absent" (our own staged write is
    // not durable), so re-record exactly that — the recorder dedups it.
    tx.recordCfcConsultedGrant({
      space: grant.space as MemorySpace,
      id: receiptId,
      digest: CFC_GRANT_ABSENT_DIGEST,
    });
  }
  return expandCfcGrantFacts(grant);
};

/**
 * The runner-side grant resolver for boundary evaluation sites that hold a
 * transaction (the sink egress gate and the input-requirement gate in
 * prepare.ts). All I/O lives here — the evaluator stays pure:
 *
 * - Candidate address: computed from `(kind + bound fields)` — `owner` (a
 *   bound DID) fixes the governing space (module doc), `resource` completes
 *   the release scope. A query with either unresolved returns nothing: the
 *   guard's variables must be bound from the label under evaluation (the
 *   §4.9.3 label-carried discovery), never enumerated. Rules that leave
 *   `resource` free (the §13.4.4 shape at a site that binds it from the
 *   evaluation context) arrive with the share-UI build-order item.
 * - Point read at the derived address, under `internalVerifierRead` metadata
 *   (the `readStoredCfcMetadata` idiom) so grant lookups never enter the
 *   consumed set or PC (design §2.3 soundness condition 2).
 * - Every consulted candidate — present or absent — is recorded with its
 *   content digest into the transaction's CFC state; B5-style digest binding
 *   (`PreparedDigestInput.consultedGrants`) invalidates a prepared decision
 *   whose grant inputs drift (design §2.3 soundness condition 3).
 * - Verification, then lifecycle: absent, malformed, address-mismatched,
 *   revoked, or expired grants resolve nothing (fail closed).
 * - Per-query memo: the transaction reads from a stable snapshot, so a
 *   fixpoint pass re-querying the same guard resolves identically; the memo
 *   keeps repeated evaluation cheap and the consulted-set recording
 *   once-per-candidate.
 *
 * The clock defaults to the runner's wall clock (`Date.now`, the builtin
 * idiom) — injected here, NEVER read inside the pure evaluator.
 */
export const createTxCfcGrantResolver = (
  tx: IExtendedStorageTransaction,
  opts: {
    readonly now?: () => number;

    /**
     * Out-record set when a grant lookup could not be READ (the catch arm
     * below) — as opposed to resolving to no facts. A boundary decision that
     * consults this resolver is only a deterministic verdict when no lookup
     * was unavailable: an unsynced grant might discharge on the attempt that
     * syncs it, so the caller reads this to withhold the terminal tag.
     */
    readonly availability?: { unavailable: boolean };
  } = {},
): CfcGrantResolver => {
  const now = opts.now ?? Date.now;
  const memo = new Map<string, readonly CfcAtom[]>();
  return (query: CfcGrantResolverQuery): readonly CfcAtom[] => {
    const owner = query.fields.owner;
    const resource = query.fields.resource;
    if (!isDID(owner) || resource === undefined || resource === null) {
      return [];
    }
    // v1 governing space == owner's identity space (module doc). An explicit
    // bound `space` field must agree; anything else fails closed.
    const space = query.fields.space ?? owner;
    if (space !== owner) return [];
    let facts: readonly CfcAtom[] = [];
    try {
      // Inside the catch so a bound field the hasher cannot digest fails the
      // GUARD closed rather than throwing out of the resolver (the
      // evaluator's own catch is the backstop, but the resolver stays
      // self-contained — cubic P2 on #4627).
      const id = cfcGrantDocId({ space, kind: query.kind, owner, resource });
      // Consumption context in the key: a single-use grant resolves in a
      // consuming query but not an observing one, so a mixed-context resolver
      // (hand-built; the prepare gates are single-context per instance) must
      // never serve a consuming resolution to an observing query.
      const memoKey = `${space}\0${id}\0${
        query.consumption === "consuming" ? "consuming" : "observing"
      }`;
      const memoized = memo.get(memoKey);
      if (memoized !== undefined) return memoized;
      const value = tx.readOrThrow({
        space: space as MemorySpace,
        id,
        type: "application/json",
        path: ["value"],
      }, { meta: INTERNAL_VERIFIER_META });
      tx.recordCfcConsultedGrant({
        space: space as MemorySpace,
        id,
        digest: value === undefined
          ? CFC_GRANT_ABSENT_DIGEST
          : hashStringOf(value),
      });
      if (value !== undefined) {
        const grant = verifyCfcGrantDocument(space, id, value);
        if (grant === undefined) {
          tx.noteCfcDiagnostic(
            `cfc-grant: malformed grant document at ${id} (fail closed)`,
          );
        } else if (cfcGrantIsLive(grant, now())) {
          facts = grant.singleUse === true
            ? resolveSingleUseGrant(tx, grant, id, query.consumption, now)
            : expandCfcGrantFacts(grant);
        }
      }
      memo.set(memoKey, facts);
    } catch {
      // Fail closed on derivation/read errors (undigestable bound field,
      // unsynced replica, storage failure): the grant does not resolve; the
      // §4.9.3 posture. Nothing is memoized or recorded on this path — a
      // candidate that could not be read never produced a value this
      // decision could have consumed. Reported as UNAVAILABLE rather than
      // absent, conservatively covering the deterministic arms too (an
      // undigestable bound field refuses identically every time): the cost
      // of over-reporting is a bounded retry, the cost of under-reporting is
      // a write that never lands.
      if (opts.availability !== undefined) opts.availability.unavailable = true;
      return [];
    }
    return facts;
  };
};
