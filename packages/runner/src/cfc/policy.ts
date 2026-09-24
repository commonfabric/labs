import { deepFreeze, hashStringOf } from "@commonfabric/data-model";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import {
  type AtomPattern,
  isAtomPattern,
  isAtomVarPlaceholder,
} from "./atom-pattern.ts";

export const CFC_POLICY_MANIFEST_ID_PREFIX = "of:cfc-policy-manifest:";

export const cfcPolicyManifestDocId = (
  policyDigest: string,
): `of:${string}` => `${CFC_POLICY_MANIFEST_ID_PREFIX}${policyDigest}`;

/**
 * Policy records + exchange rules (spec §4.3/§4.4, Epic B2 of
 * docs/history/plans/cfc-future-work-implementation.md §3).
 *
 * A deployment-configured, frozen policy set supplied via
 * `RuntimeOptions.cfcPolicyRecords` — and, per the revised B2b decision,
 * the ENDURING record store: remote attestation covers deployment config
 * for security-sensitive inputs like this one, so attested federated peers
 * provably evaluate the same record set and the originally planned
 * space-hosted policy documents are not needed for federation soundness
 * (owner decision 2026-07-10; docs/specs/cfc-spec-changes.md SC-28). Rule
 * scoping is per record: `ambient` records apply through their rules'
 * `appliesTo` patterns to every label (spec §4.4.1's deployment/system
 * policy root as a discovery source); `referenced` records are selected by
 * label-carried, hash-bound `Policy(...)`/`Context(...)` principals and
 * rewrite only their home clauses (CT-1874; `exchange-eval.ts`).
 */

/**
 * A guarded clause-local rewrite (spec §4.3.2). Shape mapping to the spec's
 * `ExchangeRule`: `appliesTo` is the spec's `preCondition.confidentiality[0]`
 * — the TARGET pattern that selects the clause alternative being rewritten;
 * `preCondition.confidentiality` here holds only the REMAINING side
 * conditions (`[1..]`), scoped by `preConfScope`. `post.addAlternatives` is
 * the spec's `postCondition.confidentiality`; `post.dropClause: true` is the
 * spec's empty instantiated confidentiality postcondition (drop the matched
 * alternative / clause). Integrity postconditions are deliberately absent
 * from B2a — no rule ships that needs one, and evidence minting stays with
 * trusted runtime surfaces.
 */
export type ExchangeRule = {
  /** Stable identifier: diagnostics, canonical evaluation order, digests. */
  readonly id: string;

  /** Target pattern selecting the clause alternative this rule rewrites. */
  readonly appliesTo: AtomPattern;

  /**
   * Conjunctive guards (spec §4.3.2 preCondition). `confidentiality` are the
   * non-target side conditions; `integrity` match against available
   * integrity evidence (invariant 3: exchange requires explicit integrity
   * guards); `boundary` match against boundary-context atoms minted per
   * evaluation (`BoundaryContext` — the generic form of the spec's
   * `allowedSink` applicability metadata); `policyState` match against
   * durable grant records resolved through `ExchangeEvalContext.grantResolver`
   * (spec §8.12.7 route 2a / §13.4.4 — each pattern is a record with a
   * CONCRETE string `kind` plus field patterns; variables bind from the
   * resolved grant's fields exactly as atom patterns bind).
   */
  readonly preCondition?: {
    readonly confidentiality?: readonly AtomPattern[];
    readonly integrity?: readonly AtomPattern[];
    readonly boundary?: readonly AtomPattern[];
    readonly policyState?: readonly AtomPattern[];
  };

  /**
   * Scope for the non-target confidentiality side conditions. Default
   * `targetClause`: they must match alternatives of the SAME clause as the
   * target match. `anywhere` (opt-in) lets them match any clause of the
   * label.
   */
  readonly preConfScope?: "targetClause" | "anywhere";

  /**
   * Effect when the rule fires on a matched clause alternative. Exactly one
   * of the two forms (validated): `addAlternatives` instantiates patterns
   * under the match bindings and ADDS them to the matched clause (spec
   * §3.1.3 — exchange rules add alternatives); `dropClause: true` removes
   * the matched alternative (and the clause when no alternatives remain) —
   * the spec's empty-postcondition removal form.
   */
  readonly post: {
    readonly addAlternatives?: readonly AtomPattern[];
    readonly dropClause?: boolean;
  };
};

