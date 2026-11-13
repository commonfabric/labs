/**
 * Test Pattern: Card Piles
 *
 * Tests the card piles pattern:
 * - Initial state with default values
 * - Initial state with custom inputs
 * - Shuffle preserves total card count
 * - Shuffle redistributes cards
 * - Move card from pile2 to pile1 via moveToPile1
 * - Move card from pile1 to pile2 via moveToPile2
 * - Move all cards to one pile (empty the other)
 * - Move card back to restore both piles
 * - Multiple shuffles preserve card count
 * - Each pile's label, its cards' ranks and suits in the suit's color, and
 *   the prompt an empty pile shows
 *
 * Run: deno task cf test patterns/showcase/card-piles/main.test.tsx --verbose
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findElementByText,
  findNode,
  hasExactText,
  hasText,
  styleOf,
} from "../../tools/test-support/vnode-helpers.ts";
import CardPiles, { defaultPile1, defaultPile2 } from "./main.tsx";

/** Whether `root` draws a card corner reading `face` in `color`. */
const showsCorner = (root: unknown, face: string, color: string): boolean =>
  findNode(
    root,
    (node) => hasExactText(node, face) && styleOf(node, "color") === color,
  ) !== undefined;

/** The drop zone whose label starts with `label` ("Pile 1" or "Pile 2"). */
const dropZone = (root: unknown, label: string): unknown =>
  findElementByText(root, "cf-drop-zone", label);

