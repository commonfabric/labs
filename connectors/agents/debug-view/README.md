# Agent sessions debug pattern

This pattern shows the live state of an agent connector host and provides an
explicit command composer. The host deploys one stable instance and passes
direct cell links for:

- the recent session index;
- the complete session index;
- host and connector health;
- the writable command action array; and
- the command receipt index.

The pattern does not reconstruct these cells from causes. Its input links are
the same `Cell` objects exposed by `AgentFabricTarget.cells`, so updates remain
reactive and the view does not duplicate connector state.

The host deploys the view before it performs the first collection, so each
top-level input accepts `undefined`. Published connector graphs store every
array element in a stable child cell. The pattern declares those boundaries as
either an unloaded `undefined` slot or a `Cell` array element. The runtime
presents loaded values to the view while retaining the underlying cells for
reactive updates. A session row also retains its manifest as a `Cell`, so
listing sessions does not read that manifest.

## Views

| Tab       | Contents                                                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview  | Host state, command admission, pending receipts, source lifecycle, collection completeness, source errors, counts, cell IDs, and index state  |
| Sessions  | Complete session index with source, title, conversation status, synchronization state, relative idle time, worktree suffix, and raw-data link |
| Commands  | Confirmed command composer, full command values, and receipt-index entries                                                                    |
| Activity  | The host's bounded lifecycle and receipt history                                                                                              |
| Raw cells | Links to separate, on-demand JSON views of each top-level connector cell                                                                      |

## Command composer

The Commands tab can append `prompt`, `cancel`, `rename`, `set-mode`, and
`set-config-option` values to the connector's command cell. The form validates
the source, native session ID, payload, and connector format limits. The
Sessions tab has a Command button that fills the source and native session ID
without displaying that ID in the session table. Choosing a session starts a
fresh draft so payload fields from another conversation do not carry over.

Reviewing creates an immutable command snapshot with a generated ID and
timestamp. A modal shows the complete snapshot, including prompt text, before
the user can send it. Sending serializes the snapshot as JSON and uses
`Cell.push()`. The connector accepts both object values and JSON strings. The
string keeps the appended value inline in the shallow command action array, so
the host receives the complete command without following another cell.
Concurrent command producers append instead of replacing each other's command
arrays. The host deduplicates command IDs, publishes an in-flight receipt before
calling a driver, and publishes the terminal outcome in the receipt index.

Command drafts, the pending confirmation, validation messages, and the last
submission message use `Writable.perSession`. They are not shared between
viewers. The command array is shared connector state. The composer disables its
review and send actions while host health reports that command admission is
stopped.

Each Raw data link opens a separate read-only piece for that session's stable
manifest cell. The detail piece reads the provider metadata, complete normalized
message list, and native event chunks. Those values include the provider session
ID. The sessions table omits provider IDs. The table shows and projects up to 20
sessions per page. Every published session remains reachable without keeping
off-page session rows or their raw-data pieces active. Raw views opened as
separate pages have independent lifetimes. The page filter and column sorting
apply to the current page only and do not load every retained row.

The complete index stores live cells for session rows. The pattern selects a
current page before projecting those cells into table rows. The list runner uses
each session cell as the projection identity and stops projections that leave
the page. Projection results remain row-cell links. Only those selected row
cells feed sorting, filtering, and rendering. A raw view that was opened as its
own page has an independent lifetime, so reclaiming its table row does not stop
the open page. A session gets the same raw-view URL when it returns to the table
page. Each row stores a manifest cell with an empty document schema, so
validating the table does not follow the manifest's child links. When the
separate raw session view mounts, its start handler removes that listing schema
and reads the selected session. Manifests store live cells for chunk
descriptors, and each descriptor stores a live native-event chunk cell. Arrays
inside provider JSON use the same stable child-cell convention. The rendered
loading state does not contain the manifest cell. Opening the session table
therefore does not read every retained transcript.

