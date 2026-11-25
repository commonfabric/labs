/**
 * Reading a stored label map in a test. A version-2 envelope holds a label
 * longer than the inline limit as a reference to a `cid:` label document
 * (`docs/specs/content-addressed-cfc-labels.md`), so a test that reads the
 * stored `cfc` member and asserts on a label follows that reference first.
 * Nothing else about an entry changes, so the assertion still reads the
 * stored shape, with no canonicalization or decoding a reader would apply.
 */
import { isObjectNotArray } from "@commonfabric/js-values/types";
import { isCfcLabelReference } from "@commonfabric/memory/v2/cfc-stored-envelope";

/**
 * Reads the document `id` names as a replica holds it, or `undefined` when
 * there is none. A label document holds its label at `value`.
 */
export type StoredDocumentReader = (id: string) => unknown;

/**
 * The entries of the label map `cfc` holds, each with its label as written
 * or, for a label held by reference, the value of the `cid:` label document
 * the reference names, as `read` returns it. None when `cfc` holds no label
 * map. `Entry` is the shape the caller asserts on; it is not checked.
 *
 * @throws Error naming the document when a reference names one `read` does
 * not return, so a missing label document fails the test where it is read
 * rather than reading as an entry with no clauses.
 */
export const storedLabelEntries = <Entry = { label: unknown }>(
  cfc: unknown,
  read: StoredDocumentReader,
): Entry[] => {
  const labelMap = (cfc as { labelMap?: { entries?: unknown } } | undefined)
    ?.labelMap;
  const entries = Array.isArray(labelMap?.entries) ? labelMap.entries : [];
  return entries.map((entry) => {
    const label = (entry as { label?: unknown }).label;
    if (!isCfcLabelReference(label)) return entry as Entry;
    const document = read(label.$ref);
    if (!isObjectNotArray(document) || !("value" in document)) {
      throw new Error(`No label document ${label.$ref} to read`);
    }
    return { ...entry, label: document.value } as Entry;
  });
};
