import type { CfcAtom } from "@commonfabric/api/cfc";
import {
  hashStringOf,
  isWalkableObjectOrArray,
} from "@commonfabric/data-model";
import { internSchema } from "@commonfabric/data-model-schema";
import {
  formatExternalSchemaRef,
  parseExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import {
  forEachSubschema,
  mapSubschemas,
} from "@commonfabric/data-model-schema/schema-walk";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import { utf8Compare } from "@commonfabric/utils/utf8";

import type { JSONSchema, JSONSchemaObj } from "../builder/types.ts";
import { registerSchemaDocument } from "../schema-registry.ts";
import type { CfcConfClause } from "./clause.ts";
import { normalizeClause } from "./clause.ts";
import {
  bindCurrentPrincipalToStoredClauses,
  isCurrentPrincipalUserClause,
} from "./current-principal-confidentiality.ts";
import { CfcSchemaMigrationError } from "./migration-reason.ts";
import {
  cfcSchemaResolvedRoot,
  hoistCfcSchemaDefs,
  localDefinitionName,
  resolveCfcSchemaRefRoot,
  resolveCfcSchemaRefs,
} from "./schema-refs.ts";
import {
  writerClaimFilesCorrespond,
  writerClaimPatternFilesCorrespond,
} from "./writer-claim-correspondence.ts";

/** Every `ifc` key the runtime understands. {@link IfcKey} names one of them. */
const IFC_KEYS = [
  "confidentiality",
  "integrity",
  "addIntegrity",
  "requiredIntegrity",
  "maxConfidentiality",
  "ownerPrincipal",
  "writeAuthorizedBy",
  "exactCopyOf",
  "projection",
  "collection",
  // Reserved legacy key: minted by nothing (the list builtins' per-element
  // transactions make pointwise precision structural) and consumed by
  // nothing, but already-persisted link schemas embed it, so merging
  // tolerates it.
  "flowPrecisionClaim",
  "uiContract",
] as const;

/**
 * One of the `ifc` keys the runtime understands.
 *
 * A consumer that has to treat the keys differently from one another states a
 * decision for each of them, and a mapped type over this union does not compile
 * until it has. Adding a key here is what tells such a consumer that a new one
 * arrived.
 */
export type IfcKey = typeof IFC_KEYS[number];

const asSchemaObject = (
  schema: JSONSchema,
  path: string,
): JSONSchemaObj => {
  if (schema === true) {
    return {};
  }
  if (!isObjectOrArray(schema)) {
    throw new Error(`unsupported schema form at ${path || "/"}`);
  }
  return schema as JSONSchemaObj;
};

const arraySubsetOf = (
  subset: readonly unknown[],
  superset: readonly unknown[],
): boolean =>
  subset.every((value) =>
    superset.some((candidate) => deepEqual(candidate, value))
  );

const mergeArraySet = (
  ...sources: Array<readonly unknown[]>
): CfcAtom[] => {
  const result: CfcAtom[] = [];
  for (const source of sources) {
    for (const value of source) {
      if (!result.some((candidate) => deepEqual(candidate, value))) {
        result.push(value as CfcAtom);
      }
    }
  }
  return result;
};

type WriterIdentityClaim = {
  __ctWriterIdentityOf: Record<string, unknown>;
};

const isWriterIdentityClaim = (value: unknown): value is WriterIdentityClaim =>
  isObjectNotArray(value) && isObjectNotArray(value.__ctWriterIdentityOf);

// The per-input provenance fields a verified write may have stamped onto a
// writer-identity claim. New claims carry only the content-addressed
// `moduleIdentity` (prepare's rebind; see implementation-identity.ts
// `resolveProvenanceImplementationIdentity`), but pre-migration stored/fixture
// claims may still carry a legacy `bundleId` — so reconciliation strips BOTH.
// The BINDING (file + path) is what the claim means; these fields only record
// which verified module/load produced the input.
const WRITER_CLAIM_STAMP_KEYS = ["bundleId", "moduleIdentity"] as const;

const writerClaimIsStamped = (identity: Record<string, unknown>): boolean =>
  WRITER_CLAIM_STAMP_KEYS.some((key) => identity[key] !== undefined);

const writerClaimWithoutStampAndFile = (
  identity: Record<string, unknown>,
): Record<string, unknown> => {
  const rest = { ...identity };
  for (const key of WRITER_CLAIM_STAMP_KEYS) delete rest[key];
  // The file spelling is compared separately, tolerantly
  // (writerClaimFilesCorrespond) — never byte-wise.
  delete rest.file;
  return rest;
};

/**
 * Reconcile two `writeAuthorizedBy` writer-identity claims that mean the same
 * binding. The binding a claim MEANS is `path` (+ `moduleIdentity` once
 * stamped); the `file` spelling is resolver-dependent (the same module spells
 * differently across piece-deploy and HTTP compiles, and the same authored
 * tree spells differently under the root each compile grounds it at), so
 * two claims reconcile when their paths match and everything outside
 * file + stamp is equal. Two stamped claims consult the spelling not at all:
 * each stamp already names its module content-addressed. With at most one
 * stamp the spellings must additionally CORRESPOND (equal or
 * one-leading-segment apart), since the spelling is then part of what the
 * unstamped side means. Returns the stamped side when exactly one carries
 * the provenance stamp (`moduleIdentity`, or a legacy `bundleId` on
 * pre-migration claims), and the existing side otherwise — both-unstamped,
 * both same stamp, and both stamped DIFFERENTLY (a version boundary:
 * born-stamped claims make a republished module re-present this binding
 * under its new moduleIdentity on every envelope write; the stored stamp is
 * kept, never rotated, and the successor's field writes are authorized at
 * verification time by authenticated `piece setsrc` module delegation — or
 * fail closed loudly without one — while the envelope's sibling writes keep
 * committing). `undefined` only when the claims name different bindings
 * (different paths, or non-corresponding files with at most one stamp).
 */
const reconcileWriterClaimStamp = (
  existing: unknown,
  candidate: unknown,
  adoptsStamp: ((claim: unknown) => boolean) | undefined,
): unknown | undefined => {
  if (!isWriterIdentityClaim(existing) || !isWriterIdentityClaim(candidate)) {
    return undefined;
  }
  const existingIdentity = existing.__ctWriterIdentityOf;
  const candidateIdentity = candidate.__ctWriterIdentityOf;
  if (
    !deepEqual(
      {
        ...existing,
        __ctWriterIdentityOf: writerClaimWithoutStampAndFile(existingIdentity),
      },
      {
        ...candidate,
        __ctWriterIdentityOf: writerClaimWithoutStampAndFile(candidateIdentity),
      },
    )
  ) {
    return undefined;
  }
  const existingStamped = writerClaimIsStamped(existingIdentity);
  const candidateStamped = writerClaimIsStamped(candidateIdentity);
  if (existingStamped && candidateStamped) {
    // Both stamped, same path: the stored claim wins either way, and the
    // spelling is not consulted, since each stamp names its module
    // content-addressed. With equal stamps this is plain stability. With
    // DIFFERENT stamps it is a version boundary — claims are minted born
    // stamped, so a republished module re-presents this binding under its
    // new moduleIdentity on every envelope write. Keeping the stored stamp
    // (instead of conflict-aborting the transaction) preserves the
    // fail-closed posture at the right granularity: the new version's
    // writes to THIS field are refused at verification unless a
    // `piece setsrc` delegation names the stored stamp as its predecessor,
    // while the envelope's sibling fields keep committing. Rotation never
    // happens here in either direction.
    return existing;
  }
  const existingFile = typeof existingIdentity.file === "string"
    ? existingIdentity.file
    : undefined;
  const candidateFile = typeof candidateIdentity.file === "string"
    ? candidateIdentity.file
    : undefined;
  if (
    !writerClaimFilesCorrespond(existingFile, candidateFile) &&
    // A stamp the caller vouches for may adopt an unstamped stored claim
    // spelled below another pattern root; nothing else widens.
    !(!existingStamped && candidateStamped &&
      adoptsStamp?.(candidate) === true &&
      writerClaimPatternFilesCorrespond(existingFile, candidateFile))
  ) {
    return undefined;
  }
  if (!existingStamped && !candidateStamped) {
    return existing;
  }
  return existingStamped ? existing : candidate;
};

const mergeSetLikeIfcArray = (
  key: string,
  existing: unknown,
  candidate: unknown,
  path: string,
  adoptsStamp: ((claim: unknown) => boolean) | undefined,
): unknown => {
  if (existing === undefined) {
    return candidate;
  }
  if (candidate === undefined) {
    return existing;
  }

  switch (key) {
    case "requiredIntegrity":
    case "confidentiality":
    case "addIntegrity": {
      if (!Array.isArray(existing) || !Array.isArray(candidate)) {
        if (!deepEqual(existing, candidate)) {
          throw new Error(`${key} must remain stable at ${path || "/"}`);
        }
        return existing;
      }
      // Confidentiality is CNF clauses: normalize each clause before
      // the subset/merge comparison so two order-differing OR-clauses
      // (`{anyOf:[A,B]}` vs `{anyOf:[B,A]}`) presented across schema inputs or
      // successive writes compare EQUAL — otherwise the raw-`deepEqual` subset
      // check would reject the re-presented clause as a weakening. This runs
      // before `derivePersistedLabel`'s persist-time normalization, closing
      // the same-transaction / two-input reorder gap. `normalizeClause` is
      // identity on flat atoms and integrity carries no OR-clauses, so the
      // other keys are untouched.
      const existingArray = key === "confidentiality"
        ? (existing as readonly CfcConfClause[]).map(normalizeClause)
        : existing as readonly unknown[];
      const candidateArray = key === "confidentiality"
        ? (bindCurrentPrincipalToStoredClauses(
          candidate,
          existingArray,
        ) as readonly CfcConfClause[]).map(normalizeClause)
        : candidate as readonly unknown[];
      // A transaction may combine its symbolic declaration with a concrete
      // label before creator binding. Retain both constraints until prepare
      // binds the symbolic one; accepting the concrete clause cannot remove it.
      const comparableExisting = key === "confidentiality"
        ? existingArray.filter((clause) =>
          !isCurrentPrincipalUserClause(clause)
        )
        : existingArray;
      if (!arraySubsetOf(comparableExisting, candidateArray)) {
        throw new Error(`${key} cannot be weakened at ${path || "/"}`);
      }
      return mergeArraySet(existingArray, candidateArray);
    }
    case "integrity":
    case "maxConfidentiality":
    case "writeAuthorizedBy": {
      if (
        !Array.isArray(existing) || !Array.isArray(candidate) ||
        !existing.every((entry) => typeof entry === "string") ||
        !candidate.every((entry) => typeof entry === "string")
      ) {
        if (!deepEqual(existing, candidate)) {
          // One transaction can record the same protected field through a
          // schema input whose `writeAuthorizedBy` claim was rebound with the
          // authoring identity's provenance stamp and one recorded without an
          // identity (unstamped). The BINDING (path, plus the stamp once
          // there is one) is what the claim means; the stamp is provenance
          // added per input — keep the stamped claim. For two different
          // stamps of the same path, keep the stored stamp (a version
          // boundary, never a rotation here). Different bindings still
          // conflict.
          if (key === "writeAuthorizedBy") {
            const reconciled = reconcileWriterClaimStamp(
              existing,
              candidate,
              adoptsStamp,
            );
            if (reconciled !== undefined) {
              return reconciled;
            }
          }
          throw new Error(`${key} must remain stable at ${path || "/"}`);
        }
        return existing;
      }
      const existingArray = existing as readonly unknown[];
      const candidateArray = candidate as readonly unknown[];
      if (!arraySubsetOf(candidateArray, existingArray)) {
        throw new Error(`${key} cannot be weakened at ${path || "/"}`);
      }
      return mergeArraySet(candidateArray);
    }
    case "exactCopyOf":
    case "projection":
    case "collection":
    case "ownerPrincipal":
      if (!deepEqual(existing, candidate)) {
        throw new Error(`${key} must remain stable at ${path || "/"}`);
      }
      return existing;
    case "flowPrecisionClaim":
    case "uiContract":
      if (!deepEqual(existing, candidate)) {
        throw new Error(`${key} must remain stable at ${path || "/"}`);
      }
      return existing;
    default:
      return candidate;
  }
};

const mergeIfc = (
  existing: JSONSchemaObj["ifc"],
  candidate: JSONSchemaObj["ifc"],
  path: string,
  adoptsStamp?: (claim: unknown) => boolean,
): JSONSchemaObj["ifc"] => {
  if (existing === undefined) {
    return candidate;
  }
  if (candidate === undefined) {
    return existing;
  }

  const existingIfc = existing as Record<string, unknown>;
  const candidateIfc = candidate as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  // A key neither side declares stays absent, as it does in the node merge.
  for (const key of IFC_KEYS) {
    const value = mergeSetLikeIfcArray(
      key,
      existingIfc[key],
      candidateIfc[key],
      path,
      adoptsStamp,
    );
    if (value !== undefined) merged[key] = value;
  }
  // `observes` is a scalar consumption class, not a set-like claim:
  // agreement keeps the class through the merge; any disagreement —
  // including one covering side — merges to covering, the widest
  // consumption (over-taint, fail-safe).
  if (
    typeof existingIfc.observes === "string" &&
    existingIfc.observes === candidateIfc.observes
  ) {
    merged.observes = existingIfc.observes;
  }
  return merged as JSONSchemaObj["ifc"];
};

// This walk descends `$defs` bodies (`includeDefs`). It does not resolve
// `$ref`, so a definition referenced but not inlined is only seen through
// `$defs`.
const branchContainsIfc = (schema: JSONSchema): boolean => {
  if (!isObjectOrArray(schema)) return false;
  if ((schema as JSONSchemaObj).ifc !== undefined) return true;
  return forEachSubschema(schema, (child) => branchContainsIfc(child), {
    includeDefs: true,
  });
};

/**
 * The two scalar `type` strings whose VALUE-sets overlap: every JSON-Schema
 * integer is a number (the runner's own `schemaTypeMatchesValue` matches a
 * concrete `5` against BOTH), so `integer` and `number` are NOT value-disjoint
 * even though the strings differ. This is the ONLY such pair among the seven
 * JSON types — {null, boolean, object, array, string} are mutually
 * value-exclusive and each is exclusive with the numerics — so excluding this
 * one pair makes {@link syntacticallyTypeDisjoint} sound by its own criterion.
 */
const NUMERIC_TYPE_STRINGS: ReadonlySet<string> = new Set([
  "integer",
  "number",
]);

/**
 * Syntactic, conservative type-disjointness: both branches carry an explicit
 * scalar `type` string, the strings name VALUE-disjoint types, and NEITHER
 * branch is itself a combinator at its root. Everything unprovable — a
 * missing `type`, a type array, a boolean schema, a nested combinator, or the
 * value-overlapping `integer`/`number` pair — is NOT disjoint: treating
 * "cannot prove non-overlap" as disjoint would admit the policy dodge (a
 * labeled value also matching an unlabeled sibling and reading unlabeled).
 * Disjointness is decided over VALUE-sets, not type STRINGS, and the one
 * subtype relation it reasons about is the fixed `integer`/`number` pair.
 */
const syntacticallyTypeDisjoint = (
  left: JSONSchema,
  right: JSONSchema,
): boolean => {
  if (!isObjectOrArray(left) || !isObjectOrArray(right)) return false;
  const leftObject = left as JSONSchemaObj;
  const rightObject = right as JSONSchemaObj;
  if (
    leftObject.anyOf !== undefined || leftObject.oneOf !== undefined ||
    leftObject.allOf !== undefined || rightObject.anyOf !== undefined ||
    rightObject.oneOf !== undefined || rightObject.allOf !== undefined
  ) {
    return false;
  }
  if (
    typeof leftObject.type !== "string" ||
    typeof rightObject.type !== "string" ||
    leftObject.type === rightObject.type
  ) {
    return false;
  }
  // The one value-set subtype pair: an `integer` value is also a `number`,
  // so a concrete value can satisfy both branches — not disjoint.
  if (
    NUMERIC_TYPE_STRINGS.has(leftObject.type) &&
    NUMERIC_TYPE_STRINGS.has(rightObject.type)
  ) {
    return false;
  }
  return true;
};

const assertNoDivergentIfcBranches = (
  schema: JSONSchema,
  path = "",
): void => {
  if (!isObjectOrArray(schema)) {
    return;
  }
  const object = schema as JSONSchemaObj;
  const branchGroups = [
    object.anyOf ? ["anyOf", object.anyOf] as const : undefined,
    object.oneOf ? ["oneOf", object.oneOf] as const : undefined,
    object.allOf ? ["allOf", object.allOf] as const : undefined,
  ].filter((value) => value !== undefined);

  for (const [kind, branches] of branchGroups) {
    const ifcBranchCount = branches.filter(branchContainsIfc).length;
    if (ifcBranchCount === 0) continue;
    // A SINGLE ifc-carrying branch whose every sibling is syntactically
    // type-disjoint from it is the POLICY CARRIER of an anyOf/oneOf presence
    // union — the wish builtin's optional-result shape,
    // `anyOf[{type:"undefined"}, <ifc view>]` — and merges: there is no
    // ambiguity (one carrier) and no dodge (no sibling a labeled value could
    // also match). Everything else is refused: more than one carrier is
    // ambiguous; a non-disjoint sibling is the policy dodge; and allOf is
    // conjunctive — type-disjoint siblings are unsatisfiable-by-construction
    // there, so no carrier reading exists. The recursion below descends INTO
    // the admitted carrier, so divergence nested deeper is refused too.
    if (kind !== "allOf" && ifcBranchCount === 1) {
      const carrierIndex = branches.findIndex(branchContainsIfc);
      const carrier = branches[carrierIndex]!;
      const siblingsDisjoint = branches.every((sibling, index) =>
        index === carrierIndex || syntacticallyTypeDisjoint(carrier, sibling)
      );
      if (siblingsDisjoint) continue;
    }
    throw new Error(
      `ifc inside divergent ${kind} branches is unsupported at ${path || "/"}`,
    );
  }

  // Recurse over the shared walker's default keyword vocabulary,
  // `prefixItems` and `additionalProperties` included, so a divergent-ifc
  // shape cannot hide under any keyword that walk visits. It passes no walk
  // options, so `$defs` bodies are not descended here. The vocabulary
  // includes the combinators, so this is also the descent into a carrier
  // admitted above.
  forEachSubschema(object, (child, keyword, key, index) => {
    const childPath = keyword === "properties"
      ? `${path}/${key}`
      : keyword === "items" || keyword === "additionalProperties"
      ? `${path}/*`
      : keyword === "prefixItems"
      ? `${path}/${index}`
      : path;
    assertNoDivergentIfcBranches(child, childPath);
  });
};

export interface MergeCfcSchemaEnvelopeOptions {
  /**
   * Logical paths generated as outputs by the running module. A path covers
   * every required descendant below it; `[]` therefore exempts the whole
   * document, as it does for a pattern result projection that setup rewrites
   * in full. Required fields outside these paths still need defaults to
   * preserve older documents.
   */
  generatedOutputPaths?: readonly (readonly string[])[];

  /**
   * Whether a logical path lies beneath a position whose claims belong to
   * another document: one where the stored document holds links (see
   * `ForeignPositions` in claim-preservation.ts). A claim there describes
   * the linked document, whose own envelope enforces it, so the merge takes
   * the candidate's claims there rather than holding the two to agree.
   */
  beneathStoredLink?: (path: readonly string[]) => boolean;

  /**
   * Whether a stamped writer claim may adopt an unstamped stored one spelled
   * below another pattern root (see `writerClaimPatternFilesCorrespond`):
   * only a stamp the release installs, or the writer the stamp names, may.
   * Absent, no claim adopts across roots.
   */
  adoptsStamp?: (claim: unknown) => boolean;
}

const generatedOutputCovers = (
  options: MergeCfcSchemaEnvelopeOptions,
  path: readonly string[],
): boolean =>
  options.generatedOutputPaths?.some((outputPath) =>
    outputPath.length <= path.length &&
    outputPath.every((segment, index) => segment === path[index])
  ) ?? false;

const mergeRequired = (
  existing: readonly string[] | undefined,
  candidate: readonly string[] | undefined,
  mergedProperties: Readonly<Record<string, JSONSchema>>,
  path: readonly string[],
  options: MergeCfcSchemaEnvelopeOptions,
): readonly string[] | undefined => {
  if (existing === undefined && candidate === undefined) {
    return undefined;
  }
  const merged = [...new Set([...(existing ?? []), ...(candidate ?? [])])];
  for (const name of merged) {
    if ((existing ?? []).includes(name) || !(candidate ?? []).includes(name)) {
      continue;
    }
    const property = mergedProperties[name];
    // A generated output is materialized by the module in this transaction,
    // so it has no older value to preserve. Inputs and ordinary document writes
    // remain default-gated: an older document may genuinely lack their newly
    // required field.
    if (generatedOutputCovers(options, [...path, name])) {
      continue;
    }
    if (!isObjectOrArray(property) || property.default === undefined) {
      // Typed so the CFC prepare catch can tag this as the recoverable
      // schema-migration class (see migration-reason.ts) without sniffing the
      // message. The message text stays human-readable and unchanged.
      throw new CfcSchemaMigrationError(
        `required field ${name} needs a default to preserve old documents`,
      );
    }
  }
  return merged;
};

// A `FabricPrimitive` default on either side takes the `candidate` arm: it has
// no properties for the spread to copy, so merging one yields `{}` and loses
// whichever side held the value. A `FabricInstance` default is refused rather
// than merged.
const mergeDefaults = (
  existing: JSONSchemaObj["default"],
  candidate: JSONSchemaObj["default"],
): JSONSchemaObj["default"] => {
  if (existing === undefined) {
    return candidate;
  }
  if (candidate === undefined) {
    return existing;
  }
  if (
    isWalkableObjectOrArray(existing) && isWalkableObjectOrArray(candidate) &&
    !Array.isArray(existing) && !Array.isArray(candidate)
  ) {
    return { ...existing, ...candidate };
  }
  return candidate;
};

/** A document's definitions, as `mergeCfcSchemaEnvelopes()` hoists them. */
type SchemaDefinitions = NonNullable<JSONSchemaObj["$defs"]>;

/**
 * What a node merge resolves references against: the hoisted definitions,
 * and the pairs of references already resolved on the way down to this node.
 */
type MergeReferences = {
  readonly definitions: SchemaDefinitions;
  readonly active: ReadonlySet<string>;
};

/**
 * Whether a node merge has to walk the body `side`'s reference names rather
 * than the reference: the other side is anything but that same bare
 * reference. Merged unresolved, whatever the other side declares beside the
 * `$ref` (an `ifc`, `properties`, `items`, a combinator, another reference)
 * would take the place of the referenced body's own and drop the claims it
 * declares.
 */
const referenceIsShadowed = (
  side: JSONSchemaObj,
  other: JSONSchemaObj,
): boolean =>
  typeof side.$ref === "string" &&
  (other.$ref !== side.$ref ||
    Object.keys(other).some((key) => key !== "$ref"));

/**
 * `schema`'s reference resolved in `root`, as a merge walks it. An `ifc` beside
 * the `$ref` replaces the body's on resolution, which would drop every claim
 * the body declares that the sibling does not restate, so the body's claims
 * are kept beneath the sibling's. `undefined` when the reference does not
 * resolve.
 */
const resolveKeepingBodyClaims = (
  schema: JSONSchemaObj,
  root: JSONSchema,
): JSONSchema | undefined => {
  const resolved = resolveCfcSchemaRefs(schema, root);
  if (!isObjectNotArray(resolved) || !isObjectNotArray(schema.ifc)) {
    return resolved;
  }
  const body = resolveCfcSchemaRefs(
    { $ref: schema.$ref } as JSONSchemaObj,
    root,
  );
  return isObjectNotArray(body) && isObjectNotArray(body.ifc)
    ? { ...resolved, ifc: { ...body.ifc, ...schema.ifc } } as JSONSchemaObj
    : resolved;
};

const resolveReferenceSide = (
  side: JSONSchemaObj,
  definitions: SchemaDefinitions,
): JSONSchemaObj => {
  const resolved = resolveKeepingBodyClaims(side, { $defs: definitions });
  return isObjectNotArray(resolved) ? resolved as JSONSchemaObj : side;
};

const mergeSchemaNode = (
  existing: JSONSchema,
  candidate: JSONSchema,
  path = "",
  logicalPath: readonly string[] = [],
  options: MergeCfcSchemaEnvelopeOptions = {},
  references?: MergeReferences,
): JSONSchema => {
  let left = asSchemaObject(existing, path);
  let right = asSchemaObject(candidate, path);
  // Two references already resolved against each other higher on this path
  // are recursive definitions meeting themselves; resolving them again would
  // not terminate, so they merge as references from there down. Against an
  // inline schema a reference resolves at every depth, since the inline side
  // runs out. Where neither side declares any `ifc`, there is no claim to
  // lose, and references stay references.
  const bothReferences = typeof left.$ref === "string" &&
    typeof right.$ref === "string";
  const pair = `${left.$ref ?? ""}\u0000${right.$ref ?? ""}`;
  let childReferences = references;
  if (
    references !== undefined &&
    !(bothReferences && references.active.has(pair))
  ) {
    // Where either side's body declares a claim, every shadowed reference is
    // resolved, so a reference declaring nothing cannot stand in for one
    // that does on the merged node.
    const policyRoot = { $defs: references.definitions };
    const claims = hasReachableIfc(left, policyRoot) ||
      hasReachableIfc(right, policyRoot);
    const resolveLeft = claims && referenceIsShadowed(left, right);
    const resolveRight = claims && referenceIsShadowed(right, left);
    if (resolveLeft || resolveRight) {
      childReferences = bothReferences
        ? {
          definitions: references.definitions,
          active: new Set([...references.active, pair]),
        }
        : references;
      if (resolveLeft) {
        left = resolveReferenceSide(left, references.definitions);
      }
      if (resolveRight) {
        right = resolveReferenceSide(right, references.definitions);
      }
    }
  }

  const leftTypes = left.type === undefined
    ? undefined
    : Array.isArray(left.type)
    ? [...left.type]
    : [left.type];
  const rightTypes = right.type === undefined
    ? undefined
    : Array.isArray(right.type)
    ? [...right.type]
    : [right.type];
  if (
    leftTypes !== undefined &&
    rightTypes !== undefined &&
    (leftTypes.length !== rightTypes.length ||
      !arraySubsetOf(leftTypes, rightTypes) ||
      !arraySubsetOf(rightTypes, leftTypes))
  ) {
    throw new Error(
      `type changed incompatibly at ${path || "/"}: ${
        JSON.stringify(leftTypes)
      } -> ${JSON.stringify(rightTypes)}`,
    );
  }

  // A side's claim about a named key is its properties[key] where declared,
  // else its object-valued additionalProperties (the rest claim covering
  // every undeclared key) — the record twin of the prefixItems/items rule
  // below. So a key only one side names still merges with the other side's
  // rest claim rather than winning wholesale.
  const leftAdditional = isObjectOrArray(left.additionalProperties)
    ? left.additionalProperties
    : undefined;
  const rightAdditional = isObjectOrArray(right.additionalProperties)
    ? right.additionalProperties
    : undefined;
  const mergedProperties: Record<string, JSONSchema> = {};
  for (
    const key of new Set([
      ...Object.keys(left.properties ?? {}),
      ...Object.keys(right.properties ?? {}),
    ])
  ) {
    const leftClaim = left.properties?.[key] ?? leftAdditional;
    const rightClaim = right.properties?.[key] ?? rightAdditional;
    mergedProperties[key] = leftClaim !== undefined &&
        rightClaim !== undefined
      ? mergeSchemaNode(
        leftClaim,
        rightClaim,
        `${path}/${key}`,
        [...logicalPath, key],
        options,
        childReferences,
      )
      : (rightClaim ?? leftClaim)!;
  }

  // Object-valued rest claims merge like items; boolean forms keep the
  // spread's right-wins behavior: the right side's value when it has one,
  // else the left's.
  let mergedAdditionalProperties = left.additionalProperties;
  if (leftAdditional !== undefined && rightAdditional !== undefined) {
    mergedAdditionalProperties = mergeSchemaNode(
      leftAdditional,
      rightAdditional,
      `${path}/*`,
      [...logicalPath, "*"],
      options,
      childReferences,
    );
  } else if (right.additionalProperties !== undefined) {
    mergedAdditionalProperties = right.additionalProperties;
  }

  let mergedItems = left.items;
  if (left.items !== undefined && right.items !== undefined) {
    mergedItems = mergeSchemaNode(
      left.items,
      right.items,
      `${path}/*`,
      [...logicalPath, "*"],
      options,
      childReferences,
    );
  } else if (right.items !== undefined) {
    mergedItems = right.items;
  }

  // Tuple slots merge slot-wise like properties — the `{...left, ...right}`
  // spread below would otherwise let one side's prefixItems win wholesale,
  // dropping the other side's slot ifc/defaults. A side's claim about slot
  // index i is its prefixItems[i] where declared, else its rest `items`
  // (2020-12: `items` speaks for every index past that side's slots). So a
  // shorter side's `items` claim merges into the longer side's extra slots,
  // and a side introducing prefixItems beside an items-only side merges
  // each slot with that `items` claim rather than winning wholesale.
  let mergedPrefixItems: JSONSchema[] | undefined;
  if (left.prefixItems !== undefined || right.prefixItems !== undefined) {
    const slotClaim = (
      side: typeof left,
      index: number,
    ): JSONSchema | undefined =>
      side.prefixItems !== undefined && index < side.prefixItems.length
        ? side.prefixItems[index]
        : side.items;
    const length = Math.max(
      left.prefixItems?.length ?? 0,
      right.prefixItems?.length ?? 0,
    );
    const slots: JSONSchema[] = [];
    for (let index = 0; index < length; index++) {
      const leftSlot = slotClaim(left, index);
      const rightSlot = slotClaim(right, index);
      slots.push(
        leftSlot !== undefined && rightSlot !== undefined
          ? mergeSchemaNode(
            leftSlot,
            rightSlot,
            `${path}/${index}`,
            [...logicalPath, String(index)],
            options,
            childReferences,
          )
          : (rightSlot ?? leftSlot)!,
      );
    }
    mergedPrefixItems = slots;
  }

  const ifc = options.beneathStoredLink?.(logicalPath)
    ? right.ifc ?? left.ifc
    : mergeIfc(left.ifc, right.ifc, path, options.adoptsStamp);
  const required = mergeRequired(
    left.required,
    right.required,
    mergedProperties,
    logicalPath,
    options,
  );
  const mergedDefault = mergeDefaults(left.default, right.default);
  // `$defs` is settled by `mergeCfcSchemaEnvelopes()` at the root, where both
  // documents' maps are hoisted into one before the walk; below the root a
  // `$defs` is inert, and the spread carries it as it does any other key.
  // A key neither side declares stays absent: an own key holding `undefined`
  // reads as present to an `in` test and hashes unlike an absent one.
  const {
    ifc: _ifc,
    required: _required,
    default: _default,
    ...rest
  } = { ...left, ...right };
  return {
    ...rest,
    ...(Object.keys(mergedProperties).length > 0
      ? { properties: mergedProperties }
      : {}),
    ...(mergedItems !== undefined ? { items: mergedItems } : {}),
    ...(mergedPrefixItems !== undefined
      ? { prefixItems: mergedPrefixItems }
      : {}),
    ...(mergedAdditionalProperties !== undefined
      ? { additionalProperties: mergedAdditionalProperties }
      : {}),
    ...(ifc !== undefined ? { ifc } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(mergedDefault !== undefined ? { default: mergedDefault } : {}),
  };
};

/** Checks every reachable policy position without unfolding reference cycles. */
function hasReachableConfidentiality(
  schema: JSONSchema,
  root: JSONSchema,
): boolean {
  return hasReachableIfc(
    schema,
    root,
    (ifc) =>
      Array.isArray(ifc.confidentiality) && ifc.confidentiality.length > 0,
  );
}

/**
 * Whether an `ifc` that `declares` accepts is reachable from `schema`,
 * following references without unfolding their cycles. A reference that does
 * not resolve counts as reaching one.
 */
function hasReachableIfc(
  schema: JSONSchema,
  root: JSONSchema,
  declares: (ifc: Record<string, unknown>) => boolean = (ifc) =>
    Object.keys(ifc).length > 0,
): boolean {
  const pending = [{ schema, root }];
  const visited = new Map<object, Set<object>>();
  while (pending.length > 0) {
    const { schema, root } = pending.pop()!;
    if (!isObjectNotArray(schema)) continue;
    const rootKey = isObjectNotArray(root) ? root : schema;
    let schemas = visited.get(rootKey);
    if (schemas?.has(schema)) continue;
    if (schemas === undefined) visited.set(rootKey, schemas = new Set());
    schemas.add(schema);
    const resolved = typeof schema.$ref === "string"
      ? resolveCfcSchemaRefs(schema, root)
      : schema;
    // An unresolved reference cannot establish that its policy is public.
    if (resolved === undefined) return true;
    if (!isObjectNotArray(resolved)) continue;
    if (
      isObjectNotArray(resolved.ifc) &&
      declares(resolved.ifc as Record<string, unknown>)
    ) return true;
    const childRoot = resolved !== schema
      ? cfcSchemaResolvedRoot(resolved, resolveCfcSchemaRefRoot(schema, root))
      : root;
    forEachSubschema(resolved, (child) => {
      pending.push({ schema: child, root: childRoot });
    }, { includeUnused: true, visitBooleans: true });
  }
  return false;
}

/**
 * Exposes each referenced declaration at its use site before confidential
 * schemas merge. Distinct stored readers of a reused definition then retain
 * their own clauses instead of selecting the candidate's symbolic definition.
 */
function resolveConfidentialSchema(
  schema: JSONSchema,
  root: JSONSchema = schema,
  active: readonly { schema: object; root: object }[] = [],
  retainedRoot: JSONSchema = root,
): JSONSchema {
  if (!isObjectNotArray(schema)) return schema;
  if (
    typeof schema.$ref === "string" &&
    !hasReachableConfidentiality(schema, root)
  ) {
    const definition = localDefinitionName(schema.$ref);
    if (definition === undefined || root === retainedRoot) return schema;
    // An expanded external body sits below a different document root. Keep
    // its public references bound to their original definition namespace.
    const { taggedHashString } = internSchema(root, true);
    registerSchemaDocument(taggedHashString, root);
    return {
      ...schema,
      $ref: formatExternalSchemaRef(taggedHashString, definition),
    };
  }
  const rootObject = isObjectNotArray(root) ? root : schema;
  if (
    active.some((entry) => entry.schema === schema && entry.root === rootObject)
  ) {
    throw new Error("Recursive confidentiality schema merging is unsupported");
  }
  const resolved = typeof schema.$ref === "string"
    ? resolveKeepingBodyClaims(schema, root)
    : schema;
  if (resolved === undefined) {
    throw new Error("Confidentiality merging requires resolved schemas");
  }
  if (!isObjectNotArray(resolved)) return resolved;
  const childRoot = resolved !== schema
    ? cfcSchemaResolvedRoot(resolved, resolveCfcSchemaRefRoot(schema, root))
    : root;
  return mapSubschemas(
    resolved,
    (child) =>
      resolveConfidentialSchema(child, childRoot, [
        ...active,
        { schema, root: rootObject },
      ], retainedRoot),
    { includeUnused: true, visitBooleans: true },
  );
}

/**
 * Policy declarations and reference edges, independent of public value shapes.
 *
 * This is a type alias, not an `interface`, because two of these are compared
 * by hashing them, and what gets hashed is a `FabricValue`. An `interface` is
 * never assignable to `FabricPlainObject`, however plain its members:
 * TypeScript gives an anonymous object type the implicit index signature which
 * that requires, and does not give one to an interface.
 */
type SchemaPolicyGraph = {
  ifc: JSONSchemaObj["ifc"];
  ref: string | undefined;
  children: {
    keyword: string;
    key: string | undefined;
    index: number | undefined;
    policy: SchemaPolicyGraph;
  }[];
};

/**
 * Retains every structural policy position and definition namespace without
 * expanding reference cycles. Label-view paths alone omit rest-property claims
 * beside named fields, so they cannot establish that two policies are equal.
 */
function schemaPolicyGraph(
  schema: JSONSchema,
  activeRefs: ReadonlySet<string> = new Set(),
): SchemaPolicyGraph | undefined {
  if (!isObjectNotArray(schema)) return undefined;
  if (
    typeof schema.$ref === "string" &&
    parseExternalSchemaRef(schema.$ref) !== undefined
  ) {
    if (activeRefs.has(schema.$ref)) {
      return { ifc: schema.ifc, ref: "#recursive", children: [] };
    }
    const resolved = resolveCfcSchemaRefs(schema, schema);
    if (resolved !== undefined && resolved !== schema) {
      return schemaPolicyGraph(
        resolved,
        new Set([...activeRefs, schema.$ref]),
      );
    }
  }
  const children: SchemaPolicyGraph["children"] = [];
  forEachSubschema(schema, (child, keyword, key, index) => {
    const policy = schemaPolicyGraph(child, activeRefs);
    if (policy !== undefined) children.push({ keyword, key, index, policy });
  }, { includeDefs: true, includeUnused: true, visitBooleans: true });
  if (
    schema.ifc === undefined && schema.$ref === undefined &&
    children.length === 0
  ) return undefined;
  children.sort((left, right) =>
    utf8Compare(left.keyword, right.keyword) ||
    utf8Compare(left.key ?? "", right.key ?? "") ||
    (left.index ?? -1) - (right.index ?? -1)
  );
  return { ifc: schema.ifc, ref: schema.$ref, children };
}

/**
 * Whether two envelopes declare the same policies at the same positions: the
 * same `ifc` claims and reference edges, whatever the public value shapes,
 * defaults and inert nested definition maps around them. A `cid:` reference
 * compares as the document it names, and a claim spelled as a member holding
 * `undefined` as no claim.
 */
export const cfcSchemaPoliciesEqual = (
  left: JSONSchema,
  right: JSONSchema,
): boolean =>
  hashStringOf(withoutUndefinedMembers(schemaPolicyGraph(left))) ===
    hashStringOf(withoutUndefinedMembers(schemaPolicyGraph(right)));

/**
 * `value` with every object member holding `undefined` removed, recursively.
 * A merge spells an absent claim as such a member, and a stored envelope read
 * back does not, so the two are compared without them.
 */
export const withoutUndefinedMembers = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map(withoutUndefinedMembers) as T;
  }
  if (!isObjectNotArray(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined) result[key] = withoutUndefinedMembers(member);
  }
  return result as T;
};

