import type { JSONSchema, JSONValue } from "@commonfabric/api";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  deepFrozenCloneAndInternSchema,
} from "@commonfabric/data-model-schema";
import {
  isSubschema,
  SINGLE_SUBSCHEMA_KEYS,
  UNUSED_SINGLE_SUBSCHEMA_KEYS,
} from "@commonfabric/data-model-schema/schema-walk";
import {
  cloneIfNecessary,
  fabricAwareEqual,
  type FabricPlainObject,
  FabricPrimitive,
  type FabricValue,
  isFabricPlainObject,
} from "@commonfabric/data-model";
import {
  FABRIC_PRIMITIVE_SCHEMA_TYPES,
  isFabricPrimitiveSchemaType,
} from "@commonfabric/data-model/fabric-primitives";
import {
  isObjectNotArray,
  isObjectOrArray,
  type ReadonlyRecord,
} from "@commonfabric/utils/types";

import { FABRIC_SPECIAL_OBJECT_BRAND } from "../fabric-special-object-brand.ts";
import {
  hasOwnEnumerableDataProperty,
  isCellKind,
  isSchemaScope,
} from "../scope.ts";
import type { CfcConfClause } from "./clause.ts";
import { clauseAlternatives, isOrClause } from "./clause.ts";
import {
  DEFAULT_EXCHANGE_FUEL,
  evaluateExchangeRules,
} from "./exchange-eval.ts";
import { uniqueCfcAtoms } from "./observation.ts";
import { buildCfcPolicySnapshot } from "./policy.ts";
import {
  cfcSchemaResolvedRoot,
  isEmbeddedCfcSchemaRef,
  resolveCfcSchemaRef,
  resolveCfcSchemaRefRoot,
  resolveCfcSchemaRefs,
} from "./schema-refs.ts";
import {
  MATERIAL_RISK_DISCHARGE_KINDS,
  MATERIAL_RISK_DISCHARGE_POLICY,
} from "./standard-profile.ts";

export const INJECTION_SAFE_ATOM = {
  type: CFC_ATOM_TYPE.InjectionSafe,
} as const satisfies JSONValue;

const PROMPT_INJECTION_RISK_KINDS = new Set(MATERIAL_RISK_DISCHARGE_KINDS);

// The material-risk discharge rules, built once. The sanitizer runs them over
// an instruction-inert path's observed confidentiality with its freshly-minted
// InjectionSafe — the discharge is now an ordinary exchange-rule firing (Epic
// B6), not a hardcoded strip. Trusted, local, and unconditional (independent of
// the global cfcPolicyEvaluation dial): §10.1 sanctions the trusted-schema
// sanitizer's InjectionSafe mint + discharge as the profile's own transition
// rule. This uses the SANITIZER-only policy, not the deployment profile:
// bare-InjectionSafe discharge is value-local here (one path, that path's
// evidence) but would be cross-value at a tx-wide boundary.
const MATERIAL_RISK_SNAPSHOT = buildCfcPolicySnapshot(
  MATERIAL_RISK_DISCHARGE_POLICY,
);

type AnnotationResult = {
  schema: JSONSchema;
  instructionInert: boolean;
};

interface AnnotationRefVisit {
  root: object;
  ref: string;
  parent?: AnnotationRefVisit;
}

const asTypeArray = (type: unknown): string[] =>
  Array.isArray(type)
    ? type.filter((entry): entry is string => typeof entry === "string")
    : typeof type === "string"
    ? [type]
    : [];

const isFabricPlainObjectValue = (
  value: unknown,
): value is FabricPlainObject => isFabricPlainObject(value as FabricValue);

export const isPrimitiveJsonValue = (value: unknown): boolean =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

const cloneJson = <T>(value: T): T =>
  cloneIfNecessary(value as FabricValue, { frozen: true }) as T;

const uniqueAtoms = (
  atoms: Iterable<unknown>,
): JSONValue[] => uniqueCfcAtoms(atoms).map((atom) => cloneJson(atom));

export const isPromptInjectionMaterialRiskAtom = (atom: unknown): boolean => {
  if (typeof atom === "string") {
    return PROMPT_INJECTION_RISK_KINDS.has(atom);
  }
  return isObjectOrArray(atom) &&
    atom.type === CFC_ATOM_TYPE.Caveat &&
    typeof atom.kind === "string" &&
    PROMPT_INJECTION_RISK_KINDS.has(atom.kind);
};

// Discharge material-risk caveats from an instruction-inert path's
// confidentiality by running the standard §10.1 profile's material-risk
// discharge rules with the path's minted InjectionSafe as integrity evidence
// (Epic B6 — this REPLACES the old hardcoded `filterMaterialRiskAtoms` strip
// with an ordinary exchange-rule firing; `cfc-standard-profile.test.ts` proves
// byte-for-byte equivalence). A dropClause rule removes a bare material-risk
// atom AND a material-risk alternative nested inside an OR-clause
// (`{anyOf:[risk, A]}` → `A`) — descending is load-bearing: a hidden caveat
// alternative is not more-restrictive when preserved (a ceiling naming the
// sibling subsumes the whole clause), so it must be discharged, not left.
// A short material-risk alias does not match the caveat-record rule directly.
// Normalize each alias, including aliases nested in an OR-clause, into the
// caveat-record form before evaluation (§10.1 SHOULD-normalize aliases before
// evaluation). Non-risk strings remain unchanged.
const normalizeMaterialRiskStringForms = (
  clause: CfcConfClause,
): CfcConfClause => {
  if (typeof clause === "string") {
    return PROMPT_INJECTION_RISK_KINDS.has(clause)
      ? { type: CFC_ATOM_TYPE.Caveat, kind: clause }
      : clause;
  }
  if (isOrClause(clause)) {
    return {
      anyOf: clause.anyOf.map((alternative) =>
        typeof alternative === "string" &&
          PROMPT_INJECTION_RISK_KINDS.has(alternative)
          ? { type: CFC_ATOM_TYPE.Caveat, kind: alternative }
          : alternative
      ),
    };
  }
  return clause;
};

export const dischargeMaterialRiskAtoms = (
  atoms: readonly CfcConfClause[],
): JSONValue[] => {
  // Fuel budget scaled to the label (cubic P2 on #4567): the default 64 would
  // exhaust on a label with more than ~64 droppable alternatives, and the
  // sanitizer would then keep every material-risk caveat — a regression from
  // the old strip, which removed ALL of them. This rule set is add-free (only
  // drops), so it terminates in at most one firing per material-risk
  // alternative; budgeting one per alternative plus the default headroom
  // covers any label without ever risking a real (add/drop-cycle) runaway,
  // which this set cannot have.
  const normalized = atoms.map(normalizeMaterialRiskStringForms);
  const alternativeCount = normalized.reduce(
    (total: number, clause) =>
      total + clauseAlternatives(clause as CfcConfClause).length,
    0,
  );
  const result = evaluateExchangeRules(
    { confidentiality: normalized },
    MATERIAL_RISK_SNAPSHOT,
    { integrity: [INJECTION_SAFE_ATOM] },
    alternativeCount + DEFAULT_EXCHANGE_FUEL,
  );
  // Fixpoint over the finite add-free discharge rule set cannot exhaust with
  // the budget above, but fail safe if it ever did: keep the un-discharged
  // (more-restrictive) label.
  return uniqueAtoms(
    result.exhausted ? atoms : result.label.confidentiality ?? [],
  );
};

const mergeIfc = (
  schema: Record<string, unknown>,
  {
    observedConfidentiality,
    instructionInert,
  }: {
    observedConfidentiality: readonly CfcConfClause[];
    instructionInert: boolean;
  },
): Record<string, unknown> => {
  const existingIfc = isObjectOrArray(schema.ifc) ? schema.ifc : {};
  const retainedConfidentiality = instructionInert
    ? dischargeMaterialRiskAtoms(observedConfidentiality)
    : uniqueAtoms(observedConfidentiality);
  const nextIfc: Record<string, unknown> = { ...existingIfc };

  const confidentiality = uniqueAtoms([
    ...(Array.isArray(existingIfc.confidentiality)
      ? existingIfc.confidentiality
      : []),
    ...retainedConfidentiality,
  ]);
  if (confidentiality.length > 0) {
    nextIfc.confidentiality = confidentiality;
  }

  if (instructionInert) {
    nextIfc.addIntegrity = uniqueAtoms([
      ...(Array.isArray(existingIfc.addIntegrity)
        ? existingIfc.addIntegrity
        : []),
      INJECTION_SAFE_ATOM,
    ]);
  }

  return Object.keys(nextIfc).length > 0 ? { ...schema, ifc: nextIfc } : schema;
};

const schemaHasSafeEnum = (schema: Record<string, unknown>): boolean =>
  Array.isArray(schema.enum) && schema.enum.length > 0 &&
  schema.enum.every(isPrimitiveJsonValue);

const schemaHasSafeConst = (schema: Record<string, unknown>): boolean =>
  Object.hasOwn(schema, "const") && isPrimitiveJsonValue(schema.const);

const primitiveTypeIsInstructionInert = (
  schema: Record<string, unknown>,
): boolean => {
  if (schemaHasSafeEnum(schema) || schemaHasSafeConst(schema)) {
    return true;
  }
  const types = asTypeArray(schema.type);
  return types.length > 0 &&
    types.every((type) =>
      type === "number" ||
      type === "integer" ||
      type === "boolean" ||
      type === "null" ||
      type === "undefined"
    );
};

const schemaDeclaresObjectShape = (schema: Record<string, unknown>): boolean =>
  asTypeArray(schema.type).includes("object") ||
  schema.properties !== undefined ||
  schema.required !== undefined ||
  schema.additionalProperties !== undefined;

