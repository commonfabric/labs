# Book recommendations

`main.tsx` demonstrates an agent request over linked reading history. The
reader's `finishedBooks` and `favoriteAuthors` inputs are `PerUser` writable
cells, defaulting to empty arrays. Every finished book is a separate cell with
`title` and `author`; the list holds read-only references to those cells.

The request passes the two input cells and a named `book_0`, `book_1`, and so on
for each finished book. These are cell references, not values interpolated into
the task. The tools are `loom_search` and `loom_page_read`. The named book
inputs let a model select held book handles without a separate tool for
traversing the list.

The result has exactly five `picks`, each containing a read-only `book` link and
an inline `why` string. An optional `sources` array contains read-only links to
supporting Loom referents. A referenced Loom row becomes a labeled document
through the harness result writer. The writer also materializes observed rows
that the result does not reference so their labels contribute to inline text;
only referenced rows receive links. After the model submits its result with
`submit_result`, the harness result writer validates the schema and resolves
held handles.

`view.tsx` renders pending and error states, each selected book's live title and
author, and the explanation. It displays available token usage and keeps
reported and estimated costs separate. Missing usage remains unavailable; zero
costs remain visible. Sources are exposed through
`recommendation.result.sources` for inspection.

## Tests

Run the authored state, rendering, reference, and user-scope tests from the
repository root:

```bash
deno task cf test \
  packages/patterns/book-recommendations/main.test.tsx \
  packages/patterns/book-recommendations/scope.test.tsx
```

These tests need no live model. Attach both files with separate `--test` flags
when deploying `main.tsx` with `cf piece new` or `cf piece setsrc`.

The integration test uses the real runner and the `runsc-cfc` sandbox with an
OpenAI-compatible scripted model and a Loom CLI fixture. Its scripted choices
validate the request, handle, link, and label flow; they do not measure
recommendation quality. The fixture selects five held book cells and returns
three referenced Loom sources alongside the picks: two search hits and one page
read. Durable `cf inspect` assertions check the result's reader label and
`LlmDerived` integrity, each original book link and its label, and all three
minted source documents' reader labels.

The integration also runs authored assertions through the same `runTestPattern`
harness that implements `cf test`. Its host supplies the API origin and
preserves the provisioned home pattern and agent queue. The `beforeAssertions`
host callback demands the request and awaits the external runner's terminal
state before assertions read the result. This is a host lifecycle hook; it does
not replace the model, tools, or result writer.

## Run against disposable dev-local

Run these commands from the repository root in a worktree. Docker must have its
`runsc-cfc` runtime registered. The two sidecar paths must match that
registration; the values below are the macOS setup defaults described in the
[cf-harness README](../../cf-harness/README.md). The
[local server guide](../../../docs/development/LOCAL_DEV_SERVERS.md) describes
server startup and the runner's enforcement settings.

```bash
agent_demo_root=$(mktemp -d /tmp/agent-book-demo.XXXXXX)
export AGENT_DEMO_API_URL=http://localhost:8429
agent_demo_memory="$agent_demo_root/memory"
export AGENT_DEMO_STORE="$agent_demo_memory/engine-v3/engine-v3"
export AGENT_DEMO_EVIDENCE_DIR="$agent_demo_root/evidence"
export CF_HARNESS_RUNSC_CFC_RESULT_DIR="$HOME/.local/share/runsc-cfc/cfc-results"
export CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR="$HOME/.local/share/runsc-cfc/cfc-invocations"
mkdir -p "$agent_demo_memory" "$AGENT_DEMO_EVIDENCE_DIR"

MEMORY_DIR="file://$agent_demo_memory/" \
EXPERIMENTAL_SERVER_EXECUTION=false \
EXPERIMENTAL_AGENT_BUILTIN=true \
  ./scripts/start-local-dev.sh --port-offset 429

deno test -A packages/patterns/integration/agent-book-recommendations.test.ts

./scripts/stop-local-dev.sh --port-offset 429
```

Stop the servers after a failed test too. Each invocation needs a fresh evidence
directory: the test creates a new identity key there and refuses to overwrite
one. It starts and stops its runner and scripted model server, records model
requests and run artifacts, and writes `cf inspect` JSON for the result, picks,
book cells, and all three minted sources. The store path must name the SQLite
directory used by this toolshed. Directory mode stores each space beneath
`engine-v3/engine-v3` relative to `MEMORY_DIR`; an API URL alone cannot supply
those files. Without `AGENT_DEMO_API_URL`, this integration test is skipped.

## Enforcement limits

`agentBuiltin` remains off by default. In the harness's default `enforce-strict`
mode, a task in the `context` role can call `submit_result` but cannot call its
retrieval tools. The integration explicitly selects `enforce-explicit` for the
harness so its Loom reads can run. Its fabric clients use `enforce-strict` with
persisted flow labels. These are separate enforcement settings; this test does
not establish that default harness strict mode supports retrieval.

D5 remains in force: the `agent` sink declares a static empty ceiling and the
builtin checks `maxConfidentiality`. Under max enforcement, a reference to a
labeled cell is refused. A per-request sink ceiling is separate follow-up work.

The book fixture declares the reader's `User` confidentiality label on each book
cell. The result writer requires stored source-label metadata and refuses a link
target whose metadata is absent; creating an unlabeled cell is not evidence that
its public metadata is stored.

Loom deviation 10 also remains unchanged: a row without `ifc` inherits the label
of its query. This can under-label a row, including admitting it as public on a
fresh run. The fixture supplies explicit row labels; it does not establish that
unlabeled real Loom rows are safe. See the harness
[implementation profile](../../cf-harness/docs/IMPLEMENTATION_PROFILE.md).