/**
 * How a record enters evaluation scope (B2b label-carried selection):
 *
 * - `ambient` (default, the B2a posture): in scope for every evaluated label
 *   — the operator-vetted standard profiles (B6 sanitizer, display), spec
 *   §4.4.1's deployment/system policy root as a discovery source.
 * - `referenced`: in scope ONLY where a label clause carries a policy-ref
 *   atom (`Policy(...)`/`Context(...)`, spec §4.4.2) whose `name` matches the
 *   record id AND whose `hash` matches the record digest — and its rules may
 *   rewrite only that atom's home clause(s) (CT-1874 / invariant 11: a policy
 *   admitted as one clause's alternative must not widen sibling clauses).
 */
export type CfcPolicySelection = "ambient" | "referenced";

/**
 * A named, digest-bound set of exchange rules (spec §4.3.1, reduced to the
 * B2a surface: `id` + `rules` + `selection`). `digest` is COMPUTED
 * content-addressing over the canonical record content — never trusted from
 * input (a supplied digest is verified and mismatch fails closed, §4.4.3
 * discipline).
 */
export type PolicyRecord = {
  readonly id: string;
  readonly digest: string;
  readonly rules: readonly ExchangeRule[];
  readonly selection: CfcPolicySelection;
};

/**
 * The frozen record set a Runtime evaluates under, with a digest covering
 * every record — B5 folds it into `PreparedDigestInput` so a policy change
 * between prepare and commit invalidates (same discipline as
 * `trustSnapshot`).
 */
export type PolicySnapshot = {
  readonly records: readonly PolicyRecord[];
  readonly digest: string;
};

/**
 * Authoring form for `RuntimeOptions.cfcPolicyRecords`: a record without a
 * digest (computed at construction), or with one to be verified.
 */
export type CfcPolicyRecordInput = {
  readonly id: string;
  readonly rules: readonly ExchangeRule[];
  readonly digest?: string;

  /** Scope mode (see {@link CfcPolicySelection}); defaults to `ambient`. */
  readonly selection?: CfcPolicySelection;
};

export type PolicyTemplateExchangeRuleV1 = {
  readonly name: string;
  readonly preCondition: {
    readonly confidentiality: readonly AtomPattern[];
    readonly integrity: readonly AtomPattern[];
  };
  readonly preConfScope?: "targetClause" | "anywhere";
  readonly postCondition: {
    readonly confidentiality: readonly AtomPattern[];
    readonly integrity: readonly AtomPattern[];
  };
  readonly guard?: {
    readonly policyState: readonly AtomPattern[];
  };
};

export type PolicyTemplateV1 = {
  readonly templateVersion: 1;
  readonly exchangeRules: readonly PolicyTemplateExchangeRuleV1[];
  readonly dependencies: {
    readonly authorityOnly: readonly string[];
    readonly dataBearing: readonly string[];
  };
  readonly integrityRequirements: {
    readonly read?: readonly AtomPattern[];
    readonly write?: readonly AtomPattern[];
    readonly share?: readonly AtomPattern[];
  };
};

export type PolicyArtifactManifestBodyV1 = {
  readonly formatVersion: 1;
  readonly moduleIdentity: string;
  readonly symbol: string;
  readonly template: PolicyTemplateV1;
};

export type PolicyArtifactManifestV1 = {
  readonly policyDigest: string;
  readonly manifest: PolicyArtifactManifestBodyV1;
};

