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
  generateObject,
  handler,
  ifElse,
  lift,
  NAME,
  pattern,
  Stream,
  toIndentedDebugString,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  acceptedExample,
  type AutoClassifiedItem,
  buildClassificationPrompt,
  buildRuleGenerationPrompt,
  calculateF1,
  type ClassifiableInput,
  classificationFailure,
  type ClassificationResult,
  type ClassificationRule,
  type ClassifierConfig,
  correctedExample,
  deriveClassification,
  generateId,
  getTierColor,
  getTierLabel,
  type LabeledExample,
  type LLMClassificationResult,
  matchRulesAgainstInput,
  newRule,
  type PendingClassification,
  previewFields,
  type RuleSuggestion,
  type RuleSuggestionsResult,
  scoreRules,
  scoringOf,
  selectVisibleSuggestions,
  viewVerdict,
} from "./classifier-logic.ts";

export type {
  ClassifiableInput,
  ClassificationResult,
  ClassificationRule,
  LabeledExample,
  PendingClassification,
  RuleSuggestion,
} from "./classifier-logic.ts";

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
  // Classifications awaiting the user's confirmation, settled through the view
  // or the confirm, correct, and dismiss streams
  pendingClassifications: Writable<PendingClassification[] | Default<[]>>;
  // The item currently being classified (null when idle)
  // Only one item can be classified at a time
  currentItem: Writable<ClassifiableInput | null | Default<null>>;
}

/** Self-improving binary classifier with LLM + regex rules. #classifier #learning */
export interface ClassifierOutput {
  [NAME]: string;
  [UI]: VNode;
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

// =============================================================================
// STATISTICS
// =============================================================================

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
      // An auto-classification the user has reviewed since still counts as
      // one, and the correction rate is the share of those the user
      // corrected; corrections of the model's predictions do not count
      if (e.decidedBy === "auto" || e.reviewedAutoClassification) acc.auto++;
      if (e.reviewedAutoClassification && e.wasCorrection) acc.corrections++;
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
const getExamplePreview = lift((example: LabeledExample): string =>
  example?.input?.fields ? previewFields(example.input.fields) : "(invalid)"
);

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
// These handlers receive the row's ID as state at render time, and find the
// row by that ID when they run.
// =============================================================================

/**
 * Records the example `decide` makes of the classification pending for
 * `inputId`, and takes it off the queue. Does nothing when none is pending.
 */
function settlePending(
  pendingClassifications: Writable<PendingClassification[]>,
  examples: Writable<LabeledExample[]>,
  inputId: string,
  decide: (item: PendingClassification) => LabeledExample,
): void {
  const pending = pendingClassifications.get();
  const item = pending.find((p) => p.input.id === inputId);
  if (!item) return;
  examples.push(decide(item));
  dropPending(pendingClassifications, inputId);
}

/** Takes the classification pending for `inputId` off the queue. */
function dropPending(
  pendingClassifications: Writable<PendingClassification[]>,
  inputId: string,
): void {
  pendingClassifications.set(
    pendingClassifications.get().filter((p) => p.input.id !== inputId),
  );
}

/** Removes the rule with `ruleId`. */
function dropRule(
  rules: Writable<ClassificationRule[]>,
  ruleId: string,
): void {
  rules.set(rules.get().filter((r) => r.id !== ruleId));
}

/** The example recording the user's agreement with a pending prediction. */
const confirmPending = (item: PendingClassification) =>
  acceptedExample(item.input, item.result);

/** Confirm a pending classification (user agrees with the prediction) */
const confirmPendingClassification = handler<
  unknown,
  {
    inputId: string;
    examples: Writable<LabeledExample[]>;
    pendingClassifications: Writable<PendingClassification[]>;
  }
>((_event, { inputId, examples, pendingClassifications }) =>
  settlePending(pendingClassifications, examples, inputId, confirmPending)
);

/** Correct a pending classification (user disagrees with the prediction) */
const correctPendingClassification = handler<
  unknown,
  {
    inputId: string;
    examples: Writable<LabeledExample[]>;
    pendingClassifications: Writable<PendingClassification[]>;
  }
>((_event, { inputId, examples, pendingClassifications }) =>
  settlePending(
    pendingClassifications,
    examples,
    inputId,
    (item) =>
      correctedExample(
        item.input,
        item.result.classification,
        !item.result.classification,
        "User correction",
      ),
  )
);

/** Dismiss a pending classification without recording it */
const dismissPendingClassification = handler<
  unknown,
  {
    inputId: string;
    pendingClassifications: Writable<PendingClassification[]>;
  }
>((_event, { inputId, pendingClassifications }) =>
  dropPending(pendingClassifications, inputId)
);

/** Remove a rule from the rules list */
const removeRuleHandler = handler<
  unknown,
  {
    ruleId: string;
    rules: Writable<ClassificationRule[]>;
  }
>((_event, { ruleId, rules }) => dropRule(rules, ruleId));

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
export const undoAutoClassificationHandler = handler<
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
    // One undone item awaits review at a time; undoing another now would
    // replace it, and it is already out of the examples and the metrics
    if (undoneAutoItem.get() !== null) {
      console.warn(
        "[Classifier] An undone item awaits review, cannot undo another",
      );
      return;
    }

