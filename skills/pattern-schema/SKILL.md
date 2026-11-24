---
name: pattern-schema
description: Design schemas.tsx with Input/Output types for patterns
user-invocable: false
---

Use the `cf` skill, or read `skills/cf/SKILL.md`, for CLI documentation when
running commands.

# Schema Design Phase

## Goal

Create `schemas.tsx` with all data types and Input/Output types BEFORE any
pattern code.

## Read First

- `docs/common/concepts/types-and-schemas/default.md`
- `docs/common/concepts/types-and-schemas/writable.md`
- `docs/common/concepts/pattern.md` (Input/Output section)

## Rules

1. **ALWAYS use `pattern<Input, Output>()`** - Never use single-type
   `pattern<State>()`. Single-type patterns cannot be tested via `.send()`.
2. Use `Writable<>` in an Input type only for values the pattern receives and
   intends to mutate.
3. **Output types never use `Writable<>`** - they reflect returned data shape
4. Fields that could be undefined initially: use `Default<T, value>`
5. Actions in Output type: `Stream<T>` (enables testing and linking)
6. Sub-patterns need `[NAME]: string` and `[UI]: VNode` in Output type
7. **Decide the sharing boundary now** - choose `PerSpace<>` / `PerUser<>` /
   `PerSession<>` for every Input field at schema time; see the `pattern-dev`
   skill for the new-tab test. Transient UI state (selected tab, filter text,
   open modal) defaults to `PerSession<>`.

## Top-Level vs Sub-Pattern Inputs

A top-level pattern should be usable by itself with sensible defaults and should
usually own its local state unless the brief explicitly describes caller-owned
cells, linking, or embedding.

Do not create required caller-provided `Writable<>` inputs solely because the UI
edits that field. If the top-level pattern owns the state, model that ownership
in the pattern implementation and expose the user-visible shape through the
Output type.

Use caller-provided writable inputs by default for nested sub-patterns that edit
state owned by a parent pattern. Those sub-patterns also need `[NAME]` and
`[UI]` when rendered by composition.

## Template

```tsx
import {
  Default,
  NAME,
  type PerSession,
  Stream,
  UI,
  VNode,
  Writable,
} from "commonfabric";

// ============ DATA TYPES ============
export interface Item {
  name: Default<string, "">;
  done: Default<boolean, false>;
}

// ============ TOP-LEVEL PATTERN (typical deliverable) ============
// Usable standalone: no required caller-provided Writable<> inputs.
// Optional Writable<... | Default<...>> lets callers link state while the
// pattern still works alone; scope wrappers set each field's boundary.
export interface ItemListInput {
  items?: Writable<Item[] | Default<[]>>; // optional + Default = standalone-safe
  filterText?: PerSession<string | Default<"">>; // transient UI state
}

export interface ItemListOutput {
  [NAME]: string;
  [UI]: VNode;
  items: Item[]; // No Writable in Output
  addItem: Stream<{ name: string }>; // Actions as Stream<T>
}

// ============ SUB-PATTERN (edits parent-owned state) ============
export interface ItemInput {
  item: Writable<Item>; // Writable in Input = pattern will modify
}

export interface ItemOutput {
  [NAME]: string; // Required for sub-patterns
  [UI]: VNode; // Required for sub-patterns
  item: Item; // No Writable in Output
  toggle: Stream<void>; // Actions as Stream<T>
}
```

## Done When

- All data types defined with correct Writable/Default wrapping
- All Input/Output types defined for each top-level pattern or sub-pattern
- No TypeScript errors: `deno task cf check schemas.tsx --no-run`
