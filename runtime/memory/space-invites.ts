/** Versioned credentials, links, and wire contracts for space invitations. */
import { hashStringOf } from "@commonfabric/data-model";
import { type DIDKey, isDIDKey } from "@commonfabric/identity/did";
import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/bytes/base64url";
import { isLoopbackHostname } from "@commonfabric/platform/loopback";
import type { Capability } from "./acl.ts";

/**
 * The admission capabilities an invitation can grant, weakest first.
 *
 * OWNER was added after version one shipped with READ and WRITE. The link
 * format and the redemption request did not change, because neither carries
 * the access: it is fixed in the issuer's signed create request and stored in
 * the service's invitation row. A service that predates OWNER refuses an
 * OWNER create with `invalid-request` and never holds an OWNER row, so no
 * version pairing turns an OWNER request into a lesser grant. Clients read
 * `SPACE_INVITE_CAPABILITY.access` from `/api/space-invites` to learn whether
 * a service issues OWNER invitations; a response without the field predates
 * them.
 */
export const INVITE_ACCESS = ["READ", "WRITE", "OWNER"] as const;

/**
 * Host limits for version one of the invitation protocol.
 *
 * `suggestedProfile` bounds the profile an issuer may suggest for the person
 * an invitation is for (see {@link InviteProfileSuggestion}). It was added
 * after version one shipped, as OWNER was: a service whose response lacks the
 * field refuses a create carrying a suggestion with `invalid-request`, since
 * both transports refuse unknown fields, so a client reads the field before it
 * offers a suggestion.
 *
 * `preview` bounds the names an issuer may give an invitation for the person
 * opening it to read before they redeem it (see {@link InvitePreview}). It was
 * added after version one shipped, as `suggestedProfile` was: a service whose
 * response lacks the field refuses a create carrying `spaceName` or
 * `issuerName` with `invalid-request`, and has no `preview` operation, so a
 * client reads the field before it sends either.
 */
export const SPACE_INVITE_CAPABILITY = {
  version: 1,
  maxUses: 1000,
  maxTtlSeconds: 30 * 24 * 60 * 60,
  access: INVITE_ACCESS,
  suggestedProfile: { maxNameLength: 128, maxPictureBytes: 64 * 1024 },
  preview: { maxNameLength: 128 },
} as const;

/**
 * The admission capability an invitation can grant. An invitation grants at
 * most its issuer's own access; since only an explicit OWNER may issue one,
 * that bound admits every value here, and redemption also requires the issuer
 * to still be an explicit OWNER.
 */
export type InviteAccess = typeof INVITE_ACCESS[number];

/** Whether a value is an access an invitation can grant. */
export function isInviteAccess(value: unknown): value is InviteAccess {
  return (INVITE_ACCESS as readonly unknown[]).includes(value);
}

/**
 * The profile an issuer suggests for the one person an invitation is for: the
 * name, and optionally the picture, the issuer knows them by. The person who
 * redeems the invitation is offered it when they make their first profile, and
 * keeps, edits, or drops it; nothing applies it on their behalf.
 *
 * `name` is a well-formed string of between 1 and
 * `SPACE_INVITE_CAPABILITY.suggestedProfile.maxNameLength` UTF-16 code units,
 * with no leading or trailing whitespace and no control character, so that
 * the service stores exactly the name it was given. `picture` is the bytes the
 * issuer offers as the person's picture, at most `maxPictureBytes` of them, in
 * unpadded base64url; the service holds them without inspecting them, as a
 * profile's own picture is held.
 */
export type InviteProfileSuggestion = {
  name: string;
  picture?: string;
};

/** Whether a value is a well-formed {@link InviteProfileSuggestion}. */
export function isInviteProfileSuggestion(
  value: unknown,
): value is InviteProfileSuggestion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const { maxNameLength, maxPictureBytes } =
    SPACE_INVITE_CAPABILITY.suggestedProfile;
  const { name, picture, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length !== 0) return false;
  if (!isInviteName(name, maxNameLength)) return false;
  if (picture === undefined) return true;
  if (typeof picture !== "string" || !/^[A-Za-z0-9_-]+$/.test(picture)) {
    return false;
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64url(picture);
  } catch {
    return false;
  }
  return bytes.length > 0 && bytes.length <= maxPictureBytes &&
    toUnpaddedBase64url(bytes) === picture;
}

