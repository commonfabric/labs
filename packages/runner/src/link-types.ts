import { debugStr } from "@commonfabric/data-model";
import { isDID } from "@commonfabric/identity/did";
import {
  isLinkRef,
  linkRefFrom,
  linkRefPayload,
} from "@commonfabric/data-model/cell-rep";
import {
  decodeJsonPointer,
  encodeJsonPointer,
} from "@commonfabric/utils/json-pointer";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { parseCellReference, renderCellReference } from "./cell-reference.ts";
import {
  type CellScope,
  type JSONSchema,
  type LinkScope,
  type SchemaScope,
} from "./builder/types.ts";
import { type MemorySpace } from "./cell.ts";
import {
  type CellLinkRefPayload,
  LINK_ADDRESS_KEYS,
  type SigilLink,
  type SigilWriteRedirectLink,
  type URI,
} from "./sigil-types.ts";
import { arrayEqual } from "./path-utils.ts";
import type {
  IMemorySpaceAddress,
  MemoryAddressPathComponent,
} from "./storage/interface.ts";

export { decodeJsonPointer, encodeJsonPointer };

/** The scopes an `@scope` suffix on a link handle may name. */
export const CELL_SCOPE_VALUES: ReadonlySet<string> = new Set([
  "space",
  "user",
  "session",
]);

/**
 * Splits a link's id segment into the id and the scope its `@scope` suffix
 * names, leaving the scope absent when the segment carries no suffix. Throws
 * when a suffix is present but names something other than a scope, or leaves
 * no id in front of it.
 */
export function parseScopedIdSegment(idSegment: string): {
  id: string;
  scope?: CellScope;
} {
  const scopeSeparator = idSegment.lastIndexOf("@");
  if (scopeSeparator === -1) return { id: idSegment };

  const id = idSegment.slice(0, scopeSeparator);
  const scope = idSegment.slice(scopeSeparator + 1);
  if (!id || !CELL_SCOPE_VALUES.has(scope)) {
    throw new Error(
      `Invalid scope suffix "@${scope}" in link handle. Expected @space, @user, or @session.`,
    );
  }

  return { id, scope: scope as CellScope };
}

/**
 * A follow cap declared by the schema at `depth` path segments from this
 * link's root, remembered because narrowing past that segment drops the
 * declaring schema. See {@link NormalizedLink.scopeCaps}.
 */
export type ScopeCapAtDepth = {
  /** Number of leading `path` segments the declaring schema addresses. */
  depth: number;

  scope: SchemaScope;
};

/**
 * Normalized link structure returned by parsers
 */
export type NormalizedLink = {
  id?: URI; // URI format with "of:" prefix
  path: readonly MemoryAddressPathComponent[];
  space?: MemorySpace;
  scope?: LinkScope;
  schema?: JSONSchema;
  overwrite?: "redirect"; // "this" gets normalized away to undefined

  /**
   * Follow caps declared by schemas ABOVE this link's leaf, ascending by
   * depth. `schema` only describes the leaf, so a cap declared mid-path — an
   * `asCell` entry's `scope` on an ancestor — is otherwise lost the moment
   * `key()` narrows past it, and `resolveLink` has nothing to check when it
   * discovers the stored link at that ancestor. Populated by `Cell.key()`,
   * which is the one place that walks the schema segment by segment.
   *
   * Read-side only: this is never serialized into a sigil link, never part of
   * link identity (`areNormalizedLinksSame`), and must never be stamped onto a
   * followed link's own scope (CT-1623).
   *
   * Caps are MONOTONIC across `asSchema()`: reinterpreting an address can
   * tighten a cap (the next `key()` merges the narrower of the two) but never
   * lift one. Clearing them on `asSchema` looks tempting — it is a sibling
   * with a different schema, so carrying provenance from the discarded one
   * reads as surprising — but it would turn every `asSchema`-based read
   * helper into a cap bypass. `cellWithScopedLinkRequiredsRelaxed`, the piece
   * read boundary itself, ends in `cell.asSchema(relaxed)`; the ancestor caps
   * a narrowed cell carries exist nowhere else, so dropping them there would
   * silently lift the caps that boundary is supposed to enforce.
   */
  scopeCaps?: readonly ScopeCapAtDepth[];

  /**
   * Link resolution FOLLOWED at least one hop and then dead-ended at a
   * doc the replica cannot serve (the sigil probe reported the DOC
   * itself missing — not merely an absent path in a present doc). The
   * chain may well continue inside that doc once it arrives, so nothing
   * about the value at this link is knowable yet: under the lazy
   * (action-body) read path this is an UNRESOLVED INPUT and the read
   * refuses instead of handing `undefined` into the body (the RULED
   * OW51 semantics, 2026-08-21 — schema.ts's lazy branch throws
   * `UnresolvedInputError`). A dead-end at the handle's OWN root doc
   * does not set this: a fresh cell's doc does not exist until its
   * first write, and `get() ?? fallback` on it stays `undefined` as it
   * always has. Nor does a dead-end at a USER- or SESSION-scoped row:
   * a principal's instance row exists only once that principal writes
   * it, so its absence is knowledge (the scoped first-write idiom) —
   * only a missing SPACE-scoped doc marks the result pending. One
   * window sits outside that idiom and outside the refusal's
   * protection, matching main's behavior: a scoped row already
   * written elsewhere (another device; a cold or lagging serving
   * replica) is transit, not knowledge, and its mid-arrival read
   * takes main's interim-undefined-then-heal. No shipped pattern
   * routes link chains through user-scoped docs (the #6179 review's
   * population audit). Read-side
   * only, like `scopeCaps`: never serialized, never part of link
   * identity; consumers that copy links by spread carry it inertly.
   */
  pendingHopDoc?: true;

  /**
   * This link is DATA-DERIVED: parsed from a stored sigil link, or
   * produced by a resolution that followed at least one hop. A handle
   * minted from such a link points at somebody else's doc — the doc's
   * absence may be transit (not yet arrived), unlike a locally-minted
   * cell's own doc, whose absence before its first write is knowledge
   * (the `get() ?? fallback` idiom). Consulted only by link resolution
   * when a walk dead-ends at a missing doc (see `pendingHopDoc`).
   * Read-side only, like `scopeCaps`: never serialized, never part of
   * link identity.
   */
  viaLinkHop?: true;
};

