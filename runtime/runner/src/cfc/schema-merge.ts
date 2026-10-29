import type { CfcAtom } from "@commonfabric/api/cfc";
import {
  fabricAwareEqual,
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
import { schemaTypesAreDisjoint } from "../schema-type-disjointness.ts";
import type { CfcConfClause } from "./clause.ts";
import { normalizeClause } from "./clause.ts";
import {
  bindCurrentPrincipalToStoredClauses,
  isCurrentPrincipalUserClause,
} from "./current-principal-confidentiality.ts";
import { CfcEnvelopeStabilityError } from "./envelope-stability-reason.ts";
import { CfcSchemaMigrationError } from "./migration-reason.ts";
import { isValueStamp } from "./minted-integrity.ts";
import {
  canonicalizeCfcSchemaDocument,
  cfcSchemaResolvedRoot,
  encodedLocalDefinitionRef,
  hoistCfcSchemaDefs,
  localDefinitionName,
  pruneCfcSchemaDefinitionBody,
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
  "writePolicyAnyOf",
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
          throw new CfcEnvelopeStabilityError(
            `${key} must remain stable at ${path || "/"}`,
          );
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
      // A value stamp (`addIntegrity`, principal claims excepted) is the
      // stamping write's own and binds no later writer, so a schema that
      // names fewer stamps than the stored one weakens nothing.
      const comparableExisting = key === "confidentiality"
        ? existingArray.filter((clause) =>
          !isCurrentPrincipalUserClause(clause)
        )
        : key === "addIntegrity"
        ? existingArray.filter((atom) => !isValueStamp(atom))
        : existingArray;
      if (!arraySubsetOf(comparableExisting, candidateArray)) {
        throw new CfcEnvelopeStabilityError(
          `${key} cannot be weakened at ${path || "/"}`,
        );
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
          throw new CfcEnvelopeStabilityError(
            `${key} must remain stable at ${path || "/"}`,
          );
        }
        return existing;
      }
      const existingArray = existing as readonly unknown[];
      const candidateArray = candidate as readonly unknown[];
      if (!arraySubsetOf(candidateArray, existingArray)) {
        throw new CfcEnvelopeStabilityError(
          `${key} cannot be weakened at ${path || "/"}`,
        );
      }
      return mergeArraySet(candidateArray);
    }
    case "writePolicyAnyOf":
      return mergeWritePolicyAnyOf(existing, candidate, path, adoptsStamp);
    case "exactCopyOf":
    case "projection":
    case "collection":
    case "ownerPrincipal":
      if (!deepEqual(existing, candidate)) {
        throw new CfcEnvelopeStabilityError(
          `${key} must remain stable at ${path || "/"}`,
        );
      }
      return existing;
    case "flowPrecisionClaim":
    case "uiContract":
      if (!deepEqual(existing, candidate)) {
        throw new CfcEnvelopeStabilityError(
          `${key} must remain stable at ${path || "/"}`,
        );
      }
      return existing;
    default:
      return candidate;
  }
};

/**
 * Helper for `mergeSetLikeIfcArray()`, which merges two `writePolicyAnyOf`
 * lists. The alternatives stay as stored — the same ones, in the same order,
 * each with the same contract — so a later schema can neither admit a writer
 * nor drop one. Each alternative's writer claim reconciles as a lone
 * `writeAuthorizedBy` does, which is how an alternative gains its stamp.
 */
const mergeWritePolicyAnyOf = (
  existing: unknown,
  candidate: unknown,
  path: string,
  adoptsStamp?: (claim: unknown) => boolean,
): unknown => {
  const unstable = () =>
    new CfcEnvelopeStabilityError(
      `writePolicyAnyOf must remain stable at ${path || "/"}`,
    );
  if (
    !Array.isArray(existing) || !Array.isArray(candidate) ||
    existing.length !== candidate.length
  ) {
    throw unstable();
  }
  return existing.map((policy, index) => {
    const other = candidate[index];
    if (
      !isObjectNotArray(policy) || !isObjectNotArray(other) ||
      !sameKeys(policy, other) ||
      !deepEqual(policy.uiContract, other.uiContract)
    ) {
      throw unstable();
    }
    if (deepEqual(policy.writeAuthorizedBy, other.writeAuthorizedBy)) {
      return policy;
    }
    const writer = reconcileWriterClaimStamp(
      policy.writeAuthorizedBy,
      other.writeAuthorizedBy,
      adoptsStamp,
    );
    if (writer === undefined) throw unstable();
    return { ...policy, writeAuthorizedBy: writer };
  });
};

