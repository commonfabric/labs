# Shared note

A standalone Markdown document for a shared space or an embedded Loom panel. It
uses `cf-code-editor` in collaborative prose mode, with the document title and
body in `PerSpace` state, and a panel of comments on ranges of the body beside
the editor. The same compact view is available as `UI` and `TILE_UI`.

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

## In the filesystem

Mounted through FUSE, the note is a single `index.md`: its title in the
frontmatter, then the body. Saving the file writes both back. A save replaces
the whole body, which the body accepts only until an editor has changed it;
after that, a save that changes the body is refused, while one that changes only
the title still lands. A save that changes both lands the title and not the
body, because the two are written separately. Change the body then through the
verbs below, which the mount exposes as callable files beside `index.md`.

A save that replaces the body moves no comment. Memory moves a comment's anchors
through edits made in the editor or by the verbs, and a whole-body write is
neither, so a comment placed before any editor has changed the note keeps its
old offsets after such a save and may sit on other text, which its mark then
shows.

## Editing from a handler or an agent

Three verbs edit the body while people are typing in it, so an agent or another
pattern can add to a note without the editor:

| Verb          | Event          | Effect                                                                                                                  |
| ------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `appendLine`  | `{ text }`     | Adds `text` at the end, on a line of its own.                                                                           |
| `prependLine` | `{ text }`     | Adds `text` at the start, on a line of its own.                                                                         |
| `replaceText` | `{ old, new }` | Replaces the one occurrence of `old` with `new`; refuses when `old` is empty, occurs nowhere, or occurs more than once. |

```sh
cf piece call --cell <piece> appendLine '{"text": "- [ ] Send the summary"}'
```

Five more verbs work on comments. A comment from a verb anchors on text the body
holds exactly once, as `replaceText` does:

| Verb             | Event             | Effect                                                                                      |
| ---------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| `addComment`     | `{ quote, body }` | Comments on the one occurrence of `quote`; refuses as `replaceText` does, and a blank body. |
| `replyToComment` | `{ id, body }`    | Replies to the comment `id`.                                                                |
| `resolveComment` | `{ id }`          | Marks the comment resolved.                                                                 |
| `reopenComment`  | `{ id }`          | Marks the comment open again.                                                               |
| `deleteComment`  | `{ id }`          | Deletes the comment and its anchors; refused to anyone but its author.                      |

`addComment` and `replyToComment` are refused to a caller with no Fabric profile
of their own, since a comment and a reply are shown under their author's
profile: a profile someone else owns would show them as the author.

`appendLine`, `prependLine` and `replaceText` each read the body and edit it
through `applyChanges()`, by position in the text they read. The edit reaches
the open editors as an edit they merge with their own typing, and lands only
while the body still holds the text the verb read: if someone typed in the
meantime, the commit is refused and the verb runs again against the new text.
`replaceText` matches `old` exactly, code unit for code unit, so text someone
has since edited refuses rather than matching somewhere else; read the note
again and name what it holds. Moving the comments' anchors through each of these
edits is Memory's work, not the verb's.

`addComment` and `deleteComment` change the body's anchors as well as the
comments. Each reads the anchors, and `addComment` the body too, and writes the
anchors it leaves; the commit lands only while what it read still holds, and the
verb runs again otherwise.

The pattern includes no notebook, note registry, or automatic backlink creation.
Space membership controls access through the host's ordinary sharing flow.

## Comments

Selecting text in the editor enables the Comment button. Opening the composer
starts a draft comment and anchors the selected text at once, and marks that
text for the person writing. Post completes the draft, and Cancel deletes it
with its anchors. A draft left open when its author goes away stays listed to
that author alone, with Continue and Discard, and marks nothing for anyone else.
A draft keeps its place in the note; the text typed into the composer is kept
only while the composer is open in that tab. The editor marks each open
comment's text; clicking a mark selects its comment, and clicking a comment
selects it and marks its text more strongly. A comment under the pointer marks
its text more strongly too, for that viewer only, until the pointer leaves its
row. A selected comment shows a reply field and Resolve or Reopen, and, to its
author, Delete. Resolved comments are hidden unless "Show resolved" is checked,
and mark no text.

A comment never stores a position. Each comment has two anchors on the body,
`<id>:from` where its text starts and `<id>:to` where it ends. An anchor is a
point that Memory keeps for the field and moves through every edit, whoever
makes it, in the transaction that stores the edit
(`docs/features/collaborative-fields.md`). Text typed at the start of a
comment's text joins it, and text typed at its end does not. The editor reports
a selection with its whole text. The note keeps the selection only while the
body is that text, and nothing selected until the editor's next report
otherwise, so a selection the body has changed under is never kept. The composer
checks again that the body holds the selected text at its range before it adds
the anchors, refusing a selection an edit has moved since. From then on
everything typed while the person writes moves the anchors with their text. The
panel lists comments in the order their text appears in the body.
`commentAnchors` gives every comment's two anchors.

A row shows the comment, not its text: the mark in the editor shows what the
comment is about. The comment still stores its quote, the text its author
selected. A comment whose text an edit deleted stays listed after the rest,
marks nothing, and shows its quote struck through, beside "text no longer in
note".

Comments and replies are labeled `authored-by` the person each was written for,
by the runtime, and only the handlers their write policies name can write them,
so the profile badge on a comment is the one its author wrote it under.
`cf-cfc-authorship` checks that label against the author's profile, and shows a
deleted comment's quote, the comment and each reply only when they carry it.
Replies and the resolved state are cells of their own, linked from the comment,
so anyone who can write the note can reply or resolve while the comment itself
stays its author's.

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

The pattern test covers initial text, the filesystem projection, compact views,
profile setup, editor bindings, error display, recovery, the live-cursor notice,
the verbs, and comments: posting from a selection, anchors moving through the
verbs' edits, an anchor whose text is deleted, replies, resolving, and deleting.
Browser integration covers multiple identities and the actual editor protocol.