/**
 * Full normalized link from a complete link, i.e. with required id and space.
 * Gets created by parseLink if a base is provided.
 *
 * Normalized link paths are value-relative. Use `toMemorySpaceAddress` when a
 * document-root memory address is required.
 */
export type NormalizedFullLink = NormalizedLink & {
  id: URI;
  space: MemorySpace;
  scope: CellScope;
};

export type ValuePath = readonly ["value", ...string[]];
export type IMemorySpaceValueAddress = IMemorySpaceAddress & {
  path: ValuePath;
};

/**
 * Convert a value-relative normalized link into a document-root memory address.
 */
export function toMemorySpaceAddress(
  link: NormalizedFullLink,
): IMemorySpaceValueAddress {
  return {
    space: link.space,
    id: link.id,
    scope: link.scope,
    path: ["value", ...link.path],
  };
}

/**
 * The serializable link form. There is one, the sigil link, and every
 * predicate and parser in this module speaks only about it.
 *
 * The one thing that resembles a link here and is not one is the `$alias`
 * pattern binding, defined in `alias-binding.ts`. It carries no document
 * identifier, so nothing in this module recognizes it and an `$alias` record
 * found in data is data.
 */
export type PrimitiveCellLink = SigilLink;

export function isSigilLink(value: any): value is SigilLink {
  return isLinkRef(value);
}

export function isPrimitiveCellLink(
  value: any,
): value is PrimitiveCellLink {
  return isSigilLink(value);
}

export function isNormalizedLink(value: any): value is NormalizedLink {
  if (!isObjectNotArray(value)) return false;
  const { path, id, space, scope } = value;
  return Array.isArray(path) &&
    (typeof id === "string" || id === undefined) &&
    (typeof space === "string" || space === undefined) &&
    (scope === undefined || scope === "inherit" || scope === "space" ||
      scope === "user" || scope === "session");
}

/**
 * Check if value is a normalized full link.
 *
 * Beware: Unlike all the other types that `isLink` is checking for, this could
 * appear in regular data and not actually be meant as a link. So only use this
 * if you know for sure that the value is a link.
 *
 * We don't verify that the id and space are URI or MemorySpace, but we do
 * verify that they are strings.
 */
export function isNormalizedFullLink(value: any): value is NormalizedFullLink {
  return (
    isObjectNotArray(value) &&
    typeof value.id === "string" &&
    typeof value.space === "string" &&
    (value.scope === "space" || value.scope === "user" ||
      value.scope === "session") &&
    Array.isArray(value.path)
  );
}

/**
 * Check if value is a write-redirect link (sigil `link@1` with
 * `overwrite: "redirect"`).
 */
export function isWriteRedirectLink(
  value: any,
): value is SigilWriteRedirectLink {
  if (isSigilLink(value)) {
    return linkRefPayload(value).overwrite === "redirect";
  }

  return false;
}

