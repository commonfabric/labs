/**
 * The address a person opens a named piece at.
 *
 * It is the fabric's URL, then the space, then the slug: what `cf piece new`
 * prints under "Open in browser", and what the shell reads back. The space
 * goes in as it was configured. A name addresses the legacy space that name
 * derives; a space created with a random key has no name, and goes in as its
 * DID. The shell's own writer writes the path, so a DID reaches the shell as
 * the DID it reads rather than escaped into a segment it would take for a
 * name, which derives a different space.
 */

import {
  appViewToUrlPath,
  isAppViewEqual,
  spaceViewRef,
  urlToAppView,
} from "@commonfabric/navigation";

/**
 * The URL of the piece `slug` names in `space` on the fabric at `base`, or
 * `undefined` when no URL can be composed from them: `base` is not a URL,
 * `space` is empty, or the address would not read back as this piece. The
 * shell's own reader is asked, and it reads a path as written: a legacy name
 * holding `/` or `\` reads as more segments than it is, one holding a
 * character a URL escapes reads as its escape, and a leading `@` is read as a
 * mark rather than as the name. Each would name another space or piece, so it
 * gets no address. A path on `base` is kept, so a host that renders pieces
 * under a path of its own gets addresses under it.
 */
export const pieceUrl = (
  base: string | URL,
  space: string,
  slug: string,
): string | undefined => {
  const addressed = spaceViewRef(space, undefined);
  if (addressed === undefined) {
    return undefined;
  }
  const view = { ...addressed, pieceSlug: slug };
  const path = appViewToUrlPath(view);
  let url: URL;
  try {
    if (
      !isAppViewEqual(urlToAppView(new URL(path, "http://piece.invalid")), view)
    ) {
      return undefined;
    }
    url = new URL(base);
  } catch {
    return undefined;
  }
  const prefix = url.pathname.endsWith("/")
    ? url.pathname.slice(0, -1)
    : url.pathname;
  url.pathname = `${prefix}${path}`;
  return url.toString();
};
