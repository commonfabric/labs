/**
 * The classifier's decisions, apart from the pattern that stores and shows
 * them: compiling and matching regex rules, scoring rules against outcomes,
 * building the prompts the pattern sends to the model, checking what the model
 * sends back, and shaping the examples a decision records.
 */

import type { BuiltInLLMGenerateObjectState } from "commonfabric";

// =============================================================================
// TYPES
// =============================================================================

/** Confidence tiers from the self-hoisting essay */
export type Tier = 0 | 1 | 2 | 3 | 4;

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
  /** Set when the rules auto-classified the input and the user then reviewed
   * that decision, accepting or correcting it. */
  reviewedAutoClassification?: boolean;
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
  isShared: boolean;
  sharedFrom?: string;
}

/** User configuration */
export interface ClassifierConfig {
  question: string;
  minExamplesForRules: number;
  autoClassifyThreshold: number;
  prefillThreshold: number;
  suggestionThreshold: number;
  harmAsymmetry: "fp" | "fn" | "equal";
  enableLLMFallback: boolean;
}

/** LLM classification response */
export interface LLMClassificationResult {
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

/** LLM rule generation response */
export interface RuleSuggestionsResult {
  suggestions: RuleSuggestion[];
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

/** The rules an outcome was scored against, and those of them that matched,
 * by rule ID. */
export interface RuleScoring {
  ruleIds: readonly string[];
  matchedRuleIds: readonly string[];
}

/** Item that was auto-classified (tracked for undo functionality) */
export interface AutoClassifiedItem {
  input: ClassifiableInput;
  label: boolean;
  confidence: number;
  reasoning: string;
  matchedRules: string[];
  /** Absent from items stored before rule scorings were recorded. */
  scoring?: RuleScoring;
  tier: Tier;
  classifiedAt: number;
}

/** The parts of a `generateObject` call's state that a decision reads. */
export type Generation<T> = Pick<
  BuiltInLLMGenerateObjectState<T>,
  "pending" | "error" | "result"
>;

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
export function isRegexSafe(pattern: string): boolean {
  // Reject overly long patterns
  if (pattern.length > REGEX_MAX_PATTERN_LENGTH) {
    return false;
  }

  // Reject nested quantifiers, which can cause catastrophic backtracking:
  // patterns like (a+)+, (.*)+, (a*)*
  const nestedQuantifiers = /\([^)]*[+*][^)]*\)[+*]/;
  return !nestedQuantifiers.test(pattern);
}

/**
 * Compile a rule's regex after validation.
 * Returns null for invalid or potentially dangerous regex patterns.
 */
export function compileRuleRegex(
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
    return new RegExp(pattern, caseInsensitive ? "i" : "");
  } catch (e) {
    console.warn(
      `[Classifier] Invalid regex pattern "${pattern}": ${
        e instanceof Error ? e.message : "Unknown error"
      }`,
    );
    return null;
  }
}

// =============================================================================
// RULES
// =============================================================================

/** Generate a unique ID */
export function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

/**
 * A new tier-0 rule from a suggestion, or null, with the reason logged, when
 * the suggestion's pattern is not a valid regex or not a safe one.
 */
