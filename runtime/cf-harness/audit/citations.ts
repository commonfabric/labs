/**
 * The citation table: every clause of the agent-harness specification an
 * audit check is an expression of, and the exact words of that clause the
 * check turns on.
 *
 * A check that states its own rule in its own words is independent state, and
 * independent state diverges from the specification it was written against
 * without anything saying so. A citation closes that: the quote is copied out
 * of the document verbatim, so an edit that changes what the clause requires
 * breaks `test/citation-drift.test.ts` and reaches the check with it.
 *
 * Line numbers are deliberately absent. A clause id and a quote survive a
 * document being reordered; a line number names a different clause the moment
 * a paragraph is inserted above it.
 *
 * A check names a clause with a KIND, because there are two honest ways to
 * rest on one and they carry different authority. `required-by` says the
 * clause states the requirement the check enforces — a finding is the
 * specification speaking. `extends` says the check serves the clause's purpose
 * without the clause stating it — a finding is our judgment, and the clause is
 * why we think the judgment is worth having. Citing a clause as `required-by`
 * when it does not state the requirement lends specification authority to a
 * check the specification never asked for, which is the same divergence this
 * table exists to prevent, pointed inward.
 */

/**
 * How a check rests on a clause.
 *
 * - `required-by` — the clause states the requirement the check enforces.
 * - `extends` — the check serves the clause's purpose; the clause does not
 *   state the requirement. The finding is ours, not the specification's.
 */
export type CitationKind = "required-by" | "extends";

/** One clause an audit check rests on. */
export interface SpecCitation {
  /** Repo-relative path of the document holding the clause. */
  doc: string;

  /**
   * The clause's stable id — `AH-CFC-11` for a numbered clause, or a section
   * heading's number where the sentence sits in a section's prose rather than
   * under a numbered clause.
   */
  clause: string;

  /**
   * The words of the clause the check turns on, copied verbatim. A quote
   * spanning a line break in the source carries the break as a single space:
   * the drift test normalizes the document's whitespace the same way before
   * looking for it, so a rewrap is not drift and a rewording is.
   */
  quote: string;
}

const CFC_SPEC = "docs/specs/agent-harness/02-cfc-integration.md";
const RUNTIME_SPEC = "docs/specs/agent-harness/01-runtime-contract.md";
const MATRIX_SPEC = "docs/specs/cfc-enforcement-matrix.md";
const SQLITE_CFC_SPEC = "docs/specs/sqlite-builtin/06-cfc.md";

/**
 * Every citation the checks draw on, keyed by the clause id where the clause
 * is numbered and by a section-scoped key where it is not.
 */
