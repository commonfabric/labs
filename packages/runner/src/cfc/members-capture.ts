/**
 * The label-capture check for an authored `Members` clause (spec §8.7.5). An
 * output whose schema declares `ifc.members` names a list position of its own
 * run; at capture the runtime adds `[User(Q) ∨ Members(list, S)]` to the
 * output's label when the writing run's actor `Q` is the sole owner of the
 * subject `S` of exactly one module-policy clause the output carries, the
 * output and the list belong to one run of the module that clause names, and
 * the list is `Q`'s. Anything else refuses the write.
 *
 * The decision is {@link membersCaptureClause}, over a
 * {@link MembersCaptureReads} the caller backs with storage reads, so every
 * refusal is decided here and nowhere else.
 */

import {
  CFC_ATOM_TYPE,
  cfcAtom,
  type CfcListPosition,
  type CfcModulePolicyRefAtom,
  type CfcPolicySubjectCommitment,
} from "@commonfabric/api/cfc";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectNotArray } from "@commonfabric/utils/types";

import {
  type CfcConfClause,
  type CfcOrClause,
  clauseAlternatives,
  normalizeClause,
} from "./clause.ts";
import { commitmentAwareEquals } from "./label-representation.ts";
import { isExactModulePolicyRef } from "./policy.ts";

/** A run of a pattern: its result document and the module it runs. */
export type PatternRun = {
  readonly resultId: string;
  readonly moduleIdentity: string;
};

/**
 * The storage reads the check consults. Each returns `undefined` when the
 * thing cannot be read, which the check treats as a refusal.
 */
export type MembersCaptureReads = {
  /** The principals a space's ACL names `OWNER`. */
  readonly owners: (space: string) => readonly string[] | undefined;

  /** The run a document belongs to. */
  readonly runOf: (
    document: { space: string; id: string },
  ) => PatternRun | undefined;

  /**
   * The principals the stored label at a position names as its owner
   * (spec §8.15.4), and whether its schema declares writers.
   */
  readonly position: (
    position: CfcListPosition,
  ) => { owners: readonly string[]; declaresWriter: boolean } | undefined;

  /**
   * The document a link held at the position names, `"none"` when the
   * position holds the list inline.
   */
  readonly linkTarget: (
    position: CfcListPosition,
  ) => CfcListPosition | "none" | undefined;
};

export type MembersCaptureInput = {
  /** The writing run's acting principal. */
  readonly actingPrincipal: string | undefined;

  /** The output's `ifc.members` value: a pointer into its run's result. */
  readonly members: unknown;

  /** The document the output is written to. */
  readonly target: { readonly space: string; readonly id: string };

  /** The confidentiality the write carries in from its inputs. */
  readonly flowConfidentiality: readonly CfcConfClause[];
};

export type MembersCaptureResult =
  | { readonly clause: CfcConfClause }
  | { readonly refusal: string };

/** Parses an RFC 6901 pointer; `undefined` for anything else. */
const parsePointer = (pointer: unknown): string[] | undefined => {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    return undefined;
  }
  if (pointer === "/") return [];
  return pointer.slice(1).split("/").map((segment) =>
    segment.replaceAll("~1", "/").replaceAll("~0", "~")
  );
};

/** Whether `owners` names `principal` as the one owner. */
const soleOwner = (
  owners: readonly string[] | undefined,
  principal: string,
): boolean => owners !== undefined && deepEqual(owners, [principal]);

/**
 * Whether `principal` solely owns `subject`: a plaintext subject by its ACL;
 * a committed one only as the principal's own Home space, whose identity is
 * the principal's, compared without opening the commitment.
 */
const solelyOwns = (
  reads: MembersCaptureReads,
  subject: string | CfcPolicySubjectCommitment,
  principal: string,
): boolean => {
  if (typeof subject === "string") {
    return soleOwner(reads.owners(subject), principal);
  }
  return commitmentAwareEquals(subject, principal) &&
    soleOwner(reads.owners(principal), principal);
};

/** The module-policy references a confidentiality label carries. */
const modulePolicyRefs = (
  confidentiality: readonly CfcConfClause[],
): readonly CfcModulePolicyRefAtom[] => {
  const refs: CfcModulePolicyRefAtom[] = [];
  for (const clause of confidentiality) {
    for (const alternative of clauseAlternatives(clause)) {
      if (
        isExactModulePolicyRef(alternative) &&
        !refs.some((ref) => deepEqual(ref, alternative))
      ) {
        refs.push(alternative);
      }
    }
  }
  return refs;
};

/** Whether a position is the actor's, and declares who writes it. */
const ownedPosition = (
  reads: MembersCaptureReads,
  position: CfcListPosition,
  principal: string,
): boolean => {
  const stored = reads.position(position);
  return stored !== undefined && stored.declaresWriter &&
    soleOwner(stored.owners, principal);
};

/**
 * Decides the authored `Members` clause for an output that declares
 * `ifc.members` (spec §8.7.5). Returns the clause to add to the output's
 * label, or the reason the write is refused.
 */
export const membersCaptureClause = (
  input: MembersCaptureInput,
  reads: MembersCaptureReads,
): MembersCaptureResult => {
  const actor = input.actingPrincipal;
  if (actor === undefined) {
    return { refusal: "members requires a run acting for a principal" };
  }
  const path = parsePointer(input.members);
  if (path === undefined) {
    return { refusal: "members must be a pointer into the run's result" };
  }
  const owned = modulePolicyRefs(input.flowConfidentiality).filter((ref) =>
    solelyOwns(reads, ref.subject, actor)
  );
  if (owned.length !== 1) {
    return {
      refusal:
        "members requires exactly one module-policy clause whose subject the acting principal solely owns",
    };
  }
  const [policy] = owned;
  const run = reads.runOf(input.target);
  if (run === undefined || run.moduleIdentity !== policy.moduleIdentity) {
    return {
      refusal:
        "members requires the output to belong to a run of the module the policy names",
    };
  }
  const list: CfcListPosition = {
    space: input.target.space,
    id: run.resultId,
    path,
  };
  if (!ownedPosition(reads, list, actor)) {
    return {
      refusal:
        "members requires a list position the acting principal owns that declares its writers",
    };
  }
  const linked = reads.linkTarget(list);
  if (
    linked === undefined ||
    (linked !== "none" && !ownedPosition(reads, linked, actor))
  ) {
    return {
      refusal:
        "members requires the list a position links to to be the acting principal's",
    };
  }
  const clause: CfcOrClause = {
    anyOf: [cfcAtom.user(actor), cfcAtom.members(list, policy.subject)],
  };
  return { clause: normalizeClause(clause) };
};

/**
 * Whether a schema-authored confidentiality label names a `Members` atom. A
 * `Members` alternative is admitted only through `ifc.members` and
 * {@link membersCaptureClause}, never written into a label directly.
 */
export const authorsMembersAtom = (
  confidentiality: readonly CfcConfClause[],
): boolean =>
  confidentiality.some((clause) =>
    clauseAlternatives(clause).some((alternative) =>
      isObjectNotArray(alternative) &&
      alternative.type === CFC_ATOM_TYPE.Members
    )
  );
