# Hosted pattern authoring

How a person asks an agent to change an existing piece or create a new space,
how that coding session runs on the server, and how its result enters the
piece source lifecycle.

This document specifies the product operation and its entry points. The
[piece source lifecycle](piece-source-lifecycle.md) remains the design of
record for retaining source, recording revisions, checking compatibility, and
detaching a directly edited piece. The
[`cf-harness` implementation profile](../../packages/cf-harness/docs/IMPLEMENTATION_PROFILE.md)
describes the agent runtime used by the operation.

## Status

Design, and likely to be superseded before it is built. The
[archived agent requests design](../history/plans/agent-requests-and-work-queue.md)
records a
general way for a pattern, acting for its user, to hand work to a `cf-harness`
run and track it through a per-user queue; revising a piece from a request is
one such run under the harness's existing `pattern-author` profile, and the
harness is now capable of the authoring that this document specified a service
for. The live [agent capability](../common/capabilities/agent.md) describes the
implemented request surface. Whoever picks this up should treat the entry points, the
session state machine, and the publication gate below as requirements to carry
into that design rather than as a second service to build.

Design. Labs contains the agent harness, authoring guidance, source lifecycle,
and source replacement machinery needed by this design. It does not yet expose
a hosted authoring service or the product entry points specified here. Local
`cf piece new` and `cf piece setsrc` now accept repeatable `--test` entries,
package and type-check those tests, and retain them as source roots. FUSE source
writeback preserves the attached roots. Those are foundations for the test
retention contract below, but they do not run the tests or provide the complete
authored-program manifest still required by the piece source lifecycle.

## Last updated

2026-09-18

## Goal

A person can describe an outcome instead of supplying pattern source. The
server hosts one coding session that can read the Labs documentation and use
the `cf` development tools. The session builds and verifies a candidate. A
trusted service publishes the candidate only after the required checks pass.

There are two operations:

1. Change the pattern source of an existing piece while preserving its data.
2. Create a new space whose root is a newly authored pattern.

The browser and command-line interfaces are thin clients of the same service.
They do not contain their own prompting, repair, testing, or publication logic.

## Product entry points

### Request a change from a piece

Every piece context menu has a **Request a change** item. Selecting it opens a
form with:

- the selected piece shown as a fixed target;
- a multiline **What should change?** field;
- a **Start** button.

The item is disabled with an explanation when the service reports that the
piece has no complete retained authored program. It stays visible so the
absence of the operation is not mistaken for a permissions or loading failure.

The piece identity is taken from the menu context. The person does not type or
paste it into the request. This keeps authority over the target outside the
model's text.

The target is the same whole piece that the existing context menu resolves. A
right-click inside nested rendered pieces selects the innermost piece boundary,
not the outer container. A renderer showing a field inside a piece does not
become a piece target. If the renderer disconnects or changes its target before
submission, the menu closes instead of submitting the stale selection. Once a
session starts, its canonical target remains fixed even if that renderer later
changes.

Submitting starts an existing-piece authoring session. The form changes to a
session view that shows the current activity, verification results, final
outcome, and a cancel action. The person can leave the view and return to it
from the same piece menu while a session is active or awaiting attention.

While the view is open, it updates from the session event stream in real time.
It shows the agent's emitted progress summaries, files created or changed,
incremental source diffs, safe tool-activity summaries, and compile, test, and
runtime results. Tool summaries contain the tool name, state, and a bounded
outcome. They exclude raw arguments, raw results, credentials, request text,
source, internal paths, and identifiers. Source diffs use a separate CFC-checked
event visible only to a caller authorized to read the session source. The view
does not expose private model reasoning. Reopening it uses a stable event
sequence cursor to replay and then follow without missing or duplicating an
event.

The first version accepts only source changes compatible with the piece's
current pattern and retained input. An incompatible candidate is not
published. A later design may add an explicit confirmation flow, but an agent
must never approve that warning for the person.

### Create a space from Home

The default Home pattern's Spaces tab has a **Create from a request** section.
It contains:

- an optional **Space name** field;
- a multiline **What should this space do?** field;
- a **Create** button.

This is separate from the existing field that adds or opens a space by name.
Submitting starts a new-space authoring session. Home shows the session's
activity and verification results in the same section.

The service does not add an empty or failed space to Home. It builds and tests
the candidate in an isolated workspace and test space. After successful
publication, the new space is added to Home's spaces list and Home navigates to
it. If the person supplied a display name, the new space uses that name. The
trusted service chooses all durable identifiers.

### Command line

The matching commands are:

```console
cf piece change <piece> --request "Add a compact weekly view"
cf space create --request "A shared meal planner for four people" \
  --name "Meal planner"
```

The ordinary `--identity` and `--api-url` options select the caller and server.
Long requests can be read from standard input by omitting `--request`:

```console
cf piece change <piece> < request.md
cf space create --name "Meal planner" < request.md
```

Supplying both `--request` and non-empty standard input is an error. An empty
request is an error.

By default, the command stays attached to the server event stream and exits
when the session reaches a terminal state. `--detach` returns after the server
accepts the request. Both modes print the authoring session identifier. `--json`
uses the same event and result shapes as the service protocol.

The command line does not start a local agent and does not call `cf piece
setsrc` itself. It submits the same operation as the browser, using the same
server checks and publication path.

## One hosted operation

Clients start the operation with one of these request shapes:

```ts
type AuthoringRequestTarget =
  | {
    kind: "change-piece";
    piece: string;
  }
  | {
    kind: "create-space";
    requestedName?: string;
  };

type StartAuthoringRequest = {
  operationId: string;
  target: AuthoringRequestTarget;
  request: string;
};
```

These are logical protocol fields, not a required wire encoding. The piece
field accepts the same address syntax as the rest of the `cf` command line.
The authenticated server resolves that address to canonical space and piece
identifiers and captures the current source revision. It stores those trusted
bindings in the session. The agent receives an opaque, target-bound publication
capability. It cannot replace the target by printing another piece or space
identifier.

The client creates one stable `operationId` for a submission and reuses it if
the start response is lost. While the session record is retained, submitting
the same operation identifier as the same principal returns that session.
Submitting it with different content is an error. This prevents transport
replay from starting a second agent or creating a second space.

The operation returns a durable session identifier. A session has one of these
states:

- `queued`: accepted but not yet assigned to a harness;
- `working`: the agent can inspect, edit, and run development tools;
- `verifying`: required checks are running;
- `publishing`: the trusted service is committing the verified candidate;
- `succeeded`: publication completed;
- `failed`: the session stopped with a recorded error;
- `cancelled`: the person cancelled it before publication began.

Clients may subscribe to the append-only session event stream and may read the
current snapshot at any time. Reconnecting resumes after the last received
event. Correctness does not depend on polling intervals, retries, or client
uptime.

Only the principal that created a session can read its snapshot, subscribe to
its events, or cancel it. An operational support role may receive separately
defined, audited access. Reads also pass the CFC check for the stored record's
labels. Knowing a session identifier grants no authority.

Only one service implementation owns session creation, harness invocation,
verification, and publication. The menu, Home pattern, and CLI adapt their
local addresses and presentation to that operation.

## Authoring session

Each request gets one persistent `cf-harness` session. The session has:

- a writable candidate workspace;
- the relevant current pattern source, if changing a piece;
- Labs source and documentation mounted read-only;
- the general pattern-development and testing guidance and the current `cf`,
  `pattern-dev`, `pattern-test`, and `pattern-deploy` skills;
- `cf check`, `cf test`, and the other explicitly allowed development tools;
- an isolated runtime target for checks that need a running piece;
- no readable user key, provider credential, or publication credential.

The current `cf`, `pattern-dev`, `pattern-test`, and `pattern-deploy` skills
already tell an agent to run every authored test and attach every test entry to
each source revision. The hosted adapter loads those live resources. It does
not copy their command syntax into a separate prompt that can drift from the
CLI.

