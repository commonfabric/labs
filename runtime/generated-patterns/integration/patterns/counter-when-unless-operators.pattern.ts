/**
 * Integration test pattern for when/unless operators.
 *
 * This pattern tests the transformation of && and || operators to when() and unless()
 * built-in functions. The transformer converts:
 * - `complexExpr && value` → `when(derive(complexExpr), value)`
 * - `complexExpr || fallback` → `unless(derive(complexExpr), fallback)`
 *
 * Simple opaque refs (like `showPanel && value`) don't use when/unless,
 * only complex expressions that need derivation.
 */

import { type Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface WhenUnlessArgs {
  items: Default<string[], []>;
  showPanel: Default<boolean, false>;
  userName: Default<string, "">;
  count: Default<number, 0>;
}

const togglePanel = handler(
  (_event: unknown, context: { showPanel: Cell<boolean> }) => {
    const current = context.showPanel.get() ?? false;
    context.showPanel.set(!current);
  },
);

const setUserName = handler(
  (
    event: { name: string } | undefined,
    context: { userName: Cell<string> },
  ) => {
    context.userName.set(event?.name ?? "");
  },
);

const addItem = handler(
  (event: { item: string } | undefined, context: { items: Cell<string[]> }) => {
    const current = context.items.get() ?? [];
    const item = event?.item ?? "item";
    context.items.set([...current, item]);
  },
);

const clearItems = handler(
  (_event: unknown, context: { items: Cell<string[]> }) => {
    context.items.set([]);
  },
);

const liftHasItemsMessage = lift(
  (state: { itemCount: number }) => state.itemCount > 0 && "has items",
);

const liftItemsOrDefault = lift(
  (state: { itemCount: number }) => state.itemCount || "no items",
);

const liftHighCountMessage = lift(
  (state: { count: number }) => state.count > 5 && "high count",
);

const liftDisplayName = lift(
  (state: { name: string }) => state.name || "Anonymous",
);

const liftHasItems = lift((len: number) => len > 0);

const liftUserWithItems = lift(
  (state: { hasItems: boolean; name: string }) =>
    (state.hasItems && state.name) || "Guest with no items",
);

const liftPanelWithItems = lift(
  (state: { show: boolean; hasItems: boolean }) =>
    state.show && state.hasItems && "panel with items",
);

const liftFirstItem = lift((arr: string[]) => arr[0]);

const liftFirstOption = lift(
  (state: { name: string; firstItem: string | undefined }) =>
    state.name || state.firstItem || "default",
);

const liftItemCount = lift((arr: string[]) => arr.length);

const liftSafeCount = lift((n: number | undefined) =>
  typeof n === "number" ? n : 0
);

const incrementCount = handler(
  (
    event: { amount?: number } | undefined,
    context: { count: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const current = context.count.get() ?? 0;
    context.count.set(current + amount);
  },
);

export const counterWithWhenUnlessOperators = pattern<WhenUnlessArgs>(
  ({ items, showPanel, userName, count }) => {
    // Test 1: && with complex expression (items.length > 0)
    // This should transform to: when(derive(...items.length > 0...), "has items")
    const hasItemsMessage = liftHasItemsMessage({ itemCount: items.length });

    // Test 2: || with complex expression (items.length)
    // This should transform to: unless(derive(...items.length...), "no items")
    const itemsOrDefault = liftItemsOrDefault({ itemCount: items.length });

    // Test 3: && with derived boolean condition
    // count > 5 && "high count"
    const highCountMessage = liftHighCountMessage({ count });

    // Test 4: || for fallback with derived string
    // userName || "Anonymous"
    const displayName = liftDisplayName({ name: userName });

    // Test 5: Chained && and || (a && b || c pattern)
    // (items.length > 0 && userName) || "Guest with no items"
    const userWithItems = liftUserWithItems({
      hasItems: liftHasItems(items.length),
      name: userName,
    });

    // Test 6: Multiple && (a && b && c pattern)
    // showPanel && items.length > 0 && "panel with items"
    const panelWithItems = liftPanelWithItems({
      show: showPanel,
      hasItems: liftHasItems(items.length),
    });

    // Test 7: Multiple || (a || b || c pattern)
    // userName || items[0] || "default"
    const firstOption = liftFirstOption({
      name: userName,
      firstItem: liftFirstItem(items),
    });

    // Derived values for assertions
    const itemCount = liftItemCount(items);
    const safeCount = liftSafeCount(count);

    // Summary label combining multiple results
    const summary =
      str`items=${itemCount} show=${showPanel} user=${displayName} count=${safeCount}`;

    return {
      // Input state
      items,
      showPanel,
      userName,
      count,

      // Derived counts
      itemCount,
      safeCount,

      // Test results - these exercise when/unless at runtime
      hasItemsMessage,
      itemsOrDefault,
      highCountMessage,
      displayName,
      userWithItems,
      panelWithItems,
      firstOption,

      // Summary
      summary,

      // Handlers for state manipulation
      togglePanel: togglePanel({ showPanel }),
      setUserName: setUserName({ userName }),
      addItem: addItem({ items }),
      clearItems: clearItems({ items }),
      incrementCount: incrementCount({ count }),
    };
  },
);

export default counterWithWhenUnlessOperators;
