/**
 * Test Pattern: Self-Improving Classifier items stored without a scoring
 *
 * An auto-classified item stored before items recorded which rules they were
 * scored against carries only the names of the rules that matched. Undoing
 * it, and accepting or correcting such an undone item, takes it to have been
 * scored against every rule created by the time it was classified, matching
 * by name, as the version that stored it did.
 *
 * The undo state is the pattern's own, so the test binds the pattern's
 * handlers to cells it seeds with the stored shape.
 *
 * Pattern under test: ./self-improving-classifier.tsx
 */
import { assert, pattern, TESTS, Writable } from "commonfabric";
import type { AutoClassifiedItem } from "./classifier-logic.ts";
import {
  CONFIG,
  INVOICE_RULE,
  labeledExample,
} from "./classifier-test-fixture.ts";
import SelfImprovingClassifier, {
  acceptUndoneClassificationHandler,
  correctUndoneClassificationHandler,
  undoAutoClassificationHandler,
} from "./self-improving-classifier.tsx";

/** An auto-classified item in the shape stored before `scoring` existed. */
const storedItem = (id: string, subject: string): AutoClassifiedItem => ({
  input: { id, receivedAt: 0, fields: { subject } },
  label: true,
  confidence: 1,
  reasoning: "Auto-classified by Tier 4 rule(s): Invoice word",
  matchedRules: ["Invoice word"],
  tier: 4,
  classifiedAt: 0,
});

export default pattern(() => {
  const subject = SelfImprovingClassifier({
    config: CONFIG,
    examples: [labeledExample("i-7", "Invoice 7", { decidedBy: "auto" })],
    rules: [
      INVOICE_RULE,
      // Predicts NO and matches no invoice, so each stored YES counted for
      // it as a true negative
      {
        ...INVOICE_RULE,
        id: "rule-lunch",
        name: "Lunch word",
        pattern: "lunch",
        predicts: false,
        evaluationCount: 5,
        truePositives: 0,
        trueNegatives: 5,
      },
      // Created after the stored items were classified, so none of their
      // outcomes was recorded against it
      {
        ...INVOICE_RULE,
        id: "rule-later",
        name: "Later invoice word",
        createdAt: 1,
        evaluationCount: 5,
        truePositives: 5,
      },
    ],
    pendingClassifications: [],
    currentItem: null,
  });

  const recent = Writable.of<AutoClassifiedItem[]>([
    storedItem("i-7", "Invoice 7"),
  ]);
  const undone = Writable.of<AutoClassifiedItem | null>(null);
  const storedUndoneToAccept = Writable.of<AutoClassifiedItem | null>(
    storedItem("i-8", "Invoice 8"),
  );
  const storedUndoneToCorrect = Writable.of<AutoClassifiedItem | null>(
    storedItem("i-9", "Invoice 9"),
  );

  // === Actions ===

  const action_undo_stored = undoAutoClassificationHandler({
    autoItem: storedItem("i-7", "Invoice 7"),
    examples: subject.examples,
    rules: subject.rules,
    recentAutoClassified: recent,
    undoneAutoItem: undone,
  });
  const action_accept_stored = acceptUndoneClassificationHandler({
    undoneAutoItem: storedUndoneToAccept,
    examples: subject.examples,
    rules: subject.rules,
  });
  const action_correct_stored = correctUndoneClassificationHandler({
    undoneAutoItem: storedUndoneToCorrect,
    examples: subject.examples,
    rules: subject.rules,
  });

  // === Assertions ===

  // The undo takes the outcome back from every rule there was then: a true
  // positive from the invoice rule, which matched by name, and a true
  // negative from the lunch rule, which did not. The later rule keeps its
  // counts. The undo records the scoring it used on the undone item.
  const assert_undone = assert(() =>
    subject.examples.length === 0 &&
    recent.get().length === 0 &&
    subject.rules[0]?.evaluationCount === 29 &&
    subject.rules[0]?.truePositives === 29 &&
    subject.rules[1]?.evaluationCount === 4 &&
    subject.rules[1]?.trueNegatives === 4 &&
    subject.rules[2]?.evaluationCount === 5 &&
    undone.get()?.scoring?.ruleIds.join() === "rule-invoice,rule-lunch" &&
    undone.get()?.scoring?.matchedRuleIds.join() === "rule-invoice"
  );
  const assert_accepted = assert(() =>
    subject.examples.length === 1 &&
    subject.examples[0]?.reviewedAutoClassification === true &&
    subject.rules[0]?.evaluationCount === 30 &&
    subject.rules[0]?.truePositives === 30 &&
    subject.rules[1]?.trueNegatives === 5 &&
    subject.rules[2]?.evaluationCount === 5 &&
    storedUndoneToAccept.get() === null
  );
  const assert_corrected = assert(() =>
    subject.examples.length === 2 &&
    subject.examples[1]?.wasCorrection === true &&
    subject.rules[0]?.evaluationCount === 31 &&
    subject.rules[0]?.falsePositives === 1 &&
    subject.rules[1]?.falseNegatives === 1 &&
    subject.rules[1]?.evaluationCount === 6 &&
    subject.rules[2]?.evaluationCount === 5 &&
    storedUndoneToCorrect.get() === null
  );

  return {
    [TESTS]: [
      { action: action_undo_stored },
      { assertion: assert_undone },
      { action: action_accept_stored },
      { assertion: assert_accepted },
      { action: action_correct_stored },
      { assertion: assert_corrected },
    ],
    subject,
    recent,
    undone,
    storedUndoneToAccept,
    storedUndoneToCorrect,
  };
});
