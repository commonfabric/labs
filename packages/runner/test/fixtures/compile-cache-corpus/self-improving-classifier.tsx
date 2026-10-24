/**
 * Self-Improving Classifier
 *
 * A binary classifier that uses LLMs for judgment calls but progressively
 * crystallizes intelligence into efficient regex rules. Implements the
 * "self-hoisting feedback loop" pattern for compounding quality improvements.
 *
 * Key features:
 * - LLM classifies from the start, auto-accumulating examples
 * - User corrections are tracked specially for learning
 * - Regex rules with precision-weighted voting (Phase 2)
 * - LLM-generated rule suggestions (Phase 3)
 * - Per-rule confidence tiers (Phase 4)
 */
import {
  computed,
  type Default,
  equals,
  generateObject,
  handler,
  ifElse,
  lift,
  NAME,
  pattern,
  Stream,
  toIndentedDebugString,
  UI,
  Writable,
} from "commonfabric";

// =============================================================================
// TYPES
// =============================================================================

/** Confidence tiers from the self-hoisting essay */
type Tier = 0 | 1 | 2 | 3 | 4;

/** Input to classify - generic key-value structure */
export interface ClassifiableInput {
  id: string;
  receivedAt: number;
  fields: Record<string, string>;
}

/** Full audit trail for labeled examples */
export interface LabeledExample {
  input: ClassifiableInput;
  label: boolean;
  decidedBy: "user" | "auto" | "suggestion-accepted";
  reasoning: string;
  confidence: number;
  labeledAt: number;
  wasCorrection: boolean;
  originalPrediction?: boolean;
  isInteresting: boolean;
  interestingReason?: string;
}

/** A regex-based classification rule */
export interface ClassificationRule {
  id: string;
  name: string;
  targetField: string;
  pattern: string;
  caseInsensitive: boolean;
  predicts: boolean;
  precision: number;
  recall: number;
  tier: Tier;
  evaluationCount: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  createdAt: number;
  // NOTE: isShared/sharedFrom are planned for cross-classifier rule sharing.
  // When implemented, users will be able to share high-performing rules
  // between classifiers and track rule provenance.
  isShared: boolean;
  sharedFrom?: string;
}

/** User configuration */
interface ClassifierConfig {
  question: string;
  minExamplesForRules: number;
  autoClassifyThreshold: number;
  prefillThreshold: number;
  suggestionThreshold: number;
  // NOTE: harmAsymmetry is planned for asymmetric error weighting -
  // "fp" penalizes false positives more, "fn" penalizes false negatives more.
  // Not yet implemented - will affect confidence thresholds and tier promotion.
  harmAsymmetry: "fp" | "fn" | "equal";
  enableLLMFallback: boolean;
}

/** LLM classification response */
interface LLMClassificationResult {
  itemId: string;
  classification: boolean;
  confidence: number;
  reasoning: string;
}

/** Rule suggestion from LLM */
export interface RuleSuggestion {
  name: string;
  targetField: string;
  pattern: string;
  predicts: boolean;
  reasoning: string;
}

/** Classification result for an item */
export interface ClassificationResult {
  inputId: string;
  classification: boolean;
  confidence: number;
  reasoning: string;
  decidedBy: "rules" | "llm" | "user";
  matchedRules: string[];
}

/** Pending item awaiting user confirmation */
export interface PendingClassification {
  input: ClassifiableInput;
  result: ClassificationResult;
}

// =============================================================================
// DEFAULT CONFIG
// =============================================================================

const DEFAULT_CONFIG: ClassifierConfig = {
  question: "",
  minExamplesForRules: 5,
  autoClassifyThreshold: 0.85,
  prefillThreshold: 0.70,
  suggestionThreshold: 0.50,
  harmAsymmetry: "equal",
  enableLLMFallback: true,
};

// =============================================================================
// PATTERN INPUT/OUTPUT
// =============================================================================

interface ClassifierInput {
  config: Writable<ClassifierConfig | Default<typeof DEFAULT_CONFIG>>;
  examples: Writable<LabeledExample[] | Default<[]>>;
  rules: Writable<ClassificationRule[] | Default<[]>>;
  // NOTE: pendingClassifications is reserved for future batch processing API.
  // Currently items flow through currentItem → LLM → user confirmation → examples.
  // External systems could use this queue for bulk submissions in the future.
  pendingClassifications: Writable<PendingClassification[] | Default<[]>>;
  // The item currently being classified (null when idle)
  // Only one item can be classified at a time
  currentItem: Writable<ClassifiableInput | null | Default<null>>;
}

/** Self-improving binary classifier with LLM + regex rules. #classifier #learning */
export interface ClassifierOutput {
  config: ClassifierConfig;
  examples: LabeledExample[];
  rules: ClassificationRule[];
  pendingClassifications: PendingClassification[];
  stats: {
    totalExamples: number;
    positiveExamples: number;
    negativeExamples: number;
    autoClassified: number;
    correctionRate: number;
    totalRules: number;
  };
  submitItem: Stream<{ fields: Record<string, string> }>;
  confirmClassification: Stream<{ inputId: string }>;
  correctClassification: Stream<
    { inputId: string; correctLabel: boolean; reasoning?: string }
  >;
  dismissClassification: Stream<{ inputId: string }>;
  addRule: Stream<RuleSuggestion>;
  removeRule: Stream<{ ruleId: string }>;
}

/** Item that was auto-classified (tracked for undo functionality) */
interface AutoClassifiedItem {
  input: ClassifiableInput;
  label: boolean;
  confidence: number;
  reasoning: string;
  matchedRules: string[];
  tier: Tier;
  classifiedAt: number;
}

// =============================================================================
// REGEX SAFETY
// =============================================================================

/**
 * Maximum length for regex patterns to prevent ReDoS attacks.
 * Patterns longer than this are rejected.
 */
const REGEX_MAX_PATTERN_LENGTH = 500;

/**
 * Check if a regex pattern is potentially dangerous (ReDoS).
 * This is a heuristic check for common catastrophic backtracking patterns.
 * Returns true if the pattern appears safe, false if potentially dangerous.
 */
function isRegexSafe(pattern: string): boolean {
  // Reject overly long patterns
  if (pattern.length > REGEX_MAX_PATTERN_LENGTH) {
    return false;
  }

  // Check for nested quantifiers which can cause catastrophic backtracking
  // Patterns like (a+)+, (.*)+, (a*)*
  const nestedQuantifiers = /\([^)]*[+*][^)]*\)[+*]|\([^)]*\)[+*][+*]/;
  if (nestedQuantifiers.test(pattern)) {
    return false;
  }

  // Check for overlapping alternatives with quantifiers
  // Patterns like (a|a)+, (ab|abc)+
  const overlappingAlts = /\([^)]*\|[^)]*\)[+*]{2,}/;
  if (overlappingAlts.test(pattern)) {
    return false;
  }

  return true;
}

/**
 * Compile a regex after validation.
 * Returns null for invalid or potentially dangerous regex patterns.
 */