    const inputId = autoItem.input.id;

    // Remove from examples
    const examplesList = examples.get();
    examples.set(examplesList.filter((ex) => ex.input.id !== inputId));

    // Remove from recent auto-classified
    const autoItems = recentAutoClassified.get();
    recentAutoClassified.set(autoItems.filter((a) => a.input.id !== inputId));

    // Take back the rule metrics the auto-classification recorded, from the
    // rules it recorded them against
    const rulesVal = rules.get();
    const scoring = scoringOf(autoItem, rulesVal);
    rules.set(scoreRules(rulesVal, scoring, autoItem.label, -1));

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
      scoring: {
        ruleIds: [...scoring.ruleIds],
        matchedRuleIds: [...scoring.matchedRuleIds],
      },
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
        scoring: ruleMatch.scoring,
        tier: ruleMatch.highestTier,
        classifiedAt: Date.now(),
      };
      recentAutoClassified.set(
        [autoItem, ...recentAutoClassified.get()].slice(0, 10),
      );

      // Record the outcome against every rule's metrics
      rules.set(
        scoreRules(rulesVal, ruleMatch.scoring, ruleMatch.prediction, 1),
      );

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
>(({ inputId }, { pendingClassifications, examples }) =>
  settlePending(pendingClassifications, examples, inputId, confirmPending)
);

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
) =>
  settlePending(
    pendingClassifications,
    examples,
    inputId,
    (item) =>
      correctedExample(
        item.input,
        item.result.classification,
        correctLabel,
        reasoning || "User correction",
      ),
  )
);

/** Dismiss a classification without recording it - for API use */
const dismissClassificationHandler = handler<
  { inputId: string },
  {
    pendingClassifications: Writable<PendingClassification[]>;
  }
>(({ inputId }, { pendingClassifications }) =>
  dropPending(pendingClassifications, inputId)
);

/** Add a new rule */
const addRuleHandler = handler<
  RuleSuggestion,
  {
    rules: Writable<ClassificationRule[]>;
  }
>((event, { rules }) => {
  const rule = newRule(event);
  if (rule) rules.push(rule);
});

/** Remove a rule */
const removeRuleActionHandler = handler<
  { ruleId: string },
  {
    rules: Writable<ClassificationRule[]>;
  }
>(({ ruleId }, { rules }) => dropRule(rules, ruleId));

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
  const rule = newRule(suggestion);
  if (!rule) return;
  rules.push(rule);

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

  examples.push(acceptedExample(result.item, result.classification));
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

  const original = result.classification.classification;
  examples.push(
    correctedExample(
      result.item,
      original,
      !original,
      "User corrected classification",
    ),
  );
  currentItem.set(null);
});

/** Accept the undone item's classification (user agrees with the original rules-based result) */
export const acceptUndoneClassificationHandler = handler<
  void,
  {
    undoneAutoItem: Writable<AutoClassifiedItem | null>;
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
    reviewedAutoClassification: true,
  });

  // Record the rules' original prediction as the outcome
  const rulesVal = rules.get();
  rules.set(
    scoreRules(rulesVal, scoringOf(undone, rulesVal), undone.label, 1),
  );

  undoneAutoItem.set(null);
});

/** Correct the undone item's classification (user disagrees with the original rules-based result) */
export const correctUndoneClassificationHandler = handler<
  void,
  {
    undoneAutoItem: Writable<AutoClassifiedItem | null>;
    examples: Writable<LabeledExample[]>;
    rules: Writable<ClassificationRule[]>;
  }
