/**
 * The confidentiality a collaborative field's anchors take on when the
 * engine moves them (`07-op-views-and-annotations.md` §7.7.4). A moved offset
 * is computed from the field's edits, so it is as confidential as the field,
 * whoever wrote the anchor. The engine reads what labels the field's stored
 * CFC envelope holds over the field's path, keeps their confidentiality, and
 * joins it onto the anchors document's envelope as a label of each offset
 * it moved.
 *
 * The functions here read and build envelopes as plain stored values. Which
 * stored envelopes they read is decided by the checks of
 * `cfc-stored-envelope.ts`, which the runner's reader holds to as well, so
 * the engine reads the envelopes the runner reads and no others, and
 * refuses whatever it cannot read, since a label it misread would leave the
 * anchors less confidential than the field.
 */

import type { FabricValue } from "@commonfabric/api";
import { taggedHashStringOf, valueEqual } from "@commonfabric/data-model";
import {
  isCfcLabelReference,
  isInlineCfcLabelShape,
  type StoredCfcEnvelope,
  type StoredCfcEnvelopeDefect,
  storedCfcEnvelopeDefect,
  type StoredCfcLabelEntry,
  type StoredInlineCfcLabel,
} from "./cfc-stored-envelope.ts";

/**
 * A stored CFC envelope the engine cannot read a confidentiality out of, or
 * cannot add one to. The edit that would have moved the anchors is refused
 * with it, so that no offset is derived from a field whose label is unknown.
 */
export class AnchorsLabelError extends Error {}

/**
 * The schema the envelope of an anchors document names when the engine
 * creates the envelope: the one a writer of the document through no schema
 * names, which declares nothing.
 */
const ANCHORS_SCHEMA = {};

/**
 * The hash {@link ANCHORS_SCHEMA} is stored under, as `cid:<hash>`: the
 * content hash of the schema, which is the hash a schema is interned under.
 */
export const anchorsSchemaHash = (): string =>
  taggedHashStringOf(ANCHORS_SCHEMA);

/** The document stored at `cid:<hash>` for {@link anchorsSchemaHash}. */
export const anchorsSchemaDocument = (): { value: FabricValue } => ({
  value: ANCHORS_SCHEMA,
});

const CID_PREFIX = "cid:";

/** A stored document member, or `undefined` where the document has none. */
type Stored = FabricValue | undefined;

/** A label as an envelope entry or a label document holds it, inline. */
type InlineLabel = StoredInlineCfcLabel<FabricValue>;

/**
 * Whether the stored value `value` has the shape of an inline label
 * (`isInlineCfcLabelShape()`), whose clauses and atoms are then stored
 * values too.
 */
const isInlineLabel = (value: FabricValue): value is InlineLabel =>
  isInlineCfcLabelShape(value);

/** A label-map entry as the engine reads it: a path, and a label. */
type ReadEntry = StoredCfcLabelEntry<FabricValue>;

/** A stored envelope the engine reads. */
type ReadEnvelope = StoredCfcEnvelope<FabricValue>;

/**
 * What the engine says of an envelope that breaks each rule of
 * `cfc-stored-envelope.ts`, of the document `holder` names. An envelope that
 * is not a record has no version, and is said to be of none the engine
 * reads.
 */
const DEFECT_MESSAGES: {
  readonly [Defect in StoredCfcEnvelopeDefect]: (holder: string) => string;
} = {
  "record": (holder) =>
    `the CFC envelope of ${holder} is not of a version the engine reads`,
  "version": (holder) =>
    `the CFC envelope of ${holder} is not of a version the engine reads`,
  "schema": (holder) => `the CFC envelope of ${holder} names no schema`,
  "label-map": (holder) =>
    `the CFC envelope of ${holder} holds no label map the engine reads`,
  "entry-path": (holder) =>
    `a label entry in the CFC envelope of ${holder} has no path`,
  "entry-label": (holder) =>
    `a label in the CFC envelope of ${holder} is not one the engine reads`,
  "version-1-reference": (holder) =>
    `the CFC envelope of ${holder}, of version 1, holds a label by reference`,
  "template-keying": (holder) =>
    `a label-metadata template entry in the CFC envelope of ${holder} is keyed as a label`,
};

/**
 * Helper for {@link readableEnvelopeOf}, which establishes that the stored
 * envelope `envelope` is one the engine reads.
 *
 * @throws AnchorsLabelError naming the first rule of
 *   `cfc-stored-envelope.ts` the envelope breaks.
 */
function assertReadable(
  envelope: FabricValue,
  holder: string,
): asserts envelope is ReadEnvelope {
  const defect = storedCfcEnvelopeDefect(envelope);
  if (defect !== undefined) {
    throw new AnchorsLabelError(DEFECT_MESSAGES[defect](holder));
  }
}

/**
 * The stored envelope `envelope` as the engine reads it, or `undefined` for
 * a document that stores no envelope: `undefined`, `null` and the scalars,
 * which are what a reader of the reserved member takes as nothing stored.
 *
 * @throws AnchorsLabelError for an envelope the runner would not read,
 *   naming the rule of `cfc-stored-envelope.ts` it breaks.
 */