const RECORD_INPUT_KEYS = new Set(["id", "rules", "digest", "selection"]);
const RULE_KEYS = new Set([
  "id",
  "appliesTo",
  "preCondition",
  "preConfScope",
  "post",
]);
const PRE_CONDITION_KEYS = new Set([
  "confidentiality",
  "integrity",
  "boundary",
  "policyState",
]);
const POST_KEYS = new Set(["addAlternatives", "dropClause"]);
const MANIFEST_BODY_KEYS = new Set([
  "formatVersion",
  "moduleIdentity",
  "symbol",
  "template",
]);
const MANIFEST_ENVELOPE_KEYS = new Set(["policyDigest", "manifest"]);
const TEMPLATE_KEYS = new Set([
  "templateVersion",
  "exchangeRules",
  "dependencies",
  "integrityRequirements",
]);
const TEMPLATE_RULE_KEYS = new Set([
  "name",
  "preCondition",
  "preConfScope",
  "postCondition",
  "guard",
]);
const TEMPLATE_PRE_CONDITION_KEYS = new Set([
  "confidentiality",
  "integrity",
]);
const TEMPLATE_POST_CONDITION_KEYS = new Set([
  "confidentiality",
  "integrity",
]);
const TEMPLATE_GUARD_KEYS = new Set(["policyState"]);
const DEPENDENCY_KEYS = new Set(["authorityOnly", "dataBearing"]);
const INTEGRITY_REQUIREMENT_KEYS = new Set(["read", "write", "share"]);

/**
 * Deployment policy records are trusted enforcement config, so malformation
 * fails CLOSED at construction time — a thrown error at Runtime boot naming
 * the offending record/rule, never a silently skipped rule (a dropped
 * discharge rule would be safe, but a dropped guard on a record an operator
 * believes active is a policy hole they cannot see). Unknown keys are
 * rejected for the same reason: a typo like `precondition` must not become
 * an unguarded rule.
 */
const rejectUnknownKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  where: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`cfcPolicyRecords: unknown key "${key}" in ${where}`);
    }
  }
};

// A PLAIN object (prototype `Object.prototype` or null) — the shape authored
// TS literals and parsed JSON produce. `isObjectOrArray` alone admits `Map`, `Set`,
// and class instances, whose own-enumerable string keys are usually empty, so
// the field-by-field validation below would read NO guards and wave through
// an unguarded rule (cubic P1 on #4562). Config that is not a plain object
// fails closed here.
const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isObjectNotArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const validatePatternArray = (
  value: unknown,
  where: string,
): readonly AtomPattern[] => {
  if (!Array.isArray(value)) {
    throw new Error(`cfcPolicyRecords: ${where} must be an array`);
  }
  for (const pattern of value) {
    if (pattern === undefined) {
      throw new Error(
        `cfcPolicyRecords: ${where} contains an undefined pattern`,
      );
    }
    if (!isAtomPattern(pattern)) {
      throw new Error(
        `cfcPolicyRecords: ${where} contains a pattern that is not a \`FabricValue\``,
      );
    }
  }
  return value as readonly AtomPattern[];
};

const isThisPolicyPattern = (value: unknown): boolean =>
  isPlainRecord(value) && Object.keys(value).length === 1 &&
  value.thisPolicy === true;

const isThisPolicyFieldPattern = (value: unknown): boolean =>
  isPlainRecord(value) && Object.keys(value).length === 1 &&
  (value.thisPolicyField === "subject" ||
    value.thisPolicyField === "moduleIdentity");

const validateTemplatePattern = (
  value: unknown,
  where: string,
  allowThisPolicy = false,
): void => {
  if (value === undefined) {
    throw new Error(`cfcPolicyManifest: ${where} contains undefined`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      validateTemplatePattern(entry, `${where}[${index}]`)
    );
    return;
  }
  if (!isObjectOrArray(value)) return;
  if (Object.hasOwn(value, "var")) {
    if (!isAtomVarPlaceholder(value)) {
      throw new Error(`cfcPolicyManifest: malformed variable in ${where}`);
    }
    return;
  }
  if (Object.hasOwn(value, "thisPolicy")) {
    if (!allowThisPolicy || !isThisPolicyPattern(value)) {
      throw new Error(`cfcPolicyManifest: invalid THIS_POLICY in ${where}`);
    }
    return;
  }
  if (Object.hasOwn(value, "thisPolicyField")) {
    if (!isThisPolicyFieldPattern(value)) {
      throw new Error(
        `cfcPolicyManifest: invalid THIS_POLICY field in ${where}`,
      );
    }
    return;
  }
  for (const [key, field] of Object.entries(value)) {
    validateTemplatePattern(field, `${where}.${key}`);
  }
};