The debug pattern gives session rows only the shallow fields used by the table.
Each row keeps its manifest behind an opaque cell link. Opening the table does
not read transcript chunks; the separate raw-data view loads them when opened.

The host protects the deterministic command queue before it creates or starts
the debug piece. It starts the piece, labels the rendered result for the owner,
and stores an owner-confidential registration. It does not add the piece to the
space-wide home registry. The host reports the piece ID as a local discovery
handle.

On later starts, the host reuses a prepared piece only when its pattern
identity, configured owner, and every connector input link match. The pattern
identity is part of the piece's stable cause. A new pattern identity therefore
creates a new piece. A shallow owner-confidential registration identifies the
current piece and retains the causes of retired pieces. The host removes stale
shared-registry links and stops superseded local runners without traversing
their result graphs.

The Overview tab reports the recent and complete index generations, generation
times, row counts, total session counts, and older-session counts. It reads the
index structure with opaque row links. It does not put the indexes themselves
into the rendered result graph.

The Raw cells tab links to separate views. Each view keeps its target behind an
opaque input. Its loading UI does not read that input. Mounting the view sends
an event to a payload-specific handler. The handler reads the target and stores
a formatted JSON snapshot in the detail view. The main debug result therefore
contains links to the raw views rather than copies of the connector cells.
Separate handlers for session indexes, health, commands, and receipts keep their
schemas independent. Starting the main view does not test a large cell against a
union of every connector payload schema. A top-level raw view reads one
document. Nested cells remain in the fabric's stored link representation. It
does not follow those links. The complete-index view can therefore show every
session-row address without fetching every manifest or native event chunk.

The raw session view follows the same event-driven boundary. Its `rawJson`
output remains at the loading text until its `load` stream receives an event.
The handler then reads the manifest and its linked chunks. The mounted view
sends the event through `cf-autostart`. The resulting JSON is a snapshot from
the time the raw detail view starts.

## Raw-data provenance

Every separate raw-data page includes a **Where this data comes from** card. The
page result also exposes the same information in its `provenance` field. That
record contains:

- the code path that wrote the data;
- the exact Fabric space, entity, and value path, plus the link's declared
  scope;
- a `cf inspect` procedure for retrieving the stored value;
- the environment needed to run that procedure;
- the transformations applied before rendering the JSON; and
- provider retrieval instructions when the data began as a provider
  conversation.

The generated procedure assumes `CF_API_URL` contains the Toolshed server URL
and `CF_IDENTITY` contains the path to the signing identity key. Run it from a
Labs checkout. The Toolshed `ENV` must be `development`, `test`, or `staging`,
and `MEMORY_DUMP_ENABLED` must be `true`. The signing DID must appear in
`MEMORY_DUMP_DIDS` or `MEMORY_SERVICE_DIDS`; ordinary Fabric read access does
not grant access to the raw SQLite dump endpoint.

The first command force-downloads a current read-only snapshot, including its
revision history, into the local inspection cache. For the default `space`
scope, the second command lists every revision of the source entity. Match a
revision to the page using its IDs, timestamps, content hashes, and rendered
JSON. The final command reconstructs that exact revision:

```sh
deno task cf inspect pull 'SPACE_DID' --remote --force
deno task cf inspect history 'SPACE_DID' 'ENTITY_ID' \
  --remote --limit=-1 --json
# Replace REVISION_SEQ with the selected numeric seq.
deno task cf inspect value-at 'SPACE_DID' 'ENTITY_ID' \
  --remote --full-depth --seq REVISION_SEQ \
  --path-json '["OPTIONAL","VALUE","PATH"]'
```

The value command resolves the space through the remote listing but reuses the
snapshot that the forced pull placed in the cache. It omits `--path-json` for a
root value. Each JSON array item is one exact object-property name or array
index. Array indexes are strings such as `"0"`. This form preserves property
names that contain `/` and property names that are empty strings. `--seq` keeps
the result stable after later connector publications. `--full-depth` prevents
annotated output from replacing deep provider data or child links with a
truncation marker.

