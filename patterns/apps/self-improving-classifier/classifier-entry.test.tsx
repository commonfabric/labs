/**
 * Test Pattern: Self-Improving Classifier item entry
 *
 * Composes an item field by field, starting from the fields every example
 * shares, and submits it.
 *
 * Pattern under test: ./self-improving-classifier.tsx
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findElementByText,
  findNodeByProp,
  fireEvent,
  propValue,
  typeInto,
} from "../../tools/test-support/vnode-helpers.ts";
import {
  CONFIG,
  inputValue,
  INVOICE_RULE,
  labeledExample,
  showsNone,
} from "./classifier-test-fixture.ts";
import SelfImprovingClassifier from "./self-improving-classifier.tsx";

export default pattern(() => {
  const subject = SelfImprovingClassifier({
    config: CONFIG,
    examples: [labeledExample("e-rent", "Rent due")],
    rules: [INVOICE_RULE],
    pendingClassifications: [],
    currentItem: null,
  });

  // === Actions ===

  const action_fill_subject = action(() =>
    fireEvent(
      findNodeByProp(subject[UI], "placeholder", "Enter subject"),
      "oncf-input",
      { detail: { value: "Invoice 77" } },
      "the subject input",
    )
  );
  const action_draft_body_field = action(() => {
    typeInto(subject[UI], "Field name", "body");
    typeInto(subject[UI], "Field value", "Pay soon");
  });

  // === Assertions ===

  const assert_subject_prefilled = assert(() =>
    inputValue(subject[UI], "Enter subject") === "" &&
    showsNone(subject[UI], ["No fields added yet"])
  );
  const assert_subject_filled = assert(() =>
    inputValue(subject[UI], "Enter subject") === "Invoice 77" &&
    propValue(
        findElementByText(subject[UI], "cf-button", "Classify"),
        "disabled",
      ) === false
  );
  const assert_body_added = assert(() =>
    inputValue(subject[UI], "Enter body") === "Pay soon" &&
    propValue(
        findNodeByProp(subject[UI], "placeholder", "Field name"),
        "$value",
      ) === ""
  );
  const assert_body_removed = assert(() =>
    inputValue(subject[UI], "Enter body") === undefined &&
    inputValue(subject[UI], "Enter subject") === "Invoice 77"
  );
  const assert_invoice_77_classified = assert(() =>
    subject.examples.length === 2 &&
    subject.examples[1]?.decidedBy === "auto" &&
    subject.examples[1]?.input.fields.subject === "Invoice 77" &&
    subject.examples[1]?.input.fields.body === undefined &&
    inputValue(subject[UI], "Enter subject") === ""
  );

  return {
    [TESTS]: [
      { assertion: assert_subject_prefilled },
      { action: action_fill_subject },
      { assertion: assert_subject_filled },
      { action: action_draft_body_field },
      { press: subject[UI], control: "Add" },
      { assertion: assert_body_added },
      { press: subject[UI], control: "x", within: "body:" },
      { assertion: assert_body_removed },
      // The invoice rule auto-classifies the submitted item
      { press: subject[UI], control: "Classify" },
      { assertion: assert_invoice_77_classified },
    ],
    subject,
  };
});
