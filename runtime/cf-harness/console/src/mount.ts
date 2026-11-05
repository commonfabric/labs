/**
 * Where this console is mounted, read from the address a page was opened at.
 *
 * The console serves its pages and `/api` at the root of its own origin — the
 * loopback address on the loom host. A host can also front it under a prefix
 * on an origin of its own: loom's daemon serves it at `/harness-console` so a
 * Weaver on another device reaches it through the same tailnet front as every
 * other loom route. A page must work at both, so nothing it fetches, streams
 * or links is written from the origin's root; every path goes under the
 * mount, and the mount is whatever precedes the page's own address.
 */

/**
 * The prefix a page's address sits under: `""` at the console's own root, or
 * the host's prefix, without a trailing slash. The operator's page is served
 * at the mount itself (`/` or `/harness-console/`); the live pane is served
 * at `<mount>/live/<sessionId>`, with or without a trailing slash.
 */
export const consoleMount = (pathname: string): string => {
  const trimmed = pathname.replace(/\/+$/, "");
  const live = /^(.*)\/live\/[^/]+$/.exec(trimmed);
  // Strip any trailing slash off the mount itself: for a doubled path like
  // `/a//live/x` the capture keeps the extra slash, and `consolePath` would
  // then build `/a//api` — a redundant slash that some hosts route
  // differently. The real `/harness-console` mount never hits this, but the
  // mount is the base every path hangs off, so it should be canonical.
  return (live === null ? trimmed : live[1]).replace(/\/+$/, "");
};

/**
 * A console path — `/api/...`, `/live/...` — as this page should address it:
 * under the mount the page was opened at.
 */
export const consolePath = (mount: string, path: string): string =>
  `${mount}${path}`;

/**
 * The mount of the page this script runs in. Outside a page (a test, a
 * server-side import) there is no address, and the console's own root is the
 * answer, which is what every path was before mounts existed.
 */
export const pageMount = (): string =>
  consoleMount(globalThis.location?.pathname ?? "/");

/**
 * The live pane's canonical address has no trailing slash: its stylesheet and
 * script are `../styles/...` and `../scripts/...`, one level up from
 * `/live/<sessionId>`, so a trailing slash would resolve them one level too
 * deep. Rather than serve a page whose assets cannot load, the server sends
 * the trailing-slash form to the canonical one, query and all — `?turn=` and
 * `?piecesBase=` are what the address carries, and a redirect that lost them
 * would open the pane on the wrong thing. The `Location` is RELATIVE on
 * purpose: from `<mount>/live/<sessionId>/` it resolves to
 * `<mount>/live/<sessionId>` on the client, whatever the mount, so a host
 * fronting the console under a prefix needs no `Location` rewriting.
 *
 * The operator's page has the mirror-image case, and it is the HOST's: at a
 * bare prefix (`/harness-console`, no slash) `./styles/...` would resolve
 * beside the prefix rather than under it. The console itself is never asked
 * for that address — at its own root the page is `/` — so the host that
 * fronts it under a prefix owns that redirect (loom's daemon answers 308 to
 * the slashed form).
 */
export const liveCanonicalRedirect = (
  pathname: string,
  search = "",
): string | undefined => {
  const match = /^\/live\/([^/]+)\/$/.exec(pathname);
  return match === null ? undefined : `../${match[1]}${search}`;
};
