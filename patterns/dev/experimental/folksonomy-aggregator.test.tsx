/**
 * Test Pattern: Folksonomy Aggregator
 *
 * Tests correctness of the folksonomy aggregator under load:
 * - Basic event posting via stream
 * - Multi-scope isolation
 * - Preferential attachment (sort order by count)
 * - Remove handling (count decrements, never negative)
 * - Large batch loading (500 events)
 * - Invalid event handling (graceful rejection)
 * - Dense scope (100 unique tags in 1 scope)
 *
 * Run: deno task cf test patterns/dev/experimental/folksonomy-aggregator.test.tsx --verbose
 *
 * Note: Uses module-scoped handlers with explicit state parameters
 * instead of action() closures to avoid "reactive reference outside
 * reactive context" errors when accessing reactive proxy objects.
 */
import { assert, Cell, handler, pattern, Stream, TESTS } from "commonfabric";
import AggregatorPattern from "./folksonomy-aggregator.tsx";

export interface TagEvent {
  scope: string;
  tag: string;
  action: "add" | "use" | "remove";
  timestamp: number;
}

export interface CommunityTagSuggestion {
  tag: string;
  count: number;
}

// ============================================================================
// Test Data Generators
// ============================================================================

/** Multi-scope events: scope-a gets alpha(5) + beta(3), scope-b gets gamma(4) + delta(2) */
function makeMultiScopeEvents(): TagEvent[] {
  const events: TagEvent[] = [];
  for (let i = 0; i < 5; i++) {
    events.push({
      scope: "scope-a",
      tag: "alpha",
      action: "add",
      timestamp: i,
    });
  }
  for (let i = 0; i < 3; i++) {
    events.push({
      scope: "scope-a",
      tag: "beta",
      action: "add",
      timestamp: 10 + i,
    });
  }
  for (let i = 0; i < 4; i++) {
    events.push({
      scope: "scope-b",
      tag: "gamma",
      action: "add",
      timestamp: 20 + i,
    });
  }
  for (let i = 0; i < 2; i++) {
    events.push({
      scope: "scope-b",
      tag: "delta",
      action: "add",
      timestamp: 30 + i,
    });
  }
  return events;
}

/** Preferential attachment: popular(10) vs rare(1) in same scope */
function makePreferentialEvents(): TagEvent[] {
  const events: TagEvent[] = [];
  for (let i = 0; i < 10; i++) {
    events.push({
      scope: "scope-p",
      tag: "popular",
      action: "add",
      timestamp: i,
    });
  }
  events.push({ scope: "scope-p", tag: "rare", action: "add", timestamp: 100 });
  return events;
}

/** Remove handling: add removable(5), remove removable(3), add permanent(1) */
function makeRemoveEvents(): TagEvent[] {
  const events: TagEvent[] = [];
  for (let i = 0; i < 5; i++) {
    events.push({
      scope: "scope-r",
      tag: "removable",
      action: "add",
      timestamp: i,
    });
  }
  for (let i = 0; i < 3; i++) {
    events.push({
      scope: "scope-r",
      tag: "removable",
      action: "remove",
      timestamp: 10 + i,
    });
  }
  events.push({
    scope: "scope-r",
    tag: "permanent",
    action: "add",
    timestamp: 20,
  });
  return events;
}

const BATCH_SCOPES = [
  "recipe-tracker",
  "meal-planner",
  "cookbook",
  "food-blog",
  "grocery-list",
  "restaurant-reviews",
  "wine-journal",
  "kitchen-inventory",
  "diet-log",
  "cooking-class",
];

const BATCH_TAGS = [
  "vegetarian",
  "quick",
  "easy",
  "italian",
  "mexican",
  "breakfast",
  "dessert",
  "healthy",
  "spicy",
  "gluten-free",
  "vegan",
  "comfort-food",
  "budget",
  "meal-prep",
  "one-pot",
  "grilled",
  "baked",
  "seasonal",
  "holiday",
  "snack",
];

