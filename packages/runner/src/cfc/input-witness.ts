/**
 * Input witnesses on `TransformedBy` (spec §8.9.3, §4.5.1.1): what the runtime
 * retains about the integrity of the confidential inputs a transformation
 * consumed, so an exchange rule can require that an endorsed transformer was
 * fed specific evidence and not merely that it ran. The design, and what it
 * does not cover, is `docs/specs/cfc-transformed-by-input-witnesses.md`.
 *
 * Each consumed content reference remains distinct in the minted atom. Its
 * witnesses summarize only the label locations consumed through that one
 * reference, so evidence on one input is never attributed to another.
 */

import {
  CFC_ATOM_TYPE,
  type CfcAtom,
  cfcAtom,
  type CfcTransformedByAtom,
  type CfcTransformedByInput,
} from "@commonfabric/api/cfc";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { canonicalizeTransformedByInputs } from "./canonical.ts";
import type { transformedByOperation } from "./implementation-identity.ts";

/**
 * The deepest nested `inputs[].witnesses` chain a minted atom may carry. Each
 * endorsed step adds one level; past this depth the deeper witnesses are
 * dropped, which under-claims and so fails safe.
 */
export const INPUT_WITNESS_MAX_DEPTH = 3;

const isTransformedBy = (atom: unknown): atom is Record<string, unknown> =>
  isObjectNotArray(atom) &&
  (atom as { type?: unknown }).type === CFC_ATOM_TYPE.TransformedBy;

/** The deepest nested input-witness chain of a `TransformedBy` atom. */
export const inputWitnessDepth = (atom: CfcAtom): number => {
  if (!isTransformedBy(atom) || !Array.isArray(atom.inputs)) return 0;
  let deepest = 0;
  for (const input of atom.inputs) {
    if (!isObjectNotArray(input) || !Array.isArray(input.witnesses)) continue;
    for (const witness of input.witnesses) {
      deepest = Math.max(deepest, 1 + inputWitnessDepth(witness));
    }
  }
  return deepest;
};

/**
 * The atoms of one input location's integrity that are retained as input
 * witnesses. Only the `TransformedBy` family is retained: it is the evidence
 * family the default transition never carries forward, so without this it
 * says nothing past the value it was minted on, and it is what a chain of
 * endorsed transformers needs. Evidence beyond the depth cap is pruned from
 * the nested atom while its operation and input references remain. Hereditary
 * atoms already survive by the meet, and further families can join this set
 * when a rule needs them.
 */
export const retainedInputWitnesses = (
  integrity: readonly CfcAtom[] | undefined,
): CfcAtom[] =>
  (integrity ?? []).flatMap((atom) =>
    isTransformedBy(atom)
      ? [truncateInputWitnesses(atom, INPUT_WITNESS_MAX_DEPTH - 1)]
      : []
  );

const truncateInputWitnesses = (
  atom: CfcAtom,
  remainingDepth: number,
): CfcAtom => {
  if (!isTransformedBy(atom) || !Array.isArray(atom.inputs)) return atom;
  return {
    ...atom,
    inputs: atom.inputs.map((input) => {
      if (!isObjectNotArray(input)) return input;
      const witnesses = Array.isArray(input.witnesses) && remainingDepth > 0
        ? input.witnesses.map((witness) =>
          truncateInputWitnesses(witness, remainingDepth - 1)
        )
        : [];
      const { witnesses: _witnesses, ...rest } = input;
      return witnesses.length === 0 ? rest : { ...rest, witnesses };
    }),
  };
};

/**
 * The atoms common to `left` and `right`, by structural equality: the meet
 * that makes retained witnesses a claim about every consumed location within
 * one input reference.
 */
export const meetInputWitnesses = (
  left: readonly CfcAtom[],
  right: readonly CfcAtom[],
): CfcAtom[] =>
  left.filter((atom) => right.some((other) => deepEqual(atom, other)));

/**
 * Mints the single exact `TransformedBy` atom for one operation.
 */
export const mintTransformedBy = (
  operation: NonNullable<ReturnType<typeof transformedByOperation>>,
  inputs: readonly CfcTransformedByInput[],
): CfcTransformedByAtom =>
  cfcAtom.transformedBy({
    ...operation,
    inputs: canonicalizeTransformedByInputs(inputs),
  });
