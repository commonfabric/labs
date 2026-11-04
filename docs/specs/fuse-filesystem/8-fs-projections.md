# 8. Filesystem Projections (`[FS]`)

## Overview

By default, FUSE explodes a pattern's result cell into a recursive directory
tree. This works well for structured data but is poor UX for patterns whose
primary output is a document — you get dozens of nested directories instead
of a readable file.

The `[FS]` symbol lets a pattern declare its own on-disk representation.
When a result cell includes `[FS]`, FUSE produces a single projection file
(`index.md` or `index.json`) at the piece root instead of a `result/`
directory.

## Declaring a Projection

Import `FS` and `FsProjection` from `commonfabric` and add `[FS]` to the
pattern's return object:

```tsx
// Shown at module scope.
import { FS, type FsProjection, NAME, pattern, UI } from "commonfabric";

const MyPattern = pattern<Input, Output>(({ title, content }) => {
  // ...

  return {
    [NAME]: computed(() => `My Pattern`),
    [UI]: myUI,
    [FS]: {
      type: "text/markdown",
      frontmatter: { title },
      content,
    },
    // other fields...
  };
});
```

## The `FsProjection` Type

```ts
type FsProjection =
  | {
      type: "text/markdown";
      frontmatter?: Record<string, unknown>;
      content: string;
    }
  | {
      type: "application/json";
      content: Record<string, unknown>;
    }
  | { type?: undefined; [key: string]: unknown }; // plain object → default JSON projection
```

`pattern()` types `[FS]` at its return position as a `FactoryInput<FsProjection>`,
so a projection that matches none of these shapes is a compile error at the
pattern rather than a surprise at mount time.

## Projection Variants

### `text/markdown` — Markdown with YAML Frontmatter

Produces `index.md` at the piece root:

```markdown
---
entityId: of:ba4jcbvpq3k5soo...
title: My Note Title
---

The note body content goes here.
```

- `entityId` is always injected first and is read-only.
- Primitive `frontmatter` fields (string, number, boolean, null) become YAML
  key-value pairs.
- Complex `frontmatter` fields (arrays of entities, nested objects) cannot be
  represented in YAML — they become sibling directories alongside `index.md`,
  using the same directory-tree rules as the default result layout.
- `content` becomes the markdown body after the closing `---`.

### `application/json` — Explicit JSON

Produces `index.json` at the piece root:

```json
{
  "entityId": "of:ba4jcbvpq3k5soo...",
  "field1": "value1",
  "field2": 42
}
```

`entityId` is always injected first. The `content` object's keys follow.

### Plain Object (Default JSON Shorthand)

Omitting `type` treats the entire `[FS]` value as the content of
`index.json`. Equivalent to `{ type: "application/json", content: theObject }`:

```tsx
// Shown for illustration only.
[FS]: { summary, count }  // → index.json with { entityId, summary, count }
```

## Write-Back

`index.md` and `index.json` are writable. Edits are parsed and written back
to the corresponding reactive cells.

| File | Write-Back Behavior |
|------|---------------------|
| `index.md` | Parses YAML frontmatter → updates `$FS.frontmatter.<key>` cells; parses body → updates `$FS.content` cell |
| `index.json` | Parses JSON → updates `$FS.content.<key>` cells |

`entityId` is always skipped on write (read-only).

## Callables and `.handlers`

When `[FS]` is active, callable files (`.handler`, `.tool`) move from
`result/` to the piece root, alongside `index.md` or `index.json`.

The `.handlers` summary file is always at the piece root regardless of
whether `[FS]` is used.

## The `.handlers` File

Every piece has a `.handlers` file at its root, generated automatically:

```
editContent.handler  {
  detail: {
    value: string
  }
}
setTitle.handler  string
appendLink.handler  {
  piece: MentionablePiece
}
createNewNote.handler  void
```

- Dot-prefixed: hidden from `ls` but readable with `cat .handlers`
- One entry per callable (handlers and tools)
- Input type shown as a TypeScript-ish shape
- Void handlers (no payload) show `void`

## Callable Scripts

Each `.handler` and `.tool` file embeds the input schema as readable comments:

```sh
#!/path/to/cf-exec exec
# schema: {"type":"string"}
# input: string
exec '/path/to/cf-exec' exec "$0" "$@"
```

Use `cat setTitle.handler` or `head setTitle.handler` to see the expected
input before invoking. Run with `--help` for full usage including all flags:

```bash
./setTitle.handler --help
# Usage:
#   ./setTitle.handler [invoke] --value <string>
#   ...
# Input type:
#   string
# Flags:
#   --value <string>  Required.
```

Call with no arguments to see the expected type in the error:

```bash
./setTitle.handler
# Handler requires input. Expected type: string
# Run --help for full usage.
```

## Live Updates

Projection files update reactively. When a cell changes, the FUSE daemon
regenerates `index.md`/`index.json` in place and invalidates the kernel
cache. Reads always see the current cell value.

## Example: Note Pattern

The `Note` pattern in `patterns/system/notes/note.tsx` uses `[FS]`:

```tsx
// Shown inside a pattern body.
return {
  [NAME]: computed(() => `📝 ${title.get()}`),
  [UI]: <cf-screen>...</cf-screen>,
  [FS]: {
    type: "text/markdown",
    frontmatter: { title },
    content,
  },
  title,
  content,
  editContent,
  setTitle,
  // ...
};
```

Mounted result for a note piece:

```
home/pieces/📝 My Note/
  index.md              # YAML frontmatter + note body
  $UI.json              # serialized UI tree (single file, not exploded)
  editContent.handler   # { detail: { value: string } }
  setTitle.handler      # string
  appendLink.handler    # { piece: MentionablePiece }
  createNewNote.handler # void
  toggleMenu.handler    # void
  input.json
  input/
    title
    content
  meta.json
  .handlers
```

---

**Previous:** [Open Questions](./7-open-questions.md)
