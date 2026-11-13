/**
 * Test Pattern: Self-Improving Classifier undo, dismissed
 *
 * Undoes an auto-classification after a rule was added and another item
 * scored, which takes the outcome back from the rules that recorded it and
 * leaves the new rule alone. While that item awaits review, undoing another
 * does nothing, since it would replace the item under review. Dismissing the
 * review records nothing. The correction rate counts only corrections of auto-classified
 * decisions.
 *
 * Pattern under test: ./self-improving-classifier.tsx
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findNode,
  fireEvent,
  hasExactText,
  propsOf,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import {
  CONFIG,
  INVOICE_RULE,
  labeledExample,
  showsAll,
  showsNone,
} from "./classifier-test-fixture.ts";
import SelfImprovingClassifier from "./self-improving-classifier.tsx";

/** The view's one Undo button, which only Invoice 100's row has left. */
const undoButton = (root: unknown): unknown =>
  findNode(
    root,
    (node) =>
      hasExactText(node, "Undo") && propsOf(node)?.onClick !== undefined,
  );

export default pattern(() => {
  const subject = SelfImprovingClassifier({
    config: CONFIG,
    examples: [
      // A correction of the rules' auto-classification, which counts
      labeledExample("e-lunch", "Lunch plans", {
        label: false,
        decidedBy: "user",
        wasCorrection: true,
        originalPrediction: true,
        reviewedAutoClassification: true,
      }),
      // A correction of the model's prediction, which does not
      labeledExample("e-party", "Party invite", {
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

  const action_submit_invoice_99 = action(() =>
    subject.submitItem.send({ fields: { subject: "Invoice 99" } })
  );
  const action_add_statement_rule = action(() =>
    subject.addRule.send({
      name: "Statement word",
      targetField: "subject",
      pattern: "statement",
      predicts: true,
      reasoning: "Statements are bills",
    })
  );
  const action_submit_invoice_100 = action(() =>
    subject.submitItem.send({ fields: { subject: "Invoice 100" } })
  );

  // Invoice 100's Undo is disabled while Invoice 99 awaits review; firing
  // its handler anyway is what a stale click does.
  const action_undo_invoice_100_while_reviewing = action(() =>
    fireEvent(
      undoButton(subject[UI]),
      "onClick",
      {},
      "the Undo button",
    )
  );

  // === Assertions ===

  // Invoice 100 scored both rules: the statement rule missed a YES.
  const assert_both_scored = assert(() =>
    subject.examples.length === 4 &&
    subject.rules[0]?.evaluationCount === 32 &&
    subject.rules[1]?.evaluationCount === 1 &&
    subject.rules[1]?.falseNegatives === 1
  );
  // Undoing Invoice 99 takes its outcome back from the invoice rule alone.
  const assert_invoice_99_in_review = assert(() =>
    subject.examples.length === 3 &&
    subject.rules[0]?.evaluationCount === 31 &&
    subject.rules[0]?.truePositives === 31 &&
    subject.rules[1]?.evaluationCount === 1 &&
    subject.rules[1]?.falseNegatives === 1 &&
    showsAll(subject[UI], ["Manual Review", "Invoice 99"])
  );
  const assert_second_undo_refused = assert(() =>
    subject.examples.length === 3 &&
    subject.examples[2]?.input.fields.subject === "Invoice 100" &&
    subject.rules[0]?.evaluationCount === 31 &&
    propValue(undoButton(subject[UI]), "disabled") === true &&
    showsAll(subject[UI], ["Manual Review", "Invoice 99"])
  );
  // One correction of the two auto-classified decisions left: the reviewed
  // lunch example and Invoice 100.
  const assert_invoice_99_dismissed = assert(() =>
    subject.examples.length === 3 &&
    subject.rules[0]?.evaluationCount === 31 &&
    subject.stats.autoClassified === 2 &&
    subject.stats.correctionRate === 0.5 &&
    showsAll(subject[UI], ["Correction rate: 50.0%"]) &&
    showsNone(subject[UI], ["Manual Review"])
  );

  return {
    [TESTS]: [
      { action: action_submit_invoice_99 },
      { action: action_add_statement_rule },
      { action: action_submit_invoice_100 },
      { assertion: assert_both_scored },
      { press: subject[UI], control: "Undo", within: "Invoice 99" },
      { assertion: assert_invoice_99_in_review },
      { action: action_undo_invoice_100_while_reviewing },
      { assertion: assert_second_undo_refused },
      { press: subject[UI], control: "Dismiss" },
      { assertion: assert_invoice_99_dismissed },
    ],
    subject,
    // The refused undo warns.
    allowConsoleWarnings: true,
  };
});