/**
 * Whether `value` is a name the service stores exactly as it was given: a
 * well-formed string of between 1 and `maxLength` UTF-16 code units, with no
 * leading or trailing whitespace and no control character.
 */
export function isInviteName(
  value: unknown,
  maxLength: number,
): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maxLength && value.isWellFormed() &&
    value.trim() === value && !/\p{Cc}/u.test(value);
}

/**
 * Whether `value` is a well-formed `spaceName` or `issuerName`: a name of at
 * most `SPACE_INVITE_CAPABILITY.preview.maxNameLength` UTF-16 code units, as
 * {@link isInviteName} judges it.
 */
export function isInvitePreviewName(value: unknown): value is string {
  return isInviteName(value, SPACE_INVITE_CAPABILITY.preview.maxNameLength);
}

/**
 * Issuance parameters, signed by a current explicit space owner. An
 * invitation that carries a `suggestedProfile` is for one person, so its
 * `maxUses` is 1. `spaceName` and `issuerName` are the names the issuer gives
 * the space and themself for the person opening the invitation to read before
 * they redeem it (see {@link InvitePreview}); any invitation may carry them.
 */
export type CreateInvite = {
  inviteId: string;
  codeVerifier: string;
  ttlSeconds: number;
  access: InviteAccess;
  maxUses?: number;
  suggestedProfile?: InviteProfileSuggestion;
  spaceName?: string;
  issuerName?: string;
};

/**
 * What the person holding an invitation's code may read before redeeming it:
 * the access it grants, the names its issuer gave the space and themself, and
 * the profile its issuer suggests for them, each while the service holds it.
 * The names are the issuer's claims, as the suggestion is; the service checks
 * only their form. A preview consumes no use and grants nothing.
 */
export type InvitePreview = {
  access: InviteAccess;
  spaceName?: string;
  issuerName?: string;
  suggestedProfile?: InviteProfileSuggestion;
};

/** Public, owner-visible metadata while an invitation remains active. */
export type InviteMetadata = {
  inviteId: string;
  issuedBy: string;
  createdAt: number;
  expiresAt: number;
  access: InviteAccess;
  maxUses: number;
  usedCount: number;
  remainingUses: number;
};

/** The only durable redemption history. */
export type InviteRedemption = {
  inviteId: string;
  did: string;
};

/**
 * A successful admission decision and current ACL observation, with the
 * profile the issuer suggested for the redeemer, when the invitation carries
 * one and the service still holds it.
 */
export type RedeemReceipt = {
  outcome: "redeemed" | "already-redeemed";
  redemption: InviteRedemption;
  currentAccess: Capability | null;
  suggestedProfile?: InviteProfileSuggestion;
};

/**
 * The non-secret destination and fragment secret in an invitation link.
 *
 * `inviter` is a display hint naming who issued the invitation. Anyone who
 * holds the link can change it, it is not bound into the code verifier, and it
 * is checked only syntactically here. A recipient cannot read the space ACL
 * before redeeming, and after redeeming an ACL check can show at most that the
 * DID is an owner (the issuer must still own the space at first redemption),
 * not that it issued this link (the issuer, `issuedBy`, is visible only to
 * owners). Treat it as a hint bounded by that access check.
 */
export interface InviteLink {
  host: string;
  space: string;
  inviteId: string;
  code: string;
  inviter?: string;
}

/** Structured protocol refusals, without private invite metadata. */
export class SpaceInviteError extends Error {
  #code: string;

  /** Creates a refusal identified by a stable machine-readable code. */
  constructor(code: string) {
    super(code);
    this.#code = code;
  }

  /** Stable refusal code. */
  get code(): string {
    return this.#code;
  }
}

/** Canonical secure service origin, allowing loopback HTTP for development. */
export function normalizeInviteHost(host: string): string {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new SpaceInviteError("invalid-host");
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (
    url.username || url.password || url.pathname !== "/" || url.search ||
    url.hash ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  ) {
    throw new SpaceInviteError("invalid-host");
  }
  return url.origin;
}

