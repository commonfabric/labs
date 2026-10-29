# Style Object Reference Repro

## What the bug was

When multiple sibling elements shared the same style object _reference_, only
the first two siblings got styles applied. Siblings 3+ rendered without styling
(no background, no border-radius, no box-shadow, etc.).

## Why it happened

The `withAliasBindings` function in
`runtime/runner/src/builder/to-encodable-form.ts` used a `WeakSet` to guard
against circular object references during pattern serialization. However, this
guard also triggered on shared (non-circular) references, returning `{}` instead
of re-serializing the value.

The reason 2 siblings worked (not just 1) is that `traverseValue` upstream
creates one copy of the shared object and returns the original for subsequent
encounters, giving `withAliasBindings` 2 distinct object identities before it
hits duplicates on the 3rd+.

## The fix

The `WeakSet` was replaced with a `WeakMap<object, number>` that tracks
recursion depth. Only returns `{}` when `depth > 0` (we're currently inside this
object's serialization — actual circularity), not when `depth === 0` (shared
reference that was already fully processed). Shared style objects now serialize
correctly regardless of how many siblings reference them.

## Reproduction

This pattern demonstrates the bug scenario (shared `const` style object) and the
old workaround (factory function). With the fix applied, both sections render
identically — all 10 cards are styled.

Run with `deno task cf check main.tsx --pattern-json` and verify all cards have
full style data.