export default pattern(() => {
  // =========================================================================
  // Instance 1: Default inputs (uses defaultPile1 / defaultPile2)
  // =========================================================================
  const defaults = CardPiles({
    pile1: defaultPile1,
    pile2: defaultPile2,
  });

  // =========================================================================
  // Instance 2: Custom inputs for move/shuffle testing
  // =========================================================================
  const piles = CardPiles({
    pile1: [
      { suit: "hearts", rank: "A" },
      { suit: "spades", rank: "K" },
    ],
    pile2: [
      { suit: "clubs", rank: "Q" },
    ],
  });

  // =========================================================================
  // Instance 3: Single card (edge case)
  // =========================================================================
  const single = CardPiles({
    pile1: [{ suit: "diamonds", rank: "7" }],
    pile2: [],
  });

  // =========================================================================
  // Initial state assertions — defaults
  // =========================================================================
  const assert_defaults_pile1_count = assert(
    () => defaults.pile1.length === 3,
  );
  const assert_defaults_pile2_count = assert(
    () => defaults.pile2.length === 3,
  );
  const assert_defaults_pile1_first_card = assert(
    () =>
      defaults.pile1[0]?.suit === "hearts" &&
      defaults.pile1[0]?.rank === "A",
  );
  const assert_defaults_pile2_first_card = assert(
    () =>
      defaults.pile2[0]?.suit === "clubs" &&
      defaults.pile2[0]?.rank === "Q",
  );

  // =========================================================================
  // Initial state assertions — custom inputs
  // =========================================================================
  const assert_custom_pile1_count = assert(() => piles.pile1.length === 2);
  const assert_custom_pile2_count = assert(() => piles.pile2.length === 1);
  const assert_custom_total = assert(
    () => piles.pile1.length + piles.pile2.length === 3,
  );
  const assert_custom_pile1_has_ace = assert(
    () => piles.pile1[0]?.suit === "hearts" && piles.pile1[0]?.rank === "A",
  );
  const assert_custom_pile2_has_queen = assert(
    () => piles.pile2[0]?.suit === "clubs" && piles.pile2[0]?.rank === "Q",
  );

  // =========================================================================
  // Initial state assertions — single card edge case
  // =========================================================================
  const assert_single_pile1_count = assert(() => single.pile1.length === 1);
  const assert_single_pile2_empty = assert(() => single.pile2.length === 0);
  const assert_single_total = assert(
    () => single.pile1.length + single.pile2.length === 1,
  );

  // =========================================================================
  // View: labels, suits, and the empty-pile prompt
  // =========================================================================
  // The defaults hold every suit: hearts and diamonds are drawn red, clubs
  // and spades dark, each corner showing the rank and the suit's symbol.
  const assert_defaults_view = assert(() => {
    const ui = defaults[UI];
    return hasText(ui, "Pile 1 (3 cards)") && hasText(ui, "Pile 2 (3 cards)") &&
      showsCorner(ui, "A\u2665", "#dc2626") &&
      showsCorner(ui, "7\u2666", "#dc2626") &&
      showsCorner(ui, "Q\u2663", "#1e293b") &&
      showsCorner(ui, "K\u2660", "#1e293b") &&
      !hasText(ui, "Drop cards here");
  });
  // One card, so its label is singular, and the empty pile asks for a drop.
  const assert_single_view = assert(() => {
    const ui = single[UI];
    return hasText(dropZone(ui, "Pile 1"), "Pile 1 (1 card)") &&
      !hasText(dropZone(ui, "Pile 1"), "Drop cards here") &&
      hasText(dropZone(ui, "Pile 2"), "Pile 2 (0 cards)") &&
      hasText(dropZone(ui, "Pile 2"), "Drop cards here");
  });

  const action_move_single_to_pile2 = action(() => {
    single.moveToPile2.send({ detail: { sourceCell: single.pile1[0] } });
  });
  const assert_single_moved_view = assert(() => {
    const ui = single[UI];
    return single.pile2[0]?.rank === "7" &&
      hasText(dropZone(ui, "Pile 1"), "Pile 1 (0 cards)") &&
      hasText(dropZone(ui, "Pile 1"), "Drop cards here") &&
      hasText(dropZone(ui, "Pile 2"), "Pile 2 (1 card)") &&
      !hasText(dropZone(ui, "Pile 2"), "Drop cards here") &&
      showsCorner(dropZone(ui, "Pile 2"), "7\u2666", "#dc2626");
  });

  // =========================================================================
  // Actions: Shuffle
  // =========================================================================
  const action_shuffle = action(() => {
    piles.shuffle.send();
  });

  // Shuffle preserves total card count
  const assert_total_preserved_after_shuffle = assert(
    () => piles.pile1.length + piles.pile2.length === 3,
  );

  // Second shuffle also preserves count
  const action_shuffle_again = action(() => {
    piles.shuffle.send();
  });

  const assert_total_preserved_after_second_shuffle = assert(
    () => piles.pile1.length + piles.pile2.length === 3,
  );

  // Shuffle single-card instance
  const action_shuffle_single = action(() => {
    single.shuffle.send();
  });

  const assert_single_total_after_shuffle = assert(
    () => single.pile1.length + single.pile2.length === 1,
  );

  // =========================================================================
  // Actions: Move card from pile2 to pile1 (moveToPile1)
  // =========================================================================
  // We need a fresh instance for move tests so state is predictable
  const movePiles = CardPiles({
    pile1: [
      { suit: "hearts", rank: "A" },
      { suit: "spades", rank: "K" },
    ],
    pile2: [
      { suit: "clubs", rank: "Q" },
      { suit: "diamonds", rank: "10" },
    ],
  });

  const assert_move_initial_pile1 = assert(
    () => movePiles.pile1.length === 2,
  );
  const assert_move_initial_pile2 = assert(
    () => movePiles.pile2.length === 2,
  );
  const assert_move_initial_total = assert(
    () => movePiles.pile1.length + movePiles.pile2.length === 4,
  );

  // Move first card of pile2 (Queen of Clubs) to pile1
  const action_move_to_pile1 = action(() => {
    movePiles.moveToPile1.send({
      detail: { sourceCell: movePiles.pile2[0] },
    });
  });

  const assert_after_move_to_pile1_count1 = assert(
    () => movePiles.pile1.length === 3,
  );
  const assert_after_move_to_pile1_count2 = assert(
    () => movePiles.pile2.length === 1,
  );
  const assert_after_move_to_pile1_total = assert(
    () => movePiles.pile1.length + movePiles.pile2.length === 4,
  );
  // Queen of Clubs should now be at end of pile1
  const assert_queen_moved_to_pile1 = assert(
    () =>
      movePiles.pile1[2]?.suit === "clubs" &&
      movePiles.pile1[2]?.rank === "Q",
  );
  // Original pile1 cards should still be in order
  const assert_pile1_originals_intact = assert(
    () =>
      movePiles.pile1[0]?.suit === "hearts" &&
      movePiles.pile1[0]?.rank === "A" &&
      movePiles.pile1[1]?.suit === "spades" &&
      movePiles.pile1[1]?.rank === "K",
  );
  // pile2 should only have diamonds/10 left
  const assert_pile2_has_only_ten = assert(
    () =>
      movePiles.pile2[0]?.suit === "diamonds" &&
      movePiles.pile2[0]?.rank === "10",
  );

  // =========================================================================
  // Actions: Move card from pile1 to pile2 (moveToPile2)
  // =========================================================================
  // Move first card of pile1 to pile2
  const action_move_to_pile2 = action(() => {
    movePiles.moveToPile2.send({
      detail: { sourceCell: movePiles.pile1[0] },
    });
  });

  const assert_after_move_to_pile2_count1 = assert(
    () => movePiles.pile1.length === 2,
  );
  const assert_after_move_to_pile2_count2 = assert(
    () => movePiles.pile2.length === 2,
  );
  const assert_after_move_to_pile2_total = assert(
    () => movePiles.pile1.length + movePiles.pile2.length === 4,
  );
  // hearts/A should now be at end of pile2
  const assert_ace_moved_to_pile2 = assert(
    () =>
      movePiles.pile2[1]?.suit === "hearts" &&
      movePiles.pile2[1]?.rank === "A",
  );
  // pile1 should still have spades/K and clubs/Q (ace removed from front)
  const assert_pile1_after_move_to_pile2 = assert(
    () =>
      movePiles.pile1[0]?.suit === "spades" &&
      movePiles.pile1[0]?.rank === "K" &&
      movePiles.pile1[1]?.suit === "clubs" &&
      movePiles.pile1[1]?.rank === "Q",
  );

  // =========================================================================
  // Actions: Empty a pile by moving all cards out
  // =========================================================================
  const action_move_remaining_pile2_to_pile1_a = action(() => {
    movePiles.moveToPile1.send({
      detail: { sourceCell: movePiles.pile2[0] },
    });
  });

  const action_move_remaining_pile2_to_pile1_b = action(() => {
    movePiles.moveToPile1.send({
      detail: { sourceCell: movePiles.pile2[0] },
    });
  });

  const assert_pile2_empty = assert(() => movePiles.pile2.length === 0);
  const assert_pile1_has_all = assert(() => movePiles.pile1.length === 4);
  const assert_empty_pile_total = assert(
    () => movePiles.pile1.length + movePiles.pile2.length === 4,
  );

  // =========================================================================
  // Actions: Move card back to restore non-empty pile2
  // =========================================================================
  const action_move_one_back_to_pile2 = action(() => {
    movePiles.moveToPile2.send({
      detail: { sourceCell: movePiles.pile1[0] },
    });
  });

  const assert_pile2_restored = assert(() => movePiles.pile2.length === 1);
  const assert_pile1_after_restore = assert(
    () => movePiles.pile1.length === 3,
  );

  // =========================================================================
  // Shuffle after moves preserves total
  // =========================================================================
  const action_shuffle_after_moves = action(() => {
    movePiles.shuffle.send();
  });

  const assert_total_after_shuffle_moves = assert(
    () => movePiles.pile1.length + movePiles.pile2.length === 4,
  );

  // =========================================================================
  // Test sequence
  // =========================================================================
  return {
    [TESTS]: [
      // --- Initial state: defaults ---
      { assertion: assert_defaults_pile1_count },
      { assertion: assert_defaults_pile2_count },
      { assertion: assert_defaults_pile1_first_card },
      { assertion: assert_defaults_pile2_first_card },

      // --- Initial state: custom inputs ---
      { assertion: assert_custom_pile1_count },
      { assertion: assert_custom_pile2_count },
      { assertion: assert_custom_total },
      { assertion: assert_custom_pile1_has_ace },
      { assertion: assert_custom_pile2_has_queen },

      // --- Initial state: single card edge case ---
      { assertion: assert_single_pile1_count },
      { assertion: assert_single_pile2_empty },
      { assertion: assert_single_total },

      // --- View ---
      { assertion: assert_defaults_view },
      { assertion: assert_single_view },

      // --- Shuffle preserves totals ---
      { action: action_shuffle },
      { assertion: assert_total_preserved_after_shuffle },
      { action: action_shuffle_again },
      { assertion: assert_total_preserved_after_second_shuffle },

      // --- Shuffle single card ---
      { action: action_shuffle_single },
      { assertion: assert_single_total_after_shuffle },
      { action: action_move_single_to_pile2 },
      { assertion: assert_single_moved_view },

      // --- Move tests: initial state ---
      { assertion: assert_move_initial_pile1 },
      { assertion: assert_move_initial_pile2 },
      { assertion: assert_move_initial_total },

      // --- Move pile2[0] (clubs/Q) → pile1 ---
      { action: action_move_to_pile1 },
      { assertion: assert_after_move_to_pile1_count1 },
      { assertion: assert_after_move_to_pile1_count2 },
      { assertion: assert_after_move_to_pile1_total },
      { assertion: assert_queen_moved_to_pile1 },
      { assertion: assert_pile1_originals_intact },
      { assertion: assert_pile2_has_only_ten },

      // --- Move pile1[0] (hearts/A) → pile2 ---
      { action: action_move_to_pile2 },
      { assertion: assert_after_move_to_pile2_count1 },
      { assertion: assert_after_move_to_pile2_count2 },
      { assertion: assert_after_move_to_pile2_total },
      { assertion: assert_ace_moved_to_pile2 },
      { assertion: assert_pile1_after_move_to_pile2 },

      // --- Empty pile2 completely ---
      { action: action_move_remaining_pile2_to_pile1_a },
      { action: action_move_remaining_pile2_to_pile1_b },
      { assertion: assert_pile2_empty },
      { assertion: assert_pile1_has_all },
      { assertion: assert_empty_pile_total },

      // --- Restore pile2 ---
      { action: action_move_one_back_to_pile2 },
      { assertion: assert_pile2_restored },
      { assertion: assert_pile1_after_restore },

      // --- Shuffle after moves still preserves total ---
      { action: action_shuffle_after_moves },
      { assertion: assert_total_after_shuffle_moves },
    ],
    // Expose for debugging
    defaults,
    piles,
    single,
    movePiles,
  };
});