A Fabric link stores a declared scope: `space`, `user`, or `session`. The
`--scope` option accepted by `cf inspect history` and `cf inspect value-at`
instead takes the exact `scope_key` stored in SQLite. Passing `user` or
`session` to those commands does not select a user-scoped or session-scoped
value. For either non-space scope, the raw page inserts this additional
procedure:

```sh
deno task cf inspect overlay 'SPACE_DID' 'ENTITY_ID' --remote --json
# Repeat the next command for every variants[] entry whose kind matches the
# declared scope. Replace RAW_SCOPE_KEY with that entry's exact scope field.
deno task cf inspect history 'SPACE_DID' 'ENTITY_ID' \
  --remote --limit=-1 --json --scope 'RAW_SCOPE_KEY'
# For every candidate history, try each relevant revision sequence.
deno task cf inspect value-at 'SPACE_DID' 'ENTITY_ID' \
  --remote --full-depth --seq REVISION_SEQ \
  --path-json '["OPTIONAL","VALUE","PATH"]' --scope 'RAW_SCOPE_KEY'
```

The JSON returned by `overlay` includes every stored variant. Each
`variants[].scope` field is an exact raw key. A user key has the form
`user:${encodeURIComponent(PRINCIPAL_DID)}`. A session key has the form
`session:${encodeURIComponent(PRINCIPAL_DID)}:${encodeURIComponent(SESSION_ID)}`.
The same output identifies the decoded `principal` and `sessionId`.

`overlay` reconstructs the latest value in every scope. A raw page can contain
an earlier snapshot, so its current value is not a reliable way to choose one
scope key. Treat every variant with the link's declared scope as a candidate.
List the complete history for each candidate. Select the scope key and revision
sequence together by running `value-at` and comparing the complete value at the
link's path with the raw page. If several candidates reproduce the same value,
each independently obtains the displayed raw data.

`value-at` represents each stored child cell as a `$link` object. A raw page
that materializes child cells includes a second command template. Run it for
every link and repeat until no unresolved links remain. Pull the linked space,
list that entity's history, and select the revision whose rendered value matches
the corresponding value shown on the raw-data page. Do this for every linked
entity. The matching revision can differ for every entity, including links in
the same space, so a child command does not reuse the root sequence without
checking its history. Resolve a relative link against the cell that contains it.
A missing ID uses the containing entity. A missing space uses the containing
space. A missing scope or the `inherit` scope uses the containing declared
scope. For a resolved `user` or `session` scope, run `inspect overlay` for that
linked entity. Search the full history of every `variants[].scope` candidate
with the resolved declared scope. Select the scope key and revision sequence
together by matching the page value. Conversation pages call out the metadata,
summary, normalized-message, chunk-descriptor, event, and nested provider-data
links explicitly. Command-payload and activity-detail pages provide the same
recursive procedure for child cells inside their selected values.

