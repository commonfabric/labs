/**
 * The input join a schema's confidentiality holds, as distinct from what it
 * declares.
 *
 * The node factories join the confidentiality of a module's inputs onto the
 * schema of what it outputs, before anything runs. For a module whose writes
 * the runtime measures against what it read, that join stands in for the
 * measurement, and a runtime persisting flow labels leaves it to the
 * measurement rather than minting it as store policy
 * (`docs/specs/cfc-render-boundary-composition.md`, "Nested pattern
 * outputs"). `ifc.inputConfidentiality` names the clauses of
 * `ifc.confidentiality` that only such a join put there, so every reader of
 * `ifc.confidentiality` still sees the whole join.
 *
 * Every function here keeps one invariant: an `ifc`'s `inputConfidentiality`
 * is a subset of its `confidentiality` and holds no clause any source of that
 * `ifc` declares. A clause one source declares is declared, whatever another
 * source joined, so the invariant fails toward declaring.
 */

import type { JSONSchemaObj, JSONValue } from "../builder/types.ts";
import { type CfcConfClause, clausesEqual } from "./clause.ts";

/** Where the clauses of a confidentiality came from. */
export interface ConfidentialitySources {
  /** Clauses a measured module's input join contributed. */
  readonly inputJoin: readonly unknown[];

  /** Clauses a declaration contributed. */
  readonly declared: readonly unknown[];
}

/** Whether `clauses` holds `clause`, each compared in its normal form. */
export const holdsClause = (
  clauses: readonly unknown[],
  clause: unknown,
): boolean =>
  clauses.some((other) =>
    clausesEqual(other as CfcConfClause, clause as CfcConfClause)
  );

/**
 * The sources of the confidentiality `ifc` holds: the clauses its
 * `inputConfidentiality` names are an input join's, and the rest are
 * declared.
 */
export const ifcConfidentialitySources = (
  ifc: JSONSchemaObj["ifc"] | undefined,
): ConfidentialitySources => {
  const confidentiality = Array.isArray(ifc?.confidentiality)
    ? ifc.confidentiality
    : [];
  const named = Array.isArray(ifc?.inputConfidentiality)
    ? ifc.inputConfidentiality
    : [];
  return {
    inputJoin: confidentiality.filter((clause) => holdsClause(named, clause)),
    declared: confidentiality.filter((clause) => !holdsClause(named, clause)),
  };
};

/**
 * The sources of `clauses`: an input join's when `inputJoin`, and declared
 * otherwise.
 */
export const confidentialitySources = (
  clauses: Iterable<unknown>,
  inputJoin: boolean,
): ConfidentialitySources =>
  inputJoin
    ? { inputJoin: [...clauses], declared: [] }
    : { inputJoin: [], declared: [...clauses] };

/**
 * The clauses an input join in `sources` contributed that none of them
 * declares, once each.
 */
export const inputJoinOf = (
  sources: Iterable<ConfidentialitySources>,
): unknown[] => {
  const all = [...sources];
  const declared = all.flatMap((source) => source.declared);
  const joined: unknown[] = [];
  for (const clause of all.flatMap((source) => source.inputJoin)) {
    if (holdsClause(declared, clause) || holdsClause(joined, clause)) continue;
    joined.push(clause);
  }
  return joined;
};

/**
 * `ifc` holding `confidentiality`, with `inputConfidentiality` naming the
 * clauses of it that {@link inputJoinOf} `sources` leaves, and absent when
 * none is left.
 */
export const withInputJoin = (
  ifc: JSONSchemaObj["ifc"] | undefined,
  confidentiality: readonly unknown[],
  sources: Iterable<ConfidentialitySources>,
): NonNullable<JSONSchemaObj["ifc"]> => {
  const inputJoin = inputJoinOf(sources).filter((clause) =>
    holdsClause(confidentiality, clause)
  );
  const { inputConfidentiality: _previous, ...rest } = ifc ?? {};
  return {
    ...rest,
    confidentiality: [...confidentiality] as JSONValue[],
    ...(inputJoin.length > 0
      ? { inputConfidentiality: inputJoin as JSONValue[] }
      : {}),
  };
};
