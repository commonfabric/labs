/**
 * Input requirements on a lift's arguments (spec §8.10.3). A lift's code that
 * declares `requiredIntegrity` on an argument admits only an argument carrying
 * that integrity, however the graph that runs it was wired: every value read
 * through the argument is checked, a public value included, and a value the
 * wiring wrote itself carries no evidence. The plan is
 * `docs/plans/cfc-argument-input-requirements.md`.
 *
 * The observations are found by following the lift's binding to the values
 * its code can reach at each declared path, rather than from the read log, so
 * they do not depend on which paths a lazily materialized argument happened to
 * touch, nor on reads a memo served; the reach can only be wider than what the
 * code read. Every reference on the way to a declared path, including one
 * partway along a reference's own path, is followed to its target. A
 * reference held deeper, inside the value reached, is checked where it is
 * held, on the label its holder gave it: by §8.2.4 a dereference's integrity
 * includes the reference's, so that is the stricter side, and evidence copied
 * onto the reference from its target (a link-carried entry, §8.2.5) does not
 * count for it.
 *
 * Absence is not an observation, as in §8.10.3's own check: a declared path
 * where no value is reached (no document, a missing field, an empty
 * container) consumes nothing, and the code sees no value there.
 */

import type { CfcAtom } from "@commonfabric/api/cfc";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "../builder/types.ts";
import {
  isCellLink,
  isPrimitiveCellLink,
  type NormalizedFullLink,
  parseLink,
} from "../link-utils.ts";
import { normalizeCellScope } from "../scope.ts";
import type {
  IExtendedStorageTransaction,
  Metadata,
} from "../storage/interface.ts";
import { cfcIntegritySatisfiesFloorCoherently } from "./observation.ts";
import { cfcFloorTrustContext, consumedIntegrityAt } from "./prepare.ts";
import { cfcSchemaEntries } from "./schema-label-view.ts";
import type { CfcArgumentInputRefusal } from "./types.ts";

/** One argument path whose value must carry `requiredIntegrity`. */
export type ArgumentRequirement = {
  readonly path: readonly string[];
  readonly requiredIntegrity: readonly CfcAtom[];
};

/**
 * Every integrity requirement `schemas` declare on an argument: one schema
 * cannot remove a requirement another declares. A requirement inside an
 * `anyOf` branch is kept whichever branch the value takes, which refuses more
 * than the branch would (§8.10 leaves branch-local obligations outside the
 * automatic check).
 */
export const argumentIntegrityRequirements = (
  schemas: readonly (JSONSchema | undefined)[],
): ArgumentRequirement[] => {
  const requirements: ArgumentRequirement[] = [];
  for (const schema of schemas) {
    if (schema === undefined) continue;
    for (const entry of cfcSchemaEntries(schema)) {
      const required = isObjectOrArray(entry.schema)
        ? entry.schema.ifc?.requiredIntegrity
        : undefined;
      if (!Array.isArray(required) || required.length === 0) continue;
      requirements.push({ path: entry.path, requiredIntegrity: required });
    }
  }
  return requirements;
};

/** What a lift's binding gives one declared argument path. */
type ArgumentReach = {
  /**
   * Where each value reached through a reference sits, read whole, with the
   * value's leaf positions relative to it.
   */
  readonly locations: {
    location: NormalizedFullLink;
    leaves: (readonly string[])[];
  }[];
  /** How many values the binding holds itself, which carry no evidence. */
  readonly inWiring: number;
};

/**
 * The leaf positions of a value read from a document, relative to it: each
 * scalar and each reference slot, which is checked where it is held. An
 * empty container has none: like an absent value, it shows nothing.
 */
const leafPaths = (value: unknown): (readonly string[])[] =>
  isPrimitiveCellLink(value) || !isObjectOrArray(value)
    ? [[]]
    : Object.entries(value).flatMap(([key, child]) =>
      leafPaths(child).map((leaf) => [key, ...leaf])
    );

/** Calls `visit` for the child or children `segment` names, if any. */
const descend = (
  value: unknown,
  segment: string,
  visit: (child: unknown, key: string) => void,
): void => {
  if (!isObjectOrArray(value)) return;
  if (segment === "*") {
    for (const [key, child] of Object.entries(value)) visit(child, key);
    return;
  }
  if (Object.hasOwn(value, segment)) visit(value[segment], segment);
};