export const SPEC_CITATIONS = {
  "AH-CFC-3": {
    doc: CFC_SPEC,
    clause: "AH-CFC-3",
    quote:
      "Direct-command authority MUST depend on trusted `PromptSlotBound` evidence binding the kernel name, the authenticated subject, the named surface, the slot role, and a digest of the exact value carrying the authority.",
  },
  "AH-CFC-6": {
    doc: CFC_SPEC,
    clause: "AH-CFC-6",
    quote:
      "Before an observation is exposed to a model in an enforcing profile, the harness MUST receive trusted mediation metadata or return a typed opaque/denied observation.",
  },
  "AH-CFC-7": {
    doc: CFC_SPEC,
    clause: "AH-CFC-7",
    quote:
      "Labels on observations exposed to the model MUST be accumulated as influence on subsequent model-authored invocation inputs. Opaque or denied observations MUST NOT be accumulated as if their content were visible.",
  },
  "AH-CFC-8": {
    doc: CFC_SPEC,
    clause: "AH-CFC-8",
    quote:
      "Explicit trusted input labels and derived prompt-influence labels MUST remain distinguishable.",
  },
  "AH-CFC-9": {
    doc: CFC_SPEC,
    clause: "AH-CFC-9",
    quote:
      "A side-effect request MUST carry the direct-command evidence and input influence labels required by the selected CFC runtime profile.",
  },
  "AH-CFC-11": {
    doc: CFC_SPEC,
    clause: "AH-CFC-11",
    quote:
      "Policy denial MUST be recorded as a policy event and exposed to the model only through the profile's typed deny/recovery channel.",
  },
  "AH-CFC-12": {
    doc: CFC_SPEC,
    clause: "AH-CFC-12",
    quote:
      "A child receives only the authority, labels, skills, and capabilities explicitly bound to the child profile.",
  },
  "AH-CFC-12a": {
    doc: CFC_SPEC,
    clause: "AH-CFC-12a",
    quote:
      "A child profile SHOULD carry a confidentiality ceiling bounding what the child may observe, through inherited handles, arguments, mounted files, and any other labeled channel.",
  },
  "AH-CFC-13": {
    doc: CFC_SPEC,
    clause: "AH-CFC-13",
    quote:
      "Child artifacts and raw browser/network observations remain under the child boundary.",
  },
  "AH-CFC-14": {
    doc: CFC_SPEC,
    clause: "AH-CFC-14",
    quote:
      "The selected mode and any fallback MUST be present in the run snapshot and report.",
  },
  "AH-CFC-15": {
    doc: CFC_SPEC,
    clause: "AH-CFC-15",
    quote: "It MUST NOT silently fall back from an enforcing mode.",
  },
  "AH-CFC-16": {
    doc: CFC_SPEC,
    clause: "AH-CFC-16",
    quote:
      "The artifact boundary MUST retain prompt-slot evidence, invocation-context references, mediation dispositions, policy events, model-context influence state, and side-effect decisions sufficient to explain why a tool result was exposed or denied.",
  },
  "AH-CFC-18": {
    doc: CFC_SPEC,
    clause: "AH-CFC-18",
    quote:
      "Possession or successful resolution of a handle supplies neither prompt-slot authority nor a CFC release; the resulting invocation remains subject to the same label, authority, and side-effect checks as a directly supplied reference.",
  },
  "AH-CFC-19": {
    doc: CFC_SPEC,
    clause: "AH-CFC-19",
    quote:
      "Their access, retention, child-transfer, and model-disclosure boundaries MUST be at least as strict as those of the canonical references they contain.",
  },
  "AH-CFC-modes-observe": {
    doc: CFC_SPEC,
    clause: "§6 Enforcement modes",
    quote:
      "This is a diagnostic mode and MUST NOT be described as CFC enforcement.",
  },
  "MATRIX-conforming": {
    doc: MATRIX_SPEC,
    clause: "\u00a73 Conforming deployment states",
    quote:
      "A **conforming state** is one where no enforcement consumes a label the flow dial is not yet producing.",
  },
  "MATRIX-strict-persist": {
    doc: MATRIX_SPEC,
    clause: "\u00a73 Non-conforming",
    quote:
      "any `enforce-strict` with `cfcFlowLabels \u2260 persist` (strict consumes derived labels the dial isn't producing)",
  },
  "MATRIX-persist-pointless": {
    doc: MATRIX_SPEC,
    clause: "\u00a73 Non-conforming",
    quote:
      "is *permitted but pointless* (labels written, never consulted) \u2014 a warning, not an error.",
  },
  "MATRIX-floor-credits-nothing": {
    doc: MATRIX_SPEC,
    clause: "\u00a72 rule 3",
    quote:
      "the floor credits the flow meet only when `cfcFlowLabels: persist` (else it credits nothing, fail-closed)",
  },
  "MATRIX-trigger-one-hop": {
    doc: MATRIX_SPEC,
    clause: "\u00a72 rule 4",
    quote:
      "Multi-hop closure requires `cfcFlowLabels: persist` stamping the intermediate doc's derived label so the second hop's trigger read picks it up.",
  },
  "SQLITE-CFC-read-labels": {
    doc: SQLITE_CFC_SPEC,
    clause: "\u00a7 Read \u2014 sound column provenance, per-field labels",
    quote:
      "writes the result rows under a **per-field label schema** (`labelResultSchema`), so a consumer reading `resultOf(q).rows[i].<col>` inherits that column's label",
  },
  "AH-LIFE-6": {
    doc: RUNTIME_SPEC,
    clause: "AH-LIFE-6",
    quote:
      "It MUST preserve the active instructions, prompt-role distinctions, authority evidence, and valid tool-call/tool-result relationships required by the selected provider protocol.",
  },
  "AH-TOOL-3": {
    doc: RUNTIME_SPEC,
    clause: "AH-TOOL-3",
    quote:
      "Every tool call MUST record the tool identity, bounded input summary, outcome, timing, and policy/mediation disposition.",
  },
} as const satisfies Record<string, SpecCitation>;

/** A key of {@link SPEC_CITATIONS}. */
export type SpecCitationKey = keyof typeof SPEC_CITATIONS;

/** One clause a check rests on, and how. */
export interface CheckCitation extends SpecCitation {
  kind: CitationKind;
}

/**
 * Clauses that STATE what the check enforces. A finding citing one of these
 * is the specification speaking.
 */
export const requiredBy = (
  ...keys: readonly SpecCitationKey[]
): readonly CheckCitation[] =>
  keys.map((key) => ({ ...SPEC_CITATIONS[key], kind: "required-by" }));

/**
 * Clauses whose purpose the check serves without their stating its
 * requirement. A finding citing only these is our judgment, and says so.
 */
export const extendsClause = (
  ...keys: readonly SpecCitationKey[]
): readonly CheckCitation[] =>
  keys.map((key) => ({ ...SPEC_CITATIONS[key], kind: "extends" }));