const collectPatternVariables = (
  value: unknown,
  variables: Set<string>,
): void => {
  if (isAtomVarPlaceholder(value)) {
    variables.add(value.var);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectPatternVariables(entry, variables));
    return;
  }
  if (isObjectOrArray(value)) {
    Object.values(value).forEach((field) =>
      collectPatternVariables(field, variables)
    );
  }
};

/**
 * `policyState` guard validation (§8.12.7 route 2a): each entry is a grant
 * pattern — a PLAIN record whose `kind` field is a CONCRETE non-empty string
 * (the resolver point-queries by kind; a variable or pattern-valued kind
 * would require enumeration, which the §4.9.3 discipline forbids). Remaining
 * fields are ordinary atom patterns. An EMPTY array is rejected: a
 * policyState guard that names no grant pattern gates nothing — an authoring
 * error a policy author must see, not a vacuously-satisfied guard.
 */
const validatePolicyStateGuards = (
  value: readonly AtomPattern[],
  where: string,
): void => {
  if (value.length === 0) {
    throw new Error(
      `cfcPolicyRecords: ${where} must name at least one grant pattern`,
    );
  }
  for (const pattern of value) {
    if (!isPlainRecord(pattern)) {
      throw new Error(
        `cfcPolicyRecords: ${where} entries must be grant-pattern records`,
      );
    }
    // Own property required: the digest projection and atom-pattern matching
    // consider own fields only, so an inherited `kind` must not satisfy boot
    // validation (cubic P2 on #4627; isPlainRecord already confines this to
    // Object.prototype, where a `kind` would be global pollution — belt).
    const kind = Object.hasOwn(pattern, "kind")
      ? (pattern as { kind: unknown }).kind
      : undefined;
    if (typeof kind !== "string" || kind.length === 0) {
      throw new Error(
        `cfcPolicyRecords: ${where} entries need a concrete non-empty ` +
          `string kind (grant resolution is a point query by kind)`,
      );
    }
  }
};

const validateExchangeRule = (
  rule: unknown,
  where: string,
): ExchangeRule => {
  if (!isPlainRecord(rule)) {
    throw new Error(`cfcPolicyRecords: ${where} must be a rule object`);
  }
  rejectUnknownKeys(rule, RULE_KEYS, where);
  const { id, appliesTo, preCondition, preConfScope, post } = rule as {
    id?: unknown;
    appliesTo?: unknown;
    preCondition?: unknown;
    preConfScope?: unknown;
    post?: unknown;
  };
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`cfcPolicyRecords: ${where} needs a non-empty string id`);
  }
  const ruleWhere = `${where} "${id}"`;
  if (appliesTo === undefined) {
    throw new Error(
      `cfcPolicyRecords: ${ruleWhere} needs an appliesTo pattern`,
    );
  }
  if (!isAtomPattern(appliesTo)) {
    throw new Error(
      `cfcPolicyRecords: ${ruleWhere} appliesTo is not a \`FabricValue\``,
    );
  }
  if (preCondition !== undefined) {
    if (!isPlainRecord(preCondition)) {
      throw new Error(
        `cfcPolicyRecords: ${ruleWhere} preCondition must be an object`,
      );
    }
    rejectUnknownKeys(
      preCondition,
      PRE_CONDITION_KEYS,
      `${ruleWhere} preCondition`,
    );
    for (const guard of ["confidentiality", "integrity", "boundary"] as const) {
      const patterns = (preCondition as Record<string, unknown>)[guard];
      if (patterns !== undefined) {
        validatePatternArray(patterns, `${ruleWhere} preCondition.${guard}`);
      }
    }
    const policyState = (preCondition as Record<string, unknown>).policyState;
    if (policyState !== undefined) {
      const guardWhere = `${ruleWhere} preCondition.policyState`;
      validatePolicyStateGuards(
        validatePatternArray(policyState, guardWhere),
        guardWhere,
      );
    }
  }
  if (
    preConfScope !== undefined && preConfScope !== "targetClause" &&
    preConfScope !== "anywhere"
  ) {
    throw new Error(
      `cfcPolicyRecords: ${ruleWhere} preConfScope must be "targetClause" or "anywhere"`,
    );
  }
  if (!isPlainRecord(post)) {
    throw new Error(`cfcPolicyRecords: ${ruleWhere} needs a post object`);
  }
  rejectUnknownKeys(post, POST_KEYS, `${ruleWhere} post`);
  const { addAlternatives, dropClause } = post as {
    addAlternatives?: unknown;
    dropClause?: unknown;
  };
  if (dropClause !== undefined && typeof dropClause !== "boolean") {
    throw new Error(
      `cfcPolicyRecords: ${ruleWhere} post.dropClause must be a boolean`,
    );
  }
  const adds = addAlternatives === undefined ? undefined : validatePatternArray(
    addAlternatives,
    `${ruleWhere} post.addAlternatives`,
  );
  const drops = dropClause === true;
  // Exactly one effect: an empty post is a no-op rule (an authoring error a
  // policy author must see), and add+drop on one rule is contradictory —
  // the spec models dropping as the EMPTY instantiated postcondition.
  if (drops && adds !== undefined) {
    throw new Error(
      `cfcPolicyRecords: ${ruleWhere} post cannot both addAlternatives and dropClause`,
    );
  }
  if (!drops && (adds === undefined || adds.length === 0)) {
    throw new Error(
      `cfcPolicyRecords: ${ruleWhere} post must addAlternatives or dropClause`,
    );
  }
  return rule as ExchangeRule;
};

