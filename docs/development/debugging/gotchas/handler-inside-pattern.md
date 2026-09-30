# handler() or Function Inside Pattern

**Error:** `handler() should be defined at module scope, not inside a pattern` or `Function creation is not allowed in pattern context` or a `pattern-context:object-member` error such as `A method ... on an object literal in pattern or render context is a function value, which the reactive data model cannot store` or `lift() should not be immediately invoked inside a pattern`

**Cause:** The CTS transformer requires that `handler()`, `lift()`, and helper functions be defined at module scope (outside the pattern body). The transformer cannot process closures over pattern-scoped variables. The same applies to a function-valued member of an object literal in the pattern body — a method, getter, setter, or a property whose value is an arrow/function. The reactive-read lowering pass does not descend into these bodies, so a reactive read inside is never tracked. An object carrying a getter is not an inert plain object, so building the pattern refuses it with ``Not representable as a `FabricValue`: object that is not an inert plain object``. A method, setter, or function-valued property is a function value the reactive data model cannot store (it throws ``Not representable as a `FabricValue`: function``). Expose a value as a plain property or a `computed(() => ...)` field, and move behavior into a module-scope `handler()` or `lift()`. `toJSON` gets no exception: the data model reads the name as the ordinary function-valued member it is, so a `toJSON()` member is reported like any other method.

## Quick Fix: Use action() Instead

For most event handling, use `action()` which IS allowed inside patterns and automatically closes over pattern state:

```typescript
// Shown at module scope.
export default pattern<Input, Input>(({ items }) => {
  // action() works inside patterns - this is the recommended approach
  const addItem = action(() => {
    items.push({ title: "New" });
  });

  return {
    [UI]: <cf-button onClick={addItem}>Add</cf-button>,
    items,
  };
});
```

Only use `handler()` when you need to reuse the same logic with different state bindings, or export the handler for other patterns to call.

## Wrong - handler() Inside Pattern

```typescript
// Shown for illustration only.
export default pattern<Input, Input>(({ items }) => {
  const addItem = handler((_, { items }) => {  // Error!
    items.push({ title: "New" });
  });

  const formatDate = (d: string) => new Date(d).toLocaleDateString();  // Error!

  return { ... };
});
```

## Correct - handler() at Module Scope

If you need `handler()` specifically (for reusability or exports), define it outside the pattern:

```typescript
// Shown at module scope.
// Handler at module scope
const addItem = handler<unknown, { items: Writable<Item[]> }>(
  (_, { items }) => {
    items.push({ title: "New" });
  }
);

// Helper function at module scope
const formatDate = (d: string): string => new Date(d).toLocaleDateString();

export default pattern<Input, Input>(({ items }) => ({
  [UI]: <cf-button onClick={addItem({ items })}>Add</cf-button>,
  items,
}));
```

## For Immediately-Invoked lift()

```typescript
// Shown for illustration only.
// WRONG - lift defined and invoked inside pattern
const result = lift((args) => args.grouped[args.date])({ grouped, date });

// CORRECT - use computed() instead
const result = computed(() => grouped[date]);

// OR define lift at module scope
const getByDate = lift((args: { grouped: Record<string, Item[]>; date: string }) =>
  args.grouped[args.date]
);
// Then use inside pattern:
const result = getByDate({ grouped, date });
```

## Allowed Inside Patterns

These are fine inside pattern context:
- `computed()` callbacks
- `action()` callbacks
- `.map()` callbacks on cells/opaques
- JSX event handlers (e.g., `onClick={() => ...}`)

## See Also

- [@handler](../../../common/concepts/handler.md) - Handler basics and module scope
- [@computed](../../../common/concepts/computed/computed.md) - lift() basics and module scope (see "Reusable Computations: lift()")