const readableEnvelopeOf = (
  envelope: Stored,
  holder: string,
): ReadEnvelope | undefined => {
  if (envelope === null || typeof envelope !== "object") return undefined;
  assertReadable(envelope, holder);
  return envelope;
};

/**
 * Whether a label entry at `entryPath` bears on the value at `fieldPath`: it
 * labels the field, something above it, or something inside it. A `*`
 * segment of an entry's path stands for every key at its depth. An entry of
 * any observation class counts, so the anchors take on at least what a read
 * of the field's value would.
 */
const bearsOn = (
  entryPath: readonly string[],
  fieldPath: readonly string[],
): boolean => {
  const shared = Math.min(entryPath.length, fieldPath.length);
  for (let index = 0; index < shared; index++) {
    if (entryPath[index] !== fieldPath[index] && entryPath[index] !== "*") {
      return false;
    }
  }
  return true;
};

/**
 * The confidentiality the stored envelopes `envelopes` hold over the value
 * at `path`: every clause of every entry that bears on the path, each once,
 * in the order found. `envelopes` are those of the document the value is in,
 * one per scope instance a reader of the value answers to. Integrity is left
 * out: it speaks for whoever wrote a value, and nobody wrote an offset the
 * engine computed.
 *
 * A version-2 envelope may hold a label as `{ $ref: "cid:<hash>" }`, which
 * `labelDocument` resolves to the value of the document stored under that
 * hash, or `undefined` where the store holds none.
 *
 * @throws AnchorsLabelError for an envelope the engine cannot read
 *   ({@link readableEnvelopeOf}), for a label reference nothing stored backs, and
 *   for a label document that does not hold a label.
 */
export const confidentialityOver = (
  envelopes: readonly Stored[],
  path: readonly string[],
  holder: string,
  labelDocument: (hash: string) => Stored,
): FabricValue[] => {
  const clauses: FabricValue[] = [];
  for (const envelope of envelopes) {
    const entries: readonly ReadEntry[] =
      readableEnvelopeOf(envelope, holder)?.labelMap.entries ?? [];
    for (const entry of entries) {
      if (!bearsOn(entry.path, path)) continue;
      const label = resolvedLabel(entry.label, holder, labelDocument);
      for (const clause of label.confidentiality ?? []) {
        if (!clauses.some((held) => valueEqual(held, clause))) {
          clauses.push(clause);
        }
      }
    }
  }
  return clauses;
};

/**
 * Helper for {@link confidentialityOver}, which returns the label an entry
 * holds: `label` itself, or, for a `{ $ref: "cid:<hash>" }` reference, the
 * value of the label document it names.
 *
 * @throws AnchorsLabelError for a reference nothing stored backs, and for a
 *   document that does not hold a label.
 */
const resolvedLabel = (
  label: ReadEntry["label"],
  holder: string,
  labelDocument: (hash: string) => Stored,
): InlineLabel => {
  if (!isCfcLabelReference(label)) return label;
  const resolved = label.$ref.length > CID_PREFIX.length &&
      label.$ref.startsWith(CID_PREFIX)
    ? labelDocument(label.$ref.slice(CID_PREFIX.length))
    : undefined;
  if (resolved === undefined) {
    throw new AnchorsLabelError(
      `the CFC envelope of ${holder} names a label document \`${label.$ref}\` the store does not hold`,
    );
  }
  if (!isInlineLabel(resolved)) {
    throw new AnchorsLabelError(
      `the label document \`${label.$ref}\` the CFC envelope of ${holder} names does not hold a label`,
    );
  }
  return resolved;
};

/**
 * The envelope an anchors document stores once each anchor of `anchorIds`
 * carries `confidentiality` besides what `envelope`, the one it stores now,
 * says: for each, an entry labeling that anchor's offset, derived rather
 * than declared, that a read of the offset consumes. Returns `undefined`
 * where nothing is to be written: `confidentiality` is empty, or `envelope`
 * already holds every such entry.
 *
 * An entry sits at its anchor's own path and is of the value class alone,
 * which is what ties the label to the offset the engine computed. A writer's
 * envelope pass drops a derived value-class entry at a path the writer
 * replaces, and a writer of the document writes the anchors that differ, so
 * the label lasts until its anchor is next written and no longer.
 *
 * A document with no envelope gets one naming {@link anchorsSchemaHash}.
 *
 * @throws AnchorsLabelError for an envelope the engine cannot read.
 */
export const anchorsEnvelopeWith = (
  envelope: Stored,
  confidentiality: readonly FabricValue[],
  anchorIds: readonly string[],
  holder: string,
): FabricValue | undefined => {
  if (confidentiality.length === 0) return undefined;
  const stored = readableEnvelopeOf(envelope, holder);
  const held: readonly FabricValue[] = stored?.labelMap.entries ?? [];
  const added = anchorIds
    .map((id): FabricValue => ({
      path: [id],
      origin: "derived",
      observes: "value",
      label: { confidentiality: [...confidentiality] },
    }))
    .filter((entry) => !held.some((other) => valueEqual(other, entry)));
  if (added.length === 0) return undefined;
  if (stored === undefined) {
    return {
      version: 1,
      schemaHash: anchorsSchemaHash(),
      labelMap: { version: 1, entries: added },
    };
  }
  return {
    ...stored,
    labelMap: { ...stored.labelMap, entries: [...held, ...added] },
  };
};