/** Whether a value is the canonical unpadded encoding of exactly 32 bytes. */
export function isInviteSecret(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return false;
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64url(value);
  } catch {
    // Text with nonzero bits past its last whole byte, which no encoder writes.
    return false;
  }
  return bytes.length === 32 && toUnpaddedBase64url(bytes) === value;
}

/** Whether an invite ID is bounded, opaque, and safe as a protocol identifier. */
export function isInviteId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{22,64}$/.test(value);
}

/**
 * Whether a space or inviter has the DID key encoding accepted by invite
 * routes. The check is syntactic only.
 */
function isInviteDIDKey(value: unknown): value is DIDKey {
  return isDIDKey(value) &&
    /^did:key:z[1-9A-HJ-NP-Za-km-z]{20,120}$/.test(value);
}

/**
 * Generates independent opaque credentials using the platform RNG. The invite
 * ID begins with a letter, so a command line never reads it as an option.
 */
export function createInviteCredentials(): { inviteId: string; code: string } {
  const id = crypto.getRandomValues(new Uint8Array(16));
  // A first byte below 0x80 encodes as a first character in A-Z or a-f.
  id[0] &= 0x7f;
  return {
    inviteId: toUnpaddedBase64url(id),
    code: toUnpaddedBase64url(crypto.getRandomValues(new Uint8Array(32))),
  };
}

/** Hashes a code with a versioned host, space, and invite-ID binding. */
export function inviteCodeVerifier(link: InviteLink): string {
  const host = normalizeInviteHost(link.host);
  if (
    !isInviteDIDKey(link.space) || !isInviteId(link.inviteId) ||
    !isInviteSecret(link.code)
  ) {
    throw new SpaceInviteError("invalid-request");
  }
  return hashStringOf([
    "commonfabric-space-invite-v1",
    host,
    link.space,
    link.inviteId,
    link.code,
  ]);
}

/**
 * Builds a join link whose secret is carried only in its fragment:
 * `/join?host&space&invite[&inviter]#code`. The optional `inviter` is an
 * unverified claim; see {@link InviteLink}.
 */
export function buildInviteLink(shell: string, invite: InviteLink): URL {
  inviteCodeVerifier(invite);
  if (invite.inviter !== undefined && !isInviteDIDKey(invite.inviter)) {
    throw new SpaceInviteError("invalid-request");
  }
  const url = new URL("/join", normalizeInviteHost(shell));
  url.search = new URLSearchParams({
    host: normalizeInviteHost(invite.host),
    space: invite.space,
    invite: invite.inviteId,
    ...(invite.inviter === undefined ? {} : { inviter: invite.inviter }),
  }).toString();
  url.hash = new URLSearchParams({ code: invite.code }).toString();
  return url;
}

/**
 * Parses a join link; unrelated routes return undefined, malformed joins throw
 * secret-free errors. A returned `inviter` is the link's unverified claim; see
 * {@link InviteLink}.
 */
export function parseInviteLink(
  link: string | URL,
): (InviteLink & { space: DIDKey; inviter?: DIDKey }) | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new SpaceInviteError("invalid-link");
  }
  if (url.pathname !== "/join") return undefined;
  normalizeInviteHost(url.origin);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (
    url.username || url.password || url.pathname !== "/join" ||
    !["host,invite,space", "host,invite,inviter,space"].includes(
      [...url.searchParams.keys()].sort().join(","),
    ) ||
    [...fragment.keys()].join(",") !== "code"
  ) throw new SpaceInviteError("invalid-link");
  const space = url.searchParams.get("space");
  if (!isInviteDIDKey(space)) throw new SpaceInviteError("invalid-link");
  const inviter = url.searchParams.get("inviter");
  if (inviter !== null && !isInviteDIDKey(inviter)) {
    throw new SpaceInviteError("invalid-link");
  }
  const invite = {
    host: normalizeInviteHost(url.searchParams.get("host")!),
    space,
    inviteId: url.searchParams.get("invite")!,
    code: fragment.get("code")!,
    ...(inviter === null ? {} : { inviter }),
  };
  inviteCodeVerifier(invite);
  return invite;
}
