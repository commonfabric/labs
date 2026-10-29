/**
 * Content-addressed label documents: the `cid:` documents a version-2 CFC
 * envelope names its labels by, the canonical content that decides a
 * label's document id, the inline limit below which a label stays inline,
 * and the realm-wide registry of verified label documents. The design is
 * `docs/specs/content-addressed-cfc-labels.md`. Nothing here reads
 * storage; resolution through a transaction is `metadata.ts`.
 */

import { deepFreeze, taggedHashStringOf } from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { canonicalizeCfcLabel } from "./canonical.ts";
import type { IFCLabel } from "./label-view-core.ts";
import { onSchemaRegistryClear } from "../schema-registry.ts";
import type {
  CfcLabelReference,
  LabelMapEntry,
  StoredLabelMapEntry,
} from "./types.ts";

/**
 * The length of a label's canonical JSON, in UTF-8 bytes, above which a
 * version-2 envelope stores it by reference. A reference is 63 bytes, so
 * below two references' worth the saving is under half the label and the
 * document costs more than it saves. Part of the versioned envelope
 * contract: the same label takes the same form wherever it is written, so
 * it hashes to one document rather than existing as two spellings.
 */
export const CFC_LABEL_INLINE_LIMIT = 128;

const utf8 = new TextEncoder();

const CID_PREFIX = "cid:";

/** Whether a stored entry's label is a reference rather than an inline label. */
export const isCfcLabelReference = (
  value: unknown,
): value is CfcLabelReference =>
  isObjectNotArray(value) && typeof value.$ref === "string" &&
  Object.keys(value).length === 1;

/**
 * The document hash a label reference names, or `undefined` for a reference
 * outside the `cid:` namespace. The hash is the part after the prefix, the
 * form `schemaHash` carries and `cid:<hash>` documents are addressed by.
 */
export const parseCfcLabelReference = (
  reference: CfcLabelReference,
): string | undefined =>
  reference.$ref.startsWith(CID_PREFIX) &&
    reference.$ref.length > CID_PREFIX.length
    ? reference.$ref.slice(CID_PREFIX.length)
    : undefined;

const LABEL_MEMBERS = ["confidentiality", "integrity"] as const;

/**
 * Whether `value` has the shape of a label document's content: a record
 * whose every member is one of the two label members holding an array.
 * A record of any other shape hashes like any other value, so the content
 * hash alone cannot tell a label from a document that merely verifies;
 * this is the check that keeps a malformed document from resolving as a
 * label whose members a consumer then reads as empty.
 */
export const isCfcLabelDocumentContent = (value: unknown): value is IFCLabel =>
  isObjectNotArray(value) &&
  Object.keys(value).every((key) =>
    (LABEL_MEMBERS as readonly string[]).includes(key) &&
    Array.isArray(value[key])
  );

/**
 * Whether `value` has the shape of an inline label as an envelope stores
 * one: a record whose every member is one of the two label members holding
 * an array or `undefined`. Like {@link isCfcLabelDocumentContent}, except
 * that an absent member may be present as `undefined`, which a stored
 * inline label may carry and a document never does.
 */
export const isInlineCfcLabelShape = (value: unknown): value is IFCLabel =>
  isObjectNotArray(value) &&
  Object.keys(value).every((key) =>
    (LABEL_MEMBERS as readonly string[]).includes(key) &&
    (value[key] === undefined || Array.isArray(value[key]))
  );

/**
 * Whether `value` has the shape of a stored entry: a record with a `path`
 * of strings and a `label` that is either a reference or an inline label.
 * An entry of any other shape is one no reader can produce a label from,
 * and the envelope holding it is unreadable. A member beyond those is not
 * such a shape: the spec's entry carries view-specific refinements beside
 * the label (spec §4.6.4), so an entry this build reads fewer members of
 * is one it still reads the label of.
 */
export const isStoredLabelMapEntry = (
  value: unknown,
): value is StoredLabelMapEntry =>
  isObjectNotArray(value) && Array.isArray(value.path) &&
  value.path.every((segment) => typeof segment === "string") &&
  (isCfcLabelReference(value.label) || isInlineCfcLabelShape(value.label));

/**
 * The canonical content of a label document: the label with its clauses
 * normalized and every `undefined` member dropped, so a label written with
 * `integrity: undefined` and one written without the member are one
 * document. Only the two label members survive, each as a fresh array;
 * the clause and atom objects inside them are shared with the caller's
 * label, and registration deep-freezes them in place, which the CFC
 * immutability contract already promises of every label value.
 */
export const cfcLabelDocumentContent = (label: IFCLabel): IFCLabel => {
  const canonical = canonicalizeCfcLabel(label);
  const content: IFCLabel = {};
  if (canonical.confidentiality !== undefined) {
    content.confidentiality = [...canonical.confidentiality];
  }
  if (canonical.integrity !== undefined) {
    content.integrity = [...canonical.integrity];
  }
  return content;
};

/** The id hash of the label document holding `content`. */
export const cfcLabelDocumentHash = (content: IFCLabel): string =>
  taggedHashStringOf(content);

/**
 * Whether a label's canonical content is stored by reference in a
 * version-2 envelope: its JSON, encoded as UTF-8, is longer than
 * {@link CFC_LABEL_INLINE_LIMIT} bytes. A pure function of the content,
 * which is what makes the stored form canonical.
 */