// Deliberate deviation from JSON Schema defaults: standard JSON Schema treats
// missing `additionalProperties` as permissive (effectively `true`). For
// instruction-inertness analysis we treat it as closed unless explicitly
// declared open, so authors must opt in to free-form properties before we'll
// allow taint to escape through them. Don't "fix" this back to spec defaults
// without revisiting the sanitizer's caller assumptions.
export const cfcObjectSchemaIsClosed = (
  schema: Record<string, unknown>,
): boolean =>
  schemaDeclaresObjectShape(schema) &&
  schema.additionalProperties !== true &&
  typeof schema.additionalProperties !== "object";

/**
 * The property surface an object schema's `anyOf`/`oneOf`/`allOf` branches
 * contribute to the node carrying them: the property names those branches
 * declare, and whether any of them leaves the object open.
 *
 * A discriminated union is normally written as a bare node — `{type: "object",
 * oneOf: [...]}` — whose own `properties` is empty because every property
 * belongs to a branch. Judging that node's closedness on its own `properties`
 * alone makes it a closed object with no permitted keys, so every value fails
 * on its first key. The branches are where the shape lives, so they are what
 * decides.
 *
 * This grants nothing a branch would refuse: a branch is validated against the
 * same value in its own right, and rejects any key it does not model.
 *
 * The walk is an explicit worklist rather than a recursion, so a chain of
 * combinators costs heap instead of call stack: `A` branches to `B` branches
 * to `C` for as long as an author (or a generator) cares to nest, and depth is
 * no longer what decides whether this returns an answer or a stack overflow.
 *
 * Two guards keep it finite, and each answers a different question:
 *
 * - `activeRefs` is PATH-scoped: a `$ref` goes in when the walk descends
 *   through it and comes out when the walk leaves, so the set holds exactly
 *   the chain from the root to wherever the walk stands. That is what makes a
 *   self-recursive union — `$defs.Node.anyOf = [leaf, {$ref: "#/$defs/Node"}]`
 *   — terminate. Scoping it to the path rather than to the whole walk is
 *   load-bearing: two SIBLING branches may name one `$ref` while carrying
 *   different constraints of their own, and a walk-wide guard would skip the
 *   second, losing the property names it declares and treating keys it models
 *   as unmodeled. Refs are tracked by string because a ref site carrying
 *   siblings resolves to a fresh object every time, so identity alone would
 *   not close such a loop.
 * - `visited` is walk-wide, and holds the RESOLVED branch objects already
 *   descended into. One object's subtree is the same subtree whichever path
 *   arrives at it, so descending once is enough — which is what keeps a
 *   diamond of definitions from re-walking its shared tail once per path, and
 *   what cuts a branch array that holds its own node. Nothing is lost to it:
 *   a ref site with its own siblings resolves to its own object, so it is
 *   never confused with another site naming the same definition.
 *
 * A branch a guard cuts contributes nothing further: no property names, and no
 * `open`. Contributing nothing is the fail-closed answer, because `open` is
 * the permissive result — it is what makes the caller skip its
 * additional-property check — so a cycle leaves the surface closed and an
 * unmodeled key is still refused. A cut branch's own property names are
 * collected before the cut, and every branch merges into the one set the
 * caller reads.
 *
 * A branch that leaves the object open contributes its names too, and is
 * descended into like any other. Openness and the name set are separate
 * answers: the validator reads `known` only where nothing is open, while the
 * opaque-link sanitizer reads it whether or not anything is open — an
 * unmodeled key seals there even under an open schema. One walk therefore has
 * to answer both, or the two disagree about what the schema declares, and that
 * disagreement is what decides whether a value seals or is released.
 */
export const cfcCombinatorObjectSurface = (
  schema: Record<string, unknown>,
  schemaRoot: JSONSchema,
): { known: Set<string>; open: boolean } => {
  const known = new Set<string>();
  let open = false;
  const activeRefs = new Set<string>();
  const visited = new Set<object>([schema]);

  type SurfaceStep =
    | { kind: "branch"; raw: unknown }
    | { kind: "leave"; ref: string };

  const stack: SurfaceStep[] = [];
  const pushBranches = (node: Record<string, unknown>): void => {
    for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      for (const raw of branches) stack.push({ kind: "branch", raw });
    }
  };
  pushBranches(schema);

  while (stack.length > 0) {
    const step = stack.pop()!;
    if (step.kind === "leave") {
      activeRefs.delete(step.ref);
      continue;
    }
    const raw = step.raw;
    const branchRef = isObjectOrArray(raw) && typeof raw.$ref === "string"
      ? raw.$ref
      : undefined;
    if (branchRef !== undefined && activeRefs.has(branchRef)) continue;
    const branch = branchRef !== undefined && isObjectOrArray(raw)
      ? resolveCfcSchemaRefs(raw, schemaRoot)
      : raw;
    if (branch === false) continue;
    if (!isObjectNotArray(branch)) {
      open = true;
      continue;
    }
    if (!cfcObjectSchemaIsClosed(branch)) {
      open = true;
    }
    for (const key of Object.keys(branch.properties ?? {})) {
      known.add(key);
    }
    if (visited.has(branch)) continue;
    visited.add(branch);
    if (branchRef !== undefined) {
      activeRefs.add(branchRef);
      stack.push({ kind: "leave", ref: branchRef });
    }
    pushBranches(branch);
  }
  return { known, open };
};

export const resolveSchemaForValidation = (
  schema: JSONSchema,
  fullSchema: JSONSchema,
): JSONSchema =>
  isObjectOrArray(schema) && typeof schema.$ref === "string"
    ? resolveCfcSchemaRefs(schema, fullSchema) ?? false
    : schema;

const annotateSchema = (
  schema: JSONSchema,
  observedConfidentiality: readonly CfcConfClause[],
  fullSchema: JSONSchema,
  visitedRef?: AnnotationRefVisit,
): AnnotationResult => {
  if (typeof schema === "boolean") {
    return { schema, instructionInert: false };
  }

  const schemaRoot = fullSchema;
  const rootKey = isObjectOrArray(schemaRoot) ? schemaRoot : schema;

  // $ref cycle guard: resolveSchemaRefs only detects cycles within a single
  // call, but annotateSchema recurses across resolutions. A local ref string
  // is only meaningful together with its owning root.
  const directRef = typeof schema.$ref === "string" ? schema.$ref : undefined;
  let cursor = visitedRef;
  while (directRef !== undefined && cursor !== undefined) {
    if (cursor.root === rootKey && cursor.ref === directRef) {
      return {
        schema: observedConfidentiality.length > 0
          ? mergeIfc({ ...schema }, {
            observedConfidentiality,
            instructionInert: false,
          }) as JSONSchema
          : schema,
        instructionInert: false,
      };
    }
    cursor = cursor.parent;
  }
  const nextVisited = directRef !== undefined
    ? { root: rootKey, ref: directRef, parent: visitedRef }
    : visitedRef;

  const resolved = resolveSchemaForValidation(schema, schemaRoot);
  if (resolved !== schema) {
    const resolvedRoot = cfcSchemaResolvedRoot(
      resolved,
      resolveCfcSchemaRefRoot(schema, schemaRoot),
    );
    const annotated = annotateSchema(
      resolved,
      observedConfidentiality,
      resolvedRoot,
      nextVisited,
    );
    return {
      schema: mergeIfc({ ...schema }, {
        observedConfidentiality,
        instructionInert: annotated.instructionInert,
      }) as JSONSchema,
      instructionInert: annotated.instructionInert,
    };
  }

  const types = asTypeArray(schema.type);
  const typeSet = new Set(types);

  if (primitiveTypeIsInstructionInert(schema)) {
    return {
      schema: mergeIfc({ ...schema }, {
        observedConfidentiality,
        instructionInert: true,
      }) as JSONSchema,
      instructionInert: true,
    };
  }

  if (
    Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf) ||
    Array.isArray(schema.allOf)
  ) {
    const branches = [
      ...(schema.anyOf ?? []),
      ...(schema.oneOf ?? []),
      ...(schema.allOf ?? []),
    ];
    const annotatedBranches = branches.map((branch) =>
      annotateSchema(branch, observedConfidentiality, schemaRoot, nextVisited)
    );
    const instructionInert = annotatedBranches.length > 0 &&
      annotatedBranches.every((branch) => branch.instructionInert);
    return {
      schema: mergeIfc({
        ...schema,
        ...(schema.anyOf
          ? {
            anyOf: annotatedBranches.slice(0, schema.anyOf.length).map((
              branch,
            ) => branch.schema),
          }
          : {}),
        ...(schema.oneOf
          ? {
            oneOf: annotatedBranches.slice(
              schema.anyOf?.length ?? 0,
              (schema.anyOf?.length ?? 0) + schema.oneOf.length,
            ).map((branch) => branch.schema),
          }
          : {}),
        ...(schema.allOf
          ? {
            allOf: annotatedBranches.slice(
              (schema.anyOf?.length ?? 0) + (schema.oneOf?.length ?? 0),
            ).map((branch) => branch.schema),
          }
          : {}),
      }, { observedConfidentiality, instructionInert }) as JSONSchema,
      instructionInert,
    };
  }

  if (typeSet.has("object") || schema.properties !== undefined) {
    const annotatedProperties: Record<string, JSONSchema> = {};
    const childResults = Object.entries(schema.properties ?? {}).map((
      [key, child],
    ) => {
      const annotated = annotateSchema(
        child,
        observedConfidentiality,
        schemaRoot,
        nextVisited,
      );
      annotatedProperties[key] = annotated.schema;
      return annotated;
    });
    const closedObject = cfcObjectSchemaIsClosed(schema);
    const allChildrenInert = childResults.every((child) =>
      child.instructionInert
    );
    const instructionInert = closedObject && allChildrenInert;
    const shouldTaintRoot = observedConfidentiality.length > 0 &&
      !instructionInert &&
      !closedObject;
    const next = {
      ...schema,
      ...(schema.properties !== undefined
        ? { properties: annotatedProperties }
        : {}),
    };
    return {
      schema: mergeIfc(next, {
        observedConfidentiality: shouldTaintRoot ? observedConfidentiality : [],
        instructionInert,
      }) as JSONSchema,
      instructionInert,
    };
  }

  if (typeSet.has("array") && typeof schema.items === "object") {
    const child = annotateSchema(
      schema.items,
      observedConfidentiality,
      schemaRoot,
      nextVisited,
    );
    const instructionInert = child.instructionInert;
    return {
      schema: mergeIfc({
        ...schema,
        items: child.schema,
      }, { observedConfidentiality, instructionInert }) as JSONSchema,
      instructionInert,
    };
  }

  return {
    schema: observedConfidentiality.length > 0
      ? mergeIfc({ ...schema }, {
        observedConfidentiality,
        instructionInert: false,
      }) as JSONSchema
      : schema,
    instructionInert: false,
  };
};

