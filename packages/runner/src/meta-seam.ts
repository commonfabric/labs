import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

export const META_LINK_FIELDS = Object.freeze(
  [
    "pattern",
    "argument",
    "result",
  ] as const,
);

export type MetaLinkField = typeof META_LINK_FIELDS[number];

/**
 * The meta fields: the document-root siblings of `value` that the raw meta
 * seam addresses. This list is the authority — {@link MetaField} is derived
 * from it, and {@link isMetaField} tests membership at runtime.
 *
 * The seam is the runtime's, to read as well as to write, so none of this
 * reaches the cell surface a pattern compiles against. `pattern` links a
 * result cell to its pattern, and `argument` to its argument cell. `internal`
 * holds a manifest of links to derived internal cells. `schema` stores the
 * schema for a result cell. `patternSetupIdentity` records the pattern
 * identity whose complete setup state was installed on a result cell.
 * `result` lets a result cell link to its parent result cell, and lets the
 * argument and derived internal cells link back to the result cell.
 *
 * `cfc` is deliberately NOT a meta field: the `["cfc"]` document field holds
 * raw label metadata (Caveat.source and other principal identities), which
 * must not ride the raw meta seam. The cfc code reads the field directly
 * through its own verifier seams; display consumers get the redacted view via
 * getCfcLabel.
 */
export const META_FIELDS = Object.freeze(
  [
    ...META_LINK_FIELDS,
    "patternIdentity", // content-addressed {identity, symbol} pattern reference
    "patternSetupIdentity", // setup-completion {identity, symbol} marker
    "patternSource", // active web or `cf:` source origin
    "pieceSourceHistory", // append-only source revisions and retention roots
    "pieceReconciliation", // what following the active origin last did:
    // {outcome, at, origin, offered?, reason?, detail?} — a piece that refused
    // or could not reach its origin looks otherwise exactly like one that is
    // running what its origin offers
    "patternRepository", // optional caller-supplied repository locator
    "displacedPattern", // {identity, symbol, displacedAt}: the prior pattern
    // reference recorded when system-pattern auto-update replaces an unloadable
    // sourceless root — the recovery pointer for a displaced custom program
    "internal",
    "schema",
    "slug",
  ] as const,
);

export type MetaField = typeof META_FIELDS[number];

const META_FIELD_SET: ReadonlySet<string> = new Set(META_FIELDS);

/** Whether the given field name addresses the raw meta seam. */
export function isMetaField(field: string): field is MetaField {
  return META_FIELD_SET.has(field);
}

/**
 * Narrow a raw meta value to a `{ identity, symbol }` pattern ref, or
 * undefined.
 *
 * This is the one test for "does this document name a pattern", and it lives
 * here so every reader of the `patternIdentity` field shares it: a cell read
 * through `getMetaRaw`, and a store read that has the document envelope in
 * hand and no cell. Two readers that decide the question apart can disagree,
 * and a disagreement here is a piece that never starts.
 */
export function asPatternIdentityRef(
  raw: unknown,
): { identity: string; symbol: string } | undefined {
  if (
    isObjectOrArray(raw) && typeof raw.identity === "string" &&
    typeof raw.symbol === "string"
  ) {
    return { identity: raw.identity, symbol: raw.symbol };
  }
  return undefined;
}

/**
 * Marks a write as one the runtime makes on the meta seam.
 *
 * The write chokepoint refuses a meta write whose options do not carry this
 * mark. `setMetaRaw` in `cell.ts` is the one holder of
 * {@link rawMetaWriteAuthorization}, the options value that carries it: a
 * symbol cannot be named by a module that did not import it, and the sandbox
 * hands pattern code the builder namespace rather than the runner's modules.
 */
export const RAW_META_WRITE: unique symbol = Symbol("raw-meta-write");

/** Write options that authorize the meta fields the write lands. */
export interface RawMetaWriteAuthorization {
  readonly [RAW_META_WRITE]: true;
}

/**
 * The authorization `setMetaRaw` passes with the write it makes.
 *
 * The authorization travels as the write's own options rather than as a scope
 * open around the call, so it reaches the one write that carries it and no
 * other — including no write another transaction makes in the meantime.
 */
export const rawMetaWriteAuthorization: RawMetaWriteAuthorization = Object
  .freeze({ [RAW_META_WRITE]: true } as RawMetaWriteAuthorization);

/** Whether write options carry {@link rawMetaWriteAuthorization}. */
export function rawMetaWriteAuthorized(options: unknown): boolean {
  return isObjectNotArray(options) &&
    (options as Partial<RawMetaWriteAuthorization>)[RAW_META_WRITE] === true;
}

/**
 * The meta fields a write at `path` carrying `value` lands on a document.
 *
 * A meta field is a document-root sibling of `value`, so a write reaches one
 * two ways: addressed at the field (or at a path inside it), or addressed at
 * the document root with the field as a key of the written envelope. A write
 * under `value` reaches none, whatever a user key is named: a user field
 * named `slug` is addressed at `["value", "slug"]`.
 */
export function metaFieldsWritten(
  path: readonly string[],
  value: unknown,
): readonly MetaField[] {
  if (path.length === 0) return metaFieldsIn(value);
  return isMetaField(path[0]) ? [path[0]] : NO_META_FIELDS;
}

/**
 * The meta fields a stored document carries.
 *
 * A write at the document root replaces the envelope, so the fields it does
 * not carry are the fields it drops, and telling which those are means
 * reading what the document holds. `envelope` is that document root, which
 * one read answers for every field at once.
 *
 * A field is carried when its value is defined. The storage layer can hold a
 * field that is present and `undefined` — that is what `IWriteOptions.delete`
 * distinguishes — and this treats such a field as absent, because the seam's
 * read half does too: `getMetaRaw` returns `undefined` for both, and no
 * reader addresses a meta path any other way. A root write that drops such a
 * field redirects no piece, which is what the guard is here to stop.
 *
 * An envelope that is not a record carries nothing, which is what a document
 * the transaction does not hold reads as.
 */
export function storedMetaFields(envelope: unknown): readonly MetaField[] {
  if (!isObjectNotArray(envelope)) return NO_META_FIELDS;
  let carried: MetaField[] | undefined;
  for (const field of META_FIELDS) {
    if (envelope[field] === undefined) continue;
    (carried ??= []).push(field);
  }
  return carried ?? NO_META_FIELDS;
}

function metaFieldsIn(document: unknown): readonly MetaField[] {
  return isObjectNotArray(document)
    ? Object.keys(document).filter(isMetaField)
    : NO_META_FIELDS;
}

/**
 * No meta fields.
 *
 * Every write in the runtime asks the two questions above, and almost every
 * write is addressed under `value`. The shared answer keeps that path
 * allocation free.
 */
export const NO_META_FIELDS: readonly MetaField[] = Object.freeze([]);
