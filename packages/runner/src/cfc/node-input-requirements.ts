/**
 * Input requirements of a node's code (spec §8.9, §8.10.3): `requiredIntegrity`
 * a lift's, a computed node's or a handler's code declares on its input is
 * checked against every value the node's attempt reads there, public values
 * included, before the attempt commits. §8.9 holds every node to its input
 * contract ("MUST be enforced before commit"), §4.6.1 gives a node its input
 * cells, and §3.8.4 and §10's `to_city()` are the reason: trusted code that
 * requires integrity on its input refuses a value untrusted code computed or
 * chose. `maxConfidentiality` on an input and the inputs of builtins are not
 * checked here yet; the conformance statement records both.
 *
 * Which schema's requirements apply is the one point the specification does
 * not yet settle, decided in `resolveNodeInputRequirements` below.
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
 * - A value written in the node's binding itself (a literal in the wiring,
 *   including a handler's `$event` payload) carries no evidence, so it never
 *   satisfies a `requiredIntegrity`.
 * - A path read and found absent from a container is a `shape` observation
 *   (§4.6.3) carrying the integrity minted for the container's own current
 *   value (`ownEvidenceAt`): never a label it inherits from an ancestor, a
 *   declared store policy or a derived entry, so neither a reference into a
 *   stamped document nor a deletion by other code can borrow its writer's
 *   stamp for an absence. A segment of a reference's own path that is not
 *   there, a walk past a scalar, and a missing document carry no evidence. If
 *   a schema other than the code's own would fill an absence with a `default`
 *   the code's schema does not declare (one a reference carries, or the
 *   graph's), the code would be handed the value that schema chose, which
 *   carries no evidence either.
 * - A requirement on the members of an empty container (a `*` path) observes
 *   nothing: it constrains each member, not how many there are.
 * - A cycle of references, or a chain longer than the runtime resolves,
 *   carries no evidence. The cycle check is keyed on each reference's target,
 *   so a chain that passes one target twice on different walks is refused
 *   too, which refuses more than the runtime's own resolution would.
 */

import type { CfcAtom } from "@commonfabric/api/cfc";
import { isSubschema } from "@commonfabric/data-model-schema/schema-walk";
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
import {
  cfcFloorTrustContext,
  consumedIntegrityAt,
  ownEvidenceAt,
} from "./prepare.ts";
import { cfcSchemaEntries } from "./schema-label-view.ts";
import type { CfcNodeInputRefusal, ImplementationIdentity } from "./types.ts";