export function newRule(suggestion: RuleSuggestion): ClassificationRule | null {
  if (!compileRuleRegex(suggestion.pattern, true)) return null;
  return {
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
}

/** Validate a rule suggestion has valid structure */
export function isValidRuleSuggestion(s: unknown): s is RuleSuggestion {
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

/**
 * Calculate F1 score for a rule based on its metrics
 * F1 = 2 * (precision * recall) / (precision + recall)
 */
export function calculateF1(
  rule: Pick<ClassificationRule, "precision" | "recall"> | undefined,
): number {
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
 *
 * A rule with nothing to divide by scores 0.5.
 */
export function calculatePrecisionRecall(rule: {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}): { precision: number; recall: number } {
  const tp = rule.truePositives || 0;
  const fp = rule.falsePositives || 0;
  const fn = rule.falseNegatives || 0;

  return {
    precision: tp + fp > 0 ? tp / (tp + fp) : 0.5,
    recall: tp + fn > 0 ? tp / (tp + fn) : 0.5,
  };
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
export function calculateTier(
  rule: Pick<ClassificationRule, "precision" | "recall" | "evaluationCount">,
): Tier {
  const f1 = calculateF1(rule);
  const evals = rule.evaluationCount;

  if (evals >= 20 && f1 >= 0.95) return 4;
  if (evals >= 10 && f1 >= 0.85) return 3;
  if (evals >= 5 && f1 >= 0.70) return 2;
  if (evals >= 3 && f1 >= 0.50) return 1;
  return 0;
}

const TIER_LABELS = ["Silent", "Suggest", "Default", "Auto+Undo", "Automatic"];

/** Get human-readable tier label */
export function getTierLabel(tier: Tier | undefined): string {
  return TIER_LABELS[tier ?? 0] ?? TIER_LABELS[0];
}

const TIER_COLORS = [
  "var(--cf-colors-gray-400)",
  "var(--cf-colors-info)",
  "var(--cf-theme-color-success)",
  "var(--cf-theme-color-warning)",
  "var(--cf-theme-color-error)",
];

/** Get tier badge color */
export function getTierColor(tier: Tier | undefined): string {
  return TIER_COLORS[tier ?? 0] ?? TIER_COLORS[0];
}

/**
 * Score the rules `scoring` names against one outcome, `actual`, and
 * recalculate their precision, recall, and tier, leaving every other rule as
 * it is. A `step` of 1 records the outcome; a `step` of -1 takes back an
 * outcome recorded earlier with the same `scoring`, never counting below
 * zero.
 *
 * Confusion matrix for a rule:
 * - TP: rule matched AND rule.predicts === actual
 * - FP: rule matched AND rule.predicts !== actual
 * - TN: rule didn't match AND rule.predicts !== actual (would have been correct)
 * - FN: rule didn't match AND rule.predicts === actual (missed the correct prediction)
 */
export function scoreRules(
  rules: readonly ClassificationRule[],
  scoring: Readonly<RuleScoring>,
  actual: boolean,
  step: 1 | -1,
): ClassificationRule[] {
  const bump = (count: number) => Math.max(0, (count || 0) + step);
  return rules.map((rule) => {
    if (!scoring.ruleIds.includes(rule.id)) return rule;
    const matched = scoring.matchedRuleIds.includes(rule.id);
    const correct = rule.predicts === actual;
    const counts = {
      truePositives: rule.truePositives || 0,
      falsePositives: rule.falsePositives || 0,
      trueNegatives: rule.trueNegatives || 0,
      falseNegatives: rule.falseNegatives || 0,
    };
    const cell = matched
      ? (correct ? "truePositives" : "falsePositives")
      : (correct ? "falseNegatives" : "trueNegatives");
    counts[cell] = bump(counts[cell]);

    const scored = {
      ...rule,
      ...counts,
      ...calculatePrecisionRecall(counts),
      evaluationCount: bump(rule.evaluationCount),
    };
    return { ...scored, tier: calculateTier(scored) };
  });
}

/**
 * The rules `item` was scored against. An item stored without its scoring
 * was scored against every rule there was then, matched by name, so it is
 * taken to have been scored against every rule in `rules`, matching those
 * named in its `matchedRules`.
 */
export function scoringOf(
  item: {
    readonly matchedRules: readonly string[];
    readonly scoring?: Readonly<RuleScoring> | undefined;
  },
  rules: readonly ClassificationRule[],
): Readonly<RuleScoring> {
  return item.scoring ?? {
    ruleIds: rules.map((rule) => rule.id),
    matchedRuleIds: rules
      .filter((rule) => item.matchedRules.includes(rule.name))
      .map((rule) => rule.id),
  };
}

/**
 * Result of matching rules against an input
 */
export interface RuleMatchResult {
  matchedRules: string[];
  /** The rules matched against, and those that matched, by ID. */
  scoring: RuleScoring;
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
export function matchRulesAgainstInput(
  input: ClassifiableInput,
  rules: readonly ClassificationRule[],
  autoClassifyThreshold: number,
): RuleMatchResult {
  const matchedRules: string[] = [];
  const matchedRuleIds: string[] = [];
  const votes: RuleMatchResult["votes"] = [];

  for (const rule of rules) {
    const fieldValue = input.fields[rule.targetField];
    if (!fieldValue) continue;

    const regex = compileRuleRegex(rule.pattern, rule.caseInsensitive);
    if (regex && regex.test(fieldValue)) {
      matchedRules.push(rule.name);
      matchedRuleIds.push(rule.id);
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
      confidence = yesWeight / totalWeight;
    } else if (noWeight > yesWeight) {
      prediction = false;
      confidence = noWeight / totalWeight;
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
    scoring: { ruleIds: rules.map((rule) => rule.id), matchedRuleIds },
    prediction,
    confidence,
    highestTier,
    shouldAutoClassify,
    votes,
  };
}

// =============================================================================
// LLM CLASSIFICATION
// =============================================================================

/**
 * The prompt asking the model to classify `item`, with the three most recent
 * positive and negative examples for context. It carries the item's ID so the
 * model echoes it back.
 */
export function buildClassificationPrompt(
  item: ClassifiableInput,
  question: string,
  examples: readonly LabeledExample[],
): string {
  const recentPositive = examples.filter((e) => e.label).slice(-3);
  const recentNegative = examples.filter((e) => !e.label).slice(-3);

  let prompt = `Item ID: ${item.id}\n\n`;
  prompt += `Question: ${question || "Is this a positive example?"}\n\n`;
  prompt += `Input to classify:\n${JSON.stringify(item.fields, null, 2)}\n\n`;

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
}

/**
 * Why the model gave no usable classification of the item with `itemId`, or
 * null when it gave one, `classification`, or may still give one. The call
 * failed, or `deriveClassification` rejected an answer the model gave for
 * this item or without saying which item. Until the call for the item
 * starts, the state shows no error and either no result or the previous
 * item's result, and that is not a failure.
 */
export function classificationFailure(
  llm: Generation<Partial<Record<keyof LLMClassificationResult, unknown>>>,
  itemId: string,
  classification: ClassificationResult | null,
): string | null {
  if (classification || llm.pending) return null;
  if (llm.error) return llm.error;
  const answer = llm.result;
  return answer && (!answer.itemId || answer.itemId === itemId)
    ? "the model's answer could not be used"
    : null;
}

/**
 * The classification of `item` once the model has answered, or null while
 * the model has not answered, when the answer is for another item, or when
 * the answer is malformed (logged). The answer is model output, so no field
 * of it is trusted to have its declared type. Rules that match with at least
 * `autoClassifyThreshold` confidence decide over the model.
 */
export function deriveClassification(
  llm: Generation<Partial<Record<keyof LLMClassificationResult, unknown>>>,
  item: ClassifiableInput,
  rules: readonly ClassificationRule[],
  autoClassifyThreshold: number,
): ClassificationResult | null {
  if (llm.pending || llm.error) return null;
  const answer = llm.result;
  if (!answer || !answer.itemId) return null;

  if (item.id !== answer.itemId) {
    console.warn(
      `[Classifier] Item ID mismatch: expected ${item.id}, got ${answer.itemId}`,
    );
    return null;
  }
  if (typeof answer.classification !== "boolean") {
    console.warn(
      `[Classifier] Invalid classification type: expected boolean, got ${typeof answer
        .classification}`,
    );
    return null;
  }
  if (
    typeof answer.confidence !== "number" ||
    answer.confidence < 0 ||
    answer.confidence > 1
  ) {
    console.warn(
      `[Classifier] Invalid confidence: expected number between 0 and 1, got ${answer.confidence}`,
    );
    return null;
  }
  if (typeof answer.reasoning !== "string" || answer.reasoning.trim() === "") {
    console.warn(`[Classifier] Invalid reasoning: expected non-empty string`);
    return null;
  }

  const threshold = autoClassifyThreshold ?? 0.85;
  const rulesResult = matchRulesAgainstInput(item, rules, threshold);
  const matchedRules = rulesResult.matchedRules;

  if (
    rulesResult.prediction !== null && rulesResult.confidence >= threshold
  ) {
    return {
      inputId: item.id,
      classification: rulesResult.prediction,
      confidence: rulesResult.confidence,
      reasoning: `Rules matched: ${matchedRules.join(", ")}`,
      decidedBy: "rules",
      matchedRules,
    };
  }
  return {
    inputId: item.id,
    classification: answer.classification,
    confidence: answer.confidence,
    reasoning: answer.reasoning,
    decidedBy: "llm",
    matchedRules,
  };
}

// =============================================================================
// LLM RULE GENERATION
// =============================================================================

/**
 * The prompt asking the model for regex rules, or "" when there is too little
 * to learn from: fewer than `minExamplesForRules` examples, or no corrections
 * and fewer than two interesting examples.
 */
export function buildRuleGenerationPrompt(
  examples: readonly LabeledExample[],
  config: Pick<ClassifierConfig, "question" | "minExamplesForRules">,
): string {
  if (examples.length < (config.minExamplesForRules || 5)) return "";

  const corrections = examples.filter((e) => e.wasCorrection);
  const interestingExamples = examples.filter((e) => e.isInteresting);
  if (corrections.length === 0 && interestingExamples.length < 2) return "";

  const allFields = new Set(
    examples.flatMap((ex) => Object.keys(ex.input.fields)),
  );
  const question = config.question || "Is this a positive example?";
  const positiveExamples = examples.filter((e) => e.label).slice(-5);
  const negativeExamples = examples.filter((e) => !e.label).slice(-5);

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

  prompt += `Generate 1-3 regex patterns that could help classify future inputs.
Each rule should:
1. Target a specific field
2. Use a simple regex pattern (avoid overly complex patterns)
3. Be specific enough to avoid false positives
4. Explain why this pattern indicates the classification`;

  return prompt;
}

/**
 * The model's valid suggestions that have not been dismissed, each with its
 * index in the model's answer. Invalid suggestions are logged and left out.
 */
export function selectVisibleSuggestions(
  generation: Generation<RuleSuggestionsResult>,
  dismissed: readonly number[],
): Array<{ suggestion: RuleSuggestion; originalIndex: number }> {
  if (generation.pending || generation.error) return [];
  const suggestions = generation.result?.suggestions ?? [];
  return [...suggestions]
    .map((suggestion, originalIndex) => ({ suggestion, originalIndex }))
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
}

// =============================================================================
// EXAMPLES
// =============================================================================

/** A plain copy of `input`, detached from any cell it was read from. */
function copyInput(input: ClassifiableInput): ClassifiableInput {
  return {
    id: input.id,
    receivedAt: input.receivedAt,
    fields: { ...input.fields },
  };
}

/**
 * The example recorded when the user accepts a prediction. A prediction made
 * with less than 0.7 confidence is marked interesting.
 */
export function acceptedExample(
  input: ClassifiableInput,
  prediction: Pick<
    ClassificationResult,
    "classification" | "confidence" | "reasoning"
  >,
): LabeledExample {
  const lowConfidence = prediction.confidence < 0.7;
  return {
    input: copyInput(input),
    label: prediction.classification,
    decidedBy: "suggestion-accepted",
    reasoning: prediction.reasoning,
    confidence: prediction.confidence,
    labeledAt: Date.now(),
    wasCorrection: false,
    isInteresting: lowConfidence,
    ...(lowConfidence &&
      { interestingReason: "Low confidence, user confirmed" }),
  };
}

/**
 * The example recorded when the user overrules `originalPrediction` with
 * `label`.
 */
export function correctedExample(
  input: ClassifiableInput,
  originalPrediction: boolean,
  label: boolean,
  reasoning: string,
): LabeledExample {
  return {
    input: copyInput(input),
    label,
    decidedBy: "user",
    reasoning,
    confidence: 1.0,
    labeledAt: Date.now(),
    wasCorrection: true,
    originalPrediction,
    isInteresting: true,
    interestingReason: "User corrected classification",
  };
}

/** A classification as the view shows it. */
export interface VerdictView {
  answer: "YES" | "NO";
  opposite: "YES" | "NO";
  color: string;
  confidencePercent: string;
  decidedBy: string;
  reasoning: string;
}

/** How the view shows `result`, or a blank NO when there is none. */
export function viewVerdict(
  result:
    | Pick<
      ClassificationResult,
      "classification" | "confidence" | "decidedBy" | "reasoning"
    >
    | null
    | undefined,
): VerdictView {
  const yes = result?.classification ?? false;
  return {
    answer: yes ? "YES" : "NO",
    opposite: yes ? "NO" : "YES",
    color: yes
      ? "var(--cf-theme-color-success)"
      : "var(--cf-theme-color-error)",
    confidencePercent: ((result?.confidence ?? 0) * 100).toFixed(0),
    decidedBy: result?.decidedBy ?? "",
    reasoning: result?.reasoning ?? "",
  };
}

/** A one-line preview of an input's first field, or "(empty)". */
export function previewFields(fields: Record<string, string>): string {
  const first = Object.entries(fields)[0];
  return first ? `${first[0]}: ${first[1].substring(0, 30)}...` : "(empty)";
}
