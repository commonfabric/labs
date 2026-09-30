import { parseCellReference, type ReferenceMember } from "./cell-reference.ts";
import type { CellScope } from "@commonfabric/api";
import { isSlugAddress, isValidSlug } from "./slugs.ts";

/**
 * What a URL names, when it names a cell.
 *
 * `space` is whatever the URL carried — a DID, or a name that still has to be
 * resolved into one. Exactly one of `id` and `slug` is set: a last segment
 * carrying a scheme is an id, and anything else is a slug, which addresses a
 * redirect document rather than the piece itself.
 */
export interface FabricUrlTarget {
  space?: string;
  id?: string;
  slug?: string;
  path: string[];
  member?: ReferenceMember;
  scope?: CellScope;
}

export interface FabricUrlOptions {
  /**
   * Hosts whose page URLs name cells. A page URL from anywhere else is just a
   * link to a web page, and saying which hosts are ours is the only way to
   * tell the two apart — until an unknown host can be probed.
   */
  hosts?: readonly string[];
}

/**
 * Percent-decoding that returns rather than throws. A malformed escape is a
 * URL this cannot read, and the contract is that such a URL names no cell —
 * not that asking about it fails.
 */
function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * A path segment as the cell key it stands for. `createLLMFriendlyLink` writes
 * paths as a JSON Pointer, so a key holding `/` or `~` arrives escaped and a
 * segment taken verbatim would name a key nothing has.
 */
function decodePathSegment(segment: string): string | undefined {
  const decoded = decode(segment);
  return decoded?.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** `fid1:<payload>`, with the colon percent-encoded or not. */
const TAGGED_HASH = /^fid1(?::|%3a)([A-Za-z0-9_-]{20,})$/i;

/**
 * Whether a segment names an entity rather than a slug. Bare and `of:`-schemed
 * forms both count; the scheme is part of the identity, so it is preserved
 * rather than assumed.
 */
function asEntityId(segment: string): string | undefined {
  const decoded = decode(segment);
  if (decoded === undefined) return undefined;
  const schemeAt = decoded.indexOf(":");
  if (schemeAt === -1) return undefined;

  // `of:fid1:…` — a scheme in front of the tagged hash.
  const head = decoded.slice(0, schemeAt);
  const rest = decoded.slice(schemeAt + 1);
  if (TAGGED_HASH.test(rest)) return `${head}:${rest}`;

  // `fid1:…` on its own. A piece reached through a URL path is a root, and
  // roots are `of:`, which is what the shell's own id normalization assumes.
  if (TAGGED_HASH.test(decoded)) return `of:${decoded}`;

  return undefined;
}

/**
 * The space a marked path segment carries, or `undefined` where the segment
 * carries no mark and so is not the space at all.
 *
 * In the `/@space/` alias, a leading `@` marks a segment as the space: it keeps
 * a space from competing for the slot the piece would otherwise hold. What the mark carries is only held to a form by the
 * reader — a DID resolves from the string alone, a name needs a session — so
 * the rest of the segment comes back unexamined.
 *
 * The segment is percent-decoded first, so a mark or a name that arrived
 * escaped reads as what it stands for and `%40space` carries what `@space`
 * carries; a segment holding a malformed escape is one this cannot read, and
 * carries no space. A segment that is nothing but the mark returns the empty
 * string rather than `undefined`, which is the distinction a caller needs: it
 * says it is the space while naming none, where an unmarked segment never
 * said it was one.
 */
export function asSpaceSegment(segment: string): string | undefined {
  const decoded = decode(segment);
  return decoded?.startsWith("@") ? decoded.slice(1) : undefined;
}

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

/** Every segment as its key, or undefined when any of them cannot be read. */
function decodePath(segments: string[]): string[] | undefined {
  const path: string[] = [];
  for (const segment of segments) {
    const key = decodePathSegment(segment);
    if (key === undefined) return undefined;
    path.push(key);
  }
  return path;
}

/**
 * Read the cell a URL names, or `undefined` when it names none.
 *
 * Four shapes reach this, and they are the shapes people actually have in
 * hand: a bare or schemed tagged hash copied out of a tool, the
 * `/of:…`-rooted link this repository renders into markdown, that same form
 * carrying an `@space`, and a page URL off one of our own hosts.
 *
 * This is deliberately pure and synchronous. Deciding whether an unknown host
 * is ours, and turning a space name into a DID, are the parts that become
 * asynchronous later; neither belongs to reading a string apart.
 */
export function parseFabricUrl(
  url: string,
  options: FabricUrlOptions = {},
): FabricUrlTarget | undefined {
  const trimmed = (url ?? "").trimStart();
  if (trimmed.length === 0) return undefined;

  // A bare or schemed tagged hash, with no path around it.
  if (!trimmed.startsWith("/") && !trimmed.includes("://")) {
    const id = asEntityId(trimmed.trimEnd());
    return id ? { id, path: [] } : undefined;
  }

  if (trimmed.startsWith("/")) {
    try {
      const reference = trimmed.split("/").map((segment) => {
        const decoded = decode(segment);
        return decoded?.replace(/\//g, "~1");
      });
      if (reference.some((segment) => segment === undefined)) return undefined;
      const parts = parseCellReference(reference.join("/"));
      const id = asEntityId(
        parts.path.length === 0 ? parts.id.trimEnd() : parts.id,
      );
      if (id === undefined) return undefined;
      return {
        space: parts.space,
        id,
        path: parts.path,
        ...(parts.member && { member: parts.member }),
        ...(parts.scope && { scope: parts.scope }),
      };
    } catch {
      return undefined;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }

  const hosts = options.hosts ?? [];
  if (!hosts.includes(parsed.host)) return undefined;

  const segments = splitPath(parsed.pathname);
  // `/<space>/<piece>` is the page URL shape. A host of ours with anything
  // shorter is one of its own pages rather than a piece.
  if (segments.length < 2) return undefined;

  const space = decode(segments[0]);
  if (space === undefined) return undefined;

  const target = segments[1];
  const path = decodePath(segments.slice(2));
  if (path === undefined) return undefined;

  const id = asEntityId(target);
  if (id !== undefined) return { space, id, path };

  // A colon-free segment only looks like a slug; it has to BE one, or the id
  // derived from it would be derived from something the space cannot hold.
  const decoded = decode(target);
  return decoded !== undefined && isSlugAddress(decoded) && isValidSlug(decoded)
    ? { space, slug: decoded, path }
    : undefined;
}
