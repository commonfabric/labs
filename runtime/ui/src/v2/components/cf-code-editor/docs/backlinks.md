# Backlink implementation in cf-code-editor

Backlinks are inline references stored directly in the document text as
`[[Note Name (some-id)]]`. The ID is the stable reference to the linked piece;
the name is the human-readable label. The user never sees the ID — it is hidden
by decorations.

This is one of the editor's two mention forms. Given a `$references` cell it
mints the other, described in [`mention-refs.md`](mention-refs.md), which keeps
the destination in that cell rather than in the text. Both forms are read
whichever is being minted, so a document holding either works.

## The four CM6 building blocks

The implementation uses four distinct CodeMirror 6 features stacked on top of
each other.

### 1. `StateField` — the source of truth (`backlinkField`)

A `StateField` is a piece of data that lives inside CM6's immutable state and
updates automatically with every transaction. `backlinkField` runs
`parseBacklinks()` (a plain regex scan) over the document string whenever the
doc changes, producing an array of `BacklinkInfo` objects — each one is just the
`from`/`to` positions plus `name` and `id`.

```
"text [[My Note (abc123)]] more"
              ↑          ↑
         from=5       to=25
         nameFrom=7   nameTo=14
```

Everything else reads from this field rather than re-parsing the document
themselves.

### 2. `transactionFilter` — protecting the ID (`backlinkEditFilter`)

A `transactionFilter` intercepts every transaction before it is applied. This
one looks at any proposed change and asks: _does it touch the `(id)]]` portion
of a backlink?_ If so, it either blocks the change entirely (edit starts inside
the ID) or truncates it to the name boundary (edit spans from name into ID).

### 3. `atomicRanges` — cursor skipping (`atomicBacklinkRanges`)

`EditorView.atomicRanges` tells CM6 to treat a range as a single unit for cursor
movement. This extension produces two atomic regions per complete backlink: the
`[[` prefix and the `(id)]]` suffix. Arrow-key navigation jumps over those
regions, so the cursor can enter the name area but the ID is unreachable from
the keyboard.

### 4. `ViewPlugin` with `Decoration` — visual rendering (`createBacklinkDecorationPlugin`)

A `ViewPlugin` runs in the view layer (not the state layer) so it can react to
focus state. It produces a `DecorationSet` — a sorted set of `Decoration.mark`
and `Decoration.replace` ranges that CM6 uses for rendering:

| Cursor position                  | What the user sees                                            |
| -------------------------------- | ------------------------------------------------------------- |
| Outside a complete backlink      | `[[` hidden, `(id)]]` hidden, name styled as a clickable pill |
| Inside a complete backlink       | `(id)` hidden, `[[` and `]]` visible — user sees `[[Name]]`   |
| Outside an incomplete `[[text]]` | `[[` hidden, `]]` hidden, name styled as a pending pill       |
| Inside an incomplete `[[text]]`  | Full `[[text]]` shown with an editing style                   |

The plugin re-runs on `docChanged`, `selectionSet`, `viewportChanged`, and
`focusChanged`.

## How the layers fit together

```
Document text: "[[My Note (abc123)]]"

StateField ──────── parses positions ──────────────────────────┐
                                                               ↓
transactionFilter ── reads StateField, blocks ID edits        │
                                                               │
atomicRanges ──────── reads StateField, makes [[ and (id)]] ──┤
                       unjumpable by cursor                    │
                                                               │
ViewPlugin ────────── reads StateField + hasFocus + cursorPos ─┘
                       → hides/shows parts with Decorations
```

The `StateField` is the central hub — the other three all read from it rather
than doing their own parsing.

## Known issues and future improvements

1. **The backlink logic lives in `features/backlinks.ts`**, fully extracted from
   the Lit component. The exports (`parseBacklinks`, `backlinkField`,
   `atomicBacklinkRanges`, `backlinkEditFilter`, `BacklinkInfo`) are tested
   directly in `features/backlinks.test.ts`.

2. **The `ViewPlugin` re-runs on every selection change** across the whole
   document. For documents with many backlinks this is fine, but it could bail
   early when the cursor has not moved relative to any backlink boundary.

3. **`atomicRanges` and the `ViewPlugin` both iterate all backlinks
   independently.** They could share a single pass, though this is a minor
   concern in practice.
