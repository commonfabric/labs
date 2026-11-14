/**
 * Test: `$checked` on rows mapped from a `computed()` result.
 *
 * The view binds the same `done` field twice: section A maps the `items` input
 * itself, section B maps `activeItems`, a computed filter of it. Checking a box
 * in A writes the item in `items`. Checking a box in B raises no error, but the
 * write never reaches `items`: the rows of a computed result are its own data,
 * not links to the input, so the box changes alone and A stays as it was.
 *
 * A checkbox writes through the cell its `$checked` prop links to, so the test
 * walks the view as cells to reach that link and writes through it.
 *
 * Run: deno task cf test patterns/dev/gideon-tests/test-checkbox-computed.test.tsx --root patterns --verbose
 */
import {
  assert,
  handler,
  NAME,
  pattern,
  TESTS,
  UI,
  VNode,
  Writable,
} from "commonfabric";
import {
  boundViewCell,
  childNodes,
  findElementByText,
  findNode,
  findViewCell,
  hasText,
  propValue,
  textContent,
  viewCell,
} from "../../tools/test-support/vnode-helpers.ts";
import CheckboxComputed from "./test-checkbox-computed.tsx";

const SECTION_A = "A: Direct Cell Map";
const SECTION_B = "B: Computed Map";

/** Whether a node is the section `div` headed by `heading`. */
const isSection = (heading: string) => (node: unknown): boolean =>
  childNodes(node).some((child) =>
    findElementByText(child, "h3", heading) === child
  );

/** Whether a node is the checkbox labeled `title`. */
const isCheckbox = (title: string) => (node: unknown): boolean =>
  findElementByText(node, "cf-checkbox", title) === node;

const checkbox = (ui: unknown, heading: string, title: string): unknown =>
  findNode(findNode(ui, isSection(heading)), isCheckbox(title));

const checkedValue = (ui: unknown, heading: string, title: string): unknown =>
  propValue(checkbox(ui, heading, title), "$checked");

/** Flips the checkbox labeled `title` in the section headed `heading`. */
const toggle = handler<
  void,
  { ui: Writable<VNode>; heading: string; title: string }
>((_, { ui, heading, title }) => {
  const section = findViewCell(viewCell(ui), isSection(heading));
  if (section === undefined) throw new Error(`no section ${heading}`);
  const checked = boundViewCell(
    section,
    isCheckbox(title),
    "$checked",
    `the "${title}" box`,
  );
  checked.set(!checked.get());
});

export default pattern(() => {
  const subject = CheckboxComputed({
    items: Writable.of([
      { id: "1", title: "Task A", done: false, active: true },
      { id: "2", title: "Task B", done: true, active: true },
      { id: "3", title: "Task C", done: false, active: false },
    ]),
  });

  const assert_name = assert(() =>
    subject[NAME] === "TEST: $checked on Computed"
  );
  const assert_counts = assert(() =>
    hasText(subject[UI], "Active: 2 / Total: 3")
  );
  const assert_section_a_lists_every_item = assert(() =>
    textContent(findNode(subject[UI], isSection(SECTION_A))).includes(
      "Task A Task B Task C (inactive)",
    )
  );
  const assert_section_b_lists_active_items = assert(() =>
    checkbox(subject[UI], SECTION_B, "Task A") !== undefined &&
    checkbox(subject[UI], SECTION_B, "Task B") !== undefined &&
    checkbox(subject[UI], SECTION_B, "Task C") === undefined
  );
  const assert_initial_boxes = assert(() =>
    checkedValue(subject[UI], SECTION_A, "Task A") === false &&
    checkedValue(subject[UI], SECTION_B, "Task A") === false &&
    checkedValue(subject[UI], SECTION_A, "Task B") === true &&
    checkedValue(subject[UI], SECTION_B, "Task B") === true
  );

  const action_check_b_task_a = toggle({
    ui: subject[UI],
    heading: SECTION_B,
    title: "Task A",
  });
  const assert_b_box_checked_alone = assert(() =>
    checkedValue(subject[UI], SECTION_B, "Task A") === true &&
    checkedValue(subject[UI], SECTION_A, "Task A") === false
  );
  const assert_b_write_misses_input = assert(() =>
    subject.items[0].done === false
  );

  const action_check_a_task_c = toggle({
    ui: subject[UI],
    heading: SECTION_A,
    title: "Task C",
  });
  const assert_a_write_reaches_input = assert(() =>
    subject.items[2].done === true &&
    checkedValue(subject[UI], SECTION_A, "Task C") === true
  );
  // The input changed, so the filter reran and replaced the row the earlier
  // write had changed.
  const assert_b_row_replaced = assert(() =>
    checkedValue(subject[UI], SECTION_B, "Task A") === false
  );

  const action_uncheck_a_task_b = toggle({
    ui: subject[UI],
    heading: SECTION_A,
    title: "Task B",
  });
  const assert_b_follows_input = assert(() =>
    subject.items[1].done === false &&
    checkedValue(subject[UI], SECTION_B, "Task B") === false
  );

  return {
    [TESTS]: [
      { assertion: assert_name },
      { assertion: assert_counts },
      { assertion: assert_section_a_lists_every_item },
      { assertion: assert_section_b_lists_active_items },
      { assertion: assert_initial_boxes },
      { action: action_check_b_task_a },
      { assertion: assert_b_box_checked_alone },
      { assertion: assert_b_write_misses_input },
      { action: action_check_a_task_c },
      { assertion: assert_a_write_reaches_input },
      { assertion: assert_b_row_replaced },
      { action: action_uncheck_a_task_b },
      { assertion: assert_b_follows_input },
    ],
    subject,
  };
});
