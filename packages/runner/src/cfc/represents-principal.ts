/**
 * Which principal a CFC label says its value represents, read from the label's
 * `represents-principal` integrity atoms.
 *
 * A trusted surface that checks an author claim asks this of the claim's
 * label: `cf-cfc-authorship` on the main thread, and the HTML renderer's text
 * integrity boundary in the worker. The module depends on nothing but the
 * label view's type and `@commonfabric/utils`, so that either can import it
 * without the rest of the CFC machinery.
 */
import { isObjectNotArray } from "@commonfabric/utils/types";
import type { CfcLabelView } from "./label-view-core.ts";

const REPRESENTS_PRINCIPAL = "represents-principal";

/**
 * The DID a `represents-principal` integrity atom names, in either the object
 * form (`{ kind, subject }`) or the string form (`represents-principal:<did>`),
 * trimmed; `undefined` for any other atom, or for one naming no DID.
 */
export const representsPrincipalSubject = (
  atom: unknown,
): string | undefined => {
  if (typeof atom === "string") {
    if (!atom.startsWith(`${REPRESENTS_PRINCIPAL}:`)) {
      return undefined;
    }
    const subject = atom.slice(REPRESENTS_PRINCIPAL.length + 1).trim();
    return subject.length > 0 ? subject : undefined;
  }
  if (!isObjectNotArray(atom)) {
    return undefined;
  }
  const record = atom as Record<string, unknown>;
  if (
    record.kind !== REPRESENTS_PRINCIPAL || typeof record.subject !== "string"
  ) {
    return undefined;
  }
  const subject = record.subject.trim();
  return subject.length > 0 ? subject : undefined;
};

/** Every DID the `represents-principal` atoms of `entries` name, in order. */
export const representsPrincipalSubjects = (
  entries: CfcLabelView["entries"],
): string[] =>
  entries.flatMap((entry) =>
    (entry.label.integrity ?? []).flatMap((atom) => {
      const subject = representsPrincipalSubject(atom);
      return subject === undefined ? [] : [subject];
    })
  );

/**
 * The DIDs that could be the principal the value labeled by `view` represents,
 * as an author claim is checked against: each distinct DID a
 * `represents-principal` atom names at the root or on a top-level field, in
 * order of first appearance. A profile's owner-protected fields carry their
 * owner's atom at their own top-level paths; atoms deeper down come from
 * documents the value links, and are not counted. One DID is the principal.
 * None means the label names no principal. More than one means it names no
 * single principal, and a claim resting on it must not verify.
 */
export const authorPrincipalCandidates = (
  view: CfcLabelView | undefined,
): string[] =>
  view === undefined ? [] : [
    ...new Set(
      representsPrincipalSubjects(
        view.entries.filter((entry) => entry.path.length <= 1),
      ),
    ),
  ];