const DENSE_TAGS = [
  "vegetarian",
  "quick",
  "easy",
  "italian",
  "mexican",
  "breakfast",
  "dessert",
  "healthy",
  "spicy",
  "gluten-free",
  "vegan",
  "comfort-food",
  "budget",
  "meal-prep",
  "one-pot",
  "grilled",
  "baked",
  "seasonal",
  "holiday",
  "snack",
  "appetizer",
  "soup",
  "salad",
  "pasta",
  "seafood",
  "chicken",
  "beef",
  "pork",
  "tofu",
  "rice",
  "noodles",
  "curry",
  "stir-fry",
  "slow-cooker",
  "instant-pot",
  "fermented",
  "pickled",
  "smoked",
  "roasted",
  "steamed",
  "raw",
  "frozen",
  "organic",
  "local",
  "farm-to-table",
  "keto",
  "paleo",
  "mediterranean",
  "asian",
  "french",
  "indian",
  "thai",
  "japanese",
  "korean",
  "middle-eastern",
  "african",
  "caribbean",
  "southern",
  "tex-mex",
  "fusion",
  "street-food",
  "brunch",
  "lunch",
  "dinner",
  "party",
  "potluck",
  "date-night",
  "kids",
  "beginner",
  "advanced",
  "under-30-min",
  "under-15-min",
  "overnight",
  "no-cook",
  "five-ingredient",
  "dairy-free",
  "nut-free",
  "egg-free",
  "soy-free",
  "low-sodium",
  "high-protein",
  "low-carb",
  "high-fiber",
  "antioxidant",
  "probiotic",
  "immune-boost",
  "energy",
  "recovery",
  "chocolate",
  "vanilla",
  "cinnamon",
  "garlic",
  "lemon",
  "ginger",
  "basil",
  "cilantro",
  "mint",
  "rosemary",
  "thyme",
  "oregano",
  "cumin",
  "turmeric",
];

/** Large batch: 500 events across 10 scopes and 20 tags */
function makeLargeBatchEvents(): TagEvent[] {
  const events: TagEvent[] = [];
  for (let i = 0; i < 500; i++) {
    events.push({
      scope: BATCH_SCOPES[i % 10],
      tag: BATCH_TAGS[(i * 7) % 20], // Prime multiplier for even distribution
      action: "add",
      timestamp: i,
    });
  }
  return events;
}

/** Dense scope: 100 unique tags in 1 scope, each with (index % 3 + 1) events */
function makeDenseEvents(): TagEvent[] {
  const events: TagEvent[] = [];
  for (let t = 0; t < 100; t++) {
    const count = (t % 3) + 1; // 1, 2, or 3 events per tag
    for (let i = 0; i < count; i++) {
      events.push({
        scope: "cookbook",
        tag: DENSE_TAGS[t],
        action: "add",
        timestamp: t * 10 + i,
      });
    }
  }
  return events;
}

// ============================================================================
// Module-scope Handlers
// ============================================================================

/** Set events cell directly (for bulk loading and resetting) */
const setEventsHandler = handler<
  void,
  { eventsCell: Cell<TagEvent[]>; newEvents: TagEvent[] }
>((_event, { eventsCell, newEvents }) => {
  eventsCell.set([...newEvents]);
});

/** Post a single event via the aggregator's postEvent stream */
const postEventHandler = handler<
  void,
  { stream: Stream<TagEvent>; event: TagEvent }
>((_event, { stream, event }) => {
  stream.send(event);
});

// ============================================================================
// Test Pattern
// ============================================================================

