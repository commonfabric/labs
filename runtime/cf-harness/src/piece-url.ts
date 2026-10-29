/**
 * The address a person opens a named piece at: a base URL, then the space's
 * DID, then the slug. The shell's own writer writes the path, so the shell
 * reads back the space and slug that went in.
 */

import type { DID } from "@commonfabric/identity/did";
import { appViewToUrlPath } from "@commonfabric/navigation";

/**
 * The URL of the piece `slug` names in `space` under `base`, or `undefined`
 * when `base` is not a URL. A path on `base` is kept, so a host that renders
 * pieces under a path of its own gets addresses under it.
 */
export const pieceUrl = (
  base: string | URL,
  space: DID,
  slug: string,
): string | undefined => {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return undefined;
  }
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}${
    appViewToUrlPath({ spaceDid: space, pieceSlug: slug })
  }`;
  return url.toString();
};
