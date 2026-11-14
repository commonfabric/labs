/**
 * Test Pattern: Simple List
 *
 * Tests the core functionality of the simple-list pattern:
 * - Initial state (empty list)
 * - Adding items
 * - Deleting items
 * - Toggle indent
 * - Set indent directly
 * - Empty string handling
 * - The name and summary outputs
 * - The rendered rows' keyboard indent, indent toggle, and delete controls,
 *   and the add-item field
 *
 * Run: deno task cf test patterns/examples/simple-list/simple-list.test.tsx --verbose
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findNodeByProp,
  fireClick,
  fireEvent,
  innermostNode,
  propValue,
  sendMessage,
} from "../../tools/test-support/vnode-helpers.ts";
import SimpleListModule from "./simple-list.tsx";

// The rendered row whose text field holds `text`.
const rowOf = (root: unknown, text: string): unknown =>
  innermostNode(
    root,
    (node) =>
      findNodeByProp(node, "$value", text) !== undefined &&
      findNodeByProp(node, "title", "Delete") !== undefined,
  );

// The indent toggle in a row, titled by what a click would do.
const indentToggle = (root: unknown, text: string): unknown => {
  const row = rowOf(root, text);
  return findNodeByProp(row, "title", "Indent") ??
    findNodeByProp(row, "title", "Outdent");
};

// A key press in a row's text field, as `cf-input` reports it.
const pressKey = (
  root: unknown,
  text: string,
  detail: { key: string; metaKey?: boolean; ctrlKey?: boolean } | undefined,
): void =>
  fireEvent(
    findNodeByProp(root, "$value", text),
    "oncf-keydown",
    { type: "cf-keydown", detail },
    `the "${text}" field`,
  );

export default pattern(() => {
  // Instantiate the simple list pattern with default empty list
  const list = SimpleListModule({});
  // A list seeded with one finished and one open item.
  const seeded = SimpleListModule({
    items: [
      { text: "Milk", indented: false, done: true },
      { text: "Eggs", indented: false, done: false },
    ],
  });

  // ==========================================================================
  // Actions
  // ==========================================================================

  // Add items
  const action_add_first = action(() => {
    list.addItem.send({ text: "First item" });
  });

  const action_add_second = action(() => {
    list.addItem.send({ text: "Second item" });
  });

  const action_add_third = action(() => {
    list.addItem.send({ text: "Third item" });
  });

  // Empty/whitespace should be ignored
  const action_add_empty = action(() => {
    list.addItem.send({ text: "" });
  });

  const action_add_whitespace = action(() => {
    list.addItem.send({ text: "   " });
  });

  // Toggle indent on first item
  const action_toggle_indent_0 = action(() => {
    list.toggleIndent.send({ index: 0 });
  });

  // Set indent directly on second item
  const action_set_indent_1_true = action(() => {
    list.setIndent.send({ index: 1, indented: true });
  });

  const action_set_indent_1_false = action(() => {
    list.setIndent.send({ index: 1, indented: false });
  });

  // Delete middle item (index 1)
  const action_delete_1 = action(() => {
    list.deleteItem.send({ index: 1 });
  });

  // Delete first item (index 0)
  const action_delete_0 = action(() => {
    list.deleteItem.send({ index: 0 });
  });

  // Invalid index operations (should be no-ops)
  const action_toggle_invalid = action(() => {
    list.toggleIndent.send({ index: 999 });
  });

  const action_delete_invalid = action(() => {
    list.deleteItem.send({ index: -1 });
  });

  // Driven through the rendered view
  const action_submit_alpha = action(() => sendMessage(list[UI], "Alpha"));
  const action_submit_beta = action(() => sendMessage(list[UI], "Beta"));
  const action_submit_nothing = action(() => sendMessage(list[UI], ""));

  const action_cmd_close_bracket_beta = action(() =>
    pressKey(list[UI], "Beta", { key: "]", metaKey: true })
  );
  const action_ctrl_open_bracket_beta = action(() =>
    pressKey(list[UI], "Beta", { key: "[", ctrlKey: true })
  );
  // A bracket without a modifier, another key with one, and an event with
  // no detail are all ordinary typing.
  const action_plain_keys_beta = action(() => {
    pressKey(list[UI], "Beta", { key: "]" });
    pressKey(list[UI], "Beta", { key: "a", metaKey: true });
    pressKey(list[UI], "Beta", undefined);
  });

  const action_click_indent_alpha = action(() =>
    fireClick(indentToggle(list[UI], "Alpha"), "Alpha's indent toggle")
  );
  const action_click_delete_alpha = action(() =>
    fireClick(
      findNodeByProp(rowOf(list[UI], "Alpha"), "title", "Delete"),
      "Alpha's delete button",
    )
  );

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_named_empty = assert(() => list[NAME] === "☑ List: Empty");
  const assert_named_none_done = assert(() =>
    list[NAME] === "☑ List: 0/3" &&
    list.summary === "○ First item, ○ Second item, ○ Third item"
  );
  const assert_seeded_reports_done = assert(() =>
    seeded[NAME] === "☑ List: 1/2" && seeded.summary === "✓ Milk, ○ Eggs"
  );

  // Initial state
  const assert_empty = assert(() => {
    return list.items.filter(() => true).length === 0;
  });

  // After adding items
  const assert_has_one = assert(() => {
    return list.items.filter(() => true).length === 1;
  });

  const assert_first_text = assert(() => {
    return list.items[0]?.text === "First item";
  });

  const assert_first_not_indented = assert(() => {
    return list.items[0]?.indented === false;
  });

  const assert_first_not_done = assert(() => {
    return list.items[0]?.done === false;
  });

  const assert_has_two = assert(() => {
    return list.items.filter(() => true).length === 2;
  });

  const assert_has_three = assert(() => {
    return list.items.filter(() => true).length === 3;
  });

  // After toggle indent on first item
  const assert_first_indented = assert(() => {
    return list.items[0]?.indented === true;
  });

  // After setIndent on second item
  const assert_second_indented = assert(() => {
    return list.items[1]?.indented === true;
  });

  const assert_second_not_indented = assert(() => {
    return list.items[1]?.indented === false;
  });

  const assert_second_is_third = assert(() => {
    // After deleting "Second item", "Third item" should now be at index 1
    return list.items[1]?.text === "Third item";
  });

  const assert_remaining_is_third = assert(() => {
    return list.items[0]?.text === "Third item";
  });

  const assert_submitted_two = assert(() =>
    list.items.length === 2 && list.items[0]?.text === "Alpha" &&
    list.items[1]?.text === "Beta" && list[NAME] === "☑ List: 0/2"
  );
  const assert_beta_indented = assert(() =>
    list.items[1]?.indented === true && list.items[0]?.indented === false
  );
  const assert_beta_outdented = assert(() => list.items[1]?.indented === false);
  // The toggle's title says what a click does next.
  const assert_alpha_toggle_offers_indent = assert(() =>
    propValue(indentToggle(list[UI], "Alpha"), "title") === "Indent"
  );
  const assert_alpha_indented = assert(() =>
    list.items[0]?.indented === true &&
    propValue(indentToggle(list[UI], "Alpha"), "title") === "Outdent"
  );
  const assert_alpha_deleted = assert(() =>
    list.items.length === 1 && list.items[0]?.text === "Beta" &&
    rowOf(list[UI], "Alpha") === undefined
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      // Initial state
      { assertion: assert_empty },
      { assertion: assert_named_empty },
      { assertion: assert_seeded_reports_done },

      // Add items
      { action: action_add_first },
      { assertion: assert_has_one },
      { assertion: assert_first_text },
      { assertion: assert_first_not_indented },
      { assertion: assert_first_not_done },

      { action: action_add_second },
      { assertion: assert_has_two },

      { action: action_add_third },
      { assertion: assert_has_three },
      { assertion: assert_named_none_done },

      // Empty/whitespace ignored
      { action: action_add_empty },
      { assertion: assert_has_three },
      { action: action_add_whitespace },
      { assertion: assert_has_three },

      // Toggle indent
      { action: action_toggle_indent_0 },
      { assertion: assert_first_indented },
      { action: action_toggle_indent_0 },
      { assertion: assert_first_not_indented },

      // Set indent directly
      { action: action_set_indent_1_true },
      { assertion: assert_second_indented },
      { action: action_set_indent_1_false },
      { assertion: assert_second_not_indented },

      // Delete middle item
      { action: action_delete_1 },
      { assertion: assert_has_two },
      { assertion: assert_second_is_third },

      // Delete first item
      { action: action_delete_0 },
      { assertion: assert_has_one },
      { assertion: assert_remaining_is_third },

      // Delete last item
      { action: action_delete_0 },
      { assertion: assert_empty },

      // Invalid operations should be no-ops
      { action: action_toggle_invalid },
      { assertion: assert_empty },
      { action: action_delete_invalid },
      { assertion: assert_empty },

      // The add-item field ignores an empty submission
      { action: action_submit_alpha },
      { action: action_submit_nothing },
      { action: action_submit_beta },
      { assertion: assert_submitted_two },

      // Cmd+] indents and Ctrl+[ outdents; other keys change nothing
      { action: action_cmd_close_bracket_beta },
      { assertion: assert_beta_indented },
      { action: action_plain_keys_beta },
      { assertion: assert_beta_indented },
      { action: action_ctrl_open_bracket_beta },
      { assertion: assert_beta_outdented },
      { action: action_plain_keys_beta },
      { assertion: assert_beta_outdented },

      // The row's buttons
      { assertion: assert_alpha_toggle_offers_indent },
      { action: action_click_indent_alpha },
      { assertion: assert_alpha_indented },
      { action: action_click_delete_alpha },
      { assertion: assert_alpha_deleted },
    ],
    // Expose subject for debugging
    list,
  };
});