/** One input path whose value must carry `requiredIntegrity`. */
export type NodeInputRequirement = {
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
export const nodeIntegrityRequirements = (
  schemas: readonly (JSONSchema | undefined)[],
): NodeInputRequirement[] => {
  const requirements: NodeInputRequirement[] = [];
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

/** A node's input requirements, as resolved for the code that runs. */
export type NodeInputResolution = {
  readonly requirements: NodeInputRequirement[];
  /** Whether the schema bound to the code identity was found. */
  readonly codeSchemaKnown: boolean;
  /** The code's own input schema, whose `default`s are the code's choice. */
  readonly codeSchema: JSONSchema | undefined;
  /** The schema the graph carries for the node, checked as well. */
  readonly graphSchema: JSONSchema | undefined;
};

/**
 * The input requirements of a node whose code has `identity` and whose graph
 * carries `graphSchema` for it. For verified code they are those of the
 * schema bound to the identity that ran — the artifact `artifactFor` finds
 * under the identity the outputs are stamped with, not whatever module
 * carried the function — together with the graph's, which can add a
 * requirement and cannot remove one. Code with no verified identity has no
 * schema but the graph's. A verified identity under which no artifact is
 * found has no known schema, and its run is refused.
 *
 * The identity is the function's verified provenance, recorded when its
 * module is evaluated; a function two factories share carries the identity it
 * was first registered under, and so that factory's requirements.
 */
export const resolveNodeInputRequirements = (
  identity: ImplementationIdentity | undefined,
  graphSchema: JSONSchema | undefined,
  artifactFor: (moduleIdentity: string, symbol: string) => unknown,
): NodeInputResolution => {
  if (identity?.kind !== "verified") {
    return {
      requirements: nodeIntegrityRequirements([graphSchema]),
      codeSchemaKnown: true,
      codeSchema: graphSchema,
      graphSchema: undefined,
    };
  }
  const artifact: unknown =
    identity.moduleIdentity === undefined || identity.symbol === undefined
      ? undefined
      : artifactFor(identity.moduleIdentity, identity.symbol);
  if (typeof artifact !== "function" && !isObjectOrArray(artifact)) {
    return {
      requirements: [],
      codeSchemaKnown: false,
      codeSchema: undefined,
      graphSchema,
    };
  }
  const declared: unknown = Reflect.get(artifact, "argumentSchema");
  const codeSchema = isSubschema(declared) ? declared : undefined;
  // SPEC-PENDING https://github.com/commonfabric/specs/pull/62
  return {
    requirements: nodeIntegrityRequirements([codeSchema, graphSchema]),
    codeSchemaKnown: true,
    codeSchema,
    graphSchema,
  };
};

/** The subschemas that describe the same position as `schema`. */
const sameDepth = (schema: Record<string, unknown>): unknown[] =>
  ["allOf", "anyOf", "oneOf"].flatMap((keyword) => {
    const branches = schema[keyword];
    return Array.isArray(branches) ? branches : [];
  });

/** The subschemas below `schema`'s position, by the segment each describes. */
const childSchemas = (
  schema: Record<string, unknown>,
): [string, unknown][] => {
  const children: [string, unknown][] = [];
  const properties = schema.properties;
  if (isObjectOrArray(properties)) {
    for (const [key, child] of Object.entries(properties)) {
      children.push([key, child]);
    }
  }
  for (const keyword of ["additionalProperties", "items"]) {
    if (schema[keyword] !== undefined) children.push(["*", schema[keyword]]);
  }
  const prefixItems = schema.prefixItems;
  if (Array.isArray(prefixItems)) {
    for (const [index, child] of prefixItems.entries()) {
      children.push([String(index), child]);
    }
  }
  const patternProperties = schema.patternProperties;
  if (isObjectOrArray(patternProperties)) {
    for (const child of Object.values(patternProperties)) {
      children.push(["*", child]);
    }
  }
  return children;
};

/** The values `value` holds at `path` (`*` matching any member). */
const valuesAt = (value: unknown, path: readonly string[]): unknown[] => {
  if (value === undefined) return [];
  if (path.length === 0) return [value];
  if (!isPlainContainer(value)) return [];
  const [segment, ...rest] = path;
  return Object.entries(value).flatMap(([key, child]) =>
    segment === "*" || key === segment ? valuesAt(child, rest) : []
  );
};

/**
 * The `default`s `schema` would supply at `path`, each as a comparable key:
 * the part of a default above `path` that reaches it, and each default at or
 * below it with its position. `undefined` when a `$ref` does not resolve, so
 * what it would supply is not known.
 */
export const schemaDefaultsAt = (
  schema: unknown,
  path: readonly string[],
): Set<string> | undefined => {
  const found = new Set<string>();
  let unknown = false;
  const visited = new Map<object, Set<string>>();
  const walk = (
    node: unknown,
    rest: readonly string[],
    below: readonly string[],
  ): void => {
    if (!isObjectOrArray(node) || Array.isArray(node)) return;
    // Each subschema once per position, so a recursive `$ref` ends.
    const position = JSON.stringify([rest, below]);
    const seen = visited.get(node) ?? new Set<string>();
    if (seen.has(position)) return;
    seen.add(position);
    visited.set(node, seen);
    let resolved: Record<string, unknown> = node;
    if (typeof node.$ref === "string") {
      const target = isObjectOrArray(schema) && !Array.isArray(schema)
        ? ContextualFlowControl.resolveSchemaRefs(node, schema)
        : undefined;
      if (!isObjectOrArray(target) || Array.isArray(target)) {
        unknown = true;
        return;
      }
      resolved = target;
    }
    if (Object.hasOwn(resolved, "default")) {
      const value: unknown = Reflect.get(resolved, "default");
      if (rest.length === 0) found.add(JSON.stringify(["at", below, value]));
      else {
        for (const part of valuesAt(value, rest)) {
          found.add(JSON.stringify(["at", [], part]));
        }
      }
    }
    for (const branch of sameDepth(resolved)) walk(branch, rest, below);
    if (rest.length === 0) {
      for (const [key, child] of childSchemas(resolved)) {
        walk(child, [], [...below, key]);
      }
      return;
    }
    const [segment, ...remaining] = rest;
    for (const [key, child] of childSchemas(resolved)) {
      if (key === "*" || segment === "*" || key === segment) {
        walk(child, remaining, below);
      }
    }
  };
  walk(schema, path, []);
  return unknown ? undefined : found;
};

/**
 * Whether `foreign`, a schema other than the code's own, would supply a
 * `default` at a position the code's schema would not fill the same way:
 * `foreign` described at `foreignPath`, the code's schema at `codePath`.
 */
export const foreignDefaultAt = (
  foreign: unknown,
  foreignPath: readonly string[],
  code: JSONSchema | undefined,
  codePath: readonly string[],
): boolean => {
  if (foreign === undefined) return false;
  const supplied = schemaDefaultsAt(foreign, foreignPath);
  if (supplied === undefined) return true;
  if (supplied.size === 0) return false;
  const own = schemaDefaultsAt(code, codePath) ?? new Set<string>();
  return [...supplied].some((key) => !own.has(key));
};

/** What a node's binding gives one declared input path. */
type InputReach = {
  /**
   * Each position a value was observed at, with its leaf positions and the
   * reference slots it holds, both relative to it.
   */
  readonly locations: {
    location: NormalizedFullLink;
    leaves: (readonly string[])[];
    references: (readonly string[])[];
  }[];
  /** The evidence of each container a declared path was found absent from. */
  readonly absences: (readonly CfcAtom[])[];
  /** How many observations carry no evidence (see the module comment). */
  readonly withoutEvidence: number;
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
  resolution: NodeInputResolution,
): InputReach => {
  const locations: InputReach["locations"] = [];
  const absences: (readonly CfcAtom[])[] = [];
  let withoutEvidence = 0;
  const followed = new Set<string>();
  const { codeSchema, graphSchema } = resolution;
  const graphDefaults = foreignDefaultAt(graphSchema, path, codeSchema, path);

  // `container` holds no value at the rest of the walk: a `shape`
  // observation with the container's own evidence, unless a schema not the
  // code's would hand the code a default there.
  const absentFrom = (container: NormalizedFullLink, defaulting: boolean) => {
    if (defaulting) withoutEvidence += 1;
    else absences.push(ownEvidenceAt(tx, container));
  };

  const at = (location: NormalizedFullLink, key: string) => ({
    ...location,
    path: [...location.path, key],
  });

  // A value read from a stored document at `location`, with `rest` of the
  // declared path still to walk; the first `fixed` segments of `rest` are a
  // reference's own path rather than the declared path's.
  const inDocument = (
    location: NormalizedFullLink,
    value: unknown,
    rest: readonly string[],
    fixed: number,
    defaulting: boolean,
    chain: readonly string[],
  ): void => {
    if (isPrimitiveCellLink(value)) {
      const link = parseLink(value, location);
      if (link === undefined) withoutEvidence += 1;
      else {follow(
          link,
          rest.slice(fixed),
          defaulting,
          chain,
          rest.slice(0, fixed),
        );}
      return;
    }
    if (rest.length === 0) {
      const { leaves, references } = leavesOf(value);
      if (leaves.length > 0) locations.push({ location, leaves, references });
      // A reference inside the value is followed: its target's integrity
      // is what the code is handed (the slot adds confidentiality only).
      for (const reference of references) {
        const held = valuesAt(value, reference)[0];
        const link = parseLink(held, {
          ...location,
          path: [...location.path, ...reference],
        });
        if (link === undefined) withoutEvidence += 1;
        else follow(link, [], defaulting, chain);
      }
      return;
    }
    const [segment, ...remaining] = rest;
    // A segment of a reference's own path that is not there, or a walk past
    // a scalar: the reference or the walk chose a position no container
    // holds, so nothing vouches for it.
    if (!isPlainContainer(value)) {
      withoutEvidence += 1;
      return;
    }
    if (segment === "*") {
      // A requirement on the members of an empty container has no member to
      // observe: it says nothing of how many members there are.
      for (const [key, child] of Object.entries(value)) {
        inDocument(
          at(location, key),
          child,
          remaining,
          Math.max(0, fixed - 1),
          defaulting,
          chain,
        );
      }
      return;
    }
    const child: unknown = Object.hasOwn(value, segment)
      ? Reflect.get(value, segment)
      : undefined;
    if (child === undefined) {
      if (fixed > 0) withoutEvidence += 1;
      else absentFrom(location, defaulting);
      return;
    }
    inDocument(
      at(location, segment),
      child,
      remaining,
      Math.max(0, fixed - 1),
      defaulting,
      chain,
    );
  };

  // Reads the target's document from its root, so a reference partway along
  // the target's own path is followed like any other.
  // `before` is a reference's own path still unwalked when this one was
  // reached partway along it; it stays fixed, like this link's own path.
  const follow = (
    link: NormalizedFullLink,
    rest: readonly string[],
    defaulting: boolean,
    chain: readonly string[],
    before: readonly string[] = [],
  ) => {
    const own = [...link.path, ...before];
    const walk = [...own, ...rest];
    // The link's schema describes its target, the position `rest` above
    // the declared path's end; a default it would supply there that the
    // code's schema would not is the wiring's.
    const carriesDefault = defaulting ||
      foreignDefaultAt(link.schema, [...before, ...rest], codeSchema, path);
    const target = addressKey({
      ...link,
      scope: normalizeCellScope(link.scope),
    });
    if (
      chain.includes(target) || chain.length >= MAX_PATH_RESOLUTION_LENGTH
    ) {
      withoutEvidence += 1;
      return;
    }
    // The same target, walk and default exposure observe the same values.
    const key = JSON.stringify([target, rest, carriesDefault]);
    if (followed.has(key)) return;
    followed.add(key);
    // The verifier's own read (§8.10.1, §18.6.2): marked by `meta`, so it
    // enters no consumed set; the observation it supports is recorded here.
    const root = { ...link, path: [] };
    const value: unknown = tx.readValueOrThrow(root, { meta });
    // A document with no value at all is no container to be absent from.
    if (value === undefined) {
      withoutEvidence += 1;
      return;
    }
    inDocument(
      root,
      value,
      walk,
      own.length,
      carriesDefault,
      [...chain, target],
    );
  };

  // A value the binding holds at the declared path: its references are
  // followed, and every other value in it is the wiring's own.
  const heldAtPath = (value: unknown): void => {
    if (isCellLink(value)) {
      const link = parseLink(value, base);
      if (link === undefined) withoutEvidence += 1;
      else follow(link, [], graphDefaults, []);
      return;
    }
    if (isPlainContainer(value) && Object.keys(value).length > 0) {
      for (const child of Object.values(value)) heldAtPath(child);
      return;
    }
    withoutEvidence += 1;
  };

  const inBinding = (value: unknown, rest: readonly string[]): void => {
    if (isCellLink(value)) {
      const link = parseLink(value, base);
      if (link === undefined) withoutEvidence += 1;
      else follow(link, rest, graphDefaults, []);
      return;
    }
    if (rest.length === 0) return heldAtPath(value);
    const [segment, ...remaining] = rest;
    // The wiring leaving a path out is the wiring's choice: no evidence.
    if (!isPlainContainer(value)) {
      withoutEvidence += 1;
      return;
    }
    const children = segment === "*"
      ? Object.values(value)
      : Object.hasOwn(value, segment)
      ? [Reflect.get(value, segment)]
      : [];
    if (children.length === 0) {
      withoutEvidence += 1;
      return;
    }
    for (const child of children) inBinding(child, remaining);
  };

  inBinding(binding, path);
  return { locations, absences, withoutEvidence };
};

/**
 * The input requirements of `resolution` that the node running `code`,
 * bound by `binding`, fails, each as a refusal. Reads go through `tx` under
 * `meta`, which marks them as the verifier's own (§8.10.1, §18.6.2), so they
 * are not consumed inputs of anything else in the transaction.
 *
 * Labels are the stored ones, so the check is made before the transaction
 * writes: a transaction that has written may have changed a value whose label
 * the boundary pass has not yet derived, and is refused instead. The runner
 * checks before the node's code runs, when nothing has been written.
 */
export const nodeInputRefusals = (
  tx: IExtendedStorageTransaction,
  code: string,
  binding: unknown,
  base: NormalizedFullLink,
  resolution: NodeInputResolution,
  meta: Metadata,
): CfcNodeInputRefusal[] => {
  if (!resolution.codeSchemaKnown) {
    return [{
      reason: `input schema of ${code} is not available`,
      verdict: true,
    }];
  }
  if (resolution.requirements.length === 0) return [];
  if (tx.hasWrites()) {
    return [{
      reason: `input requiredIntegrity of ${code} checked after a write`,
      verdict: true,
    }];
  }
  const trust = cfcFloorTrustContext(tx);
  const refusals: CfcNodeInputRefusal[] = [];
  for (const requirement of resolution.requirements) {
    const reach = reachThroughInput(
      tx,
      binding,
      base,
      requirement.path,
      meta,
      resolution,
    );
    const observations: (readonly CfcAtom[])[] = [
      ...reach.locations.flatMap(({ location, leaves, references }) =>
        consumedIntegrityAt(tx, location, leaves, references)
      ),
      ...reach.absences,
      ...Array.from(
        { length: reach.withoutEvidence },
        (): readonly CfcAtom[] => [],
      ),
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
