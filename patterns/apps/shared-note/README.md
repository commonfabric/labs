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
pattern can add to a note without the editor, and two more work on its comments:

| Verb             | Event                | Effect                                                                                                                                                                        |
| ---------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appendLine`     | `{ text }`           | Adds `text` at the end, on a line of its own.                                                                                                                                 |
| `prependLine`    | `{ text }`           | Adds `text` at the start, on a line of its own.                                                                                                                               |
| `replaceText`    | `{ old, new }`       | Replaces the one occurrence of `old` with `new`; refuses when `old` is empty, occurs nowhere, or occurs more than once.                                                       |
| `addComment`     | `{ from, to, body }` | Adds a comment under the caller's profile on the range `from..to` of the body; refuses a range outside the body or with `from` not before `to`, and a caller with no profile. |
| `resolveComment` | `{ id }`             | Marks the comment named by `id` resolved; refuses an `id` that names none.                                                                                                    |

```sh
cf piece call --cell <piece> appendLine '{"text": "- [ ] Send the summary"}'
```

Each body-editing verb reads the body and edits it through `applyChanges()`, by
position in the text it read. The edit reaches the open editors as an edit they
merge with their own typing, and lands only while the body still holds the text
the verb read: if someone typed in the meantime, the commit is refused and the
verb runs again against the new text. `replaceText` matches `old` exactly, code
unit for code unit, so an anchor someone has since edited refuses rather than
landing somewhere else; read the note again and anchor on what it holds. In the
same commit, each body-editing verb maps every comment's anchor through its
edit, so the comments stay on their text whether or not an editor is open; the
Comments section below says how. `addComment` and `resolveComment` change the
comment list and leave the body as it is.

The pattern includes no notebook, note registry, or automatic backlink creation.
Space membership controls access through the host's ordinary sharing flow.

## Comments

A comment is anchored to a range of the body. Select text in the editor, choose
Comment, and post: the comment stores `{ from, to }`, the range in the text as
the editor last reported the selection, with the viewer's `#profile` as its
author, and the body `version` the editor read the selection at, in the
collaborative field's numbering. Every open editor draws each open comment's
range as a highlight, and the panel beside the editor lists the comments with
the author's profile badge, the text the range covers now, replies, and Resolve.
Clicking a highlight or a row selects the comment, which opens its reply field;
a resolved comment marks no text and is listed only under Show resolved.

A range means something only together with the version of the body it was read
against, and every edit of the body is a step in the collaborative field's
history. So an anchor follows the text by being mapped through each edit, the
way the editor maps the selection and its highlights: text inserted before a
range moves it, text inserted inside it grows it, a deletion overlapping it
shrinks it, and a deletion covering it empties it. Two parties do the mapping:

- **Each open editor** maps every highlight through every edit it sees, its own
  or a collaborator's, and reports the mapped positions back to the pattern,
  which writes them onto the comment. Two people typing at once end with both
  editors reporting the same merged positions. Each report names the body
  version it was read at, and the pattern writes a report only when it is later
  than the version the anchor holds. That sets aside the same edit reported by
  every open editor, and a replay: two sessions writing one comment at once have
  the loser's handler run again after the winner's write, replaying a report the
  winner has moved past. Two editors with different unconfirmed edits name one
  version for different text, and the first of their reports to arrive stands
  until the next report from either.
- **Each body-editing verb** maps every anchor through the one change it makes,
  in the commit that makes it, with the same rule the editor applies. A verb's
  edit lands only against the text the verb read, so the mapping is exact; an
  open editor maps the same edit to the same positions and finds nothing to
  report. This is what keeps anchors right when no editor is open.

A comment whose text an edit deleted holds an empty range, `from` equal to `to`.
It stays in the panel marked "text no longer in note" and marks nothing; the
text is gone, and so is the place to put the comment back, so resolve it. A
comment is not re-placed by searching the body for the text it covered: the
range and the version say where it is, and a search can land on a different
occurrence.

`addComment` lets an agent comment through `cf piece call` on a range of the
body, in UTF-16 code units of the text the caller read from the piece's
`content`. The caller's profile is the author, so a caller with no profile is
refused. The range is placed in the body as it is when the verb runs; a caller
that read the body a while ago anchors on whatever the range covers now.

```sh
cf piece call --cell <piece> addComment \
  '{"from": 12, "to": 30, "body": "Who owns this?"}'
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
comments: anchoring on a selection, the editor's highlights, the verbs mapping
an anchor through their edits, an anchor following the editor's reports and
refusing a stale one, orphaning by an editor's report and by a verb, resolving,
replies, and the comment verbs. It drives `SharedNoteCore`, which takes the
viewer's profile as an input, with a profile of its own. `anchors.test.ts` is a
plain unit test of the mapping, which a random comparison against CodeMirror's
`ChangeSet.mapPos()` also agrees with. Browser integration covers multiple
identities, the actual editor protocol, and a comment one viewer makes appearing
as a highlight in the other's editor and staying on its text while they type.
