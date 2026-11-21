/**
 * Test: two sub-patterns handed the same `items` cell stay in sync.
 *
 * BasicList and CategoryList each render `items` and write it: adding from
 * the basic list's input, checking a box, and removing a row with its x
 * button. Each change is made through one view and read back from both, which
 * only agree when both hold the same cell rather than a copy.
 *
 * Run: deno task cf test patterns/dev/gideon-tests/test-pattern-composition-shared-cells.test.tsx --root patterns --verbose
 */
import {
  action,
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
  clickInRow,
  findElement,
  findElementByExactText,
  findElementByText,
  findNode,
  findViewCell,
  fireEvent,
  propValue,
  readValue,
  textContent,
  viewCell,
} from "../../tools/test-support/vnode-helpers.ts";
import SharedCells from "./test-pattern-composition-shared-cells.tsx";

const BASIC = "Basic List View";
const CATEGORY = "Category List View";

/** Whether a node is the `div` whose own `tag` child reads `heading`. */
const isHeadedBy = (tag: string, heading: string) => (node: unknown): boolean =>
  childNodes(node).some((child) =>
    findElementByExactText(child, tag, heading) === child
  );

const section = (ui: unknown, heading: string): unknown =>
  findNode(ui, isHeadedBy("h3", heading));

const isElement = (name: string) => (node: unknown): boolean =>
  findElement(node, name) === node;

const isCheckbox = (title: string) => (node: unknown): boolean =>
  findElementByText(node, "cf-checkbox", title) === node;

/** Every node under `root` that `accept` admits, outermost first. */
const findAll = (
  root: unknown,
  accept: (node: unknown) => boolean,
): unknown[] => {
  const value = readValue(root);
  return accept(value)
    ? [value]
    : childNodes(value).flatMap((child) => findAll(child, accept));
};

/** A checkbox row's title, starred when it reads as done: its box checked and
 * its title struck through. A box that disagrees with its title is marked. */
const row = (box: unknown): string => {
  const checked = propValue(box, "$checked") === true;
  const struck =
    JSON.stringify(propValue(findElement(box, "span"), "style")) ===
      JSON.stringify({ textDecoration: "line-through" });
  return textContent(box) + (checked !== struck ? "?" : checked ? "*" : "");
};

/** Both views as text: the basic list's rows, then each category's rows. */
const views = (ui: unknown): string => {
  const basic = findAll(section(ui, BASIC), isElement("cf-checkbox"))
    .map(row).join(", ");
  const groups = findAll(section(ui, CATEGORY), isElement("h4")).map(
    (heading) => {
      const name = textContent(heading);
      const group = findNode(section(ui, CATEGORY), isHeadedBy("h4", name));
      const rows = findAll(group, isElement("cf-checkbox")).map(row);
      return `${name}: ${rows.join(", ")}`;
    },
  );
  return `basic: ${basic} | category: ${groups.join("; ")}`;
};

/** Sends `message` from the basic list's input. */
const send = handler<void, { ui: VNode; message: string }>((
  _,
  { ui, message },
) =>
  fireEvent(
    findElement(section(ui, BASIC), "cf-message-input"),
    "oncf-send",
    { detail: { message } },
    "the basic list's input",
  )
);

/** Flips the box titled `title` in the view headed `heading`. */
const toggle = handler<
  void,
  { ui: Writable<VNode>; heading: string; title: string }
>((_, { ui, heading, title }) => {
  const view = findViewCell(viewCell(ui), isHeadedBy("h3", heading));
  if (view === undefined) throw new Error(`no view headed ${heading}`);
  const checked = boundViewCell(
    view,
    isCheckbox(title),
    "$checked",
    `the "${title}" box`,
  );
  checked.set(!checked.get());
});

