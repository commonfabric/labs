# cf-harness console

Type a task, watch the harness work, open what it built — and read what the run
left behind when the feed's elided summaries are not enough. One Deno HTTP
server holding one in-process interactive chat service, and two Lit pages
reading its events over Server-Sent Events: the console itself, and the live
pane a host embeds to show one session working.

A completed turn that names a piece keeps its reference for a bare follow-up in
the same session, including after restart. Explicit attachments select the new
turn's inputs; `inputCells: []` attaches none and clears the retained target on
successful completion without naming a piece. Omission or `null` keeps the bare
follow-up behavior. A `pending: true` output declared by the piece's top-level
result schema prevents naming it as a ready page, and data-only probes stay
unnamed. Reread the same piece after its read settles and verify the result.

A successful `run_pattern` result may carry `outputConcerns`: `error-branch`
reports an observed failure, `pending` marks an unfinished read, and `no-rows`
marks a settled empty read. Pending counts are placeholders. Reread the same
piece through a minimal unnamed reader, passing its result reference in `inputs`
and exposing pending, error, and counts in `resultSchema`. Repair observed
failures; for a settled empty filtered result, compare the unfiltered count.

An unnamed reader still creates a persisted, detached piece; `assign_slug` adds
it to the registered list. Source-history revisions are storage-retention roots:
unnamed pieces are not transient and are neither deleted nor garbage-collected.
See
[piece execution and retention](../README.md#running-patterns-against-a-fabric-space).

The server binds `127.0.0.1` and asks one thing of a request: that it names this
server's own host. A hostile name that resolves to `127.0.0.1` would otherwise
make these routes same-origin to a browser, and that name is visible on the
wire. Nothing else is asked and no client carries a credential, so the network
is the boundary: run this where reaching it already means being trusted — on a
shared host, a tailnet with an access policy — and not behind a public address.

## Prerequisites

- **Toolshed and shell running locally.** `./scripts/start-local-dev.sh` from
  the repository root, which serves the API on `http://localhost:8000`. See
  [`docs/development/LOCAL_DEV_SERVERS.md`](../../../docs/development/LOCAL_DEV_SERVERS.md).
- **Docker.** Every tool the model runs executes in the harness sandbox, which
  is a container. A stopped Docker daemon is a run that fails on its first
  `bash` call.
- **An identity keyfile.** A PKCS#8 key on this host, the same one the `cf` CLI
  uses. The fabric session loads it to sign with, and the pattern index signs
  its requests with the same identity.
- **A space named by name.** `assign_slug` composes the URL a person opens from
  the API URL and the space's name, and offers no URL at all for a space named
  by `did:key`. The server refuses a `did:` space at startup rather than
  finishing a run with no link to show.
- **A connected model provider.** The provider preference lives in
  `$CF_HARNESS_HOME/config.json` and its credentials in
  `$CF_HARNESS_HOME/auth.json`, both written by `cf-harness config set` and
  `cf-harness auth`. `CF_HARNESS_HOME` defaults to `$HOME/.cf-harness`. For
  `openai-compatible-gateway`, the key comes from `CF_HARNESS_API_KEY` or
  `OPENAI_API_KEY` instead; for `openai-codex`, the server preflights the stored
  credential and refuses to start when it is not connected.
- **A model credential.** For `openai-compatible-gateway`, `CF_HARNESS_API_KEY`
  or `OPENAI_API_KEY`; a turn started without one fails on its first model call
  rather than at startup, because the key is read per request.
- **A pattern index URL**, optionally. With one set, the session also offers
  `search_patterns` and `record_feedback`, so a run can find an existing pattern
  rather than write one from scratch, and publishes what it worked out back to
  the index. It is also what the Index view reads; without one that view says so
  and the server answers its route with a 404. Driving a list of tasks through
  this server unattended and counting what they did with the index is
  [the measurement protocol](../docs/pattern-index-measurement.md), whose runner
  reaches this server over the same routes the page does.
- **A public skill registry URL**, optionally. With one set, the parent session
  offers metadata-only `search_skills`; without one, the tool is absent. Its
  registry-reported install counts are unauthenticated and unverifiable, not a
  trust signal, and the tool cannot fetch, read, or load skill content.

## Running it

The console comes along when the fabric does.
`scripts/start-local-dev.sh
--cf-harness` starts one against the fabric it is
starting and stops it with the pair, and loom passes the same flag when it
starts an instance's pair — so on a labs checkout and on a loom host alike,
nobody starts this server by hand:

```sh
./scripts/start-local-dev.sh --cf-harness
```

The flag calls `console:launch`, which is also how to put a console on a fabric
that is already running:

```sh
deno task --cwd packages/cf-harness console:launch --instance <loom-instance>
deno task --cwd packages/cf-harness console:launch \
  --fabric-api-url http://localhost:8000 --store packages/toolshed/cache/memory \
  --fabric-identity "$HOME/.cf/my-key.pkcs8" --fabric-space my-space
```

That task reads the identity, the space and the toolshed URL off a loom
instance's `pieces.json` when `--instance` names one, the store off
`loom toolshed-store-dir`, the connector handles that instance has injected off
its `sqlite-injection/handles.json` receipt, and the two `runsc-cfc` sidecar
directories off the runtime registration `docker info` reports — so a sidecar
path is fixed where Docker registers the runtime, not in loom. Without an
instance the identity and the space are named — by the flags above, or by
`CF_HARNESS_FABRIC_IDENTITY` and `CF_HARNESS_FABRIC_SPACE`, or by the `cf` CLI's
own `CF_IDENTITY` and `CF_SPACE` — and their absence is an error naming them.
The pattern index and skills registry are this deployment's constants rather
than any fabric's. It prints every value with the record that decided it, and
serves on the port Weaver pairs with. Arguments after `--` reach this server
untouched, so every flag in the tables below is reachable through it.
[`../docs/WEAVER.md`](../docs/WEAVER.md) is the operator procedure it belongs
to, including the tailnet topology and the pre-demo preflight.

Against a toolshed of your own, the environment below is what `console:launch`
would otherwise have resolved:

```sh
export CF_HARNESS_FABRIC_API_URL=http://localhost:8000
export CF_HARNESS_FABRIC_IDENTITY="$HOME/.cf/my-key.pkcs8"
export CF_HARNESS_FABRIC_SPACE=my-space
export CF_HARNESS_PATTERN_INDEX_URL=https://index.example/   # optional
export CF_HARNESS_SKILLS_REGISTRY_URL=https://www.skills.sh/  # optional

deno task --cwd packages/cf-harness console
open http://127.0.0.1:8100
```

`console` and `console:launch` both build the page and then serve it, and differ
only in where the configuration comes from: `console` takes it, `console:launch`
resolves it from the fabric and prints what it found. The page is a
[felt](../../felt/) build: its source is `src/`, its static files are `public/`,
and both are emitted to `dist/`, which the server serves and git ignores. A
server started without that build answers `/` by naming the command that
produces it. While changing the page,
`deno task --cwd packages/cf-harness
console:watch` rebuilds `src/` on save — it
serves on felt's own port, which holds no API, so keep the console server
running and reload against it after a rebuild. `console:build` is the one-shot
build on its own.

Every environment variable has a flag, and the flag wins:

| Flag                      | Environment                          | Default                               |
| ------------------------- | ------------------------------------ | ------------------------------------- |
| `--port`                  | `CF_HARNESS_CONSOLE_PORT`            | `8100`                                |
| `--fabric-api-url`        | `CF_HARNESS_FABRIC_API_URL`          | `http://localhost:8000`               |
| `--fabric-identity`       | `CF_HARNESS_FABRIC_IDENTITY`         | required                              |
| `--fabric-space`          | `CF_HARNESS_FABRIC_SPACE`            | required, a name                      |
| `--fabric-foreign-spaces` | `CF_HARNESS_FABRIC_FOREIGN_SPACES`   | no foreign spaces admitted            |
| `--pattern-index-url`     | `CF_HARNESS_PATTERN_INDEX_URL`       | unset                                 |
| `--skills-registry-url`   | `CF_HARNESS_SKILLS_REGISTRY_URL`     | unset                                 |
| `--model`                 | `CF_HARNESS_MODEL`                   | the CLI's default model               |
| `--workspace`             | `CF_HARNESS_CONSOLE_WORKSPACE`       | `.cf-harness-console/workspace`       |
| `--artifact-root`         | `CF_HARNESS_ARTIFACT_ROOT`           | `.cf-harness-console/runs`            |
| `--session-db`            | `CF_HARNESS_CONSOLE_SESSION_DB`      | `.cf-harness-console/sessions.sqlite` |
| `--space-db`              | `CF_HARNESS_SPACE_DB`                | the space's own database, discovered  |
| `--max-model-turns`       | `CF_HARNESS_CONSOLE_MAX_MODEL_TURNS` | the prompt loop's default             |
| `--skills-root`           | `CF_HARNESS_CONSOLE_SKILLS_ROOT`     | the repository's `skills/` tree       |
| `--allow-skill-scripts`   | `CF_HARNESS_ALLOW_SKILL_SCRIPTS=1`   | off; scripts do not run               |
| `--host-mount`            | —                                    | none; repeatable                      |

### Skill scripts

Whether a skill this console holds may have its scripts run in the sandbox is
the operator's decision, and the console takes it at launch rather than per
task, since it is about the server rather than about the work:

```sh
./scripts/start-local-dev.sh --cf-harness --allow-skill-scripts
```

Off unless named, and naming it once covers every skill the run holds — a
registry skill and an acquired one alike, because what a script is trusted with
is the sandbox it runs in, which does not vary with where the skill came from.
The value is printed beside the record that decided it, with the rest of what
the launch resolved, so what a console will run is on screen before it binds.

The switch decides whether scripts run and nothing about which bytes. A registry
script is still checked against the run-start registry snapshot, and an acquired
one against the digest taken when it was acquired, so a file changed on the host
after either still refuses.

Publishing to the index is configured the way the CLI configures it, by the same
names:

| Flag                                   | Environment                                       | Default               |
| -------------------------------------- | ------------------------------------------------- | --------------------- |
| `--no-pattern-index-publish`           | `CF_HARNESS_PATTERN_INDEX_PUBLISH=0`              | publishing is on      |
| `--pattern-index-publish-discoverable` | `CF_HARNESS_PATTERN_INDEX_PUBLISH_DISCOVERABLE=1` | recorded, not offered |

A pattern a session authors and runs is recorded against the index unless
publishing is turned off, and is offered to search only when discoverability is
asked for — which is for deliberate corpus seeding, since discoverability is
otherwise earned from later evidence. The
[seeding guidance](../README.md#seeding-the-pattern-index) distinguishes raw
connector readers from pieces built and evaluated with a person.

`--host-mount name=<name>,source=<host path>,target=<sandbox path>[,mode=readonly|writable]`
takes the same spec the CLI takes, and is repeatable. It is how a reference tree
— a corpus to work from, a checkout to read — reaches the sandbox a task runs
in.

Every turn scans the skills root and records the registry on its run before the
first model call, so `read_skill_resource` can answer and a delegated
`pattern-author` child inherits its profile's preloaded skills — the authoring,
schema, and UI guides. A turn whose run carries no registry authors patterns
without them. Tools read the tree on the host, so it needs no sandbox mount; the
registry names host paths, and the run's `skill-registry.json` artifact records
what the scan found.

Everything the server writes lives under `.cf-harness-console/` in the working
directory — the sandbox workspace, run artifacts, the session database, and the
sandbox's two CFC sidecar transport directories. The harness refuses to start an
enforcing run without those transports wired, so this surface sites them itself;
`CF_HARNESS_RUNSC_CFC_RESULT_DIR` and
`CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR` move them somewhere else.
`CF_HARNESS_CONSOLE_DIR` moves the whole tree. Give each console a directory of
its own: nothing stops two from sharing one, and two that do interleave their
runs, so a run record names a session the other console holds. `console:launch`
names one per fabric and port for that reason.

`--session-db none` keeps sessions in memory for the life of the process, which
is what a throwaway run wants. Otherwise sessions, turns, and events are
durable: restarting the server and reopening the page replays the log.

## HTTP routes

Every route is behind the loopback `Host` check and nothing else. A caller that
names this server's host may call any of them, in one request, with no preceding
one.

| Method | Route                        | Result                                                                                  |
| ------ | ---------------------------- | --------------------------------------------------------------------------------------- |
| `GET`  | `/api/health`                | Console health, configured Fabric API URL, and honestly limited Fabric-session liveness |
| `GET`  | `/api/health/detail`         | Cached operator observations with deciding records, times, causes, and remedies         |
| `POST` | `/api/task`                  | Starts a session or a follow-up turn                                                    |
| `POST` | `/api/cancel`                | Cancels the active turn                                                                 |
| `GET`  | `/api/sessions`              | Durable session summaries                                                               |
| `GET`  | `/api/status`                | Session status and artifact roots                                                       |
| `GET`  | `/api/policy`                | What a new session here would run under                                                 |
| `GET`  | `/api/turns/<turnId>/result` | Durable structured result for a completed turn                                          |
| `GET`  | `/api/events`                | Live and replayed chat events over SSE                                                  |
| `GET`  | `/api/runs`                  | Run summaries                                                                           |
| `GET`  | `/api/runs/<runId>/...`      | Run detail, flow, graph, artifacts, and tool outputs                                    |
| `POST` | `/api/index/call`            | One allowlisted pattern-index read                                                      |
| `POST` | `/api/index/feedback`        | Records one up or down vote on a pattern in the index                                   |
| `GET`  | `/live/<sessionId>`          | The live pane for one session; takes `?turn=<turnId>` and `?piecesBase=<url-prefix>`    |

Health returns `ok`, `fabricApiUrl`, and `fabricSession`. The last field is
`unverified`: the console has no inspectable Fabric-session connection state,
and HTTP reachability, configuration, or factory existence says nothing about
whether a retained session can complete an operation. The field does not spend a
provider turn or make a Fabric round trip. A caller needing proven substrate
liveness must perform a separate probe.

`GET /api/health/detail` returns `{version: 1, generatedAt, rows}` for an
operator status panel. Each flat row carries `id`, `group`, `label`, `state`,
`value`, `source`, and `checkedAt`. `source` is always a short human label;
optional `detail` is one opaque string retaining the exact deciding paths,
command, or endpoint for a selectable disclosure. URL credentials, query values,
fragments, and connector references are omitted. Fixed labels use Title Case;
connection names retain their recorded spelling. `reason`, when present,
explains the cause; `remedy` names the operator action that can change it.
Groups are open strings so clients can render new checks without learning new
fields. `generatedAt` timestamps the snapshot; `checkedAt` timestamps each
deciding observation. States are `ok`, `degraded`, `failed`, or `unknown`. Only
an unknown row can have a null timestamp. An unavailable observation stays
unknown rather than claiming a failure.

Configuration rows name the active console address, port, space, store, model,
and skill-script switch. The launcher passes its decision report directly into
the server: connector rows retain every accepted or refused grant, its CFC class
or refusal reason, and the injection receipt and piece declaration that decided
it. Changing those files requires a console restart to establish new grants. A
server flag takes precedence over the inherited launch value and its source. A
directly configured server reports its explicit grants and marks the full
connector inventory unknown. An absent injection receipt is also unknown; an
observed empty receipt establishes an empty inventory.

External rows check the running Docker daemon's `runsc-cfc` registration and the
configured index's health and enrollment for the console identity. Each probe
caches independently for 30 seconds. Reading the route returns the current
snapshot immediately and schedules stale checks in the background, sharing any
in-flight check. No probe is awaited by the route. The timestamp remains visible
while an observation is being refreshed. Model rows describe the startup
provider and credential source without exposing credentials or making a model
request; a configured API key does not prove provider acceptance. Docker
registration does not prove a sandbox can execute a task. Fabric-session
liveness remains unverified, and Loom, toolshed, and application pin status
belong to the application that observes them directly.

A task body carries the text, optionally the session to continue, and optionally
the cells the task is to be computed over, published patterns, and the
originating durable Loom. Optional `loomId` is captured per turn, persisted, and
returned as `originLoomId`; it never changes with later UI focus:

```json
{
  "text": "summarize this trip",
  "sessionId": "…",
  "inputCells": [
    { "name": "itinerary", "ref": "/of:fid1:…/days" }
  ],
  "patternRefs": [
    { "patternId": "…" }
  ]
}
```

An input cell is named per task rather than per session, because a turn is its
own run with its own handle table: the tokens the model is given are the ones
that turn's run minted. What the model receives is a token and the caller's own
name for it — never the reference, and never what the cell holds. The reference
grammar is `--input-cell`'s, so a spelling the CLI refuses is refused here with
a 400 before any turn starts: a `ref` has to be a link naming an entity
(`/of:fid1:…/path`, or `computed:`), not a bare hash. A cell that passes the
grammar and still cannot be minted — one in an unadmitted foreign space, say —
fails the turn rather than starting it without what the caller attached, and
that turn is terminal like any other failed one.

The operator can admit foreign references at startup with
`--fabric-foreign-spaces '{"did:key:zForeign":"https://foreign.example/"}'`. The
value maps explicit space DIDs to HTTP(S) origins. It registers the routes for
the session and governs attachment minting, `describe_handle`, and `run_pattern`
together. `{}` clears an environment default. A task body and a model tool call
cannot change this setting. Reads use the session identity's existing rights and
retain the source CFC labels; handles do not declassify. See
[foreign reference admission](../README.md#running-patterns-against-a-fabric-space).

A `ref` may also name a piece the way a person sees it named, which is what a
caller showing a rendered piece has to work with:

```json
{
  "text": "make the headings readable",
  "inputCells": [
    { "name": "pattern_1", "ref": "pattern:my-space/reading-list" }
  ]
}
```

`pattern:<space>/<slug>`, or the bare `<slug>` meaning a piece in this console's
own space. The session resolves the name to the piece's address before it mints
a handle, so what the handle table holds is the address either way and the model
is told no more than it is told for any other cell. The alternative is every
surface holding a piece deriving fabric ids of its own, which is one copy of the
runtime's addressing rules per client — and a client is exactly where that copy
goes stale.

Which side answers which mistake follows from what each side can know. A slug
the runtime's own rule refuses, an address carrying a path under the piece
rather than the piece, and an address naming a space that is not this console's
are decidable from the text, so the route answers **400** naming which — the
caller cannot see the space this console runs against, so a mismatch is this
side's to explain. Whether the space HOLDS that slug is not a fact about the
text; the turn finds it out and fails naming the slug, under the rule above that
governs every reference which parses and still cannot mint.

The address is scoped to pieces. A pane may show any cell in a space, and the
general case is CT-2319's; a slug names a piece or it names nothing, which is
what lets this resolve with no vocabulary the space does not already have. The
retired `piece:` spelling is not read as an address — one name for one thing.

A pattern reference names a published pattern by the index's own id, which is
the content-addressed identity of its source: it names an entry the index holds
or it names nothing, and the id is the whole of the reference. The turn's run
resolves each one against the index before its first model turn and seeds what
comes back as a `search_patterns` hit, so the model runs it with `run_pattern`'s
`patternId`, composes it through its `cf:pattern:` specifier, or selects it for
a child with `delegate_task`'s `patternRefs`, without searching for it. What the
reference grants is what a search hit grants — compose this source by identifier
— and attaching one asserts nothing about whether the pattern works.

The grammar is the run's, so a value that is not an id is refused with a 400
before any turn starts, as a bad `ref` is; so are more than eight references and
the same id twice. Whether the index holds an id is the run's to find out: an id
it does not hold fails the turn, naming the id, rather than starting it without
what the caller attached. A task attaching patterns needs a console started with
a pattern index (`--pattern-index-url`).

The completed-turn result is:

```json
{
  "outcome": "completed",
  "sessionId": "…",
  "continuable": true,
  "looms": [],
  "pieces": [
    {
      "slug": "reading-list",
      "url": "http://localhost:8000/my-space/reading-list"
    }
  ],
  "spaceName": "my-space",
  "finalText": "Your reading list is ready."
}
```

`outcome` is `completed`, `question`, or `gave-up`. All three are normally ended
turns and return **200**. A question includes `question: { "text": "…" }`; a
give-up includes `reason: "…"`. Each field is present only for its matching
outcome. `finalText` carries the human-readable answer, question, or reason in
every case. An older result without `outcome` means `completed`. When reading
stored artifacts, an unfamiliar nonempty outcome word also means `completed`, so
a pin change or rollback does not hide a finished turn's result. Its `finalText`
remains available. Malformed objects remain invalid; new tool calls and writes
use the closed three-outcome contract.

`sessionId` identifies the conversation on every result. `continuable` says
whether it currently accepts another turn: the session must be idle and
reusable. A reply uses the existing task route with that `sessionId`, so the
question and its tool context remain in the conversation after a restart too.
Clients retain the piece-to-session association for questions and give-ups as
well as completed tasks. A closed or busy session reports `continuable: false`;
this preflight value can change before the next request arrives.

`pieces` is always present, including as `[]` when the run assigned no slug.
`looms` is also always present: it contains verified current-turn composition
receipts, replay flags, and current versions, and is empty when the run composed
none. Optional `originLoomId` is the turn's submitted origin. Enable the tools
with `--loom-authoring-config` or `CF_HARNESS_LOOM_AUTHORING_CONFIG`; the
complete contract is [Durable Loom authoring](../docs/LOOM_AUTHORING.md). Each
entry copies `slug` and `url` from the successful `assign_slug` observation.
When that same held token also appeared in a verified successful composition,
optional `loomComponents: [{loomId, componentId}]` identifies its saved
membership. The correlation uses unique matching current-turn tool calls and
request-order receipt IDs, never the human slug or assistant prose. When using
this metadata, clients suppress duplicate placement only after verifying the
pair in a freshly opened manifest. Weaver also retains a legacy exact-reference
membership check; absent either proof it keeps ordinary placement. Different
tokens for the same Pattern are not inferred equivalent. No cell address or
token is added to the result. `spaceName` identifies this console's configured
space.

The route never holds a request open; it answers with where the turn stands, and
the status code says whether asking again can change the answer:

| Turn                    | Status | Body                                            |
| ----------------------- | ------ | ----------------------------------------------- |
| running, or canceling   | 409    | `{ code: "turn_not_completed" }` — ask again    |
| completed               | 200    | the result above                                |
| completed, no artifacts | 404    | `{ code: "turn_result_unavailable" }`           |
| failed                  | 410    | `{ code: "turn_failed", detail: <chat error> }` |
| canceled                | 410    | `{ code: "turn_canceled", detail: <reason> }`   |
| unknown                 | 404    | `{ code: "turn_not_found" }`                    |

Every body carries an `error` string beside `code`. A poller's whole rule is:
409 keep polling, 200 read the result, anything else stop. 410 is what a turn
that died before its first model turn answers too — a turn is terminal after
every way it can fail, not only after the model has been asked.

The same holds for the run behind the turn. Its `run-state.json` under the
artifact root reads `status: "running"` from the moment the turn takes it,
through every tool call, until the turn ends; `completed`, `failed`, or
`canceled`, with `endedAt` and `terminalReason`, appear once and only when it is
over. A `failed` run carries the failure under `failureRecords` and
`primaryFailure`, and `terminalReason: "setup_error"` names the run that never
reached a model turn. The run's controlling abort signal records
`status: "canceled"`, `terminalReason: "canceled"`, and `cancelReason` in both
state and report. Cancellation adds no failure record. Active delegated children
unwind with the same outcome; children that already completed keep their
outcome. A tool output returned during cancellation remains in the artifacts and
is linked from the canceled tool activity. An unrelated provider `AbortError` is
a failure unless the run's own signal was aborted. Resuming a run clears its
prior terminal status and cancellation reason.

## What you'll see

Type a task — "build me a page that tracks the books I'm reading" — and press
Start. The feed then shows, in the order the harness produces them:

- **`calling <tool>`** as each tool call begins, with its input summary.
- **`<tool> completed` / `failed`** with the result the model read, truncated.
- **assistant text** between tool calls.
- **a nested subagent block** under each `delegate_task` entry, headed by the
  child's profile and the goal it was given, holding the child's own tool and
  assistant lines as they happen and closing with the child's status.
- **the final text** of the turn, in a boxed entry, when it completes.

The `turn_completed` event carries the same `outcome` and its matching question
or reason at the event level, and the structured object under `result`. Its turn
attribution is unchanged. Live streams and replayed durable events have the same
shape, so a caller can open `result.pieces[0].url` without parsing assistant
prose. Pollers read the same object from `GET /api/turns/<turnId>/result`.

The parent calls `finish_task` alone to ask a question or explain why it cannot
proceed. This uses the ordinary tool policy and artifact path, then ends the
turn without another model request. The live pane shows the sentence as "waiting
for your answer" or "stopped", without a failure badge. Child agents report
blockers to their parent; they cannot end the user's task themselves.

When the run names a piece, the `assign_slug` result carries a `slug` and a
`url`, and the page raises an **Open your piece** link above the feed. That link
is the point of the surface: everything above it is the work, and the link is
what the work produced. The same result is durable under
`<artifact-root>/<run-id>/tool-outputs/`; when a run ends without the link
appearing, the Runs view below reads it back.

Cancel stops the running turn. The session survives a cancel and a page reload
both — the stream resumes from the last event the page rendered rather than
replaying the feed.

## The live pane

`GET /live/<sessionId>` is the same work in a column, for a host that can show a
task running beside the thing that asked for it and can only open a plain web
address. It is served from the same build as the console page, and the `Host`
gate covers it; the content security policy that keeps the console page out of a
frame keeps this one out too. It is opened at the top level of a view, never
framed.

`?turn=<turnId>` narrows the pane to one turn. Without it the pane shows the
session's activity in order, however many turns it has taken.

`GET /live/<sessionId>/` — the trailing-slash form — answers `308` to
`../<sessionId>`, query and all. The pane's stylesheet and script are written
relative to `/live/<sessionId>` (see below), so the slashed form would resolve
them one level too deep; the `Location` is relative so it lands under whatever
prefix a host fronts the console at, with no rewriting on the host's side.

Both pages address the console RELATIVE to where they were opened — assets,
`/api` fetches and the event stream all go under the mount `src/mount.ts` reads
off the page's own address — so a host may serve the console under a prefix on
its own origin (loom's daemon fronts it at `/harness-console`, rewriting `Host`
to the loopback address this server insists on). At the console's own root the
mount is empty and every path is what it always was.

`?piecesBase=<url-prefix>` says where the host renders a piece. A piece's own
address is the one `assign_slug` recorded, which is the Fabric API's; a host
that shows pieces somewhere else — a pane of its own, say, where the API's
address answers with a login gate instead of the piece — names its prefix here,
and every piece link on the page is composed as `<piecesBase>/<space>/<slug>`
from the space and slug the turn's result carries, each escaped. With no prefix
named, the recorded URL is used as it stands rather than rebuilt. The prefix has
to be an absolute `http` or `https` URL: it arrives from whatever opened the
page and ends up in an `href`, so anything else — a `javascript:` URL, a
relative path — is refused, the page says so, and the links stay on the recorded
address. The console composes against a prefix it is given and knows nothing
about the host that gave it.

The pane reads the same event stream the console page reads, from sequence zero
— so a pane opened halfway through a turn shows the steps that already happened
rather than only the ones that follow, and a reconnect resumes from the last
event it rendered. What the stream carries is the order and the outcome; what a
call was given, what CFC decided about it, and what it withheld from the model
come from the turn's own run, which the pane re-reads when one of its tool calls
completes. The run id of a console turn is the turn id, so no route composes
that address and no lookup stands between the two.

Each step is one line — the tool, how it ended, and what it was about: the
numbered `run_pattern` attempt and the compiler's word on it, the slug
`assign_slug` registered, the query a search was given, the question legacy
`query_docs` asked, or the Common Fabric task `research` investigated. Under a
line whose run recorded a CFC decision sits the same CFC line the console's
timeline draws, and a result that held anything back from the model carries the
same omission block, openable in place. A completed turn ends the pane with the
piece link the turn produced, which is what the pane is watched for.

## Sessions

The session a page is showing is named in its address, as `?sessionId=<id>`. A
started task puts it there, so the address bar always holds a link back to the
run: open it later, or on another tab, and the page replays that session's whole
event log from the start and draws the same feed the live run drew, nested
subagent blocks and piece link included.

With no session named, the page lists the sessions this server knows — the most
recently touched first, each named by the task it was given — and following one
opens it.

An open session takes another turn: the box sends a follow-up into the session
being shown rather than starting a new one, and the feed continues rather than
clearing. A follow-up carries its own `inputCells`, named per task like any
other turn — so continuing a session and attaching the piece being looked at are
two independent halves of one request, and a caller may send either without the
other. **New session** goes back to an empty page and the list. A session that
cannot take another turn — closed, or left with a transcript that did not
survive a restart — says so in the feed when the follow-up is refused.

### Status route

`GET /api/status` returns the console's absolute `artifactRoot` and a `sessions`
array. Each session status carries its lifecycle, timestamps, model, workspace,
capabilities, policy, and, once a run has started, its own `artifactRoot`. A
`sessionId` query narrows that array to the matching live session. Clients that
need a run's artifacts use the session's root when it is present and the
top-level root as the console-wide fallback.

Status is read directly, with no preceding request. The top-level fields are
present even before the console has any sessions, so an unattended client can
check the route contract before starting a model turn.

### Policy route

`GET /api/policy` returns what a session started here **would** run under, which
is the same question the status route answers only for sessions that already
exist:

| field                     | value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| `systemPromptSha256`      | SHA-256 of the seeded system prompt, or `null` when none is seeded    |
| `allowedToolIds`          | the tools a new session's policy asks for                             |
| `allowedSubagentProfiles` | the subagent profiles it authorizes                                   |
| `artifactRoot`            | where runs are filed                                                  |
| `fabricSpace`             | the space name runs build in                                          |
| `sessionDbPath`           | the durable session store, or `null` when sessions are held in memory |

The prompt crosses as a digest and never as text, so a client can check that
this console holds the prompt it was told to run without the prompt leaving the
process. `allowedToolIds` is what the policy asks for; the prompt loop withholds
a tool again when its backing is absent, so this says a session may reach a tool
rather than that a turn will hold it.

The route carries the space name and the two host paths alongside the digest, so
it says what a session here would run under without a session having been
started.

An unattended client is the caller this route is for: the measurement batch
runner refuses a whole batch when the console it found is not the cell its
`--cell-spec` names, before the first task spends anything. That file's shape is
in
[the measurement protocol](../docs/pattern-index-measurement.md#the-cell-spec).

## CFC

This surface exists partly to show CFC working, so the fabric session's runtime
runs under the `max-enforcement` posture by default rather than opting into it.
That bundle — `MAX_ENFORCEMENT_CFC_OPTIONS` in the runner's presets — sets flow
labels to `persist`, puts the write floor, policy evaluation, declared
monotonicity and label-metadata protection at `enforce`, turns trigger-read
gating on, installs the standard prompt-caveat policy, and gives the
network-fetch sinks public-only confidentiality ceilings. The server prints the
posture it resolved at startup, so what a run ran under is never a guess.

The bundle names no enforcement mode, so the session keeps the core's
`enforce-strict` pin. Each dial has a flag, and the flag wins:

| Flag                            | Environment                              | Default                            |
| ------------------------------- | ---------------------------------------- | ---------------------------------- |
| `--fabric-cfc-posture`          | `CF_HARNESS_FABRIC_CFC_POSTURE`          | `max-enforcement` (`none` to drop) |
| `--fabric-cfc-flow-labels`      | `CF_HARNESS_FABRIC_CFC_FLOW_LABELS`      | the posture's `persist`            |
| `--fabric-cfc-enforcement-mode` | `CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE` | `enforce-strict`                   |

These govern the runtime `run_pattern` deploys patterns into. The harness's own
`cfcEnforcementMode`, which governs tool policy and the sandbox, is a separate
dial and reaches every run's `policy-snapshot.json` either way.

A run ends by reading the space it wrote into for the labels it holds on the
cells the run touched, and records them as the run's `cell-labels.json` in the
same write as its outcome, so `run-state.json` carries them too. That is what a
cell chip draws its `space` row from, and what the head of the map states the
regime of — a space that could not be read is a run whose cells are
unasked-about rather than unlabelled, and a snapshot that could not be written
at all is a failure record on the run, which tells it from a run that held no
cell to ask about. The turn's run and the `delegate_task` children beneath it
each record their own as each of them ends, and the head states what every cell
on the map can be taken to mean, so a family whose runs did not all read the
space is stated as read for none of them: one member's reading cannot speak for
another member's cells. `--space-db` reaches the children as it reaches the
parent.

The read is one hop wide. A pattern's results are their own cells, linked from
the piece that names them, and the derived label sits on the cell — so the
labels of the cells a run's own cells link to are read too, at the path the link
sits at. The walk descends through the objects and arrays of a value to find
those links and stops at each: a linked cell's own links belong to that cell,
not to this one.

It descends a bounded way, and what it does not reach it records rather than
passes over. The bounds sit far above the shape of any document a pattern writes
— sixty-four levels deep, a hundred thousand values wide — and a path below that
depth is recorded unread at the path itself, so the cells beneath it read as
nothing known. A value large enough to exhaust the node budget is a walk that
stopped before enumerating what was left, so it can name no path: it marks the
whole cell's labels partial and warns as it does, because a value that size is a
cycle far more often than it is a document. Either way, a cell the reader did
not finish never reads as a cell with no label.

It reaches one space. A reference or a link naming a space the opened file
cannot be shown to be — another space, or any space at all where the file's own
name proves no DID — is recorded as unread rather than resolved, because the id
it names may also exist here and would answer with the wrong cell's labels. A
reference is recorded unread as a whole cell; a link is recorded unread at the
path it sits at, so the cells beneath it read as nothing known rather than as
cells the space holds no label for. The database is opened read-only, and it is
found by the space the fabric session names; `--space-db` points at the file
instead, for a host whose store is not where the search looks — and a file named
for anything but its space proves no DID, so every spaced reference and link
goes unread against one. A cell the opened file holds no document for is
recorded as unread too, not as unlabeled: the run held a reference to it, so a
store with nothing at it is a store the run did not write into. A file holding
none of a run's cells is said out loud as the wrong store, with the fix beside
it.

## Reading a run

Three columns, each scrolling on its own: the runs there are, the run being
read, and the map of how it went. A turn produces a run, and the run's artifacts
are the record of it, so the same view serves a run that finished an hour ago
and one still going. The live event stream drives the status line and the
re-reads; it is not a second feed. A run records its labels in the write that
ends it, and the event that closes a turn follows that write, so the re-read the
event drives reads the snapshot rather than racing it. A run writes its
artifacts as it goes, so every completed tool call re-reads the list, the open
run and its map. The step the scrubber sits on survives the re-read.

### The runs

The left column lists every run the server has made, each named by the task it
was given, with a `delegate_task` child nested under the run that delegated to
it.

### The map

The right column is the conversation, read top to bottom. A turn opens where a
person spoke; under it are the calls the agent made, each carrying how it turned
out and what CFC decided, with a delegated child's own calls nested beneath the
call that delegated. Clicking a node moves the middle column to that step —
which is how you move around a run — and clicking a node of a child opens that
child's own run.

Cells appear wherever a run touches one:

- **makes** — the call minted it, and its result addressed it.
- **reads** — the call was wired to it, labelled with the argument name that
  carried it.
- **in scope** — it arrived without this call making it: a handle handed to the
  session, or one a child's result carried back.

The map heads with the CFC regime the run ran under and with the blunt counts:
how many calls failed, how many CFC refused, and how many patterns read no cell.
That last one matters — a run whose patterns read nothing built its work from
literals rather than composing it over references, which is the opposite of what
the handle model is for.

A map spans the run **and the `delegate_task` children beneath it**, because
that is where the routing lives: a parent commonly names a cell its child
produced. Cells are keyed by the address they stand for, so a parent's token and
a child's token for one cell are one cell.

### A cell

A cell is drawn one way wherever it appears — in an argument, in a map node, in
the handles a step holds — because two sightings of one cell have to be
recognisable as one cell. The chip carries the name it goes by: the slug a
person gave it, else the handle the model held, else its address. Hovering it
gives the rest — handle, address, the shape the pattern that made it declared,
the labels below, and the step whose result minted it.

A chip holds two label facts, and the card names them apart because they answer
different questions:

- **cfc** — the atoms the sandbox's invocation context recorded on the arguments
  of the call this sighting belongs to. What one call saw crossing into it. The
  count on the chip is this one.
- **space** — the confidentiality and integrity atoms the space stores for the
  cell itself, read from the space the run wrote into, with the labelled paths
  read path by path and the origin of each beside it.

An atom is not a claim that the value was computed from something confidential.
A value's label can be the join of the fields of the object it was reached
through, so a plain input reached through a labelled object carries an atom
having been derived from nothing. What separates the two is the space's own
account of where the value came from, and the chip wears it as a second state: a
**derived** cell — one the space says was computed from what a function read —
is colored apart from a merely labelled one, and its card names the
implementation that produced it under `transformed by`.

A cell whose card says the space holds no label for it is saying what the space
holds, and only a cell read whole says it. A cell whose card says no label was
read for it is saying nothing was read there, which is a different thing: either
the run's labels name the cell nowhere, or the reading covered part of it. Where
it covered part of it, a **reading** row says which part it missed and what a
path with no entry means under it — `read but for` the paths it declined to
follow, each named, with every other path read; or `did not finish`, which names
no path at all, because what it missed it never reached. The chip cannot tell on
its own whether a cell went unnamed because the space was never read. The head
of the map carries that: `cell labels read` with how many of the cells it read
carry one, `cell labels unavailable` with why, or `cell labels not read`. Where
a cell of the run was read only in part it heads `cell labels read in part`
instead, and says how many, because the count beside it is then a floor rather
than a total. Read an empty chip against that head — under a run whose flow
labels are `off`, or one whose space could not be read, an empty chip is a
record of what the run recorded rather than a cell with nothing to hide.

### The run's own panes

- **Timeline** — the run step by step, scrubbed with arrow keys or the slider. A
  tool call and the result answering it are one step. A coloured dot on each
  step in the rail says how it turned out: green for a result the tool called
  `ok`, red for one it called an error, amber for a call CFC denied. A call
  whose result CFC withheld the values of is green: it ran and answered.

  A step leads with what it was given and what it holds, and the payloads come
  after:

  - **handles in scope** — every cell live by that point, the ones the step
    introduced marked.
  - **arguments** — each one read as what it is. A reference is a cell chip and
    leads back to the step that produced it; both spellings resolve alike, since
    `run_pattern` takes a `cfh:a:` token or a whole link and they name one cell.
    A plain value says it is a value.
  - **cfc** — the decision recorded for that call: allowed, denied, or withheld,
    its effect class, and the reason codes behind it. A withheld decision is a
    confidentiality boundary holding back the values of a result the call did
    return, so the count of the positions it held back sits beside it and the
    step itself stays the success its answer states; the dot goes amber only for
    a call that did not run. Which of the three it is comes from the `release`
    record's own reason code wherever a boundary decided, not from the outcome
    word the run persisted beside it — the same field AUD-16 counts — so a run
    recorded before that word existed reads here as what its boundary actually
    decided. A policy event appears beside the decision, which is how a call CFC
    _allowed_ but whose _observation_ it refused reads as the two separate facts
    it is. The flow labels the runtime computed for each input position appear
    here too.
  - **disclosure** — how many bytes the result let across as a plain value, how
    many positions it sealed behind a reference, and the longest run of numbers
    it carried. A long numeric run is called out, in the rail as well: the
    harness seals a string the schema does not pin to an enum or a const, but it
    never seals a number, so an array of them carries whatever its author chose
    to encode.

  Then the call's input and model-facing output as formatted JSON, with long
  lines scrolling inside their block rather than widening the page. Beside the
  output, **withheld from the model** expands to the full artifact positions
  named by `transcript-omissions.json`, each labeled by its omission rule. CFC
  denials render a redaction marker. Scrubbed Fabric identifiers are shown with
  `[fabric-id]` in place of their values when the artifact position is
  available; that fixed marker stands in alone when it is not. A legacy result
  with no omission record says so instead of inferring omissions from the full
  result.

  Superseded `run_pattern` source is an assistant argument rather than a tool
  result, so it is outside the omission record. Where its marker appears, the
  Timeline says **source replaced by a later attempt** and directs the reader to
  the run-pattern-source sidecar named by that marker.

  A `delegate_task` step names the child it started; opening that child in the
  rail reads its own timeline.
- **Patterns** — the pattern-shaped work. Every `run_pattern` attempt in order
  with the source it submitted and, for one the compiler refused, the diagnostic
  — so the compile-error and fix rounds are legible rather than lost. Alongside
  them: what `search_patterns` matched and with what score, what
  `record_feedback` reported, and every address `assign_slug` named.
- **Tool outputs** — the full persisted tool-result artifacts, including fields
  the model-facing rendering omitted.
- **Artifacts** — the run's own records: `run-state.json`, `transcript.json`,
  `transcript-omissions.json`, `run-report.json`, the policy snapshot and trace,
  the capability snapshot, the cell labels read back from the space, and the
  skill registry and activations, whichever the run wrote.

Handle scope is reconstructed rather than recorded. A run keeps one handle
table, its last, so the timeline takes a handle to be in scope from the step its
token first appears in — the order the model met them in, which is the order
that matters for reading a run back.

## The Index view

The header switches between **Runs** — everything above — and **Index**, which
reads the pattern index the server was configured with. The view is named in the
address as `?view=index`, so it is a page to reload into and to link someone at.
It needs `--pattern-index-url`; without one, the route it reads through answers
404 saying the server was started without an index, and the view shows that.

The page holds no key and addresses no host but this server. It posts a function
name to `/api/index/call`, and the server signs the request with the fabric
identity and sends it — so the index sees the operator's own identity, the same
principal a run writes with. Four functions are reachable, all of them reads:
`listPatterns`, `listEvents`, `getPattern` and `searchPatterns`. Anything else —
a publication, a recorded event — is refused by name before the index is
touched, and the request the server sends is composed field by field rather than
forwarded, so nothing extra survives the crossing. `searchPatterns` uses the
shared client's
[successor resolution](../README.md#pattern-generations-in-search); the listing
and exact-ID reads retain their individual generation records. Event badges
count only that generation's own events, split by author DID when the index
supplies `eventAuthors`. Each DID can be copied in full. Counts with no known
author show **author unavailable**; the caller's bounded event stream cannot
attribute the whole index's totals. When the index supplies inherited evidence,
the score separately identifies its inherited portion, predecessor, and
publication cutoff. `getPattern` is called without `includeSource`: this surface
shows metadata, schemas, dependencies and events, and a pattern's source is read
through the CLI.

The route sits under `/api/`, so it is behind the same `Host` gate as the rest.

Voting is the console's one write to the index, and it has a route of its own
rather than a name in that allowlist: `POST /api/index/feedback`, below.

Three panes:

- **Patterns** — everything the index holds, by score. A row carries the pattern
  id, its description and hashtags, badges per event type and known author, the
  weighted score those counts produce, and when it was created; the weights
  themselves are printed beside the heading. Opening a row reads that pattern's
  argument and result schemas, its dependencies, and the events you recorded
  against it. Every identifier is a button that copies the whole of itself.
- **Your events** — your own event stream, newest first, with a box that filters
  on any field. The index answers each signer with their own events and nobody
  else's; the shared counts and their available author breakdowns are in the
  table above. Individual notes stay in the author's own stream.
- **Search** — the query the runtime's `search_patterns` would make, run by
  hand. Tags, free text and a limit compose a request, and the request is shown
  beside the results, because what the pane is for is how the index answers
  rather than what it answered once. Each hit reads `matched/asked` on its text
  terms: matching is disjunctive and ranked, so the ratio is what says how close
  a hit is.

## Voting on a pattern

`POST /api/index/feedback` records one vote on a published pattern. The body is
a pattern id and a verdict and nothing else:

```json
{ "patternId": "ss-2w4nQ8", "verdict": "up" }
```

An `up` is recorded as a `thumbs_up` and a `down` as a `thumbs_down`, through
the same verdict mapping the `record_feedback` tool records through. The index
client adds the author as `did` from its signing identity: the console's DID for
this route, and the run's DID for the harness tool. Neither the browser nor the
model chooses that field. The server returns the author as `recordedBy`:

```json
{
  "patternId": "ss-2w4nQ8",
  "eventType": "thumbs_up",
  "recordedBy": "did:key:z…"
}
```

The console and the runs it launches use the same configured Fabric keyfile.
Their author DIDs therefore match. A DID identifies the key that recorded a
vote; it does not certify that a human chose the verdict. Distinguishing those
actors requires distinct held identities, not a caller-supplied human flag.

The index ranks on these votes, so a pattern that keeps disappointing stops
being offered first and one that keeps working is offered sooner. That is why
this is a route and not a page control: whoever is working with a pattern votes
on it from wherever they are working, and Weaver's command pill is the first
such caller.

The route answers 400 for a body naming no pattern or a verdict that is neither
`up` nor `down`, 503 when this server was started without `--pattern-index-url`,
and the index's own status when the index faulted the call. Nothing is recorded
in any of those cases. Like the read route, it is under `/api/` and behind the
same `Host` gate, and takes one bare request with no cookie and no preceding
one.

### Index service contract for authors

The cloud function implementation is outside this checkout. Its matching
contract is:

- `recordEvent` accepts `{ patternId, eventType, did, note? }`. It verifies
  `did` against the authenticated CF1 signer and rejects a mismatch. It stores
  that authenticated DID on the event. Older clients omitting `did` can be
  attributed from the signer; an unverified body field is never authority.
- `listEvents` retains its caller-scoped stream and existing `did` field.
- `listPatterns` may return `eventAuthors` on each pattern, shaped as
  `{ "thumbs_up": { "did:key:z…": 2 } }`: event type to author DID to count.
  These are counts on that exact generation, excluding inherited evidence, and
  each type's author counts sum to at most its `events` total. This makes author
  counts public alongside the totals, without exposing event notes. Historical
  events with a stored authenticated DID can contribute; events without one stay
  unattributed. Neither the pattern owner nor its source is evidence of who
  voted.

Until the service supplies `eventAuthors`, the inspector shows the aggregate
counts as author unavailable. The client contract and display support do not
establish that a cloud deployment implements them.

## How the configuration reaches the run

This server resolves its flags and environment into a `HarnessSessionConfig` —
the same description the batch CLI resolves argv into — and
`src/session-assembly.ts` turns that into the run. So a capability the CLI can
configure is configurable here under the same name, and the two surfaces cannot
drift apart over what a session is.

The tools a session offers are derived from what it can back rather than listed
here: the default surface plus `run_pattern`, `assign_slug`, and `resolve_piece`
for a fabric session, `search_patterns` and `record_feedback` for an index,
`search_skills` for a registry, and `acquire_skill` for a run holding both. A
tool whose backing is absent is not offered, rather than offered and failing.

Each turn is its own run, so what that run holds is established per turn and
announced in the messages it opens with: the skills registry scanned from the
skills root, the well-known grants of the session's space — which is what lets a
task explore what the space holds — and the input cells the request attached.

## Connector grants

A console launched against a loom instance grants every session it runs the
connector databases that instance has injected, beside the piece registry. That
is what lets a bare task reach the fabric's own mail and bank data without the
caller attaching anything: a request that names no `inputCells` at all still
opens holding them.

A grant is named by its Loom connection, with `#companion_key` appended for a
second store on that connection. All declared CFC classes are separate metadata:
the prompt describes `gmail-work (email)` or `readwise (document)`, and a
companion as `gmail-work / calendar (calendar)`. A store declaring both
`message` and `call` is granted with both classes. Connections sharing a class
remain separately reachable. Two of the instance's records decide that, and the
launcher reads both. `sqlite-injection/handles.json` — the receipt loom's daemon
writes, and what `loom connector handles` prints — says which handles exist and
what each one's reference is, and records no class. `pieces.json` declares each
connector piece's `sqlite_sources`, whose table contract carries the per-column
`ifc` the daemon seeded, and that is where the class is written down. They join
on the piece, connection, and optional companion key Loom names in both.
Repeated receipts for the same connection/store, reference, and class set yield
one grant. Conflicting references or classes for that store are reported and
withheld. Grants carry the class list as `cfcClasses`; persisted grants with a
singular `cfcClass` or a class as their name remain readable.

The session description carries the receipt's account identity, physical row
count, and newest record observation time. Counts come from linked `sources`
rows joined by piece, connection, and companion key. They include metadata and
history across the declared tables, so they are not a count of current events or
query-visible rows. Missing, invalid, or conflicting counts remain unknown; zero
means the count succeeded and found no rows.

Account metadata comes from the source row's `viewer` object: `kind`,
`source_id`, `email`, `label`, and `absent_reason`. An `account` identity
prefers the provider's viewer ID, then its login address, then its display
label; a null email means that account has no email address. The internal
`account_id` is not included in the description. A `none` identity says "no
account" with its reason; only an explicit `unknown` identity says "unknown". A
null or absent viewer says the identity was not recorded in the receipt. When
there is no source row, the launcher reads the handle's `viewer` object. It
reads no connection configuration or authentication file.

Repeated source or handle receipts must agree on each metadata field. A count
disagreement leaves the count unknown; an account disagreement is described as
conflicting receipts, distinct from an unrecorded or explicitly unknown
identity. An observation disagreement reports `conflicting-receipts` rather than
choosing one timestamp. Fields the receipts agree on remain available.

The source row's `newest_observed_at` is when Loom observed the newest record,
not the content's timestamp or the receipt's `written_at`. When no observation
time is available, `newest_observed_at_reason` distinguishes `no-rows` (an empty
store) from an unavailable measurement such as `no-observed-at-column`,
`row-count-unsupported`, `query-failed`, or `not-linked`. Receipts without these
additive fields describe the observation time as unknown. Timestamps require an
ISO8601 date and time with an explicit zone and are displayed in UTC. This
metadata survives launcher serialization, grant minting, and session
restoration.

What a grant does not do is decide anything a reference does not already decide.
It discloses a token and a harness-authored sentence; the address stays
trusted-side, `describe_handle` answers shape from the cell, and reading
anything behind the token means running a pattern over it, where CFC rules as it
does for every other flow.

Three cases the launch printout states rather than resolving silently:

- A handle whose declared contract carries no CFC class is printed as
  `grant <connection>  (none: <reason>)` and is not granted.
- An ambiguous store identity or invalid connection name, companion key, or
  class is reported with the deciding record and a remedy.
- A receipt that does not parse refuses the launch. A console that came up
  holding no grants while its report claimed two is the silent misconfiguration
  this launch path exists to rule out; an absent receipt, by contrast, is simply
  an instance that has injected nothing yet.

`/api/task` answers 400 when a request's `inputCells` name something the console
already grants, naming both the word and the connection behind the grant: the
caller cannot see the grants, so a collision is the console's to explain.
