/**
 * Test Pattern: Self-Improving Classifier examples
 *
 * Expands, collapses, and removes recorded examples. With five examples and a
 * correction among them, the classifier asks the model for rules, which has
 * no endpoint here and so suggests none.
 *
 * Pattern under test: ./self-improving-classifier.tsx
 */
import { assert, pattern, TESTS, UI } from "commonfabric";
import {
  CONFIG,
  labeledExample,
  shows,
  showsAll,
  showsNone,
  sortedIds,
} from "./classifier-test-fixture.ts";
import SelfImprovingClassifier from "./self-improving-classifier.tsx";

export default pattern(() => {
  const subject = SelfImprovingClassifier({
    config: CONFIG,
    examples: [
      labeledExample("e-electric", "Electric bill", {
        confidence: 0.6,
        reasoning: "Mentions a bill",
      }),
      labeledExample("e-party", "Party invite", {
        label: false,
        decidedBy: "user",
        confidence: 1,
        wasCorrection: true,
        originalPrediction: true,
      }),
      labeledExample("e-rent", "Rent due"),
      labeledExample("e-lunch", "Lunch plans", { label: false }),
      labeledExample("e-water", "Water bill"),
    ],
    rules: [],
    pendingClassifications: [],
    currentItem: null,
  });

  // === Assertions ===

  const assert_examples_listed = assert(() =>
    showsAll(subject[UI], ["Recent Examples (5)", "subject: Rent due..."]) &&
    showsNone(subject[UI], ["Input Fields"])
  );
  const assert_electric_expanded = assert(() =>
    showsAll(subject[UI], ["Input Fields", "Mentions a bill"]) &&
    shows(subject[UI], "60%") &&
    shows(subject[UI], "[-]")
  );
  const assert_collapsed = assert(() =>
    showsNone(subject[UI], ["Input Fields", "[-]"])
  );
  const assert_party_expanded = assert(() =>
    showsAll(subject[UI], ["Originally predicted YES", "user (corrected)"])
  );
  const assert_party_removed = assert(() =>
    sortedIds(subject.examples) === "e-electric,e-lunch,e-rent,e-water" &&
    showsNone(subject[UI], ["Input Fields", "Party invite"])
  );

  return {
    [TESTS]: [
      // Browsing and removing examples
      { assertion: assert_examples_listed },
      { press: subject[UI], control: "[+]", within: "Electric bill" },
      { assertion: assert_electric_expanded },
      { press: subject[UI], control: "[-]", within: "Electric bill" },
      { assertion: assert_collapsed },
      { press: subject[UI], control: "[+]", within: "Party invite" },
      { assertion: assert_party_expanded },
      { press: subject[UI], control: "Remove" },
      { assertion: assert_party_removed },
    ],
    subject,
    // The model has no endpoint in a pattern test, so the llm builtin warns.
    allowConsoleWarnings: true,
  };
});
