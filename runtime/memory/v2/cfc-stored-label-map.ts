/**
 * How the store reads the label map of a document's `cfc` member: its
 * entries, a label held by reference, and the confidentiality a label holds.
 * The store reads the member a writer hands it without trusting its shape, so
 * every reader here takes `unknown` and says what it could not read rather
 * than guessing. Shared by the store's admission of a dropped declared path
 * (`envelope-admission.ts`) and its judgment of a release by intent
 * (`cfc-owner-release-by-intent.ts`).
 */

import { isObjectNotArray } from "@commonfabric/js-values/types";

/** One label-map entry, as far as the store reads it. */
export interface StoredLabelMapEntry {
  /** The entry's path, unchecked. */
  readonly path: unknown;

  /** The entry's component, unchecked. */
  readonly origin: unknown;

  /** The entry's observation class, unchecked. */
  readonly observes: unknown;

  /** The entry's label, inline or by reference, unchecked. */
  readonly label: unknown;
}

/**
 * The entries of the label map `cfc` holds, each a record, or none when `cfc`
 * holds no label map.
 */
export const storedLabelMapEntries = (
  cfc: unknown,
): readonly StoredLabelMapEntry[] => {
  if (!isObjectNotArray(cfc)) return [];
  const labelMap = cfc.labelMap;
  if (!isObjectNotArray(labelMap) || !Array.isArray(labelMap.entries)) {
    return [];
  }
  return labelMap.entries.filter(isObjectNotArray).map((entry) => ({
    path: entry.path,
    origin: entry.origin,
    observes: entry.observes,
    label: entry.label,
  }));
};

/**
 * `label` itself, or the content of the label document a single-member
 * `{ $ref: "cid:…" }` record names, or `undefined` when that document isn't
 * there, or when the reference names anything but a `cid:` document.
 * `resolveLabel` returns the content of the label document a `cid:`
 * reference names, or `undefined` when there is none.
 */
export const resolveStoredLabel = (
  label: unknown,
  resolveLabel: (ref: string) => unknown,
): unknown => {
  if (
    isObjectNotArray(label) && Object.keys(label).length === 1 &&
    typeof label.$ref === "string"
  ) {
    return label.$ref.startsWith("cid:") ? resolveLabel(label.$ref) : undefined;
  }
  return label;
};

/**
 * The confidentiality clauses a resolved label holds, none when it holds no
 * `confidentiality`, or `undefined` when the label is not a record or its
 * `confidentiality` is not a list, so what it holds is not known.
 */
export const storedConfidentiality = (
  label: unknown,
): readonly unknown[] | undefined => {
  if (!isObjectNotArray(label)) return undefined;
  const confidentiality = label.confidentiality;
  if (confidentiality === undefined) return [];
  return Array.isArray(confidentiality) ? confidentiality : undefined;
};
