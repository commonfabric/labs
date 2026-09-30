/**
 * Contract shapes of the documentation corpus `research` inspects, and
 * the integrity endorsement that says where a piece of it came from.
 *
 * The endorsement is the whole trust story of this corpus. Operator-provisioned
 * reference material is trusted for confidentiality — the operator mounted it,
 * it carries no secret — and endorsed for integrity provenance, so a reader of
 * a run can tell reference material apart from a file some earlier child wrote
 * into the workspace. A section carrying no endorsement is not corpus, and an
 * answer cannot be built out of it.
 *
 * Shapes and the mint only. Reading the roots lives in `../docs-corpus/`.
 */

import { cfcAtom, type CfcResourceAtom } from "@commonfabric/api/cfc";

/**
 * Resource classes the harness names in a label of its own, following the
 * `CFC_<subsystem>_ATOM_CLASS` table `CFC_FUSE_ATOM_CLASS` establishes: a
 * class string under the existing `Resource` atom family rather than a new
 * atom type in the spec registry.
 */
export const CFC_HARNESS_ATOM_CLASS = {
  OperatorProvisionedReference:
    "CommonFabricHarnessOperatorProvisionedReference",
} as const;

/**
 * The integrity endorsement carried by a section the corpus admitted, naming
 * the configured root it was read under.
 *
 * Every field is host-observed: the class is this module's constant and the
 * subject is the operator's own root path, so nothing in the read bytes can
 * decide what the atom says about them.
 */
export const operatorProvisionedReferenceAtom = (
  corpusRoot: string,
): CfcResourceAtom =>
  cfcAtom.resource(
    CFC_HARNESS_ATOM_CLASS.OperatorProvisionedReference,
    corpusRoot,
  );

/** Whether `atom` endorses a value as operator-provisioned reference material. */
export const isOperatorProvisionedReferenceAtom = (
  atom: CfcResourceAtom,
): boolean =>
  atom.class === CFC_HARNESS_ATOM_CLASS.OperatorProvisionedReference;

/**
 * One addressable piece of the corpus: the text under a single heading of a
 * single Markdown file, with the endorsement the loader stamped on it.
 *
 * The heading is the address as much as the path is. A query returns the
 * section rather than the file, so a citation names a place a reader can open
 * rather than a document they then have to search.
 */
export interface HarnessDocsCorpusSection {
  /** Corpus-relative path of the file, in `<root name>/<path>` form. */
  path: string;

  /**
   * Heading text the section sits under, without its `#` markers. Empty for
   * the text above a file's first heading.
   */
  heading: string;

  /** Document's first top-level heading, when retained by the corpus loader. */
  documentTitle?: string;

  /** Ancestor headings followed by this section's heading. */
  headingPath?: readonly string[];

  text: string;

  /** The endorsement, which is what made this text eligible for an answer. */
  integrity: readonly CfcResourceAtom[];
}

/**
 * Where an answer came from, as the child may name it. A citation carries no
 * text and no handle: what it addresses is a place in the corpus, and reading
 * that place is a separate act by whoever is entitled to.
 */
export interface HarnessDocsCitation {
  path: string;
  heading: string;
}

/**
 * Where this run's corpus came from. `checkout-default` is the labs checkout
 * the harness is running out of, which is what a console started with no
 * documentation configuration gets; `configured` is an operator's own
 * `--docs-corpus-root`. Recorded in run state and printed in operator output,
 * because a dial nobody can see is a dial nobody can question.
 */
export type HarnessDocsCorpusSource = "configured" | "checkout-default";

/** The corpus dial this run resolved, as it stands before any load. */
export interface HarnessDocsCorpusRecord {
  type: "cf-harness.docs-corpus-record";
  source: HarnessDocsCorpusSource;
  roots: readonly string[];
}

/** Whether two corpus records name the same documentation from the same place. */
export const harnessDocsCorpusRecordsEqual = (
  left: HarnessDocsCorpusRecord,
  right: HarnessDocsCorpusRecord,
): boolean =>
  left.source === right.source &&
  left.roots.length === right.roots.length &&
  left.roots.every((root, index) => root === right.roots[index]);

/** A corpus record as an operator message names it. */
export const describeHarnessDocsCorpus = (
  record: HarnessDocsCorpusRecord,
): string =>
  record.roots.length === 0
    ? "no corpus"
    : `${record.source} ${record.roots.join(", ")}`;

/** The citation form of a section. */
export const citationOfSection = (
  section: HarnessDocsCorpusSection,
): HarnessDocsCitation => ({
  path: section.path,
  heading: section.heading,
});