export const mergeCfcSchemaEnvelopes = (
  existing: JSONSchema,
  candidate: JSONSchema,
  options: MergeCfcSchemaEnvelopeOptions = {},
): JSONSchema => {
  assertNoDivergentIfcBranches(existing);
  assertNoDivergentIfcBranches(candidate);
  // Equal policies keep their reference graphs, including recursive ones,
  // through data-shape migrations. Public field shapes do not change the
  // reader or writer declarations enforced at a logical path.
  const policiesDiffer = hashStringOf(schemaPolicyGraph(existing)) !==
    hashStringOf(schemaPolicyGraph(candidate));
  if (policiesDiffer) {
    existing = resolveConfidentialSchema(existing);
    candidate = resolveConfidentialSchema(candidate);
  }
  assertNoDivergentIfcBranches(existing);
  assertNoDivergentIfcBranches(candidate);
  // The merged envelope is one document, so the two maps become one: a name
  // both define alike is shared, and a name they define differently is
  // renamed apart on the candidate's side, refs included, so every
  // `#/$defs/<name>` below the merged root still names the definition its
  // own document declared.
  const { fragments: [left, right], definitions } = hoistCfcSchemaDefs([
    existing,
    candidate,
  ]);
  const merged = mergeSchemaNode(
    left,
    right,
    "",
    [],
    options,
    // Where the policies differ, a reference is resolved wherever the other
    // side could take its place. `cid:` references resolve through the schema
    // registry, so that holds even where neither side defines any.
    policiesDiffer
      ? { definitions: definitions ?? {}, active: new Set() }
      : undefined,
  );
  return internSchema(
    definitions !== undefined && isObjectOrArray(merged)
      ? { ...merged, $defs: definitions }
      : merged,
  );
};