export default pattern(() => {
  const subject = SharedCells({
    items: Writable.of([
      { title: "Milk", done: false, category: "Dairy" },
      { title: "Bread", done: false, category: "Bakery" },
      { title: "Cheese", done: true, category: "Dairy" },
    ]),
  });

  const assert_name = assert(() =>
    subject[NAME] === "Test: Pattern Composition with Shared Cells"
  );
  const assert_initial_views = assert(() =>
    views(subject[UI]) ===
      "basic: Milk (Dairy), Bread (Bakery), Cheese (Dairy)* | " +
        "category: Bakery: Bread; Dairy: Milk, Cheese*"
  );

  // The input splits "title:category" and trims both halves.
  const action_add_apples = send({
    ui: subject[UI],
    message: " Apples : Produce ",
  });
  const assert_apples_in_both = assert(() =>
    subject.items[3]?.category === "Produce" &&
    views(subject[UI]) ===
      "basic: Milk (Dairy), Bread (Bakery), Cheese (Dairy)*, " +
        "Apples (Produce) | " +
        "category: Bakery: Bread; Dairy: Milk, Cheese*; Produce: Apples"
  );

  // A blank message adds nothing, and one with no category files the item
  // under "Uncategorized".
  const action_add_blank = send({ ui: subject[UI], message: "   " });
  const action_add_eggs = send({ ui: subject[UI], message: "Eggs" });
  const assert_eggs_uncategorized = assert(() =>
    subject.items.length === 5 &&
    views(subject[UI]) ===
      "basic: Milk (Dairy), Bread (Bakery), Cheese (Dairy)*, " +
        "Apples (Produce), Eggs (Uncategorized) | " +
        "category: Bakery: Bread; Dairy: Milk, Cheese*; Produce: Apples; " +
        "Uncategorized: Eggs"
  );

  const action_check_milk_in_basic = toggle({
    ui: subject[UI],
    heading: BASIC,
    title: "Milk",
  });
  const action_uncheck_cheese_in_category = toggle({
    ui: subject[UI],
    heading: CATEGORY,
    title: "Cheese",
  });
  const assert_done_in_both = assert(() =>
    subject.items[0]?.done === true && subject.items[2]?.done === false &&
    views(subject[UI]) ===
      "basic: Milk (Dairy)*, Bread (Bakery), Cheese (Dairy), " +
        "Apples (Produce), Eggs (Uncategorized) | " +
        "category: Bakery: Bread; Dairy: Milk*, Cheese; Produce: Apples; " +
        "Uncategorized: Eggs"
  );

  const action_remove_bread_in_category = action(() =>
    clickInRow(section(subject[UI], CATEGORY), "Bread", "x")
  );
  const assert_bread_gone_from_both = assert(() =>
    views(subject[UI]) ===
      "basic: Milk (Dairy)*, Cheese (Dairy), Apples (Produce), " +
        "Eggs (Uncategorized) | " +
        "category: Dairy: Milk*, Cheese; Produce: Apples; Uncategorized: Eggs"
  );

  const action_remove_milk_in_basic = action(() =>
    clickInRow(section(subject[UI], BASIC), "Milk", "x")
  );
  const assert_milk_gone_from_both = assert(() =>
    subject.items.length === 3 &&
    views(subject[UI]) ===
      "basic: Cheese (Dairy), Apples (Produce), Eggs (Uncategorized) | " +
        "category: Dairy: Cheese; Produce: Apples; Uncategorized: Eggs"
  );

  return {
    [TESTS]: [
      { assertion: assert_name },
      { assertion: assert_initial_views },
      { action: action_add_apples },
      { assertion: assert_apples_in_both },
      { action: action_add_blank },
      { action: action_add_eggs },
      { assertion: assert_eggs_uncategorized },
      { action: action_check_milk_in_basic },
      { action: action_uncheck_cheese_in_category },
      { assertion: assert_done_in_both },
      { action: action_remove_bread_in_category },
      { assertion: assert_bread_gone_from_both },
      { action: action_remove_milk_in_basic },
      { assertion: assert_milk_gone_from_both },
    ],
    subject,
  };
});
