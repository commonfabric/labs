# cf-harness onboarding: attach a console to your dev server

Every command below is literal, and each block carries its own `cd`. Replace
only values in `<angle-brackets>`.

## 1. What this is

- `cf-harness` gives an agent a bounded prompt-and-tool loop.
- The loop works in handles: names for data in a Fabric space, never copies of
  it. A schema decides what crosses back as a value.
- Work happens by writing patterns and running them in the space; a successful
  run leaves a piece a person can open, and a slug makes it addressable.
- CFC policy governs every tool call, and the run's artifacts make it
  inspectable after it ends.
- The console is a local web page over that loop: type a task, watch the run,
  open what it built, and read what it left behind.

[Handles and patterns](README.md#the-model-handles-and-patterns) is the model
underneath all of it. This document is the path from a toolshed you already run
to a session you can browse. The labeled-cell flow is one worked example in
section 7, not a prerequisite for anything before it.

### The three demos

- [CT-2190](https://linear.app/common-tools/issue/CT-2190/demo-the-weaver-pill-cf-harness-session-openable-cfc-governed-piece)
  demonstrates the Weaver pill → harness → openable, CFC-governed piece; section
  7 is its runbook.
- [CT-2189](https://linear.app/common-tools/issue/CT-2189/demo-bills-dashboard-from-gmail-plaid-connectors-cfc-governed-alexs)
  demonstrates the connector-fed bills dashboard over Gmail and Plaid; its
  loom-side gaps are stated on the issue.
- [CT-2091](https://linear.app/common-tools/issue/CT-2091/ct-2066-demo-the-hostile-skill-run-and-the-act-2-taint-renderer)
  demonstrates the skills.sh hostile-skill flow and its CFC-governed
  prompt-injection refusal.

## 2. Prerequisites

Four things are needed to explore. The pattern-index allowlist is a fifth that a
first run does without.

1. **The pinned Deno.** `mise.toml` pins the version; install it with any
   version manager and check the active binary:

   ```sh
   cd <labs>
   deno --version
   ```

   Success is a version matching the pin. For `mise` users: the repo's
   `mise.toml` pins Deno and nothing else, so a fresh checkout or worktree
   resolves it with no `mise trust` step. To skip the shims, put the install on
   `PATH` directly:

   ```sh
   export PATH="$HOME/.local/share/mise/installs/deno/<pinned-version>/bin:$PATH"
   ```

   Every `deno run` and `deno task` in this checkout prints a repeated
   `Warning Ignored build scripts for packages: npm:fuse-native@2.2.6` box on
   stderr. It is noise; the command's output is on stdout.

2. **Docker with the `runsc-cfc` runtime.** Every tool the model runs executes
   in a container under that runtime. On macOS, follow the gVisor
   [Docker Desktop CFC setup guide](https://github.com/commonfabric/gvisor/blob/cfc_v2/g3doc/user_guide/quick_start/docker_desktop_cfc.md);
   it owns installation and registration. Confirm the result:

   ```sh
   docker info --format '{{json .Runtimes}}'
   ```

   Success is a `runsc-cfc` entry whose `runtimeArgs` name both
   `--cfc-result-dir` and `--cfc-invocation-context-dir`. Keep those two paths;
   section 3 needs them. On Docker Desktop they read `/host_mnt/Users/...`; the
   host-side path is the same with `/host_mnt` removed.

3. **An identity keyfile.** One PKCS#8 key signs the Fabric session, the
   pattern-index requests, and the browser login in section 5. To mint one:

   ```sh
   cd <labs>
   deno run -A packages/cli/mod.ts id new > "$HOME/.cf-demo.key"
   chmod 600 "$HOME/.cf-demo.key"
   deno run -A packages/cli/mod.ts id did "$HOME/.cf-demo.key"
   ```

   Success is a printed `did:key:z6Mk…`. Use an existing keyfile instead when
   one already owns the space you intend to work in.

4. **A connected model provider.** For `openai-codex`:

   ```sh
   cd <labs>/packages/cf-harness
   deno task run -- auth login openai-codex
   deno task run -- auth status openai-codex
   deno task run -- config set openai-codex
   ```

   Success is `auth status` reporting the credential as connected. Skip
   `auth login` when it already is. These files live under `CF_HARNESS_HOME`,
   which defaults to `$HOME/.cf-harness`.

5. **The pattern-index allowlist, optionally.** The index is a shared cloud
   service that lets a run find an existing pattern instead of writing one, and
   publishes what a run built. Access is by DID, and getting on the allowlist is
   a manual step an admin performs in the Firebase console, not something you
   can do from here:
   [pattern-index ONBOARDING §2](https://github.com/commonfabric/pattern-index/blob/main/ONBOARDING.md#2-access)
   names the collection and the document to add. The repository is private, so
   the link needs GitHub access.

   What you get without it: leave `CF_HARNESS_PATTERN_INDEX_URL` unset in
   section 3, and the session offers no `search_patterns` or `record_feedback`,
   publishes nothing, and the console's Index view says the server has no index.
   Every other part of a run works. Set the URL before your DID is allowlisted,
   and the run still completes: `search_patterns` returns `status: "error"` with
   a `403` message in the transcript, and the server log reports
   `run_pattern could not publish the pattern it ran to the pattern index: … (403)`.

For the `cf` commands below, either use an installed `cf` or define this
source-checkout equivalent once:

```sh
export LABS_ROOT=<labs>
cf() { (cd "$LABS_ROOT" && deno task cf "$@"); }
```

## 3. Attach a console to your dev server

The console attaches to a toolshed and shell that are already running: Loom,
`scripts/start-local-dev.sh`, or your own arrangement. It needs three facts
about that toolshed. Starting one from scratch is in
[Local Development Servers](../../docs/development/LOCAL_DEV_SERVERS.md); the
same three facts apply to it.

**The API URL.** The toolshed's origin, `http://127.0.0.1:8000` under
`start-local-dev.sh`. Confirm it and note its commit:

```sh
curl -sS <toolshed-api-url>/api/meta | jq '{gitSha, cfc}'
```

**Its store directory.** The console reads the space's labels back from the
toolshed's own SQLite files when a run ends, so it needs the directory the
toolshed serves from. Find it one of three ways:

- The toolshed's startup log has one line
  `Memory: Using directory mode: file:///…/`. The console's `MEMORY_DIR` is that
  URL without `file://`. Under `start-local-dev.sh` that log is
  `packages/toolshed/local-dev-toolshed.log`.
- A toolshed started without `MEMORY_DIR` uses `cache/memory/` under the
  directory it was started in, which for the scripts and the manual recipe is
  `<labs>/packages/toolshed/cache/memory/`.
- For a Loom-launched toolshed, `loom toolshed-store-dir <instance>` prints the
  `file://` URL.

When none of those is at hand, the running toolshed's process environment holds
`MEMORY_DIR` when one was set. A wrong directory is not fatal to the run; it
shows up as `cell-labels.json` saying `space-not-found`, which section 11
covers.

**Its commit, against yours.** The parity check compares the toolshed's `gitSha`
with the checkout the console runs from:

```sh
test "$(curl -sS <toolshed-api-url>/api/meta | jq -r .gitSha)" = \
  "$(git -C <labs> rev-parse HEAD)"
```

No output and exit status `0` is a match. A mismatch is expected when the
toolshed was started from another checkout, which a shared machine or a
colleague's server makes the normal case; it is not something to fix by
restarting a server that is not yours. What it risks is the console's runtime
client and the server disagreeing on a protocol the checkout moved, which
surfaces as a failed turn rather than a wrong result. A toolshed older than your
checkout by a few commits usually runs fine. Restart from your checkout when a
turn fails for a reason that reads like a protocol mismatch, or when you need
the toolshed's CFC posture to match what this checkout documents.

### Start the console

| Variable                                      | Value                                                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `CF_HARNESS_CONSOLE_PORT`                     | Any free local port; the default is `8100`.                                                    |
| `CF_HARNESS_CONSOLE_DIR`                      | Any absolute directory unique to this console. It holds sessions, runs, and the workspace.     |
| `CF_HARNESS_FABRIC_API_URL`                   | The toolshed API URL from above.                                                               |
| `CF_HARNESS_FABRIC_IDENTITY`                  | The absolute path to the keyfile from prerequisite 3.                                          |
| `CF_HARNESS_FABRIC_SPACE`                     | A space name. A new name is fine; a `did:key` is refused.                                      |
| `CF_HARNESS_RUNSC_CFC_RESULT_DIR`             | The host side of `--cfc-result-dir` from prerequisite 2.                                       |
| `CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR` | The host side of `--cfc-invocation-context-dir` from prerequisite 2.                           |
| `MEMORY_DIR`                                  | The toolshed's store directory from above, as a plain path.                                    |
| `CF_HARNESS_PATTERN_INDEX_URL`                | Optional: `https://us-central1-pattern-index.cloudfunctions.net`, once prerequisite 5 is done. |
| `CF_HARNESS_SKILLS_REGISTRY_URL`              | Optional: `https://skills.sh`, which adds a metadata-only `search_skills` tool.                |

```sh
cd <labs>/packages/cf-harness
export CF_HARNESS_CONSOLE_PORT=<free-console-port>
export CF_HARNESS_CONSOLE_DIR=<absolute-unique-console-directory>
export CF_HARNESS_FABRIC_API_URL=<toolshed-api-url>
export CF_HARNESS_FABRIC_IDENTITY=<absolute-path-to-identity-keyfile>
export CF_HARNESS_FABRIC_SPACE=<space-name>
export CF_HARNESS_FABRIC_CFC_POSTURE=max-enforcement
export CF_HARNESS_FABRIC_CFC_FLOW_LABELS=persist
export CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE=enforce-strict
export CF_HARNESS_RUNSC_CFC_RESULT_DIR=<absolute-host-result-directory>
export CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR=<absolute-host-invocation-context-directory>
export MEMORY_DIR=<absolute-toolshed-cache-directory>
deno task console
```

The three CFC exports are the console's defaults, written out so the posture a
run ran under is never a guess. Success is a startup summary naming the space,
the toolshed, `(not configured)` or a URL for the index and skills,
`cfc:
max-enforcement, flow labels persist, enforce-strict`, and the two sidecar
directories; then HTTP `200` here:

```sh
curl -sS http://127.0.0.1:<free-console-port>/api/health | jq
```

The expected body is:

```json
{
  "ok": true,
  "fabricApiUrl": "<toolshed-api-url>",
  "fabricSession": "unverified"
}
```

`unverified` is honest: health makes no Fabric round trip. Never point two
console processes at one `CF_HARNESS_CONSOLE_DIR`; until CT-2156 closes, they
interleave each other's records.

## 4. Use it

### The words

- A **space** is where cells and pieces live, named here by
  `CF_HARNESS_FABRIC_SPACE`.
- A **pattern** is the program the model writes; a **piece** is that pattern
  running in the space, with its own data and UI.
- A **slug** is the name `assign_slug` gives a piece, which makes it a URL.
- A **handle** is a token like `cfh:a:d4nfc` the model holds in place of data.
  It resolves to an address in the space such as `/of:fid1:…/path`, and the
  run's handle table joins the two.
- An **input cell** is a cell you attach to a task, which the model receives as
  a handle and a name you chose, never as its contents.
- A **session** is one conversation with the console; a **turn** is one message
  into it; a **run** is the artifact directory one turn produces. The turn ID
  and the root run ID are the same string, and a `delegate_task` child writes
  its own run beside its parent as `<runId>.subagent.<n>`.
- The **posture** is the CFC configuration the run's patterns deploy into; the
  three dials are printed at startup and recorded on every run.
- A **sidecar** is the process beside the sandbox that records what each tool
  call was allowed to observe; its two directories are the ones from
  prerequisite 2.

### Type a task

Open `http://127.0.0.1:<free-console-port>/` in a browser. The page has one text
box, Start, and two header buttons: **Runs** and **Index**. Type a task that
needs no input cells; that is the simplest first run, and the box's own
placeholder describes it. For example:

```text
Build me a small piece that shows a reading list of three books (title and
author) with a checkbox next to each one I can tick when I finish it. Name
the piece reading-list.
```

Press Start. The address becomes `?sessionId=<id>`, the status reads `working`,
and the feed shows each tool call as it begins and completes, assistant text
between calls, a nested block for each `delegate_task` child, and the final text
in a box when the turn ends. [What you'll see](console/README.md#what-youll-see)
describes each entry.

Two things the first turn does that are not faults:

- The server log prints
  `fabric grants unavailable for this turn: Error: space
  has no default pattern to anchor the piece registry`
  on a space with no default pattern, which a new name always is. The turn
  continues without the grants that let a task explore what the space already
  holds.
- The Runs column fills in at the first completed tool call. Press its
  **Refresh** button to see the root run before that.

When the run names a piece, an **Open your piece** link appears above the feed
and the status reads `done`. Section 5 is what the browser needs before that
link renders. The box then sends follow-up turns into the same session; **New
session** returns to the empty page, which lists every session this console
knows.

### Read the run

The **Runs** view is three columns: every run the console has made, with
children nested under the run that delegated to them; the run being read; and a
map of how it went. The map heads with the CFC regime and the blunt counts:
calls failed, calls CFC refused, patterns that read no cell. Click a node to
move to that step. The run's own panes are **Timeline** (each step with its
handles in scope, arguments, CFC decision, and full input and output),
**Patterns** (every `run_pattern` attempt with the source it submitted and any
compiler diagnostic), **Tool outputs**, and **Artifacts**.
[Reading a run](console/README.md#reading-a-run) is the full description.

The same run is on disk:

```text
<CF_HARNESS_CONSOLE_DIR>/
├── sessions.sqlite            # sessions, turns, and events
└── runs/
    ├── <runId>/               # the turn's root run
    │   ├── run-state.json     # status, lineage, postures, input cells, failures
    │   ├── transcript.json    # what the model saw: handles and denials, never payloads
    │   ├── transcript-omissions.json # rules and full-artifact locations, never withheld values
    │   ├── run-report.json    # model attempts, usage, timeline
    │   ├── policy-snapshot.json
    │   ├── policy-trace.json  # every CFC decision
    │   ├── capabilities.json
    │   ├── skill-registry.json
    │   ├── cell-labels.json   # labels read from the space as the run ended
    │   └── tool-outputs/      # every full tool result, including pattern sources
    └── <runId>.subagent.1/    # a delegate_task child, same layout
```

`transcript.json` is the fastest way to see what the model was working with:
every tool result is a record keyed by `outputId`, and the pattern source the
model wrote is in `tool-outputs/`, not in the transcript. `run-state.json` reads
`status: "running"` until one terminal write turns it `completed`, `failed`, or
`canceled`, and that same write records `cell-labels.json`. Cancellation retains
the controlling signal's reason in `cancelReason` without adding a failure
record.

For a retrospective, use the Timeline. It joins `transcript-omissions.json` to
the full `tool-outputs/*.json` result and places each withheld location beside
what the model saw, labeled by the rule that omitted it. CFC-denied content
stays a redaction marker, and scrubbed Fabric identifiers stay `[fabric-id]`;
the console does not reveal either value. The join is display-only and never
changes resume or replay. A run predating the omission artifact says **no
record** rather than guessing what was withheld.

The **Index** view, at `?view=index`, reads the pattern index through the server
with your identity; with no index configured it says so.
[The Index view](console/README.md#the-index-view) describes its three panes.

## 5. Open the piece

The console's link uses the toolshed origin, which proxies the shell. The shell
needs an identity before any piece renders: on first load it shows
`Preparing secure storage...`, then **Register** and **Login**. Choose Login,
then **Import CLI Key**, and pick the keyfile from prerequisite 3. This is once
per browser profile. The piece then renders at either address:

```text
<toolshed-api-url>/<space-name>/<slug>
<shell-origin>/<space-name>/<slug>
```

From the command line, the same piece resolves by slug:

```sh
export CF_API_URL=<toolshed-api-url>
export CF_IDENTITY=<absolute-path-to-identity-keyfile>
export CF_SPACE=<space-name>
cf cell get /<slug>
export PIECE_ID=$(cf cell get "/<slug>" --select '@' | \
  jq -r '."$link" | sub("^/of:"; "")')
cf piece render --cell "$PIECE_ID"
```

`cf cell get /<slug>` returns the piece's live result. The `--select '@'` form
returns `{"$link":"/of:fid1:…"}`; stripping `/of:` gives the ID that
`cf piece render` accepts, and success there is rendered HTML. Render by ID
because render-by-slug currently crashes (CT-2185).

## 6. Drive it from the web API

For the weaver, a script, or an agent that does not hold a browser. The
[console routes](console/README.md#http-routes) take one request each: they
carry no credential, and ask only that the request names the server's own host.
Reaching this socket is what the network already decided.

### Submit

```sh
export CONSOLE_URL=http://127.0.0.1:<free-console-port>

TASK_RESPONSE=$(curl -sS \
  -H 'Content-Type: application/json' \
  -d '{"text": "Build me a reading list of three books with a checkbox next to each. Name the piece reading-list."}' \
  "$CONSOLE_URL/api/task")
printf '%s\n' "$TASK_RESPONSE" | jq
export SESSION_ID=$(printf '%s' "$TASK_RESPONSE" | jq -r .sessionId)
export TURN_ID=$(printf '%s' "$TASK_RESPONSE" | jq -r .turnId)
```

Success is HTTP `200` with non-empty `sessionId` and `turnId`. Add `sessionId`
to the body to continue a session, and `inputCells` to attach cells; section 7
shows the shape.

### Wait by polling

A script asks once and repeats only while it receives `409`:

```sh
curl -i -sS "$CONSOLE_URL/api/turns/$TURN_ID/result"
```

The whole rule is `409` keep asking, `200` read the result, `410` stop with the
terminal failure. A `404` is either an unknown turn or a completed turn whose
artifacts are unavailable; inspect its `code`. Once it is `200`, keep the body:

```sh
TURN_RESULT=$(curl -sS "$CONSOLE_URL/api/turns/$TURN_ID/result")
printf '%s\n' "$TURN_RESULT" | jq
```

The successful result is:

```json
{
  "pieces": [
    {
      "slug": "reading-list",
      "url": "<toolshed-api-url>/<space-name>/reading-list"
    }
  ],
  "spaceName": "<space-name>",
  "finalText": "Created reading-list."
}
```

`pieces` is always present and may be empty. A caller opens `pieces[0].url`; it
does not parse `finalText` to find a link.

### Wait on the event stream

The stream is what the page reads. It does not close when the turn ends: after
the terminal event it keeps sending `event: ping` every fifteen seconds for as
long as the connection is held, so a caller must disconnect on the terminal
event rather than wait for end of stream.

```sh
curl -N "$CONSOLE_URL/api/events?sessionId=$SESSION_ID"
```

Every chat event is one frame:

```text
event: chat
id: <sequence>
data: {"type":"…","sessionId":"…","turnId":"…","sequence":<n>,"emittedAt":"…","event":{"kind":"…",…}}

event: ping
data: <beat>
```

The terminal kinds are `turn_completed`, whose `event.result` is the same object
the poll returns, and `turn_failed` and `turn_canceled`. Reconnecting with
`&afterSequence=<sequence>` resumes after the last frame read.

## 7. Worked example: a labeled input cell through to the audit

This is the CT-2190 flow: a cell carrying a confidentiality label enters a task
as an input cell, the piece the run builds derives from it, and the store and
the audit show the label followed. Everything here builds on sections 3 to 6.

### Seed the cell

Save this pattern as `finance-data.tsx` in the labs root. It passes the
`account` input through to the `account` result and renders its balance:

```tsx
import { type Default, NAME, pattern, UI } from "commonfabric";

interface Transaction {
  date: Default<string, "">;
  description: Default<string, "">;
  category: Default<string, "">;
  amount: Default<number, 0>;
}

interface FinanceData {
  account: {
    balance: Default<number, 0>;
    transactions: Default<Transaction[], []>;
  };
}

export default pattern<FinanceData, FinanceData>(({ account }) => ({
  [NAME]: "Transaction data",
  [UI]: <div>Balance: {account.balance}</div>,
  account,
}));
```

Deploy it, keep the printed piece ID, and attach the label:

```sh
cd <labs>
export CF_API_URL=<toolshed-api-url>
export CF_IDENTITY=<absolute-path-to-identity-keyfile>
export CF_SPACE=<space-name>

cf piece new --slug transaction-data finance-data.tsx
export INPUT_PIECE_ID=<the-printed-fid1-id>
echo '{"balance":2417.55,"transactions":[{"date":"2026-09-01","description":"Donuts","category":"Food","amount":24.50}]}' | \
  cf cell set --cell "$INPUT_PIECE_ID" --input account
cf piece step --cell "$INPUT_PIECE_ID"
echo '{"confidentiality":["finance"]}' | \
  cf cell set-label --cell "$INPUT_PIECE_ID" account
cf cell get-label --cell "$INPUT_PIECE_ID" account
```

`cf piece new` prints a `fid1:…` piece ID and the `transaction-data` slug;
`cf cell set` writes the sample account into the piece's input; `cf piece step`
makes the pass-through result current. The readback succeeds with:

```json
{
  "version": 1,
  "entries": [{ "path": [], "label": { "confidentiality": ["finance"] } }]
}
```

The input reference is the entity form of that result path. The `/of:` prefix is
required; the `/fid1:…` form printed in some piece hints is not an input-cell
reference.

```sh
export INPUT_CELL_REF="/of:${INPUT_PIECE_ID}/account"
```

### Submit with the cell attached

```sh
TASK_RESPONSE=$(curl -sS \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg ref "$INPUT_CELL_REF" '{
    text: "Make me a budget dashboard from my transaction data — totals by category that update when the data changes.",
    inputCells: [{name: "transactions", ref: $ref}]
  }')" \
  "$CONSOLE_URL/api/task")
export SESSION_ID=$(printf '%s' "$TASK_RESPONSE" | jq -r .sessionId)
export TURN_ID=$(printf '%s' "$TASK_RESPONSE" | jq -r .turnId)
```

Each `inputCells` entry is `{name, ref}`. `ref` must be an entity link such as
`/of:fid1:…/path` (or `computed:`); an invalid form is HTTP `400` before a turn
starts. Wait as in section 6, then resolve the piece as in section 5 to set
`PIECE_ID`.

### Read the labels back

Live from the store:

```sh
cf cell get-label --cell "$INPUT_PIECE_ID" account
cf cell get-label --cell "$PIECE_ID" <derived-result-path>
```

The derived path carries the `finance` atom, with the space's own account of
what it was computed from. The run's `cell-labels.json` holds the same read as
the run ended; when its `status` is `read`, its entries are the terminal
snapshot, and `unavailable` or `no-document` is not evidence that a cell is
unlabeled. In the Runs view the cell chip's **space** row draws from the same
file, and a **derived** cell is colored apart from a merely labeled one.

### Audit

```sh
cd <labs>/packages/cf-harness
deno task cfc-audit "$CF_HARNESS_CONSOLE_DIR/runs/$TURN_ID"
```

The [CFC audit reference](README.md#the-cfc-audit) defines AUD-1 through AUD-9.
Read verdicts literally: `pass` is established; `not-applicable` means complete
evidence showed the subject did not arise; `warn` means weaker assurance; `fail`
is a contradicted requirement; and `inconclusive` means required evidence was
absent. `inconclusive` is never `pass`.

What a console run audits to today, so you can tell your run from the checker:

- **AUD-2 `warn` on the root run**: a root that delegated all its substrate work
  exercised no enforcement itself, and the check says so rather than passing.
  This is the documented reading, not a defect.
- **AUD-9 `warn` on the root run**: `delegate_task` and `assign_slug` run
  host-side and mint no invocation context, and the artifacts do not say whether
  an effect ran host-side or lost the context it minted, so retention is
  unconfirmed rather than met. The two warns are one run read against two
  clauses: AUD-2 against AH-CFC-15, AUD-9 against AH-CFC-16.

So `FAIL 0 WARN 2` over a root and one child is the expected verdict line. A
finding outside that set is about your run. Read AUD-4 and AUD-5 first: a denial
that reached the model with a payload, or a handle used before it was disclosed,
is a real problem.

## 8. Run the CLI path instead

The batch CLI and the console resolve the same session configuration. The CLI
refuses an enforcing run unless both runsc-cfc transports are named:

```sh
cd <labs>/packages/cf-harness
export CF_HARNESS_RUNSC_CFC_RESULT_DIR=<absolute-host-result-directory>
export CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR=<absolute-host-invocation-context-directory>

deno task run -- \
  --output-mode batch \
  --artifact-root <absolute-artifact-root> \
  --workspace <absolute-workspace-directory> \
  --fabric-api-url <toolshed-api-url> \
  --fabric-identity <absolute-path-to-identity-keyfile> \
  --fabric-space <space-name> \
  --fabric-cfc-posture max-enforcement \
  --space-db <absolute-path-to-space-database> \
  --input-cell "transactions=/of:${INPUT_PIECE_ID}/account" \
  --prompt "Make me a budget dashboard from my transaction data — totals by category that update when the data changes."
```

Drop `--input-cell` for a task with no cells. Success is exit status `0` and a
completed operator summary naming the run artifact directory, which has the
layout in section 4. `--space-db` is the exact space database used only by the
terminal label reader; it does not change the Fabric session's target, and every
`delegate_task` child inherits it.
[Running patterns against a Fabric space](README.md#running-patterns-against-a-fabric-space)
defines the three required session flags and the input-cell behavior.

## 9. Experiments and measurement

[Measuring the pattern index loop](docs/pattern-index-measurement.md) is the
protocol for comparable experiments: the fixed task suite, the rule that a
discovery task must not mention the index, the CFC and server-parity readings,
and how label persistence is attributed to the writing session. With a console
running, the executable entry is
`deno task measure-batch
scripts/pattern-index-suite.json --console=<console-url>
--fabric-api-url=<toolshed-api-url>
--out=<absolute-measurement-output-directory>`
from `packages/cf-harness`; success writes `report.md` and `report.json` and
exits zero only when every task completed. The pattern-index repository's
[own onboarding](https://github.com/commonfabric/pattern-index/blob/main/ONBOARDING.md)
owns allowlisting, signed direct calls, corpus behavior, and its repo map.

## 10. What works today and what does not

[Current state](docs/CURRENT_STATE.md) is the maintained capability inventory.
For this path, the batch and interactive loops, input-cell handles, host-side
`run_pattern`, slug assignment, structured web completion, durable artifacts,
pattern-index search and publication, CFC posture records, provider-attempt
records, and the offline audit are usable now.

The boundaries that affect this onboarding are:

- CT-2175: a successful `run_pattern` capture receives its result handle and
  host-computed `pending`/`hasError` flags when their release fit admits them. A
  refused host-only status fit silently omits the flags and keeps the handle.
  `resultSchema` requests computed values beyond those flags. If the ceiling
  refuses those requested values, the call still receives the handle, with
  `value` withheld, a `valueError` that explains why and names the input
  carrying the label, and `policyRefusal` as structured data. Declassification
  by policy — releasing a value under one policy and refusing it under another —
  remains open.
- CT-2187 and CT-2191: the audit's known findings in section 7.
- CT-2155 clause 5: the console's web routes carry no credential. The `Host`
  allowlist is the whole of the request gate, and the network the console is
  reachable on is the boundary.
- CT-2185: `cf piece render --cell /<slug>` crashes; resolve with `cf cell get`
  and render by `fid1:` ID.
- CT-2156: two consoles on one `CF_HARNESS_CONSOLE_DIR` interleave records.

## 11. Troubleshooting

**The event stream never ends.** It is not meant to. `turn_completed`,
`turn_failed`, and `turn_canceled` are the terminal events; after one of them
the server keeps the connection open with `ping` frames. Disconnect on the
terminal event, or poll `/api/turns/<turnId>/result` instead.

**Parity mismatch on a shared toolshed.** The toolshed was started from another
checkout. It is expected, and the run usually completes. Restart from your own
checkout only when a turn fails in a way that reads as a protocol disagreement.

**`403` from the index.** Your DID is not on the pattern-index allowlist.
`search_patterns` returns an error to the model and publication fails in the
server log; the run still completes. Unset `CF_HARNESS_PATTERN_INDEX_URL` to
remove the tool until an admin allowlists you.

**The shell shows Register / Login instead of the piece.** The browser holds no
identity. Login → Import CLI Key with the keyfile from prerequisite 3.

**`space has no default pattern to anchor the piece registry`.** A fresh space
name. The turn continues without well-known grants.

**Healthy console, dead Fabric.** `/api/health` returning HTTP `200` with
`fabricSession: "unverified"` says nothing about Fabric. Probe toolshed
`/api/meta` and perform a real `cf cell get` before spending a model turn.

**Wrong store.** `cell-labels.json` with `unavailableReason:
"space-not-found"`,
or every cell carrying `unreadReason: "no-document"`, usually means the label
reader opened no store or another checkout's store. Give the console the serving
toolshed's plain `MEMORY_DIR`; give a CLI run the exact `--space-db`.
[Reading the labels back](docs/pattern-index-measurement.md#reading-the-labels-back)
defines both forms.

**Provider overload.** Inspect `run-report.json.modelAttempts`. A failed attempt
preserves the provider's `providerError.type`, `code`, and `message`; errors
such as `server_is_overloaded` are provider capacity signals, not a Fabric or
Docker diagnosis.
[Model attempts and transport retry](README.md#model-attempts-and-transport-retry)
defines the bounded retry contract.

**Sandbox refusal under an enforcing mode.** Check the startup banner,
`policy-trace.json`, full `tool-outputs/`, and Docker's registered runtime args.
The harness-side directories must be the host side of runsc-cfc's
`--cfc-result-dir` and `--cfc-invocation-context-dir`; on Docker Desktop the
runtime sees their `/host_mnt/...` projections. A refusal is evidence to read,
not a reason to silently drop to `observe`.

**Concurrent consoles.** Never point two console processes at one
`CF_HARNESS_CONSOLE_DIR`. Give each process an absolute, unique directory.

## 12. Repo map

- [`README.md`](README.md) — complete harness model, CLI surface, runtime tools,
  provider behavior, and CFC audit reference.
- [`console/README.md`](console/README.md) — console configuration, web API,
  SSE, structured result, label snapshot, and the Runs and Index views.
- [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md) — maintained capability and
  limitation inventory.
- [`docs/pattern-index-measurement.md`](docs/pattern-index-measurement.md) —
  comparable experiment protocol and store-reading rules.
- [`src/session-assembly.ts`](src/session-assembly.ts) — the one session
  assembly shared by console and batch CLI.
- [`src/run-state.ts`](src/run-state.ts) — durable `run-state.json` contract.
- [`audit/checks/structural.ts`](audit/checks/structural.ts) — AUD-1 through
  AUD-9 implementations.
- [`../../docs/development/LOCAL_DEV_SERVERS.md`](../../docs/development/LOCAL_DEV_SERVERS.md)
  — toolshed/shell lifecycle and `dev-local` rule.
- [`../../docs/development/CONFIGURATION.md`](../../docs/development/CONFIGURATION.md)
  — environment-variable authority, including toolshed's URL-valued
  `MEMORY_DIR`.
- [pattern-index `ONBOARDING.md`](https://github.com/commonfabric/pattern-index/blob/main/ONBOARDING.md)
  — allowlist, signed API calls, corpus behavior, troubleshooting, and the
  pattern-index repo map.
