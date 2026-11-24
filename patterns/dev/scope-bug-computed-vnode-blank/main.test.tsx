/**
 * Test: every reactive composition shape in the fixture renders and follows
 * the counter.
 *
 * The fixture puts a computed style object, a computed style string, four
 * computed blocks, and an `ifElse()` around a `$value` binding in one view.
 * The test reads each section at an even count, presses "Tick", and reads
 * each again at an odd count, so a section that rendered nothing fails, and
 * so does one that did not recompute, other than Block D, which reads the
 * same until the count reaches five.
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  findElement,
  findNode,
  hasText,
  propsOf,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import Repro from "./main.tsx";

/** The style of the outermost element, below the one holding the counter,
 * whose text includes `text`. */
const styleOf = (root: unknown, text: string): unknown =>
  propValue(
    findNode(
      root,
      (node) =>
        propsOf(node) !== undefined && hasText(node, text) &&
        !hasText(node, "Counter:"),
    ),
    "style",
  );

const objectBackground = (root: unknown): unknown => {
  const style = styleOf(root, "W1 content");
  return typeof style === "object" && style !== null && "background" in style
    ? style.background
    : undefined;
};

export default pattern(() => {
  const subject = Repro({ name: "Ada" });

  const action_tick = action(() => clickButton(subject[UI], "Tick"));

  const assert_named = assert(() =>
    subject[NAME] === "Computed-VNode blank-render repro"
  );

  const assert_even_sections = assert(() =>
    subject.counter === 0 &&
    hasText(subject[UI], "Counter: 0") &&
    objectBackground(subject[UI]) === "#dbeafe" &&
    String(styleOf(subject[UI], "W2 content")).includes(
      "background: #dbeafe",
    ) &&
    hasText(subject[UI], "Block A — counter is zero") &&
    hasText(subject[UI], "Block B — counter mod 2 is 0") &&
    hasText(subject[UI], "Block C — counter squared is 0") &&
    hasText(subject[UI], "Block D — counter == 5? no")
  );

  // At an even count the `ifElse()` shows the input, bound to the name.
  const assert_even_shows_input = assert(() =>
    propValue(findElement(subject[UI], "cf-input"), "$value") === "Ada" &&
    !hasText(subject[UI], "Input hidden on odd ticks") &&
    hasText(subject[UI], "Name: Ada")
  );

  const assert_odd_sections = assert(() =>
    subject.counter === 1 &&
    hasText(subject[UI], "Counter: 1") &&
    objectBackground(subject[UI]) === "#fde68a" &&
    String(styleOf(subject[UI], "W2 content")).includes(
      "background: #fde68a",
    ) &&
    hasText(subject[UI], "Block A — counter is positive") &&
    hasText(subject[UI], "Block B — counter mod 2 is 1") &&
    hasText(subject[UI], "Block C — counter squared is 1")
  );

  const assert_odd_hides_input = assert(() =>
    findElement(subject[UI], "cf-input") === undefined &&
    hasText(subject[UI], "Input hidden on odd ticks") &&
    hasText(subject[UI], "Name: Ada")
  );

  return {
    [TESTS]: [
      { assertion: assert_named },
      { assertion: assert_even_sections },
      { assertion: assert_even_shows_input },
      { action: action_tick },
      { assertion: assert_odd_sections },
      { assertion: assert_odd_hides_input },
    ],
    subject,
  };
});
