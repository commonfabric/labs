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
 * container) consumes nothing, and the code sees no value there. The
 * exception is an absence a schema other than the code's own could fill with
 * a `default` — one a reference on the way carries, or the graph's when it
 * differs from the code's: the code would be handed the value that schema
 * chose, which is a value written in the wiring.
 */

import type { CfcAtom } from "@commonfabric/api/cfc";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectOrArray, isPlainContainer } from "@commonfabric/utils/types";

import type { JSONSchema } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { MAX_PATH_RESOLUTION_LENGTH } from "../link-resolution.ts";
import { addressKey } from "../link-types.ts";
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
      const requirement = { path: entry.path, requiredIntegrity: required };
      // The same floor from both schemas is one requirement.
      if (requirements.some((kept) => deepEqual(kept, requirement))) continue;
      requirements.push(requirement);
    }
  }
  return requirements;
};

/** A lift's argument requirements, as the runner resolves them. */
export type ArgumentRequirementResolution = {
  readonly requirements: ArgumentRequirement[];
  /** Whether the code's own argument schema was found. */
  readonly codeSchema: boolean;
  /**
   * The schema the graph carries for the node when it is not the code's own,
   * whose `default`s would be the wiring's choice.
   */
  readonly foreignSchema: JSONSchema | undefined;
};

/** The subschemas that describe the same position as `schema`. */
const sameDepth = (schema: Record<string, unknown>): unknown[] =>
  ["allOf", "anyOf", "oneOf"].flatMap((keyword) => {
    const branches = schema[keyword];
    return Array.isArray(branches) ? branches : [];
  });

/** The subschemas that describe the child `segment` of `schema`'s position. */
const childSchemas = (
  schema: Record<string, unknown>,
  segment: string,
): unknown[] => {
  const children: unknown[] = [];
  const properties = schema.properties;
  if (isObjectOrArray(properties)) {
    if (segment === "*") children.push(...Object.values(properties));
    else if (Object.hasOwn(properties, segment)) {
      children.push(properties[segment]);
    }
  }
  for (const keyword of ["additionalProperties", "items"]) {
    if (schema[keyword] !== undefined) children.push(schema[keyword]);
  }
  const prefixItems = schema.prefixItems;
  if (Array.isArray(prefixItems)) {
    const index = Number(segment);
    if (segment === "*") children.push(...prefixItems);
    else if (Number.isInteger(index)) children.push(prefixItems[index]);
  }
  const patternProperties = schema.patternProperties;
  if (isObjectOrArray(patternProperties)) {
    children.push(...Object.values(patternProperties));
  }
  return children;
};

/** Whether `value` holds something at `path` (`*` matching any member). */
const valueReachesPath = (value: unknown, path: readonly string[]): boolean => {
  if (value === undefined) return false;
  if (path.length === 0) return true;
  if (!isPlainContainer(value)) return false;
  const [segment, ...rest] = path;
  return Object.entries(value).some(([key, child]) =>
    (segment === "*" || key === segment) && valueReachesPath(child, rest)
  );
};

/**
 * Whether `schema` could supply a value at `path` with a `default`: one at
 * or below `path`, or one above it whose value reaches `path`. A `$ref` that does not resolve
 * against `root` counts as one, which refuses more.
 */
export const schemaDefaultsAt = (
  schema: unknown,
  path: readonly string[],
  root: unknown = schema,
  visited: Map<object, Set<number>> = new Map(),
): boolean => {
  if (!isObjectOrArray(schema) || Array.isArray(schema)) return false;
  // Each subschema once per remaining depth, so a recursive `$ref` ends.
  const depths = visited.get(schema) ?? new Set<number>();
  if (depths.has(path.length)) return false;
  depths.add(path.length);
  visited.set(schema, depths);
  let node: Record<string, unknown> = schema;
  if (typeof schema.$ref === "string") {
    const resolved = isObjectOrArray(root) && !Array.isArray(root)
      ? ContextualFlowControl.resolveSchemaRefs(schema, root)
      : undefined;
    if (!isObjectOrArray(resolved) || Array.isArray(resolved)) return true;
    node = resolved;
  }
  // A default at or below the path supplies a value there; one above it
  // supplies one only if that default holds something at the rest of the path.
  if (
    Object.hasOwn(node, "default") &&
    valueReachesPath(Reflect.get(node, "default"), path)
  ) return true;
  const inner = (child: unknown, at: readonly string[]) =>
    schemaDefaultsAt(child, at, root, visited);
  if (sameDepth(node).some((branch) => inner(branch, path))) return true;
  if (path.length === 0) {
    return childSchemas(node, "*").some((child) => inner(child, []));
  }
  const [segment, ...rest] = path;
  return childSchemas(node, segment).some((child) => inner(child, rest));
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
   * How many values carry no evidence: those the binding holds itself, and
   * each absence a schema other than the code's could fill with a `default`.
   */
  readonly inWiring: number;
};

