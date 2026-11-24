import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

/**
 * Integration tests for when/unless operators.
 *
 * These tests verify that && and || operators work correctly at runtime
 * after being transformed to when() and unless() by the compiler.
 */
export const counterWhenUnlessOperatorsScenario: PatternIntegrationScenario<
  { items?: string[]; showPanel?: boolean; userName?: string; count?: number }
> = {
  name: "when/unless operators work with && and || semantics",
  module: new URL(
    "./counter-when-unless-operators.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithWhenUnlessOperators",
  steps: [
    // Step 1: Initial state - all falsy conditions
    {
      expect: [
        { path: "itemCount", value: 0 },
        { path: "safeCount", value: 0 },
        // Test 1: items.length > 0 && "has items" → false (short-circuit)
        { path: "hasItemsMessage", value: false },
        // Test 2: items.length || "no items" → "no items" (fallback)
        { path: "itemsOrDefault", value: "no items" },
        // Test 3: count > 5 && "high count" → false
        { path: "highCountMessage", value: false },
        // Test 4: userName || "Anonymous" → "Anonymous"
        { path: "displayName", value: "Anonymous" },
        // Test 5: (hasItems && userName) || "Guest with no items" → "Guest with no items"
        { path: "userWithItems", value: "Guest with no items" },
        // Test 6: showPanel && hasItems && "panel with items" → false
        { path: "panelWithItems", value: false },
        // Test 7: userName || items[0] || "default" → "default"
        { path: "firstOption", value: "default" },
      ],
    },

    // Step 2: Add items - tests && with truthy left side
    {
      events: [{ stream: "addItem", payload: { item: "apple" } }],
      expect: [
        { path: "itemCount", value: 1 },
        // Test 1: items.length > 0 && "has items" → "has items"
        { path: "hasItemsMessage", value: "has items" },
        // Test 2: items.length || "no items" → 1 (truthy, returns condition)
        { path: "itemsOrDefault", value: 1 },
        // Test 5: still no userName, so fallback
        { path: "userWithItems", value: "Guest with no items" },
        // Test 6: showPanel is false, so false
        { path: "panelWithItems", value: false },
        // Test 7: userName empty, items[0] = "apple"
        { path: "firstOption", value: "apple" },
      ],
    },

    // Step 3: Set userName - tests || with truthy left side
    {
      events: [{ stream: "setUserName", payload: { name: "Alice" } }],
      expect: [
        // Test 4: userName || "Anonymous" → "Alice"
        { path: "displayName", value: "Alice" },
        // Test 5: hasItems && userName = true && "Alice" = "Alice"
        { path: "userWithItems", value: "Alice" },
        // Test 7: userName = "Alice" (first truthy)
        { path: "firstOption", value: "Alice" },
      ],
    },

    // Step 4: Toggle showPanel - tests multiple &&
    {
      events: [{ stream: "togglePanel", payload: {} }],
      expect: [
        { path: "showPanel", value: true },
        // Test 6: showPanel && hasItems && "panel with items" → "panel with items"
        { path: "panelWithItems", value: "panel with items" },
      ],
    },

    // Step 5: Clear items - tests && returning false when middle condition fails
    {
      events: [{ stream: "clearItems", payload: {} }],
      expect: [
        { path: "itemCount", value: 0 },
        // Test 1: items.length > 0 && "has items" → false
        { path: "hasItemsMessage", value: false },
        // Test 2: items.length || "no items" → "no items"
        { path: "itemsOrDefault", value: "no items" },
        // Test 5: hasItems = false, so "Guest with no items"
        { path: "userWithItems", value: "Guest with no items" },
        // Test 6: showPanel true but hasItems false → false
        { path: "panelWithItems", value: false },
        // Test 7: userName = "Alice" (first truthy, items[0] undefined)
        { path: "firstOption", value: "Alice" },
      ],
    },

    // Step 6: Increment count high - tests count > 5 && "high count"
    {
      events: [{ stream: "incrementCount", payload: { amount: 10 } }],
      expect: [
        { path: "safeCount", value: 10 },
        // Test 3: count > 5 && "high count" → "high count"
        { path: "highCountMessage", value: "high count" },
      ],
    },

    // Step 7: Clear userName - tests || fallback chain
    {
      events: [{ stream: "setUserName", payload: { name: "" } }],
      expect: [
        // Test 4: userName || "Anonymous" → "Anonymous"
        { path: "displayName", value: "Anonymous" },
        // Test 7: userName empty, items[0] undefined → "default"
        { path: "firstOption", value: "default" },
      ],
    },

    // Step 8: Add item back with no userName - tests || fallback to middle option
    {
      events: [{ stream: "addItem", payload: { item: "banana" } }],
      expect: [
        { path: "itemCount", value: 1 },
        // Test 7: userName empty, items[0] = "banana"
        { path: "firstOption", value: "banana" },
      ],
    },
  ],
};

export const scenarios = [counterWhenUnlessOperatorsScenario];

describe("counter-when-unless-operators", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