/**
 * Canonical digestible projection of a record's content. Explicit field
 * spelling (rather than hashing the input object) so unknown/absent keys and
 * input aliasing cannot reach the digest, and a supplied-then-verified digest
 * never participates in its own computation. `hashStringOf` hashes object
 * fields in sorted-key order, so authoring key order is already immaterial;
 * rule ORDER is content (kept — reordering rules is a different record).
 */
const policyRecordDigest = (
  id: string,
  rules: readonly ExchangeRule[],
  selection: CfcPolicySelection,
): string =>
  hashStringOf({
    // Version 3: the digestible projection gained `selection` (B2b
    // label-carried scope; absent == "ambient" by construction, no
    // conditional key inclusion). Version 2 added `policyState` (§8.12.7
    // route 2a guards). Each bump changes every record digest — safe while
    // digests only feed in-memory prepared digests, and REQUIRED here: a
    // selection flip re-scopes every rule, so it must invalidate. NOTE:
    // from B2b on, label-carried policy-ref atoms persist record digests as
    // their `hash` binding — a future projection change strands those refs
    // (they stop matching and fail CLOSED, the §4.4.3/§4.4.4 version-
    // mismatch posture) until labels re-mint against the new digests.
    version: 3,
    id,
    selection,
    rules: rules.map((rule) => ({
      id: rule.id,
      appliesTo: rule.appliesTo,
      preCondition: {
        confidentiality: rule.preCondition?.confidentiality ?? [],
        integrity: rule.preCondition?.integrity ?? [],
        boundary: rule.preCondition?.boundary ?? [],
        policyState: rule.preCondition?.policyState ?? [],
      },
      preConfScope: rule.preConfScope ?? "targetClause",
      post: {
        addAlternatives: rule.post.addAlternatives ?? [],
        dropClause: rule.post.dropClause === true,
      },
    })),
  });

const validateStringArray = (value: unknown, where: string): void => {
  if (
    !Array.isArray(value) || value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`cfcPolicyManifest: ${where} must be a string array`);
  }
};

