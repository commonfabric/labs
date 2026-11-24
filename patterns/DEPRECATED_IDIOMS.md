# Deprecated Idioms - Migration Task List

This document tracks deprecated idioms found in the patterns directory that need
to be updated to the current API. For per-file status (which patterns are
current vs legacy), see the status tiers in [index.md](./index.md).

## Summary

Most of the original migration list is complete: the affected files have either
been migrated or removed. The entries below are the verified remaining
occurrences.

## Deprecated APIs to Replace

1. `cell()` → `new Writable()`
2. `derive()` → `computed()`
3. `lift()` → `computed()` or refactor
4. `handler()` for simple operations → inline handlers
5. `.equals()` method → `Writable.equals(a, b)`
6. `[ID]` usage → the symbol no longer exists; array elements are anchored into
   documents automatically, and `Writable.equals()` finds/removes items

## Remaining Occurrences

### chatbot.tsx

**Location**: `patterns/system/chatbot/chatbot.tsx`

- `clearChat`: simple `handler()` → inline handler

### default-app.tsx

**Location**: `patterns/system/default-app/default-app.tsx`

- `removePiece`: instance `.equals()` → `Writable.equals(a, b)`
- `toggleMenu`, `closeMenu`: simple `handler()` → inline handler

### omnibox-fab.tsx

**Location**: `patterns/system/omnibox-fab/omnibox-fab.tsx`

- `toggle`, `closeFab`: simple `handler()` → inline handler

## Update Checklist for Each File

- [ ] Replace `cell()` with `new Writable()`
- [ ] Replace `derive()` with `computed()`
- [ ] Replace `lift()` with `computed()` or refactor
- [ ] Convert simple `handler()` calls to inline handlers
- [ ] Update pattern input types to use `Writable<T>` for cells used in inline
      handlers
- [ ] Replace `.equals()` with `Writable.equals(a, b)`
- [ ] Remove any `[ID]` usage - the symbol no longer exists (anchoring is
      automatic; use `Writable.equals()` for finding/removing).
- [ ] Test the updated pattern
- [ ] Verify no TypeScript errors
- [ ] Deploy and verify functionality

## Notes

- When converting to inline handlers, remember to update the pattern input
  interface to declare cells as `Writable<T>`
- For complex handlers with multiple operations or reusable logic, keep using
  `handler()` function
- Use the decision hierarchy: bidirectional binding → inline handlers →
  `handler()` function
- Test each file after updating to ensure functionality is preserved
