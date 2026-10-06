/**
 * Input witnesses on `TransformedBy` (spec §8.9.3, §4.5.1.1): what the runtime
 * retains about the integrity of the confidential inputs a transformation
 * consumed, so an exchange rule can require that an endorsed transformer was
 * fed specific evidence and not merely that it ran. The design, and what it
 * does not cover, is `docs/specs/cfc-transformed-by-input-witnesses.md`.
 *
 * The spec's `inputs: [{ ref, witnesses }]` is summarized conservatively
 * (§8.9.3 permits it, "so long as they do not overstate"): an atom is retained
 * only when EVERY confidential input location the transformation consumed
 * carried it, and each retained atom is minted as its own claim,
 * `TransformedBy{identity, inputWitness}`, beside the identity-only
 * `TransformedBy{identity}`. A standalone atom is what the rule calculus
 * matches with subset record patterns, and two such atoms conjoin soundly
 * because each already quantifies over every input.
 */

import { CFC_ATOM_TYPE, type CfcAtom } from "@commonfabric/api/cfc";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { compareByCanonicalHash, uniqueCfcAtoms } from "./atoms.ts";
import type { ImplementationIdentity } from "./types.ts";

/**
 * The deepest `inputWitness` nesting a minted atom may carry. A transformer
 * whose input was itself witness-bearing records that atom inside its own, so
 * each endorsed step of a chain adds one level; past this depth the deeper
 * witnesses are dropped, which under-claims and so fails safe.
 */
export const INPUT_WITNESS_MAX_DEPTH = 3;

const isTransformedBy = (atom: unknown): atom is Record<string, unknown> =>
  isObjectNotArray(atom) &&
  (atom as { type?: unknown }).type === CFC_ATOM_TYPE.TransformedBy;

/** The `inputWitness` nesting depth of a `TransformedBy` atom. */
export const inputWitnessDepth = (atom: CfcAtom): number => {
  let depth = 0;
  let current: unknown = atom;
  while (
    isTransformedBy(current) && Object.hasOwn(current, "inputWitness")
  ) {
    depth++;
    current = current.inputWitness;
  }
  return depth;
};

/**
 * The atoms of one input location's integrity that are retained as input
 * witnesses. Only the `TransformedBy` family is retained: it is the provenance
 * family the default transition never carries forward, so without this it
 * says nothing past the value it was minted on, and it is what a chain of
 * endorsed transformers needs. Hereditary atoms already survive by the meet,
 * and further families can join this set when a rule needs them.
 */
export const retainedInputWitnesses = (
  integrity: readonly CfcAtom[] | undefined,
): CfcAtom[] =>
  (integrity ?? []).filter((atom) =>
    isTransformedBy(atom) &&
    inputWitnessDepth(atom) < INPUT_WITNESS_MAX_DEPTH
  );

/**
 * The atoms common to `left` and `right`, by structural equality: the meet
 * that makes a retained witness a claim about every input.
 */
export const meetInputWitnesses = (
  left: readonly CfcAtom[],
  right: readonly CfcAtom[],
): CfcAtom[] =>
  left.filter((atom) => right.some((other) => deepEqual(atom, other)));

/**
 * The `TransformedBy` atoms a transformation mints: the identity-only atom,
 * and one witness-bearing atom per retained witness, in a canonical order so
 * the stamped label does not depend on read order. `witnesses` is `undefined`
 * when the transformation consumed no confidential input, which retains
 * nothing: an empty set of inputs witnesses nothing a rule could ask for.
 */
export const mintTransformedBy = (
  identity: ImplementationIdentity,
  witnesses: readonly CfcAtom[] | undefined,
): CfcAtom[] => {
  const minted: CfcAtom[] = [{ type: CFC_ATOM_TYPE.TransformedBy, identity }];
  // The meet keeps its left side's duplicates, so dedup before minting.
  const ordered = uniqueCfcAtoms(witnesses ?? []).sort(compareByCanonicalHash);
  for (const witness of ordered) {
    minted.push({
      type: CFC_ATOM_TYPE.TransformedBy,
      identity,
      inputWitness: witness,
    });
  }
  return minted;
};
