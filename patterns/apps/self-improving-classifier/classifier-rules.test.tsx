/**
 * Test Pattern: Self-Improving Classifier rules
 *
 * Shows each rule's tier and metrics, matches an item against rules that
 * tie, skipping rules whose patterns are dangerous or invalid, and adds and
 * removes rules through the API and the view.
 *
 * Pattern under test: ./self-improving-classifier.tsx
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  CONFIG,
  INVOICE_RULE,
  showsAll,
  showsNone,
  statsText,
} from "./classifier-test-fixture.ts";
import SelfImprovingClassifier from "./self-improving-classifier.tsx";

export default pattern(() => {
  const subject = SelfImprovingClassifier({
    // Low enough that a tie, at 0.5 confidence, auto-classifies
    config: { ...CONFIG, autoClassifyThreshold: 0.5 },
    examples: [],
    rules: [
      INVOICE_RULE,
      {
        ...INVOICE_RULE,
        id: "rule-greeting-yes",
        name: "Greeting yes",
        pattern: "hello",
        precision: 0.6,
        tier: 3,
      },
      {
        ...INVOICE_RULE,
        id: "rule-greeting-no",
        name: "Greeting no",
        pattern: "hello",
        predicts: false,
        precision: 0.6,
      },
      { ...INVOICE_RULE, id: "rule-nested", name: "Nested", pattern: "(.*)+" },
      { ...INVOICE_RULE, id: "rule-broken", name: "Broken", pattern: "[" },
    ],
    pendingClassifications: [],
    currentItem: null,
  });

  // === Actions ===

  const action_submit_greeting = action(() =>
    subject.submitItem.send({ fields: { subject: "hello there" } })
  );

  // The second rule's pattern is not a regex, and the third's could backtrack
  // catastrophically, so both are refused.
  const action_add_rules = action(() => {
    subject.addRule.send({
      name: "Statement word",
      targetField: "subject",
      pattern: "statement",
      predicts: true,
      reasoning: "Statements are bills",
    });
    subject.addRule.send({
      name: "Unclosed",
      targetField: "subject",
      pattern: "(",
      predicts: true,
      reasoning: "Not a regex",
    });
    subject.addRule.send({
      name: "Nested again",
      targetField: "subject",
      pattern: "(a+)+",
      predicts: true,
      reasoning: "Backtracks",
    });
  });
  const action_remove_seeded_rules = action(() => {
    for (
      const ruleId of [
        "rule-invoice",
        "rule-greeting-yes",
        "rule-greeting-no",
        "rule-nested",
        "rule-broken",
      ]
    ) {
      subject.removeRule.send({ ruleId });
    }
  });

  // === Assertions ===

  const assert_rule_rows = assert(() =>
    showsAll(subject[UI], [
      "Classification Rules",
      "T4",
      "Invoice word",
      "subject: /invoice/i → YES",
      "P: 100% | F1: 100% | 30 evals | Automatic",
      "T3",
      "subject: /hello/i → NO",
    ])
  );

  // The two greeting rules carry equal weight, so the higher-tier one, which
  // says NO, decides; the nested and broken rules match nothing.
  const assert_tie_broken_by_tier = assert(() =>
    subject.examples.length === 1 &&
    subject.examples[0]?.label === false &&
    subject.examples[0]?.confidence === 0.5 &&
    subject.examples[0]?.reasoning ===
      "Auto-classified by Tier 4 rule(s): Greeting yes, Greeting no"
  );

  const assert_rules_added = assert(() =>
    subject.rules.length === 6 &&
    subject.rules[5]?.name === "Statement word" &&
    subject.rules[5]?.tier === 0 &&
    statsText(subject[UI]).endsWith("6Rules")
  );
  const assert_seeded_rules_removed = assert(() =>
    subject.rules.map((r) => r.name).join() === "Statement word" &&
    showsAll(subject[UI], ["T0", "statement/i → YES", "0 evals | Silent"])
  );
  const assert_rules_empty = assert(() =>
    subject.rules.length === 0 &&
    showsNone(subject[UI], ["Classification Rules"])
  );

  return {
    [TESTS]: [
      { assertion: assert_rule_rows },
      { action: action_submit_greeting },
      { assertion: assert_tie_broken_by_tier },
      { action: action_add_rules },
      { assertion: assert_rules_added },
      { action: action_remove_seeded_rules },
      { assertion: assert_seeded_rules_removed },
      { press: subject[UI], control: "x", within: "Statement word" },
      { assertion: assert_rules_empty },
    ],
    subject,
    // The dangerous and broken patterns are skipped, and the rules whose
    // patterns are not regexes or not safe ones are refused, with warnings.
    allowConsoleWarnings: true,
  };
});