const validatePolicyTemplateRule = (
  input: unknown,
): PolicyTemplateExchangeRuleV1 => {
  if (!isPlainRecord(input)) {
    throw new Error("cfcPolicyManifest: module policy rule must be an object");
  }
  rejectUnknownKeys(input, TEMPLATE_RULE_KEYS, "module policy rule");
  if (typeof input.name !== "string" || input.name.length === 0) {
    throw new Error("cfcPolicyManifest: module policy rule needs a name");
  }
  const where = `module policy rule "${input.name}"`;
  if (!isPlainRecord(input.preCondition)) {
    throw new Error(`cfcPolicyManifest: ${where} needs a preCondition`);
  }
  rejectUnknownKeys(
    input.preCondition,
    TEMPLATE_PRE_CONDITION_KEYS,
    `${where} preCondition`,
  );
  const confidentiality = validatePatternArray(
    input.preCondition.confidentiality,
    `${where} preCondition.confidentiality`,
  );
  const integrity = validatePatternArray(
    input.preCondition.integrity,
    `${where} preCondition.integrity`,
  );
  if (
    confidentiality.length === 0 || !isThisPolicyPattern(confidentiality[0])
  ) {
    throw new Error(
      `cfcPolicyManifest: ${where} must target THIS_POLICY as its first confidentiality pattern`,
    );
  }
  confidentiality.forEach((pattern, index) =>
    validateTemplatePattern(
      pattern,
      `${where} preCondition.confidentiality[${index}]`,
      index === 0,
    )
  );
  integrity.forEach((pattern, index) =>
    validateTemplatePattern(
      pattern,
      `${where} preCondition.integrity[${index}]`,
    )
  );
  if (
    input.preConfScope !== undefined &&
    input.preConfScope !== "targetClause" &&
    input.preConfScope !== "anywhere"
  ) {
    throw new Error(
      `cfcPolicyManifest: ${where} preConfScope must be "targetClause" or "anywhere"`,
    );
  }
  if (!isPlainRecord(input.postCondition)) {
    throw new Error(`cfcPolicyManifest: ${where} needs a postCondition`);
  }
  rejectUnknownKeys(
    input.postCondition,
    TEMPLATE_POST_CONDITION_KEYS,
    `${where} postCondition`,
  );
  const postConfidentiality = validatePatternArray(
    input.postCondition.confidentiality,
    `${where} postCondition.confidentiality`,
  );
  const postIntegrity = validatePatternArray(
    input.postCondition.integrity,
    `${where} postCondition.integrity`,
  );
  if (postIntegrity.length > 0) {
    throw new Error(
      `cfcPolicyManifest: ${where} cannot mint integrity in authoring v1`,
    );
  }
  postConfidentiality.forEach((pattern, index) =>
    validateTemplatePattern(
      pattern,
      `${where} postCondition.confidentiality[${index}]`,
    )
  );

  let policyState: readonly AtomPattern[] = [];
  if (input.guard !== undefined) {
    if (!isPlainRecord(input.guard)) {
      throw new Error(`cfcPolicyManifest: ${where} guard must be an object`);
    }
    rejectUnknownKeys(input.guard, TEMPLATE_GUARD_KEYS, `${where} guard`);
    policyState = validatePatternArray(
      input.guard.policyState,
      `${where} guard.policyState`,
    );
    validatePolicyStateGuards(policyState, `${where} guard.policyState`);
    policyState.forEach((pattern, index) =>
      validateTemplatePattern(
        pattern,
        `${where} guard.policyState[${index}]`,
      )
    );
  }
  if (integrity.length === 0 && policyState.length === 0) {
    throw new Error(
      `cfcPolicyManifest: ${where} needs an integrity or policyState guard`,
    );
  }

  const bound = new Set<string>();
  collectPatternVariables(confidentiality, bound);
  collectPatternVariables(integrity, bound);
  collectPatternVariables(policyState, bound);
  const postVariables = new Set<string>();
  collectPatternVariables(postConfidentiality, postVariables);
  for (const variable of postVariables) {
    if (!bound.has(variable)) {
      throw new Error(
        `cfcPolicyManifest: ${where} has unbound postcondition variable "${variable}"`,
      );
    }
  }
  return input as PolicyTemplateExchangeRuleV1;
};

