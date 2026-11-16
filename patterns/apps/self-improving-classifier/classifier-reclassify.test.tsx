/**
 * Test Pattern: Self-Improving Classifier reclassification
 *
 * Reclassifies an example, which sends it back to the model and holds the
 * classifier, ignoring further submissions, until the item is dismissed.
 *
 * The model is unreachable here, so the classification fails, which the card
 * shows until the item is dismissed. What the classifier does with the
 * model's answer is covered by `classifier-logic.test.ts`.
 *
 * Pattern under test: ./self-improving-classifier.tsx
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findElementByText,
  findNode,
  fireEvent,
  hasExactText,
  hasText,
  propsOf,
} from "../../tools/test-support/vnode-helpers.ts";
import {
  CONFIG,
  INVOICE_RULE,
  labeledExample,
  showsAll,
  showsNone,
  sortedIds,
} from "./classifier-test-fixture.ts";
import SelfImprovingClassifier from "./self-improving-classifier.tsx";

export default pattern(() => {
  const subject = SelfImprovingClassifier({
    config: CONFIG,
    examples: [
      labeledExample("e-rent", "Rent due"),
      labeledExample("e-lunch", "Lunch plans", { label: false }),
    ],
    rules: [INVOICE_RULE],
    pendingClassifications: [],
    currentItem: null,
  });

  // === Actions ===

  const action_submit_while_busy = action(() =>
    subject.submitItem.send({ fields: { subject: "Invoice 5" } })
  );
  // The Reclassify control is disabled while an item is classifying; firing
  // its handler anyway is what a stale click does.
  const action_reclassify_while_busy = action(() =>
    fireEvent(
      findNode(
        subject[UI],
        (node) =>
          hasExactText(node, "Reclassify") &&
          propsOf(node)?.onClick !== undefined,
      ),
      "onClick",
      {},
      "the Reclassify button",
    )
  );
  const action_submit_invoice_6 = action(() =>
    subject.submitItem.send({ fields: { subject: "Invoice 6" } })
  );

  // === Assertions ===

  const assert_rent_classifying = assert(() =>
    sortedIds(subject.examples) === "e-lunch" &&
    showsAll(subject[UI], ["Classification failed:", "Dismiss"]) &&
    hasText(findElementByText(subject[UI], "pre", "Rent due"), "Rent due")
  );
  const assert_busy_ignored = assert(() =>
    sortedIds(subject.examples) === "e-lunch"
  );
  const assert_freed_by_dismiss = assert(() =>
    subject.examples.length === 2 &&
    subject.examples[1]?.input.fields.subject === "Invoice 6" &&
    showsNone(subject[UI], ["Classification failed:"])
  );

  return {
    [TESTS]: [
      { press: subject[UI], control: "[+]", within: "Rent due" },
      { press: subject[UI], control: "Reclassify" },
      { assertion: assert_rent_classifying },
      { action: action_submit_while_busy },
      { press: subject[UI], control: "[+]", within: "Lunch plans" },
      { action: action_reclassify_while_busy },
      { assertion: assert_busy_ignored },
      { press: subject[UI], control: "Dismiss" },
      { action: action_submit_invoice_6 },
      { assertion: assert_freed_by_dismiss },
    ],
    subject,
    // The model has no endpoint in a pattern test, so the llm builtin warns,
    // and the classifier warns about the submissions it ignores.
    allowConsoleWarnings: true,
  };
});