/**
 * Follows `binding` to what its code can reach at `path`. The binding's own
 * reference slots, and the objects it builds around them, are plumbing; a
 * scalar it holds at or below `path` is a value written in the wiring.
 */
const reachThroughArgument = (
  tx: IExtendedStorageTransaction,
  binding: unknown,
  base: NormalizedFullLink,
  path: readonly string[],
  meta: Metadata,
): ArgumentReach => {
  const locations: ArgumentReach["locations"] = [];
  let inWiring = 0;
  const followed = new Set<string>();

  // A value read from a stored document at `location`, with `rest` of the
  // declared path still to walk.
  const inDocument = (
    location: NormalizedFullLink,
    value: unknown,
    rest: readonly string[],
  ): void => {
    if (isPrimitiveCellLink(value)) {
      return follow(parseLink(value, location), rest);
    }
    if (rest.length === 0) {
      const leaves = value === undefined ? [] : leafPaths(value);
      if (leaves.length > 0) locations.push({ location, leaves });
      return;
    }
    const [segment, ...remaining] = rest;
    descend(
      value,
      segment,
      (child, key) =>
        inDocument(
          { ...location, path: [...location.path, key] },
          child,
          remaining,
        ),
    );
  };

  // Reads the target's document from its root, so a reference partway along
  // the target's own path is followed like any other.
  const follow = (link: NormalizedFullLink, rest: readonly string[]) => {
    const walk = [...link.path, ...rest];
    // A cycle of references reaches no value.
    const key = JSON.stringify([
      link.space,
      link.id,
      normalizeCellScope(link.scope),
      walk,
    ]);
    if (followed.has(key)) return;
    followed.add(key);
    const root = { ...link, path: [] };
    inDocument(root, tx.readValueOrThrow(root, { meta }), walk);
  };

  // A value the binding holds at the declared path: its references are
  // followed, and every scalar in it is the wiring's own.
  const heldAtPath = (value: unknown): void => {
    if (isCellLink(value)) return follow(parseLink(value, base), []);
    if (isObjectOrArray(value)) {
      for (const child of Object.values(value)) heldAtPath(child);
      return;
    }
    if (value !== undefined) inWiring += 1;
  };

  const inBinding = (value: unknown, rest: readonly string[]): void => {
    if (isCellLink(value)) return follow(parseLink(value, base), rest);
    if (rest.length === 0) return heldAtPath(value);
    const [segment, ...remaining] = rest;
    descend(value, segment, (child) => inBinding(child, remaining));
  };

  inBinding(binding, path);
  return { locations, inWiring };
};

/**
 * The argument input requirements `requirements` that the lift `code`, bound
 * by `binding`, fails, each as a refusal. Reads go through `tx` under `meta`,
 * which marks them as the verifier's own (§8.10.1), so they are not consumed
 * inputs of anything else in the transaction.
 *
 * Labels are the stored ones, so the check is made before the transaction
 * writes: a transaction that has written may have changed a value whose label
 * the boundary pass has not yet derived, and is refused instead.
 */
export const argumentInputRefusals = (
  tx: IExtendedStorageTransaction,
  code: string,
  binding: unknown,
  base: NormalizedFullLink,
  requirements: readonly ArgumentRequirement[],
  meta: Metadata,
): CfcArgumentInputRefusal[] => {
  if (requirements.length === 0) return [];
  if (tx.hasWrites()) {
    return [{
      reason: `argument requiredIntegrity of ${code} checked after a write`,
      verdict: false,
    }];
  }
  const trust = cfcFloorTrustContext(tx);
  const refusals: CfcArgumentInputRefusal[] = [];
  for (const requirement of requirements) {
    const reach = reachThroughArgument(
      tx,
      binding,
      base,
      requirement.path,
      meta,
    );
    const observations: (readonly CfcAtom[])[] = [
      ...reach.locations.flatMap(({ location, leaves }) =>
        consumedIntegrityAt(tx, location, leaves)
      ),
      ...Array.from({ length: reach.inWiring }, (): readonly CfcAtom[] => []),
    ];
    // SPEC-PENDING https://github.com/commonfabric/specs/pull/NN
    if (
      cfcIntegritySatisfiesFloorCoherently(
        observations,
        requirement.requiredIntegrity,
        trust,
      )
    ) {
      continue;
    }
    refusals.push({
      reason: `argument requiredIntegrity failed at /${
        requirement.path.join("/")
      } of ${code}`,
      verdict: true,
    });
  }
  return refusals;
};