function getCachedRegex(
  pattern: string,
  caseInsensitive: boolean,
): RegExp | null {
  // Check for potentially dangerous patterns (ReDoS prevention)
  if (!isRegexSafe(pattern)) {
    console.warn(
      `[Classifier] Rejecting potentially dangerous regex pattern: "${pattern}"`,
    );
    return null;
  }

  try {
    const flags = caseInsensitive ? "i" : "";
    return new RegExp(pattern, flags);
  } catch (e) {
    // Log invalid regex pattern for debugging
    console.warn(
      `[Classifier] Invalid regex pattern "${pattern}": ${
        e instanceof Error ? e.message : "Unknown error"
      }`,
    );
    return null;
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/** Generate a unique ID */
function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

/** Validate a regex pattern and return validation result */
function isValidRegex(pattern: string): { valid: boolean; error?: string } {
  try {
    new RegExp(pattern);
    return { valid: true };
  } catch (e) {
    return {
      valid: false,
      error: e instanceof Error ? e.message : "Invalid regex",
    };
  }
}

/** Validate a rule suggestion has valid structure */
function isValidRuleSuggestion(s: unknown): s is RuleSuggestion {
  if (!s || typeof s !== "object") return false;
  const suggestion = s as Record<string, unknown>;
  return (
    typeof suggestion.name === "string" &&
    suggestion.name.trim() !== "" &&
    typeof suggestion.targetField === "string" &&
    suggestion.targetField.trim() !== "" &&
    typeof suggestion.pattern === "string" &&
    suggestion.pattern.trim() !== "" &&
    typeof suggestion.predicts === "boolean" &&
    typeof suggestion.reasoning === "string" &&
    suggestion.reasoning.trim() !== ""
  );
}

/** Compute statistics from examples */
const computeStats = lift((args: {
  examples: LabeledExample[];
  rules: ClassificationRule[];
}): {
  totalExamples: number;
  positiveExamples: number;
  negativeExamples: number;
  autoClassified: number;
  correctionRate: number;
  totalRules: number;
} => {
  const { examples, rules } = args;

  // Single-pass computation for O(n) instead of O(4n)
  // Filter out any undefined/null entries that might exist in the array
  const counts = examples.reduce(
    (acc, e) => {
      if (!e) return acc; // Skip undefined/null entries
      if (e.label) acc.positive++;
      else acc.negative++;
      if (e.decidedBy === "auto") acc.auto++;
      if (e.wasCorrection) acc.corrections++;
      return acc;
    },
    { positive: 0, negative: 0, auto: 0, corrections: 0 },
  );

  const correctionRate = counts.auto > 0 ? counts.corrections / counts.auto : 0;

  return {
    totalExamples: examples.length,
    positiveExamples: counts.positive,
    negativeExamples: counts.negative,
    autoClassified: counts.auto,
    correctionRate,
    totalRules: rules.length,
  };
});

/**
 * Calculate F1 score for a rule based on its metrics
 * F1 = 2 * (precision * recall) / (precision + recall)
 */
function calculateF1(rule: ClassificationRule | undefined): number {
  if (!rule) return 0;
  const precision = rule.precision ?? 0;
  const recall = rule.recall ?? 0;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Calculate precision and recall from confusion matrix metrics.
 * Precision = TP / (TP + FP) - how often the rule is correct when it fires
 * Recall = TP / (TP + FN) - how often the rule fires when it should
 *
 * For a rule that "predicts: true":
 * - TP: rule matched AND actual was true
 * - FP: rule matched AND actual was false
 * - TN: rule didn't match AND actual was false
 * - FN: rule didn't match AND actual was true
 *
 * For a rule that "predicts: false":
 * - TP: rule matched AND actual was false
 * - FP: rule matched AND actual was true
 * - TN: rule didn't match AND actual was true
 * - FN: rule didn't match AND actual was false
 */
function calculatePrecisionRecall(rule: {
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
}): { precision: number; recall: number } {
  const tp = rule.truePositives || 0;
  const fp = rule.falsePositives || 0;
  const fn = rule.falseNegatives || 0;

  // Precision: TP / (TP + FP)
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0.5;

  // Recall: TP / (TP + FN)
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0.5;

  return { precision, recall };
}

/**
 * Determine what tier a rule should be at based on its metrics
 *
 * Tier thresholds (from self-hoisting essay):
 * - Tier 0: Silent (no predictions) - default
 * - Tier 1: Suggestions (user can accept) - F1 >= 0.5, 3+ evals
 * - Tier 2: Default (pre-filled) - F1 >= 0.7, 5+ evals
 * - Tier 3: Self-driving (auto with undo) - F1 >= 0.85, 10+ evals
 * - Tier 4: Automatic (fully auto) - F1 >= 0.95, 20+ evals
 */
function _calculateTier(rule: ClassificationRule): Tier {
  const f1 = calculateF1(rule);
  const evals = rule.evaluationCount;

  if (evals >= 20 && f1 >= 0.95) return 4;
  if (evals >= 10 && f1 >= 0.85) return 3;
  if (evals >= 5 && f1 >= 0.70) return 2;
  if (evals >= 3 && f1 >= 0.50) return 1;
  return 0;
}

/**
 * Get human-readable tier label
 */
function getTierLabel(tier: Tier | undefined): string {
  switch (tier) {
    case 0:
      return "Silent";
    case 1:
      return "Suggest";
    case 2:
      return "Default";
    case 3:
      return "Auto+Undo";
    case 4:
      return "Automatic";
    default:
      return "Silent";
  }
}

/**
 * Get tier badge color
 */
function getTierColor(tier: Tier | undefined): string {
  switch (tier) {
    case 0:
    default:
      return "var(--cf-colors-gray-400)";
    case 1:
      return "var(--cf-colors-info)";
    case 2:
      return "var(--cf-theme-color-success)";
    case 3:
      return "var(--cf-theme-color-warning)";
    case 4:
      return "var(--cf-theme-color-error)";
  }
}

/**
 * Result of matching rules against an input
 */
interface RuleMatchResult {
  matchedRules: string[];
  prediction: boolean | null;
  confidence: number;
  highestTier: Tier;
  shouldAutoClassify: boolean;
  votes: Array<{
    name: string;
    predicts: boolean;
    precision: number;
    tier: Tier;
  }>;
}

/**
 * Match rules against an input and return the aggregated result
 */
function matchRulesAgainstInput(
  input: ClassifiableInput,
  rules: readonly ClassificationRule[],
  autoClassifyThreshold: number,
): RuleMatchResult {
  const matchedRules: string[] = [];
  const votes: RuleMatchResult["votes"] = [];

  for (const rule of rules) {
    const fieldValue = input.fields[rule.targetField];
    if (!fieldValue) continue;

    const regex = getCachedRegex(rule.pattern, rule.caseInsensitive);
    if (regex && regex.test(fieldValue)) {
      matchedRules.push(rule.name);
      votes.push({
        name: rule.name,
        predicts: rule.predicts,
        precision: rule.precision,
        tier: rule.tier,
      });
    }
  }

  // Precision-weighted voting
  let yesWeight = 0;
  let noWeight = 0;
  let highestTier: Tier = 0;

  for (const vote of votes) {
    if (vote.predicts) {
      yesWeight += vote.precision;
    } else {
      noWeight += vote.precision;
    }
    if (vote.tier > highestTier) {
      highestTier = vote.tier;
    }
  }

  // Determine prediction
  let prediction: boolean | null = null;
  let confidence = 0;

  if (votes.length > 0) {
    const totalWeight = yesWeight + noWeight;
    if (yesWeight > noWeight) {
      prediction = true;
      confidence = totalWeight > 0 ? yesWeight / totalWeight : 0.5;
    } else if (noWeight > yesWeight) {
      prediction = false;
      confidence = totalWeight > 0 ? noWeight / totalWeight : 0.5;
    } else {
      // Tie - use the higher tier rule's prediction
      const highestTierVote = votes.reduce((a, b) => a.tier > b.tier ? a : b);
      prediction = highestTierVote.predicts;
      confidence = 0.5;
    }
  }

  // Determine if we should auto-classify (Tier 3-4 with high confidence)
  const shouldAutoClassify = prediction !== null &&
    highestTier >= 3 &&
    confidence >= autoClassifyThreshold;

  return {
    matchedRules,
    prediction,
    confidence,
    highestTier,
    shouldAutoClassify,
    votes,
  };
}

// =============================================================================
// LIFT FUNCTIONS FOR REACTIVE .map() DISPLAY
// These need lift() because they're used inside .map() with reactive proxies
// =============================================================================

/** Extract field key - simple property access wrapped for reactivity */
const getFieldKey = lift(
  (entry: { key: string; value: string }): string => entry.key,
);

/** Extract field value - simple property access wrapped for reactivity */
const getFieldValue = lift(
  (entry: { key: string; value: string }): string => entry.value,
);

/** Format example preview - truncates first field value for compact display */
const getExamplePreview = lift((example: LabeledExample): string => {
  if (!example?.input?.fields) return "(invalid)";
  const entries = Object.entries(example.input.fields);
  const first = entries[0];
  return first ? `${first[0]}: ${first[1].substring(0, 30)}...` : "(empty)";
});

/** Extract decidedBy label - simple property access wrapped for reactivity */
const getExampleDecidedBy = lift(
  (example: LabeledExample): string => example?.decidedBy ?? "unknown",
);

/** Remove a field from the newItemFields record */
const removeFieldHandler = handler<
  unknown,
  {
    entry: { key: string; value: string };
    newItemFields: Writable<Record<string, string>>;
  }
>((_event, { entry, newItemFields }) => {
  const current = newItemFields.get();
  const updated = { ...current };
  delete updated[entry.key];
  newItemFields.set(updated);
});

/** Update a field value in the newItemFields record */
const updateFieldHandler = handler<
  { detail?: { value?: string } },
  {
    fieldKey: string;
    newItemFields: Writable<Record<string, string>>;
  }
>((event, { fieldKey, newItemFields }) => {
  const value = event.detail?.value ?? "";
  newItemFields.update({ [fieldKey]: value });
});

// =============================================================================
// MODULE-SCOPED HANDLERS FOR BUTTON CLICKS IN .map()
// These handlers receive the pending item as a parameter at render time (in reactive context)
// so they don't need to access reactive proxies in the callback.
// Uses equals() for idiomatic cell reference comparison.
// =============================================================================

/** Confirm a pending classification (user agrees with the prediction) */
const confirmPendingClassification = handler<
  unknown,
  {
    pending: PendingClassification;
    examples: Writable<LabeledExample[]>;
    pendingClassifications: Writable<PendingClassification[]>;
  }
>((_event, { pending, examples, pendingClassifications }) => {
  const pendingList = pendingClassifications.get();
  const idx = pendingList.findIndex((p) => equals(pending, p));
  if (idx < 0) return;

  const item = pendingList[idx];
  const result = item.result;

  // Spread to create plain objects (breaks proxy chain)
  examples.push({
    input: { ...item.input, fields: { ...item.input.fields } },
    label: result.classification,
    decidedBy: "suggestion-accepted",
    reasoning: result.reasoning,
    confidence: result.confidence,
    labeledAt: Date.now(),
    wasCorrection: false,
    isInteresting: result.confidence < 0.7,
    interestingReason: result.confidence < 0.7
      ? "Low confidence, user confirmed"
      : undefined,
  });
  pendingClassifications.set(
    pendingList.filter((p) => !equals(pending, p)),
  );
});

/** Correct a pending classification (user disagrees with the prediction) */
const correctPendingClassification = handler<
  unknown,
  {
    pending: PendingClassification;
    examples: Writable<LabeledExample[]>;
    pendingClassifications: Writable<PendingClassification[]>;
  }
>((_event, { pending, examples, pendingClassifications }) => {
  const pendingList = pendingClassifications.get();
  const idx = pendingList.findIndex((p) => equals(pending, p));
  if (idx < 0) return;

  const item = pendingList[idx];
  const correctLabel = !item.result.classification;

  // Spread to create plain objects (breaks proxy chain)
  examples.push({
    input: { ...item.input, fields: { ...item.input.fields } },
    label: correctLabel,
    decidedBy: "user",
    reasoning: "User correction",
    confidence: 1.0,
    labeledAt: Date.now(),
    wasCorrection: true,
    originalPrediction: item.result.classification,
    isInteresting: true,
    interestingReason: "User corrected classification",
  });
  pendingClassifications.set(
    pendingList.filter((p) => !equals(pending, p)),
  );
});

/** Dismiss a pending classification without recording it */
const dismissPendingClassification = handler<
  unknown,
  {
    pending: PendingClassification;
    pendingClassifications: Writable<PendingClassification[]>;
  }
>((_event, { pending, pendingClassifications }) => {
  const pendingList = pendingClassifications.get();
  pendingClassifications.set(
    pendingList.filter((p) => !equals(pending, p)),
  );
});

/** Remove a rule from the rules list */
const removeRuleHandler = handler<
  unknown,
  {
    rule: ClassificationRule;
    rules: Writable<ClassificationRule[]>;
  }
>((_event, { rule, rules }) => {
  const currentRules = rules.get();
  rules.set(currentRules.filter((r) => !equals(rule, r)));
});

/** Toggle example selection for expanded details view */
const toggleExampleSelectionHandler = handler<
  unknown,
  {
    example: LabeledExample;
    selectedExampleId: Writable<string | null>;
  }
>((_event, { example, selectedExampleId }) => {
  const currentSelected = selectedExampleId.get();
  const exampleId = example?.input?.id;
  if (!exampleId) return;

  // Toggle: if already selected, deselect; otherwise select this one
  if (currentSelected === exampleId) {
    selectedExampleId.set(null);
  } else {
    selectedExampleId.set(exampleId);
  }
});

/** Remove an example from the examples list */
const removeExampleHandler = handler<
  unknown,
  {
    example: LabeledExample;
    examples: Writable<LabeledExample[]>;
    selectedExampleId: Writable<string | null>;
  }
>((_event, { example, examples, selectedExampleId }) => {
  const examplesList = examples.get();
  const exampleId = example?.input?.id;
  if (!exampleId) return;

  // Remove the example
  examples.set(examplesList.filter((ex) => ex.input.id !== exampleId));

  // Clear selection if this was the selected example
  if (selectedExampleId.get() === exampleId) {
    selectedExampleId.set(null);
  }

  console.log(`[Classifier] Removed example ${exampleId}`);
});

/** Reclassify an example - remove it and set as current item */
const reclassifyExampleHandler = handler<
  unknown,
  {
    example: LabeledExample;
    examples: Writable<LabeledExample[]>;
    currentItem: Writable<ClassifiableInput | null>;
    selectedExampleId: Writable<string | null>;
  }
>((_event, { example, examples, currentItem, selectedExampleId }) => {
  // Only allow reclassification if not already classifying something
  if (currentItem.get() !== null) {
    console.warn(
      "[Classifier] Already classifying an item, cannot reclassify",
    );
    return;
  }

  const exampleId = example?.input?.id;
  if (!exampleId) return;

  // Get the input data from the example
  const inputData = example.input;

  // Remove from examples
  const examplesList = examples.get();
  examples.set(examplesList.filter((ex) => ex.input.id !== exampleId));

  // Clear selection
  selectedExampleId.set(null);

  // Set as current item with a new ID (so it's treated as a fresh classification)
  const newInput: ClassifiableInput = {
    id: generateId(),
    receivedAt: Date.now(),
    fields: { ...inputData.fields },
  };
  currentItem.set(newInput);

  console.log(`[Classifier] Reclassifying example (new ID: ${newInput.id})`);
});

/** Undo an auto-classification (module-scoped handler) */
const undoAutoClassificationHandler = handler<
  unknown,
  {
    autoItem: AutoClassifiedItem;
    examples: Writable<LabeledExample[]>;
    rules: Writable<ClassificationRule[]>;
    recentAutoClassified: Writable<AutoClassifiedItem[]>;
    undoneAutoItem: Writable<AutoClassifiedItem | null>;
  }
>(
  (
    _event,
    { autoItem, examples, rules, recentAutoClassified, undoneAutoItem },
  ) => {
    const inputId = autoItem.input.id;

    // Remove from examples
    const examplesList = examples.get();
    examples.set(examplesList.filter((ex) => ex.input.id !== inputId));

    // Remove from recent auto-classified
    const autoItems = recentAutoClassified.get();
    recentAutoClassified.set(autoItems.filter((a) => a.input.id !== inputId));

    // Revert rule metrics and recalculate tiers (create new objects to avoid mutation)
    // This is the inverse of the logic in submitItemHandler - decrement the metrics
    // that were incremented when this item was auto-classified.
    const rulesVal = rules.get();
    const actual = autoItem.label;
    const updatedRules = rulesVal.map((rule) => {
      const ruleMatched = autoItem.matchedRules.includes(rule.name);
      const predicted = rule.predicts;

      // Calculate reverted confusion matrix values (decrement what was incremented)
      let newTP = rule.truePositives || 0;
      let newFP = rule.falsePositives || 0;
      let newTN = rule.trueNegatives || 0;
      let newFN = rule.falseNegatives || 0;

      if (ruleMatched) {
        // Rule matched - revert its prediction metric
        if (predicted === actual) {
          // TP was incremented - decrement it
          newTP = Math.max(0, newTP - 1);
        } else {
          // FP was incremented - decrement it
          newFP = Math.max(0, newFP - 1);
        }
      } else {
        // Rule didn't match - revert its non-match metric
        if (predicted === actual) {
          // FN was incremented - decrement it
          newFN = Math.max(0, newFN - 1);
        } else {
          // TN was incremented - decrement it
          newTN = Math.max(0, newTN - 1);
        }
      }

      // Recalculate precision and recall from the reverted confusion matrix
      const { precision, recall } = calculatePrecisionRecall({
        truePositives: newTP,
        falsePositives: newFP,
        trueNegatives: newTN,
        falseNegatives: newFN,
      });

      const updatedRule = {
        ...rule,
        truePositives: newTP,
        falsePositives: newFP,
        trueNegatives: newTN,
        falseNegatives: newFN,
        precision,
        recall,
        evaluationCount: Math.max(0, (rule.evaluationCount || 0) - 1),
      };
      // Recalculate tier based on reverted metrics (may demote)
      updatedRule.tier = _calculateTier(updatedRule);
      return updatedRule;
    });
    rules.set(updatedRules);

    // Set as undone item for manual review (shows rules-based result immediately)
    // Create a mutable copy to satisfy type requirements
    undoneAutoItem.set({
      input: {
        id: autoItem.input.id,
        receivedAt: autoItem.input.receivedAt,
        fields: { ...autoItem.input.fields },
      },
      label: autoItem.label,
      confidence: autoItem.confidence,
      reasoning: autoItem.reasoning,
      matchedRules: [...autoItem.matchedRules], // Mutable array copy
      tier: autoItem.tier,
      classifiedAt: autoItem.classifiedAt,
    });

    console.log(`[Classifier] Undid auto-classification for ${inputId}`);
  },
);

/** Submit an item for classification (module-scoped handler for cross-pattern invocation) */
const submitItemHandler = handler<
  { fields: Record<string, string> },
  {
    currentItem: Writable<ClassifiableInput | null>;
    rules: Writable<ClassificationRule[]>;
    config: Writable<ClassifierConfig>;
    examples: Writable<LabeledExample[]>;
    recentAutoClassified: Writable<AutoClassifiedItem[]>;
  }
>(
  (
    event,
    { currentItem, rules, config, examples, recentAutoClassified },
  ) => {
    // Only allow one item at a time - ignore if already classifying
    if (currentItem.get() !== null) {
      console.warn(
        "[Classifier] Already classifying an item, ignoring new submission",
      );
      return;
    }

    // Create the input object
    const input: ClassifiableInput = {
      id: generateId(),
      receivedAt: Date.now(),
      fields: { ...event.fields },
    };

    // Check rules first for potential auto-classification
    const rulesVal = rules.get();
    const configVal = config.get() || DEFAULT_CONFIG;
    const ruleMatch = matchRulesAgainstInput(
      input,
      rulesVal,
      configVal.autoClassifyThreshold,
    );

    if (ruleMatch.shouldAutoClassify && ruleMatch.prediction !== null) {
      // Auto-classify: store directly to examples, skip LLM
      const example: LabeledExample = {
        input,
        label: ruleMatch.prediction,
        decidedBy: "auto",
        reasoning: `Auto-classified by Tier ${ruleMatch.highestTier} rule(s): ${
          ruleMatch.matchedRules.join(", ")
        }`,
        confidence: ruleMatch.confidence,
        labeledAt: Date.now(),
        wasCorrection: false,
        isInteresting: false,
      };
      examples.push(example);

      // Track for undo UI
      const autoItem: AutoClassifiedItem = {
        input,
        label: ruleMatch.prediction,
        confidence: ruleMatch.confidence,
        reasoning: example.reasoning,
        matchedRules: ruleMatch.matchedRules,
        tier: ruleMatch.highestTier,
        classifiedAt: Date.now(),
      };
      recentAutoClassified.set(
        [autoItem, ...recentAutoClassified.get()].slice(0, 10),
      );

      // Update rule metrics and recalculate tiers (create new objects to avoid mutation)
      // For each rule that matched, update its confusion matrix based on whether
      // its individual prediction aligned with the actual outcome.
      //
      // Confusion matrix for a rule:
      // - TP: rule matched AND rule.predicts === actual
      // - FP: rule matched AND rule.predicts !== actual
      // - TN: rule didn't match AND rule.predicts !== actual (would have been correct)
      // - FN: rule didn't match AND rule.predicts === actual (missed the correct prediction)
      const actual = ruleMatch.prediction!;
      const updatedRules = rulesVal.map((rule) => {
        const ruleMatched = ruleMatch.matchedRules.includes(rule.name);
        const predicted = rule.predicts;

        // Calculate new confusion matrix values
        let newTP = rule.truePositives || 0;
        let newFP = rule.falsePositives || 0;
        let newTN = rule.trueNegatives || 0;
        let newFN = rule.falseNegatives || 0;

        if (ruleMatched) {
          // Rule matched - it made a prediction
          if (predicted === actual) {
            // Rule predicted correctly
            newTP += 1;
          } else {
            // Rule predicted incorrectly
            newFP += 1;
          }
        } else {
          // Rule didn't match - it "predicted" the opposite of rule.predicts
          // (by not firing, a rule that predicts:true implies false, and vice versa)
          if (predicted === actual) {
            // Rule should have fired but didn't - it missed
            newFN += 1;
          } else {
            // Rule correctly didn't fire
            newTN += 1;
          }
        }

        // Recalculate precision and recall from the updated confusion matrix
        const { precision, recall } = calculatePrecisionRecall({
          truePositives: newTP,
          falsePositives: newFP,
          trueNegatives: newTN,
          falseNegatives: newFN,
        });

        const updatedRule = {
          ...rule,
          truePositives: newTP,
          falsePositives: newFP,
          trueNegatives: newTN,
          falseNegatives: newFN,
          precision,
          recall,
          evaluationCount: (rule.evaluationCount || 0) + 1,
        };
        // Recalculate tier based on new metrics
        updatedRule.tier = _calculateTier(updatedRule);
        return updatedRule;
      });
      rules.set(updatedRules);

      console.log(
        `[Classifier] Auto-classified as ${
          ruleMatch.prediction ? "YES" : "NO"
        } by Tier ${ruleMatch.highestTier} rules`,
      );
    } else {
      // Normal flow: send to LLM for classification
      currentItem.set(input);
    }
  },
);

/** Confirm an LLM classification (user agrees) - for API use */
const confirmClassificationHandler = handler<
  { inputId: string },
  {
    pendingClassifications: Writable<PendingClassification[]>;
    examples: Writable<LabeledExample[]>;
  }
>(({ inputId }, { pendingClassifications, examples }) => {
  const pending = pendingClassifications.get();
  const itemIndex = pending.findIndex((p) => p.input.id === inputId);
  if (itemIndex < 0) return;

  const item = pending[itemIndex];
  const result = item.result;

  const example: LabeledExample = {
    input: item.input,
    label: result.classification,
    decidedBy: "suggestion-accepted",
    reasoning: result.reasoning,
    confidence: result.confidence,
    labeledAt: Date.now(),
    wasCorrection: false,
    isInteresting: result.confidence < 0.7,
    interestingReason: result.confidence < 0.7
      ? "Low confidence, user confirmed"
      : undefined,
  };

  examples.push(example);
  pendingClassifications.set(
    pending.filter((p) => p.input.id !== inputId),
  );
});

/** Correct a classification (user disagrees) - for API use */
const correctClassificationHandler = handler<
  { inputId: string; correctLabel: boolean; reasoning?: string },
  {
    pendingClassifications: Writable<PendingClassification[]>;
    examples: Writable<LabeledExample[]>;
  }
>((
  { inputId, correctLabel, reasoning },
  { pendingClassifications, examples },
) => {
  const pending = pendingClassifications.get();
  const itemIndex = pending.findIndex((p) => p.input.id === inputId);
  if (itemIndex < 0) return;

  const item = pending[itemIndex];

  const example: LabeledExample = {
    input: item.input,
    label: correctLabel,
    decidedBy: "user",
    reasoning: reasoning || "User correction",
    confidence: 1.0,
    labeledAt: Date.now(),
    wasCorrection: true,
    originalPrediction: item.result.classification,
    isInteresting: true,
    interestingReason: "User corrected classification",
  };

  examples.push(example);
  pendingClassifications.set(
    pending.filter((p) => p.input.id !== inputId),
  );
});

/** Dismiss a classification without recording it - for API use */
const dismissClassificationHandler = handler<
  { inputId: string },
  {
    pendingClassifications: Writable<PendingClassification[]>;
  }
>(({ inputId }, { pendingClassifications }) => {
  const pending = pendingClassifications.get();
  pendingClassifications.set(
    pending.filter((p) => p.input.id !== inputId),
  );
});

/** Add a new rule */
const addRuleHandler = handler<
  RuleSuggestion,
  {
    rules: Writable<ClassificationRule[]>;
  }
>((event, { rules }) => {
  // Validate regex pattern before adding
  const validation = isValidRegex(event.pattern);
  if (!validation.valid) {
    console.error(
      `[Classifier] Cannot add rule "${event.name}": invalid regex pattern "${event.pattern}" - ${validation.error}`,
    );
    return;
  }

  const newRule: ClassificationRule = {
    id: generateId(),
    name: event.name,
    targetField: event.targetField,
    pattern: event.pattern,
    caseInsensitive: true,
    predicts: event.predicts,
    precision: 0.5,
    recall: 0.5,
    tier: 0,
    evaluationCount: 0,
    truePositives: 0,
    falsePositives: 0,
    trueNegatives: 0,
    falseNegatives: 0,
    createdAt: Date.now(),
    isShared: false,
  };
  rules.push(newRule);
});

/** Remove a rule */
const removeRuleActionHandler = handler<
  { ruleId: string },
  {
    rules: Writable<ClassificationRule[]>;
  }
>(({ ruleId }, { rules }) => {
  const current = rules.get();
  rules.set(current.filter((r) => r.id !== ruleId));
});

/** Add field to new item */
const addFieldToNewItemHandler = handler<
  void,
  {
    newFieldKey: Writable<string>;
    newFieldValue: Writable<string>;
    newItemFields: Writable<Record<string, string>>;
  }
>((_event, { newFieldKey, newFieldValue, newItemFields }) => {
  const key = newFieldKey.get().trim();
  const value = newFieldValue.get().trim();
  if (key && value) {
    newItemFields.update({ [key]: value });
    newFieldKey.set("");
    newFieldValue.set("");
  }
});

/** Dismiss the current item without classifying */
const dismissCurrentItemHandler = handler<
  void,
  {
    currentItem: Writable<ClassifiableInput | null>;
  }
>((_event, { currentItem }) => {
  currentItem.set(null);
});

/** Accept a rule suggestion - add as new rule and mark as dismissed */
const acceptSuggestionHandler = handler<
  void,
  {
    suggestion: RuleSuggestion;
    originalIndex: number;
    rules: Writable<ClassificationRule[]>;
    dismissedSuggestionIndices: Writable<number[]>;
  }
>((
  _event,
  { suggestion, originalIndex, rules, dismissedSuggestionIndices },
) => {
  // Validate regex pattern before adding
  const validation = isValidRegex(suggestion.pattern);
  if (!validation.valid) {
    console.error(
      `[Classifier] Cannot accept suggestion "${suggestion.name}": invalid regex pattern "${suggestion.pattern}" - ${validation.error}`,
    );
    return;
  }

  // Add the rule
  const newRule: ClassificationRule = {
    id: generateId(),
    name: suggestion.name,
    targetField: suggestion.targetField,
    pattern: suggestion.pattern,
    caseInsensitive: true,
    predicts: suggestion.predicts,
    precision: 0.5,
    recall: 0.5,
    tier: 0,
    evaluationCount: 0,
    truePositives: 0,
    falsePositives: 0,
    trueNegatives: 0,
    falseNegatives: 0,
    createdAt: Date.now(),
    isShared: false,
  };
  rules.push(newRule);

  // Mark as dismissed
  dismissedSuggestionIndices.addUnique(originalIndex);
});

/** Reject a rule suggestion - just mark as dismissed */
const rejectSuggestionHandler = handler<
  void,
  {
    originalIndex: number;
    dismissedSuggestionIndices: Writable<number[]>;
  }
>((_event, { originalIndex, dismissedSuggestionIndices }) => {
  dismissedSuggestionIndices.addUnique(originalIndex);
});

/** State type for the classification result cell passed to handlers */
interface CurrentClassificationResultState {
  item: ClassifiableInput;
  classification: ClassificationResult;
}

/**
 * Accept the current classification result and store directly to examples.
 * Uses module-scoped handler pattern with Writable cell that is resolved
 * via .get() inside the handler (avoids reactive context issues).
 */
const acceptCurrentClassificationHandler = handler<
  void,
  {
    resultCell: Writable<CurrentClassificationResultState | null>;
    examples: Writable<LabeledExample[]>;
    currentItem: Writable<ClassifiableInput | null>;
  }
>((_event, { resultCell, examples, currentItem }) => {
  const result = resultCell.get();
  if (!result) return;

  const { item, classification } = result;

  examples.push({
    input: {
      id: item.id,
      receivedAt: item.receivedAt,
      fields: { ...item.fields },
    },
    label: classification.classification,
    decidedBy: "suggestion-accepted",
    reasoning: classification.reasoning,
    confidence: classification.confidence,
    labeledAt: Date.now(),
    wasCorrection: false,
    isInteresting: classification.confidence < 0.7,
    interestingReason: classification.confidence < 0.7
      ? "Low confidence, user confirmed"
      : undefined,
  });
  currentItem.set(null);
});

/**
 * Correct the current classification and store directly to examples with flipped label.
 * Uses module-scoped handler pattern with Writable cell that is resolved
 * via .get() inside the handler (avoids reactive context issues).
 */
const correctCurrentClassificationHandler = handler<
  void,
  {
    resultCell: Writable<CurrentClassificationResultState | null>;
    examples: Writable<LabeledExample[]>;
    currentItem: Writable<ClassifiableInput | null>;
  }
>((_event, { resultCell, examples, currentItem }) => {
  const result = resultCell.get();
  if (!result) return;

  const { item, classification } = result;
  const flippedLabel = !classification.classification;

  examples.push({
    input: {
      id: item.id,
      receivedAt: item.receivedAt,
      fields: { ...item.fields },
    },
    label: flippedLabel, // FLIP the classification
    decidedBy: "user",
    reasoning: "User corrected classification",
    confidence: 1.0, // User is certain
    labeledAt: Date.now(),
    wasCorrection: true,
    originalPrediction: classification.classification,
    isInteresting: true,
    interestingReason: "User corrected classification",
  });
  currentItem.set(null);
});

/** Item that was auto-classified (for handler state typing) */
interface AutoClassifiedItemState {
  input: ClassifiableInput;
  label: boolean;
  confidence: number;
  reasoning: string;
  matchedRules: string[];
  tier: Tier;
  classifiedAt: number;
}

/** Accept the undone item's classification (user agrees with the original rules-based result) */
const acceptUndoneClassificationHandler = handler<
  void,
  {
    undoneAutoItem: Writable<AutoClassifiedItemState | null>;
    examples: Writable<LabeledExample[]>;
    rules: Writable<ClassificationRule[]>;
  }
>((_event, { undoneAutoItem, examples, rules }) => {
  const undone = undoneAutoItem.get();
  if (!undone) return;

  // Store to examples with the original rules-based classification
  examples.push({
    input: {
      id: undone.input.id,
      receivedAt: undone.input.receivedAt,
      fields: { ...undone.input.fields },
    },
    label: undone.label,
    decidedBy: "suggestion-accepted",
    reasoning: undone.reasoning,
    confidence: undone.confidence,
    labeledAt: Date.now(),
    wasCorrection: false,
    isInteresting: false,
  });

  // Re-add rule metrics since user confirmed the original prediction was correct
  // The actual label is what the rules predicted (undone.label)
  const rulesVal = rules.get();
  const actual = undone.label;
  const updatedRules = rulesVal.map((rule) => {
    const ruleMatched = undone.matchedRules.includes(rule.name);
    const predicted = rule.predicts;

    let newTP = rule.truePositives || 0;
    let newFP = rule.falsePositives || 0;
    let newTN = rule.trueNegatives || 0;
    let newFN = rule.falseNegatives || 0;

    if (ruleMatched) {
      if (predicted === actual) {
        newTP += 1;
      } else {
        newFP += 1;
      }
    } else {
      if (predicted === actual) {
        newFN += 1;
      } else {
        newTN += 1;
      }
    }

    const { precision, recall } = calculatePrecisionRecall({
      truePositives: newTP,
      falsePositives: newFP,
      trueNegatives: newTN,
      falseNegatives: newFN,
    });

    const updatedRule = {
      ...rule,
      truePositives: newTP,
      falsePositives: newFP,
      trueNegatives: newTN,
      falseNegatives: newFN,
      precision,
      recall,
      evaluationCount: (rule.evaluationCount || 0) + 1,
    };
    updatedRule.tier = _calculateTier(updatedRule);
    return updatedRule;
  });
  rules.set(updatedRules);

  undoneAutoItem.set(null);
});

/** Correct the undone item's classification (user disagrees with the original rules-based result) */
const correctUndoneClassificationHandler = handler<
  void,
  {
    undoneAutoItem: Writable<AutoClassifiedItemState | null>;
    examples: Writable<LabeledExample[]>;
    rules: Writable<ClassificationRule[]>;
  }
>((_event, { undoneAutoItem, examples, rules }) => {
  const undone = undoneAutoItem.get();
  if (!undone) return;

  // The user is correcting - the actual label is the OPPOSITE of what rules predicted
  const actual = !undone.label;

  // Store to examples with the FLIPPED classification
  examples.push({
    input: {
      id: undone.input.id,
      receivedAt: undone.input.receivedAt,
      fields: { ...undone.input.fields },
    },
    label: actual, // FLIPPED classification
    decidedBy: "user",
    reasoning: "User corrected classification",
    confidence: 1.0, // User is certain
    labeledAt: Date.now(),
    wasCorrection: true,
    originalPrediction: undone.label,
    isInteresting: true,
    interestingReason: "User corrected classification",
  });

  // Add rule metrics based on the corrected (flipped) actual label
  // This means the rules were WRONG - matched rules that predicted undone.label
  // should now count as FP (they predicted wrong), and so on.
  const rulesVal = rules.get();
  const updatedRules = rulesVal.map((rule) => {
    const ruleMatched = undone.matchedRules.includes(rule.name);
    const predicted = rule.predicts;

    let newTP = rule.truePositives || 0;
    let newFP = rule.falsePositives || 0;
    let newTN = rule.trueNegatives || 0;
    let newFN = rule.falseNegatives || 0;

    if (ruleMatched) {
      if (predicted === actual) {
        newTP += 1;
      } else {
        newFP += 1;
      }
    } else {
      if (predicted === actual) {
        newFN += 1;
      } else {
        newTN += 1;
      }
    }

    const { precision, recall } = calculatePrecisionRecall({
      truePositives: newTP,
      falsePositives: newFP,
      trueNegatives: newTN,
      falseNegatives: newFN,
    });

    const updatedRule = {
      ...rule,
      truePositives: newTP,
      falsePositives: newFP,
      trueNegatives: newTN,
      falseNegatives: newFN,
      precision,
      recall,
      evaluationCount: (rule.evaluationCount || 0) + 1,
    };
    updatedRule.tier = _calculateTier(updatedRule);
    return updatedRule;
  });
  rules.set(updatedRules);

  undoneAutoItem.set(null);
});

/** Dismiss the undone item without storing it */
const dismissUndoneItemHandler = handler<
  void,
  {
    undoneAutoItem: Writable<AutoClassifiedItemState | null>;
  }
>((_event, { undoneAutoItem }) => {
  undoneAutoItem.set(null);
});

/** Clear all suggestions and trigger new generation */
const refreshSuggestionsHandler = handler<
  void,
  {
    dismissedSuggestionIndices: Writable<number[]>;
    ruleGenCounter: Writable<number>;
  }
>((_event, { dismissedSuggestionIndices, ruleGenCounter }) => {
  // Clear dismissed indices so new suggestions will be visible
  dismissedSuggestionIndices.set([]);
  // Increment counter to force regeneration of prompt (triggers new LLM call)
  ruleGenCounter.increment(1);
});

/** Submit a new item for classification from UI input fields */
const submitNewItemHandler = handler<
  void,
  {
    newItemFields: Writable<Record<string, string>>;
    submitItem: Stream<{ fields: Record<string, string> }>;
  }
>((_event, { newItemFields, submitItem }) => {
  const fields = newItemFields.get();
  if (Object.keys(fields).length === 0) return;

  // Delegate to the submitItem stream (spread fields to break proxy chain)
  submitItem.send({ fields: { ...fields } });

  // Clear the input fields
  newItemFields.set({});
});

// =============================================================================
// PATTERN
// =============================================================================

export default pattern<ClassifierInput, ClassifierOutput>(
  ({
    config,
    examples,
    rules,
    pendingClassifications,
    currentItem,
  }) => {
    // Local state for new item input - use Writable for bidirectional binding with $value
    const newItemFields = new Writable<Record<string, string>>({});
    const newFieldKey = new Writable("");
    const newFieldValue = new Writable("");

    // Track recently auto-classified items for undo functionality
    const recentAutoClassified = new Writable<AutoClassifiedItem[]>([]);

    // Track undone auto-classified item awaiting manual review
    // When set, this takes priority over currentClassificationResult (shows rules-based result immediately)
    const undoneAutoItem = new Writable<AutoClassifiedItem | null>(null);

    // Track selected example for expanded details view (null when none selected)
    const selectedExampleId = new Writable<string | null>(null);

    // Compute common field names from existing examples
    // These are field names that appear in ALL examples
    const commonFields = computed((): string[] => {
      const examplesList = examples.get();
      if (examplesList.length === 0) return [];

      // Get field names from first example
      const firstFields = Object.keys(examplesList[0]?.input?.fields || {});

      // Filter to only fields that exist in ALL examples
      return firstFields.filter((field) =>
        examplesList.every((ex) => ex?.input?.fields?.[field] !== undefined)
      );
    });

    // Transform Record to array of {key, value} for reactive iteration
    // Use computed() instead of lift() to avoid closure limitations
    // When no fields are manually added, pre-populate with common fields (empty values)
    const newItemFieldEntries = computed(() => {
      const fields = newItemFields.get() ?? {};
      const manualEntries = Object.entries(fields);

      // If user has manually added fields, show those
      if (manualEntries.length > 0) {
        return manualEntries.map(([key, value]) => ({ key, value }));
      }

      // Otherwise, pre-populate with common fields from examples (empty values)
      // Access computed value directly - reactivity is transparent within computed
      return commonFields.map((key) => ({ key, value: "" }));
    });

    // Compute stats
    const stats = computeStats({ examples, rules });

    // ==========================================================================
    // BOUND HANDLERS
    // All handlers use module-scoped handler() functions with explicit state.
    // Computed values and Streams are passed as state to enable this pattern.
    // ==========================================================================

    /** Submit a new item for classification (API endpoint) */
    const submitItem = submitItemHandler({
      currentItem,
      rules,
      config,
      examples,
      recentAutoClassified,
    });

    /** Confirm an LLM classification (user agrees) - for API use */
    const confirmClassification = confirmClassificationHandler({
      pendingClassifications,
      examples,
    });

    /** Correct a classification (user disagrees) - for API use */
    const correctClassification = correctClassificationHandler({
      pendingClassifications,
      examples,
    });

    /** Dismiss a classification without recording it - for API use */
    const dismissClassification = dismissClassificationHandler({
      pendingClassifications,
    });

    /** Add a new rule */
    const addRule = addRuleHandler({ rules });

    /** Remove a rule */
    const removeRule = removeRuleActionHandler({ rules });

    // ==========================================================================
    // UI HELPERS
    // ==========================================================================

    /** Add field to new item */
    const addFieldToNewItem = addFieldToNewItemHandler({
      newFieldKey,
      newFieldValue,
      newItemFields,
    });

    /** Submit the new item for classification */
    const submitNewItem = submitNewItemHandler({
      newItemFields,
      submitItem,
    });

    // ==========================================================================
    // LLM CLASSIFICATION
    // ==========================================================================

    // Build the classification prompt for the current item
    const classificationPrompt = computed(() => {
      const item = currentItem.get();
      if (!item) return "";

      const question = config.get()?.question || "Is this a positive example?";
      const examplesList = examples.get();

      // Get recent examples for few-shot learning
      const recentPositive = examplesList.filter((e) => e.label).slice(-3);
      const recentNegative = examplesList.filter((e) => !e.label).slice(-3);

      // Include itemId in prompt so LLM echoes it back
      let prompt = `Item ID: ${item.id}\n\n`;
      prompt += `Question: ${question}\n\n`;
      prompt += `Input to classify:\n${
        JSON.stringify(item.fields, null, 2)
      }\n\n`;

      if (recentPositive.length > 0 || recentNegative.length > 0) {
        prompt += "Examples for context:\n";
        if (recentPositive.length > 0) {
          prompt += "\nPositive examples (answer is YES):\n";
          for (const ex of recentPositive) {
            prompt += `- ${JSON.stringify(ex.input.fields)}\n`;
          }
        }
        if (recentNegative.length > 0) {
          prompt += "\nNegative examples (answer is NO):\n";
          for (const ex of recentNegative) {
            prompt += `- ${JSON.stringify(ex.input.fields)}\n`;
          }
        }
      }

      return prompt;
    });

    // LLM classification - only runs when there's a prompt
    const llmResult = generateObject<LLMClassificationResult>({
      prompt: classificationPrompt,
      system:
        `You are a precise classifier. Analyze the input and determine if it matches the question criteria.
Respond with:
- itemId: echo back the exact Item ID from the prompt (REQUIRED - this must match exactly)
- classification: true for YES, false for NO
- confidence: a number between 0 and 1 indicating your confidence
- reasoning: a brief explanation of why you classified it this way`,
    });

    // When LLM result arrives, compute the classification result
    // IMPORTANT: This computed has NO SIDE EFFECTS - it only derives state
    // The UI shows this result, and user actions (Confirm/Correct) trigger state changes
    const currentClassificationResult = computed((): {
      item: ClassifiableInput;
      classification: ClassificationResult;
    } | null => {
      // Skip if still pending or error
      if (llmResult.pending || llmResult.error) return null;

      const llmResultValue = llmResult.result;
      if (!llmResultValue || !llmResultValue.itemId) return null;

      // Get the current item being classified
      const item = currentItem.get();
      if (!item) return null;

      // Verify the LLM response matches the item we sent
      if (item.id !== llmResultValue.itemId) {
        console.warn(
          `[Classifier] Item ID mismatch: expected ${item.id}, got ${llmResultValue.itemId}`,
        );
        return null;
      }

      // Validate LLM response fields
      if (typeof llmResultValue.classification !== "boolean") {
        console.warn(
          `[Classifier] Invalid classification type: expected boolean, got ${typeof llmResultValue
            .classification}`,
        );
        return null;
      }
      if (
        typeof llmResultValue.confidence !== "number" ||
        llmResultValue.confidence < 0 ||
        llmResultValue.confidence > 1
      ) {
        console.warn(
          `[Classifier] Invalid confidence: expected number between 0 and 1, got ${llmResultValue.confidence}`,
        );
        return null;
      }
      if (
        typeof llmResultValue.reasoning !== "string" ||
        llmResultValue.reasoning.trim() === ""
      ) {
        console.warn(
          `[Classifier] Invalid reasoning: expected non-empty string`,
        );
        return null;
      }

      // Try rules first with precision-weighted voting
      // Use the shared matchRulesAgainstInput function to avoid duplication
      const configVal = config.get() || DEFAULT_CONFIG;
      const rulesVal = rules.get();
      const threshold = configVal.autoClassifyThreshold || 0.85;

      const ruleResult = matchRulesAgainstInput(item, rulesVal, threshold);
      // Access properties directly to avoid CTS transformer issues with destructuring rename
      const matchedRules = ruleResult.matchedRules;
      const rulesPrediction = ruleResult.prediction;
      const rulesConfidence = ruleResult.confidence;

      let classification: ClassificationResult;

      // Determine if rules should be used:
      // 1. Rules must have produced a prediction (rulesPrediction !== null means at least one rule matched)
      // 2. Rules confidence must meet the threshold
      const useRules = rulesPrediction !== null && rulesConfidence >= threshold;

      if (useRules && rulesPrediction !== null) {
        // TypeScript needs the explicit null check here for type narrowing
        classification = {
          inputId: item.id,
          classification: rulesPrediction,
          confidence: rulesConfidence,
          reasoning: `Rules matched: ${matchedRules.join(", ")}`,
          decidedBy: "rules",
          matchedRules,
        };
      } else {
        // Use LLM when: no rules matched OR rules confidence below threshold
        classification = {
          inputId: item.id,
          classification: llmResultValue.classification,
          confidence: llmResultValue.confidence,
          reasoning: llmResultValue.reasoning ?? "",
          decidedBy: "llm",
          matchedRules,
        };
      }

      // Return the computed classification - NO SIDE EFFECTS
      return { item, classification };
    });

    // Helper computed to check if we have a classification result ready
    const hasClassificationResult = computed(
      () => currentClassificationResult !== null,
    );

    // ==========================================================================
    // HANDLERS FOR CURRENT ITEM (in-progress classification)
    // These are called when user clicks Accept/Correct on the item being classified
    // They store directly to examples (single-step confirmation)
    // Computed values extract item/classification from currentClassificationResult
    // to pass to module-scoped handlers.
    // ==========================================================================

    /** Accept the current classification result and store directly to examples */
    const acceptCurrentClassification = acceptCurrentClassificationHandler({
      resultCell: currentClassificationResult,
      examples,
      currentItem,
    });

    /** Correct the current classification and store directly to examples with flipped label */
    const correctCurrentClassification = correctCurrentClassificationHandler({
      resultCell: currentClassificationResult,
      examples,
      currentItem,
    });

    /** Dismiss the current item without classifying */
    const dismissCurrentItem = dismissCurrentItemHandler({ currentItem });

    // ==========================================================================
    // UNDONE ITEM HANDLERS (for items that were auto-classified and then undone)
    // These show the original rules-based classification immediately
    // ==========================================================================

    /** Accept the undone item's classification (user agrees with the original rules-based result) */
    const acceptUndoneClassification = acceptUndoneClassificationHandler({
      undoneAutoItem,
      examples,
      rules,
    });

    /** Correct the undone item's classification (user disagrees with the original rules-based result) */
    const correctUndoneClassification = correctUndoneClassificationHandler({
      undoneAutoItem,
      examples,
      rules,
    });

    /** Dismiss the undone item without storing it */
    const dismissUndoneItem = dismissUndoneItemHandler({ undoneAutoItem });

    // ==========================================================================
    // PHASE 3: LLM RULE GENERATION
    // ==========================================================================

    // Track which suggestion indices have been acted on (accepted or dismissed)
    // This avoids side effects in computed - we derive visible suggestions from LLM result
    const dismissedSuggestionIndices = new Writable<number[]>([]);
    // Counter to force refresh of rule generation prompt
    const ruleGenCounter = new Writable(0);

    // Build the rule generation prompt when conditions are met
    const ruleGenerationPrompt = computed(() => {
      const examplesList = examples.get();
      const configVal = config.get();
      // Read counter to establish dependency (forces regeneration when incremented)
      const _refreshCount = ruleGenCounter.get();

      // Only generate when we have enough examples
      if (!configVal) return "";
      if (examplesList.length < (configVal.minExamplesForRules || 5)) return "";

      // Check for errors/corrections that indicate room for improvement
      const corrections = examplesList.filter((e) => e.wasCorrection);
      const interestingExamples = examplesList.filter((e) => e.isInteresting);

      // Only suggest rules if we have at least some interesting examples
      if (corrections.length === 0 && interestingExamples.length < 2) return "";

      // Get field names from examples
      const allFields = new Set<string>();
      for (const ex of examplesList) {
        for (const key of Object.keys(ex.input.fields)) {
          allFields.add(key);
        }
      }

      const question = configVal.question || "Is this a positive example?";

      const positiveExamples = examplesList.filter((e) => e.label).slice(-5);
      const negativeExamples = examplesList.filter((e) => !e.label).slice(-5);

      let prompt =
        `You are analyzing classification examples to generate regex rules.

Question being classified: "${question}"

Available fields: ${Array.from(allFields).join(", ")}

Positive examples (label = YES):
${positiveExamples.map((e) => JSON.stringify(e.input.fields)).join("\n")}

Negative examples (label = NO):
${negativeExamples.map((e) => JSON.stringify(e.input.fields)).join("\n")}

`;

      if (corrections.length > 0) {
        prompt += `Recent corrections (initially misclassified):
${
          corrections.slice(-3).map((e) =>
            `- ${JSON.stringify(e.input.fields)} → was ${
              e.originalPrediction ? "YES" : "NO"
            }, correct: ${e.label ? "YES" : "NO"}`
          ).join("\n")
        }

`;
      }

      prompt +=
        `Generate 1-3 regex patterns that could help classify future inputs.
Each rule should:
1. Target a specific field
2. Use a simple regex pattern (avoid overly complex patterns)
3. Be specific enough to avoid false positives
4. Explain why this pattern indicates the classification`;

      return prompt;
    });

    // LLM rule generation - only runs when there's a prompt
    interface RuleSuggestionsResult {
      suggestions: RuleSuggestion[];
    }

    const ruleGenResult = generateObject<RuleSuggestionsResult>({
      prompt: ruleGenerationPrompt,
      system:
        `You are a pattern recognition expert. Analyze the examples and generate regex rules.
Each suggestion should have:
- name: a short descriptive name
- targetField: which field to match against
- pattern: a regex pattern (without delimiters)
- predicts: true for YES, false for NO
- reasoning: why this pattern indicates the classification`,
    });

    // Derive visible suggestions from LLM result, filtered by dismissed indices
    // This is pure derivation with no side effects
    const visibleSuggestions = computed(
      (): Array<{ suggestion: RuleSuggestion; originalIndex: number }> => {
        if (ruleGenResult.pending || ruleGenResult.error) return [];

        const result = ruleGenResult.result;
        if (!result || !result.suggestions || result.suggestions.length === 0) {
          return [];
        }

        const dismissed = dismissedSuggestionIndices.get();
        // Convert reactive proxy to plain array to avoid mapWithPattern issues
        const suggestionsArray = [...result.suggestions];
        return suggestionsArray
          .map((suggestion, index) => ({ suggestion, originalIndex: index }))
          .filter(({ originalIndex }) => !dismissed.includes(originalIndex))
          .filter(({ suggestion }) => {
            const isValid = isValidRuleSuggestion(suggestion);
            if (!isValid) {
              console.warn(
                `[Classifier] Invalid rule suggestion, skipping:`,
                suggestion,
              );
            }
            return isValid;
          });
      },
    );

    /** Clear all suggestions and trigger new generation */
    const refreshSuggestions = refreshSuggestionsHandler({
      dismissedSuggestionIndices,
      ruleGenCounter,
    });

    // Display name
    const displayName = computed(() => {
      const configVal = config.get();
      const q = configVal?.question;
      return q ? `Classifier: ${q}` : "Self-Improving Classifier";
    });

    // ==========================================================================
    // UI
    // ==========================================================================

    return {
      [NAME]: displayName,
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="2">
            <cf-heading level={4}>{displayName}</cf-heading>
            <cf-input
              value={computed(() => config.get()?.question ?? "")}
              placeholder="Enter your classification question (e.g., 'Is this email a bill?')"
              oncf-input={(e: { detail?: { value?: string } }) => {
                const q = e.detail?.value || "";
                const current = config.get() || DEFAULT_CONFIG;
                config.set({ ...current, question: q });
              }}
            />
          </cf-vstack>

          <cf-vscroll flex showScrollbar fadeEdges>
            <cf-vstack gap="3" style="padding: 1rem;">
              {/* Stats Section */}
              <cf-card>
                <cf-vstack gap="2">
                  <cf-heading level={5}>Statistics</cf-heading>
                  <cf-hstack gap="4" justify="around">
                    <cf-vstack gap="0" align="center">
                      <span style="font-size: 1.5rem; font-weight: 600;">
                        {stats.totalExamples}
                      </span>
                      <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                        Examples
                      </span>
                    </cf-vstack>
                    <cf-vstack gap="0" align="center">
                      <span style="font-size: 1.5rem; font-weight: 600;">
                        {stats.positiveExamples}
                      </span>
                      <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                        YES
                      </span>
                    </cf-vstack>
                    <cf-vstack gap="0" align="center">
                      <span style="font-size: 1.5rem; font-weight: 600;">
                        {stats.negativeExamples}
                      </span>
                      <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                        NO
                      </span>
                    </cf-vstack>
                    <cf-vstack gap="0" align="center">
                      <span style="font-size: 1.5rem; font-weight: 600;">
                        {stats.totalRules}
                      </span>
                      <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                        Rules
                      </span>
                    </cf-vstack>
                  </cf-hstack>
                  {ifElse(
                    computed(() => stats.autoClassified > 0),
                    <span style="font-size: 0.875rem; color: var(--cf-colors-gray-500); text-align: center;">
                      Correction rate:{" "}
                      {computed(() => (stats.correctionRate * 100).toFixed(1))}%
                    </span>,
                    null,
                  )}
                </cf-vstack>
              </cf-card>

              {/* Submit New Item */}
              <cf-card>
                <cf-vstack gap="2">
                  <cf-heading level={5}>
                    Submit Item for Classification
                  </cf-heading>

                  {/* Current fields - show empty message or field list */}
                  {ifElse(
                    computed(() => {
                      const entries = newItemFieldEntries;
                      return !entries || entries.length === 0;
                    }),
                    <span style="color: var(--cf-colors-gray-400); font-size: 0.875rem;">
                      No fields added yet
                    </span>,
                    <cf-vstack gap="1">
                      {newItemFieldEntries.map(
                        (entry: { key: string; value: string }) => (
                          <cf-hstack gap="2" align="center">
                            <span style="font-weight: 500; min-width: 80px;">
                              {getFieldKey(entry)}:
                            </span>
                            <cf-input
                              value={getFieldValue(entry)}
                              placeholder={computed(() =>
                                `Enter ${entry.key}`
                              )}
                              style="flex: 1;"
                              oncf-input={updateFieldHandler({
                                fieldKey: getFieldKey(entry),
                                newItemFields,
                              })}
                            />
                            <cf-button
                              color="neutral"
                              variant="ghost"
                              onClick={removeFieldHandler({
                                entry,
                                newItemFields,
                              })}
                            >
                              x
                            </cf-button>
                          </cf-hstack>
                        ),
                      )}
                    </cf-vstack>,
                  )}

                  {/* Add field */}
                  <cf-hstack gap="2">
                    <cf-input
                      $value={newFieldKey}
                      placeholder="Field name"
                      style="width: 120px;"
                    />
                    <cf-input
                      $value={newFieldValue}
                      placeholder="Field value"
                      style="flex: 1;"
                    />
                    <cf-button
                      color="neutral"
                      variant="outline"
                      onClick={addFieldToNewItem}
                    >
                      Add
                    </cf-button>
                  </cf-hstack>

                  <cf-button
                    color="primary"
                    variant="solid"
                    disabled={computed(() => {
                      const fields = newItemFields.get();
                      const fieldKeys = Object.keys(fields);
                      // Disabled if no fields or all fields are empty
                      if (fieldKeys.length === 0) return true;
                      return fieldKeys.every((k) => !fields[k]?.trim());
                    })}
                    onClick={submitNewItem}
                  >
                    Classify
                  </cf-button>
                </cf-vstack>
              </cf-card>

              {/* Currently classifying - show loader or result */}
              {ifElse(
                computed(() => currentItem.get() !== null),
                <cf-card style="border-left: 4px solid var(--cf-colors-info);">
                  <cf-vstack gap="2">
                    {/* Show item being classified */}
                    <pre style="font-size: 0.75rem; overflow: auto; max-height: 100px; margin: 0; background: var(--cf-colors-gray-50); padding: 0.5rem; border-radius: 4px;">
                      {computed(() => {
                        const result = currentClassificationResult;
                        if (result) {
                          return toIndentedDebugString(result.item.fields);
                        }
                        const item = currentItem.get();
                        return item ? toIndentedDebugString(item.fields) : "";
                      })}
                    </pre>

                    {/* Show loading or result */}
                    {ifElse(
                      hasClassificationResult,
                      // Result is ready - show classification with action buttons
                      <cf-vstack gap="2">
                        <cf-hstack gap="2" align="center">
                          <span
                            style={{
                              fontWeight: "600",
                              color: ifElse(
                                computed(() =>
                                  currentClassificationResult?.classification
                                    .classification ?? false
                                ),
                                "var(--cf-theme-color-success)",
                                "var(--cf-theme-color-error)",
                              ),
                            }}
                          >
                            {ifElse(
                              computed(() =>
                                currentClassificationResult?.classification
                                  .classification ?? false
                              ),
                              "YES",
                              "NO",
                            )}
                          </span>
                          <span style="color: var(--cf-colors-gray-500); font-size: 0.875rem;">
                            ({computed(() =>
                              (
                                (currentClassificationResult?.classification
                                  .confidence ?? 0) * 100
                              ).toFixed(0)
                            )}% confidence via {computed(() =>
                              currentClassificationResult?.classification
                                .decidedBy ?? ""
                            )})
                          </span>
                        </cf-hstack>

                        <span style="font-size: 0.875rem; color: var(--cf-colors-gray-600);">
                          {computed(() =>
                            currentClassificationResult?.classification
                              .reasoning ?? ""
                          )}
                        </span>

                        <cf-hstack gap="2">
                          <cf-button
                            color="primary"
                            variant="solid"
                            onClick={acceptCurrentClassification}
                          >
                            Accept
                          </cf-button>
                          <cf-button
                            color="neutral"
                            variant="outline"
                            onClick={correctCurrentClassification}
                          >
                            Actually {ifElse(
                              computed(() =>
                                currentClassificationResult?.classification
                                  .classification ?? false
                              ),
                              "NO",
                              "YES",
                            )}
                          </cf-button>
                          <cf-button
                            color="neutral"
                            variant="ghost"
                            onClick={dismissCurrentItem}
                          >
                            Dismiss
                          </cf-button>
                        </cf-hstack>
                      </cf-vstack>,
                      // Still loading
                      <cf-hstack gap="2" align="center">
                        <cf-loader size="sm" />
                        <span style="font-weight: 500;">Classifying...</span>
                      </cf-hstack>,
                    )}
                  </cf-vstack>
                </cf-card>,
                null,
              )}

              {/* Undone Auto-Classification - Manual Review */}
              {ifElse(
                computed(() => undoneAutoItem.get() !== null),
                <cf-card style="border-left: 4px solid var(--cf-theme-color-warning);">
                  <cf-vstack gap="2">
                    <cf-hstack gap="2" align="center">
                      <cf-heading level={5}>Manual Review</cf-heading>
                      <span style="font-size: 0.75rem; color: var(--cf-theme-color-warning);">
                        (undone auto-classification)
                      </span>
                    </cf-hstack>

                    {/* Show item fields */}
                    <pre style="font-size: 0.75rem; overflow: auto; max-height: 100px; margin: 0; background: var(--cf-colors-gray-50); padding: 0.5rem; border-radius: 4px;">
                      {computed(() => {
                        const undone = undoneAutoItem.get();
                        return undone
                          ? toIndentedDebugString(undone.input.fields)
                          : "";
                      })}
                    </pre>

                    {/* Show the original rules-based classification */}
                    <cf-hstack gap="2" align="center">
                      <span
                        style={{
                          fontWeight: "600",
                          color: ifElse(
                            computed(() =>
                              undoneAutoItem.get()?.label ?? false
                            ),
                            "var(--cf-theme-color-success)",
                            "var(--cf-theme-color-error)",
                          ),
                        }}
                      >
                        {ifElse(
                          computed(() => undoneAutoItem.get()?.label ?? false),
                          "YES",
                          "NO",
                        )}
                      </span>
                      <span style="color: var(--cf-colors-gray-500); font-size: 0.875rem;">
                        ({computed(() =>
                          (
                            (undoneAutoItem.get()?.confidence ?? 0) * 100
                          ).toFixed(0)
                        )}% confidence via rules - Tier{" "}
                        {computed(() => undoneAutoItem.get()?.tier ?? 0)})
                      </span>
                    </cf-hstack>

                    <span style="font-size: 0.875rem; color: var(--cf-colors-gray-600);">
                      {computed(() => undoneAutoItem.get()?.reasoning ?? "")}
                    </span>

                    <cf-hstack gap="2">
                      <cf-button
                        color="primary"
                        variant="solid"
                        onClick={acceptUndoneClassification}
                      >
                        Accept
                      </cf-button>
                      <cf-button
                        color="neutral"
                        variant="outline"
                        onClick={correctUndoneClassification}
                      >
                        Actually {ifElse(
                          computed(() => undoneAutoItem.get()?.label ?? false),
                          "NO",
                          "YES",
                        )}
                      </cf-button>
                      <cf-button
                        color="neutral"
                        variant="ghost"
                        onClick={dismissUndoneItem}
                      >
                        Dismiss
                      </cf-button>
                    </cf-hstack>
                  </cf-vstack>
                </cf-card>,
                null,
              )}

              {/* Pending Classifications */}
              {ifElse(
                computed(() => pendingClassifications.get().length > 0),
                <cf-card>
                  <cf-vstack gap="2">
                    <cf-heading level={5}>Awaiting Confirmation</cf-heading>
                    {pendingClassifications.map((pending) => (
                      <cf-card style="background: var(--cf-colors-gray-50);">
                        <cf-vstack gap="2">
                          <pre style="font-size: 0.75rem; overflow: auto; max-height: 100px; margin: 0;">
                            {computed(() =>
                              toIndentedDebugString(pending.input.fields)
                            )}
                          </pre>

                          <cf-hstack gap="2" align="center">
                            <span
                              style={{
                                fontWeight: "600",
                                color: ifElse(
                                  pending.result.classification,
                                  "var(--cf-theme-color-success)",
                                  "var(--cf-theme-color-error)",
                                ),
                              }}
                            >
                              {ifElse(
                                pending.result.classification,
                                "YES",
                                "NO",
                              )}
                            </span>
                            <span style="color: var(--cf-colors-gray-500); font-size: 0.875rem;">
                              ({computed(() =>
                                (pending.result.confidence * 100).toFixed(0)
                              )}% confidence via{" "}
                              {pending.result.decidedBy ?? "unknown"})
                            </span>
                          </cf-hstack>

                          <span style="font-size: 0.875rem; color: var(--cf-colors-gray-600);">
                            {pending.result.reasoning ?? ""}
                          </span>

                          <cf-hstack gap="2">
                            <cf-button
                              color="primary"
                              variant="solid"
                              onClick={confirmPendingClassification({
                                pending,
                                examples,
                                pendingClassifications,
                              })}
                            >
                              Confirm
                            </cf-button>
                            <cf-button
                              color="neutral"
                              variant="outline"
                              onClick={correctPendingClassification({
                                pending,
                                examples,
                                pendingClassifications,
                              })}
                            >
                              Actually {ifElse(
                                pending.result.classification,
                                "NO",
                                "YES",
                              )}
                            </cf-button>
                            <cf-button
                              color="neutral"
                              variant="ghost"
                              onClick={dismissPendingClassification({
                                pending,
                                pendingClassifications,
                              })}
                            >
                              Dismiss
                            </cf-button>
                          </cf-hstack>
                        </cf-vstack>
                      </cf-card>
                    ))}
                  </cf-vstack>
                </cf-card>,
                null,
              )}

              {/* Rules Section */}
              {ifElse(
                computed(() => rules.get().length > 0),
                <cf-card>
                  <cf-vstack gap="2">
                    <cf-heading level={5}>Classification Rules</cf-heading>
                    {rules.map((rule) => (
                      <cf-hstack
                        gap="2"
                        align="center"
                        style="padding: 0.5rem; background: var(--cf-colors-gray-50); border-radius: 4px;"
                      >
                        {/* Tier badge */}
                        <span
                          style={{
                            padding: "2px 6px",
                            borderRadius: "4px",
                            fontSize: "0.625rem",
                            fontWeight: "600",
                            backgroundColor: computed(() =>
                              getTierColor(rule.tier)
                            ),
                            color: "white",
                            whiteSpace: "nowrap",
                          }}
                        >
                          T{rule.tier}
                        </span>
                        <cf-vstack gap="0" style="flex: 1;">
                          <span style="font-weight: 500;">{rule.name}</span>
                          <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                            {rule.targetField}: /{rule.pattern}/{ifElse(
                              rule.caseInsensitive,
                              "i",
                              "",
                            )} → {ifElse(rule.predicts, "YES", "NO")}
                          </span>
                          <span style="font-size: 0.75rem; color: var(--cf-colors-gray-400);">
                            P:{" "}
                            {computed(() => (rule.precision * 100).toFixed(0))}%
                            | F1: {computed(() =>
                              (calculateF1(rule) * 100).toFixed(0)
                            )}% | {rule.evaluationCount} evals | {computed(() =>
                              getTierLabel(rule.tier)
                            )}
                          </span>
                        </cf-vstack>
                        <cf-button
                          color="neutral"
                          variant="ghost"
                          onClick={removeRuleHandler({ rule, rules })}
                        >
                          x
                        </cf-button>
                      </cf-hstack>
                    ))}
                  </cf-vstack>
                </cf-card>,
                null,
              )}

              {/* Suggested Rules */}
              {ifElse(
                computed(() => visibleSuggestions.length > 0),
                <cf-card style="border-left: 4px solid var(--cf-theme-color-success);">
                  <cf-vstack gap="2">
                    <cf-hstack gap="2" align="center" justify="between">
                      <cf-heading level={5}>Suggested Rules</cf-heading>
                      <cf-button
                        color="neutral"
                        variant="ghost"
                        onClick={refreshSuggestions}
                      >
                        Refresh
                      </cf-button>
                    </cf-hstack>
                    {visibleSuggestions.map(({ suggestion, originalIndex }) => (
                      <cf-card style="background: var(--cf-theme-color-success-light);">
                        <cf-vstack gap="2">
                          <cf-vstack gap="0">
                            <span style="font-weight: 500;">
                              {suggestion.name}
                            </span>
                            <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                              {suggestion.targetField}: /{suggestion.pattern}/ →
                              {" "}
                              {suggestion.predicts ? "YES" : "NO"}
                            </span>
                          </cf-vstack>
                          <span style="font-size: 0.875rem; color: var(--cf-colors-gray-600);">
                            {suggestion.reasoning}
                          </span>
                          <cf-hstack gap="2">
                            <cf-button
                              color="primary"
                              variant="solid"
                              onClick={acceptSuggestionHandler({
                                suggestion,
                                originalIndex,
                                rules,
                                dismissedSuggestionIndices,
                              })}
                            >
                              Accept
                            </cf-button>
                            <cf-button
                              color="neutral"
                              variant="ghost"
                              onClick={rejectSuggestionHandler({
                                originalIndex,
                                dismissedSuggestionIndices,
                              })}
                            >
                              Reject
                            </cf-button>
                          </cf-hstack>
                        </cf-vstack>
                      </cf-card>
                    ))}
                  </cf-vstack>
                </cf-card>,
                null,
              )}

              {/* Auto-Classified Items (with Undo) */}
              {ifElse(
                computed(() => recentAutoClassified.get().length > 0),
                <cf-card style="margin-bottom: 1rem; border-left: 4px solid var(--cf-theme-color-warning);">
                  <cf-vstack gap="2">
                    <cf-hstack align="center" gap="2">
                      <h5 style="margin: 0;">Auto-Classified</h5>
                      <span style="font-size: 0.75rem; color: var(--cf-theme-color-warning);">
                        (click Undo to review manually)
                      </span>
                    </cf-hstack>
                    {recentAutoClassified.map((autoItem) => (
                      <cf-hstack
                        gap="2"
                        align="center"
                        style={{
                          padding: "0.5rem",
                          background:
                            "var(--cf-theme-color-status-warning-subtle)",
                          borderRadius: "4px",
                        }}
                      >
                        <span
                          style={{
                            padding: "0.125rem 0.375rem",
                            borderRadius: "4px",
                            fontSize: "0.625rem",
                            fontWeight: "600",
                            background: computed(() =>
                              getTierColor(autoItem.tier)
                            ),
                            color: "white",
                          }}
                        >
                          T{autoItem.tier}
                        </span>
                        <span
                          style={{
                            fontWeight: "600",
                            color: ifElse(
                              autoItem.label,
                              "var(--cf-theme-color-success)",
                              "var(--cf-theme-color-error)",
                            ),
                          }}
                        >
                          {ifElse(autoItem.label, "YES", "NO")}
                        </span>
                        <span style="flex: 1; font-size: 0.875rem;">
                          {computed(() => {
                            const fields = autoItem.input.fields;
                            const entries = Object.entries(fields);
                            const first = entries[0];
                            return first
                              ? `${first[0]}: ${first[1].substring(0, 30)}...`
                              : "(empty)";
                          })}
                        </span>
                        <cf-button
                          color="neutral"
                          variant="outline"
                          size="sm"
                          onClick={undoAutoClassificationHandler({
                            autoItem,
                            examples,
                            rules,
                            recentAutoClassified,
                            undoneAutoItem,
                          })}
                        >
                          Undo
                        </cf-button>
                      </cf-hstack>
                    ))}
                  </cf-vstack>
                </cf-card>,
                null,
              )}

              {/* Recent Examples */}
              {ifElse(
                computed(() => examples.get().length > 0),
                <details>
                  <summary style="cursor: pointer; padding: 0.5rem; color: var(--cf-colors-gray-600);">
                    Recent Examples ({computed(() => examples.get().length)})
                  </summary>
                  <cf-vstack gap="1" style="margin-top: 0.5rem;">
                    {examples.map((example) => (
                      <cf-vstack gap="0">
                        {/* Clickable example row */}
                        <cf-hstack
                          gap="2"
                          align="center"
                          onClick={toggleExampleSelectionHandler({
                            example,
                            selectedExampleId,
                          })}
                          style={{
                            padding: "0.5rem",
                            cursor: "pointer",
                            background: ifElse(
                              computed(() =>
                                selectedExampleId.get() === example.input.id
                              ),
                              "var(--cf-colors-blue-100)",
                              ifElse(
                                example.wasCorrection,
                                "var(--cf-theme-color-status-warning-subtle)",
                                "var(--cf-colors-gray-50)",
                              ),
                            ),
                            borderRadius: ifElse(
                              computed(() =>
                                selectedExampleId.get() === example.input.id
                              ),
                              "4px 4px 0 0",
                              "4px",
                            ),
                            borderLeft: ifElse(
                              example.isInteresting,
                              "3px solid var(--cf-theme-color-warning)",
                              "none",
                            ),
                          }}
                        >
                          <span
                            style={{
                              fontWeight: "600",
                              color: ifElse(
                                example.label,
                                "var(--cf-theme-color-success)",
                                "var(--cf-theme-color-error)",
                              ),
                            }}
                          >
                            {ifElse(example.label, "YES", "NO")}
                          </span>
                          <span style="flex: 1; font-size: 0.875rem; color: var(--cf-colors-gray-600);">
                            {getExamplePreview(example)}
                          </span>
                          <span style="font-size: 0.75rem; color: var(--cf-colors-gray-400);">
                            {getExampleDecidedBy(example)}
                            {ifElse(example.wasCorrection, " (corrected)", "")}
                          </span>
                          <span style="font-size: 0.75rem; color: var(--cf-colors-gray-400);">
                            {ifElse(
                              computed(() =>
                                selectedExampleId.get() === example.input.id
                              ),
                              "[-]",
                              "[+]",
                            )}
                          </span>
                        </cf-hstack>

                        {/* Expanded details panel */}
                        {ifElse(
                          computed(() =>
                            selectedExampleId.get() === example.input.id
                          ),
                          <cf-card
                            style={{
                              marginTop: "0",
                              borderRadius: "0 0 4px 4px",
                              borderTop: "1px solid var(--cf-colors-gray-200)",
                              background: "var(--cf-colors-gray-50)",
                            }}
                          >
                            <cf-vstack gap="2">
                              {/* All input fields */}
                              <cf-vstack gap="1">
                                <span style="font-weight: 600; font-size: 0.75rem; color: var(--cf-colors-gray-500); text-transform: uppercase;">
                                  Input Fields
                                </span>
                                <pre style="font-size: 0.75rem; overflow: auto; max-height: 150px; margin: 0; background: white; padding: 0.5rem; border-radius: 4px; border: 1px solid var(--cf-colors-gray-200);">
                                  {computed(() =>
                                    toIndentedDebugString(
                                      example.input.fields,
                                    )
                                  )}
                                </pre>
                              </cf-vstack>

                              {/* Classification details */}
                              <cf-hstack gap="4" wrap>
                                <cf-vstack gap="0">
                                  <span style="font-weight: 600; font-size: 0.625rem; color: var(--cf-colors-gray-500); text-transform: uppercase;">
                                    Label
                                  </span>
                                  <span
                                    style={{
                                      fontWeight: "600",
                                      color: ifElse(
                                        example.label,
                                        "var(--cf-theme-color-success)",
                                        "var(--cf-theme-color-error)",
                                      ),
                                    }}
                                  >
                                    {ifElse(example.label, "YES", "NO")}
                                  </span>
                                </cf-vstack>
                                <cf-vstack gap="0">
                                  <span style="font-weight: 600; font-size: 0.625rem; color: var(--cf-colors-gray-500); text-transform: uppercase;">
                                    Confidence
                                  </span>
                                  <span style="font-size: 0.875rem;">
                                    {computed(() =>
                                      (example.confidence * 100).toFixed(0)
                                    )}%
                                  </span>
                                </cf-vstack>
                                <cf-vstack gap="0">
                                  <span style="font-weight: 600; font-size: 0.625rem; color: var(--cf-colors-gray-500); text-transform: uppercase;">
                                    Decided By
                                  </span>
                                  <span style="font-size: 0.875rem;">
                                    {getExampleDecidedBy(example)}
                                  </span>
                                </cf-vstack>
                                <cf-vstack gap="0">
                                  <span style="font-weight: 600; font-size: 0.625rem; color: var(--cf-colors-gray-500); text-transform: uppercase;">
                                    Timestamp
                                  </span>
                                  <span style="font-size: 0.875rem;">
                                    {computed(() =>
                                      new Date(
                                        example.labeledAt,
                                      ).toLocaleString()
                                    )}
                                  </span>
                                </cf-vstack>
                              </cf-hstack>

                              {/* Reasoning */}
                              {ifElse(
                                computed(() => !!example.reasoning),
                                <cf-vstack gap="1">
                                  <span style="font-weight: 600; font-size: 0.625rem; color: var(--cf-colors-gray-500); text-transform: uppercase;">
                                    Reasoning
                                  </span>
                                  <span style="font-size: 0.875rem; color: var(--cf-colors-gray-600);">
                                    {example.reasoning}
                                  </span>
                                </cf-vstack>,
                                null,
                              )}

                              {/* Correction info */}
                              {ifElse(
                                example.wasCorrection,
                                <cf-hstack
                                  gap="1"
                                  align="center"
                                  style="font-size: 0.75rem; color: var(--cf-theme-color-warning); padding: 0.25rem 0.5rem; background: var(--cf-theme-color-status-warning-subtle); border-radius: 4px;"
                                >
                                  <span style="font-weight: 500;">
                                    Correction:
                                  </span>
                                  <span>
                                    Originally predicted {ifElse(
                                      example.originalPrediction,
                                      "YES",
                                      "NO",
                                    )}
                                  </span>
                                </cf-hstack>,
                                null,
                              )}

                              {/* Action buttons */}
                              <cf-hstack gap="2" style="margin-top: 0.5rem;">
                                <cf-button
                                  color="neutral"
                                  variant="outline"
                                  size="sm"
                                  disabled={computed(() =>
                                    currentItem.get() !== null
                                  )}
                                  onClick={reclassifyExampleHandler({
                                    example,
                                    examples,
                                    currentItem,
                                    selectedExampleId,
                                  })}
                                >
                                  Reclassify
                                </cf-button>
                                <cf-button
                                  color="neutral"
                                  variant="ghost"
                                  size="sm"
                                  onClick={removeExampleHandler({
                                    example,
                                    examples,
                                    selectedExampleId,
                                  })}
                                >
                                  Remove
                                </cf-button>
                              </cf-hstack>
                            </cf-vstack>
                          </cf-card>,
                          null,
                        )}
                      </cf-vstack>
                    ))}
                  </cf-vstack>
                </details>,
                null,
              )}
            </cf-vstack>
          </cf-vscroll>
        </cf-screen>
      ),
      config,
      examples,
      rules,
      pendingClassifications,
      stats,
      submitItem,
      confirmClassification,
      correctClassification,
      dismissClassification,
      addRule,
      removeRule,
    };
  },
);