const validatePolicyTemplate = (input: unknown): PolicyTemplateV1 => {
  if (!isPlainRecord(input)) {
    throw new Error("cfcPolicyManifest: template must be an object");
  }
  rejectUnknownKeys(input, TEMPLATE_KEYS, "policy template");
  if (input.templateVersion !== 1) {
    throw new Error("cfcPolicyManifest: templateVersion must be 1");
  }
  if (!Array.isArray(input.exchangeRules)) {
    throw new Error("cfcPolicyManifest: exchangeRules must be an array");
  }
  const ruleNames = new Set<string>();
  for (const rule of input.exchangeRules) {
    const validated = validatePolicyTemplateRule(rule);
    if (ruleNames.has(validated.name)) {
      throw new Error(
        `cfcPolicyManifest: duplicate rule name "${validated.name}"`,
      );
    }
    ruleNames.add(validated.name);
  }
  if (!isPlainRecord(input.dependencies)) {
    throw new Error("cfcPolicyManifest: dependencies must be an object");
  }
  rejectUnknownKeys(
    input.dependencies,
    DEPENDENCY_KEYS,
    "template dependencies",
  );
  validateStringArray(
    input.dependencies.authorityOnly,
    "dependencies.authorityOnly",
  );
  validateStringArray(
    input.dependencies.dataBearing,
    "dependencies.dataBearing",
  );
  if (!isPlainRecord(input.integrityRequirements)) {
    throw new Error(
      "cfcPolicyManifest: integrityRequirements must be an object",
    );
  }
  rejectUnknownKeys(
    input.integrityRequirements,
    INTEGRITY_REQUIREMENT_KEYS,
    "template integrityRequirements",
  );
  for (const operation of INTEGRITY_REQUIREMENT_KEYS) {
    const patterns = input.integrityRequirements[operation];
    if (patterns === undefined) continue;
    const validated = validatePatternArray(
      patterns,
      `integrityRequirements.${operation}`,
    );
    validated.forEach((pattern, index) =>
      validateTemplatePattern(
        pattern,
        `integrityRequirements.${operation}[${index}]`,
      )
    );
  }
  return input as PolicyTemplateV1;
};

/** Adapts the normative portable template into the runner's clause-local form. */
export const lowerCfcPolicyTemplateRules = (
  template: PolicyTemplateV1,
): readonly ExchangeRule[] =>
  template.exchangeRules.map((rule) => {
    const [appliesTo, ...confidentiality] = rule.preCondition.confidentiality;
    return {
      id: rule.name,
      appliesTo: appliesTo!,
      preCondition: {
        confidentiality,
        integrity: rule.preCondition.integrity,
        ...(rule.guard === undefined
          ? {}
          : { policyState: rule.guard.policyState }),
      },
      ...(rule.preConfScope === undefined
        ? {}
        : { preConfScope: rule.preConfScope }),
      post: rule.postCondition.confidentiality.length === 0
        ? { dropClause: true }
        : { addAlternatives: rule.postCondition.confidentiality },
    };
  });

const validatePolicyManifestBody = (
  input: unknown,
): PolicyArtifactManifestBodyV1 => {
  if (!isPlainRecord(input)) {
    throw new Error("cfcPolicyManifest: manifest body must be an object");
  }
  rejectUnknownKeys(input, MANIFEST_BODY_KEYS, "policy manifest body");
  if (input.formatVersion !== 1) {
    throw new Error("cfcPolicyManifest: formatVersion must be 1");
  }
  if (
    typeof input.moduleIdentity !== "string" ||
    input.moduleIdentity.length === 0
  ) {
    throw new Error(
      "cfcPolicyManifest: moduleIdentity must be a non-empty string",
    );
  }
  if (typeof input.symbol !== "string" || input.symbol.length === 0) {
    throw new Error("cfcPolicyManifest: symbol must be a non-empty string");
  }
  validatePolicyTemplate(input.template);
  return input as PolicyArtifactManifestBodyV1;
};

const policyManifestDigest = (
  manifest: PolicyArtifactManifestBodyV1,
): string =>
  hashStringOf({
    domain: "cfc/policy-manifest/v1",
    manifest,
  });

/** Validates, canonical-digests, and freezes one compiler-produced manifest. */
export const buildCfcPolicyArtifactManifest = (
  input: PolicyArtifactManifestBodyV1,
): PolicyArtifactManifestV1 => {
  const manifest = validatePolicyManifestBody(input);
  return deepFreeze({
    policyDigest: policyManifestDigest(manifest),
    manifest,
  });
};