>((_event, { undoneAutoItem, examples, rules }) => {
  const undone = undoneAutoItem.get();
  if (!undone) return;

  // The user is correcting - the actual label is the OPPOSITE of what rules predicted
  const actual = !undone.label;

  examples.push({
    ...correctedExample(
      undone.input,
      undone.label,
      actual,
      "User corrected classification",
    ),
    reviewedAutoClassification: true,
  });

  // Record the corrected label as the outcome: matched rules that predicted
  // the original label count as false positives
  const rulesVal = rules.get();
  rules.set(scoreRules(rulesVal, scoringOf(undone, rulesVal), actual, 1));

  undoneAutoItem.set(null);
});

/** Dismiss the undone item without storing it */
const dismissUndoneItemHandler = handler<
  void,
  {
    undoneAutoItem: Writable<AutoClassifiedItem | null>;
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
      return item
        ? buildClassificationPrompt(
          item,
          config.get()?.question ?? "",
          examples.get(),
        )
        : "";
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
      const item = currentItem.get();
      if (!item) return null;
      const classification = deriveClassification(
        llmResult,
        item,
        rules.get(),
        (config.get() || DEFAULT_CONFIG).autoClassifyThreshold,
      );
      return classification ? { item, classification } : null;
    });

    // Helper computed to check if we have a classification result ready
    const hasClassificationResult = computed(
      () => currentClassificationResult !== null,
    );

    // Why the model gave no usable classification of the current item, or
    // null while it may still give one
    const currentFailure = computed(() => {
      const item = currentItem.get();
      return item
        ? classificationFailure(
          llmResult,
          item.id,
          currentClassificationResult?.classification ?? null,
        )
        : null;
    });

    // The current classification as the view shows it
    const currentVerdict = computed(() =>
      viewVerdict(currentClassificationResult?.classification)
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
      // Read counter to establish dependency (forces regeneration when incremented)
      ruleGenCounter.get();
      const configVal = config.get();
      return configVal
        ? buildRuleGenerationPrompt(examples.get(), configVal)
        : "";
    });

    // LLM rule generation - only runs when there's a prompt
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
    const visibleSuggestions = computed(() =>
      selectVisibleSuggestions(
        ruleGenResult,
        dismissedSuggestionIndices.get(),
      )
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
                              color: currentVerdict.color,
                            }}
                          >
                            {currentVerdict.answer}
                          </span>
                          <span style="color: var(--cf-colors-gray-500); font-size: 0.875rem;">
                            ({currentVerdict.confidencePercent}% confidence via
                            {" "}
                            {currentVerdict.decidedBy})
                          </span>
                        </cf-hstack>

                        <span style="font-size: 0.875rem; color: var(--cf-colors-gray-600);">
                          {currentVerdict.reasoning}
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
                            Actually {currentVerdict.opposite}
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
                      // No usable result: the call failed, the answer was
                      // rejected, or the model is still working (or has not
                      // started). Either way the item can be dismissed,
                      // which frees the classifier
                      <cf-hstack gap="2" align="center">
                        {ifElse(
                          computed(() => currentFailure !== null),
                          <span style="flex: 1; color: var(--cf-theme-color-error);">
                            Classification failed: {currentFailure}
                          </span>,
                          <cf-hstack gap="2" align="center" style="flex: 1;">
                            <cf-loader size="sm" />
                            <span style="font-weight: 500;">
                              Classifying...
                            </span>
                          </cf-hstack>,
                        )}
                        <cf-button
                          color="neutral"
                          variant="ghost"
                          onClick={dismissCurrentItem}
                        >
                          Dismiss
                        </cf-button>
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
                        ({computed(() => (
                          (undoneAutoItem.get()?.confidence ?? 0) * 100
                        ).toFixed(0))}% confidence via rules - Tier{" "}
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
                                inputId: pending.input.id,
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
                                inputId: pending.input.id,
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
                                inputId: pending.input.id,
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
                          onClick={removeRuleHandler({
                            ruleId: rule.id,
                            rules,
                          })}
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
                          {computed(() => previewFields(autoItem.input.fields))}
                        </span>
                        <cf-button
                          color="neutral"
                          variant="outline"
                          size="sm"
                          disabled={computed(() =>
                            undoneAutoItem.get() !== null
                          )}
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
