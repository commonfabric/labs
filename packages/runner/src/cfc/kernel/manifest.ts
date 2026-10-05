/**
 * The correspondence manifest: one row per critical function of the
 * Contextual Flow Control specification, stating how this runtime relates to
 * it.
 *
 * A critical function is one the specification states as TypeScript
 * pseudocode and the Lean development under `cfc/formal/` mechanizes, narrowed
 * to the ones a reactive runtime executes. Each row names the chapter file and
 * section that state it, the Lean definition `cfc/formal/FORMALIZATION.md`
 * gives it in its "Pseudocode Coverage Matrix", and the relation this
 * runtime's code bears to it. The relation is one of three:
 *
 * - `missing`: no kernel function exists; the row names the runtime symbols
 *   that make the pseudocode's decision today, scattered through the
 *   adapters, or `unknown` where no symbol does.
 * - `exact`: the kernel file named holds a function of the pseudocode's name
 *   and shape, carrying a `@spec` header whose hash the spec snapshot
 *   confirms.
 * - `adapted`: as `exact`, with a stated difference from the pseudocode and
 *   the specs pull request that ruled the difference acceptable.
 *
 * `deno task check-cfc-correspondence` holds this table to the snapshot
 * beside it and to the kernel directory: a row must name a function the
 * snapshot has; a row that is `exact` or `adapted` must name a kernel file
 * exporting that function under a matching header; a `missing` row must name
 * a function the kernel does not yet export. The check also reports a
 * function the snapshot defines in a section some row names that neither a
 * row nor {@link COMPANIONS} accounts for, so the specification adding a
 * function beside a critical one is a decision this table has to record.
 *
 * `docs/development/cfc-spec-correspondence.md` holds the procedure that
 * turns a row from `missing` to one of the other two.
 */

/** A runtime symbol, by file under `packages/runner/src/` and name. */
export interface RuntimeSymbol {
  /** The file, relative to `packages/runner/src/`. */
  readonly file: string;

  /** The top-level symbol in that file. */
  readonly symbol: string;
}

/** What a row says about the kernel, by relation. */
export type ManifestRelation =
  /** No kernel function yet; the adapters decide it where `decidedToday` says. */
  | {
    readonly relation: "missing";

    /**
     * The runtime symbols that make the pseudocode's decision today, or
     * `unknown` where none was found to.
     */
    readonly decidedToday: readonly RuntimeSymbol[] | "unknown";

    /**
     * How what `decidedToday` names differs from the pseudocode, or what the
     * closest code does where the decision is `unknown`.
     */
    readonly note: string;
  }
  /** A kernel function of the pseudocode's name and shape. */
  | {
    readonly relation: "exact";

    /** The kernel file holding it, relative to this directory. */
    readonly kernelFile: string;
  }
  /** A kernel function that differs from the pseudocode in a ruled way. */
  | {
    readonly relation: "adapted";

    /** The kernel file holding it, relative to this directory. */
    readonly kernelFile: string;

    /** What differs from the pseudocode. */
    readonly reason: string;

    /** The specs pull request that ruled the difference acceptable. */
    readonly ruling: string;
  };

/** The Lean definition a row rests on, or the reason it has none. */
export type LeanCounterpart =
  /** As the coverage matrix names it: module, then definitions. */
  | { readonly lean: string }
  /** No row of the coverage matrix names this function. */
  | { readonly lean: "none"; readonly leanNote: string };

/** One critical function. */
export type ManifestRow =
  & {
    /** The chapter file, e.g. `08-12-store-label-monotonicity.md`. */
    readonly file: string;

    /** The section whose pseudocode block defines it. */
    readonly section: string;

    /** The function's name as the block declares it. */
    readonly name: string;
  }
  & LeanCounterpart
  & ManifestRelation;

/**
 * A function a critical function's section also defines, which is not a row
 * of its own: a helper the critical function calls, or a function that
 * section states for another audience.
 */
export interface Companion {
  /** The chapter file. */
  readonly file: string;

  /** The section whose block defines it. */
  readonly section: string;

  /** The function's name. */
  readonly name: string;

  /** Why it is not a row. */
  readonly note: string;
}