The authoring profile has no general outbound network access. Access to a
model provider, local test runtime, browser lease, or approved fetch operation
is a mediated capability with a fixed destination and result policy. The
service sets limits for concurrent sessions, model tokens, tool invocations,
CPU, memory, and disk. Reaching a limit fails the session without publication.
Queued sessions wait for admission; clients do not create retry loops.

The initial instruction states the requested outcome and the acceptance gates.
The agent decides how to inspect, implement, test, and repair its work. The
service does not divide the work into mandatory design, implementation,
critique, repair, or finalization phases. Separate sessions are used only when
access policy requires different information boundaries.

The session can finish successfully only after it has produced:

- the complete authored program needed by the candidate, including its test
  files;
- focused new or updated pattern tests for behavior changed by the request, or
  the recorded explanation and named alternative evidence described below;
- passing `cf check` results;
- passing pattern tests;
- any required runtime or browser smoke evidence;
- a concise summary and the recorded verification results.

Test files are part of the retained authored-program manifest even when the
deployed pattern does not import them. Publication attaches them to the source
revision alongside the runtime source. Source retrieval, history, and revert
therefore preserve the tests with the pattern. The runtime does not execute
the test files as part of the deployed piece; the authoring verification gate
runs them before publication.

Current source packaging represents attached tests as additional source roots.
The complete manifest records those entry paths and directly retains their
files along with every other authored file and the public-subpath map. Hosted
authoring supplies the full root set on every create or update, just as the CLI
requires every `--test` entry on each `piece new` or `piece setsrc`. It never
treats `sourceRoots` or the reachable source closure as a substitute for the
complete manifest. The service does not invoke those CLI commands to publish,
but it uses the same program and source-lifecycle representation beneath them.

An edit starts from the complete retained manifest. The candidate preserves
every existing test file unless the agent deliberately deletes or replaces it
and records that change in the final report. Publication never constructs a
new manifest from the runtime import graph, because doing so would silently
drop tests and other authored files that the deployed export does not import.

When a behavior change cannot usefully be covered by a pattern test, the final
report records why and names the runtime or browser evidence that covers it.
Omitting tests merely because the agent ran out of time or context is not a
successful result.

Browser smoke testing is required when behavior depends on rendering, browser
events, navigation, or a freshly deployed runtime. It is not a ritual for
source-only changes that are completely exercised by pattern tests.

The service records the request, session events, tool results, candidate
artifacts, and final result so a failed or interrupted session can be inspected
without relying on the model's last message.

### Developer-tooling feedback follow-up

The authoring environment should eventually let its agent report compiler
bugs, poor diagnostics, missing `cf` behavior, missing Unix tools,
documentation gaps, sandbox restrictions, browser-tooling gaps, and anything
else it lacks to do good work. This is independent of changing or publishing a
pattern. The separate
[developer-tooling feedback plan](../plans/hosted-pattern-authoring-tooling-feedback.md)
defines the proposed `report_developer_tooling_need` tool and its CFC boundary.

## Publication

The agent never writes directly to the target. It writes a candidate. The
trusted service validates and publishes that candidate.

For an existing piece, publication first verifies the complete candidate
source outside the agent sandbox. It then uses one serializable transaction to:

1. check the caller's current source-update authority;
2. read and check the piece's actual retained input and pattern contract;
3. compare the current source revision with the revision captured when the
   session started;
4. apply one direct-edit source transition;
5. clear the active origin and append a detached source revision whose cause
   identifies the authoring session.

The transaction's read basis includes the retained input, authorization state,
source revision, current pattern, and active origin. A change to any of them
before commit rejects the transaction.

A concurrent source change makes step 3 fail. The service keeps the candidate
and reports that the target changed. It does not merge, rebase, overwrite, or
silently start again.

For a new space, publication:

1. verifies the complete candidate source again outside the agent sandbox;
2. verifies that the candidate exposes the operations and state required of a
   space root;
