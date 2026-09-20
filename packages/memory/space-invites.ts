/** Versioned credentials, links, and wire contracts for space invitations. */
import { sha256 } from "@commonfabric/content-hash";
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

/** The non-secret destination and fragment secret in an invitation link. */
export interface InviteLink {
  host: string;
  space: string;
  inviteId: string;
  code: string;
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

/** Whether a destination has the DID key encoding accepted by invite routes. */
function isInviteSpace(value: unknown): value is DIDKey {
  return isDIDKey(value) &&
    /^did:key:z[1-9A-HJ-NP-Za-km-z]{20,120}$/.test(value);
}

/** Generates independent opaque credentials using the platform RNG. */
export function createInviteCredentials(): { inviteId: string; code: string } {
  return {
    inviteId: toUnpaddedBase64url(crypto.getRandomValues(new Uint8Array(16))),
    code: toUnpaddedBase64url(crypto.getRandomValues(new Uint8Array(32))),
  };
}

/** Hashes a code with a versioned host, space, and invite-ID binding. */
export function inviteCodeVerifier(link: InviteLink): string {
  const host = normalizeInviteHost(link.host);
  if (
    !isInviteSpace(link.space) || !isInviteId(link.inviteId) ||
    !isInviteSecret(link.code)
  ) {
    throw new SpaceInviteError("invalid-request");
  }
  return toUnpaddedBase64url(sha256(new TextEncoder().encode(JSON.stringify([
    "commonfabric-space-invite-v1",
    host,
    link.space,
    link.inviteId,
    link.code,
  ]))));
}

/** Builds a join link whose secret is carried only in its fragment. */
export function buildInviteLink(shell: string, invite: InviteLink): URL {
  inviteCodeVerifier(invite);
  const url = new URL("/join", normalizeInviteHost(shell));
  url.search = new URLSearchParams({
    host: normalizeInviteHost(invite.host),
    space: invite.space,
    invite: invite.inviteId,
  }).toString();
  url.hash = new URLSearchParams({ code: invite.code }).toString();
  return url;
}

/** Parses a join link; unrelated routes return undefined, malformed joins throw secret-free errors. */
export function parseInviteLink(
  link: string | URL,
): (InviteLink & { space: DIDKey }) | undefined {
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
    [...url.searchParams.keys()].sort().join(",") !== "host,invite,space" ||
    [...fragment.keys()].join(",") !== "code"
  ) throw new SpaceInviteError("invalid-link");
  const space = url.searchParams.get("space");
  if (!isInviteSpace(space)) throw new SpaceInviteError("invalid-link");
  const invite = {
    host: normalizeInviteHost(url.searchParams.get("host")!),
    space,
    inviteId: url.searchParams.get("invite")!,
    code: fragment.get("code")!,
  };
  inviteCodeVerifier(invite);
  return invite;
}