const CORE = "03-core-concepts.md";
const LABELS = "04-label-representation.md";
const PROPAGATION = "08-09-runtime-label-propagation.md";
const BOUNDARIES = "08-10-validation-at-boundaries.md";
const STORE = "08-12-store-label-monotonicity.md";
const WRITE_AUTHORITY = "08-15-write-authority.md";

const PREPARE = "cfc/prepare.ts";

/**
 * Every critical function, grouped by the chapter that states it, in the
 * order the kernel takes them: the store-label comparison, the label
 * algebra, exchange, the boundary checks, propagation, label-metadata
 * inspection, and write authority.
 */
export const MANIFEST: readonly ManifestRow[] = [
  {
    file: STORE,
    section: "8.12.1",
    name: "atomLe",
    lean: "`Cfc/Store.lean`: `atomLeB`",
    relation: "missing",
    decidedToday: [
      { file: "cfc/atom-pattern.ts", symbol: "atomEntails" },
      { file: "cfc/clause.ts", symbol: "personalSpaceOwnerAsReader" },
    ],
    note: "`atomEntails` is structural equality with the `Expires` " +
      "ordering, and also lets a plaintext atom entail its committed digest " +
      "form; `personalSpaceOwnerAsReader` lets a `PersonalSpace(owner)` " +
      "alternative answer one naming the owner, which the pseudocode lacks",
  },
  {
    file: STORE,
    section: "8.12.1",
    name: "isMoreRestrictiveCNF",
    lean: "`Cfc/Store.lean`: `confLeB`, `clauseLeB`",
    relation: "missing",
    decidedToday: [
      {
        file: "cfc/declared-monotonicity.ts",
        symbol: "collectDeclaredMonotonicityViolations",
      },
      { file: "cfc/clause.ts", symbol: "clauseSubsumes" },
    ],
    note: "the confidentiality loop of the first asks `clauseSubsumes` for a " +
      "witness per stored clause; a route-2b exemption keyed by canonical " +
      "clause digest can excuse one stored clause",
  },
  {
    file: STORE,
    section: "8.12.1",
    name: "canUpdateStoreLabel",
    lean: "`Cfc/Store.lean`: `canUpdateStoreLabel(B)`, `groupJoin`, " +
      "`canUpdateStoreLabelGroup(B)`",
    relation: "missing",
    decidedToday: [
      {
        file: "cfc/declared-monotonicity.ts",
        symbol: "collectDeclaredMonotonicityViolations",
      },
    ],
    note: "covers declared entries on both sides, joined per path; the " +
      "integrity subset is decided by structural equality of atoms",
  },
  {
    file: CORE,
    section: "3.1.7",
    name: "joinLabels",
    lean: "none",
    leanNote: "the coverage matrix has no §3.1 row; `Cfc/Label.lean` " +
      "defines `Label.join` and `Label.joinIntegrity` outside the matrix",
    relation: "missing",
    decidedToday: [
      { file: PREPARE, symbol: "joinLabels" },
      { file: PREPARE, symbol: "mergeLabels" },
      { file: "cfc/label-view-core.ts", symbol: "mergeLabel" },
      {
        file: "cfc/observation.ts",
        symbol: "joinCfcObservedConfidentiality",
      },
    ],
    note: "each concatenates and deduplicates confidentiality clauses; the " +
      "integrity side is a plain union in `prepare.ts` and the class-aware " +
      "meet exists only inside `deriveFlowJoin`",
  },
  {
    file: CORE,
    section: "3.1.4",
    name: "canAccess",
    lean: "none",
    leanNote: "the coverage matrix has no §3.1 row; `Cfc/Access.lean` " +
      "defines `canAccessConf` and `canAccess` outside the matrix",
    relation: "missing",
    decidedToday: "unknown",
    note: "no principal-satisfies-every-clause check exists; the closest " +
      "is the ceiling fit, `cfcObservationFitsCeiling` and " +
      "`atomsOutsideCeiling` in `cfc/observation.ts`, which expresses a " +
      "reader as a ceiling and asks `clauseSubsumes` per label clause",
  },
  {
    file: LABELS,
    section: "4.3.4",
    name: "matchRuleWithBindings",
    lean: "none",
    leanNote: "the coverage matrix has no §4.3.4 row; `Cfc/Policy.lean` " +
      "matches rules with variable bindings (`Policy.matchRuleMode`) " +
      "outside the matrix",
    relation: "missing",
    decidedToday: [
      { file: "cfc/exchange-eval.ts", symbol: "matchRule" },
      { file: "cfc/atom-pattern.ts", symbol: "matchAtomPattern" },
    ],
    note: "returns every consistent environment per target clause and " +
      "alternative; concept guards consult the trust resolver, and the " +
      "match is restricted to a policy's home clauses",
  },
  {
    file: LABELS,
    section: "4.4.5",
    name: "applyExchangeRule",
    lean: "none",
    leanNote: "the coverage matrix has no §4.4.5 row; `Cfc/Exchange.lean` " +
      "and `Cfc/Policy.lean` model exchange outside the matrix",
    relation: "missing",
    decidedToday: [
      { file: "cfc/exchange-eval.ts", symbol: "applyRuleMatch" },
    ],
    note: "adds instantiated alternatives or drops the matched one; the " +
      "pseudocode's integrity postcondition has no counterpart, since the " +
      "evaluator never modifies integrity",
  },
  {
    file: LABELS,
    section: "4.4.5",
    name: "evaluateExchangeRules",
    lean: "none",
    leanNote: "the coverage matrix has no §4.4.5 row; `Cfc/Policy.lean` " +
      "holds the evaluator outside the matrix",
    relation: "missing",
    decidedToday: [
      { file: "cfc/exchange-eval.ts", symbol: "evaluateExchangeRules" },
    ],
    note: "runs the selected module policies' rules to a fixpoint under " +
      "`DEFAULT_EXCHANGE_FUEL`, returning the original label flagged " +
      "`exhausted` when fuel runs out",
  },
  {
    file: BOUNDARIES,
    section: "8.10.3",
    name: "pathsOverlap",
    lean: "`Cfc/Boundary/Core.lean`: read coverage",
    relation: "missing",
    decidedToday: [
      { file: PREPARE, symbol: "pathsOverlap" },
      { file: PREPARE, symbol: "pathPatternsOverlap" },
      { file: "cfc/label-view-core.ts", symbol: "cfcLabelPathsOverlap" },
    ],
    note: "the same ancestor-or-equal test, wildcard-aware; none of them " +
      "selects a requirement's consumed reads, which the runtime selects " +
      "by journal order instead",
  },
  {
    file: BOUNDARIES,
    section: "8.10.3",
    name: "collectConsumedLabelsOverlapping",
    lean: "`Cfc/Boundary/Core.lean`: read coverage",
    relation: "missing",
    decidedToday: "unknown",
    note: "no path-overlap selection exists; `verifyInputRequirements` in " +
      "`cfc/prepare.ts` gates every non-internal read before the last " +
      "write overlapping the entry path (`buildWritePrefixBounds`), and " +
      "path overlap enters only through each read's own label resolution",
  },
  {
    file: BOUNDARIES,
    section: "8.10.3",
    name: "resolveCeiling",
    lean: "`Cfc/InputCeiling.lean`: declaration resolution",
    relation: "missing",
    decidedToday: "unknown",
    note: "`verifyInputRequirements` in `cfc/prepare.ts` reads " +
      "`ifc.maxConfidentiality` as written, with no binding instantiation " +
      "and no ambiguity check; `instantiateAtomPattern` in " +
      "`cfc/atom-pattern.ts` is the generic instantiation",
  },
  {
    file: BOUNDARIES,
    section: "8.10.3",
    name: "verifyRequiredIntegrityCoherent",
    lean: "`Cfc/Boundary/Core.lean`: coherent input gate; " +
      "`Cfc/InputRequirements.lean`: integrity witness matching",
    relation: "missing",
    decidedToday: [
      {
        file: "cfc/observation.ts",
        symbol: "cfcIntegritySatisfiesFloorCoherently",
      },
      { file: "cfc/observation.ts", symbol: "cfcIntegrityWitnessKey" },
    ],
    note: "keys witnesses with `scope.projection` dropped as the pseudocode " +
      "does; makes no binding-ambiguity check, and an empty consumed set " +
      "passes vacuously",
  },
  {
    file: BOUNDARIES,
    section: "8.10.3",
    name: "verifyInputRequirements",
    lean: "`Cfc/InputCeiling.lean`: CNF checking; `Cfc/Boundary/Core.lean`: " +
      "optional declarations, read coverage, coherent input gate",
    relation: "missing",
    decidedToday: [
      { file: PREPARE, symbol: "verifyInputRequirements" },
    ],
    note: "walks the write target's schema entries rather than an input " +
      "schema, takes the transaction and per-write prefix bounds in place " +
      "of the pseudocode's consumed reads and labels, and returns a " +
      "tagged refusal reason rather than a boolean",
  },
  {
    file: BOUNDARIES,
    section: "8.10.1.1",
    name: "canonicalizeBoundaryActivity",
    lean: "`Cfc/Boundary.lean`: `canonicalizeBoundaryActivity`, `Activity`, " +
      "`InvocationJournal`, `attemptOfJournal`",
    relation: "missing",
    decidedToday: [
      { file: "cfc/canonical.ts", symbol: "canonicalizeDocumentPath" },
      { file: "cfc/canonical.ts", symbol: "canonicalizePreparedDigestInput" },
      {
        file: "storage/extended-storage-transaction.ts",
        symbol: "ExtendedStorageTransaction",
      },
    ],
    note: "the transaction's `buildPreparedDigestInput()` assembles the " +
      "record and drops internal verifier reads where the pseudocode keeps " +
      "them marked; `canonical.ts` strips `/value` and separates envelope " +
      "metadata paths",
  },
  {
    file: BOUNDARIES,
    section: "8.10.2",
    name: "verifyTransition",
    lean: "`Cfc/Boundary.lean`: `verifyTransitionB`; " +
      "`Cfc/Boundary/ConcreteRelease.lean`: `verifyObservedValueTransitionB`, " +
      "`verifyConcreteTransitionB`",
    relation: "missing",
    decidedToday: [
      { file: PREPARE, symbol: "verifyExactCopyRequirements" },
      { file: PREPARE, symbol: "verifyProjectionRequirements" },
      { file: PREPARE, symbol: "unsupportedTrustSensitiveReason" },
    ],
    note: "exact copy and projection are verified; collection, opaque, " +
      "pass-through, recomposition, combination, transformation and added " +
      "integrity are refused; output confidentiality is derived rather " +
      "than checked monotone",
  },
  {
    file: BOUNDARIES,
    section: "8.10.4",
    name: "verifyIntegrityBinding",
    lean: "`Cfc/IntegrityBinding.lean`: `verifyIntegrityBindingB`",
    relation: "missing",
    decidedToday: "unknown",
    note: "nothing resolves `scope.valueRef` against the value; " +
      "`atomPropagationClass` in `cfc/atom-classes.ts` drops value-bound " +
      "atoms through default transforms, and `reconcileMintedEntries` in " +
      "`cfc/minted-integrity.ts` withdraws schema-minted stamps when the " +
      "value at the path changes",
  },
  {
    file: PROPAGATION,
    section: "8.9.2",
    name: "propagateLabels",
    lean: "`Cfc/LabelTransitions.lean`; `Cfc/Boundary.lean`: " +
      "`derivedOutputs?`, `verifyObservedValueTransitionB`, " +
      "`verifyConcreteTransitionB`",
    relation: "missing",
    decidedToday: [
      { file: PREPARE, symbol: "deriveFlowJoin" },
      { file: PREPARE, symbol: "derivePersistedLabel" },
    ],
    note: "one per-transaction join is stamped on every written path as a " +
      "derived entry; declared, exact-copy and projection labels are " +
      "derived per path, and the other annotations are refused",
  },
  {
    file: PROPAGATION,
    section: "8.9.2",
    name: "taintPc",
    lean: "none",
    leanNote: "the coverage matrix's §8.9 row names `propagateLabels` " +
      "alone; `taintPc` theorems (`taintPc_conf_subset`, " +
      "`ConfLe_taintPc_triggers`) are listed outside the matrix",
    relation: "missing",
    decidedToday: "unknown",
    note: "no separate PC is kept; the conservative PC is the join of " +
      "every transaction observation inside `deriveFlowJoin` in " +
      "`cfc/prepare.ts`, with trigger reads added by `triggerReadSources`",
  },
  {
    file: PROPAGATION,
    section: "8.9.3",
    name: "deriveTransformedLabel",
    lean: "none",
    leanNote: "the coverage matrix's §8.9 row names `propagateLabels` " +
      "alone; `Cfc/LabelTransitions.lean` holds " +
      "`LabelTransition.hereditaryCommonIntegrity` outside the matrix",
    relation: "missing",
    decidedToday: [
      { file: PREPARE, symbol: "deriveFlowJoin" },
      { file: "cfc/input-witness.ts", symbol: "mintTransformedBy" },
      { file: "cfc/atom-classes.ts", symbol: "atomPropagationClass" },
    ],
    note: "the confidentiality union, the hereditary meet by propagation " +
      "class, and a `TransformedBy` summary atom carrying an input witness " +
      "in place of the pseudocode's `inputs` array",
  },
  {
    file: LABELS,
    section: "4.6.4.1",
    name: "inspectConfLabel",
    lean: "`Cfc/LabelMetadata.lean`: `inspectConfLabel`, " +
      "`PayloadConfLabelMetadataView`, `ConfLabelQuery`",
    relation: "missing",
    decidedToday: [
      {
        file: "cfc/label-introspection.ts",
        symbol: "inspectStoredConfLabel",
      },
      {
        file: "cfc/label-introspection.ts",
        symbol: "evaluateConfLabelQuery",
      },
    ],
    note: "`evaluateConfLabelQuery` is the pure evaluator; " +
      "`inspectStoredConfLabel` reads the envelope, degrades to " +
      "not-available under the fail-closed dial, and records the " +
      "label-metadata observation",
  },
  {
    file: WRITE_AUTHORITY,
    section: "8.15.6",
    name: "authorizeWrite",
    lean: "none",
    leanNote: "the coverage matrix has no §8.15 row; " +
      "`Cfc/WriteAuthority.lean` models `writeAuthorizedBy` outside the " +
      "matrix",
    relation: "missing",
    decidedToday: [
      { file: PREPARE, symbol: "writeAuthorizedByReason" },
      { file: PREPARE, symbol: "writePolicyAnyOfReason" },
    ],
    note: "accepts a builtin id or a module identity with a matching " +
      "binding path, and exempts setup initialization, runtime " +
      "initialization and owner adoption, none of which the pseudocode " +
      "states",
  },
];