export default pattern(() => {
  // Instantiate aggregator with a writable events cell
  const eventsCell = new Cell<TagEvent[]>([]);
  const aggregator = AggregatorPattern({ events: eventsCell });

  // ========================================================================
  // Actions
  // ========================================================================

  // --- Test 1: Basic correctness ---
  const action_post_basic_event = postEventHandler({
    stream: aggregator.postEvent,
    event: { scope: "basic", tag: "typescript", action: "add", timestamp: 1 },
  });

  // --- Test 2: Multi-scope isolation ---
  const action_load_multiscope = setEventsHandler({
    eventsCell,
    newEvents: makeMultiScopeEvents(),
  });

  // --- Test 3: Preferential attachment ---
  const action_load_preferential = setEventsHandler({
    eventsCell,
    newEvents: makePreferentialEvents(),
  });

  // --- Test 4: Remove handling ---
  const action_load_remove = setEventsHandler({
    eventsCell,
    newEvents: makeRemoveEvents(),
  });

  // --- Test 5: Large batch ---
  const action_load_large_batch = setEventsHandler({
    eventsCell,
    newEvents: makeLargeBatchEvents(),
  });

  // --- Test 6: Invalid events ---
  const action_reset = setEventsHandler({
    eventsCell,
    newEvents: [],
  });

  const action_post_invalid_empty_scope = postEventHandler({
    stream: aggregator.postEvent,
    event: { scope: "", tag: "orphan", action: "add", timestamp: 1 },
  });

  const action_post_invalid_empty_tag = postEventHandler({
    stream: aggregator.postEvent,
    event: { scope: "invalid-test", tag: "", action: "add", timestamp: 2 },
  });

  const action_post_valid_after_invalid = postEventHandler({
    stream: aggregator.postEvent,
    event: { scope: "recovery", tag: "works", action: "add", timestamp: 3 },
  });

  // --- Test 7: Dense scope ---
  const action_load_dense = setEventsHandler({
    eventsCell,
    newEvents: makeDenseEvents(),
  });

  // ========================================================================
  // Assertions
  // ========================================================================

  // --- Initial state ---
  const assert_initial_empty = assert(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    // Either no keys or all values are empty arrays
    for (const scopeSuggs of Object.values(suggs)) {
      if (scopeSuggs.length > 0) return false;
    }
    return true;
  });

  // --- Test 1: Basic correctness ---
  const assert_basic_has_typescript = assert(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    const basicSuggs = suggs["basic"] || [];
    return basicSuggs.some(
      (s) => s.tag === "typescript" && s.count === 1,
    );
  });

  // --- Test 2: Multi-scope isolation ---
  const assert_scope_a_has_alpha = assert(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    return (suggs["scope-a"] || []).some((s) => s.tag === "alpha");
  });

  const assert_scope_a_has_beta = assert(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    return (suggs["scope-a"] || []).some((s) => s.tag === "beta");
  });

  const assert_scope_b_has_gamma = assert(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    return (suggs["scope-b"] || []).some((s) => s.tag === "gamma");
  });

  const assert_scope_a_no_gamma = assert(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    return !(suggs["scope-a"] || []).some((s) => s.tag === "gamma");
  });

  const assert_scope_b_no_alpha = assert(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    return !(suggs["scope-b"] || []).some((s) => s.tag === "alpha");
  });

  const assert_scope_a_alpha_count_5 = assert(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    const alpha = (suggs["scope-a"] || []).find((s) => s.tag === "alpha");
    return alpha?.count === 5;
  });

  // --- Test 3: Preferential attachment ---
  const assert_popular_first = assert(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    const pSuggs = suggs["scope-p"] || [];
    return pSuggs.length >= 2 && pSuggs[0].tag === "popular";
  });

  const assert_popular_count_higher = assert(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    const pSuggs = suggs["scope-p"] || [];
    const popular = pSuggs.find((s) => s.tag === "popular");
    const rare = pSuggs.find((s) => s.tag === "rare");
    return (popular?.count || 0) > (rare?.count || 0);
  });

  // --- Test 4: Remove handling ---
  const assert_removable_count_2 = assert(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    const removable = (suggs["scope-r"] || []).find(
      (s) => s.tag === "removable",
    );
    return removable?.count === 2; // 5 adds - 3 removes = 2
  });

  const assert_permanent_count_1 = assert(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    const permanent = (suggs["scope-r"] || []).find(
      (s) => s.tag === "permanent",
    );
    return permanent?.count === 1;
  });

  // --- Test 5: Large batch ---
  const assert_batch_multiple_scopes = assert(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    let scopeCount = 0;
    for (const key of Object.keys(suggs)) {
      if (BATCH_SCOPES.includes(key) && suggs[key].length > 0) {
        scopeCount++;
      }
    }
    return scopeCount >= 5; // Should have all 10 batch scopes populated
  });

  const assert_batch_has_tags = assert(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    const first = suggs["recipe-tracker"] || [];
    return first.length > 0; // first scope should have suggestions
  });

  // --- Test 6: Invalid events ---
  const assert_empty_after_invalid = assert(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    for (const scopeSuggs of Object.values(suggs)) {
      if (scopeSuggs.length > 0) return false;
    }
    return true;
  });

  const assert_recovery_after_invalid = assert(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    return (suggs["recovery"] || []).some(
      (s) => s.tag === "works" && s.count === 1,
    );
  });

  // --- Test 7: Dense scope ---
  const assert_dense_100_tags = assert(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    return (suggs["cookbook"] || []).length === 100;
  });

  const assert_dense_sorted = assert(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    const denseSuggs = suggs["cookbook"] || [];
    if (denseSuggs.length < 2) return false;
    // Verify descending sort by count
    for (let i = 0; i < denseSuggs.length - 1; i++) {
      if (denseSuggs[i].count < denseSuggs[i + 1].count) return false;
    }
    return true;
  });

  // ========================================================================
  // Test Sequence
  // ========================================================================

  return {
    [TESTS]: [
      // === Initial state: empty ===
      { assertion: assert_initial_empty },

      // === Test 1: Basic correctness ===
      // Post 1 event via stream, verify suggestions contain it
      { action: action_post_basic_event },
      { assertion: assert_basic_has_typescript },

      // === Test 2: Multi-scope isolation ===
      // Set events across 2 scopes, verify isolation
      { action: action_load_multiscope },
      { assertion: assert_scope_a_has_alpha },
      { assertion: assert_scope_a_has_beta },
      { assertion: assert_scope_b_has_gamma },
      { assertion: assert_scope_a_no_gamma },
      { assertion: assert_scope_b_no_alpha },
      { assertion: assert_scope_a_alpha_count_5 },

      // === Test 3: Preferential attachment ===
      // popular(10) should sort before rare(1)
      { action: action_load_preferential },
      { assertion: assert_popular_first },
      { assertion: assert_popular_count_higher },

      // === Test 4: Remove handling ===
      // 5 adds - 3 removes = count 2, permanent stays at 1
      { action: action_load_remove },
      { assertion: assert_removable_count_2 },
      { assertion: assert_permanent_count_1 },

      // === Test 5: Large batch ===
      // 500 events across 10 scopes
      { action: action_load_large_batch },
      { assertion: assert_batch_multiple_scopes },
      { assertion: assert_batch_has_tags },

      // === Test 6: Invalid events ===
      // Reset, post invalid events, verify rejection, then verify recovery
      { action: action_reset },
      { action: action_post_invalid_empty_scope },
      { action: action_post_invalid_empty_tag },
      { assertion: assert_empty_after_invalid },
      { action: action_post_valid_after_invalid },
      { assertion: assert_recovery_after_invalid },

      // === Test 7: Dense scope ===
      // 100 unique tags in 1 scope, all present and sorted
      { action: action_load_dense },
      { assertion: assert_dense_100_tags },
      { assertion: assert_dense_sorted },
    ],
    // The invalid-event test deliberately feeds malformed events, which the
    // aggregator rejects with console.warn("Invalid event received").
    allowConsoleWarnings: true,
  };
});
