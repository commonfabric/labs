/**
 * Test Pattern: Self-Improving Classifier
 *
 * Tests the tier-based auto-classification functionality:
 * - Auto-classification when tier 3-4 rules match
 * - Rule metric updates after classification
 *
 * Pattern under test: ./self-improving-classifier.tsx
 *
 * Note: This test uses module-scoped handlers with explicit state parameters
 * instead of action() with closures to avoid "reactive reference outside
 * reactive context" errors when accessing proxy objects like subject.submitItem.
 */
import { assert, Cell, handler, pattern, Stream, TESTS } from "commonfabric";
import SelfImprovingClassifier, {
  type ClassificationRule,
  type LabeledExample,
  type PendingClassification,
} from "./self-improving-classifier.tsx";

// Handler to set up a tier 4 rule
const setupTier4Rule = handler<
  void,
  { rules: Cell<unknown[]> }
>((_event, { rules }) => {
  rules.set([{
    id: "rule1",
    name: "Invoice Pattern",
    targetField: "subject",
    pattern: "invoice|statement|payment due",
    caseInsensitive: true,
    predicts: true,
    precision: 0.95,
    recall: 0.8,
    tier: 4,
    evaluationCount: 50,
    truePositives: 40,
    falsePositives: 2,
    trueNegatives: 8,
    falseNegatives: 0,
    createdAt: Date.now(),
    isShared: false,
  }]);
});

// Handler to set classifier config
const setupConfig = handler<
  void,
  { config: Cell<unknown> }
>((_event, { config }) => {
  config.set({
    question: "Is this email a bill?",
    minExamplesForRules: 5,
    autoClassifyThreshold: 0.85,
    prefillThreshold: 0.7,
    suggestionThreshold: 0.5,
    harmAsymmetry: "equal",
    enableLLMFallback: true,
  });
});

// Handler to clear examples
const clearExamples = handler<
  void,
  { examples: Cell<unknown[]> }
>((_event, { examples }) => {
  examples.set([]);
});

// Handler to submit items via stream - avoids reactive context issue with action()
// By receiving the stream as explicit state instead of via closure capture,
// we avoid the "reactive reference outside reactive context" error
const submitItem = handler<
  void,
  {
    stream: Stream<{ fields: Record<string, string> }>;
    fields: Record<string, string>;
  }
>((_event, { stream, fields }) => {
  stream.send({ fields });
});

export default pattern(() => {
  // 1. Instantiate the classifier with empty initial state
  const subject = SelfImprovingClassifier({
    config: new Cell({
      question: "",
      minExamplesForRules: 5,
      autoClassifyThreshold: 0.85,
      prefillThreshold: 0.7,
      suggestionThreshold: 0.5,
      harmAsymmetry: "equal" as const,
      enableLLMFallback: true,
    }),
    examples: new Cell<LabeledExample[]>([]),
    rules: new Cell<ClassificationRule[]>([]),
    pendingClassifications: new Cell<PendingClassification[]>([]),
    currentItem: new Cell(null),
  });

  // Bind setup handlers
  const action_setup_config = setupConfig({ config: subject.config });
  const action_setup_tier4_rule = setupTier4Rule({ rules: subject.rules });
  const action_clear_examples = clearExamples({ examples: subject.examples });

  // ============= TEST ACTIONS =============
  // Use bound handlers instead of action() to avoid reactive context issues.
  // The stream is accessed here in the pattern body (reactive context) and
  // passed as explicit state to the handler.

  const action_submit_matching_item = submitItem({
    stream: subject.submitItem,
    fields: {
      subject: "Your Invoice #12345",
      body: "Please pay by January 15th",
    },
  });

  const action_submit_non_matching_item = submitItem({
    stream: subject.submitItem,
    fields: {
      subject: "Hello from a friend",
      body: "Just wanted to say hi!",
    },
  });

  // ============= ASSERTIONS =============

  // Initial state assertions
  const assert_initial_examples_empty = assert(() => {
    return subject.examples.length === 0;
  });

  const assert_initial_rules_empty = assert(() => {
    return subject.rules.length === 0;
  });

  // After setup assertions
  const assert_config_set = assert(() => {
    return subject.config.question === "Is this email a bill?";
  });

  const assert_rule_added = assert(() => {
    return subject.rules.length === 1 &&
      subject.rules[0].name === "Invoice Pattern";
  });

  // After submitting matching item - check first example is auto-classified
  const assert_auto_classified = assert(() => {
    if (subject.examples.length === 0) return false;
    const example = subject.examples[0];
    return (
      example.decidedBy === "auto" &&
      example.label === true &&
      example.reasoning.includes("Tier 4")
    );
  });

  // Stats should reflect auto-classification
  const assert_stats_updated = assert(() => {
    return subject.stats.totalExamples === 1 &&
      subject.stats.autoClassified === 1;
  });

  // After clearing and submitting non-matching item
  // Non-matching items go to LLM path, not auto-classified
  // In test environment without LLM, examples should remain empty
  const assert_examples_still_empty_after_non_match = assert(() => {
    return subject.examples.length === 0;
  });

  // After auto-classification, rule metrics should be higher than the initial values
  // Initial rule was set with evaluationCount: 50, truePositives: 40
  // After two successful auto-classifications, should be 52 and 42
  const assert_rule_metrics_updated = assert(() => {
    if (subject.rules.length === 0) return false;
    const rule = subject.rules[0];
    // Check metrics are higher than initial values (50 and 40)
    return rule.evaluationCount > 50 && rule.truePositives > 40;
  });

  // Return tests array using discriminated union format
  return {
    [TESTS]: [
      // Test 1: Initial state is empty
      { assertion: assert_initial_examples_empty },
      { assertion: assert_initial_rules_empty },

      // Test 2: Setup config and rule
      { action: action_setup_config },
      { assertion: assert_config_set },
      { action: action_setup_tier4_rule },
      { assertion: assert_rule_added },

      // Test 3: Auto-classification works for matching items
      { action: action_submit_matching_item },
      { assertion: assert_auto_classified },
      { assertion: assert_stats_updated },

      // Test 4: Non-matching items don't auto-classify
      { action: action_clear_examples },
      { action: action_submit_non_matching_item },
      { assertion: assert_examples_still_empty_after_non_match },

      // Test 5: Rule metrics update after auto-classification
      { assertion: assert_rule_metrics_updated },
    ],
    // Expose subject for debugging when deployed as piece
    subject,
    // generateObject has no LLM endpoint in the unit-test environment; the
    // llm builtin warns ("Invalid URL: '//api/ai/llm/generateObject'").
    allowConsoleWarnings: true,
  };
});
