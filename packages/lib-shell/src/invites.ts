/**
 * Encodes generic invitation links for browser shells. This module describes
 * link syntax only; service discovery, proof signing, and redemption are
 * separate protocol operations.
 */

import { type DID, isDID } from "@commonfabric/identity";
import { isLoopbackHostname, normalizeSpaceHost } from "@commonfabric/runner";

/** A captured invitation whose bearer code belongs in tab-scoped storage. */
export interface InviteLink {
  /** Canonical service origin. */
  host: string;

  /** Space whose admission operation the invitation addresses. */
  space: DID;

  /** Public invitation identifier. */
  inviteId: string;

  /** Bearer secret, encoded only in the URL fragment. */
  code: string;
}

/**
 * Normalizes an invitation's service or shell origin. HTTPS is required except
 * for loopback development; credentials, paths, queries, and fragments fail.
 */
export function normalizeInviteHost(value: string): string {
  try {
    const url = normalizeSpaceHost(value);
    if (url.protocol !== "https:" && !isLoopbackHostname(url.hostname)) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new Error("Invalid invitation host: expected an HTTPS origin.");
  }
}

/** Helper for the link codec, which refuses missing or ambiguous values. */
function validateInvitation(invite: InviteLink): InviteLink {
  if (
    !isDID(invite.space) || !invite.inviteId || !invite.code ||
    /\s/.test(invite.space) ||
    [...invite.inviteId, ...invite.code].some((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  ) {
    throw new Error(
      "Invalid invitation: required fields are missing or malformed.",
    );
  }
  return { ...invite, host: normalizeInviteHost(invite.host) };
}

/** Builds a generic join link, confining the bearer secret to its fragment. */
export function buildInviteLink(
  shellOrigin: string,
  invitation: InviteLink,
): URL {
  const invite = validateInvitation(invitation);
  const url = new URL("/join", normalizeInviteHost(shellOrigin));
  url.search = new URLSearchParams({
    host: invite.host,
    space: invite.space,
    invite: invite.inviteId,
  }).toString();
  url.hash = new URLSearchParams({ code: invite.code }).toString();
  return url;
}

/**
 * Parses a generic join link. Returns `undefined` for another route and throws
 * for malformed join links, without including input values in error messages.
 */
export function parseInviteLink(url: URL): InviteLink | undefined {
  if (url.pathname !== "/join") return undefined;
  const query = url.searchParams;
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (
    query.size !== 3 || fragment.size !== 1 ||
    ["host", "space", "invite"].some((key) => query.getAll(key).length !== 1) ||
    fragment.getAll("code").length !== 1
  ) {
    throw new Error(
      "Invalid invitation: expected one host, space, invite, and fragment code.",
    );
  }
  const space = query.get("space");
  if (!isDID(space)) {
    throw new Error("Invalid invitation: the space is malformed.");
  }
  return validateInvitation({
    host: query.get("host")!,
    space,
    inviteId: query.get("invite")!,
    code: fragment.get("code")!,
  });
}
