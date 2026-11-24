/**
 * Test Pattern: Self-Improving Classifier undo and manual review
 *
 * Undoes auto-classifications and settles the manual review by accepting the
 * rules' prediction and by correcting it, checking the rule's metrics and the
 * correction rate after each. The seeded correction is of a model prediction,
 * so the correction rate leaves it out.
 *
 * Pattern under test: ./self-improving-classifier.tsx
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  CONFIG,
  INVOICE_RULE,
  labeledExample,
  showsAll,
  showsNone,
} from "./classifier-test-fixture.ts";
import SelfImprovingClassifier from "./self-improving-classifier.tsx";

export default pattern(() => {
  const subject = SelfImprovingClassifier({
    config: CONFIG,
    examples: [
      labeledExample("e-lunch", "Lunch plans", {
        label: false,
        decidedBy: "user",
        wasCorrection: true,
        originalPrediction: true,
      }),
    ],
    rules: [INVOICE_RULE],
    pendingClassifications: [],
    currentItem: null,
  });

  // === Actions ===

  const action_submit_invoice_77 = action(() =>
    subject.submitItem.send({ fields: { subject: "Invoice 77" } })
  );
  const action_submit_invoice_88 = action(() =>
    subject.submitItem.send({ fields: { subject: "Invoice 88" } })
  );
  // === Assertions ===

  const assert_invoice_77_auto = assert(() =>
    subject.examples.length === 2 &&
    subject.examples[1]?.decidedBy === "auto" &&
    subject.examples[1]?.reasoning ===
      "Auto-classified by Tier 4 rule(s): Invoice word" &&
    subject.rules[0]?.evaluationCount === 31 &&
    showsAll(subject[UI], [
      "Auto-Classified",
      "T4",
      "subject: Invoice 77...",
      "Correction rate: 0.0%",
    ])
  );
  const assert_invoice_77_in_review = assert(() =>
    subject.examples.length === 1 &&
    subject.rules[0]?.evaluationCount === 30 &&
    subject.rules[0]?.truePositives === 30 &&
    showsAll(subject[UI], [
      "(undone auto-classification)",
      "Invoice 77",
      "(100% confidence via rules - Tier 4)",
      "Auto-classified by Tier 4 rule(s): Invoice word",
      "Actually NO",
    ]) &&
    showsNone(subject[UI], ["Auto-Classified", "Correction rate"])
  );
  const assert_invoice_77_accepted = assert(() =>
    subject.examples.length === 2 &&
    subject.examples[1]?.input.fields.subject === "Invoice 77" &&
    subject.examples[1]?.decidedBy === "suggestion-accepted" &&
    subject.rules[0]?.evaluationCount === 31 &&
    subject.rules[0]?.truePositives === 31 &&
    subject.stats.autoClassified === 1 &&
    subject.stats.correctionRate === 0 &&
    showsNone(subject[UI], ["Manual Review"])
  );
  const assert_invoice_88_in_review = assert(() =>
    subject.rules[0]?.evaluationCount === 31 &&
    showsAll(subject[UI], ["Manual Review", "Invoice 88"])
  );
  const assert_invoice_88_corrected = assert(() =>
    subject.examples.length === 3 &&
    subject.examples[2]?.input.fields.subject === "Invoice 88" &&
    subject.examples[2]?.label === false &&
    subject.examples[2]?.wasCorrection === true &&
    subject.examples[2]?.originalPrediction === true &&
    subject.rules[0]?.falsePositives === 1 &&
    subject.rules[0]?.evaluationCount === 32 &&
    subject.stats.autoClassified === 2 &&
    subject.stats.correctionRate === 0.5 &&
    showsAll(subject[UI], ["Correction rate: 50.0%"]) &&
    showsNone(subject[UI], ["Manual Review"])
  );
  return {
    [TESTS]: [
      { action: action_submit_invoice_77 },
      { assertion: assert_invoice_77_auto },
      { press: subject[UI], control: "Undo" },
      { assertion: assert_invoice_77_in_review },
      { press: subject[UI], control: "Accept" },
      { assertion: assert_invoice_77_accepted },

      { action: action_submit_invoice_88 },
      { press: subject[UI], control: "Undo" },
      { assertion: assert_invoice_88_in_review },
      { press: subject[UI], control: "Actually NO" },
      { assertion: assert_invoice_88_corrected },
    ],
    subject,
  };
});
