# Shared note

A standalone Markdown document for a shared space or an embedded Loom panel. It
uses `cf-code-editor` in collaborative prose mode, with the document title,
body, and comments in `PerSpace` state. The same compact view, comments
included, is available as `UI` and `TILE_UI`.

Each viewer resolves their Fabric profile through `#profile` and `#profileName`.
The header shows the live profile badge, and the editor uses the profile's name
for cursor labels. Without a selected profile, the header shows the profile
create/pick surface. Text editing remains available; named cursor presence
starts when the profile name resolves. Cursor labels are presence information,
not attested authorship of individual edits.

Presence travels over each viewer's existing connection to the memory server.
The editor joins the presence room of the shared content field, and the memory
server admits a viewer to that room through their session on the space, so only
viewers who can read the space see each other's cursors. Everyone must open the
same piece to edit the same document. Creating a piece per person creates
independent documents.

## Create with Markdown

Pass a JSON object with `title` and `content` through
`cf piece new --input-file`:

```sh
cf piece new patterns/apps/shared-note/main.tsx \
  --root . --test patterns/apps/shared-note/main.test.tsx \
  --input-file /path/to/note-input.json \
  --identity /path/to/identity.key --api-url https://your-host.example \
  --space <space>
```

```json
{ "title": "Team notes", "content": "# Agenda\n\n- [ ] Discuss next steps\n" }
```

Markdown is initial data, not generated source code. Use LF line endings for the
content supplied to the collaborative editor; Loom's Markdown importer converts
CRLF and CR line endings to LF while leaving the source file untouched.
Frontmatter and relative links stay in the body. Import does not upload
referenced files or synchronize changes back to a local Markdown file. Once
editors open the note, change its body through the collaborative editor or the
verbs below rather than replacing it with an ordinary whole-value write.

## Editing from a handler or an agent

Three verbs edit the body while people are typing in it, so an agent or another
pattern can add to a note without the editor:

| Verb             | Event             | Effect                                                                                                                                                                                   |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appendLine`     | `{ text }`        | Adds `text` at the end, on a line of its own.                                                                                                                                            |
| `prependLine`    | `{ text }`        | Adds `text` at the start, on a line of its own.                                                                                                                                          |
| `replaceText`    | `{ old, new }`    | Replaces the one occurrence of `old` with `new`; refuses when `old` is empty, occurs nowhere, or occurs more than once.                                                                  |
| `addComment`     | `{ quote, body }` | Adds a comment under the caller's profile on the one occurrence of `quote`; refuses when `quote` is empty, occurs nowhere, or occurs more than once, and when the caller has no profile. |
| `resolveComment` | `{ id }`          | Marks the comment named by `id` resolved; refuses an `id` that names none.                                                                                                               |

```sh
cf piece call --cell <piece> appendLine '{"text": "- [ ] Send the summary"}'
```

Each verb reads the body and edits it through `applyChanges()`, by position in
the text it read. The edit reaches the open editors as an edit they merge with
their own typing, and lands only while the body still holds the text the verb
read: if someone typed in the meantime, the commit is refused and the verb runs
again against the new text. `replaceText` matches `old` exactly, code unit for
code unit, so an anchor someone has since edited refuses rather than landing
somewhere else; read the note again and anchor on what it holds.

The pattern includes no notebook, note registry, or automatic backlink creation.
Space membership controls access through the host's ordinary sharing flow.

## Comments

A comment is anchored to a range of the body. Select text in the editor, choose
Comment, and post: the comment stores `{ from, to, quote }`, the range in the
text as the editor read it and the text it covered, with the viewer's `#profile`
as its author. Every open editor draws each open comment's range as a highlight,
and the panel beside the editor lists the comments with the author's profile
badge, the quoted text, replies, and Resolve. Clicking a highlight or a row
selects the comment, which opens its reply field; a resolved comment marks no
text and is listed only under Show resolved.

Two things keep an anchor on its text as the body changes:

- **Live mapping.** Each open editor maps every highlight through every edit it
  sees, its own or a collaborator's, and reports its own edits' mapped positions
  back to the pattern, which writes them onto the comment. Only the editor that
  made an edit reports, so two editors never write competing positions.
- **Re-finding by quote.** Whenever the stored range no longer holds the quote,
  the pattern looks for the quote in the current text and uses the one place it
  occurs. This is what covers an edit made with no editor open, a verb's
  `applyChanges()` among them.

A comment whose quote is gone from the body, or occurs in it more than once, is
orphaned: it stays in the panel marked "text no longer in note", marks nothing,
and comes back as soon as the body holds its quote once again.

`addComment` lets an agent comment through `cf piece call`, anchored the way
`replaceText` anchors: on text the body holds exactly once. The caller's profile
is the author, so a caller with no profile is refused.

```sh
cf piece call --cell <piece> addComment \
  '{"quote": "Discuss next steps", "body": "Who owns this?"}'
cf piece call --cell <piece> resolveComment '{"id": "<comment id>"}'
```

A comment's `id` is in the piece's `comments` output, with its anchor, author,
body, replies, and whether it is resolved.

## Editing failures

The editor pauses on collaboration errors and the note shows the error. If a
collaboration epoch changes while edits are pending, a session-local recovery
field preserves the unsent text for copying before the user reopens the note.
That recovery field does not replace the shared document.

Live cursors can fail on their own while editing carries on. The note then shows
a status line saying cursors are unavailable, and removes it when the editor
joins its presence room again. A server without presence stays that way until
the viewer's profile name changes; any other failure is tried again the next
time the editor gains focus, so the status line asks the viewer to click outside
the note and back into it.

## Tests

```sh
deno run --no-lock -A runtime/cli/mod.ts test patterns/apps/shared-note/main.test.tsx
```

The pattern test covers initial text, compact views, profile setup, editor
bindings, error display, recovery, the live-cursor notice, the verbs, and the
comments: anchoring on a selection, the editor's highlights, an anchor following
the editor's mapping, re-finding by quote, orphaning, resolving, replies, and
the comment verbs. It drives `SharedNoteCore`, which takes the viewer's profile
as an input, with a profile of its own. `anchors.test.ts` is a plain unit test
of the anchor resolution. Browser integration covers multiple identities, the
actual editor protocol, and a comment one viewer makes appearing as a highlight
in the other's editor and staying on its text while they type.
