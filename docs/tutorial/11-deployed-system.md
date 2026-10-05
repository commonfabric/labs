# Chapter 11 — The Deployed System, End to End

Every previous chapter examined one layer. This one assembles them: the
server, the browser app, and the CLI — then re-runs Chapter 1's trace with
all the machinery visible.

## Toolshed: the server

Toolshed (`packages/toolshed`) is a single Deno server that hosts everything
the product needs server-side. Its route groups (`app.ts`) tell the story:

- `storage/memory` — **the** sync endpoint: `GET /api/storage/memory` with a
  WebSocket upgrade, bridging each socket to the memory server of Chapter 9
  (one SQLite engine per space, sessions, watches).
- `ai/llm` (+ `ai/img`, `ai/voice`) — the LLM proxy behind
  `generateText`/`generateObject` (Chapter 5): model routing, caching,
  feedback. Patterns never hold API keys; the capability is mediated
  server-side.
- `blobs` — content-addressed binary storage (images etc., 10 MB cap),
  per-space.
- `patterns` — serves the built-in pattern sources
  (`GET /api/patterns/:filename`).
- `integrations/*` — OAuth flows (Google, Discord, ...) so pieces can hold
  third-party credentials server-side; `webhooks` for inbound events.
- `ingest` — `POST /api/ingest/:id`: a bearer-token channel for external,
  DID-less sources (a phone beacon, a webhook emitter) to durably append
  records to a channel's cell; everything arriving here carries the
  runtime-minted `ExternalIngest` provenance mark (Chapter 10).
- `agent-tools/*` (web-search, web-read), `link-preview`, `sandbox/exec` —
  server-mediated capabilities for patterns and agents.
- `whoami`, `meta`, `health` — introspection; `shell` — serves the web app
  itself.

It boots its own `Runtime` instance too — the server is also a client of the
fabric, which is what server-side piece execution rides on. Configuration is
environment-driven (`HOST`, `PORT`, `MEMORY_DIR`/`DB_PATH`, `CACHE_DIR`,
...); `docs/development/LOCAL_DEV_SERVERS.md` covers running it locally.

## Shell: the browser client

The shell (`packages/shell`) is deliberately thin — a login screen, a
header, and a piece renderer around the runtime:

- **Boot.** The page loads, opens the IndexedDB key store, and either runs
  the passkey flow (Chapter 10) or restores the cached identity. The
  Runtime itself — scheduler, replicas, compiled pattern execution — runs in
  a **Web Worker** (`src/lib/runtime.ts`); the DOM thread talks to it
  through a `RuntimeClient` transport. UI jank and pattern execution are
  isolated from each other.
- **Routing.** `/{spaceName}` shows the space's default pattern;
  `/{spaceName}/{pieceIdOrSlug}` a specific piece; `/.embed/...` the same
  without shell chrome. Navigation is an event (`cf-navigate`) kept in sync
  with browser history, and `navigateTo()` from Chapter 5 bottoms out here.
  [Common Fabric URLs](../specs/fabric-urls.md) describes a possible future ASP,
  namespace, registered-name, DID, and presentation contract. No deployment is
  planned; this route behavior remains authoritative.
- **Rendering.** To show a piece, the shell asks the runtime for the
  piece's result cell, takes its `[UI]` VNode tree, and materializes it as
  DOM: `cf-*` tags become the Lit web components of Chapter 4, whose
  reactive slots are bound to cells via sinks. Updates flow cell → sink →
  component re-render; there is no app-level render loop.

## The CLI, revisited

With the architecture visible, Chapter 6's CLI needs one sentence: `cf` is a
third client — key file instead of passkey, terminal instead of DOM,
loopback or remote transport — driving the identical runtime. That all three
executors (shell, toolshed, CLI) are *the same machine with different
transports* is the architectural payoff of the local/remote symmetry noted
in Chapter 9.

## The full trace

Chapter 1's checkbox, one last time — every step now has a chapter behind
it. Alice and Bob both have `/{space}/todo-list` open; Alice's browser also
ran `cf piece link` long ago to feed the list into a dashboard piece.

1. **Click** (Ch. 4). Alice toggles `<cf-checkbox $checked={item.done} />`.
   The Lit component writes `true` through the binding into the cell — a
   `Writable` whose link is `(space, item-doc-id, ["value", ..., "done"])`.
2. **Transaction** (Ch. 8). The write lands in a transaction journal in the
   worker-hosted runtime. On commit, the replica applies it optimistically;
   the trigger index dirties the `activeItems`/`completedItems` computeds;
   the settle pass re-runs them; UI sinks fire; the row moves to "Completed"
   in Alice's DOM — all before any network round trip.
3. **Commit** (Ch. 9). The storage manager emits a `ClientCommit` — a
   `patch` op on the item document — over the session opened at login
   (signed `session.open`, Ch. 10). A scalar binding write like this
   checkbox is *blind* (last-write-wins): its reads are recorded for
   reactivity, not as commit preconditions. Toolshed's engine validates
   whatever reads a commit does carry against the space's SQLite history
   inside one write transaction, appends commit + revision rows, advances
   the head. Had Bob concurrently patched the same item's `title`, both
   commits would land — disjoint paths never conflict. Had he toggled
   `done` at the same instant, the later write would simply win;
   revert-and-retry is reserved for read-modify-write commits, and
   mergeable ops (a `push` of a new item) merge instead of racing
   (Ch. 8/9).
4. **Fan-out** (Ch. 9). The engine marks the item document dirty. The
   debounced refresh re-walks affected watch graphs per session — Bob's
   watch covers the list's documents via its schema selectors, as does the
   dashboard's (the link from `cf piece link` is just a sigil link the
   traversal follows). Each gets a `session/effect` with the new document
   state; Alice's session is skipped as origin.
5. **Remote update** (Ch. 8/11). Bob's worker integrates the upsert into
   his replica; the notification hits his trigger index; the same computeds
   re-run on his machine; his DOM updates. While a client is running the
   dashboard piece, it sees the same change the same way.

Total pattern-author code involved: one `$checked` binding and two
`computed()` lines. Everything else — atomicity, conflict detection,
sync, multi-client reactivity, auth, persistence — is the substrate doing
its job. That ratio, more than any single mechanism, is the thesis of
Common Fabric.

## Where to go from here

- **Build something**: re-read [Chapter 6](06-workflow.md) and start from
  `packages/patterns/counter/`; the catalog stories
  (`packages/patterns/catalog/stories/`) are the best UI reference.
- **Runtime work**: `docs/development/DEVELOPMENT.md` for style and
  principles, `docs/development/debugging/` for the error reference; the
  scheduler (`packages/runner/src/scheduler.ts`) and the v2 engine
  (`packages/memory/v2/engine.ts`) are the two files most worth reading
  end to end.
- **Areas to watch in the code**: per-space ACL enforcement is enabled by
  default through `MEMORY_ACL_MODE` (Ch. 10), with explicit `observe` and `off`
  rollout overrides; branch
  infrastructure exists in the storage engine's schema while merge remains
  open (Ch. 9); and the CFC flow-control layer is evolving quickly
  (`packages/runner/src/cfc/`, specs in `docs/specs/cfc-*.md`, demo
  patterns in `packages/patterns/cfc-*`).
