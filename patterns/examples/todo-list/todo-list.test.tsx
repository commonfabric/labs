/**
 * Test Pattern: Todo List
 *
 * Tests the core functionality of the todo-list pattern:
 * - Initial state (empty list)
 * - Adding items
 * - Removing items
 * - Item count updates
 * - Multiple items
 * - Empty string handling (should not add)
 *
 * Run: deno task cf test patterns/examples/todo-list/todo-list.test.tsx --verbose
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  findElement,
  hasText,
  sendMessage,
} from "../../tools/test-support/vnode-helpers.ts";
import TodoList, { type TodoItem } from "./todo-list.tsx";

export default pattern(() => {
  // Instantiate the todo list pattern with default empty list
  const todoList = TodoList({});

  // A second list driven through its rendered controls rather than its
  // streams. The test holds its store so that it can tick an item off, as the
  // item's checkbox does.
  const viewStore = Writable.of<TodoItem[]>([]);
  const viaView = TodoList({ items: viewStore });

  // ==========================================================================
  // Actions - using action() to trigger stream sends
  // ==========================================================================

  // Add first item
  const action_add_first_item = action(() => {
    todoList.addItem.send({ title: "Buy groceries" });
  });

  // Add second item
  const action_add_second_item = action(() => {
    todoList.addItem.send({ title: "Walk the dog" });
  });

  // Add third item
  const action_add_third_item = action(() => {
    todoList.addItem.send({ title: "Read a book" });
  });

  // Try to add empty string (should be ignored)
  const action_add_empty_string = action(() => {
    todoList.addItem.send({ title: "" });
  });

  // Try to add whitespace only (should be ignored)
  const action_add_whitespace = action(() => {
    todoList.addItem.send({ title: "   " });
  });

  // Remove the second item (Walk the dog)
  const action_remove_second_item = action(() => {
    const items = todoList.items.filter(() => true);
    const walkTheDog = items.find((item) => item.title === "Walk the dog");
    if (walkTheDog) {
      todoList.removeItem.send({ item: walkTheDog });
    }
  });

  // Remove the first item (Buy groceries)
  const action_remove_first_item = action(() => {
    const items = todoList.items.filter(() => true);
    const buyGroceries = items.find((item) => item.title === "Buy groceries");
    if (buyGroceries) {
      todoList.removeItem.send({ item: buyGroceries });
    }
  });

  // Remove the last item (Read a book)
  const action_remove_last_item = action(() => {
    const items = todoList.items.filter(() => true);
    const readBook = items.find((item) => item.title === "Read a book");
    if (readBook) {
      todoList.removeItem.send({ item: readBook });
    }
  });

  // ==========================================================================
  // Assertions - assert() over pattern state
  // ==========================================================================

  // Initial state
  const assert_empty = assert(() => {
    return todoList.items.filter(() => true).length === 0;
  });

  const assert_count_0 = assert(() => {
    return todoList.itemCount === 0;
  });

  // After adding first item
  const assert_has_one_item = assert(() => {
    return todoList.items.filter(() => true).length === 1;
  });

  const assert_count_is_1 = assert(() => {
    return todoList.itemCount === 1;
  });

  const assert_first_item_title = assert(() => {
    return todoList.items[0]?.title === "Buy groceries";
  });

  const assert_first_item_not_done = assert(() => {
    return todoList.items[0]?.done === false;
  });

  // After adding second item
  const assert_has_two_items = assert(() => {
    return todoList.items.filter(() => true).length === 2;
  });

  const assert_count_is_2 = assert(() => {
    return todoList.itemCount === 2;
  });

  const assert_second_item_title = assert(() => {
    return todoList.items[1]?.title === "Walk the dog";
  });

  // After adding third item
  const assert_has_three_items = assert(() => {
    return todoList.items.filter(() => true).length === 3;
  });

  const assert_count_is_3 = assert(() => {
    return todoList.itemCount === 3;
  });

  const assert_walk_dog_removed = assert(() => {
    return !todoList.items.some((item) => item.title === "Walk the dog");
  });

  const assert_groceries_still_exists = assert(() => {
    return todoList.items.some((item) => item.title === "Buy groceries");
  });

  const assert_book_still_exists = assert(() => {
    return todoList.items.some((item) => item.title === "Read a book");
  });

  const assert_groceries_removed = assert(() => {
    return !todoList.items.some((item) => item.title === "Buy groceries");
  });

  // ==========================================================================
  // The second list, driven through its view
  // ==========================================================================

  const assert_view_starts_empty = assert(() =>
    viaView[NAME] === "Todo List (0)" &&
    findElement(viaView[UI], "cf-empty-state") !== undefined &&
    hasText(viaView[UI], "0 items")
  );

  const action_send_blank_message = action(() =>
    sendMessage(viaView[UI], "   ")
  );
  const assert_blank_message_ignored = assert(() => viaView.items.length === 0);

  const action_send_messages = action(() => {
    sendMessage(viaView[UI], "  File taxes ");
    sendMessage(viaView[UI], "Water plants");
  });
  const assert_messages_added_trimmed = assert(() =>
    viaView.items.length === 2 && viaView.items[0].title === "File taxes" &&
    viaView.items[1].title === "Water plants" &&
    viaView.items[0].done === false
  );

  const action_tick_first_item = action(() => {
    viewStore.key(0).key("done").set(true);
  });
  const assert_list_names_itself = assert(() =>
    viaView[NAME] === "Todo List (2)"
  );
  const assert_summary_marks_done = assert(() =>
    viaView.summary === "✓ File taxes, ○ Water plants"
  );
  // Only the open item is offered as a mention, under its own title.
  const assert_open_item_is_mentionable = assert(() =>
    viaView.mentionable.length === 1 &&
    viaView.mentionable[0][NAME] === "Water plants" &&
    viaView.mentionable[0].summary === "Water plants"
  );
  const assert_header_counts_open_items = assert(() =>
    hasText(viaView[UI], "1 items") &&
    findElement(viaView[UI], "cf-empty-state") === undefined
  );
  // A completed item shows its title as text; an open one holds it in an
  // input.
  const assert_completed_section_shown = assert(() =>
    hasText(viaView[UI], "Completed (1)") &&
    hasText(viaView[UI], "File taxes") &&
    !hasText(viaView[UI], "Water plants")
  );

  // The open item's "x" is the only one: completed items have none.
  const action_click_remove = action(() => clickButton(viaView[UI], "x"));
  const assert_open_item_removed = assert(() =>
    viaView.items.length === 1 && viaView.items[0].title === "File taxes" &&
    findElement(viaView[UI], "cf-empty-state") !== undefined
  );

  const action_click_archive = action(() =>
    clickButton(viaView[UI], "Archive all")
  );
  const assert_completed_archived = assert(() =>
    viaView.items.length === 0 && viaView[NAME] === "Todo List (0)" &&
    !hasText(viaView[UI], "Completed (")
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      // === Test 1: Initial state ===
      { assertion: assert_empty },
      { assertion: assert_count_0 },

      // === Test 2: Add first item ===
      { action: action_add_first_item },
      { assertion: assert_has_one_item },
      { assertion: assert_count_is_1 },
      { assertion: assert_first_item_title },
      { assertion: assert_first_item_not_done },

      // === Test 3: Add second item ===
      { action: action_add_second_item },
      { assertion: assert_has_two_items },
      { assertion: assert_count_is_2 },
      { assertion: assert_second_item_title },

      // === Test 4: Add third item ===
      { action: action_add_third_item },
      { assertion: assert_has_three_items },
      { assertion: assert_count_is_3 },

      // === Test 5: Empty string should not add item ===
      { action: action_add_empty_string },
      { assertion: assert_has_three_items },

      // === Test 6: Whitespace only should not add item ===
      { action: action_add_whitespace },
      { assertion: assert_has_three_items },

      // === Test 7: Remove middle item ===
      { action: action_remove_second_item },
      { assertion: assert_has_two_items },
      { assertion: assert_walk_dog_removed },
      { assertion: assert_groceries_still_exists },
      { assertion: assert_book_still_exists },

      // === Test 8: Remove first item ===
      { action: action_remove_first_item },
      { assertion: assert_has_one_item },
      { assertion: assert_groceries_removed },

      // === Test 9: Remove last item - back to empty ===
      { action: action_remove_last_item },
      { assertion: assert_empty },
      { assertion: assert_count_0 },

      // === Test 10: The message input adds trimmed, non-blank titles ===
      { assertion: assert_view_starts_empty },
      { action: action_send_blank_message },
      { assertion: assert_blank_message_ignored },
      { action: action_send_messages },
      { assertion: assert_messages_added_trimmed },

      // === Test 11: A ticked item moves to the completed section ===
      { action: action_tick_first_item },
      { assertion: assert_list_names_itself },
      { assertion: assert_summary_marks_done },
      { assertion: assert_open_item_is_mentionable },
      { assertion: assert_header_counts_open_items },
      { assertion: assert_completed_section_shown },

      // === Test 12: The row's "x" removes the open item ===
      { action: action_click_remove },
      { assertion: assert_open_item_removed },

      // === Test 13: "Archive all" drops the completed items ===
      { action: action_click_archive },
      { assertion: assert_completed_archived },
    ],
    // Expose subjects for debugging
    todoList,
    viaView,
  };
});
