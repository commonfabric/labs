/**
 * Test Pattern: Reading List
 *
 * Comprehensive tests for the reading-list pattern:
 * - Initial state (empty list)
 * - Adding items with different types
 * - Removing items
 * - Empty/whitespace title handling
 * - Item count tracking (total and filtered)
 * - Status filtering (all, want, reading, finished, abandoned)
 * - Modifying item properties (status, rating, notes)
 * - Composition: items are ReadingItemDetail pieces with their own state
 *
 * Run: deno task cf test patterns/examples/reading-list/reading-list.test.tsx --verbose
 */
import { action, assert, pattern, TESTS } from "commonfabric";
import ReadingList from "./reading-list.tsx";

export default pattern(() => {
  // Instantiate the reading list pattern with default empty list
  const list = ReadingList({});

  // ==========================================================================
  // Actions - Adding Items
  // ==========================================================================

  const action_add_article = action(() => {
    list.addItem.send({
      title: "Great Article",
      author: "Jane Doe",
      type: "article",
    });
  });

  const action_add_book = action(() => {
    list.addItem.send({
      title: "Amazing Book",
      author: "John Smith",
      type: "book",
    });
  });

  const action_add_paper = action(() => {
    list.addItem.send({
      title: "Research Paper",
      author: "Dr. Science",
      type: "paper",
    });
  });

  const action_add_video = action(() => {
    list.addItem.send({ title: "Tutorial Video", author: "", type: "video" });
  });

  // Empty/whitespace should be ignored
  const action_add_empty = action(() => {
    list.addItem.send({ title: "", author: "Author", type: "article" });
  });

  const action_add_whitespace = action(() => {
    list.addItem.send({ title: "   ", author: "Author", type: "article" });
  });

  // ==========================================================================
  // Actions - Modifying Item Status
  // ==========================================================================

  // Change first item (article) to "reading"
  const action_set_first_reading = action(() => {
    const items = list.items;
    if (items && items[0]) {
      list.updateItem.send({ item: items[0], status: "reading" });
    }
  });

  // Change second item (book) to "finished"
  const action_set_second_finished = action(() => {
    const items = list.items;
    if (items && items[1]) {
      list.updateItem.send({ item: items[1], status: "finished" });
    }
  });

  // Change third item (paper) to "abandoned"
  const action_set_third_abandoned = action(() => {
    const items = list.items;
    if (items && items[2]) {
      list.updateItem.send({ item: items[2], status: "abandoned" });
    }
  });

  // Fourth item (video) stays at default "want"

  // ==========================================================================
  // Actions - Modifying Item Properties
  // ==========================================================================

  // Add rating to the finished book
  const action_rate_book = action(() => {
    const items = list.items;
    if (items && items[1]) {
      list.updateItem.send({ item: items[1], rating: 5 });
    }
  });

  // Add notes to the reading article
  const action_add_notes_to_article = action(() => {
    const items = list.items;
    if (items && items[0]) {
      list.updateItem.send({
        item: items[0],
        notes: "Really insightful piece about reactive programming",
      });
    }
  });

  // ==========================================================================
  // Actions - Filtering
  // ==========================================================================

  const action_filter_all = action(() => {
    list.setFilter.send({ status: "all" });
  });

  const action_filter_want = action(() => {
    list.setFilter.send({ status: "want" });
  });

  const action_filter_reading = action(() => {
    list.setFilter.send({ status: "reading" });
  });

  const action_filter_finished = action(() => {
    list.setFilter.send({ status: "finished" });
  });

  const action_filter_abandoned = action(() => {
    list.setFilter.send({ status: "abandoned" });
  });

  // ==========================================================================
  // Actions - Removing Items
  // ==========================================================================

  const action_remove_first = action(() => {
    const items = list.items;
    if (items && items[0]) {
      list.removeItem.send({ item: items[0] });
    }
  });

  const action_remove_all_remaining = action(() => {
    // Remove items one by one (3 remaining after first remove)
    const items = list.items;
    if (items && items[0]) list.removeItem.send({ item: items[0] });
  });

  // ==========================================================================
  // Assertions - Initial State
  // ==========================================================================

  const assert_initial_empty = assert(() => list.totalCount === 0);
  const assert_initial_filter_all = assert(() => list.currentFilter === "all");
  const assert_initial_filtered_empty = assert(() => list.filteredCount === 0);

  // ==========================================================================
  // Assertions - After Adding Items
  // ==========================================================================

  const assert_has_one = assert(() => list.totalCount === 1);
  const assert_first_is_article = assert(() => {
    return (
      list.items[0]?.title === "Great Article" &&
      list.items[0]?.type === "article" &&
      list.items[0]?.author === "Jane Doe" &&
      list.items[0]?.status === "want" // default status
    );
  });

  const assert_has_two = assert(() => list.totalCount === 2);
  const assert_second_is_book = assert(() => {
    return (
      list.items[1]?.title === "Amazing Book" &&
      list.items[1]?.type === "book" &&
      list.items[1]?.status === "want"
    );
  });

  const assert_has_three = assert(() => list.totalCount === 3);
  const assert_has_four = assert(() => list.totalCount === 4);

  const assert_video_has_empty_author = assert(() => {
    return (
      list.items[3]?.title === "Tutorial Video" && list.items[3]?.author === ""
    );
  });

  // Empty/whitespace shouldn't add
  const assert_still_four = assert(() => list.totalCount === 4);

  // ==========================================================================
  // Assertions - After Status Changes
  // ==========================================================================

  const assert_first_is_reading = assert(
    () => list.items[0]?.status === "reading",
  );
  const assert_second_is_finished = assert(
    () => list.items[1]?.status === "finished",
  );
  const assert_third_is_abandoned = assert(
    () => list.items[2]?.status === "abandoned",
  );
  const assert_fourth_is_want = assert(
    () => list.items[3]?.status === "want",
  );

  // ==========================================================================
  // Assertions - After Property Changes
  // ==========================================================================

  const assert_book_has_rating = assert(() => list.items[1]?.rating === 5);
  const assert_article_has_notes = assert(() =>
    list.items[0]?.notes ===
      "Really insightful piece about reactive programming"
  );

  // ==========================================================================
  // Assertions - Filtering
  // ==========================================================================

  // When filter is "all", should show all 4 items
  const assert_filter_all_shows_four = assert(() => {
    return list.currentFilter === "all" && list.filteredCount === 4;
  });

  // When filter is "want", should show 1 item (video)
  const assert_filter_want_shows_one = assert(() => {
    return list.currentFilter === "want" && list.filteredCount === 1;
  });
  const assert_filter_want_correct_item = assert(() => {
    return list.filteredItems[0]?.title === "Tutorial Video";
  });

  // When filter is "reading", should show 1 item (article)
  const assert_filter_reading_shows_one = assert(() => {
    return list.currentFilter === "reading" && list.filteredCount === 1;
  });
  const assert_filter_reading_correct_item = assert(() => {
    return list.filteredItems[0]?.title === "Great Article";
  });

  // When filter is "finished", should show 1 item (book)
  const assert_filter_finished_shows_one = assert(() => {
    return list.currentFilter === "finished" && list.filteredCount === 1;
  });
  const assert_filter_finished_correct_item = assert(() => {
    return list.filteredItems[0]?.title === "Amazing Book";
  });

  // When filter is "abandoned", should show 1 item (paper)
  const assert_filter_abandoned_shows_one = assert(() => {
    return list.currentFilter === "abandoned" && list.filteredCount === 1;
  });
  const assert_filter_abandoned_correct_item = assert(() => {
    return list.filteredItems[0]?.title === "Research Paper";
  });

  // ==========================================================================
  // Assertions - After Removal
  // ==========================================================================

  const assert_has_three_after_remove = assert(() => list.totalCount === 3);
  const assert_first_is_now_book = assert(() => {
    return list.items[0]?.title === "Amazing Book";
  });

  const assert_has_two_after_remove = assert(() => list.totalCount === 2);
  const assert_has_one_after_remove = assert(() => list.totalCount === 1);
  const assert_back_to_empty = assert(() => list.totalCount === 0);

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      // === Initial state ===
      { assertion: assert_initial_empty },
      { assertion: assert_initial_filter_all },
      { assertion: assert_initial_filtered_empty },

      { action: action_add_article },
      { assertion: assert_has_one },
      { assertion: assert_first_is_article },
      { action: action_add_book },
      { assertion: assert_has_two },
      { assertion: assert_second_is_book },
      { action: action_add_paper },
      { assertion: assert_has_three },
      { action: action_add_video },
      { assertion: assert_has_four },
      { assertion: assert_video_has_empty_author },
      { action: action_add_empty },
      { assertion: assert_still_four },
      { action: action_add_whitespace },
      { assertion: assert_still_four },
      { action: action_set_first_reading },
      { assertion: assert_first_is_reading },
      { action: action_set_second_finished },
      { assertion: assert_second_is_finished },
      { action: action_set_third_abandoned },
      { assertion: assert_third_is_abandoned },
      { assertion: assert_fourth_is_want },
      { action: action_rate_book },
      { assertion: assert_book_has_rating },
      { action: action_add_notes_to_article },
      { assertion: assert_article_has_notes },
      { assertion: assert_filter_all_shows_four },
      { action: action_filter_want },
      { assertion: assert_filter_want_shows_one },
      { assertion: assert_filter_want_correct_item },
      { action: action_filter_reading },
      { assertion: assert_filter_reading_shows_one },
      { assertion: assert_filter_reading_correct_item },
      { action: action_filter_finished },
      { assertion: assert_filter_finished_shows_one },
      { assertion: assert_filter_finished_correct_item },
      { action: action_filter_abandoned },
      { assertion: assert_filter_abandoned_shows_one },
      { assertion: assert_filter_abandoned_correct_item },
      { action: action_filter_all },
      { assertion: assert_filter_all_shows_four },
      { action: action_remove_first },
      { assertion: assert_has_three_after_remove },
      { assertion: assert_first_is_now_book },
      { action: action_remove_all_remaining },
      { assertion: assert_has_two_after_remove },
      { action: action_remove_all_remaining },
      { assertion: assert_has_one_after_remove },
      { action: action_remove_all_remaining },
      { assertion: assert_back_to_empty },
    ],
    // Expose subject for debugging
    list,
  };
});