export const schemaWithInjectionSafeAnnotations = (
  schema: JSONSchema,
  observedConfidentiality: readonly CfcConfClause[] = [],
): JSONSchema => {
  const clone = cloneJson(schema);
  return stripRequiredFields(
    annotateSchema(clone, observedConfidentiality, clone).schema,
  );
};

const stripRequiredFields = (schema: JSONSchema): JSONSchema => {
  if (typeof schema === "boolean") {
    return schema;
  }

  const { required: _required, ...rest } = schema as any;
  const result: Record<string, unknown> = { ...rest };

  if (isObjectOrArray(result.properties)) {
    result.properties = Object.fromEntries(
      Object.entries(result.properties).map(([key, value]) => [
        key,
        stripRequiredFields(value as JSONSchema),
      ]),
    );
  }
  if (isObjectOrArray(result.items)) {
    result.items = stripRequiredFields(result.items as JSONSchema);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(result[key])) {
      result[key] = (result[key] as JSONSchema[]).map(stripRequiredFields);
    }
  }
  if (isObjectOrArray(result.not)) {
    result.not = stripRequiredFields(result.not as JSONSchema);
  }

  return result as JSONSchema;
};

const typeMatches = (
  value: unknown,
  type: string,
  rejectUnknownType: boolean,
): boolean => {
  switch (type) {
    case "unknown":
      return true;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "undefined":
      return value === undefined;
    case "array":
      return Array.isArray(value);
    case "object":
      // A `FabricPrimitive` satisfies "object" too: each `FabricPrimitive`
      // type is a subtype of "object" (the same rule the read side's
      // schemaTypeMatchesValueType applies in traverse.ts).
      return isFabricPlainObjectValue(value) ||
        value instanceof FabricPrimitive;
    default:
      if (isFabricPrimitiveSchemaType(type)) {
        return value instanceof FabricPrimitive &&
          value.schemaType === type;
      }
      return !rejectUnknownType;
  }
};

/**
 * Whether `key` is an OPTIONAL property holding `undefined` that THIS caller
 * has asked to read as absent rather than measure.
 *
 * Gated on the option, and off by default, because `undefined` is a value in
 * this system rather than a hole: the codec stores its presence as
 * `{"/Undefined@1": null}`, `type: "undefined"` is a type this validator
 * supports, and `pull-materialization.test.ts` pins both halves ("does not hide
 * present explicit undefined behind an optional alias", "retains explicit
 * undefined at an optional derived Cell root"). A caller writing `undefined`
 * where a number is declared has made a mistake worth rejecting while they can
 * still see it.
 *
 * The stored-argument check a pattern update runs asks a different question,
 * which is why it opts in — see `optionalUndefinedIsAbsent`.
 *
 * REQUIRED properties are never absent under this rule, and that carve-out is
 * load-bearing rather than cautious: a required property declared
 * `type: "undefined"` holds undefined legitimately and must still be measured
 * to be ACCEPTED. A required property of any other type holding undefined keeps
 * failing on its type, which is the right answer by a different route.
 */
const isAbsentOptional = (
  value: FabricPlainObject,
  key: string,
  requiredKeys: ReadonlySet<string>,
  options: SchemaValidationOptions,
): boolean =>
  options.optionalUndefinedIsAbsent === true &&
  (value as Record<string, unknown>)[key] === undefined &&
  !requiredKeys.has(key);

const SUPPORTED_SCHEMA_TYPES = new Set([
  "unknown",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
  "undefined",
  "array",
  "object",
  ...FABRIC_PRIMITIVE_SCHEMA_TYPES,
]);

const SUPPORTED_SCHEMA_FORMATS = new Set([
  "email",
  "uri",
  "date",
  "date-time",
]);

const isDenseArray = (value: readonly unknown[]): boolean => {
  for (let index = 0; index < value.length; index++) {
    if (!hasOwnEnumerableDataProperty(value, index)) return false;
  }
  return true;
};

const schemaTypeDefinitionIssue = (type: unknown): string | undefined => {
  if (type === undefined) return undefined;
  const types = typeof type === "string"
    ? [type]
    : Array.isArray(type)
    ? type
    : undefined;
  if (types === undefined || types.length === 0) {
    return "schema type must be a non-empty string or string array";
  }
  if (!isDenseArray(types)) {
    return "schema type array must not contain holes";
  }
  if (!types.every((entry) => typeof entry === "string")) {
    return "schema type array contains a non-string entry";
  }
  if (new Set(types).size !== types.length) {
    return "schema type array contains duplicate entries";
  }
  const unsupported = types.find((entry) =>
    !SUPPORTED_SCHEMA_TYPES.has(entry as string)
  );
  return unsupported === undefined
    ? undefined
    : `unsupported schema type ${unsupported}`;
};

const strictConstraintDefinitionIssue = (
  schema: Exclude<JSONSchema, boolean>,
  formatAnnotations = false,
): string | undefined => {
  const record = schema as Record<string, unknown>;
  for (
    const key of [
      "minimum",
      "exclusiveMinimum",
      "maximum",
      "exclusiveMaximum",
    ]
  ) {
    if (
      Object.hasOwn(record, key) &&
      (typeof record[key] !== "number" || !Number.isFinite(record[key]))
    ) {
      return `schema ${key} must be a finite number`;
    }
  }
  if (
    Object.hasOwn(record, "multipleOf") &&
    (typeof record.multipleOf !== "number" ||
      !Number.isFinite(record.multipleOf) || record.multipleOf <= 0)
  ) {
    return "schema multipleOf must be a positive finite number";
  }
  for (
    const key of [
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "minProperties",
      "maxProperties",
      "minContains",
      "maxContains",
    ]
  ) {
    if (
      Object.hasOwn(record, key) &&
      (typeof record[key] !== "number" ||
        !Number.isInteger(record[key]) || (record[key] as number) < 0)
    ) {
      return `schema ${key} must be a non-negative integer`;
    }
  }
  if (Object.hasOwn(record, "pattern")) {
    if (typeof record.pattern !== "string") {
      return "schema pattern must be a string";
    }
    try {
      new RegExp(record.pattern);
    } catch {
      return `schema has invalid pattern ${record.pattern}`;
    }
  }
  if (Object.hasOwn(record, "format")) {
    if (
      typeof record.format !== "string" ||
      (!formatAnnotations && !SUPPORTED_SCHEMA_FORMATS.has(record.format))
    ) {
      return `schema has unsupported format ${String(record.format)}`;
    }
  }
  for (const source of Object.keys(schema.patternProperties ?? {})) {
    try {
      new RegExp(source);
    } catch {
      return `schema has invalid property pattern ${source}`;
    }
  }
  return undefined;
};

interface SchemaDefinitionContext {
  /** Whether formats are annotations and all structural positions are checked. */
  structuredResult: boolean;

  activeByRoot: WeakMap<object, WeakSet<object>>;
  activeRefsByRoot: WeakMap<object, Set<string>>;

  /**
   * Definition maps whose bodies this call already walks under a given root.
   * `resolveCfcSchemaRef()` re-attaches the owning `$defs` object to every
   * resolved definition body, so without this the same map is re-walked once
   * per distinct path that reaches a `$ref` — the definition graph then
   * expands as a tree instead of a DAG and node visits grow as
   * (definition count)^(ref depth).
   */
  walkedDefinitionsByRoot: WeakMap<object, WeakSet<object>>;

  /**
   * Schemas that proved out completely under a given root, so a schema reached
   * again through another path costs a lookup instead of a full re-walk. Only
   * recorded for subtrees that no recursion guard cut short (see `cuts`).
   */
  provenByRoot: WeakMap<object, WeakSet<object>>;

  /**
   * How many times a recursion guard returned "no issue" for a subtree it did
   * not actually walk. A cut result is only sound while the schema that caused
   * it is still on the stack and will report its own issues, so a subtree whose
   * count moved must not be memoized as proven.
   */
  cuts: number;

  /**
   * Every `provenByRoot` record, in the order it was made. A schema proven
   * while a definition map was merely claimed may have skipped that map on the
   * strength of the claim, so handing the map back takes those records with it.
   */
  provenLog: Array<{ rootKey: object; schema: object }>;
}

/**
 * Validates a Fabric schema definition. Migration mode restricts formats to
 * those the migration value checker enforces. Structured-result mode admits
 * string format annotations and checks unevaluated schema positions too.
 * Diagnostics may contain schema content; callers crossing a disclosure
 * boundary replace them with a fixed message.
 */
