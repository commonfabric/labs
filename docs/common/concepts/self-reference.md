# Self-Referential Types with SELF

Use `SELF` to get a reference to the pattern's own output. This enables recursive structures like trees, parent-child relationships, and self-registration.

## Quick Start

```typescript
import { pattern, SELF, Writable, UI } from "commonfabric";

interface TreeNodeInput {
  name: string;
  parent: TreeNodeOutput | null;
}

interface TreeNodeOutput {
  name: string;
  parent: TreeNodeOutput | null;
  children: TreeNodeOutput[];
}

const TreeNode = pattern<TreeNodeInput, TreeNodeOutput>(
  ({ name, parent, [SELF]: self }) => {
    const children = new Writable<TreeNodeOutput[]>([]);

    return {
      name,
      parent,
      children,
      [UI]: (
        <button onClick={() => children.push(TreeNode({ name: "Child", parent: self }))}>
          Add Child
        </button>
      ),
    };
  }
);
```

## Reading SELF off the input

A pattern that keeps its parameter whole can read the same reference off it as
`input[SELF]` in the pattern body: at the top level, in JSX, bound to a local
(`const self = input[SELF]`), through a path (`input[SELF].title`,
`input[SELF].items.map(...)`), or handed to a child pattern or a handler.
Destructuring `[SELF]: self` and reading `input[SELF]` name the same result,
so use whichever reads better.

```tsx
import { NAME, pattern, SELF, UI, type VNode } from "commonfabric";

interface CardInput {
  title: string;
}

interface CardOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  me: CardOutput;
}

const Card = pattern<CardInput, CardOutput>((input) => ({
  [NAME]: input.title,
  [UI]: <h2>{input[SELF].title}</h2>,
  title: input.title,
  me: input[SELF],
}));
```

`[SELF]` works only on the pattern's input itself, and only where `input` is
the reactive value the pattern body receives. Inside `computed()`, `action()`,
`lift()` or a handler, the callback sees a plain value, and inside a callback
over a reactive collection, such as `items.map(...)`, it sees a captured
reference to the input; `SELF` means nothing on either. Nor does it mean
anything on a value read off the input (`input.items[SELF]`) or on another
pattern's result. The compiler reports `[SELF]` in all of those places as an
error. Read it in the pattern body instead, with `const self = input[SELF]` or
by destructuring `[SELF]: self` in the parameter as the Quick Start above does,
and capture `self` in the callback, or bind `input[SELF]` into the handler's
state from the pattern body.

```tsx
// Shown inside a pattern body.
const self = input[SELF];
const greeting = computed(() => `Hello from ${self.title}`);
```

## SELF in Actions

`self` works inside `action()` closures, not just inline arrows:

```typescript
// Shown for illustration only.
const createChild = action(() => {
  children.push(Node({ label: "Child", parent: self, registry }));
});
```

**Gotcha:** At runtime, `self` binds against the output schema. If any required output property is missing from the piece data, the binding resolves to `undefined`. This happens when input properties lack defaults:

```typescript
// Shown as alternative snippets.
// BAD: title might be missing from piece data → self binding fails
interface Input { title?: string; }

// GOOD: Default<> ensures a value always exists
interface Input { title: string | Default<"Untitled">; }
```

## Key Rules

- **Both type params required:** Use `pattern<Input, Output>()` - single param `pattern<Input>()` will error if you access SELF
- **`self` is typed as the output** - the instantiated piece itself, enabling recursive structures
- **Inputs need defaults:** If an input feeds into the output, use `T | Default<V>` so `self` can bind
- **A recursive field takes the whole output type, verbs included:** a child in
  `children` is a full piece, so declaring that field as a narrower verb-free
  interface is a claim the runtime contradicts — ask that child what it can do
  and it lists every verb. The expensive unshaped read that leaves you with is
  answered by naming what you want (`--select 'title,status'`), not by
  narrowing the type; the measurement is in
  [What you are driving](../verbs/session-walkthrough.md#what-you-are-driving).
  Adding a verb to such a type later is refused on update —
  [designing verbs so they can change](../../plans/verb-evolution.md) has the
  mechanism, and the holder-side rule that removes the refusal.

## See Also

- `packages/patterns/self-reference-test.tsx` - Canonical example
- `packages/patterns/notes/notebook.tsx` - Real-world parent-child usage
- `packages/patterns/notes/note.tsx` - Reading parent from self