3. checks the caller's current space-creation authority;
4. atomically initializes the final space, root piece, `defaultPattern`, and
   detached generated-create source revision through the ordinary creation
   path;
5. returns the completed space's canonical address.

The service publishes no final space until it has a verified root. A failed
authoring session therefore leaves no empty product space. Internal staging
data follows the service retention policy. After a Home-started operation
succeeds, Home adds the returned canonical space to its list and navigates to
it. If that Home update fails, the completed space still exists and the session
result still contains its address.

Published source is a snapshot. It does not follow the repository or the
authoring workspace. Later repository edits and later agent edits do not update
the piece. A person can request another change or use the ordinary source
origin controls when they intentionally want following behavior.

## Authorization and contextual flow control

Starting a change requires read and source-update authority for the selected
piece. Creating a space requires the caller's ordinary space-creation
authority. The service checks authority again inside publication's trusted
transaction.

The host, not the model, chooses the identity, target, expected revision, test
space, and publication capability. Instructions found in pattern source,
space data, imported documentation, tool output, or the person's request
cannot change those bindings.

The trusted ingress attaches CFC provenance to the person's request before it
enters model context. The request, source, space data, documentation, and tool
output are observations by the model. The harness records their combined CFC
provenance. Candidate files and model messages are `LlmDerived` from all of
those observations. Before data or source crosses a space boundary, the
service applies the ordinary CFC flow check and fails closed if the destination
is not allowed.

The model cannot read identity keys, provider credentials, server tokens, or
the raw publication capability. Tool calls that need authority are mediated by
the harness. The runner remains authoritative for CFC semantics; the harness
transports labels and enforces the allowed tool surface.

This feature must not be enabled for production publication while relevant
CFC checks are observe-only. A development deployment may exercise the entire
flow without granting a production publication capability.

## Failure and cancellation

A failed compile, test, runtime check, policy check, or publication check leaves
the target unchanged. The failure result includes the failed gate and its
evidence. Agent narration cannot turn a failed gate into success.

Cancellation and the transition to `publishing` are ordered by one atomic state
change. If cancellation wins, the session becomes `cancelled`, further tool use
is revoked, and publication cannot start. If publication wins, cancellation
returns `too_late` and the session does not report itself as cancelled. A
completed commit is not undone. The ordinary source history provides the
explicit revert operation for an existing piece.

Provider interruption or server restart preserves the session record and
workspace. Resume continues the same harness session when its access labels and
credentials still permit it. It does not create a second session that lacks
the first session's observed-information record.

Workspace files, request text, transcripts, tool payloads, model responses,
and the harness run-state handle table are retained while a session can
resume. After a terminal result they are
deleted at the end of a configured finite retention window. The creating
principal can request earlier deletion, subject to the ordinary audit policy.
A minimal result record may remain, but it contains no request text, source,
transcript, or tool payload. Production start is disabled until a default
window and storage collection mechanism are configured. The shared
[retention and execution provenance plan](../plans/retention-and-provenance.md)
owns the unresolved default duration and CFC review.

## Relationship to the cf-harness fabric tooling

`cf-harness` carries fabric-facing tooling of its own: a host-side fabric
session, a `run_pattern` tool, session-scoped handles for fabric addresses,
and LLM-friendly address intake in the CLI. These components overlap with
parts of this specification. This section records where a component satisfies
a requirement here, where it must not be mistaken for one, and what it adds to
the retention and identifier obligations above.

- **The fabric session is an available isolated runtime target.** The harness
  fabric session (`packages/cf-harness/src/fabric-session.ts`) constructs an
  authorization-verified `PiecesController` on the host side, so no fabric
  credential exists inside the sandbox. The isolated-runtime-target
  requirement in the authoring session stands as written; this component
  satisfies its credential-absence prerequisite by construction.

- **`run_pattern` is not this specification's verification gate.** The harness
  `run_pattern` tool is an exploration and smoke capability. It takes
  single-string, test-less pattern source, and its companion `assign_slug`
  joins a piece to the space's piece list under a caller-chosen slug.
  Publication here requires `cf check`, retained test files in the
  authored-program manifest, and trusted publication. A pattern that ran under
  `run_pattern` has passed none of those gates, and a piece `assign_slug`
  registered is a named address rather than a verified one.

