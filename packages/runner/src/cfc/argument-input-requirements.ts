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
 * touch, nor on reads a memo served. A reference held at a declared path is
 * followed to its target. A reference held deeper, inside the value reached,
 * is checked where it is held, as part of that value: by §8.2.4 a
 * dereference's integrity includes the reference's, so a value whose
 * references carry the requirement passes, and one whose references do not
 * fails, which is the stricter side.
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
 * The integrity requirements `schemas` declare on an argument, each path once.
 * A requirement inside an `anyOf` branch is kept whichever branch the value
 * takes, which refuses more than the branch would.
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
  /**
   * Each place that holds no evidence: a value the binding holds itself, or
   * no value at all. `throughReference` says whether a reference led there,
   * in which case its target may only not have synced yet.
   */
  readonly unreferenced: { throughReference: boolean }[];
};

/**
 * The leaf positions of a value read from a document, relative to it: each
 * scalar, each empty container, and each reference slot, which is checked
 * where it is held.
 */
const leafPaths = (value: unknown): (readonly string[])[] =>
  isPrimitiveCellLink(value) || !isObjectOrArray(value) ||
    Object.keys(value).length === 0
    ? [[]]
    : Object.entries(value).flatMap(([key, child]) =>
      leafPaths(child).map((leaf) => [key, ...leaf])
    );

/** Calls `visit` for the child or children `segment` names, `absent` if none. */
const descend = (
  value: unknown,
  segment: string,
  visit: (child: unknown, key: string) => void,
  absent: () => void,
): void => {
  if (!isObjectOrArray(value)) return absent();
  if (segment === "*") {
    for (const [key, child] of Object.entries(value)) visit(child, key);
    return;
  }
  if (!Object.hasOwn(value, segment)) return absent();
  visit(value[segment], segment);
};

/**
 * Follows `binding` to what its code can reach at `path`. The binding's own
 * reference slots, and the objects it builds around them, are plumbing; any
 * other value it holds at or below `path` is unreferenced.
 */
const reachThroughArgument = (
  tx: IExtendedStorageTransaction,
  binding: unknown,
  base: NormalizedFullLink,
  path: readonly string[],
  meta: Metadata,
): ArgumentReach => {
  const locations: ArgumentReach["locations"] = [];
  const unreferenced: { throughReference: boolean }[] = [];
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
      if (value === undefined) unreferenced.push({ throughReference: true });
      else locations.push({ location, leaves: leafPaths(value) });
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
      () => unreferenced.push({ throughReference: true }),
    );
  };

  const follow = (link: NormalizedFullLink, rest: readonly string[]) => {
    // A cycle of references reaches no value.
    const key = JSON.stringify([
      link.space,
      link.id,
      normalizeCellScope(link.scope),
      link.path,
      rest,
    ]);
    if (followed.has(key)) {
      unreferenced.push({ throughReference: true });
      return;
    }
    followed.add(key);
    inDocument(link, tx.readValueOrThrow(link, { meta }), rest);
  };

  // A value the binding holds at the declared path: its references are
  // followed, and everything else in it is the wiring's own.
  const heldAtPath = (value: unknown): void => {
    if (isCellLink(value)) return follow(parseLink(value, base), []);
    if (isObjectOrArray(value)) {
      const children = Object.values(value);
      if (children.length === 0) {
        unreferenced.push({ throughReference: false });
      }
      for (const child of children) heldAtPath(child);
      return;
    }
    unreferenced.push({ throughReference: false });
  };

  const inBinding = (value: unknown, rest: readonly string[]): void => {
    if (isCellLink(value)) return follow(parseLink(value, base), rest);
    if (rest.length === 0) return heldAtPath(value);
    const [segment, ...remaining] = rest;
    descend(
      value,
      segment,
      (child) => inBinding(child, remaining),
      () => unreferenced.push({ throughReference: false }),
    );
  };

  inBinding(binding, path);
  return { locations, unreferenced };
};

/**
 * The argument input requirements `requirements` that the lift bound by
 * `binding` fails, each as a refusal. Reads go through `tx` under `meta`,
 * which marks them as the verifier's own (§8.10.1), so they are not consumed
 * inputs of anything else in the transaction.
 *
 * Labels are the stored ones, so the check is made before the transaction
 * writes: a transaction that has written may have changed a value whose label
 * the boundary pass has not yet derived, and is refused instead.
 */
export const argumentInputRefusals = (
  tx: IExtendedStorageTransaction,
  binding: unknown,
  base: NormalizedFullLink,
  requirements: readonly ArgumentRequirement[],
  meta: Metadata,
): CfcArgumentInputRefusal[] => {
  if (requirements.length === 0) return [];
  if (tx.hasWrites()) {
    return [{
      reason: "argument requiredIntegrity checked after a write",
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
    // Each place a reference led to no value may only not have synced yet;
    // every other observation is settled.
    const settled = [
      ...reach.locations.flatMap(({ location, leaves }) =>
        consumedIntegrityAt(tx, location, leaves)
      ),
      ...reach.unreferenced.filter((place) => !place.throughReference).map(
        (): readonly CfcAtom[] => [],
      ),
    ];
    const pending = reach.unreferenced.filter((place) => place.throughReference)
      .map((): readonly CfcAtom[] => []);
    const satisfied = (observations: readonly (readonly CfcAtom[])[]) =>
      cfcIntegritySatisfiesFloorCoherently(
        observations,
        requirement.requiredIntegrity,
        trust,
      );
    // SPEC-PENDING https://github.com/commonfabric/specs/pull/NN
    if (satisfied([...settled, ...pending])) continue;
    refusals.push({
      reason: `argument requiredIntegrity failed at /${
        requirement.path.join("/")
      }`,
      // A verdict when the settled observations fail on their own.
      verdict: !satisfied(settled),
    });
  }
  return refusals;
};
