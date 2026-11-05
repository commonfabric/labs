/**
 * Test Pattern: Reading Item Detail
 *
 * Tests for the reading-item-detail pattern in isolation:
 * - Initial state with defaults
 * - Setting status via action
 * - Setting rating via action
 * - Setting notes via action
 * - Status transitions (want -> reading -> finished)
 * - Clearing rating (set to null)
 *
 * Run: deno task cf test patterns/examples/reading-list/reading-item-detail.test.tsx --verbose
 */
import { action, assert, pattern, TESTS } from "commonfabric";
import ReadingItemDetail from "./reading-item-detail.tsx";

export default pattern(() => {
  // Create a reading item with specific initial values
  const item = ReadingItemDetail({
    title: "Test Book",
    author: "Test Author",
    type: "book",
  });

  // ==========================================================================
  // Actions
  // ==========================================================================

  // Status transitions
  const action_set_reading = action(() => {
    item.setStatus.send({ status: "reading" });
  });

  const action_set_finished = action(() => {
    item.setStatus.send({ status: "finished" });
  });

  const action_set_abandoned = action(() => {
    item.setStatus.send({ status: "abandoned" });
  });

  const action_set_want = action(() => {
    item.setStatus.send({ status: "want" });
  });

  // Rating actions
  const action_rate_5 = action(() => {
    item.setRating.send({ rating: 5 });
  });

  const action_rate_3 = action(() => {
    item.setRating.send({ rating: 3 });
  });

  const action_clear_rating = action(() => {
    item.setRating.send({ rating: null });
  });

  // Notes actions
  const action_add_notes = action(() => {
    item.setNotes.send({ notes: "Great read, highly recommend!" });
  });

  const action_update_notes = action(() => {
    item.setNotes.send({ notes: "Updated: Even better on second read." });
  });

  const action_clear_notes = action(() => {
    item.setNotes.send({ notes: "" });
  });

  // ==========================================================================
  // Assertions - Initial State
  // ==========================================================================

  const assert_initial_title = assert(() => item.title === "Test Book");
  const assert_initial_author = assert(() => item.author === "Test Author");
  const assert_initial_type = assert(() => item.type === "book");
  const assert_initial_status = assert(() => item.status === "want");
  const assert_initial_rating = assert(() => item.rating === null);
  const assert_initial_notes = assert(() => item.notes === "");

  // ==========================================================================
  // Assertions - Status Changes
  // ==========================================================================

  const assert_status_reading = assert(() => item.status === "reading");
  const assert_status_finished = assert(() => item.status === "finished");
  const assert_status_abandoned = assert(() => item.status === "abandoned");
  const assert_status_want = assert(() => item.status === "want");

  // ==========================================================================
  // Assertions - Rating Changes
  // ==========================================================================

  const assert_rating_5 = assert(() => item.rating === 5);
  const assert_rating_3 = assert(() => item.rating === 3);
  const assert_rating_null = assert(() => item.rating === null);

  // ==========================================================================
  // Assertions - Notes Changes
  // ==========================================================================

  const assert_notes_added = assert(
    () => item.notes === "Great read, highly recommend!",
  );
  const assert_notes_updated = assert(
    () => item.notes === "Updated: Even better on second read.",
  );
  const assert_notes_cleared = assert(() => item.notes === "");

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      // === Initial state ===
      { assertion: assert_initial_title },
      { assertion: assert_initial_author },
      { assertion: assert_initial_type },
      { assertion: assert_initial_status },
      { assertion: assert_initial_rating },
      { assertion: assert_initial_notes },

      // === Status workflow: want -> reading -> finished ===
      { action: action_set_reading },
      { assertion: assert_status_reading },

      { action: action_set_finished },
      { assertion: assert_status_finished },

      // === Rating ===
      { action: action_rate_5 },
      { assertion: assert_rating_5 },

      { action: action_rate_3 },
      { assertion: assert_rating_3 },

      { action: action_clear_rating },
      { assertion: assert_rating_null },

      // === Notes ===
      { action: action_add_notes },
      { assertion: assert_notes_added },

      { action: action_update_notes },
      { assertion: assert_notes_updated },

      { action: action_clear_notes },
      { assertion: assert_notes_cleared },

      // === Status: can go back to want ===
      { action: action_set_want },
      { assertion: assert_status_want },

      // === Status: can go to abandoned ===
      { action: action_set_abandoned },
      { assertion: assert_status_abandoned },
    ],
    // Expose for debugging
    item,
  };
});
