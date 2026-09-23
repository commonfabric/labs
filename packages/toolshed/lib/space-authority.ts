// Is a verified caller entitled to act on a space, and can this deployment
// actually deliver if it is?
//
// This is the answer to the `TODO(auth)` in middlewares/first-party-http-auth.ts:
// that middleware authenticates a `did:key` and stops. Everything below turns an
// authenticated principal into an AUTHORIZED one, against the record that already
// governs space access — the space's own ACL document at `of:<space DID>`
// (memory/v2/server.ts `aclDocId`). No new trust root, no new proof format: the
// strength here is inherited from the memory ACL, so it tightens as the platform
// tightens (see docs/features/self-serve-ingest-channels.md).
//
// TWO DIFFERENT QUESTIONS, TWO DELIBERATELY DIFFERENT RESOLUTIONS
//
//   1. "Is the CALLER entitled?" — a security decision. Resolved NARROWLY:
//      `acl[caller] === "OWNER"`, an explicit concrete grant. No wildcard
//      fallback, no `principal === space` branch, no service-DID branch.
//   2. "Can the OPERATOR write?" — a PREDICTION of what the memory server will
//      do, used to fail loudly at mint instead of silently at ingest. Resolved
//      PERMISSIVELY via `spaceReaderRole`, which mirrors the server's own
//      resolution (wildcard fallback and service DIDs included) because here
//      permissive == accurate.
//
// Using the permissive oracle for (1) would be a real vulnerability:
// `spaceReaderRole` resolves `acl[principal] ?? acl["*"]`, so an ACL of
// `{alice:"OWNER","*":"OWNER"}` — reachable via `cf acl set ANYONE OWNER` —
// makes EVERYONE an owner. That is tolerable for the render fit it was written
// for (§4.9.3: over-blocking/over-admitting a value the caller could already
// read) and unacceptable when the consequence is minting durable write
// authority into someone's space.

import {
  type ACL,
  type Capability,
  hasConcreteOwner,
  isACL,
  isCapable,
} from "@commonfabric/memory/acl";
import type { DID, MemorySpace } from "@commonfabric/memory/interface";
import { spaceStorePath } from "@commonfabric/memory/v2/dump";
import { ACLManager, type Runtime } from "@commonfabric/runner";
import { spaceReaderRole } from "@commonfabric/runner/cfc";

/**
 * A space DID, pinned tightly. `isDID` (`@commonfabric/identity/did`) answers
 * only "is this a DID", so it admits newlines, whitespace and case variants
 * after the prefix — and this one string then feeds FOUR consumers that must
 * agree: the hosted-space lookup, the ACL document key, the `\n`-joined
 * channel-id derivation, and the on-disk `<space>.sqlite` filename. On a
 * case-insensitive filesystem two case-variant DIDs open the SAME engine while
 * deriving DIFFERENT channel ids. This is the narrower question, asked here.
 */
const SPACE_DID_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]{20,120}$/;

export const isValidSpaceDid = (space: string): boolean =>
  SPACE_DID_RE.test(space);

/**
 * The narrow entitlement predicate: an explicit, concrete `OWNER` grant to this
 * exact principal. A wildcard entry is never consulted — see the header.
 */
export const isExplicitSpaceOwner = (
  acl: ACL | null | undefined,
  principal: string,
): boolean => {
  if (!isACL(acl)) return false;
  const capability = (acl as Record<string, Capability | undefined>)[principal];
  // `isCapable` rather than `=== "OWNER"`, matching the memory server and
  // `spaceReaderRole`. Identical today; if a rank above OWNER is ever added,
  // the equality form would silently lock every owner out.
  return capability !== undefined && isCapable(capability, "OWNER");
};

/** Why authorization failed. `not-owner` is the catch-all; see `authorizeSpaceOwner`. */
export type SpaceDenialKind =
  | "not-owner"
  | "operator-denied"
  | "operator-cannot-write";

export type SpaceAuthority =
  | { ok: true; acl: ACL }
  | {
    ok: false;
    kind: SpaceDenialKind;

    /** Safe to return to the caller. */
    message: string;

    /** Never returned to the caller — server-side diagnosis only. */
    logDetail: string;
  };

/** Injected so tests (and non-file memory stores) can control host detection. */
export interface SpaceAuthorityDeps {
  runtime: Runtime;
  operatorDid: string;
  serviceDids: readonly string[];

  /** Hosted control-plane ACL read; grants no graph access to the process identity. */
  readAcl?: (space: string) => Promise<unknown>;

