/**
 * The confidentiality a collaborative field's anchors take on when an edit
 * to the field integrates (`07-op-views-and-annotations.md` §7.7.4). A moved
 * offset is computed from the field's edits, so it is as confidential as the
 * field, whoever wrote the anchor, and which anchors an edit moves says where
 * it fell, so every anchor takes the label, moved or not. The engine reads
 * what labels the field's stored CFC envelope holds over the field's path,
 * keeps their confidentiality, and joins it onto the anchors document's
 * envelope as a label of each anchor's offset.
 *
 * The functions here read and build envelopes as plain stored values. Which
 * stored envelopes they read is decided by the checks of
 * `cfc-stored-envelope.ts`, which the runner's reader holds to as well, so
 * an envelope that fails them is refused here too, since a label misread
 * would leave the anchors less confidential than the field. Resolving
 * labels is the engine's own: it resolves those that bear on the field
 * ({@link confidentialityOver}) and no others.
 */

import type { FabricValue } from "@commonfabric/api";
import { taggedHashStringOf, valueEqual } from "@commonfabric/data-model";
import { atomPropagationClass } from "./cfc-atom-classes.ts";
import { readConsumesEntry } from "./cfc-observation-classes.ts";
import {
  isCfcLabelDocumentContent,
  isCfcLabelReference,
  isLabelMetadataTemplateEntry,
  parseCfcLabelReference,
  type StoredCfcEnvelope,
  type StoredCfcEnvelopeDefect,
  storedCfcEnvelopeDefect,
  type StoredCfcLabelEntry,
  type StoredInlineCfcLabel,
} from "./cfc-stored-envelope.ts";

/**
 * A stored CFC envelope the engine cannot read a confidentiality out of, or
 * cannot add one to. The edit that would have labeled the anchors is refused
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

/** A stored document member, or `undefined` where the document has none. */
type Stored = FabricValue | undefined;

/** A label as an envelope entry or a label document holds it, inline. */
type InlineLabel = StoredInlineCfcLabel<FabricValue>;

/**
 * Whether the stored value `value` has the shape of a label document's
 * content (`isCfcLabelDocumentContent()`), whose clauses and atoms are then
 * stored values too.
 */
const isLabelDocumentContent = (value: FabricValue): value is InlineLabel =>
  isCfcLabelDocumentContent(value);

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
 * @throws AnchorsLabelError for an envelope that fails the checks of
 *   `cfc-stored-envelope.ts`, naming the rule it breaks.
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
 * at `path`: every clause of every payload entry that bears on the path,
 * each once, in the order found. A label-metadata template entry is not a
 * payload entry and bears on no path here. `envelopes` are those of the
 * document the value is in, one per scope instance a reader of the value
 * answers to.
 *
 * A version-2 envelope may hold a label as `{ $ref: "cid:<hash>" }`, which
 * `labelDocument` resolves to the value of the document stored under that
 * hash, or `undefined` where the store holds none.
 *
 * @throws AnchorsLabelError for an envelope the engine cannot read
 *   ({@link readableEnvelopeOf}), for a label reference nothing stored backs,
 *   and for a label document that does not hold a label.
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
      // A label-metadata template is keyed against the stored document, not
      // the value, so it labels no field. Compared as a payload path,
      // `["cfc", "labels", ...]` would bear on a field that is the whole
      // value, whose path is a prefix of every path, and on one named `cfc`.
      if (isLabelMetadataTemplateEntry(entry)) continue;
      if (!bearsOn(entry.path, path)) continue;
      const label = resolvedLabel(entry.label, holder, labelDocument);
      for (const clause of label.confidentiality ?? []) clauses.push(clause);
    }
  }
  return distinctValues(clauses);
};

/**
 * The integrity a read of the value at `path` carries, from the stored
 * envelopes `envelopes`, the same ones {@link confidentialityOver} reads: in
 * each, for each component, the deepest payload entry a value read consumes
 * ({@link readConsumesEntry}) at the path or above it, and across those every
 * atom any of them holds, each once. A link entry with no class labels the
 * pointer rather than the value, so it is not counted, and neither is an
 * entry inside the value, whose claim holds for part of the value only.
 *
 * @throws AnchorsLabelError as {@link confidentialityOver} does.
 */
export const integrityOver = (
  envelopes: readonly Stored[],
  path: readonly string[],
  holder: string,
  labelDocument: (hash: string) => Stored,
): FabricValue[] => {
  const atoms: FabricValue[] = [];
  for (const envelope of envelopes) {
    const entries: readonly ReadEntry[] =
      readableEnvelopeOf(envelope, holder)?.labelMap.entries ?? [];
    const deepest = new Map<string, { depth: number; entries: ReadEntry[] }>();
    for (const entry of entries) {
      if (isLabelMetadataTemplateEntry(entry)) continue;
      if (entry.path.length > path.length || !bearsOn(entry.path, path)) {
        continue;
      }
      if (!readConsumesEntry("value", entry)) continue;
      const component = typeof entry.origin === "string"
        ? entry.origin
        : "legacy";
      const match = deepest.get(component);
      if (match === undefined || match.depth < entry.path.length) {
        deepest.set(component, { depth: entry.path.length, entries: [entry] });
      } else if (match.depth === entry.path.length) {
        match.entries.push(entry);
      }
    }
    for (const match of deepest.values()) {
      for (const entry of match.entries) {
        const label = resolvedLabel(entry.label, holder, labelDocument);
        for (const atom of label.integrity ?? []) atoms.push(atom);
      }
    }
  }
  return distinctValues(atoms);
};