/**
 * Parse any link-like value to normalized format
 *
 * Overloads just help make fields non-optional that can be guaranteed to exist
 * in various combinations.
 */
export function parseLinkPrimitive(
  value: PrimitiveCellLink,
  base?: NormalizedLink,
): NormalizedLink {
  if (isSigilLink(value)) {
    const link = linkRefPayload(value);

    // Resolve relative references
    let id = link.id;
    const path = link.path || [];
    const resolvedSpace = link.space || base?.space;
    const resolvedScope = link.scope === undefined || link.scope === "inherit"
      ? base?.scope
      : link.scope;

    // If no id provided, use base cell's document
    if (!id && base) {
      id = base.id;
    }

    return {
      ...(id && { id }),
      path: path.map((p) => p.toString()),
      ...(resolvedSpace && { space: resolvedSpace }),
      ...(resolvedScope && { scope: resolvedScope }),
      ...(link.schema !== undefined && { schema: link.schema }),
      ...(link.overwrite === "redirect" && { overwrite: "redirect" }),
    };
  }
  throw new Error(
    debugStr`Link is not a primitive: $quote${value}`,
  );
}

/**
 * Compare two normalized links for equality
 */
export function areNormalizedLinksSame(
  link1: NormalizedLink,
  link2: NormalizedLink,
): boolean {
  return link1.id === link2.id && link1.space === link2.space &&
    (link1.scope ?? "space") === (link2.scope ?? "space") &&
    arrayEqual(link1.path, link2.path);
}

export function areNormalizedLinksSameIgnoringScope(
  link1: NormalizedLink,
  link2: NormalizedLink,
): boolean {
  return link1.id === link2.id && link1.space === link2.space &&
    arrayEqual(link1.path, link2.path);
}

/**
 * The same link reduced to the cell it names: its {@link LINK_ADDRESS_KEYS}
 * members and nothing else.
 *
 * A link's identity is its address, which is what
 * {@link areNormalizedLinksSame} compares. What a payload carries beyond the
 * address describes how the value there is read or labeled -- `schema` is the
 * reading lens, cfc's `cfcLabelView` a flow-control side channel its own
 * module calls no part of addressing identity -- so anything deriving from a
 * link's identity has to leave all of it out. `causalFormOfBinding()` is the
 * caller that does, reducing a node's bound inputs on the way into its cause.
 *
 * Kept as a list of what to KEEP rather than what to drop, so the next member
 * somebody hangs off a payload stays out of derived ids until someone decides
 * it belongs in an address. That is the direction that fails safely here: a
 * new addressing member has to be taught to `NormalizedLink` and
 * {@link areNormalizedLinksSame} anyway and cannot arrive unnoticed, while
 * metadata riding along on a link demonstrably can.
 *
 * A link already down to its address is returned as it stands, so a caller
 * pays an allocation only where there is something to drop.
 */
export function sigilLinkAddressOnly(link: SigilLink): SigilLink {
  const payload = linkRefPayload(link);

  // A payload that is not a record carries no members to read. `isLinkRef()`
  // vets the envelope rather than what sits inside it, so `{"/": {"link@1":
  // null}}` reaches here as a link; it is data nothing addresses, and it
  // passes through as it stands rather than throwing on the `in` below.
  if (!isObjectNotArray(payload)) return link;

  // `in`, not `!== undefined`: a hash is over the members a value HAS, so a
  // key spelled `schema: undefined` is a member like any other and would
  // otherwise reach the digest as one.
  const keys = Object.keys(payload);
  if (
    keys.every((key) => (LINK_ADDRESS_KEYS as readonly string[]).includes(key))
  ) {
    return link;
  }

  return linkRefFrom(
    Object.fromEntries(
      LINK_ADDRESS_KEYS
        .filter((key) => key in payload)
        .map((key) => [key, payload[key]]),
    ) as CellLinkRefPayload,
  );
}

/**
 * Serialize an address to a string key for use in Maps/Sets/memoization.
 * Includes space, id, and path — the same fields compared by
 * areNormalizedLinksSame for document links.
 *
 * Because links are relative to "value", the IMemorySpaceAddress and
 * NormalizedFullLink version of the same address will return different
 * keys, so they should not be mixed up.
 */
type ScopedMemorySpaceAddress = IMemorySpaceAddress & { scope: CellScope };

export function addressKey(
  addr: ScopedMemorySpaceAddress | NormalizedFullLink,
): string {
  return JSON.stringify([
    addr.space,
    addr.id,
    addr.scope,
    addr.path,
  ]);
}

