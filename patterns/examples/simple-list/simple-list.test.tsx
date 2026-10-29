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
 *
 * Run: deno task cf test patterns/examples/simple-list/simple-list.test.tsx --verbose
 */
import { action, assert, pattern, TESTS } from "commonfabric";
import SimpleListModule from "./simple-list.tsx";

export default pattern(() => {
  // Instantiate the simple list pattern with default empty list
  const list = SimpleListModule({});

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

  // Delete last remaining item
  const action_delete_last = action(() => {
    list.deleteItem.send({ index: 0 });
  });

  // Invalid index operations (should be no-ops)
  const action_toggle_invalid = action(() => {
    list.toggleIndent.send({ index: 999 });
  });

  const action_delete_invalid = action(() => {
    list.deleteItem.send({ index: -1 });
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  // Initial state
  const assert_initial_empty = assert(() => {
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

  // Empty string shouldn't add
  const assert_still_three = assert(() => {
    return list.items.filter(() => true).length === 3;
  });

  // After toggle indent on first item
  const assert_first_indented = assert(() => {
    return list.items[0]?.indented === true;
  });

  // After toggle again (back to not indented)
  const assert_first_not_indented_again = assert(() => {
    return list.items[0]?.indented === false;
  });

  // After setIndent on second item
  const assert_second_indented = assert(() => {
    return list.items[1]?.indented === true;
  });

  const assert_second_not_indented = assert(() => {
    return list.items[1]?.indented === false;
  });

  // After deleting middle item
  const assert_back_to_two = assert(() => {
    return list.items.filter(() => true).length === 2;
  });

  const assert_second_is_third = assert(() => {
    // After deleting "Second item", "Third item" should now be at index 1
    return list.items[1]?.text === "Third item";
  });

  // After deleting first item
  const assert_down_to_one = assert(() => {
    return list.items.filter(() => true).length === 1;
  });

  const assert_remaining_is_third = assert(() => {
    return list.items[0]?.text === "Third item";
  });

  // After deleting last item
  const assert_back_to_empty = assert(() => {
    return list.items.filter(() => true).length === 0;
  });

  // After invalid operations (should still be empty, no crash)
  const assert_still_empty = assert(() => {
    return list.items.filter(() => true).length === 0;
  });

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      // Initial state
      { assertion: assert_initial_empty },

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

      // Empty/whitespace ignored
      { action: action_add_empty },
      { assertion: assert_still_three },
      { action: action_add_whitespace },
      { assertion: assert_still_three },

      // Toggle indent
      { action: action_toggle_indent_0 },
      { assertion: assert_first_indented },
      { action: action_toggle_indent_0 },
      { assertion: assert_first_not_indented_again },

      // Set indent directly
      { action: action_set_indent_1_true },
      { assertion: assert_second_indented },
      { action: action_set_indent_1_false },
      { assertion: assert_second_not_indented },

      // Delete middle item
      { action: action_delete_1 },
      { assertion: assert_back_to_two },
      { assertion: assert_second_is_third },

      // Delete first item
      { action: action_delete_0 },
      { assertion: assert_down_to_one },
      { assertion: assert_remaining_is_third },

      // Delete last item
      { action: action_delete_last },
      { assertion: assert_back_to_empty },

      // Invalid operations should be no-ops
      { action: action_toggle_invalid },
      { assertion: assert_still_empty },
      { action: action_delete_invalid },
      { assertion: assert_still_empty },
    ],
    // Expose subject for debugging
    list,
  };
});
