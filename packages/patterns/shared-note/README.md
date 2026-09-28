# Shared note

A standalone Markdown document for a shared space or an embedded Loom panel. It
uses `cf-code-editor` in collaborative prose mode, with the document title and
body in `PerSpace` state. The same compact view is available as `UI` and
`TILE_UI`.

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
cf piece new packages/patterns/shared-note/main.tsx \
  --root . --test packages/patterns/shared-note/main.test.tsx \
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
editors open the note, change its body through the collaborative editor rather
than replacing it with an ordinary whole-value write.

The pattern includes no notebook, note registry, or automatic backlink creation.
Space membership controls access through the host's ordinary sharing flow.

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
deno run --no-lock -A packages/cli/mod.ts test packages/patterns/shared-note/main.test.tsx
```

The pattern test covers initial text, compact views, profile setup, editor
bindings, error display, recovery, and the live-cursor notice. Browser
integration covers multiple identities and the actual editor protocol.