/**
 * Helper for {@link confidentialityOver}, which returns the label an entry
 * holds: `label` itself, or, for a `{ $ref: "cid:<hash>" }` reference, the
 * value of the label document it names. The document is not compared with
 * its hash: the store installs a `cid:` document only when its content
 * hashes to its id.
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
  const hash = parseCfcLabelReference(label);
  const resolved = hash === undefined ? undefined : labelDocument(hash);
  if (resolved === undefined) {
    throw new AnchorsLabelError(
      `the CFC envelope of ${holder} names a label document \`${label.$ref}\` the store does not hold`,
    );
  }
  if (!isLabelDocumentContent(resolved)) {
    throw new AnchorsLabelError(
      `the label document \`${label.$ref}\` the CFC envelope of ${holder} names does not hold a label`,
    );
  }
  return resolved;
};

// SPEC-PENDING https://github.com/commonfabric/specs/pull/93 The label an
// edit gives a field's anchors is a store-performed derivation, which the
// pull request adds a section to rule on: the field's confidentiality joined
// into every anchor's derived value entry, moved or not, and the entry's
// integrity met with the field's. It changes what is stored, and runs by
// default rather than behind a setting that keeps the old behavior until the
// ruling, an exception to the pending-marker procedure that Robin McCollum
// accepted in the review of labs#9667: anchors are already persisted, and the
// label narrows what a reader of them learns.

/**
 * The envelope an anchors document stores once an edit to the field has
 * labeled each anchor of `anchorIds` with the field's label, the
 * `confidentiality` and `integrity` the field's document holds over it,
 * beside what `envelope`, the one it stores now, held for that anchor's
 * offset. Returns `undefined` where the envelope already holds every label
 * this would write, which includes a document with no envelope when
 * `confidentiality` is empty.
 *
 * Each anchor's offset is labeled by one derived entry of the value class at
 * the anchor's own path, which is what ties the label to the offset. The
 * engine joins the field's label into that entry: every clause either label
 * held stays, since a moved offset is computed from the old one, and the
 * integrity is the class-aware meet of the entry's and the field's, which
 * keeps a hereditary atom both hold and drops every other. That holds for an
 * anchor the edit did not move as well. Its offset is the one its writer
 * chose, but against text the edit has changed, so what its writer vouched
 * for holds only where the field vouches for it too. Where the envelope
 * holds no such entry, the anchor's writer vouched for nothing, so the entry
 * written holds the field's confidentiality alone, and none is written where
 * that is empty. A derived entry of no class at the path is consumed by a
 * read of the offset as well, so its integrity is met with the field's too;
 * its confidentiality, which reads of the other classes consume, stays.
 * Every other entry, a declared one at the anchor's path among them, stays
 * as its writer left it.
 *
 * A writer's envelope pass drops a derived value-class entry at a path the
 * writer replaces, and a writer of the document writes the anchors that
 * differ, so the label lasts until its anchor is next written and no longer.
 *
 * A document with no envelope gets one naming {@link anchorsSchemaHash}. A
 * label an entry at an anchor's path holds by reference is read through
 * `labelDocument`, as {@link confidentialityOver} reads one.
 *
 * Where `confidentiality` is empty, an envelope the engine cannot read, or a
 * label at an anchor's path it cannot resolve, is left as it is rather than
 * refused: there is no clause to add, and a reader honors no integrity in an
 * envelope it cannot read.
 *
 * @throws AnchorsLabelError for an envelope the engine cannot read, and for
 *   a label at an anchor's path that it cannot resolve, where
 *   `confidentiality` is not empty.
 */
export const anchorsEnvelopeWith = (
  envelope: Stored,
  confidentiality: readonly FabricValue[],
  integrity: readonly FabricValue[],
  anchorIds: readonly string[],
  holder: string,
  labelDocument: (hash: string) => Stored,
): FabricValue | undefined => {
  const label = () =>
    labeledAnchorsEnvelope(
      envelope,
      confidentiality,
      integrity,
      anchorIds,
      holder,
      labelDocument,
    );
  if (confidentiality.length > 0) return label();
  try {
    return label();
  } catch (cause) {
    if (cause instanceof AnchorsLabelError) return undefined;
    throw cause;
  }
};

/**
 * Helper for {@link anchorsEnvelopeWith}, which builds the envelope it
 * returns, and refuses whatever it cannot read.
 *
 * @throws AnchorsLabelError for an envelope the engine cannot read, and for
 *   a label at an anchor's path that it cannot resolve.
 */
