/**
 * The confidentiality a collaborative field's anchors take on when the
 * engine moves them (`07-op-views-and-annotations.md` §7.7.4). A moved offset
 * is computed from the field's edits, so it is as confidential as the field,
 * whoever wrote the anchor. The engine reads what labels the field's stored
 * CFC envelope holds over the field's path, keeps their confidentiality, and
 * joins it onto the anchors document's envelope as a label of each offset
 * it moved.
 *
 * The functions here read and build envelopes as plain stored values. What
 * an envelope is, and what a reader makes of one, is the runner's
 * `cfc/metadata.ts`, whose `isCfcMetadata()` decides which stored envelopes
 * the runner reads; this module admits the same ones and no others, rule
 * for rule, and refuses whatever it cannot read, since a label it misread
 * would leave the anchors less confidential than the field. The runner's
 * reader is not imported: it is written over the runner's storage layer,
 * which the store does not depend on.
 */

import type { FabricValue } from "@commonfabric/api";
import {
  isFabricPlainObject,
  taggedHashStringOf,
  valueEqual,
} from "@commonfabric/data-model";

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

/**
 * The origin of a label-metadata population template entry, which the
 * runner keys under the `["cfc", "labels"]` metadata subtree and classes as
 * `labelMetadata`, and reads nowhere else.
 */
const TEMPLATE_ORIGIN = "label-metadata";

/** A stored document member, or `undefined` where the document has none. */
type Stored = FabricValue | undefined;

/**
 * A label as an envelope entry or a label document holds it, inline. A type
 * rather than an interface, so that it is a stored value: an interface
 * carries no index signature, and a stored record does.
 */
type InlineLabel = {
  confidentiality?: FabricValue[];
  integrity?: FabricValue[];
};

/** A label-map entry as the engine reads it: a path, and a label. */
interface ReadEntry {
  readonly path: readonly string[];
  readonly label: InlineLabel | { readonly $ref: string };
}

/**
 * Whether `label` is a label held by reference, `{ $ref: "<document>" }`
 * and nothing else.
 */
const isReference = (label: Stored): label is { readonly $ref: string } =>
  label !== undefined && isFabricPlainObject(label) &&
  Object.keys(label).length === 1 && typeof label.$ref === "string";

/**
 * Whether `label` has the shape of a label as an envelope or a label
 * document holds one: a record of `confidentiality` and `integrity` alone,
 * each an array where present.
 */
const isInlineLabel = (label: Stored): label is InlineLabel => {
  if (label === undefined || !isFabricPlainObject(label)) return false;
  const { confidentiality, integrity, ...unknown } = label;
  return Object.keys(unknown).length === 0 &&
    (confidentiality === undefined || Array.isArray(confidentiality)) &&
    (integrity === undefined || Array.isArray(integrity));
};

/**
 * The label map of the stored envelope `envelope`, with its entries both as
 * stored and as the engine reads them, or `undefined` for a document that
 * stores no envelope: `undefined`, `null` and the scalars, which are what a
 * reader of the reserved member takes as nothing stored.
 *
 * @throws AnchorsLabelError for an envelope the runner would not read: one
 *   of a version other than 1 and 2, one naming no schema, one with no label
 *   map of entries, an entry with no path of strings or no label, a label
 *   held by reference in a version-1 envelope, which does not define that
 *   spelling, and a label-metadata template entry keyed or classed as the
 *   runner never writes one.
 */
const labelMapOf = (
  envelope: Stored,
  holder: string,
):
  | {
    labelMap: { [key: string]: FabricValue };
    held: FabricValue[];
    entries: ReadEntry[];
  }
  | undefined => {
  if (envelope === null || typeof envelope !== "object") return undefined;
  if (
    !isFabricPlainObject(envelope) ||
    (envelope.version !== 1 && envelope.version !== 2)
  ) {
    throw new AnchorsLabelError(
      `the CFC envelope of ${holder} is not of a version the engine reads`,
    );
  }
  if (typeof envelope.schemaHash !== "string") {
    throw new AnchorsLabelError(
      `the CFC envelope of ${holder} names no schema`,
    );
  }
  const { labelMap } = envelope;
  if (
    labelMap === undefined || !isFabricPlainObject(labelMap) ||
    labelMap.version !== 1 || !Array.isArray(labelMap.entries)
  ) {
    throw new AnchorsLabelError(
      `the CFC envelope of ${holder} holds no label map the engine reads`,
    );
  }
  const held: FabricValue[] = labelMap.entries;
  const entries = held.map((entry): ReadEntry => {
    const path = entry !== undefined && isFabricPlainObject(entry)
      ? entry.path
      : undefined;
    if (
      entry === undefined || !isFabricPlainObject(entry) ||
      !Array.isArray(path) ||
      !path.every((part): part is string => typeof part === "string")
    ) {
      throw new AnchorsLabelError(
        `a label entry in the CFC envelope of ${holder} has no path`,
      );
    }
    const { label } = entry;
    if (isReference(label)) {
      if (envelope.version === 1) {
        throw new AnchorsLabelError(
          `the CFC envelope of ${holder}, of version 1, holds a label by reference`,
        );
      }
    } else if (!isInlineLabel(label)) {
      throw new AnchorsLabelError(
        `a label in the CFC envelope of ${holder} is not one the engine reads`,
      );
    }
    if (
      entry.origin === TEMPLATE_ORIGIN &&
      (path[0] !== "cfc" || path[1] !== "labels" ||
        entry.observes !== "labelMetadata")
    ) {
      throw new AnchorsLabelError(
        `a label-metadata template entry in the CFC envelope of ${holder} is keyed as a label`,
      );
    }
    return { path, label };
  });
  return { labelMap, held, entries };
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
 *   ({@link labelMapOf}), for a label reference nothing stored backs, and
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
    for (const entry of labelMapOf(envelope, holder)?.entries ?? []) {
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
  if (!isReference(label)) return label;
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
  const stored = labelMapOf(envelope, holder);
  const held = stored?.held ?? [];
  const added = anchorIds
    .map((id): FabricValue => ({
      path: [id],
      origin: "derived",
      observes: "value",
      label: { confidentiality: [...confidentiality] },
    }))
    .filter((entry) => !held.some((other) => valueEqual(other, entry)));
  if (added.length === 0) return undefined;
  if (stored === undefined || !isFabricPlainObject(envelope)) {
    return {
      version: 1,
      schemaHash: anchorsSchemaHash(),
      labelMap: { version: 1, entries: added },
    };
  }
  return {
    ...envelope,
    labelMap: { ...stored.labelMap, entries: [...held, ...added] },
  };
};
