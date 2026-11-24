/**
 * Test: Does .length track reactively?
 *
 * This test compares two approaches:
 * 1. Direct .length access
 * 2. .filter(() => true).length (forces iteration)
 *
 * If both pass: .length tracking works fine
 * If only filter passes: .length doesn't establish reactive dependency
 *
 * Run: deno task cf test patterns/dev/gideon-tests/array-length-repro.test.tsx --verbose
 */
import { action, assert, pattern, TESTS } from "commonfabric";
import ArrayLengthRepro from "./array-length-repro.tsx";

export default pattern(() => {
  const subject = ArrayLengthRepro({ items: [] });

  // Action to add an item
  const action_add_item = action(() => {
    subject.addItem.send({ name: "Test" });
  });

  // === Approach 1: Direct .length ===
  const assert_initial_length_direct = assert(
    () => subject.items.length === 0,
  );

  const assert_one_item_length_direct = assert(
    () => subject.items.length === 1,
  );

  // === Approach 2: .filter().length ===
  const assert_initial_length_filter = assert(
    () => subject.items.filter(() => true).length === 0,
  );

  const assert_one_item_length_filter = assert(
    () => subject.items.filter(() => true).length === 1,
  );

  // === Approach 3: Check via array method that iterates ===
  const assert_initial_empty_some = assert(
    () => !subject.items.some(() => true),
  );

  const assert_one_item_some = assert(
    () => subject.items.some(() => true),
  );

  // === Approach 4: Via string templates ===
  const assert_initial_empty_template = assert(
    () => `length: ${subject.items.length}` === "length: 0",
  );

  const assert_one_item_template = assert(
    () => `length: ${subject.items.length}` === "length: 1",
  );

  return {
    [TESTS]: [
      // Initial state - all approaches
      { assertion: assert_initial_length_direct },
      { assertion: assert_initial_length_filter },
      { assertion: assert_initial_empty_some },
      { assertion: assert_initial_empty_template },

      // Add item
      { action: action_add_item },

      // After adding - compare approaches
      { assertion: assert_one_item_length_direct },
      { assertion: assert_one_item_length_filter },
      { assertion: assert_one_item_some },
      { assertion: assert_one_item_template },
    ],
    subject,
  };
});
