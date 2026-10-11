/**
 * Input requirements of a node's code (spec §8.9, §8.10.3): `requiredIntegrity`
 * a lift's, a computed node's or a handler's code declares on its input is
 * checked against every value the node's attempt reads there, public values
 * included, before the attempt commits. §8.9 holds every node to its input
 * contract ("MUST be enforced before commit"), §4.6.1 gives a node its input
 * cells, and §3.8.4 and §10's `to_city()` are the reason: trusted code that
 * requires integrity on its input refuses a value untrusted code computed or
 * chose. Requirements on confidentiality (`maxConfidentiality`) and the
 * inputs of builtins are not checked here yet; the conformance statement
 * records both.
 *
 * Which schema's requirements apply is the one point the specification does
 * not yet settle: here, the schema bound to the code identity that ran, to
 * which a graph's schema can add requirements and from which it can remove
 * none (marked pending its ruling, commonfabric/specs#62, in the runner,
 * where the schemas are resolved).
 *
 * How the reads are found is a host arrangement, recorded in
 * `docs/specs/cfc-conformance-statement.md`: the runner follows the node's
 * binding to everything its code can reach at each declared path before the
 * code runs, rather than reading the attempt's log, because the log misses
 * reads a lazily materialized argument makes later, hops a memo served, and
 * reads through a `Cell` the code holds. The reach is a superset of what the
 * code reads, so it can only refuse more.
 *
 * What each observation carries:
 * - A reference is followed to its target, which supplies the observation's
 *   integrity. The slot that holds a reference contributes confidentiality
 *   only (§8.2.4), so it is not an integrity observation here; evidence
 *   copied onto a reference from its target (§8.2.5) never counts.
 * - A value written in the node's binding itself (a literal in the wiring)
 *   carries no evidence.
 * - A path that is read and found absent is a `shape` observation (§4.6.3)
 *   of the position it is absent from, labeled as that position is. If a
 *   schema other than the code's own (one a reference carries, or the
 *   graph's where it is not the code's) would fill it with a `default`, the
 *   code would be handed the value that schema chose, which carries no
 *   evidence either.
 * - A cycle of references, or a chain longer than the runtime resolves,
 *   reaches no value the code is handed and carries no evidence.
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

/** One input path whose value must carry `requiredIntegrity`. */
export type ArgumentRequirement = {
  readonly path: readonly string[];
  readonly requiredIntegrity: readonly CfcAtom[];
};

