/**
 * Regression test for Reactive intersection type handling.
 *
 * This is a minimal reproduction of the type error from
 * community-patterns/patterns/jkomoros/components/search-select-prototype.tsx
 *
 * Without the fix, this pattern fails to compile with:
 *   Type 'OpaqueCell<{ value: OpaqueCell<string> & string; ... }> & {...}'
 *   is not assignable to type 'NormalizedItem'.
 *   Types of property 'group' are incompatible.
 *
 * The fix adds `[NonNullable<T>] extends [AnyBrandedCell<any>]` check to
 * ReactiveInner to handle nullable intersection types correctly without
 * causing distribution over union types (which would lose null/undefined).
 *
 * NOTE: This is a type-level test. The assertions at runtime are trivial;
 * the real test is that this file compiles successfully.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { OpaqueCell, Reactive } from "@commonfabric/api";

interface NormalizedItem {
  value: string;
  label: string;
  group?: string;
}

describe("Reactive intersection type handling", () => {
  it("should not double-wrap properties that are already intersection types", () => {
    // This reproduces the pattern from search-select-prototype.tsx:
    //
    // 1. props.items comes from pattern props (already Reactive wrapped)
    // 2. normalizedItems = computed(() => items.map(item => ({
    //      value: item.value,     // OpaqueCell<string> & string
    //      label: item.label,     // OpaqueCell<string> & string
    //      group: item.group,     // (OpaqueCell<string | undefined> & string) | undefined
    //    })))
    //    The mapped result has properties that ARE ALREADY INTERSECTION TYPES
    //
    // 3. computed() wraps this with Reactive<MappedItem[]>
    //
    // 4. itemLookup iterates normalizedItems, assigning items to Record<string, NormalizedItem>
    //
    // THE BUG: When Reactive processes MappedItem, it wraps the already-wrapped
    // properties AGAIN, creating nested OpaqueCell types that aren't assignable.

    // Simulate what map() produces when iterating Reactive-wrapped items:
    // Properties are already intersection types from the source Reactive
    type MappedItem = {
      value: OpaqueCell<string> & string;
      label: OpaqueCell<string | undefined> & string;
      group?: (OpaqueCell<string | undefined> & string) | undefined;
    };

    // computed() wraps the result with Reactive
    type NormalizedItems = Reactive<MappedItem[]>;

    // When we iterate, we get elements of this type
    type NormalizedElement = NormalizedItems extends Array<infer U> ? U : never;

    // THE CRITICAL TYPE TEST: This function signature compiles only if
    // NormalizedElement is assignable to NormalizedItem.
    //
    // Without the fix, item.group has type:
    //   OpaqueCell<(OpaqueCell<string | undefined> & string) | undefined> & {...}
    // which is NOT assignable to string | undefined
    //
    // With the fix, item.group keeps the original type:
    //   (OpaqueCell<string | undefined> & string) | undefined
    // which IS assignable to string | undefined
    function assignToLookup(item: NormalizedElement) {
      const lookup: Record<string, NormalizedItem> = {};
      lookup[item.value] = item;
      return lookup;
    }

    // Runtime assertion is trivial - the type check is what matters
    expect(assignToLookup).toBeDefined();
  });

  it("should allow string methods on intersection type properties", () => {
    // Same setup: properties are already intersection types from Reactive
    type MappedItem = {
      value: OpaqueCell<string> & string;
      label: OpaqueCell<string | undefined> & string;
      group?: (OpaqueCell<string | undefined> & string) | undefined;
    };

    type NormalizedItems = Reactive<MappedItem[]>;
    type NormalizedElement = NormalizedItems extends Array<infer U> ? U : never;

    // THE CRITICAL TYPE TEST: This function signature compiles only if
    // item.group has string methods available.
    //
    // Without the fix, item.group has type OpaqueCell<...> which has no
    // call signatures for toLowerCase
    //
    // With the fix, item.group keeps the intersection type where string
    // methods are available
    function filterItems(items: NormalizedElement[], q: string) {
      return items.filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          (item.group?.toLowerCase().includes(q) ?? false),
      );
    }

    // Runtime assertion is trivial - the type check is what matters
    expect(filterItems).toBeDefined();
  });
});
