/**
 * Test Pattern: Self-Improving Classifier current item
 *
 * Shows the model's classification of the item being classified, then
 * accepts one answer and corrects another, each of which records an example
 * and frees the classifier.
 *
 * Pattern under test: ./main.tsx
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  CONFIG,
  shows,
  showsAll,
  showsNone,
} from "./classifier-test-fixture.ts";
import SelfImprovingClassifier, { type ClassifiableInput } from "./main.tsx";

export const llmMocks = [
  {
    when: {
      systemContains: "precise classifier",
      lastMessageContains: "Item ID: c-electric",
    },
    object: {
      itemId: "c-electric",
      classification: true,
      confidence: 0.6,
      reasoning: "Mentions a bill",
    },
    repeat: true,
  },
  {
    when: {
      systemContains: "precise classifier",
      lastMessageContains: "Item ID: c-rent",
    },
    object: {
      itemId: "c-rent",
      classification: false,
      confidence: 0.9,
      reasoning: "Reads like a chat",
    },
    repeat: true,
  },
];

const item = (id: string, subject: string): ClassifiableInput => ({
  id,
  receivedAt: 0,
  fields: { subject },
});

export default pattern(() => {
  const currentItem = new Writable<ClassifiableInput | null>(
    item("c-electric", "Electric bill"),
  );
  const subject = SelfImprovingClassifier({
    config: CONFIG,
    examples: [],
    rules: [],
    pendingClassifications: [],
    currentItem,
  });

  // === Actions ===

  const action_classify_rent = action(() =>
    currentItem.set(item("c-rent", "Rent due"))
  );

  // === Assertions ===

  const assert_electric_shown = assert(() =>
    showsAll(subject[UI], ["(60% confidence via llm)", "Mentions a bill"]) &&
    shows(subject[UI], "Actually NO") &&
    showsNone(subject[UI], ["Classifying...", "Classification failed"])
  );
  const assert_electric_accepted = assert(() =>
    currentItem.get() === null &&
    subject.examples.length === 1 &&
    subject.examples[0]?.input.id === "c-electric" &&
    subject.examples[0]?.label === true &&
    subject.examples[0]?.decidedBy === "suggestion-accepted" &&
    subject.examples[0]?.reasoning === "Mentions a bill" &&
    subject.examples[0]?.wasCorrection === false &&
    // Accepted at less than 0.7 confidence
    subject.examples[0]?.isInteresting === true &&
    showsNone(subject[UI], ["Mentions a bill", "Actually NO"])
  );
  const assert_rent_shown = assert(() =>
    showsAll(subject[UI], ["(90% confidence via llm)", "Reads like a chat"]) &&
    shows(subject[UI], "Actually YES") &&
    !shows(subject[UI], "Actually NO")
  );
  const assert_rent_corrected = assert(() =>
    currentItem.get() === null &&
    subject.examples.length === 2 &&
    subject.examples[1]?.input.id === "c-rent" &&
    subject.examples[1]?.label === true &&
    subject.examples[1]?.decidedBy === "user" &&
    subject.examples[1]?.wasCorrection === true &&
    subject.examples[1]?.originalPrediction === false &&
    subject.examples[1]?.reasoning === "User corrected classification" &&
    showsNone(subject[UI], ["Reads like a chat", "Actually YES"])
  );
  const assert_stats = assert(() =>
    subject.stats.positiveExamples === 2 &&
    subject.stats.negativeExamples === 0
  );

  return {
    [TESTS]: [
      { assertion: assert_electric_shown },
      { press: subject[UI], control: "Accept" },
      { assertion: assert_electric_accepted },
      { action: action_classify_rent },
      { assertion: assert_rent_shown },
      { press: subject[UI], control: "Actually YES" },
      { assertion: assert_rent_corrected },
      { assertion: assert_stats },
    ],
    subject,
  };
});