/**
 * Functions defined beside a critical function that are not rows. Each is
 * held to the snapshot the way a row is: the section it names must define it.
 */
export const COMPANIONS: readonly Companion[] = [
  {
    file: LABELS,
    section: "4.3.4",
    name: "applyRuleWithAllBindings",
    note: "helper of `matchRuleWithBindings`, applying one rule under every " +
      "binding the match produced",
  },
  {
    file: LABELS,
    section: "4.3.4",
    name: "firingBindings",
    note: "helper of `matchRuleWithBindings`, selecting the bindings under " +
      "which a rule fires",
  },
  {
    file: LABELS,
    section: "4.4.5",
    name: "substituteVars",
    note: "helper of `applyExchangeRule`, substituting a binding into an " +
      "atom pattern",
  },
  {
    file: LABELS,
    section: "4.4.5",
    name: "instantiate",
    note: "helper of `applyExchangeRule`, instantiating a rule's atoms " +
      "under a binding",
  },
  {
    file: LABELS,
    section: "4.4.5",
    name: "canAccess",
    note: "the §3.1.4 access check restated in that section's worked " +
      "example; the row is the §3.1.4 definition",
  },
  {
    file: LABELS,
    section: "4.4.5",
    name: "makePrincipal",
    note: "a constructor of the worked example's principal, not a decision",
  },
  {
    file: PROPAGATION,
    section: "8.9.3",
    name: "concatClauses",
    note: "helper of `deriveTransformedLabel`, joining confidentiality by " +
      "clause concatenation",
  },
  {
    file: PROPAGATION,
    section: "8.9.3",
    name: "intersectAtoms",
    note: "helper of `deriveTransformedLabel`, meeting integrity by atom " +
      "intersection",
  },
  {
    file: BOUNDARIES,
    section: "8.10.3",
    name: "witnessKeyForRequiredMatch",
    note: "helper of `verifyRequiredIntegrityCoherent`, keying a required " +
      "pattern's witness",
  },
  {
    file: BOUNDARIES,
    section: "8.10.3",
    name: "isPathAtOrBelow",
    note: "helper of `pathsOverlap`, the one-sided prefix test",
  },
];