/**
 * The leaf positions of a value read from a document, relative to it: each
 * scalar, each special value (bytes, an instance), and each reference slot,
 * which is checked where it is held. An empty plain container has none: like
 * an absent value, it shows nothing.
 */
const leafPaths = (value: unknown): (readonly string[])[] =>
  isPrimitiveCellLink(value) || !isPlainContainer(value)
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
  // A special value has no members the code could reach by path.
  if (!isPlainContainer(value)) return absent();
  if (segment === "*") {
    for (const [key, child] of Object.entries(value)) visit(child, key);
    return;
  }
  if (!Object.hasOwn(value, segment)) return absent();
  const child: unknown = Reflect.get(value, segment);
  visit(child, segment);
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
  foreignSchema: JSONSchema | undefined,
): ArgumentReach => {
  const locations: ArgumentReach["locations"] = [];
  let inWiring = 0;
  const followed = new Set<string>();
  // The graph's own schema, where it is not the code's, could fill an absence
  // anywhere it declares a `default` at or around the declared path.
  const graphDefaults = schemaDefaultsAt(foreignSchema, path);

  // Absence is no observation, unless a schema the code did not declare —
  // the graph's, or one a reference on the way carries — could hand the code
  // a `default` there instead: that value is the wiring's.
  const absent = (defaulting: boolean) => {
    if (defaulting) inWiring += 1;
  };

  // A value read from a stored document at `location`, with `rest` of the
  // declared path still to walk.
  const inDocument = (
    location: NormalizedFullLink,
    value: unknown,
    rest: readonly string[],
    defaulting: boolean,
    chain: readonly string[],
  ): void => {
    if (isPrimitiveCellLink(value)) {
      return follow(parseLink(value, location), rest, defaulting, chain);
    }
    if (rest.length === 0) {
      if (value === undefined) return absent(defaulting);
      const leaves = leafPaths(value);
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
          defaulting,
          chain,
        ),
      () => absent(defaulting),
    );
  };

  // Reads the target's document from its root, so a reference partway along
  // the target's own path is followed like any other.
  const follow = (
    link: NormalizedFullLink,
    rest: readonly string[],
    defaulting: boolean,
    chain: readonly string[],
  ) => {
    const walk = [...link.path, ...rest];
    // The link's schema describes its target, so a `default` in it at or
    // around the rest of the walk is one the code could be handed.
    const carriesDefault = defaulting || schemaDefaultsAt(link.schema, rest);
    // A reference this chain already passed through, or a chain longer than
    // the runtime itself resolves, never reaches a value the code is
    // handed; whatever it would show is not evidence, so it counts as the
    // wiring's rather than as absence.
    const target = addressKey({
      ...link,
      scope: normalizeCellScope(link.scope),
    });
    if (
      chain.includes(target) || chain.length >= MAX_PATH_RESOLUTION_LENGTH
    ) {
      inWiring += 1;
      return;
    }
    // The same target, walk and default exposure observe the same values:
    // once is enough. A walk that could be defaulted is not one that could
    // not, since only it turns absence into a value of the wiring's.
    const key = JSON.stringify([target, rest, carriesDefault]);
    if (followed.has(key)) return;
    followed.add(key);
    const root = { ...link, path: [] };
    inDocument(
      root,
      tx.readValueOrThrow(root, { meta }),
      walk,
      carriesDefault,
      [...chain, target],
    );
  };

  // A value the binding holds at the declared path: its references are
  // followed, and every scalar in it is the wiring's own.
  const heldAtPath = (value: unknown): void => {
    if (isCellLink(value)) {
      return follow(parseLink(value, base), [], graphDefaults, []);
    }
    if (isPlainContainer(value)) {
      for (const child of Object.values(value)) heldAtPath(child);
      return;
    }
    if (value !== undefined) inWiring += 1;
  };

  const inBinding = (value: unknown, rest: readonly string[]): void => {
    if (isCellLink(value)) {
      return follow(parseLink(value, base), rest, graphDefaults, []);
    }
    if (rest.length === 0) return heldAtPath(value);
    const [segment, ...remaining] = rest;
    descend(
      value,
      segment,
      (child) => inBinding(child, remaining),
      () => absent(graphDefaults),
    );
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
  foreignSchema?: JSONSchema,
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
      foreignSchema,
    );
    const observations: (readonly CfcAtom[])[] = [
      ...reach.locations.flatMap(({ location, leaves }) =>
        consumedIntegrityAt(tx, location, leaves)
      ),
      ...Array.from({ length: reach.inWiring }, (): readonly CfcAtom[] => []),
    ];
    // SPEC-PENDING https://github.com/commonfabric/specs/pull/62
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
