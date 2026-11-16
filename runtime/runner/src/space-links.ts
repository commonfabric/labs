/**
 * Links to a space, which grant nothing.
 *
 * A space link names a space and the service that holds it, so a member can
 * say which space they mean without handing out access: it opens the space
 * for someone who already has access, and anyone else is told they don't.
 * It carries nothing secret. An invitation, which does grant access, is a
 * different link (`buildInviteLink` in `./space-invites.ts`).
 *
 * The space's key alone cannot yet say where the space lives, so the link
 * names the service in `host`.
 */

import { type DID, isDID } from "@commonfabric/identity/did";
import { INVITE_LINK_SCHEME } from "@commonfabric/memory/space-invites";
import { isLoopbackHostname, normalizeSpaceHost } from "./space-host.ts";

/** A space and the service that holds it. */
export interface SpaceLink {
  host: string;
  space: string;
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

/** `host` as the origin of an HTTPS service, or a loopback one. */
function serviceOrigin(host: string): string {
  let url: URL;
  try {
    url = normalizeSpaceHost(host);
  } catch {
    throw new SpaceLinkError("invalid-host");
  }
  if (url.protocol !== "https:" && !isLoopbackHostname(url.hostname)) {
    throw new SpaceLinkError("invalid-host");
  }
  return url.origin;
}

/**
 * Builds the canonical space link, `/space?host&space`, on the `shell`
 * origin, with no fragment. {@link parseSpaceLink} documents its other form.
 */
export function buildSpaceLink(shell: string, link: SpaceLink): URL {
  const host = serviceOrigin(link.host);
  if (!isDID(link.space)) throw new SpaceLinkError("invalid-link");
  const url = new URL("/space", serviceOrigin(shell));
  url.search = new URLSearchParams({ host, space: link.space }).toString();
  return url;
}

/**
 * Parses a space link in either of its forms:
 *
 * - `http(s)://<origin>/space?host&space`, the canonical link
 *   {@link buildSpaceLink} makes. The link's own origin is only where it was
 *   served; `host` names the service.
 * - `fbrc://space?host&space`, on the scheme every Weaver answers
 *   (`INVITE_LINK_SCHEME`), in which `space` is the URL's host and its path
 *   is empty.
 *
 * Each names exactly one `host` and one `space`. Other query fields and any
 * fragment are ignored, so a link stays readable when a chat app adds a
 * tracking field or a later version of the format adds one of its own.
 *
 * A URL that is not a space link returns undefined: any path but `/space`, a
 * `/space` URL naming neither `host` nor `space`, a scheme other than
 * `http(s)` and `fbrc`, and any other action on the `fbrc` scheme
 * (`parseInviteLink` judges those). Anything else throws a
 * {@link SpaceLinkError}.
 */
export function parseSpaceLink(
  link: string | URL,
): (SpaceLink & { space: DID }) | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new SpaceLinkError("invalid-link");
  }
  if (url.protocol === `${INVITE_LINK_SCHEME}:`) {
    if (url.hostname !== "space") return undefined;
    if (url.host !== "space" || url.pathname !== "") {
      throw new SpaceLinkError("invalid-link");
    }
  } else if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.pathname !== "/space" ||
    !SPACE_LINK_KEYS.some((key) => url.searchParams.has(key))
  ) {
    return undefined;
  }
  const hosts = url.searchParams.getAll("host");
  const spaces = url.searchParams.getAll("space");
  if (
    url.username || url.password || hosts.length !== 1 || !hosts[0] ||
    spaces.length !== 1 || !isDID(spaces[0])
  ) throw new SpaceLinkError("invalid-link");
  return { host: serviceOrigin(hosts[0]), space: spaces[0] };
}