  /**
   * The deployment's `MEMORY_ACL_MODE`. Load-bearing for the operator-write
   * PREDICTION only: the memory server short-circuits authorization entirely
   * when this is `off` (`#authorizeMessageWithEngine`), so predicting a denial
   * from the ACL there would refuse a mint whose writes would actually succeed
   * — breaking local dev outright, and silently disabling minting if ops ever
   * rolls back to `observe`. The CALLER entitlement check below is deliberately
   * NOT relaxed by this: a permissive deployment is not a reason to hand out
   * durable write capabilities to non-owners.
   */
  aclMode?: "off" | "observe" | "enforce";

  /** True when this deployment hosts `space`. Defaults to the on-disk store. */
  hostsSpace?: (space: string) => boolean;
}

export const hostsSpaceInStore =
  (storeUrl: URL) => (space: string): boolean => {
    try {
      return spaceStorePath(storeUrl, space) !== null;
    } catch {
      // `spaceStorePath` statSyncs and rethrows anything that is not NotFound
      // (EACCES, EMFILE, …). Left uncaught that turns every control-plane call
      // into a 500; treating it as "not hosted" keeps the endpoint fail-closed
      // and indistinguishable from any other denial.
      return false;
    }
  };

// One message for five states (see below). It has to be simultaneously
// uninformative about WHICH state, and actionable for the legitimate owner who
// is simply signing with the wrong key — by far the most common cause, since a
// passkey shell user's key is not the key their CLI holds. The advice is
// constant across every space and every caller, so it leaks nothing.
export const NOT_OWNER_MESSAGE =
  "Not authorized for that space, or no such space. Minting requires an " +
  "explicit OWNER grant for the identity you are signing with. Check with " +
  '`cf acl ls --space <space>` and `cf id did "$CF_IDENTITY"`. If the space ' +
  "was created by a shell login, its OWNER is that login's key, not your CLI " +
  "keyfile: recover the same identity with `cf id from-mnemonic` (only if you " +
  "hold the recovery phrase) and grant your CLI DID with `cf acl set`. A " +
  "passkey login cannot currently be exported to the CLI at all.";

/** The one denial a writer check returns; see {@link authorizeSpaceWriter}. */
export const NOT_WRITER_MESSAGE =
  "Not authorized to write to that space, or no such space. Check the grant " +
  "for the identity you are signing with: `cf acl ls --space <space>` and " +
  '`cf id did "$CF_IDENTITY"`.';

/**
 * What a writer check returns: admitted, or the denial
 * {@link SpaceAuthority} carries. It hands back no ACL, since a deployment
 * with enforcement off admits without reading one.
 */
export type SpaceWriterAuthority =
  | { ok: true }
  | Extract<SpaceAuthority, { ok: false }>;

/**
 * Authorize `callerDid` to write into `space`: the memory server's own
 * answer for an authored commit, with the wildcard grant and the service
 * principals it honors. A deployment with ACL enforcement off admits every
 * caller the way its memory server does.
 *
 * Like {@link authorizeSpaceOwner}, one denial covers a malformed DID, a
 * space this deployment does not host, an absent or malformed ACL, and a
 * caller without a grant, so the answer is not an existence oracle over
 * the deployment's spaces; the distinguishing detail is logged.
 */
export async function authorizeSpaceWriter(
  deps: SpaceAuthorityDeps,
  space: string,
  callerDid: string,
): Promise<SpaceWriterAuthority> {
  const deny = (logDetail: string): SpaceWriterAuthority => ({
    ok: false,
    kind: "not-owner",
    message: NOT_WRITER_MESSAGE,
    logDetail,
  });
  if (!isValidSpaceDid(space)) return deny("space did failed shape check");
  const hosts = deps.hostsSpace ?? (() => true);
  if (!hosts(space)) return deny("space not hosted by this deployment");
  if (deps.aclMode === "off") return { ok: true };
  let acl: ACL | null;
  try {
    if (deps.readAcl) {
      const value = await deps.readAcl(space);
      if (value === undefined || value === null) acl = null;
      else {
        if (!isACL(value) || !hasConcreteOwner(value)) {
          throw new Error("Stored ACL is malformed or has no concrete OWNER.");
        }
        acl = value;
      }
    } else acl = await new ACLManager(deps.runtime, space as DID).get();
  } catch (error) {
    return deny(`acl malformed or ownerless: ${error}`);
  }
  if (acl === null) return deny("space has no ACL (never initialized)");
  const role = spaceReaderRole(acl, space, callerDid, deps.serviceDids);
  if (role !== "owner" && role !== "writer") {
    return deny(`caller role on ${space} is ${role ?? "none"}, need writer`);
  }
  return { ok: true };
}

