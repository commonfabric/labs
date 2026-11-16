/**
 * Test Pattern: Self-Improving Classifier review queue
 *
 * Names the classifier by its question, and confirms, corrects, and
 * dismisses pending classifications through the view and through the API
 * streams.
 *
 * Pattern under test: ./self-improving-classifier.tsx
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findNodeByProp,
  fireEvent,
} from "../../tools/test-support/vnode-helpers.ts";
import {
  CONFIG,
  pendingItem,
  shows,
  showsAll,
  showsNone,
  sortedIds,
  statsText,
} from "./classifier-test-fixture.ts";
import SelfImprovingClassifier from "./self-improving-classifier.tsx";

const QUESTION_PLACEHOLDER =
  "Enter your classification question (e.g., 'Is this email a bill?')";

export default pattern(() => {
  const subject = SelfImprovingClassifier({
    config: CONFIG,
    examples: [],
    rules: [],
    pendingClassifications: [
      pendingItem("p-electric", "Electric bill", true, 0.6, "Mentions a bill"),
      pendingItem("p-party", "Party invite", true, 0.9, "Has a date"),
      pendingItem("p-spam", "Spam offer", false, 0.8, "Looks like spam"),
      pendingItem("p-rent", "Rent due", true, 0.95, "Rent is a bill"),
      pendingItem("p-lunch", "Lunch plans", true, 0.7, "Has a total"),
      pendingItem("p-news", "Newsletter", false, 0.9, "Bulk mail"),
    ],
    currentItem: null,
  });

  // === Actions ===

  const action_ask_question = action(() =>
    fireEvent(
      findNodeByProp(subject[UI], "placeholder", QUESTION_PLACEHOLDER),
      "oncf-input",
      { detail: { value: "Is this a bill?" } },
      "the question input",
    )
  );

  // Two of these name no pending classification, and change nothing.
  const action_settle_pending_through_api = action(() => {
    subject.confirmClassification.send({ inputId: "p-rent" });
    subject.correctClassification.send({
      inputId: "p-lunch",
      correctLabel: false,
      reasoning: "Social",
    });
    subject.dismissClassification.send({ inputId: "p-news" });
    subject.confirmClassification.send({ inputId: "p-missing" });
    subject.correctClassification.send({
      inputId: "p-missing",
      correctLabel: true,
    });
  });

  // === Assertions ===

  const assert_unnamed = assert(() =>
    subject[NAME] === "Self-Improving Classifier"
  );
  const assert_no_fields_yet = assert(() =>
    shows(subject[UI], "No fields added yet")
  );
  const assert_named_by_question = assert(() =>
    subject[NAME] === "Classifier: Is this a bill?" &&
    subject.config.question === "Is this a bill?"
  );
  const assert_pending_rows = assert(() =>
    showsAll(subject[UI], [
      "Awaiting Confirmation",
      "Electric bill",
      "(60% confidence via llm)",
      "Mentions a bill",
    ]) &&
    shows(subject[UI], "Actually NO") &&
    shows(subject[UI], "Actually YES")
  );

  const assert_electric_confirmed = assert(() =>
    subject.examples.length === 1 &&
    subject.examples[0]?.input.id === "p-electric" &&
    subject.examples[0]?.label === true &&
    subject.examples[0]?.decidedBy === "suggestion-accepted" &&
    subject.examples[0]?.isInteresting === true &&
    sortedIds(subject.pendingClassifications) ===
      "p-lunch,p-news,p-party,p-rent,p-spam"
  );
  const assert_party_corrected = assert(() =>
    subject.examples.length === 2 &&
    subject.examples[1]?.input.id === "p-party" &&
    subject.examples[1]?.label === false &&
    subject.examples[1]?.wasCorrection === true &&
    subject.examples[1]?.originalPrediction === true &&
    subject.examples[1]?.reasoning === "User correction"
  );
  const assert_spam_dismissed = assert(() =>
    subject.examples.length === 2 &&
    sortedIds(subject.pendingClassifications) === "p-lunch,p-news,p-rent"
  );
  const assert_api_settled_pending = assert(() =>
    sortedIds(subject.examples) === "p-electric,p-lunch,p-party,p-rent" &&
    subject.examples.some((e) =>
      e.input.id === "p-rent" && e.label && !e.isInteresting
    ) &&
    subject.examples.some((e) =>
      e.input.id === "p-lunch" && !e.label && e.reasoning === "Social" &&
      e.originalPrediction === true
    ) &&
    subject.pendingClassifications.length === 0 &&
    showsNone(subject[UI], ["Awaiting Confirmation"])
  );
  const assert_stats_after_review = assert(() =>
    statsText(subject[UI]) === "4Examples2YES2NO0Rules" &&
    subject.stats.correctionRate === 0 &&
    showsNone(subject[UI], ["Correction rate"])
  );

  return {
    [TESTS]: [
      { assertion: assert_unnamed },
      { assertion: assert_no_fields_yet },
      { action: action_ask_question },
      { assertion: assert_named_by_question },
      { assertion: assert_pending_rows },

      // Pending classifications, through the view and then the API
      { press: subject[UI], control: "Confirm", within: "Electric bill" },
      { assertion: assert_electric_confirmed },
      { press: subject[UI], control: "Actually NO", within: "Party invite" },
      { assertion: assert_party_corrected },
      { press: subject[UI], control: "Dismiss", within: "Spam offer" },
      { assertion: assert_spam_dismissed },
      { action: action_settle_pending_through_api },
      { assertion: assert_api_settled_pending },
      { assertion: assert_stats_after_review },
    ],
    subject,
  };
});
