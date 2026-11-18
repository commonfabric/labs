import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  fireClick,
  hasExactText,
} from "../../tools/test-support/vnode-helpers.ts";
import OutputSchema from "./output_schema.tsx";

// The one control the pattern renders: a button labelled with the value.
const counterButton = (root: unknown): unknown =>
  findElement(root, "cf-button");

export default pattern(() => {
  const subject = OutputSchema({ value: 4 });

  const action_click = action(() =>
    fireClick(counterButton(subject[UI]), "the counter button")
  );

  const assert_starts_at_four = assert(() =>
    subject.value === 4 && hasExactText(counterButton(subject[UI]), "4")
  );
  const assert_click_counts_up = assert(() =>
    subject.value === 5 && hasExactText(counterButton(subject[UI]), "5")
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_at_four },
      { action: action_click },
      { assertion: assert_click_counts_up },
    ],
    subject,
  };
});