/**
 * Authorize `callerDid` to administer ingest channels on `space`, and confirm
 * this deployment could actually write there.
 *
 * WHAT IS DELIBERATELY INDISTINGUISHABLE. `not-owner` covers five states: a
 * malformed space DID, a space this deployment does not host, a space with no
 * ACL, a space whose ACL is malformed/ownerless, and a space where the caller
 * simply is not an owner. Splitting them would hand any keypair holder an
 * existence oracle over the deployment's entire space inventory — and since
 * space DIDs are non-secret and (on some deployments) derivable, that inventory
 * is exactly the metadata worth protecting. Collapsing them costs nothing,
 * because in all five states the sentence "you are not an owner of that space"
 * is literally true, and all five fail closed. The distinguishing detail is
 * always logged.
 *
 * WHAT IS DELIBERATELY DISTINGUISHABLE, AND WHY THAT IS SAFE. `operator-denied`
 * fires when the toolshed operator cannot even READ the target space's ACL, so
 * ownership can never be evaluated — the chicken-and-egg case where withholding
 * the reason would leave a legitimate owner with no diagnostic at all. This is
 * safe because it is a GLOBAL deployment property, not a per-space secret: an
 * operator holding `MEMORY_SERVICE_DIDS` authority has implicit OWNER on every
 * space, so a correctly-configured deployment returns this for NO space and the
 * response is constant. It becomes differential only under per-space operator
 * grants — a configuration this feature explicitly does not recommend, and on
 * which this error is the thing you most need to see.
 */
export async function authorizeSpaceOwner(
  deps: SpaceAuthorityDeps,
  space: string,
  callerDid: string,
): Promise<SpaceAuthority> {
  const deny = (logDetail: string): SpaceAuthority => ({
    ok: false,
    kind: "not-owner",
    message: NOT_OWNER_MESSAGE,
    logDetail,
  });

  if (!isValidSpaceDid(space)) return deny("space did failed shape check");

  // Before ANY replica work. `#providers` (storage/v2.ts) is populated on first
  // access and cleared only on full dispose, and `synced()` is a global barrier
  // across every mounted provider — which `processIngest` awaits three times per
  // POST. Mounting a replica for an arbitrary caller-named space would let
  // unauthenticated-ish create traffic degrade ingest latency for every real
  // beacon, and grow the provider set without bound.
  const hosts = deps.hostsSpace ?? (() => true);
  if (!hosts(space)) return deny("space not hosted by this deployment");

  let acl: ACL | null;
  try {
    acl = await new ACLManager(deps.runtime, space as DID).get();
  } catch (error) {
    // ACLManager throws only on malformed/ownerless. Not attacker-reachable
    // (every ACL write is validated server-side), and fail-closed either way.
    return deny(`acl malformed or ownerless: ${error}`);
  }

  if (acl === null) {
    // `null` is ambiguous BY DESIGN upstream: storageManager.synced() does not
    // throw on an authorization denial ("a denied cross-space link must stay a
    // silent absent read", storage/v2.ts), so a denied read and a never-created
    // ACL both surface as an absent value. authorizationError() is the primitive
    // that separates them — it returns the memory server's own verdict.
    // Optional on IStorageManager (the emulated manager omits it). When it is
    // absent we cannot separate the two cases, so we fall through to the
    // indistinguishable denial — fail closed, never fail open.
    const denial = deps.runtime.storageManager.authorizationError?.(
      space as MemorySpace,
    );
    if (denial) {
      return {
        ok: false,
        kind: "operator-denied",
        message:
          `This deployment's ingest operator (${deps.operatorDid}) is not ` +
          `authorized to read space ${space}, so ownership cannot be verified ` +
          `and ingest could not write there. Add that DID to ` +
          `MEMORY_SERVICE_DIDS, or grant it WRITE on the space.`,
        logDetail: `operator denied on ${space}: ${denial.message}`,
      };
    }
    return deny("space has no ACL (never initialized)");
  }

  if (!isExplicitSpaceOwner(acl, callerDid)) {
    return deny(
      `caller holds ${acl[callerDid as DID] ?? "no"} grant, not OWNER`,
    );
  }

  // The caller has now proven ownership, so deployment detail below is theirs
  // by right. Skipped entirely unless the deployment actually enforces — see
  // `aclMode` above; predicting a denial the server would not make is worse
  // than not predicting at all.
  if ((deps.aclMode ?? "enforce") !== "enforce") return { ok: true, acl };

  // Permissive resolution: this predicts the memory server's own decision.
  const operatorRole = spaceReaderRole(
    acl,
    space,
    deps.operatorDid,
    deps.serviceDids,
  );
  if (operatorRole !== "owner" && operatorRole !== "writer") {
    return {
      ok: false,
      kind: "operator-cannot-write",
      message: `You own ${space}, but this deployment's ingest operator ` +
        `(${deps.operatorDid}) cannot write to it, so the channel would ` +
        `accept POSTs while silently committing nothing. Grant that DID WRITE ` +
        `on the space, or add it to MEMORY_SERVICE_DIDS.`,
      logDetail: `operator role on ${space} is ${
        operatorRole ?? "none"
      }, need writer`,
    };
  }

  return { ok: true, acl };
}
