/**
 * Entity kinds version an entity id's URI SCHEME: `computed:fid1:<hash>`
 * names an entity whose contents are re-derivable by the runtime that
 * minted it. The kind's ONLY representation is the URI scheme: the hash
 * preimage is kind-free (see `createRef`), so a computed cell and a state
 * cell minted from the same cause share hash bytes and differ solely in
 * scheme — which is why the full URI string, scheme included, is the
 * identity, and a kind change still names a different entity.
 *
 * `of:fid1:<hash>` remains the unkinded form with strict, authoritative
 * semantics. The kind rides the scheme, NOT the `FabricHash` format tag: the
 * tag stays `fid1` (same bytes, same hashing) and `FabricHash.fromString`
 * is unaffected. Because the scheme is part of the URI string, the URI
 * string IS the identity — never rebuild a computed cell's URI from its
 * bare hash.
 *
 * ## Terminology: "kind" vs "scheme" (and the other two "kind"s)
 *
 * - **Entity kind** (this module) is the SEMANTIC property: how an entity's
 *   contents relate to derivation, and what conflict policy the server may
 *   apply. **Entity URI scheme** is that kind's REPRESENTATION in the id
 *   string: `uriSchemeForEntityKind` maps kind → scheme,
 *   `entityKindOfIdString` parses scheme → kind. A "kinded scheme" is a
 *   scheme that encodes a kind; `of:` is the unkinded default.
 * - **Stream `$kind`** (`$kind: "stream"` in stream cells' cause PREIMAGES,
 *   builder/pattern.ts) is the same concept — distinguishing a cell flavor
 *   at identity-minting time — via the older mechanism: mixed into the hash
 *   preimage, invisible in the id string. Streams may eventually migrate to
 *   a visible `stream:` scheme, but deliberately have not: a visible marker
 *   would re-identify every existing stream cell (see the spec's
 *   Non-goals). Until then, "stream" is NOT an `EntityKind` and has no
 *   entry in `ENTITY_URI_SCHEMES`.
 * - **`asCell` kinds** (`asCell: ["cell" | "stream" | "opaque" | ...]` in
 *   schemas) are HANDLE CAPABILITY kinds: what a granted reference may do —
 *   a property of the binding, not of the entity, and unrelated to
 *   identity despite sharing the word (and the value `"stream"`).
 *
 * ## Which scheme names are registered
 *
 * The IANA URI scheme registry lists every registered scheme name:
 * <https://www.iana.org/assignments/uri-schemes/uri-schemes.xhtml>.
 * Consult it before minting another prefix. A name used here falls into
 * one of three cases.
 *
 * - **Registered, and used for what it was registered for.** `did:`,
 *   defined by the W3C Decentralized Identifiers specification, and
 *   `data:`, defined by RFC 2397.
 * - **Absent from the registry.** `of:`, `computed:`, and runtime-local
 *   `snapshot:` identifiers are private to this codebase.
 * - **Registered for an unrelated subject.** `cid:` prefixes a
 *   content-addressed schema document reference (`schema-decompose.ts`).
 *   RFC 2392 registers the same name for a body part of a MIME message,
 *   addressed by its `Content-ID` header.
 *
 * RFC 3986 section 3.1 bounds what a scheme name may contain: a letter,
 * then any number of letters, digits, `+`, `-`, and `.`. A prefix holding
 * a character outside that set, such as `@`, is not a scheme name at all,
 * and so cannot collide with one.
 *
 * See `docs/specs/computed-cell-identity.md`.
 */

/** The kinds an entity id can carry, beyond the unkinded `of:` default. */
export type EntityKind = "computed";

/** The URI scheme of computed-kind entity ids (`computed:fid1:<hash>`). */
export const COMPUTED_URI_SCHEME = "computed";

/**
 * Every entity URI scheme: `of` (the unkinded default) plus one scheme per
 * entity kind. This is the SINGLE place the set is defined — the helpers
 * below and scheme parsers across layers (routing, display, embeds) derive
 * from it, so adding a kind cannot leave a stale `of|computed` alternation
 * behind somewhere.
 */
export const ENTITY_URI_SCHEMES = ["of", COMPUTED_URI_SCHEME] as const;