| Raw page               | Stored source and rendered transformation                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation data      | `AgentFabricTarget.publish()` writes a deterministic session manifest from `AgentDriver.readSession()`. The manifest records the producing driver. The index row repeats it for listing. The page takes provider provenance from the manifest, materializes its stable child values, follows each descriptor's chunk link, and returns the manifest plus the native event chunks. The retrieval procedure describes every stable-cell stage. |
| Recent session index   | `AgentFabricTarget.publish()` replaces the deterministic recent-index cell after a collection. The cell contains source-row and recent non-deleted session-row links. The page preserves those links instead of loading the linked rows.                                                                                                                                                                                                     |
| Complete session index | `AgentFabricTarget.publish()` replaces the deterministic complete-index cell after a collection. The cell contains source-row links, non-deleted session-row links, and retained deleted-session rows. The page preserves those links.                                                                                                                                                                                                       |
| Health                 | `AgentsHost.health()` builds a host snapshot. `AgentFabricTarget.publishHealth()` writes it to the deterministic health cell. The page preserves its source and activity child links.                                                                                                                                                                                                                                                        |
| Commands               | Authorized Fabric writers append values to the deterministic command action cell. The page reads the root action array and represents linked child cells as `$cell` records. It does not validate or execute commands.                                                                                                                                                                                                                       |
| Receipts               | `AgentFabricTarget.publishReceipt()` writes one deterministic receipt document per command and updates a bounded receipt index. The page reads the index and preserves both receipt-row and individual-receipt links.                                                                                                                                                                                                                        |
| Command payload        | The source is one action value in the command cell. A JSON string is decoded and the fields needed for table display are checked. The page renders only its provider-specific `payload`. An unrecognized action page renders the complete value. The host independently applies the complete command validation before execution. The retrieval procedure returns the stored action value and explains how to materialize its child links.   |
| Receipt details        | The source is one stable row linked from the receipt index. The page selects `updatedAt`, `error`, and the individual receipt-document link. Its provenance shows commands for both the index row and the linked receipt document.                                                                                                                                                                                                           |
| Activity details       | `AgentsHost` records an event in its bounded activity list. The next `AgentsHost.health()` snapshot carries the event to the health cell. The page selects only the event's `details` field. The event ID, time, type, source, and message remain in the containing activity row. The retrieval procedure explains how to materialize child links inside `details`.                                                                          |

After its raw-data load, the conversation page identifies the source and the
driver recorded in the manifest that contains the displayed snapshot. It does
not take historical provider attribution from the denormalized index row,
because a publication interrupted after writing the manifest can leave an older
index row in place. The page provides the provider-side operation that supplied
the connector snapshot:

- `codex-app-server` uses the JSON-RPC method `thread/read` with the native
  thread ID and `includeTurns: true`;
- `claude-agent-sdk` uses `getSessionInfo()` and `getSessionMessages()` with
  `includeSystemMessages: true`; and
- `acp` uses `session/list` to recover the session working directory and then
  `session/load`, while collecting the resulting `session/update` notifications.

Provider metadata and native events can therefore be compared directly with the
Fabric manifest and chunks. Normalized messages are connector-derived values.
Reproduce those by running the same driver's normalization code over the
provider events.

The Idle for value uses the reactive minute clock and the provider's `updatedAt`
value. The Worktree value shows the final 10 characters of `gitWorktreeRoot`;
hovering it exposes the complete path.

Status is `archived`, `active`, `inactive`, `unarchived`, or `unknown`. Archive
state and activity are independent provider fields. A conversation that is
explicitly not archived but has no reported activity state is `unarchived`. The
Sync column separately reports connector publication state.

Tab selection, session page, page filter, sort column, and sort direction use
`Writable.perSession`. Different viewers therefore keep independent debug state.
Each raw detail piece stores its JSON snapshot in a local writable cell. Its
handler fills that snapshot when the detail view starts. The command composer is
the pattern's only write path to connector cells. It can append to the command
cell but cannot change session indexes, health, receipts, manifests, or native
event chunks.

Command values can contain prompt text. Session previews and linked manifests
can contain transcript content. A viewer with write access can also direct the
running host to act on provider conversations. Treat access to this piece as
access to the destination space's agent data and command surface.

## Direct use

The supported deployment path is `deployAgentSessionsDebugView()` from
`@commonfabric/agents-host`. A caller that creates the pattern directly must
bind each of the five connector cells to both its value input and its opaque
`Cell` input. The command value input must retain write access. The value inputs
drive the tables and command composer. The opaque inputs drive the separate raw
views without copying connector state.

## Verification

```sh
deno task cf check connectors/agents/debug-view/main.tsx --no-run
deno task cf test connectors/agents/debug-view/main.test.tsx \
  --root . --verbose
```
