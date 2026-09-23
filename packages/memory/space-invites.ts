/** Versioned credentials, links, and wire contracts for space invitations. */
import { hashStringOf } from "@commonfabric/data-model";
import { type DIDKey, isDIDKey } from "@commonfabric/identity/did";
import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";
import { isLoopbackHostname } from "@commonfabric/utils/loopback";
import type { Capability } from "./acl.ts";

/** Host limits for version one of the invitation protocol. */
export const SPACE_INVITE_CAPABILITY = {
  version: 1,
  maxUses: 1000,
  maxTtlSeconds: 30 * 24 * 60 * 60,
} as const;

/** The admission capability an invitation can grant. */
export type InviteAccess = "READ" | "WRITE";

/** Issuance parameters, signed by a current explicit space owner. */
export interface CreateInvite {
  inviteId: string;
  codeVerifier: string;
  ttlSeconds: number;
  access: InviteAccess;
  maxUses?: number;
}

/** Public, owner-visible metadata while an invitation remains active. */
export interface InviteMetadata {
  inviteId: string;
  issuedBy: string;
  createdAt: number;
  expiresAt: number;
  access: InviteAccess;
  maxUses: number;
  usedCount: number;
  remainingUses: number;
}

/** The only durable redemption history. */
export interface InviteRedemption {
  inviteId: string;
  did: string;
}

/** A successful admission decision and current ACL observation. */
export interface RedeemReceipt {
  outcome: "redeemed" | "already-redeemed";
  redemption: InviteRedemption;
  currentAccess: Capability | null;
}

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
  const bytes = fromBase64url(value);
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