export const validateSchemaDefinition = (
  schema: JSONSchema,
  fullSchema: JSONSchema = schema,
  mode: "migration" | "structured-result" = "migration",
): string | undefined => {
  // Compatibility later interns schemas for root-aware identity tracking.
  // Prove that normalization is safe up front so malformed literal payloads,
  // typed arrays, and raw object-identity cycles become ordinary validation
  // diagnostics instead of escaping as hash/freeze errors.
  try {
    deepFrozenCloneAndInternSchema(schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `$: schema cannot be normalized: ${message}`;
  }
  return validateSchemaDefinitionInternal(schema, fullSchema, "$", {
    structuredResult: mode === "structured-result",
    activeByRoot: new WeakMap(),
    activeRefsByRoot: new WeakMap(),
    walkedDefinitionsByRoot: new WeakMap(),
    provenByRoot: new WeakMap(),
    cuts: 0,
    provenLog: [],
  });
};

const DEFINITION_KEYS = ["$defs", "definitions"] as const;
type DefinitionKey = (typeof DEFINITION_KEYS)[number];

/**
 * Claim the definition maps this schema walks, so a schema that merely carries
 * the same map under the same root skips it.
 *
 * The claim is taken on entry, before any child is walked, so the map belongs
 * to the outermost schema that carries it. Refs only accumulate on the way
 * down, so an in-flight walk always holds a subset of the refs any schema
 * nested inside it would hold, and therefore cuts no more than that nested
 * walk would — skipping the nested one loses nothing.
 *
 * That reasoning covers the claim only while the walk is in flight. Once it
 * finishes, `releaseCutDefinitionScope()` hands the map back unless the walk
 * ran to completion, because a sibling reached later holds different refs.
 */
const claimDefinitionScopes = (
  schema: Exclude<JSONSchema, boolean>,
  rootKey: object,
  context: SchemaDefinitionContext,
): ReadonlySet<DefinitionKey> | undefined => {
  let claimed: Set<DefinitionKey> | undefined;
  for (const key of DEFINITION_KEYS) {
    const definitions = schema[key];
    if (!isObjectNotArray(definitions)) continue;
    let walked = context.walkedDefinitionsByRoot.get(rootKey);
    if (walked?.has(definitions)) continue;
    if (!walked) {
      walked = new WeakSet();
      context.walkedDefinitionsByRoot.set(rootKey, walked);
    }
    walked.add(definitions);
    (claimed ??= new Set()).add(key);
  }
  return claimed;
};

/**
 * Give a definition map back when a recursion guard cut its walk short.
 *
 * A cut walk did not check everything below it, so it cannot stand in for a
 * later walk that holds different refs open — through a sibling `$ref`, a
 * definition this walk skipped is reachable in full. Only a walk that took no
 * cut proves the whole map, and only that walk keeps the map for good.
 */
const releaseCutDefinitionScope = (
  rootKey: object,
  definitions: object,
  context: SchemaDefinitionContext,
  logMark: number,
): void => {
  context.walkedDefinitionsByRoot.get(rootKey)?.delete(definitions);
  // Anything memoized while the claim stood may have skipped this map because
  // of it. The claim is gone, so those proofs go with it.
  for (let index = context.provenLog.length - 1; index >= logMark; index--) {
    const record = context.provenLog[index];
    context.provenByRoot.get(record.rootKey)?.delete(record.schema);
  }
  context.provenLog.length = logMark;
};

const validateSchemaDefinitionInternal = (
  schema: JSONSchema,
  fullSchema: JSONSchema,
  path: string,
  context: SchemaDefinitionContext,
): string | undefined => {
  if (!isSubschema(schema)) {
    return `${path}: schema must be an object or boolean`;
  }
  if (typeof schema === "boolean") return undefined;

  const schemaRoot = fullSchema;
  const rootKey = isObjectOrArray(schemaRoot) ? schemaRoot : schema;
  if (context.provenByRoot.get(rootKey)?.has(schema)) return undefined;
  let active = context.activeByRoot.get(rootKey);
  if (active?.has(schema)) {
    context.cuts++;
    return undefined;
  }
  if (!active) {
    active = new WeakSet();
    context.activeByRoot.set(rootKey, active);
  }
  active.add(schema);
  const cutsOnEntry = context.cuts;
  const claimedDefinitions = claimDefinitionScopes(schema, rootKey, context);
  const settledDefinitions = new Set<string>();
  const provenLogMark = context.provenLog.length;

  try {
    if (Object.hasOwn(schema, "$ref")) {
      if (typeof schema.$ref !== "string" || schema.$ref.length === 0) {
        return `${path}: schema $ref must be a non-empty string`;
      }
      let activeRefs = context.activeRefsByRoot.get(rootKey);
      if (activeRefs?.has(schema.$ref)) {
        context.cuts++;
        return undefined;
      }
      if (!activeRefs) {
        activeRefs = new Set();
        context.activeRefsByRoot.set(rootKey, activeRefs);
      }
      activeRefs.add(schema.$ref);
      const resolved = resolveCfcSchemaRef(schemaRoot, schema.$ref);
      if (resolved === undefined) {
        activeRefs.delete(schema.$ref);
        return `${path}: cannot resolve schema reference ${schema.$ref}`;
      }
      const resolvedRoot = cfcSchemaResolvedRoot(
        resolved,
        resolveCfcSchemaRefRoot(schema, schemaRoot),
      );
      const issue = validateSchemaDefinitionInternal(
        resolved,
        resolvedRoot,
        `${path}.$ref`,
        context,
      );
      activeRefs.delete(schema.$ref);
      if (issue !== undefined) return issue;
    }

    const typeIssue = schemaTypeDefinitionIssue(schema.type);
    if (typeIssue !== undefined) return `${path}: ${typeIssue}`;

    if (
      "scope" in schema &&
      !hasOwnEnumerableDataProperty(schema, "scope")
    ) {
      return `${path}.scope: must be an own enumerable data property`;
    }
    if (schema.scope !== undefined && !isSchemaScope(schema.scope)) {
      return `${path}.scope: must be space, user, session, or any`;
    }
    if (
      "asCell" in schema &&
      !hasOwnEnumerableDataProperty(schema, "asCell")
    ) {
      return `${path}.asCell: must be an own enumerable data property`;
    }
    if (schema.asCell !== undefined) {
      if (
        !Array.isArray(schema.asCell) || schema.asCell.length === 0 ||
        !isDenseArray(schema.asCell)
      ) {
        return `${path}.asCell: must be a non-empty dense array`;
      }
      for (let index = 0; index < schema.asCell.length; index++) {
        const entry = schema.asCell[index] as unknown;
        if (isCellKind(entry)) continue;
        if (!isObjectNotArray(entry)) {
          return `${path}.asCell[${index}]: must be a cell kind or descriptor`;
        }
        if (!hasOwnEnumerableDataProperty(entry, "kind")) {
          return `${path}.asCell[${index}].kind: must be an own enumerable data property`;
        }
        if (!isCellKind(entry.kind)) {
          return `${path}.asCell[${index}].kind: unsupported cell kind ${
            String(entry.kind)
          }`;
        }
        if (
          "scope" in entry &&
          !hasOwnEnumerableDataProperty(entry, "scope")
        ) {
          return `${path}.asCell[${index}].scope: must be an own enumerable data property`;
        }
        if (entry.scope !== undefined && !isSchemaScope(entry.scope)) {
          return `${path}.asCell[${index}].scope: must be space, user, session, or any`;
        }
      }
    }

    for (
      const key of [
        "properties",
        "patternProperties",
        "$defs",
        "definitions",
        "dependentSchemas",
      ] as const
    ) {
      const value = schema[key];
      if (value === undefined) continue;
      if (!isObjectNotArray(value)) {
        return `${path}.${key}: must be an object of schemas`;
      }
    }

    const constraintIssue = strictConstraintDefinitionIssue(
      schema,
      context.structuredResult,
    );
    if (constraintIssue !== undefined) return `${path}: ${constraintIssue}`;

    if (schema.required !== undefined) {
      if (
        !Array.isArray(schema.required) ||
        !isDenseArray(schema.required) ||
        !schema.required.every((entry) => typeof entry === "string") ||
        new Set(schema.required).size !== schema.required.length
      ) {
        return `${path}.required: must be an array of unique strings`;
      }
    }
    if (schema.dependentRequired !== undefined) {
      if (
        !isObjectNotArray(schema.dependentRequired)
      ) {
        return `${path}.dependentRequired: must be an object`;
      }
      for (
        const [key, dependencies] of Object.entries(
          schema.dependentRequired,
        )
      ) {
        if (
          !Array.isArray(dependencies) ||
          !isDenseArray(dependencies) ||
          !dependencies.every((entry) => typeof entry === "string") ||
          new Set(dependencies).size !== dependencies.length
        ) {
          return `${path}.dependentRequired.${key}: must be an array of unique strings`;
        }
      }
    }
    if (
      schema.uniqueItems !== undefined &&
      typeof schema.uniqueItems !== "boolean"
    ) {
      return `${path}.uniqueItems: must be a boolean`;
    }
    if (schema.enum !== undefined) {
      if (
        !Array.isArray(schema.enum) || schema.enum.length === 0 ||
        !isDenseArray(schema.enum)
      ) {
        return `${path}.enum: must be a non-empty array`;
      }
      for (let index = 0; index < schema.enum.length; index++) {
        if (
          schema.enum.slice(0, index).some((entry) =>
            fabricAwareEqual(entry, schema.enum![index])
          )
        ) {
          return `${path}.enum: values must be unique`;
        }
      }
    }

    for (const key of ["allOf", "anyOf", "oneOf"] as const) {
      const children = schema[key];
      if (children === undefined) continue;
      if (
        !Array.isArray(children) || children.length === 0 ||
        !isDenseArray(children)
      ) {
        return `${path}.${key}: must be a non-empty schema array`;
      }
      for (let index = 0; index < children.length; index++) {
        const issue = validateSchemaDefinitionInternal(
          children[index],
          schemaRoot,
          `${path}.${key}[${index}]`,
          context,
        );
        if (issue !== undefined) return issue;
      }
    }
    if (schema.prefixItems !== undefined) {
      if (
        !Array.isArray(schema.prefixItems) ||
        !isDenseArray(schema.prefixItems)
      ) {
        return `${path}.prefixItems: must be a schema array`;
      }
      for (let index = 0; index < schema.prefixItems.length; index++) {
        const issue = validateSchemaDefinitionInternal(
          schema.prefixItems[index],
          schemaRoot,
          `${path}.prefixItems[${index}]`,
          context,
        );
        if (issue !== undefined) return issue;
      }
    }

    for (
      const key of context.structuredResult
        ? [...SINGLE_SUBSCHEMA_KEYS, ...UNUSED_SINGLE_SUBSCHEMA_KEYS]
        : [
          "additionalProperties",
          "contains",
          "contentSchema",
          "else",
          "if",
          "items",
          "not",
          "propertyNames",
          "then",
        ] as const
    ) {
      const child = schema[key];
      if (child === undefined) continue;
      const issue = validateSchemaDefinitionInternal(
        child,
        schemaRoot,
        `${path}.${key}`,
        context,
      );
      if (issue !== undefined) return issue;
    }

    for (
      const key of [
        "properties",
        "patternProperties",
        "$defs",
        "definitions",
        "dependentSchemas",
      ] as const
    ) {
      const children = schema[key];
      if (children === undefined) continue;
      // A definition map reached again under the same root has the same bodies
      // and resolves them against the same root, so whichever schema claimed it
      // on entry already covers it.
      const isDefinitionScope = key === "$defs" || key === "definitions";
      if (isDefinitionScope && !claimedDefinitions?.has(key)) continue;
      const cutsBeforeScope = context.cuts;
      for (const [name, child] of Object.entries(children)) {
        const issue = validateSchemaDefinitionInternal(
          child,
          schemaRoot,
          `${path}.${key}.${name}`,
          context,
        );
        if (issue !== undefined) return issue;
      }
      if (isDefinitionScope) {
        settledDefinitions.add(key);
        if (context.cuts !== cutsBeforeScope) {
          releaseCutDefinitionScope(rootKey, children, context, provenLogMark);
        }
      }
    }

    if (context.cuts === cutsOnEntry) {
      let proven = context.provenByRoot.get(rootKey);
      if (!proven) {
        proven = new WeakSet();
        context.provenByRoot.set(rootKey, proven);
      }
      if (!proven.has(schema)) {
        proven.add(schema);
        context.provenLog.push({ rootKey, schema });
      }
    }
    return undefined;
  } finally {
    active.delete(schema);
    for (const key of claimedDefinitions ?? []) {
      if (settledDefinitions.has(key)) continue;
      const definitions = schema[key];
      if (isObjectOrArray(definitions)) {
        releaseCutDefinitionScope(rootKey, definitions, context, provenLogMark);
      }
    }
  }
};

interface SchemaValidationOptions {
  strictConstraints: boolean;
  implicitAdditionalPropertiesOpen: boolean;
  acceptOpaqueValue?: (
    value: unknown,
    schema: JSONSchema,
    fullSchema: JSONSchema,
  ) => boolean;
  optionalUndefinedIsAbsent?: boolean;

  /**
   * Property names an object may carry without the schema modelling them —
   * the reserved keys of whatever produced the value, whose NAMES are fixed by
   * a framework rather than chosen by the value's author.
   *
   * They are excused from the additional-property rules ONLY. A name in this
   * set that the schema DOES model is measured against what the schema says
   * about it, exactly as it would be otherwise: excusing a key from the
   * unmodeled-key policy is not a licence to skip its constraints.
   *
   * The exemption reaches the ROOT value of one validation and no further —
   * see {@link nestedValueValidationOptions}.
   */
  reservedAdditionalProperties?: ReadonlySet<string>;
}

/**
 * `options` as they apply to a value nested INSIDE the value being measured.
 *
 * A reserved name is reserved because the framework that produced THIS value
 * fixed its spelling — a pattern result carries `$NAME` and `$UI` at its top
 * level whatever the caller's schema says. Nothing fixes the spelling of a key
 * one level down: that key was chosen by whoever wrote the data there, and its
 * NAME may itself be data. So the exemption stops at the root, and a nested
 * object carrying an unmodeled `$NAME` is simply an object with an unmodeled
 * key, answered by the unmodeled-key rules like any other.
 *
 * Only a recursion that changes the VALUE takes this. A combinator branch, a
 * resolved `$ref`, `not`/`if`/`then`/`else` and `dependentSchemas` all measure
 * the SAME value against another schema, so they keep the options they were
 * given — the root is still the root however many schemas describe it.
 */
const nestedValueValidationOptions = (
  options: SchemaValidationOptions,
): SchemaValidationOptions =>
  options.reservedAdditionalProperties === undefined
    ? options
    : { ...options, reservedAdditionalProperties: undefined };

export interface SchemaValueValidationOptions {
  /**
   * Accept runtime materializations such as Cell handles whose schema was
   * already proven by canonical traversal, without treating the handle object
   * itself as the schema's underlying value.
   */
  acceptOpaqueValue?: (
    value: unknown,
    schema: JSONSchema,
    fullSchema: JSONSchema,
  ) => boolean;

  /**
   * Read an OPTIONAL property whose value is `undefined` as absent instead of
   * measuring it against the property's declared type.
   *
   * OFF by default, and deliberately: `undefined` is a value here, not a hole.
   * The codec stores its presence (`{"/Undefined@1": null}`),
   * `type: "undefined"` is a type this validator supports, and a caller writing
   * `undefined` where a number is declared has made a mistake worth rejecting
   * while they can still see it -- `pull-materialization.test.ts` pins that with
   * "does not hide present explicit undefined behind an optional alias" and
   * "retains explicit undefined at an optional derived Cell root".
   *
   * ON for one caller: the STORED-ARGUMENT check a pattern update runs. That
   * asks a different question -- "can this version read the document already
   * there" -- and answers it with a refusal that is PERMANENT
   * (`isStoredArgumentSchemaRefusal` in `../runner.ts`: the same identity
   * refuses identically, so a root pinned to a version whose schema cannot read
   * its own document never opens again). A key holding `undefined` carries no
   * data, and a handler mints one without meaning to: measured,
   * `packages/patterns/topics/topic.tsx` does `comments.push({ author, ... })`
   * with no author whenever `addComment` gets no `agentName`, and
   * `lunch-poll/main.tsx` does the same with `imageUrl`. Refusing those
   * documents forever is the wrong trade; rejecting a bad write now is the
   * right one.
   */
  optionalUndefinedIsAbsent?: boolean;
}

const EMPTY_RESERVED: ReadonlySet<string> = new Set<string>();

const SANITIZATION_VALIDATION: SchemaValidationOptions = {
  strictConstraints: false,
  implicitAdditionalPropertiesOpen: false,
};

const VALUE_VALIDATION: SchemaValidationOptions = {
  strictConstraints: true,
  implicitAdditionalPropertiesOpen: true,
};

interface SchemaValidationContext {
  activeByRoot: WeakMap<object, SchemaRootValidationActivity>;

  /** Completed object proofs, keyed by options, schema root, schema, and value. */
  successful: WeakMap<
    SchemaValidationOptions,
    WeakMap<object, WeakMap<object, WeakSet<object>>>
  >;

  /** Active recursion cutoffs encountered during this validation. */
  cycleVersion: number;
}

interface SchemaRootValidationActivity {
  activeObjectValues: WeakMap<object, WeakSet<object>>;
  activePrimitiveValues: WeakMap<object, Set<string>>;
}

interface SchemaValidationFailure {
  kind: "mismatch" | "indeterminate";
  message: string;
}

const mismatch = (message: string): SchemaValidationFailure => ({
  kind: "mismatch",
  message,
});

const indeterminate = (message: string): SchemaValidationFailure => ({
  kind: "indeterminate",
  message,
});

const atValidationPath = (
  path: string | number,
  failure: SchemaValidationFailure,
): SchemaValidationFailure => ({
  ...failure,
  message: `${path}: ${failure.message}`,
});

const createSchemaValidationContext = (): SchemaValidationContext => ({
  activeByRoot: new WeakMap(),
  successful: new WeakMap(),
  cycleVersion: 0,
});

const primitiveValidationKey = (value: unknown): string =>
  `${typeof value}:${String(value)}`;

const markSchemaValueActive = (
  root: object,
  schema: object,
  value: unknown,
  context: SchemaValidationContext,
): boolean => {
  let activity = context.activeByRoot.get(root);
  if (!activity) {
    activity = {
      activeObjectValues: new WeakMap(),
      activePrimitiveValues: new WeakMap(),
    };
    context.activeByRoot.set(root, activity);
  }
  if (
    isObjectOrArray(value) ||
    typeof value === "function"
  ) {
    const objectValue = value as object;
    let active = activity.activeObjectValues.get(schema);
    if (active?.has(objectValue)) return false;
    if (!active) {
      active = new WeakSet();
      activity.activeObjectValues.set(schema, active);
    }
    active.add(objectValue);
    return true;
  }
  const key = primitiveValidationKey(value);
  let active = activity.activePrimitiveValues.get(schema);
  if (active?.has(key)) return false;
  if (!active) {
    active = new Set();
    activity.activePrimitiveValues.set(schema, active);
  }
  active.add(key);
  return true;
};

const unmarkSchemaValueActive = (
  root: object,
  schema: object,
  value: unknown,
  context: SchemaValidationContext,
): void => {
  const activity = context.activeByRoot.get(root);
  if (!activity) return;
  if (
    isObjectOrArray(value) ||
    typeof value === "function"
  ) {
    activity.activeObjectValues.get(schema)?.delete(value as object);
    return;
  }
  activity.activePrimitiveValues.get(schema)?.delete(
    primitiveValidationKey(value),
  );
};

const isSchemaObject = (
  schema: JSONSchema | undefined,
): schema is ReadonlyRecord => isObjectNotArray(schema);

/**
 * Follow `$ref` chains to the schema they name, so a `default` behind one is
 * still seen. Resolution is the canonical resolver's, not a private pointer
 * parser: each hop goes through `resolveCfcSchemaRef` (which decodes JSON
 * Pointer escapes, so `#/$defs/A~1B` names the `"A/B"` definition, and
 * resolves the embedded-schema URIs) against the document root, with each
 * hop's root tracked the way `resolveCfcSchemaRefRoot` tracks it, so this
 * gate resolves a ref exactly as the runtime's own materialization does.
 *
 * Chains are followed to their end; anything the canonical resolver does not
 * resolve (a remote non-embedded ref, a `definitions` pointer — hoisting
 * emits `$defs` only, so the runtime cannot resolve those either — a missing
 * entry, a cycle) yields the last schema reached rather than failing. For
 * the gates built on this, unresolvable keeps the field required, so the
 * call is refused and the invocation id survives for a corrected retry.
 */
export function localRefTarget(
  schema: JSONSchema,
  root: JSONSchema,
): JSONSchema {
  let current = schema;
  let currentRoot = root;
  const seenRefs = new Map<JSONSchema, Set<string>>();
  while (isSchemaObject(current) && typeof current.$ref === "string") {
    const ref = current.$ref;
    let refsForRoot = seenRefs.get(currentRoot);
    if (refsForRoot?.has(ref)) return current;
    if (!refsForRoot) {
      refsForRoot = new Set();
      seenRefs.set(currentRoot, refsForRoot);
    }
    refsForRoot.add(ref);
    const next = resolveCfcSchemaRef(currentRoot, ref);
    if (next === undefined) return current;
    currentRoot = cfcSchemaResolvedRoot(
      next,
      isEmbeddedCfcSchemaRef(ref) ? next : currentRoot,
    );
    current = next;
  }
  return current;
}

/**
 * A copy of `schema` whose `required` lists omit properties that carry their
 * own `default`.
 *
 * The runtime injects a property's default when the payload leaves it out (the
 * schema read path in runner `schema.ts`), so such a property is satisfiable
 * without the caller supplying it. Validating against the unrelaxed schema
 * would reject payloads the verb would have accepted.
 *
 * This is honest only for a payload that is PRESENT (measured 2026-07-30,
 * recorded on #5147): `SchemaObjectTraverser.#traverseObjectWithSchema` (runner
 * `traverse.ts`) fills each missing defaulted property of a present object
 * before checking `required`, while a wholly absent event bypasses the object
 * branch entirely — the handler sees `undefined` and no default is ever
 * conjured. The CLI's absent-payload gate therefore normalizes an absent
 * payload to `{}` before consulting this relaxation; absence is never excused
 * by it.
 *
 * What this relaxation does NOT check — the boundary, named so nobody assumes
 * it: only `required` lists are rewritten. Every other validation
 * `validateSchemaValue` applies runs against the original schema text —
 * `additionalProperties`, `patternProperties`, `minProperties` and the other
 * object/array/string/number constraints, `const`/`enum`, `not` and
 * `if`/`then`/`else`, and `oneOf` exclusivity. None of them is re-judged as
 * if the runtime's defaults had already been filled in, so a schema that
 * leans on a defaulted property through one of them (say `minProperties: 1`
 * over a single all-defaulted property, or an `if` conditioned on it) can
 * refuse a payload the runtime would have completed from defaults — a
 * refused-but-valid call, the conservative side of this gate.
 *
 * `seen` both memoizes and breaks reference cycles: the relaxed copy is
 * registered before its children are filled in, so a schema that reaches
 * itself resolves to the copy already under construction. The memo is keyed
 * by schema object identity alone — cycle-breaking requires registering
 * before the document of every reaching path is known — so a schema OBJECT
 * shared verbatim across two different documents relaxes in the document
 * that reaches it first. Generated schemas do not share fragment objects
 * across documents, so this stays theoretical.
 *
 * The document is threaded rather than assumed: every ref consulted for a
 * `default` and every recursion below resolves against the document root,
 * with the per-hop tracking `localRefTarget` applies, so a property `$ref`
 * resolves to the definition the runtime materializes from rather than to a
 * same-named decoy elsewhere.
 */
export function relaxDefaultedRequired(
  schema: JSONSchema,
  root: JSONSchema,
  seen: Map<object, JSONSchema>,
): JSONSchema {
  if (!isSchemaObject(schema)) return schema;
  const cached = seen.get(schema);
  if (cached !== undefined) return cached;

  const relaxed: Record<string, unknown> = { ...schema };
  seen.set(schema, relaxed as JSONSchema);

  const scopeRoot = root;

  const properties = schema.properties;
  if (isSchemaObject(properties)) {
    const defaulted = new Set<string>();
    const next: Record<string, JSONSchema> = {};
    for (
      const [key, propSchema] of Object.entries(
        properties as Record<string, JSONSchema>,
      )
    ) {
      const target = localRefTarget(propSchema, scopeRoot);
      // A property counts as defaulted only when the runtime would inject
      // its default on read: a `default` on the property schema itself is
      // read directly (ref-site siblings included — the default-injection
      // read in runner `schema.ts` consults `propSchema.default` without
      // resolving the ref), and a `default` on a fully RESOLVED chain end is
      // materialized through the resolved view. A default stranded on an
      // unresolvable chain's last reachable wrapper is neither: the runtime
      // cannot resolve past it, so crediting it would admit `{}` and spend
      // the invocation id on a handling missing the field. An unresolvable
      // chain keeps the field required (fail-closed), matching
      // `localRefTarget`'s contract for the gates.
      const chainEndResolved = isSchemaObject(target) &&
        typeof target.$ref !== "string";
      if (
        (isSchemaObject(propSchema) && propSchema.default !== undefined) ||
        (chainEndResolved && target.default !== undefined)
      ) {
        defaulted.add(key);
      }
      next[key] = relaxDefaultedRequired(propSchema, scopeRoot, seen);
    }
    relaxed.properties = next;
    if (Array.isArray(schema.required)) {
      relaxed.required = (schema.required as string[]).filter(
        (key) => !defaulted.has(key),
      );
    }
  }

  // `items` is a single schema here; the validator rejects the legacy tuple
  // form of `items` outright ("schema must be an object or boolean"). Tuples
  // are `prefixItems`, whose slot schemas get the same treatment — a present
  // tuple-slot object is materialized like any present object.
  if (schema.items !== undefined) {
    relaxed.items = relaxDefaultedRequired(
      schema.items as JSONSchema,
      scopeRoot,
      seen,
    );
  }
  if (Array.isArray(schema.prefixItems)) {
    relaxed.prefixItems = (schema.prefixItems as JSONSchema[]).map((entry) =>
      relaxDefaultedRequired(entry, scopeRoot, seen)
    );
  }

  const fields = schema as Record<string, unknown>;
  for (const combinator of ["anyOf", "oneOf", "allOf"]) {
    const branches = fields[combinator];
    if (Array.isArray(branches)) {
      relaxed[combinator] = (branches as JSONSchema[]).map((entry) =>
        relaxDefaultedRequired(entry, scopeRoot, seen)
      );
    }
  }

  for (const pool of ["$defs", "definitions"]) {
    const defs = fields[pool];
    if (isSchemaObject(defs as JSONSchema)) {
      const next: Record<string, JSONSchema> = {};
      for (
        const [key, entry] of Object.entries(defs as Record<string, JSONSchema>)
      ) {
        next[key] = relaxDefaultedRequired(entry, scopeRoot, seen);
      }
      relaxed[pool] = next;
    }
  }

  return relaxed as JSONSchema;
}

export const validateSchemaValue = (
  schema: JSONSchema,
  value: unknown,
  fullSchema: JSONSchema = schema,
  validationOptions: SchemaValueValidationOptions = {},
): string | undefined =>
  validateAgainstSchemaInternal(
    schema,
    value,
    fullSchema,
    { ...VALUE_VALIDATION, ...validationOptions },
    createSchemaValidationContext(),
  )?.message;

export const validateAgainstSchema = (
  schema: JSONSchema,
  value: unknown,
  fullSchema: JSONSchema = schema,
  options: SchemaValidationOptions = SANITIZATION_VALIDATION,
): string | undefined =>
  validateAgainstSchemaInternal(
    schema,
    value,
    fullSchema,
    options,
    createSchemaValidationContext(),
  )?.message;

/**
 * `validateAgainstSchema()` with a set of reserved property names excused from
 * the unmodeled-key rules, which is the question the structured-result
 * sanitizer asks of every value it measures.
 *
 * A reserved name is one whose SPELLING belongs to the framework that produced
 * the value rather than to whoever described it — a pattern result always
 * carries `$NAME` and `$UI`, whatever the caller's schema says. Excusing them
 * from the unmodeled-key rules is what keeps a schema describing only the
 * computed fields from failing on the framework's own. It excuses nothing
 * else: a reserved name the schema DOES model is measured against what the
 * schema says about it.
 */
export const validateAgainstSchemaForSanitization = (
  schema: JSONSchema,
  value: unknown,
  fullSchema: JSONSchema = schema,
  reservedAdditionalProperties: ReadonlySet<string> = EMPTY_RESERVED,
): string | undefined =>
  validateAgainstSchemaInternal(
    schema,
    value,
    fullSchema,
    { ...SANITIZATION_VALIDATION, reservedAdditionalProperties },
    createSchemaValidationContext(),
  )?.message;

/** Reuses completed proofs without turning an active cycle into acceptance. */
const validateAgainstSchemaInternal = (
  schema: JSONSchema,
  value: unknown,
  fullSchema: JSONSchema,
  options: SchemaValidationOptions,
  context: SchemaValidationContext,
): SchemaValidationFailure | undefined => {
  let successful: WeakSet<object> | undefined;
  if (isObjectNotArray(schema) && isObjectOrArray(value)) {
    const schemaRoot = fullSchema;
    const rootKey = isObjectOrArray(schemaRoot) ? schemaRoot : schema;
    let byRoot = context.successful.get(options);
    if (byRoot === undefined) {
      byRoot = new WeakMap();
      context.successful.set(options, byRoot);
    }
    let bySchema = byRoot.get(rootKey);
    if (bySchema === undefined) {
      bySchema = new WeakMap();
      byRoot.set(rootKey, bySchema);
    }
    successful = bySchema.get(schema);
    if (successful?.has(value)) return undefined;
    if (successful === undefined) {
      successful = new WeakSet();
      bySchema.set(schema, successful);
    }
  }
  const cycleVersion = context.cycleVersion;
  const failure = validateAgainstSchemaUncached(
    schema,
    value,
    fullSchema,
    options,
    context,
  );
  // Even an accepted union branch can depend on a recursion cutoff elsewhere
  // in the proof. Only cycle-independent successes can be reused on any path.
  if (failure === undefined && cycleVersion === context.cycleVersion) {
    successful?.add(value as object);
  }
  return failure;
};

/** Checks one schema/value pair with active-path recursion detection. */
const validateAgainstSchemaUncached = (
  schema: JSONSchema,
  value: unknown,
  fullSchema: JSONSchema,
  options: SchemaValidationOptions,
  context: SchemaValidationContext,
): SchemaValidationFailure | undefined => {
  if (schema === true) return undefined;
  if (schema === false) return mismatch("schema rejects all values");
  if (!isObjectNotArray(schema)) {
    return indeterminate("schema must be an object or boolean");
  }
  const schemaRoot = fullSchema;
  const rootKey = isObjectOrArray(schemaRoot) ? schemaRoot : schema;
  if (!markSchemaValueActive(rootKey, schema, value, context)) {
    context.cycleVersion++;
    return indeterminate("recursive schema validation made no progress");
  }

  try {
    const resolved = typeof schema.$ref === "string"
      ? resolveCfcSchemaRefs(schema, schemaRoot)
      : schema;
    if (resolved === undefined) {
      return indeterminate(`cannot resolve schema reference ${schema.$ref}`);
    }
    if (resolved !== schema) {
      // Keep the original root as `fullSchema` so nested $refs in the resolved
      // branch can still find sibling $defs entries, except when an embedded
      // or external ref changes the owning document, or resolution merged
      // ref-site siblings into a view that is a document of its own.
      const resolvedRoot = isObjectOrArray(resolved)
        ? cfcSchemaResolvedRoot(
          resolved,
          resolveCfcSchemaRefRoot(schema, schemaRoot),
        )
        : schemaRoot;
      return validateAgainstSchemaInternal(
        resolved,
        value,
        resolvedRoot,
        options,
        context,
      );
    }
    if (options.acceptOpaqueValue?.(value, schema, schemaRoot)) {
      return undefined;
    }
    const nestedOptions = nestedValueValidationOptions(options);

    if (Array.isArray(schema.allOf)) {
      // `optionalUndefinedIsAbsent` is dropped for the branches. It decides
      // "optional" from the `required` array on the node doing the check, and
      // `allOf` is precisely the combinator that can put `required` on one node
      // and `properties` on another — `{allOf: [{required: ["x"]}, {properties:
      // {x: {type: "string"}}}]}` would then see `x` as optional in the branch
      // that types it and skip the check, accepting `{x: undefined}` against a
      // required string. Measured, and reported by review on #5251.
      //
      // Dropped rather than plumbed: requiredness would have to be accumulated
      // conjunctively down the recursion, and nothing needs it. The generator
      // emits no `allOf` at all (zero occurrences in `packages/schema-generator`
      // and in every committed pattern baseline), so no pattern argument schema
      // — the only place this option is enabled — can reach the branch. Strict
      // is the safe direction for a shape that does not occur.
      const branchOptions = options.optionalUndefinedIsAbsent === true
        ? { ...options, optionalUndefinedIsAbsent: false }
        : options;
      for (const branch of schema.allOf) {
        const failure = validateAgainstSchemaInternal(
          branch,
          value,
          schemaRoot,
          branchOptions,
          context,
        );
        if (failure !== undefined) return failure;
      }
    }
    if (Array.isArray(schema.anyOf)) {
      let matched = false;
      let schemaFailure: SchemaValidationFailure | undefined;
      for (const branch of schema.anyOf) {
        const failure = validateAgainstSchemaInternal(
          branch,
          value,
          schemaRoot,
          options,
          context,
        );
        if (failure === undefined) {
          matched = true;
          break;
        }
        if (failure.kind === "indeterminate") schemaFailure ??= failure;
      }
      if (!matched) {
        return schemaFailure ?? mismatch("value does not match anyOf");
      }
    }
    if (Array.isArray(schema.oneOf)) {
      let matches = 0;
      let schemaFailure: SchemaValidationFailure | undefined;
      for (const branch of schema.oneOf) {
        const failure = validateAgainstSchemaInternal(
          branch,
          value,
          schemaRoot,
          options,
          context,
        );
        if (failure === undefined) matches++;
        else if (failure.kind === "indeterminate") schemaFailure ??= failure;
      }
      if (matches <= 1 && schemaFailure !== undefined) return schemaFailure;
      if (matches !== 1) {
        return mismatch("value does not match exactly one oneOf branch");
      }
    }

    if (
      Array.isArray(schema.enum) &&
      !schema.enum.some((entry) => fabricAwareEqual(entry, value))
    ) {
      return mismatch("value is not in enum");
    }
    if (
      Object.hasOwn(schema, "const") &&
      !fabricAwareEqual(schema.const, value)
    ) {
      return mismatch("value does not match const");
    }

    const typeDefinitionIssue = options.strictConstraints
      ? schemaTypeDefinitionIssue(schema.type)
      : undefined;
    if (typeDefinitionIssue !== undefined) {
      return indeterminate(typeDefinitionIssue);
    }
    const types = asTypeArray(schema.type);
    if (
      types.length > 0 &&
      !types.some((type) => typeMatches(value, type, options.strictConstraints))
    ) {
      return mismatch(`value does not match type ${types.join("|")}`);
    }

    if (options.strictConstraints) {
      const failure = validateStrictSchemaConstraints(
        schema,
        value,
        schemaRoot,
        options,
        context,
      );
      if (failure !== undefined) return failure;
    }

    if (value instanceof FabricPrimitive) {
      // An object-typed schema's `required` keys must exist on the opaque
      // leaf. Unlike the plain-object loop below (own-props via
      // `Object.hasOwn`), a primitive carries its surface as class
      // accessors, so the check is `in` — `FabricBytes.length` satisfies
      // `required: ["length"]`. `typeMatches` stays a permissive filter;
      // this is the complete check behind it. A `FabricPrimitive`-typed
      // schema is not gated (its type never includes "object").
      //
      // Presence only: `properties` sub-schemas are not enforced against
      // accessor values (a schema declaring `source` as a number still
      // matches a FabricRegExp, whose `source` is a string) — the type
      // system doesn't produce such schemas, and the property walk below
      // deliberately stays limited to plain objects.
      const typeAllowsObject = schema.type === undefined ||
        asTypeArray(schema.type).includes("object");
      if (typeAllowsObject && Array.isArray(schema.required)) {
        for (const key of schema.required) {
          // The nominal brand key has no runtime existence; a
          // `FabricSpecialObject` satisfies it by construction (the `TODO`
          // on `FABRIC_SPECIAL_OBJECT_BRAND` says what removing this
          // exemption takes).
          if (key === FABRIC_SPECIAL_OBJECT_BRAND) continue;
          if (!(key in value)) {
            return mismatch(`missing required property ${key}`);
          }
        }
      }
    }

    if (isFabricPlainObjectValue(value)) {
      const requiredKeys = new Set(schema.required ?? []);
      // REQUIRED keeps asking only whether the key is there. A schema may
      // declare `type: "undefined"`, and a required property of that type
      // holds undefined legitimately — so whether undefined belongs at a key
      // is the property schema's question, answered just below, not this
      // loop's.
      for (const key of requiredKeys) {
        if (!Object.hasOwn(value, key)) {
          return mismatch(`missing required property ${key}`);
        }
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (
          Object.hasOwn(value, key) &&
          !isAbsentOptional(value, key, requiredKeys, options)
        ) {
          const failure = validateAgainstSchemaInternal(
            child,
            value[key],
            schemaRoot,
            nestedOptions,
            context,
          );
          if (failure !== undefined) return atValidationPath(key, failure);
        }
      }
      // Reserved names are excused from the unmodeled-key rules below; a
      // reserved name the schema models was already measured against it above.
      const reserved = options.reservedAdditionalProperties ?? EMPTY_RESERVED;
      const explicitlyClosed = schema.additionalProperties === false;
      const closesAdditionalProperties = options
          .implicitAdditionalPropertiesOpen
        ? explicitlyClosed
        : cfcObjectSchemaIsClosed(schema);
      // A node that closes only by the implicit default defers to the shape
      // its combinator branches declare; one that says `additionalProperties:
      // false` in so many words is taken at its word.
      const branchSurface = explicitlyClosed
        ? { known: new Set<string>(), open: false }
        : cfcCombinatorObjectSurface(schema, schemaRoot);
      if (closesAdditionalProperties && !branchSurface.open) {
        const known = new Set([
          ...Object.keys(schema.properties ?? {}),
          ...branchSurface.known,
        ]);
        const patterns = options.strictConstraints
          ? Object.keys(schema.patternProperties ?? {}).map((pattern) =>
            new RegExp(pattern)
          )
          : [];
        const extra = Object.keys(value).find((key) =>
          !known.has(key) && !reserved.has(key) &&
          !patterns.some((pattern) => pattern.test(key))
        );
        if (extra !== undefined) {
          return mismatch(`additional property ${extra}`);
        }
      } else if (typeof schema.additionalProperties === "object") {
        const known = new Set(Object.keys(schema.properties ?? {}));
        const patterns = options.strictConstraints
          ? Object.keys(schema.patternProperties ?? {}).map((pattern) =>
            new RegExp(pattern)
          )
          : [];
        for (const key of Object.keys(value)) {
          if (
            !known.has(key) && !reserved.has(key) &&
            !patterns.some((pattern) => pattern.test(key))
          ) {
            const failure = validateAgainstSchemaInternal(
              schema.additionalProperties,
              value[key],
              schemaRoot,
              nestedOptions,
              context,
            );
            if (failure !== undefined) return atValidationPath(key, failure);
          }
        }
      }
    }

    if (
      !options.strictConstraints && Array.isArray(value) &&
      typeof schema.items === "object"
    ) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) continue;
        const failure = validateAgainstSchemaInternal(
          schema.items,
          value[index],
          schemaRoot,
          nestedOptions,
          context,
        );
        if (failure !== undefined) return atValidationPath(index, failure);
      }
    }

    return undefined;
  } finally {
    unmarkSchemaValueActive(rootKey, schema, value, context);
  }
};

