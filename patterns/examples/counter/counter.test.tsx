/**
 * Test Pattern: Counter
 *
 * Tests the core functionality of the counter pattern:
 * - Initial state (value defaults to 0)
 * - Increment via module-scope handler
 * - Decrement via pattern-body action
 * - Multiple increments/decrements
 * - Negative values
 *
 * Run: deno task cf test patterns/examples/counter/counter.test.tsx --verbose
 */
import { action, assert, pattern, TESTS } from "commonfabric";
import Counter from "./counter.tsx";

export default pattern(() => {
  // Instantiate the counter pattern with default value (0)
  const counter = Counter({});

  // Also test with a non-zero initial value
  const counterStartingAt5 = Counter({ value: 5 });

  // ==========================================================================
  // Actions - using action() to trigger stream sends
  // ==========================================================================

  // Increment once (tests module-scope handler)
  const action_increment = action(() => {
    counter.increment.send();
  });

  // Increment again
  const action_increment_again = action(() => {
    counter.increment.send();
  });

  // Decrement once (tests pattern-body action)
  const action_decrement = action(() => {
    counter.decrement.send();
  });

  // Decrement multiple times to go negative
  const action_decrement_twice = action(() => {
    counter.decrement.send();
    counter.decrement.send();
  });

  // Test the counter that starts at 5
  const action_decrement_from_5 = action(() => {
    counterStartingAt5.decrement.send();
  });

  const action_increment_from_5 = action(() => {
    counterStartingAt5.increment.send();
  });

  // ==========================================================================
  // Assertions - assert() over pattern state
  // ==========================================================================

  // Initial state assertions
  const assert_initial_value_is_0 = assert(() => counter.value === 0);
  const assert_initial_value_is_5 = assert(() =>
    counterStartingAt5.value === 5
  );

  // After first increment
  const assert_value_is_1 = assert(() => counter.value === 1);

  // After second increment
  const assert_value_is_2 = assert(() => counter.value === 2);

  // After decrement (back to 1)
  const assert_value_is_1_again = assert(() => counter.value === 1);

  // After decrementing twice more (goes to -1)
  const assert_value_is_negative_1 = assert(() => counter.value === -1);

  // Counter starting at 5: after decrement should be 4
  const assert_from_5_is_4 = assert(() => counterStartingAt5.value === 4);

  // Counter starting at 5: after increment should be 5 again
  const assert_from_5_back_to_5 = assert(() => counterStartingAt5.value === 5);

  // After another increment should be 6
  const action_increment_to_6 = action(() => {
    counterStartingAt5.increment.send();
  });
  const assert_from_5_is_6 = assert(() => counterStartingAt5.value === 6);

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      // === Test 1: Initial state ===
      { assertion: assert_initial_value_is_0 },
      { assertion: assert_initial_value_is_5 },

      // === Test 2: Increment (module-scope handler) ===
      { action: action_increment },
      { assertion: assert_value_is_1 },

      // === Test 3: Increment again ===
      { action: action_increment_again },
      { assertion: assert_value_is_2 },

      // === Test 4: Decrement (pattern-body action) ===
      { action: action_decrement },
      { assertion: assert_value_is_1_again },

      // === Test 5: Decrement to negative ===
      { action: action_decrement_twice },
      { assertion: assert_value_is_negative_1 },

      // === Test 6: Counter with initial value of 5 ===
      { action: action_decrement_from_5 },
      { assertion: assert_from_5_is_4 },

      // === Test 7: Increment back up ===
      { action: action_increment_from_5 },
      { assertion: assert_from_5_back_to_5 },

      // === Test 8: Increment past initial value ===
      { action: action_increment_to_6 },
      { assertion: assert_from_5_is_6 },
    ],
    // Expose subjects for debugging
    counter,
    counterStartingAt5,
  };
});