export type EntityUriScheme = (typeof ENTITY_URI_SCHEMES)[number];

/**
 * The `"<scheme>:"` prefix when `id` starts with an entity URI scheme,
 * else `undefined`. Non-entity URIs (`data:`, `snapshot:`, `did:`, …) and bare tagged
 * hashes (`fid1:<hash>`) return `undefined`.
 */
export function entityUriSchemePrefix(
  id: string,
): `${EntityUriScheme}:` | undefined {
  for (const scheme of ENTITY_URI_SCHEMES) {
    if (id.startsWith(`${scheme}:`)) return `${scheme}:`;
  }
  return undefined;
}

/** True iff `id` starts with an entity URI scheme (`of:`, `computed:`, …). */
export function hasEntityUriScheme(id: string): boolean {
  return entityUriSchemePrefix(id) !== undefined;
}

/**
 * Strip the entity URI scheme, whichever it is. CAREFUL: for kinded schemes
 * the scheme is part of the identity — a `computed:` id's bare hash names
 * its `of:` sibling — so use this only where the scheme is carried
 * alongside (see {@link entityUriSchemePrefix}) or provably `of:`.
 */
export function stripEntityUriScheme(id: string): string {
  const prefix = entityUriSchemePrefix(id);
  return prefix === undefined ? id : id.slice(prefix.length);
}

/**
 * The bare tagged hash (`fid1:<hash>`) naming the entity that `address`
 * addresses, accepting either spelling of an unkinded entity: the bare hash
 * itself, or the `of:`-schemed URI over it. This is the intake seam for an
 * address that came from outside the runtime — a command-line flag, a routing
 * request, a pasted id — where both spellings are in circulation and both
 * name the same entity.
 *
 * A KINDED scheme is refused rather than stripped. `computed:fid1:<hash>` and
 * `of:fid1:<hash>` share hash bytes and name different entities (the preimage
 * is kind-free; see the module comment above and
 * `docs/specs/computed-cell-identity.md`), so dropping the scheme would
 * silently address the sibling instead of reporting that the caller named
 * something this seam cannot resolve. Every scheme but `of:` is refused, so a
 * kind added to {@link ENTITY_URI_SCHEMES} is refused here without a further
 * edit.
 *
 * A string carrying no entity scheme is returned unchanged, including one with
 * no colon at all: recognizing a scheme is this function's job, and judging
 * what remains belongs to the parser the caller hands it to.
 *
 * @throws Error if `address` carries a kinded entity URI scheme.
 */
export function hashStringForEntityAddress(address: string): string {
  const prefix = entityUriSchemePrefix(address);
  if (prefix === undefined) return address;
  if (prefix === "of:") return address.slice(prefix.length);
  throw new Error(
    `Kinded entity id \`${address}\` cannot be addressed by its hash: ` +
      `the \`of:\` id over the same hash names a different entity.`,
  );
}

const KNOWN_ENTITY_KINDS: ReadonlySet<string> = new Set(["computed"]);

export function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === "string" && KNOWN_ENTITY_KINDS.has(value);
}

/**
 * The URI scheme that carries `kind`: `undefined` (no kind) maps to the
 * plain `"of"` scheme, `"computed"` to {@link COMPUTED_URI_SCHEME}.
 */
export function uriSchemeForEntityKind(
  kind: EntityKind | undefined,
): "of" | typeof COMPUTED_URI_SCHEME {
  return kind === undefined ? "of" : COMPUTED_URI_SCHEME;
}

/**
 * Parses the kind from an id string's URI scheme (the segment before the
 * FIRST colon): `computed:fid1:<hash>` → `"computed"`. Every other form —
 * `of:` URIs, bare tagged hashes (`fid1:<hash>`), non-entity URIs (e.g.
 * `data:`, `snapshot:`), colon-free strings, and UNKNOWN schemes (e.g. `future:fid1:…`)
 * — returns `undefined`, which callers must treat as strict/authoritative,
 * never relaxed.
 */
export function entityKindOfIdString(id: string): EntityKind | undefined {
  const colon = id.indexOf(":");
  if (colon === -1) return undefined;
  const scheme = id.slice(0, colon);
  return scheme === COMPUTED_URI_SCHEME ? "computed" : undefined;
}