/** Helper for `mergeWritePolicyAnyOf()`, which compares two key sets. */
const sameKeys = (a: object, b: object): boolean => {
  const keys = Object.keys(a);
  const other = new Set(Object.keys(b));
  return keys.length === other.size && keys.every((key) => other.has(key));
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
  // Each side may name its writers in one shape while the other names them in
  // the other, and the two do not combine: a position holding both is one
  // the runtime refuses every write to.
  if (
    merged.writePolicyAnyOf !== undefined &&
    (merged.writeAuthorizedBy !== undefined || merged.uiContract !== undefined)
  ) {
    throw new Error(
      `writePolicyAnyOf cannot join writeAuthorizedBy or uiContract at ${
        path || "/"
      }`,
    );
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
 * which the merge adds to; the pairs of references already resolved against
 * each other on the way down to this node; and, by the pair's key, the
 * definition minted for each pair of differing references met on the way
 * down (`mergedDefinitionRef()`), in whose body the pair refers to it.
 */
type MergeReferences = {
  readonly definitions: Record<string, JSONSchema>;
  readonly active: ReadonlySet<string>;
  readonly merged: ReadonlyMap<string, string>;
};

/** The key of a pair of references, one from each side of a merge. */
const referencePair = (left: JSONSchemaObj, right: JSONSchemaObj): string =>
  `${left.$ref ?? ""}\u0000${right.$ref ?? ""}`;

/**
 * Keywords that annotate a schema and constrain no value. `$comment` is not
 * one of them here: the runtime reads some of its values as property markers
 * (`schema-view.ts`), so a branch whose comment changes does not correspond.
 */
const BRANCH_ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  "title",
  "description",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/**
 * Whether a node merge has to walk the body `side`'s reference names rather
 * than the reference: the other side is anything but that same reference,
 * bare or beside annotations alone. Merged unresolved, whatever the other side
 * declares beside the `$ref` (an `ifc`, `properties`, `items`, a combinator,
 * another reference) would take the place of the referenced body's own and
 * drop the claims it declares. An annotation constrains nothing, so two sides
 * naming one definition merge as that reference, which is what keeps a
 * recursive definition from unrolling one level further on each merge.
 */
const referenceIsShadowed = (
  side: JSONSchemaObj,
  other: JSONSchemaObj,
): boolean =>
  typeof side.$ref === "string" &&
  (other.$ref !== side.$ref ||
    Object.keys(other).some((key) =>
      key !== "$ref" && !BRANCH_ANNOTATION_KEYWORDS.has(key)
    ));

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

/**
 * `side`, a reference, with the `ifc` beside it read as it resolves: the
 * referenced body's claims beneath it. A side carrying no `ifc` is returned
 * as it is.
 */
const withBodyClaimsBeneathSibling = (
  side: JSONSchemaObj,
  definitions: SchemaDefinitions,
): JSONSchemaObj => {
  if (!isObjectNotArray(side.ifc)) return side;
  const resolved = resolveKeepingBodyClaims(side, { $defs: definitions });
  return isObjectNotArray(resolved) && isObjectNotArray(resolved.ifc)
    ? { ...side, ifc: resolved.ifc }
    : side;
};

const resolveReferenceSide = (
  side: JSONSchemaObj,
  definitions: SchemaDefinitions,
): JSONSchemaObj => {
  const resolved = resolveKeepingBodyClaims(side, { $defs: definitions });
  return isObjectNotArray(resolved) ? resolved as JSONSchemaObj : side;
};

/**
 * A branch's structural correspondence key. Policies and reference targets
 * are reconciled by the node merge, and annotations constrain nothing;
 * reference boundaries and every other constraint, including discriminators
 * and literal defaults, stay in the key. Definition maps are inert below the
 * merged document's root.
 */
const unionBranchShape = (schema: JSONSchema): JSONSchema => {
  if (!isObjectNotArray(schema)) return schema;
  const { ifc: _ifc, $defs: _defs, ...annotated } = schema;
  const body = Object.fromEntries(
    Object.entries(annotated).filter(([key]) =>
      !BRANCH_ANNOTATION_KEYWORDS.has(key)
    ),
  ) as JSONSchemaObj;
  const shape = {
    ...mapSubschemas(
      typeof body.$ref === "string" ? { ...body, $ref: "" } : body,
      unionBranchShape,
      { includeUnused: true, visitBooleans: true },
    ) as JSONSchemaObj,
  };
  // These keyword arrays are order-independent. Keep multiplicity (oneOf
  // counts matching branches), and leave sequences and literal values whole.
  for (
    const key of [
      "required",
      "type",
      "enum",
      "allOf",
      "anyOf",
      "oneOf",
    ] as const
  ) {
    const members = shape[key];
    if (Array.isArray(members)) {
      Object.assign(shape, {
        [key]: members.toSorted((a, b) =>
          utf8Compare(hashStringOf(a), hashStringOf(b))
        ),
      });
    }
  }
  if (isObjectNotArray(shape.dependentRequired)) {
    shape.dependentRequired = Object.fromEntries(
      Object.entries(shape.dependentRequired).map(([key, members]) => [
        key,
        Array.isArray(members) ? members.toSorted(utf8Compare) : members,
      ]),
    );
  }
  return shape;
};

/** `branch`'s `type` keyword, with its reference resolved against `definitions`. */
const branchType = (
  branch: JSONSchema,
  definitions: SchemaDefinitions,
): JSONSchemaObj["type"] => {
  const resolved = isObjectNotArray(branch) && typeof branch.$ref === "string"
    ? resolveKeepingBodyClaims(branch, { $defs: definitions })
    : branch;
  return isObjectNotArray(resolved) ? resolved.type : undefined;
};

/**
 * Pairs every stored policy-bearing union branch with the one candidate branch
 * of its shape. A candidate branch with no stored counterpart is admitted only
 * where its declared types share no value with any stored branch's, so that no
 * value a stored branch admits can match it instead and leave that branch's
 * claims behind. Such a branch is `undefined` in the result.
 */
const correspondingUnionBranches = (
  existing: readonly JSONSchema[],
  candidate: readonly JSONSchema[],
  path: string,
  definitions: SchemaDefinitions,
): readonly (JSONSchema | undefined)[] => {
  const left = existing.map((branch) => hashStringOf(unionBranchShape(branch)));
  const right = candidate.map((branch) =>
    hashStringOf(unionBranchShape(branch))
  );
  const added = candidate.filter((_, index) => !left.includes(right[index]));
  const storedTypes = existing.map((branch) => branchType(branch, definitions));
  if (
    new Set(left).size !== left.length ||
    new Set(right).size !== right.length ||
    left.some((shape) => !right.includes(shape)) ||
    added.some((branch) => {
      const type = branchType(branch, definitions);
      return type === undefined ||
        storedTypes.some((stored) => !schemaTypesAreDisjoint(type, stored));
    })
  ) {
    throw new Error(
      `cannot reconcile policy-bearing union branches at ${path || "/"}`,
    );
  }
  return right.map((shape) =>
    left.includes(shape) ? existing[left.indexOf(shape)] : undefined
  );
};

/**
 * The reference a merge writes where `left` and `right` are references naming
 * different definitions, at least one of them declaring a claim: one to the
 * merged definition of the pair, minted here as the merge of the two
 * definitions they name. Inside that merge the pair refers to the definition
 * being minted, so the merge of two recursive definitions is itself a
 * recursive definition, holding at every level the claims the node merge
 * holds where it merges the two written out. Taking either side's definition
 * would drop the other's claims beneath, and merging the two written out
 * would write one more level out at each merge of the document.
 *
 * The definition is minted where the pair is first met below a position and
 * describes every position beneath that reaches the pair from there; a pair
 * met again beside that position is minted again, since a merge beneath a
 * position depends on the position (the paths a release relaxes, the paths a
 * module generates). Two mintings that mean the same definition fold into
 * one when the document is canonicalized.
 */
const mergedDefinitionRef = (
  left: JSONSchemaObj,
  right: JSONSchemaObj,
  path: string,
  logicalPath: readonly string[],
  options: MergeCfcSchemaEnvelopeOptions,
  references: MergeReferences,
): string => {
  const pair = referencePair(left, right);
  let name = references.merged.get(pair);
  if (name === undefined) {
    const base = localDefinitionName(left.$ref!) ??
      localDefinitionName(right.$ref!) ?? "definition";
    let suffix = 0;
    do name = `__cfc_merged_${suffix++}_${base}`; while (
      Object.hasOwn(references.definitions, name)
    );
    // Named before its body is merged, so that the name is taken while the
    // pair meets itself inside that merge.
    references.definitions[name] = {};
    const scoped: MergeReferences = {
      ...references,
      merged: new Map([...references.merged, [pair, name]]),
    };
    // A resolved body carries the document's map; the definition is stored
    // without it, as the hoisted ones are.
    references.definitions[name] = pruneCfcSchemaDefinitionBody(
      mergeSchemaNode(
        resolveReferenceSide({ $ref: left.$ref }, references.definitions),
        resolveReferenceSide({ $ref: right.$ref }, references.definitions),
        path,
        logicalPath,
        options,
        scoped,
      ),
    );
  }
  return encodedLocalDefinitionRef(name);
};

const mergeSchemaNode = (
  existing: JSONSchema,
  candidate: JSONSchema,
  path = "",
  logicalPath: readonly string[] = [],
  options: MergeCfcSchemaEnvelopeOptions = {},
  references?: MergeReferences,
  withinUnionBranch = false,
): JSONSchema => {
  let left = asSchemaObject(existing, path);
  let right = asSchemaObject(candidate, path);
  const originalLeft = left;
  const originalRight = right;
  // Where neither side declares any `ifc`, there is no claim to lose, and
  // references stay references. Otherwise two references naming different
  // definitions name the merged definition of the pair
  // (`mergedDefinitionRef()`); against an inline schema a reference resolves
  // at every depth, since the inline side runs out; and two references
  // naming one definition resolve where one's siblings shadow the other,
  // once on a path: met again further down they are a recursive definition
  // meeting itself, and merge as that reference.
  const bothReferences = typeof left.$ref === "string" &&
    typeof right.$ref === "string";
  const pair = referencePair(left, right);
  const policyRoot = references === undefined
    ? undefined
    : { $defs: references.definitions };
  const claims = policyRoot !== undefined &&
    (hasReachableIfc(left, policyRoot) || hasReachableIfc(right, policyRoot));
  const toMergedDefinition = claims && bothReferences &&
    left.$ref !== right.$ref;
  if (toMergedDefinition) {
    // An `ifc` beside a reference takes the place of the body's on
    // resolution, so each side's is read with the body's claims beneath it
    // before the two merge, and what the merged site carries beside its
    // reference is the merge of those (`resolveKeepingBodyClaims()`).
    left = withBodyClaimsBeneathSibling(left, references!.definitions);
    right = withBodyClaimsBeneathSibling(right, references!.definitions);
  }
  let childReferences = references;
  if (
    references !== undefined && claims && !toMergedDefinition &&
    !(bothReferences && references.active.has(pair))
  ) {
    // Every shadowed reference is resolved, so a reference declaring nothing
    // cannot stand in for one that does on the merged node.
    const resolveLeft = referenceIsShadowed(left, right);
    const resolveRight = referenceIsShadowed(right, left);
    if (resolveLeft || resolveRight) {
      childReferences = bothReferences
        ? { ...references, active: new Set([...references.active, pair]) }
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
        withinUnionBranch,
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
      withinUnionBranch,
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
      withinUnionBranch,
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
            withinUnionBranch,
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
  const unions: { anyOf?: JSONSchema[]; oneOf?: JSONSchema[] } = {};
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const leftBranches = left[keyword];
    const rightBranches = right[keyword];
    if (
      childReferences === undefined || leftBranches === undefined ||
      rightBranches === undefined || deepEqual(leftBranches, rightBranches)
    ) continue;
    const policyRoot = { $defs: childReferences.definitions };
    if (
      ![...leftBranches, ...rightBranches].some((branch) =>
        hasReachableIfc(branch, policyRoot)
      )
    ) continue;
    const counterparts = correspondingUnionBranches(
      leftBranches,
      rightBranches,
      path,
      childReferences.definitions,
    );
    const reconciled = rightBranches.map((branch, index) => {
      const counterpart = counterparts[index];
      return counterpart === undefined ? branch : mergeSchemaNode(
        counterpart,
        branch,
        path,
        logicalPath,
        options,
        childReferences,
        true,
      );
    });
    // A stored union is reconciled again with every later writer's schema,
    // which spells its branches as the candidate does. A branch whose merge
    // changed that spelling (a reference stored as the inline body that
    // merged both sides) would pair with no later writer's branch, and the
    // position could never be written again. Such a union is left to the
    // candidate, whose stored claims the claim-preservation check then holds.
    if (
      reconciled.some((branch, index) =>
        hashStringOf(unionBranchShape(branch)) !==
          hashStringOf(unionBranchShape(rightBranches[index]))
      )
    ) continue;
    unions[keyword] = reconciled;
    assertNoDivergentIfcBranches({ [keyword]: unions[keyword] }, path);
  }
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
  const merged: JSONSchemaObj = {
    ...rest,
    ...(toMergedDefinition
      ? {
        $ref: mergedDefinitionRef(
          left,
          right,
          path,
          logicalPath,
          options,
          references!,
        ),
      }
      : {}),
    ...unions,
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
  // Within a reconciled union branch, a body equal to either referenced body
  // keeps that reference, so shared policy definitions stay shared and the
  // branch keeps the spelling later writers pair with. Elsewhere a resolved
  // reference stays inline: the writer-claim walks (`cfcSchemaEntries`,
  // `writerClaimedPositions`) end a recursion where they meet the same schema
  // object again, so restoring a recursive reference would end them one
  // level sooner and leave a claimed position unmarked.
  // IFC siblings stay expanded: resolveKeepingBodyClaims() restores body
  // claims that the sibling masks during ordinary reference resolution.
  if (
    withinUnionBranch && (left !== originalLeft || right !== originalRight)
  ) {
    const { $defs: _leftDefs, ...leftBody } = left;
    const { $defs: _rightDefs, ...rightBody } = right;
    const { $defs: _mergedDefs, ...mergedBody } = merged;
    if (
      left !== originalLeft && originalLeft.ifc === undefined &&
      fabricAwareEqual(leftBody, mergedBody)
    ) {
      return originalLeft;
    }
    if (
      right !== originalRight && originalRight.ifc === undefined &&
      fabricAwareEqual(rightBody, mergedBody)
    ) {
      return originalRight;
    }
  }
  return merged;
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

/** One step of a `resolvedSchemaPolicyGraph()` walk, and the walk above it. */
type PolicyGraphVisit = {
  /** The document the schema sits in. */
  root: JSONSchema;

  /** The schema walked. */
  schema: JSONSchema;

  /** The step this one was reached from, if any. */
  parent: PolicyGraphVisit | undefined;
};

/**
 * The logical path a subschema reached through `keyword` describes, below the
 * value at `path`: a property's name, `*` for array items and for the rest of
 * a record that names no property, and an index for a tuple position. A
 * keyword that leaves the value where it was keeps `path`. Any other keyword,
 * and anything below an unknown path, describes no single path: `undefined`.
 */
const policyGraphChildPath = (
  path: readonly string[] | undefined,
  parent: JSONSchemaObj,
  keyword: string,
  key: string | undefined,
  index: number | undefined,
): readonly string[] | undefined => {
  if (path === undefined) return undefined;
  switch (keyword) {
    case "properties":
      return key === undefined ? undefined : [...path, key];
    case "items":
      return [...path, "*"];
    case "prefixItems":
      return index === undefined ? undefined : [...path, String(index)];
    case "additionalProperties":
      return parent.properties === undefined ||
          (isObjectOrArray(parent.properties) &&
            Object.keys(parent.properties).length === 0)
        ? [...path, "*"]
        : undefined;
    case "anyOf":
    case "oneOf":
    case "allOf":
      return path;
    default:
      return undefined;
  }
};

/**
 * The policy declarations of `schema`, a schema in the document `root` that
 * describes the value at `path`, at the positions they apply to: every
 * reference is followed to what it names, and a definition map is reached
 * only through a reference, so two spellings of one policy, one inlining what
 * the other names by reference, yield the same graph. A subschema at a path
 * `omits` names is left out, with everything beneath it. `active` is the
 * chain of schemas being walked; a reference back into it is recorded as a
 * recursion rather than followed.
 */
function resolvedSchemaPolicyGraph(
  schema: JSONSchema,
  root: JSONSchema,
  path: readonly string[] | undefined,
  omits: (path: readonly string[]) => boolean,
  active: PolicyGraphVisit | undefined,
): SchemaPolicyGraph | undefined {
  if (!isObjectNotArray(schema)) return undefined;
  for (let cursor = active; cursor !== undefined; cursor = cursor.parent) {
    if (cursor.root === root && cursor.schema === schema) {
      return { ifc: schema.ifc, ref: "#recursive", children: [] };
    }
  }
  // A claim beside a reference overlays the referenced body's claims of the
  // same kind and keeps the others, as the merge reads them.
  const resolved = typeof schema.$ref === "string"
    ? resolveKeepingBodyClaims(schema as JSONSchemaObj, root) ?? schema
    : schema;
  if (!isObjectNotArray(resolved)) return undefined;
  const childRoot = resolved !== schema
    ? cfcSchemaResolvedRoot(resolved, resolveCfcSchemaRefRoot(schema, root))
    : root;
  const nextActive: PolicyGraphVisit = { root, schema, parent: active };
  const children: SchemaPolicyGraph["children"] = [];
  forEachSubschema(resolved, (child, keyword, key, index) => {
    const childPath = policyGraphChildPath(path, resolved, keyword, key, index);
    if (childPath !== undefined && omits(childPath)) return;
    const policy = resolvedSchemaPolicyGraph(
      child,
      childRoot,
      childPath,
      omits,
      nextActive,
    );
    if (policy !== undefined) children.push({ keyword, key, index, policy });
  }, { includeUnused: true, visitBooleans: true });
  // A reference left unresolved is kept, so that it compares by what it says.
  const ref = resolved === schema ? schema.$ref : undefined;
  if (
    resolved.ifc === undefined && ref === undefined && children.length === 0
  ) {
    return undefined;
  }
  children.sort((left, right) =>
    utf8Compare(left.keyword, right.keyword) ||
    utf8Compare(left.key ?? "", right.key ?? "") ||
    (left.index ?? -1) - (right.index ?? -1)
  );
  return { ifc: resolved.ifc, ref, children };
}

/**
 * Whether two envelopes declare the same policies at the same positions: the
 * same `ifc` claims wherever a value can sit, whatever the public value
 * shapes, defaults and definition layouts around them. A reference, local or
 * `cid:`, compares as what it names, so a definition no reference reaches
 * declares nothing. A claim spelled as a member holding `undefined` compares
 * as no claim. Positions at a logical path `omits` names, and everything
 * beneath them, are not compared; a position whose path the walk cannot tell
 * is compared whatever `omits` says.
 */
export const cfcSchemaPoliciesEqual = (
  left: JSONSchema,
  right: JSONSchema,
  omits: (path: readonly string[]) => boolean = () => false,
): boolean =>
  hashStringOf(
    withoutUndefinedMembers(
      resolvedSchemaPolicyGraph(left, left, [], omits, undefined),
    ),
  ) ===
    hashStringOf(
      withoutUndefinedMembers(
        resolvedSchemaPolicyGraph(right, right, [], omits, undefined),
      ),
    );

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

/**
 * The merged envelope of `existing` and `candidate` as
 * {@link mergeCfcSchemaEnvelopes} builds it, before that canonicalizes it:
 * both documents' definitions under the names the hoist gave them, every
 * definition the merge minted, and the maps resolved bodies carry. It is what
 * canonicalization is held to meaning the same as, and is persisted nowhere.
 */
export const mergeCfcSchemaEnvelopesBeforeCanonicalization = (
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
  const { fragments: [left, right], definitions: hoisted } = hoistCfcSchemaDefs(
    [existing, candidate],
  );
  // The merged document's map: both sides' definitions, and the ones the
  // merge mints where two differing references meet (`mergedDefinitionRef()`).
  const definitions: Record<string, JSONSchema> = { ...hoisted };
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
      ? { definitions, active: new Set(), merged: new Map() }
      : undefined,
  );
  return Object.keys(definitions).length > 0 && isObjectOrArray(merged)
    ? { ...merged, $defs: definitions }
    : merged;
};

/**
 * The merged envelope of `existing` and `candidate`, in canonical form.
 * Throws where the two cannot merge.
 */
export const mergeCfcSchemaEnvelopes = (
  existing: JSONSchema,
  candidate: JSONSchema,
  options: MergeCfcSchemaEnvelopeOptions = {},
): JSONSchema =>
  // The merged document is persisted and hashed as it is returned, so it
  // leaves here in canonical form: one root map, every authored definition,
  // one minted definition per meaning those do not carry, nothing minted
  // that the document does not reach.
  internSchema(
    canonicalizeCfcSchemaDocument(
      mergeCfcSchemaEnvelopesBeforeCanonicalization(
        existing,
        candidate,
        options,
      ),
    ),
  );

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