- **Spaces may contain pieces the piece list does not name.** Harness-created
  pieces are durable whether or not `assign_slug` registered them, an
  unregistered one never joins the piece list, and every one of their
  source-history revisions is a storage-retention root. Root validation,
  retention, and space-clone reasoning over "the pieces in a space" must not
  assume the piece list is exhaustive.

- **Handles redact at the model boundary; the progress surface is separate.**
  Session handles (`cfh:` tokens,
  `packages/cf-harness/src/handle-table.ts`) replace fabric identifiers at the
  model boundary. This specification's exclusion of identifiers from progress
  events is a separate, person-facing projection and remains required. The
  identifier scrubber for compile diagnostics — bare tagged hashes, DIDs,
  `data:` URIs — covers the identifier class that handles cannot reach. What a
  handle does disclose is shape: `describe_handle` answers with the referent's
  declared schema reduced to structure, so property names cross and values,
  prose, and definition names do not. That is a model-facing channel, not a
  progress-event one, and it discloses no piece content.

- **The handle table is retained session state.** The retention window
  enumerated under failure and cancellation includes the harness run-state
  handle table alongside transcripts and tool payloads, because it is a
  durable address-to-token map of every fabric address a run touched.

- **Address intake.** The CLI's LLM-friendly reference normalization
  (`packages/cli/lib/llm-friendly-ref.ts`) provides the client-side shape for
  this specification's piece-address syntax. The authenticated server remains
  the resolution authority.

## Relationship to nearby systems

Pattern Factory is useful prior art and can remain an experimental client of
the harness. Its phase ordering, separate repair passes, and finalization pass
are not part of this product contract. The required boundary is simpler: an
autonomous session produces a candidate, deterministic gates verify it, and a
trusted service publishes it.

Server-primary pattern execution is complementary. It determines where
deployed patterns run. Hosted pattern authoring determines where a coding
agent works before deployment. One does not depend on the other.

The background piece service and the runtime `wish()` builtin do not author
pattern source. `wish()` discovers existing pieces. Neither is reused as the
authoring scheduler.

## Acceptance criteria

The feature is complete when automated tests prove all of the following:

- **Request a change** starts a session bound to the selected piece.
- A compatible candidate passes verification, replaces that piece once,
  detaches it from any origin, and appends a restorable source revision.
- Every generated-create or direct-edit source revision retains all applicable
  tests, including unchanged tests and files outside the runtime import graph.
  Deliberate removal is recorded in the final report.
- A stale revision, incompatible candidate, failed gate, denied flow, or
  cancelled session leaves the piece unchanged.
- **Create from a request** produces a new root pattern, creates one visible
  space, adds it to Home, and navigates to it.
- A failed new-space session adds no visible space to Home.
- Replaying a start request with the same operation identifier starts no second
  agent and creates no second space.
- `cf piece change` and `cf space create` submit the same request shapes and
  receive the same event and result shapes as their browser counterparts.
- The piece and Home session views show durable authoring progress as it
  arrives without exposing private model reasoning.
- A request or observed source that names another target cannot redirect
  publication.
- The model cannot read caller or provider credentials.
- The agent has no unmediated outbound network path and cannot exceed its
  configured resource limits.
- A cancel that wins the publication race leaves the target unchanged; a
  losing cancel reports `too_late` rather than `cancelled`.
- A server restart can resume a nonterminal session without losing its event
  history or observed-information record.

## Deliberately deferred

The first version does not include multiple cooperating agents, mandatory
authoring phases, automatic merging after a concurrent edit, automatic
repository tracking, scheduled self-improvement, or model-approved schema
incompatibility. These can be proposed separately if evidence from the single
session flow shows they are needed.

The developer-tooling feedback follow-up improves the environment without
changing the authoring or publication steel thread. Its separate plan is linked
above.
