/**
 * Links to a space, which grant nothing.
 *
 * A space link names a space and the service that holds it, so a member can
 * say which space they mean without handing out access: it opens the space
 * for someone who already has access, and anyone else is told they don't.
 * It carries nothing secret. An invitation, which does grant access, is a
 * different link (`buildInviteLink` in `./space-invites.ts`); both share the
 * invitation link format's rules for the service and the space, and its
 * scheme ({@link INVITE_LINK_SCHEME}).
 *
 * The format has no version number. A writer may add a field only when a
 * reader that ignores it still reads the link correctly; anything that would
 * change what an existing link means takes a new path or scheme action
 * instead. So readers ignore fields they do not know, and any fragment.
 *
 * The space's key cannot yet say where the space lives, so writers always
 * send `host`, and readers require it. Once a space can be resolved to its
 * service, `host` becomes a hint that writers keep sending and readers may
 * stop requiring.
 */

import type { DIDKey } from "@commonfabric/identity/did";
import {
  INVITE_LINK_SCHEME,
  inviteHostOrigin,
  isInviteDIDKey,
  isSchemeAction,
} from "./space-invites.ts";

/** A space and the service that holds it. */
export interface SpaceLink {
  host: string;
  space: DIDKey;
}

/**
 * Why a space link was refused: `invalid-link` for one that names no single
 * space or no service, and `invalid-host` for a service that is not an HTTPS
 * origin (or a loopback one, for development).
 */
export class SpaceLinkError extends Error {
  override name = "SpaceLinkError";
  constructor(readonly code: "invalid-link" | "invalid-host") {
    super(code);
  }
}

/** The query keys that make a `/space` URL a space link. */
const SPACE_LINK_KEYS = ["host", "space"] as const;

/**
 * `host` as a service origin, by the invitation link format's rule
 * (`inviteHostOrigin`).
 */
function serviceOrigin(host: string): string {
  const origin = inviteHostOrigin(host);
  if (origin === undefined) throw new SpaceLinkError("invalid-host");
  return origin;
}

/**
 * Builds the canonical space link, `/space?host&space`, on the `shell`
 * origin, with no fragment. {@link parseSpaceLink} documents its other form.
 */
export function buildSpaceLink(shell: string, link: SpaceLink): URL {
  const host = serviceOrigin(link.host);
  if (!isInviteDIDKey(link.space)) throw new SpaceLinkError("invalid-link");
  const url = new URL("/space", serviceOrigin(shell));
  url.search = new URLSearchParams({ host, space: link.space }).toString();
  return url;
}

/**
 * Parses a space link in either of its forms:
 *
 * - `https://<origin>/space?host&space`, the canonical link
 *   {@link buildSpaceLink} makes, on any secure origin or loopback HTTP, as an
 *   invitation's;
 * - `fbrc://space?host&space`, on the {@link INVITE_LINK_SCHEME} scheme, in
 *   which `space` is the URL's host and its path is empty.
 *
 * `host` is always the service named in the query, never the link's own
 * origin. Each form names exactly one `host` and one `space`; other query
 * fields and any fragment are ignored (see the module's compatibility rule).
 *
 * A URL that is not a space link returns undefined: any path but `/space`, a
 * `/space` URL naming neither `host` nor `space`, and any other action on the
 * scheme, so that a link kind added later reaches this reader as one it does
 * not know rather than as a malformed one. Anything else throws a
 * {@link SpaceLinkError}: `invalid-link` for a malformed space link, such as
 * `fbrc://SPACE?…` or `fbrc://space/?…`, or a scheme URL naming no action
 * (`fbrc:space?…`), as `isSchemeAction` judges for every action; and
 * `invalid-host` for a link or service that is not a secure origin.
 */
export function parseSpaceLink(link: string | URL): SpaceLink | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new SpaceLinkError("invalid-link");
  }
  if (url.protocol === `${INVITE_LINK_SCHEME}:`) {
    let named: boolean;
    try {
      named = isSchemeAction(url, "space");
    } catch {
      throw new SpaceLinkError("invalid-link");
    }
    if (!named) return undefined;
  } else {
    if (
      url.pathname !== "/space" ||
      !SPACE_LINK_KEYS.some((key) => url.searchParams.has(key))
    ) return undefined;
    serviceOrigin(url.origin);
  }
  const hosts = url.searchParams.getAll("host");
  const spaces = url.searchParams.getAll("space");
  if (
    url.username || url.password || hosts.length !== 1 || !hosts[0] ||
    spaces.length !== 1 || !isInviteDIDKey(spaces[0])
  ) throw new SpaceLinkError("invalid-link");
  return { host: serviceOrigin(hosts[0]), space: spaces[0] };
}
