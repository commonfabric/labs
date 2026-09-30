# Mentionables

Mentionables are pieces that a pattern exposes for discovery by other patterns
and UI components. They power `@`-mention autocomplete in `cf-prompt-input` and
`[[`-mention autocomplete in `cf-code-editor`.

## Exporting Mentionables

Export a `mentionable` property from your pattern to make child pieces
discoverable:

```tsx
// Shown for illustration only.
export default pattern<Input, Output>(({ ... }) => {
  const childPiece = ChildPattern({ ... });

  return {
    [NAME]: "Parent",
    [UI]: <div>...</div>,
    mentionable: [childPiece],  // Makes childPiece discoverable
  };
});
```

For dynamic collections, use a Writable:

```tsx
// Shown inside a pattern body.
const createdPieces = new Writable<any[]>([]);

const create = handler((_, { createdPieces }) => {
  createdPieces.push(ChildPattern({ name: "New" }));
});

return {
  [UI]: <cf-button onClick={create({ createdPieces })}>Create</cf-button>,
  mentionable: createdPieces,
};
```

**Notes:**
- Exported mentionables appear in autocomplete but NOT in the sidebar piece list
- This is for mentionables within your pattern's own scope — to add pieces to the
  global piece list, use the `addPiece` handler via `wish("#default")`.
  See [Adding Pieces](adding-pieces.md).

Mentionables are one deliberate way to make an unregistered child discoverable.
They do not provide a complete piece listing and cannot expose an orphan. See
[Finding Pieces](../concepts/piece-discovery.md).

### Index rows, and the reserved `piece` key

A `mentionable` list may hold the pieces themselves — the examples above —
or derived INDEX ROWS standing for them: entries shaped `{ [NAME], piece }`,
where the strings are the row's own copies and `piece` holds the actual
piece as a reference. A board-sized producer reaches for rows so that every
reader of the universe loads one document instead of every listed piece;
the Topics board's `mentionable` is the worked example, derived through the
library both it and the collection-naming exemplar share (`MentionableRow` in
`packages/patterns/collection-naming/mentionable.ts`).

`piece` is therefore a RESERVED key on this contract: an entry carrying one
IS a row, and the editors store what `piece` names — never the entry — as
the mention's destination. A producer must not publish an unrelated
property named `piece` on its mentionable entries; doing so silently
redirects every mention of that entry. How consumers resolve rows is in
[`mentionable-internals.md`](../../../packages/ui/docs/mentionable-internals.md).

### The member name, `shortName`

One further key carries a collection's name for a member — `42` for a board that
numbers its members. It is an optional plain string, and the copy a ROW carries
is the one the editor reads.

`cf-code-editor` reads a row's copy at both ends of a mention. A `#42`
completion matches against it, which lets that query run without reading a
member. A mention's pill shows it beside the label where the mention's
destination is the piece the row stands for, found by identity, so a mention
already written gains the number once the universe lists its destination under
one, and loses it when the universe stops. A producer whose collection names
nothing leaves the key out, and a row without it is one no such query reaches
and no pill takes a name from. A collection that names its members and shows
none of the names is in the same position: it publishes no name on a member, so
a row's copy is the empty string, which both ends read as no name.

A PIECE may publish a `shortName` for itself too — the name the collection that
created it gave it — and a producer building rows may copy it from there. The
editor never reads it off a destination: that name means something only to a
reader reading through the collection that assigned it, while a row's copy is
what the universe being read calls the member. A destination no row stands for
shows no name, whatever it publishes.

The name is never written into any document. A citation's spelling is computed
where it is read, which is the rule
[Naming in collections](../../specs/collection-naming.md) states.

## Wishing for Mentionables

Patterns can discover mentionables in the current space using `wish()`:

```tsx
// Shown inside a pattern body.
const mentionable = wish<MentionablePiece[]>({ query: "#mentionable" }).result;
```

Or with the `scope` parameter:

```tsx
// Shown for illustration only.
// Search mentionables in current space
const result = wish<{ content: string }>({ query: "#note", scope: ["."] });

// Search both favorites and mentionables
const result = wish<{ content: string }>({ query: "#note", scope: ["~", "."] });
```

See [wish](wish.md) for full documentation.

## Consuming Mentionables in UI Components

### cf-prompt-input (`@`-mentions)

Pass the mentionable cell to `cf-prompt-input` via the `$mentionable` attribute:

```tsx
// Shown inside a pattern body.
const mentionable = wish<MentionablePiece[]>({ query: "#mentionable" }).result;

<cf-prompt-input
  $mentionable={mentionable}
  placeholder="Type @ to mention..."
/>
```

When the user types `@` and selects a mention, it is inserted as a markdown
link in the format `[Name](/of:entityId)`. The `/of:` prefix and entity ID
follow the LLM-friendly link format used throughout the system.

### cf-code-editor (`[[`-mentions)

Pass mentionable and mentioned cells to `cf-code-editor`:

```tsx
// Shown inside a pattern body.
const mentionable = wish<MentionablePiece[]>({ query: "#mentionable" }).result;
const mentioned = new Writable<MentionablePiece[]>([]);

<cf-code-editor
  $value={content}
  $mentionable={mentionable}
  $mentioned={mentioned}
  language="text/markdown"
/>
```

When the user types `[[` and selects a mention, it is inserted as a wiki-link
in the format `[[Name (entityId)]]`. The entity ID is the bare CID without
the `of:` prefix. For rendering, `note-md.tsx` converts these to markdown
links by prepending `/of:`.

## Internals

How UI components resolve `@link` indirection (`asSchema()`,
`resolveAsCell()`, MentionController, link-format conversion) is contributor
documentation: see
[`packages/ui/docs/mentionable-internals.md`](../../../packages/ui/docs/mentionable-internals.md).