export const cfcLabelTakesReference = (content: IFCLabel): boolean =>
  utf8.encode(JSON.stringify(content)).length > CFC_LABEL_INLINE_LIMIT;

/** Thrown when a label document's content does not hash to its claimed id. */
export class CfcLabelDocumentHashMismatchError extends Error {
  constructor(readonly claimed: string, readonly actual: string) {
    super(
      `CFC label document content does not match its id: claimed \`${claimed}\`, hashed \`${actual}\``,
    );
    this.name = "CfcLabelDocumentHashMismatchError";
  }
}

/** Thrown when a value registered as a label document is not label-shaped. */
export class CfcLabelDocumentMalformedError extends Error {
  constructor(readonly hash: string) {
    super(
      `CFC label document \`${hash}\` does not hold a label: every member must be \`confidentiality\` or \`integrity\` holding an array`,
    );
    this.name = "CfcLabelDocumentMalformedError";
  }
}

// The realm-wide index from label document hash to verified label, with the
// schema registry's retention: an entry is content-verified at registration
// so it can only ever be the one value its key names, and the index clears
// when the last schema-registry lease releases, so a document resolves for
// as long as a session can read the envelope naming it.
const labelsByHash = new Map<string, IFCLabel>();

onSchemaRegistryClear(() => labelsByHash.clear());

/**
 * Registers `label` as the content of the label document `hash` names,
 * checking its shape and verifying the content against the claim first —
 * a malformed value throws {@link CfcLabelDocumentMalformedError}, a
 * mismatch {@link CfcLabelDocumentHashMismatchError}, and neither enters
 * the registry. Returns the registered label, deep-frozen: an entry is
 * shared realm-wide under a hash that names its content, so nothing may
 * change it after the verification. Freezing is in place, as interning a
 * schema is; the content a caller registers is a document's value, which
 * is immutable by contract. Registering a hash twice is idempotent by
 * construction: only one content can verify against it.
 */
export const registerCfcLabelDocument = (
  hash: string,
  label: IFCLabel,
): IFCLabel => {
  if (!isCfcLabelDocumentContent(label)) {
    throw new CfcLabelDocumentMalformedError(hash);
  }
  const actual = cfcLabelDocumentHash(label);
  if (actual !== hash) {
    throw new CfcLabelDocumentHashMismatchError(hash, actual);
  }
  const existing = labelsByHash.get(hash);
  if (existing !== undefined) return existing;
  const frozen = deepFreeze(label);
  labelsByHash.set(hash, frozen);
  return frozen;
};

/**
 * The registered label document for `hash`, or `undefined` when none has
 * been registered. A miss is recoverable — the document may arrive by sync
 * later — which is why a resolution failure is never memoized.
 */
export const lookupCfcLabelDocument = (hash: string): IFCLabel | undefined =>
  labelsByHash.get(hash);

/**
 * The version-2 stored form of resolved entries: each label's canonical
 * content, held inline when it fits under the limit and otherwise replaced
 * by a reference to the document `stage` installs for it. `stage` returns
 * the staged document's id (`cid:<hash>`), and the content is registered
 * under that hash so the label resolves in this session before the commit
 * lands. Entries keep their `path`, `origin`, and `observes` inline.
 */
export const storedLabelMapEntries = (
  entries: readonly LabelMapEntry[],
  stage: (content: IFCLabel) => string,
): StoredLabelMapEntry[] =>
  entries.map((entry) => {
    const content = cfcLabelDocumentContent(entry.label);
    if (!cfcLabelTakesReference(content)) {
      return { ...entry, label: content };
    }
    const id = stage(content);
    const reference: CfcLabelReference = { $ref: id };
    const hash = parseCfcLabelReference(reference);
    if (hash === undefined) {
      throw new Error(
        `staged label document id \`${id}\` is outside the cid: namespace`,
      );
    }
    registerCfcLabelDocument(hash, content);
    return { ...entry, label: reference };
  });

/**
 * The label document hashes a stored envelope's entries reference, in
 * entry order and deduplicated. A reference outside the `cid:` namespace
 * contributes nothing here; resolution refuses it.
 */
export const referencedCfcLabelDocumentHashes = (
  entries: readonly StoredLabelMapEntry[],
): string[] => {
  const hashes: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isCfcLabelReference(entry.label)) continue;
    const hash = parseCfcLabelReference(entry.label);
    if (hash === undefined || seen.has(hash)) continue;
    seen.add(hash);
    hashes.push(hash);
  }
  return hashes;
};

/**
 * The label document hashes the value at a document's reserved `cfc`
 * member references, for a value of any shape: none unless it is a
 * version-2 envelope with an entries array, since only version 2 defines
 * the reference, and otherwise {@link referencedCfcLabelDocumentHashes}
 * over whatever entries it holds. This is the one scan every delivery seam
 * — traversal, direct loads, arrival hydration — applies, so they agree on
 * which documents an envelope is owed.
 */
export const cfcEnvelopeLabelDocumentHashes = (cfc: unknown): string[] => {
  if (!isObjectNotArray(cfc) || cfc.version !== 2) return [];
  const labelMap = cfc.labelMap;
  const entries = isObjectNotArray(labelMap) ? labelMap.entries : undefined;
  if (!Array.isArray(entries)) return [];
  return referencedCfcLabelDocumentHashes(
    entries.filter(isObjectNotArray) as StoredLabelMapEntry[],
  );
};