/**
 * Every integrity requirement `schemas` declare on a node's input: one schema
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

/** A node's input requirements, as the runner resolves them. */
export type ArgumentRequirementResolution = {
  readonly requirements: ArgumentRequirement[];
  /** Whether the schema bound to the code identity was found. */
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
    if (segment === "*") {
      for (const child of Object.values(properties)) children.push(child);
    } else if (Object.hasOwn(properties, segment)) {
      children.push(properties[segment]);
    }
  }
  for (const keyword of ["additionalProperties", "items"]) {
    if (schema[keyword] !== undefined) children.push(schema[keyword]);
  }
  const prefixItems = schema.prefixItems;
  if (Array.isArray(prefixItems)) {
    const index = Number(segment);
    if (segment === "*") {
      for (const child of prefixItems) children.push(child);
    } else if (Number.isInteger(index)) children.push(prefixItems[index]);
  }
  const patternProperties = schema.patternProperties;
  if (isObjectOrArray(patternProperties)) {
    for (const child of Object.values(patternProperties)) children.push(child);
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

/** What a node's binding gives one declared input path. */
type InputReach = {
  /**
   * Each position an observation was made at, with the leaf positions
   * observed below it (`[[]]` for the position itself).
   */
  readonly locations: {
    location: NormalizedFullLink;
    leaves: (readonly string[])[];
  }[];
  /** How many observations carry no evidence (see the module comment). */
  readonly inWiring: number;
};

/** A value's leaf positions relative to it, and the references it holds. */
const leavesOf = (
  value: unknown,
  at: readonly string[] = [],
  out: { leaves: (readonly string[])[]; references: (readonly string[])[] } = {
    leaves: [],
    references: [],
  },
): typeof out => {
  if (isPrimitiveCellLink(value)) {
    out.references.push(at);
  } else if (!isPlainContainer(value) || Object.keys(value).length === 0) {
    // A scalar, a special value (bytes, an instance) or an empty container:
    // an observation of the position itself.
    out.leaves.push(at);
  } else {
    for (const [key, child] of Object.entries(value)) {
      leavesOf(child, [...at, key], out);
    }
  }
  return out;
};

/**
 * Follows `binding` to what its code can reach at `path`, recording each
 * observation. The reads go through `tx` under `meta`.
 */
const reachThroughInput = (
  tx: IExtendedStorageTransaction,
  binding: unknown,
  base: NormalizedFullLink,
  path: readonly string[],
  meta: Metadata,
  foreignSchema: JSONSchema | undefined,
): InputReach => {
  const locations: InputReach["locations"] = [];
  let inWiring = 0;
  const followed = new Set<string>();
  const graphDefaults = schemaDefaultsAt(foreignSchema, path);

  // A position read and found absent: a `shape` observation of it, unless a
  // schema not the code's would hand the code a default there.
  const absentAt = (location: NormalizedFullLink, defaulting: boolean) => {
    if (defaulting) inWiring += 1;
    else locations.push({ location, leaves: [[]] });
  };

  const at = (location: NormalizedFullLink, key: string) => ({
    ...location,
    path: [...location.path, key],
  });

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
      if (value === undefined) return absentAt(location, defaulting);
      const { leaves, references } = leavesOf(value);
      if (leaves.length > 0) locations.push({ location, leaves });
      // A reference inside the value is followed: its target's integrity
      // is what the code is handed (the slot adds confidentiality only).
      for (const reference of references) {
        const slot = { ...location, path: [...location.path, ...reference] };
        const held: unknown = reference.reduce<unknown>(
          (inner, key) =>
            isObjectOrArray(inner) ? Reflect.get(inner, key) : undefined,
          value,
        );
        const link = parseLink(held, slot);
        if (link !== undefined) follow(link, [], defaulting, chain);
      }
      return;
    }
    const [segment, ...remaining] = rest;
    if (!isPlainContainer(value)) {
      // Nothing to descend into: the position is read and the path absent.
      return absentAt(
        segment === "*" ? location : at(location, segment),
        defaulting,
      );
    }
    if (segment === "*") {
      const children = Object.entries(value);
      // An empty container enumerated: an observation of the container.
      if (children.length === 0) return absentAt(location, defaulting);
      for (const [key, child] of children) {
        inDocument(at(location, key), child, remaining, defaulting, chain);
      }
      return;
    }
    if (!Object.hasOwn(value, segment)) {
      return absentAt(at(location, segment), defaulting);
    }
    const child: unknown = Reflect.get(value, segment);
    inDocument(at(location, segment), child, remaining, defaulting, chain);
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
    // The same target, walk and default exposure observe the same values.
    const key = JSON.stringify([target, rest, carriesDefault]);
    if (followed.has(key)) return;
    followed.add(key);
    // The verifier's own read (§8.10.1, §18.6.2): marked by `meta`, so it
    // enters no consumed set; the observation it supports is recorded above.
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
  // followed, and every other value in it is the wiring's own.
  const heldAtPath = (value: unknown): void => {
    if (isCellLink(value)) {
      return follow(parseLink(value, base), [], graphDefaults, []);
    }
    if (isPlainContainer(value) && Object.keys(value).length > 0) {
      for (const child of Object.values(value)) heldAtPath(child);
      return;
    }
    inWiring += 1;
  };

  const inBinding = (value: unknown, rest: readonly string[]): void => {
    if (isCellLink(value)) {
      return follow(parseLink(value, base), rest, graphDefaults, []);
    }
    if (rest.length === 0) return heldAtPath(value);
    const [segment, ...remaining] = rest;
    if (!isPlainContainer(value)) {
      // The wiring left the path out: the code is handed nothing it chose.
      inWiring += 1;
      return;
    }
    const children = segment === "*"
      ? Object.values(value)
      : Object.hasOwn(value, segment)
      ? [Reflect.get(value, segment)]
      : [];
    if (children.length === 0) {
      inWiring += 1;
      return;
    }
    for (const child of children) inBinding(child, remaining);
  };

  inBinding(binding, path);
  return { locations, inWiring };
};

/**
 * The input requirements `requirements` that the node running `code`, bound
 * by `binding`, fails, each as a refusal. Reads go through `tx` under `meta`,
 * which marks them as the verifier's own (§8.10.1, §18.6.2), so they are not
 * consumed inputs of anything else in the transaction.
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
      reason: `input requiredIntegrity of ${code} checked after a write`,
      verdict: false,
    }];
  }
  const trust = cfcFloorTrustContext(tx);
  const refusals: CfcArgumentInputRefusal[] = [];
  for (const requirement of requirements) {
    const reach = reachThroughInput(
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
      reason: `input requiredIntegrity failed at /${
        requirement.path.join("/")
      } of ${code}`,
      verdict: true,
    });
  }
  return refusals;
};
