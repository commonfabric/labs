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
import { action, assert, pattern, TESTS } from "commonfabric";
import TodoList from "./todo-list.tsx";

export default pattern(() => {
  // Instantiate the todo list pattern with default empty list
  const todoList = TodoList({});

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
  const assert_initial_empty = assert(() => {
    return todoList.items.filter(() => true).length === 0;
  });

  const assert_initial_count_0 = assert(() => {
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

  // After trying to add empty string (count should still be 3)
  const assert_still_three_items = assert(() => {
    return todoList.items.filter(() => true).length === 3;
  });

  // After removing second item
  const assert_back_to_two_items = assert(() => {
    return todoList.items.filter(() => true).length === 2;
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

  // After removing first item
  const assert_down_to_one_item = assert(() => {
    return todoList.items.filter(() => true).length === 1;
  });

  const assert_groceries_removed = assert(() => {
    return !todoList.items.some((item) => item.title === "Buy groceries");
  });

  // After removing last item
  const assert_back_to_empty = assert(() => {
    return todoList.items.filter(() => true).length === 0;
  });

  const assert_final_count_0 = assert(() => {
    return todoList.itemCount === 0;
  });

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      // === Test 1: Initial state ===
      { assertion: assert_initial_empty },
      { assertion: assert_initial_count_0 },

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
      { assertion: assert_still_three_items },

      // === Test 6: Whitespace only should not add item ===
      { action: action_add_whitespace },
      { assertion: assert_still_three_items },

      // === Test 7: Remove middle item ===
      { action: action_remove_second_item },
      { assertion: assert_back_to_two_items },
      { assertion: assert_walk_dog_removed },
      { assertion: assert_groceries_still_exists },
      { assertion: assert_book_still_exists },

      // === Test 8: Remove first item ===
      { action: action_remove_first_item },
      { assertion: assert_down_to_one_item },
      { assertion: assert_groceries_removed },

      // === Test 9: Remove last item - back to empty ===
      { action: action_remove_last_item },
      { assertion: assert_back_to_empty },
      { assertion: assert_final_count_0 },
    ],
    // Expose subject for debugging
    todoList,
  };
});