/** Trusted-ingestion validation for a transported manifest envelope. */
export const validateCfcPolicyArtifactManifest = (
  input: unknown,
): PolicyArtifactManifestV1 => {
  if (!isPlainRecord(input)) {
    throw new Error("cfcPolicyManifest: envelope must be an object");
  }
  rejectUnknownKeys(input, MANIFEST_ENVELOPE_KEYS, "policy manifest envelope");
  if (
    typeof input.policyDigest !== "string" || input.policyDigest.length === 0
  ) {
    throw new Error(
      "cfcPolicyManifest: policyDigest must be a non-empty string",
    );
  }
  const built = buildCfcPolicyArtifactManifest(
    input.manifest as PolicyArtifactManifestBodyV1,
  );
  if (built.policyDigest !== input.policyDigest) {
    throw new Error(
      `cfcPolicyManifest: policyDigest mismatch (expected ${built.policyDigest})`,
    );
  }
  return built;
};

/**
 * Validates, digests, and deep-freezes a deployment policy-record set into
 * the `PolicySnapshot` a Runtime holds for its lifetime (mirrors the
 * `cfcSinkMaxConfidentiality` freeze discipline — enforcement config must
 * not be mutable after construction). Returns `undefined` for an undefined
 * input (no policies configured); an EMPTY array is a declared empty
 * snapshot with a stable digest. Throws on any malformed record (see
 * `rejectUnknownKeys` rationale), duplicate record/rule ids, and supplied
 * digests that fail verification.
 */
export const buildCfcPolicySnapshot = (
  inputs: readonly CfcPolicyRecordInput[] | undefined,
): PolicySnapshot | undefined => {
  if (inputs === undefined) return undefined;
  if (!Array.isArray(inputs)) {
    throw new Error("cfcPolicyRecords must be an array of policy records");
  }
  const records: PolicyRecord[] = [];
  const recordIds = new Set<string>();
  for (const input of inputs) {
    if (!isPlainRecord(input)) {
      throw new Error("cfcPolicyRecords: each record must be an object");
    }
    rejectUnknownKeys(input, RECORD_INPUT_KEYS, "policy record");
    const { id, rules, digest, selection } = input as {
      id?: unknown;
      rules?: unknown;
      digest?: unknown;
      selection?: unknown;
    };
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(
        "cfcPolicyRecords: each record needs a non-empty string id",
      );
    }
    if (recordIds.has(id)) {
      throw new Error(`cfcPolicyRecords: duplicate record id "${id}"`);
    }
    recordIds.add(id);
    if (
      selection !== undefined && selection !== "ambient" &&
      selection !== "referenced"
    ) {
      throw new Error(
        `cfcPolicyRecords: record "${id}" selection must be "ambient" or "referenced"`,
      );
    }
    if (!Array.isArray(rules)) {
      throw new Error(`cfcPolicyRecords: record "${id}" needs a rules array`);
    }
    const ruleIds = new Set<string>();
    const validatedRules = rules.map((rule) => {
      const validated = validateExchangeRule(rule, `record "${id}" rule`);
      if (ruleIds.has(validated.id)) {
        throw new Error(
          `cfcPolicyRecords: record "${id}" has duplicate rule id "${validated.id}"`,
        );
      }
      ruleIds.add(validated.id);
      return validated;
    });
    const recordSelection: CfcPolicySelection = selection ?? "ambient";
    const computedDigest = policyRecordDigest(
      id,
      validatedRules,
      recordSelection,
    );
    if (digest !== undefined && digest !== computedDigest) {
      throw new Error(
        `cfcPolicyRecords: record "${id}" digest mismatch (expected ${computedDigest})`,
      );
    }
    records.push({
      id,
      digest: computedDigest,
      rules: validatedRules,
      selection: recordSelection,
    });
  }
  const snapshot: PolicySnapshot = {
    records,
    digest: hashStringOf({
      version: 1,
      records: records.map((record) => record.digest),
    }),
  };
  return deepFreeze(snapshot);
};
