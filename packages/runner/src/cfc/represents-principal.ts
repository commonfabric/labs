/**
 * How a CFC label names a principal in its integrity, and which principal a
 * label says its value represents.
 *
 * This module is the one definition of a principal claim that both sides use.
 * The runtime's write check (`prepare.ts`) refuses a pattern-authored claim in
 * any spelling a reader could take for one naming a principal, and the readers
 * accept only the canonical spelling: a trusted surface checking an author
 * claim asks this of the claim's label, `cf-cfc-authorship` on the main thread
 * and the HTML renderer's text integrity boundary in the worker. The module
 * depends on nothing but the label view's type, `@commonfabric/utils`, and
 * `@commonfabric/identity/did`, so that either can import it without the rest
 * of the CFC machinery.
 */
import { isWellFormedDID } from "@commonfabric/identity/did";
import { isObjectNotArray } from "@commonfabric/utils/types";
import type { CfcLabelView } from "./label-view-core.ts";

const REPRESENTS_PRINCIPAL = "represents-principal";

/**
 * The kinds of integrity atom that name a principal as their `subject`: the
 * current-principal claim family. A pattern may attach one only with the
 * subject left for the runtime to resolve, which `prepare.ts` checks with
 * {@link principalClaimSpelling} and {@link subjectResemblesPrincipal}.
 */
export const PRINCIPAL_CLAIM_KINDS: ReadonlySet<string> = new Set([
  "authored-by",
  REPRESENTS_PRINCIPAL,
]);

/**
 * How `atom` is spelled if it could be taken for a principal claim: `"object"`
 * for an object whose `kind` is one of {@link PRINCIPAL_CLAIM_KINDS}, and
 * `"string"` for a string that begins with one of those kinds and a colon,
 * ignoring case and surrounding whitespace. `undefined` for anything else.
 *
 * The recognition is deliberately wider than {@link principalClaimSubject}:
 * the write check refuses every spelling here that is not the canonical one,
 * so a reader anywhere that accepts more than the canonical form still reads
 * nothing a pattern wrote.
 */
export const principalClaimSpelling = (
  atom: unknown,
): "object" | "string" | undefined => {
  if (typeof atom === "string") {
    const text = atom.trim().toLowerCase();
    for (const kind of PRINCIPAL_CLAIM_KINDS) {
      if (text.startsWith(`${kind}:`)) return "string";
    }
    return undefined;
  }
  if (atom === null || typeof atom !== "object") return undefined;
  const kind = (atom as { kind?: unknown }).kind;
  return typeof kind === "string" && PRINCIPAL_CLAIM_KINDS.has(kind)
    ? "object"
    : undefined;
};

/**
 * The subject a principal claim of `kind` names, read the one way every reader
 * reads it: `atom` is an object whose `kind` is exactly `kind`, and its
 * `subject` is a non-empty string, returned as written. Any other spelling,
 * the `<kind>:<subject>` string form among them, names nothing.
 */
export const principalClaimSubject = (
  atom: unknown,
  kind: string,
): string | undefined => {
  if (!isObjectNotArray(atom)) return undefined;
  const record = atom as Record<string, unknown>;
  return record.kind === kind && typeof record.subject === "string" &&
      record.subject.length > 0
    ? record.subject
    : undefined;
};

/**
 * Whether a claim subject could be taken for a principal: a string that
 * begins with `did:` once surrounding whitespace is removed and case ignored.
 * The write check refuses a pattern-authored subject for which this holds.
 */
export const subjectResemblesPrincipal = (subject: unknown): boolean =>
  typeof subject === "string" &&
  subject.trim().toLowerCase().startsWith("did:");

/**
 * The DID a `represents-principal` integrity atom names: the subject
 * {@link principalClaimSubject} reads, when it is a well-formed DID as
 * written. `undefined` for any other atom, including the string form and a
 * subject with surrounding whitespace.
 */
export const representsPrincipalSubject = (
  atom: unknown,
): string | undefined => {
  const subject = principalClaimSubject(atom, REPRESENTS_PRINCIPAL);
  return isWellFormedDID(subject) ? subject : undefined;
};

/**
 * Every DID the `represents-principal` atoms of `entries` name, in order. An
 * entry a link carries from the document it points to (`observes` of
 * `followRef`) is skipped: it says whom that document represents, not whom
 * the one holding the link does.
 */
export const representsPrincipalSubjects = (
  entries: CfcLabelView["entries"],
): string[] =>
  entries.flatMap((entry) =>
    entry.observes === "followRef"
      ? []
      : (entry.label.integrity ?? []).flatMap((atom) => {
        const subject = representsPrincipalSubject(atom);
        return subject === undefined ? [] : [subject];
      })
  );

/**
 * The DIDs that could be the principal the value labeled by `view` represents,
 * as an author claim is checked against: each distinct DID a
 * `represents-principal` atom names at the root or on a top-level field, in
 * order of first appearance. A profile's owner-protected fields carry their
 * owner's atom at their own top-level paths. Atoms deeper down come from
 * documents the value links, and an entry a link carried (`followRef`) at any
 * path describes the linked document; neither is counted. One DID is the
 * principal.
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
