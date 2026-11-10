/**
 * Which stored CFC envelopes a reader may produce labels from: the shape a
 * value at a document's reserved `cfc` member has to have before any label
 * is read out of it. `docs/specs/cfc-stored-envelope.md` states the rule
 * this serves, that a document whose envelope cannot be read is never read
 * as an unlabeled one.
 *
 * Two readers hold to these checks, and so admit the same envelopes: the
 * runner's (`cfc/metadata.ts` in `@commonfabric/runner`), which reads the
 * labels a transaction consumes, and the engine's labeling of the anchors an
 * edit moves (`cfc-anchors-label.ts`), which takes on what a read of the
 * field consumes. Each keeps its own response to an envelope it cannot read:
 * the runner's errors, and the engine's refusal of the edit. Interpreting a
 * readable envelope, resolving the label documents it names, and caching
 * what was found stay with each reader.
 *
 * Every check is of shape alone. A label's clauses and atoms are checked to
 * be arrays and no further, and an entry's `origin` and `observes` are read
 * only where a rule below names them.
 */

import { isObjectNotArray } from "@commonfabric/js-values/types";

/**
 * A stored envelope's `version`. Version 1 holds every label inline;
 * version 2 may hold a label as a reference to a content-addressed label
 * document (`docs/specs/content-addressed-cfc-labels.md`).
 */
export type StoredCfcEnvelopeVersion = 1 | 2;

const KNOWN_VERSIONS: readonly StoredCfcEnvelopeVersion[] = [1, 2];

/** Whether `value` is an envelope `version` a reader interprets. */
export const isKnownCfcEnvelopeVersion = (
  value: unknown,
): value is StoredCfcEnvelopeVersion =>
  KNOWN_VERSIONS.some((version) => version === value);

/**
 * A label held by reference in a version-2 envelope: a single-member record
 * naming the label document whose value is the label. An inline label never
 * carries `$ref`, so the key alone tells the two apart.
 */
export type StoredCfcLabelReference = { readonly $ref: string };

/**
 * Whether `value` is a label held by reference: `{ $ref: "<document>" }` and
 * nothing else. What the reference names is not checked here; resolving it
 * is the reader's.
 */
export const isCfcLabelReference = (
  value: unknown,
): value is StoredCfcLabelReference =>
  isObjectNotArray(value) && typeof value.$ref === "string" &&
  Object.keys(value).length === 1;

/**
 * A label as an envelope holds it inline, with clauses and atoms of type
 * `Leaf`. A type rather than an interface, so that a label of stored values
 * is itself a stored value.
 */
export type StoredInlineCfcLabel<Leaf = unknown> = {
  readonly confidentiality?: readonly Leaf[];
  readonly integrity?: readonly Leaf[];
};

const LABEL_MEMBERS: readonly string[] = ["confidentiality", "integrity"];

/**
 * Whether `value` has the shape of an inline label: a record whose every
 * member is `confidentiality` or `integrity`, holding an array or
 * `undefined`. A label carrying a third member is of a format the reader
 * postdates, and reading the two members it knows would drop whatever the
 * third carries.
 */
export const isInlineCfcLabelShape = (
  value: unknown,
): value is StoredInlineCfcLabel =>
  isObjectNotArray(value) &&
  Object.keys(value).every((key) =>
    LABEL_MEMBERS.includes(key) &&
    (value[key] === undefined || Array.isArray(value[key]))
  );

/**
 * The origin of a label-metadata population template entry, which the
 * runner mints under the `["cfc", "labels"]` metadata subtree, of the
 * `labelMetadata` observation class (spec §4.6.4.2).
 */
export const LABEL_METADATA_TEMPLATE_ORIGIN = "label-metadata";

/** Whether a stored entry is a label-metadata population template. */
export const isLabelMetadataTemplateEntry = (
  entry: { readonly origin?: unknown },
): boolean => entry.origin === LABEL_METADATA_TEMPLATE_ORIGIN;

/**
 * Whether an entry of the template origin is keyed and classed as the
 * runner mints one: under the `["cfc", "labels"]` metadata subtree, and of
 * the `labelMetadata` observation class alone. Decoding takes every entry of
 * that origin out of the payload entries (spec §4.6.4), so one keyed at a
 * payload path, or of a payload read class, is a payload label written as a
 * template, and reading it would drop that label from every payload lookup.
 */
export const isWellFormedLabelMetadataTemplateEntry = (
  entry: { readonly path: readonly string[]; readonly observes?: unknown },
): boolean =>
  entry.path[0] === "cfc" && entry.path[1] === "labels" &&
  entry.observes === "labelMetadata";

/**
 * A label-map entry of a readable envelope, with stored values of type
 * `Leaf` and a label of type `Label`. Members beyond these are kept by a
 * reader and not checked: the spec's entry carries view-specific
 * refinements beside the label (spec §4.6.4).
 */