/** Why a stored envelope and a candidate envelope cannot be merged. */
export interface CfcSchemaMergeIssue {
  /** The merge's own human-readable reason, verbatim. */
  message: string;

  /**
   * True when the rejection is the additive-required migration class — an old
   * document predating a now-required field that declares no default. This is
   * the class the runnability backstop rolls forward on
   * (see {@link CfcSchemaMigrationError}); everything else is a hard
   * incompatibility that no roll-forward recovers.
   */
  migration: boolean;
}

/**
 * Would {@link mergeCfcSchemaEnvelopes} accept this candidate over this stored
 * envelope? `undefined` means yes.
 *
 * Replacing a live piece's pattern source with an unmergeable envelope fails
 * as a rejection from the setup commit. `cf piece setsrc --check` predicts
 * that failure by driving this seam, which is the same merge the commit runs,
 * called as a dry run. The preflight reaches it through
 * `storedCfcEnvelopeMergeIssue` (prepare.ts), which puts the persist loop's
 * merge-skipping fast paths in front of it.
 *
 * Pure: no transaction, no writes, because the merge itself is.
 */
export const cfcSchemaMergeIssue = (
  existing: JSONSchema,
  candidate: JSONSchema,
  options: MergeCfcSchemaEnvelopeOptions = {},
): CfcSchemaMergeIssue | undefined => {
  try {
    mergeCfcSchemaEnvelopes(existing, candidate, options);
    return undefined;
  } catch (error) {
    if (error instanceof CfcSchemaMigrationError) {
      return { message: error.message, migration: true };
    }
    return {
      message: error instanceof Error ? error.message : String(error),
      migration: false,
    };
  }
};