function validateStrictSchemaConstraints(
  schema: Exclude<JSONSchema, boolean>,
  value: unknown,
  fullSchema: JSONSchema,
  options: SchemaValidationOptions,
  context: SchemaValidationContext,
): SchemaValidationFailure | undefined {
  const definitionIssue = strictConstraintDefinitionIssue(schema);
  if (definitionIssue !== undefined) return indeterminate(definitionIssue);
  const nestedOptions = nestedValueValidationOptions(options);

  if (schema.not !== undefined) {
    const failure = validateAgainstSchemaInternal(
      schema.not,
      value,
      fullSchema,
      options,
      context,
    );
    if (failure === undefined) {
      return mismatch("value matches disallowed not schema");
    }
    if (failure.kind === "indeterminate") return failure;
  }
  if (schema.if !== undefined) {
    const conditionFailure = validateAgainstSchemaInternal(
      schema.if,
      value,
      fullSchema,
      options,
      context,
    );
    if (conditionFailure?.kind === "indeterminate") return conditionFailure;
    const conditionMatches = conditionFailure === undefined;
    const selected = conditionMatches ? schema.then : schema.else;
    if (selected !== undefined) {
      const failure = validateAgainstSchemaInternal(
        selected,
        value,
        fullSchema,
        options,
        context,
      );
      if (failure !== undefined) return failure;
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return mismatch(`value is below minimum ${schema.minimum}`);
    }
    if (
      schema.exclusiveMinimum !== undefined &&
      value <= schema.exclusiveMinimum
    ) {
      return mismatch(
        `value is not above exclusiveMinimum ${schema.exclusiveMinimum}`,
      );
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return mismatch(`value is above maximum ${schema.maximum}`);
    }
    if (
      schema.exclusiveMaximum !== undefined &&
      value >= schema.exclusiveMaximum
    ) {
      return mismatch(
        `value is not below exclusiveMaximum ${schema.exclusiveMaximum}`,
      );
    }
    if (schema.multipleOf !== undefined) {
      const quotient = value / schema.multipleOf;
      const tolerance = Number.EPSILON * Math.max(1, Math.abs(quotient)) * 4;
      if (
        schema.multipleOf <= 0 ||
        Math.abs(quotient - Math.round(quotient)) > tolerance
      ) {
        return mismatch(`value is not a multiple of ${schema.multipleOf}`);
      }
    }
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      return mismatch(`value is shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      return mismatch(`value is longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined) {
      // strictConstraintDefinitionIssue() compiled this expression above.
      const pattern = new RegExp(schema.pattern);
      if (!pattern.test(value)) return mismatch(`value does not match pattern`);
    }
    if (schema.format !== undefined) {
      if (!valueMatchesFormat(value, schema.format)) {
        return mismatch(`value does not match format ${schema.format}`);
      }
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return mismatch(`array has fewer than minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return mismatch(`array has more than maxItems ${schema.maxItems}`);
    }
    if (schema.uniqueItems === true) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) continue;
        if (
          value.slice(0, index).some((entry) =>
            fabricAwareEqual(entry, value[index])
          )
        ) {
          return mismatch("array items are not unique");
        }
      }
    }
    for (let index = 0; index < (schema.prefixItems?.length ?? 0); index++) {
      if (index >= value.length) break;
      if (!Object.hasOwn(value, index)) continue;
      const failure = validateAgainstSchemaInternal(
        schema.prefixItems![index],
        value[index],
        fullSchema,
        nestedOptions,
        context,
      );
      if (failure !== undefined) return atValidationPath(index, failure);
    }
    if (schema.items !== undefined) {
      const start = schema.prefixItems?.length ?? 0;
      for (let index = start; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) continue;
        const failure = validateAgainstSchemaInternal(
          schema.items,
          value[index],
          fullSchema,
          nestedOptions,
          context,
        );
        if (failure !== undefined) return atValidationPath(index, failure);
      }
    }
    if (schema.contains !== undefined) {
      let matches = 0;
      let indeterminateMatches = 0;
      let schemaFailure: SchemaValidationFailure | undefined;
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) continue;
        const failure = validateAgainstSchemaInternal(
          schema.contains,
          value[index],
          fullSchema,
          nestedOptions,
          context,
        );
        if (failure === undefined) matches++;
        else if (failure.kind === "indeterminate") {
          indeterminateMatches++;
          schemaFailure ??= failure;
        }
      }
      const minimum = schema.minContains ?? 1;
      if (matches + indeterminateMatches < minimum) {
        return mismatch(`array has fewer than ${minimum} matches`);
      }
      if (schema.maxContains !== undefined && matches > schema.maxContains) {
        return mismatch(`array has more than ${schema.maxContains} matches`);
      }
      if (
        schemaFailure !== undefined &&
        (matches < minimum ||
          (schema.maxContains !== undefined &&
            matches + indeterminateMatches > schema.maxContains))
      ) {
        return schemaFailure;
      }
    }
  }

  if (isFabricPlainObjectValue(value)) {
    const propertyCount = Object.keys(value).length;
    if (
      schema.minProperties !== undefined &&
      propertyCount < schema.minProperties
    ) {
      return mismatch(
        `object has fewer than minProperties ${schema.minProperties}`,
      );
    }
    if (
      schema.maxProperties !== undefined &&
      propertyCount > schema.maxProperties
    ) {
      return mismatch(
        `object has more than maxProperties ${schema.maxProperties}`,
      );
    }
    for (
      const [key, dependencies] of Object.entries(
        schema.dependentRequired ?? {},
      )
    ) {
      if (Object.hasOwn(value, key)) {
        const missing = dependencies.find((dependency) =>
          !Object.hasOwn(value, dependency)
        );
        if (missing !== undefined) {
          return mismatch(`${key}: missing dependent property ${missing}`);
        }
      }
    }
    for (
      const [key, dependentSchema] of Object.entries(
        schema.dependentSchemas ?? {},
      )
    ) {
      if (Object.hasOwn(value, key)) {
        const failure = validateAgainstSchemaInternal(
          dependentSchema,
          value,
          fullSchema,
          options,
          context,
        );
        if (failure !== undefined) return atValidationPath(key, failure);
      }
    }
    if (schema.propertyNames !== undefined) {
      for (const key of Object.keys(value)) {
        const failure = validateAgainstSchemaInternal(
          schema.propertyNames,
          key,
          fullSchema,
          nestedOptions,
          context,
        );
        if (failure !== undefined) return atValidationPath(key, failure);
      }
    }
    for (
      const [source, childSchema] of Object.entries(
        schema.patternProperties ?? {},
      )
    ) {
      // strictConstraintDefinitionIssue() compiled this expression above.
      const pattern = new RegExp(source);
      for (const [key, child] of Object.entries(value)) {
        if (pattern.test(key)) {
          const failure = validateAgainstSchemaInternal(
            childSchema,
            child,
            fullSchema,
            nestedOptions,
            context,
          );
          if (failure !== undefined) return atValidationPath(key, failure);
        }
      }
    }
  }

  if (
    schema.contentEncoding !== undefined ||
    schema.contentMediaType !== undefined ||
    schema.contentSchema !== undefined
  ) {
    return indeterminate("content validation is not supported");
  }
  return undefined;
}

function valueMatchesFormat(value: string, format: string): boolean {
  switch (format) {
    case "email": {
      const separator = value.lastIndexOf("@");
      if (separator <= 0 || separator === value.length - 1) return false;
      const local = value.slice(0, separator);
      const domain = value.slice(separator + 1);
      const dotAtom = !local.startsWith(".") && !local.endsWith(".") &&
        !local.includes("..") &&
        /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local);
      const quoted = /^"(?:[\x20-\x21\x23-\x5B\x5D-\x7E]|\\[\x20-\x7E])*"$/
        .test(
          local,
        );
      if (
        local.length === 0 || local.length > 64 || domain.length === 0 ||
        domain.length > 255 || (!dotAtom && !quoted) || domain.includes("..")
      ) {
        return false;
      }
      const labels = domain.split(".");
      return labels.every((label) =>
        label.length > 0 && label.length <= 63 &&
        !label.startsWith("-") && !label.endsWith("-") &&
        /^[A-Za-z0-9-]+$/.test(label)
      );
    }
    case "uri":
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    case "date":
      return valueMatchesDate(value);
    case "date-time": {
      const match =
        /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/
          .exec(value);
      if (!match || !valueMatchesDate(match[1])) return false;
      const hour = Number(match[2]);
      const minute = Number(match[3]);
      const second = Number(match[4]);
      const offsetHour = match[6] === undefined ? 0 : Number(match[6]);
      const offsetMinute = match[7] === undefined ? 0 : Number(match[7]);
      return hour <= 23 && minute <= 59 && second <= 60 &&
        offsetHour <= 23 && offsetMinute <= 59;
    }
    default:
      return false;
  }
}

function valueMatchesDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 10) === value;
}