export type StoredCfcLabelEntry<
  Leaf = unknown,
  Label = StoredInlineCfcLabel<Leaf> | StoredCfcLabelReference,
> = {
  readonly path: readonly string[];
  readonly label: Label;
  readonly origin?: Leaf;
  readonly observes?: Leaf;
};

/**
 * A stored envelope a reader can produce labels from, with stored values of
 * type `Leaf`, discriminated by version: a version-1 envelope holds every
 * label inline. A member beyond these does not make an envelope unreadable:
 * the version is how the format announces that it carries something a
 * reader cannot read, and the spec leaves a migrating writer free to keep a
 * legacy member beside the ones it defines (spec §4.6.4).
 */
export type StoredCfcEnvelope<Leaf = unknown> =
  | {
    readonly version: 1;
    readonly schemaHash: string;
    readonly labelMap: {
      readonly version: 1;
      readonly entries: readonly StoredCfcLabelEntry<
        Leaf,
        StoredInlineCfcLabel<Leaf>
      >[];
    };
  }
  | {
    readonly version: 2;
    readonly schemaHash: string;
    readonly labelMap: {
      readonly version: 1;
      readonly entries: readonly StoredCfcLabelEntry<Leaf>[];
    };
  };

/**
 * The rule a stored envelope breaks, which a reader that reports it names.
 *
 * - `record`: the envelope is not a record.
 * - `version`: its `version` is not one a reader interprets.
 * - `schema`: it names no schema, as `schemaHash`, that its labels were
 *   derived against (spec §4.6.4).
 * - `label-map`: it holds no `labelMap` of the one map version there is,
 *   with an array of entries.
 * - `entry-path`: an entry is not a record with a `path` of strings.
 * - `entry-label`: an entry's label is neither inline nor a reference.
 * - `version-1-reference`: a version-1 envelope holds a label by reference,
 *   a spelling version 1 does not define, so reading it as a label would
 *   drop the policy it names.
 * - `template-keying`: an entry of the label-metadata template origin is
 *   not keyed and classed as a template
 *   ({@link isWellFormedLabelMetadataTemplateEntry}).
 */
export type StoredCfcEnvelopeDefect =
  | "record"
  | "version"
  | "schema"
  | "label-map"
  | "entry-path"
  | "entry-label"
  | "version-1-reference"
  | "template-keying";

/**
 * The first rule the stored envelope `value` breaks, or `undefined` for one
 * a reader can produce labels from. The rules are checked in the order
 * {@link StoredCfcEnvelopeDefect} lists them, and entries in the order the
 * envelope holds them, each entry against every entry rule before the next
 * entry is checked.
 *
 * Whether the reserved member holds an envelope at all is the caller's to
 * decide first: `undefined`, `null` and the scalars are nothing stored, and
 * `record` is returned for them as for an array.
 */
export const storedCfcEnvelopeDefect = (
  value: unknown,
): StoredCfcEnvelopeDefect | undefined => {
  if (!isObjectNotArray(value)) return "record";
  const version = value.version;
  if (!isKnownCfcEnvelopeVersion(version)) return "version";
  if (typeof value.schemaHash !== "string") return "schema";
  const labelMap = value.labelMap;
  if (
    !isObjectNotArray(labelMap) || labelMap.version !== 1 ||
    !Array.isArray(labelMap.entries)
  ) {
    return "label-map";
  }
  for (const entry of labelMap.entries) {
    const defect = storedCfcEntryDefect(version, entry);
    if (defect !== undefined) return defect;
  }
  return undefined;
};

/**
 * Helper for {@link storedCfcEnvelopeDefect}, which returns the first entry
 * rule `entry`, held in an envelope of version `version`, breaks.
 */
const storedCfcEntryDefect = (
  version: StoredCfcEnvelopeVersion,
  entry: unknown,
): StoredCfcEnvelopeDefect | undefined => {
  if (
    !isObjectNotArray(entry) || !Array.isArray(entry.path) ||
    !entry.path.every((segment) => typeof segment === "string")
  ) {
    return "entry-path";
  }
  const { label } = entry;
  const reference = isCfcLabelReference(label);
  if (!reference && !isInlineCfcLabelShape(label)) return "entry-label";
  if (reference && version === 1) return "version-1-reference";
  if (
    isLabelMetadataTemplateEntry(entry) &&
    !isWellFormedLabelMetadataTemplateEntry({
      path: entry.path,
      observes: entry.observes,
    })
  ) {
    return "template-keying";
  }
  return undefined;
};

/**
 * Whether `value` is a stored envelope a reader can produce labels from:
 * one {@link storedCfcEnvelopeDefect} finds no defect in.
 */
export const isReadableStoredCfcEnvelope = (
  value: unknown,
): value is StoredCfcEnvelope => storedCfcEnvelopeDefect(value) === undefined;