const labeledAnchorsEnvelope = (
  envelope: Stored,
  confidentiality: readonly FabricValue[],
  integrity: readonly FabricValue[],
  anchorIds: readonly string[],
  holder: string,
  labelDocument: (hash: string) => Stored,
): FabricValue | undefined => {
  const stored = readableEnvelopeOf(envelope, holder);
  if (stored === undefined && confidentiality.length === 0) return undefined;
  const held: readonly ReadEntry[] = stored?.labelMap.entries ?? [];
  const labeled = new Set(anchorIds);
  const resolved = (entry: ReadEntry) =>
    resolvedLabel(entry.label, holder, labelDocument);

  // The label each anchor's offset already carried, from every derived
  // value-class entry at its path, which the one written replaces: their
  // clauses, and the meet of their integrity.
  const carried = new Map<
    string,
    { confidentiality: FabricValue[]; integrity: FabricValue[] }
  >();
  for (const entry of held) {
    const anchor = labeledAnchorOf(entry, labeled);
    if (anchor === undefined || entry.observes !== "value") continue;
    const label = resolved(entry);
    const prior = carried.get(anchor);
    carried.set(anchor, {
      confidentiality: [
        ...(prior?.confidentiality ?? []),
        ...(label.confidentiality ?? []),
      ],
      integrity: prior === undefined
        ? [...(label.integrity ?? [])]
        : meetIntegrity(prior.integrity, label.integrity ?? []),
    });
  }
  const labelFor = (anchor: string) => {
    const prior = carried.get(anchor);
    const clauses = distinctValues([
      ...(prior?.confidentiality ?? []),
      ...confidentiality,
    ]);
    const atoms = meetIntegrity(prior?.integrity ?? [], integrity);
    return {
      ...(clauses.length === 0 ? {} : { confidentiality: clauses }),
      ...(atoms.length === 0 ? {} : { integrity: atoms }),
    };
  };

  const written = new Set<string>();
  const entries: FabricValue[] = [];
  for (const entry of held) {
    const anchor = labeledAnchorOf(entry, labeled);
    if (anchor === undefined) {
      entries.push(entry);
    } else if (entry.observes === "value") {
      if (written.has(anchor)) continue;
      written.add(anchor);
      entries.push({ ...entry, label: labelFor(anchor) });
    } else if (entry.observes === undefined) {
      const label = resolved(entry);
      const atoms = meetIntegrity(label.integrity ?? [], integrity);
      entries.push(
        valueEqual(atoms, label.integrity ?? []) ? entry : {
          ...entry,
          label: {
            ...(label.confidentiality === undefined
              ? {}
              : { confidentiality: label.confidentiality }),
            ...(atoms.length === 0 ? {} : { integrity: atoms }),
          },
        },
      );
    } else {
      entries.push(entry);
    }
  }
  if (confidentiality.length > 0) {
    for (const anchor of anchorIds) {
      if (written.has(anchor)) continue;
      written.add(anchor);
      entries.push({
        path: [anchor],
        origin: "derived",
        observes: "value",
        label: labelFor(anchor),
      });
    }
  }

  if (stored === undefined) {
    return {
      version: 1,
      schemaHash: anchorsSchemaHash(),
      labelMap: { version: 1, entries },
    };
  }
  const unchanged = entries.length === held.length &&
    entries.every((entry, index) => valueEqual(entry, held[index]));
  if (unchanged) return undefined;
  // A spread copies own enumerable members only, and the check that found
  // `stored` readable also reads members a class defines, so the members it
  // requires are copied by name.
  return {
    ...stored,
    version: stored.version,
    schemaHash: stored.schemaHash,
    labelMap: {
      ...stored.labelMap,
      version: stored.labelMap.version,
      entries,
    },
  };
};

/**
 * Helper for {@link anchorsEnvelopeWith}, which returns the anchor of
 * `labeled` whose offset `entry` labels as a derived entry at its path, or
 * `undefined` for an entry of another component or path.
 */
const labeledAnchorOf = (
  entry: ReadEntry,
  labeled: ReadonlySet<string>,
): string | undefined =>
  entry.origin === "derived" && entry.path.length === 1 &&
    labeled.has(entry.path[0])
    ? entry.path[0]
    : undefined;

/**
 * The class-aware meet of the integrity `a` and `b` (§3.1.6.2): each atom of
 * `a` whose propagation class is hereditary and that `b` holds too, once.
 */
const meetIntegrity = (
  a: readonly FabricValue[],
  b: readonly FabricValue[],
): FabricValue[] =>
  distinctValues(
    a.filter((atom) =>
      atomPropagationClass(atom) === "hereditary" &&
      b.some((other) => valueEqual(other, atom))
    ),
  );

/** `values` with each value once, in the order first found. */
const distinctValues = (values: readonly FabricValue[]): FabricValue[] => {
  const distinct: FabricValue[] = [];
  for (const value of values) {
    if (!distinct.some((held) => valueEqual(held, value))) {
      distinct.push(value);
    }
  }
  return distinct;
};
