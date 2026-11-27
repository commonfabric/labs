/**
 * Test Pattern: Self-Improving Classifier rule suggestions
 *
 * Shows the rules the model suggests once there are enough examples to learn
 * from. Accepting a suggestion adds it as a new rule and hides it, unless its
 * pattern is unsafe, which adds nothing; rejecting one hides it; refreshing
 * shows every suggestion again.
 *
 * Pattern under test: ./main.tsx
 */
import { assert, pattern, TESTS, UI } from "commonfabric";
import {
  CONFIG,
  labeledExample,
  showsAll,
  showsNone,
} from "./classifier-test-fixture.ts";
import SelfImprovingClassifier from "./main.tsx";

export const llmMocks = [
  {
    when: { systemContains: "pattern recognition expert" },
    object: {
      suggestions: [
        {
          name: "Invoice word",
          targetField: "subject",
          pattern: "invoice",
          predicts: true,
          reasoning: "Invoices are bills",
        },
        {
          name: "Party word",
          targetField: "subject",
          pattern: "party",
          predicts: false,
          reasoning: "Parties are not bills",
        },
        {
          name: "Nested repeat",
          targetField: "subject",
          pattern: "(a+)+",
          predicts: true,
          reasoning: "Repeated letters",
        },
      ],
    },
    repeat: true,
  },
];

// Each suggestion's reasoning, which only its card shows
const INVOICE = "Invoices are bills";
const PARTY = "Parties are not bills";
const NESTED = "Repeated letters";

export default pattern(() => {
  const subject = SelfImprovingClassifier({
    config: { ...CONFIG, question: "Is this a bill?" },
    // Five examples, one of them a correction, are enough to learn from
    examples: [
      labeledExample("e-invoice", "Invoice 1"),
      labeledExample("e-rent", "Rent due"),
      labeledExample("e-party", "Party invite", { label: false }),
      labeledExample("e-lunch", "Lunch plans", { label: false }),
      labeledExample("e-news", "Newsletter", {
        label: false,
        decidedBy: "user",
        wasCorrection: true,
        originalPrediction: true,
        isInteresting: true,
      }),
    ],
    rules: [],
    pendingClassifications: [],
    currentItem: null,
  });

  // === Assertions ===

  const assert_all_suggested = assert(() =>
    showsAll(subject[UI], [
      "Suggested Rules",
      INVOICE,
      PARTY,
      NESTED,
      "subject: /party/ → NO",
    ]) && subject.rules.length === 0
  );
  const assert_invoice_rule_added = assert(() =>
    subject.rules.length === 1 &&
    subject.rules[0]?.name === "Invoice word" &&
    subject.rules[0]?.pattern === "invoice" &&
    subject.rules[0]?.predicts === true &&
    subject.rules[0]?.tier === 0 &&
    showsNone(subject[UI], [INVOICE]) &&
    showsAll(subject[UI], [PARTY, NESTED])
  );
  const assert_unsafe_rule_refused = assert(() =>
    subject.rules.length === 1 &&
    showsAll(subject[UI], [PARTY, NESTED])
  );
  const assert_party_rejected = assert(() =>
    subject.rules.length === 1 &&
    showsNone(subject[UI], [INVOICE, PARTY]) &&
    showsAll(subject[UI], [NESTED])
  );
  const assert_all_shown_again = assert(() =>
    subject.rules.length === 1 &&
    showsAll(subject[UI], [INVOICE, PARTY, NESTED])
  );

  return {
    [TESTS]: [
      { assertion: assert_all_suggested },
      { press: subject[UI], control: "Accept", within: INVOICE },
      { assertion: assert_invoice_rule_added },
      { press: subject[UI], control: "Accept", within: NESTED },
      { assertion: assert_unsafe_rule_refused },
      { press: subject[UI], control: "Reject", within: PARTY },
      { assertion: assert_party_rejected },
      { press: subject[UI], control: "Refresh" },
      { assertion: assert_all_shown_again },
    ],
    subject,
    // Accepting the unsafe suggestion logs why it adds no rule
    allowConsoleWarnings: true,
  };
});