/** A canonical array-index token: `0`, or digits without a leading zero. */
const canonicalArrayIndex = /^(0|[1-9][0-9]*)$/;

/** The largest valid JS array index, 2^32 - 2. */
const MAX_ARRAY_INDEX = 4294967294;

/**
 * Converts one path segment of a reference to the number-or-string form cell
 * traversal addresses with. Only a canonical index token — `0`, or digits
 * with no leading zero — whose value is a valid JS array index (at most
 * `4294967294`) becomes a number; every other token stays a string.
 *
 * Both halves of that rule keep a segment addressing the cell it names. A
 * non-canonical token such as `01` names a property of that spelling rather
 * than element `1`, and above `Number.MAX_SAFE_INTEGER` the conversion is
 * itself lossy — `Number("9007199254740993")` is `9007199254740992` — so
 * either conversion would silently address a different cell.
 */
export function linkPathSegmentToCellPathSegment(
  segment: string,
): string | number {
  if (!canonicalArrayIndex.test(segment)) return segment;
  const index = Number(segment);
  return index <= MAX_ARRAY_INDEX ? index : segment;
}

// Matches both standard links (/of:...) and cross-space links (/@did:...)
export const matchLLMFriendlyLink = new RegExp(
  "^/(?:/[^/]+/|@[^/]+/)?[a-zA-Z0-9]+:",
);

/**
 * The shortest an id segment may be and still be a piece handle.
 *
 * Handles are long encoded strings — `of:fid1:...` runs well past forty
 * characters — where a name a person chose is short. The threshold is
 * deliberately conservative and deliberately not a parse of a handle's own
 * structure: what it has to separate is the two vocabularies a reference
 * admits, not one encoding from another.
 */
const HANDLE_MIN_LENGTH = 20;

/** Whether an id segment names a piece by handle rather than by name. */
export function isPieceHandle(id: string): boolean {
  return id.length >= HANDLE_MIN_LENGTH;
}

export {
  parseCellReference as parseReferenceParts,
  type ReferenceParts,
} from "./cell-reference.ts";

/**
 * Parses a LLM friendly link from a target string.
 * Supports both standard and cross-space formats:
 * - Standard: /of:fid1:abc123/path
 * - Cross-space: /@did:key:z6Mk.../of:fid1:abc123/path
 *
 * @param target - The target string to parse
 * @param space - The fallback space to use if not embedded in link
 * @returns The parsed LLM friendly link
 */
export function parseLLMFriendlyLink(
  target: string,
  space: MemorySpace,
): NormalizedFullLink;
export function parseLLMFriendlyLink(
  target: string,
  space?: MemorySpace,
): NormalizedLink;
export function parseLLMFriendlyLink(
  target: string,
  space?: MemorySpace,
): NormalizedLink {
  target = target.trimStart();

  if (!matchLLMFriendlyLink.test(target)) {
    throw new Error(
      'Target must include a piece handle, e.g. "/of:fid1:abc123/path".',
    );
  }

  const parsed = parseCellReference(target, space ? { space } : undefined);
  if (parsed.member === "argument") {
    throw new Error(
      "Resolving `#argument` requires a piece reader; use `parseCellReference` to read its member.",
    );
  }

  // A link resolves from the string alone, so both parts have to say what they
  // are: a space name and a slug each need a session to look up, and there is
  // none here.
  if (parsed.space !== undefined) {
    if (!isDID(parsed.space)) {
      throw new Error(
        `Link spaces must be DIDs (e.g., "/@did:key:z6Mk.../of:fid1:abc123"), not names (e.g., "${parsed.space}").`,
      );
    }
    space = parsed.space;
  }
  if (!isPieceHandle(parsed.id)) {
    throw new Error(
      `Piece references must use handles (e.g., "/of:fid1:abc123/path"), not human names (e.g., "${parsed.id}").`,
    );
  }

  return {
    id: parsed.id as `${string}:${string}`,
    path: parsed.path,
    ...(space && { space }),
    ...(parsed.scope && { scope: parsed.scope }),
  };
}

/**
 * Creates an LLM-friendly link string from a normalized link.
 * Uses the caller's space and base scope as context when supplied. Without a
 * context, writes the complete address, including its space and scope.
 *
 * @param link - The normalized link to encode
 * @param contextSpace - The current execution space (optional)
 * @returns The encoded link string
 */
export function createLLMFriendlyLink(
  link: NormalizedFullLink,
  contextSpace?: MemorySpace,
): string {
  return renderCellReference(
    link,
    contextSpace === undefined ? {} : { space: contextSpace, scope: "space" },
  );
}
