# Unify Weaver Ask and CF harness

Status: pending implementation. Complete the four checkpoints below before the
demo feature freeze; keep this plan current as each lands.

## End state

`/ask` and `/cf-harness` become aliases of one implementation and one streaming
results UI. Only their default output expectation differs: `/ask` lets the task
determine the result; `/cf-harness` expects a pattern. Carry that as request
data, not a choice of renderer, queue, continuation, or placement behavior.
Retiring `/cf-harness` later must require no execution or UI migration.

Use Ask's board for multiple queued/running sessions. Each card shows its
request, progress, approvals, and outcome. Questions and “keep going” add turns
to the same session, including after text-only results. Stop targets that card's
turn; dismissal does not cancel it. Results open when selected; developer mode
opens the console transcript.

The agent must list/find/open Looms, read their contents, add pages/panels, and
rearrange them through Weaver commands, preserving origin and explicit-target
rules. Commands need a connected Weaver; independent Fabric work can continue.

```text
/ask or /cf-harness → common request + output expectation → session board
  → shared Weaver driver → CF console session
  → typed callback → Weaver command executor → Loom or local operation
  ← execution outcome + JSON held in the session handle table
  → describe/read selected data → next decision → completion or question
  → inline outcome → optional follow-up in the same session
```

Ordinary Loom chat remains available. This requires no general job framework,
registry rewrite, mandatory Fabric storage for results, or complete CFC
redesign.

## Integration and ownership

Build on [labs #8328](https://github.com/commonfabric/labs/pull/8328)'s callback
work and Weaver main, which includes
[Weaver #830](https://github.com/commonfabric/commonfabric-weaver/pull/830)'s
`HarnessRunner` and `shared/Harness*.swift` organization. Include the
browser-host contracts from
[labs #8348](https://github.com/commonfabric/labs/pull/8348) in the integration
base. The Loom chat callback bridge is not a dependency of this direct console
path. Native Weaver browser attachment remains a separate integration; advertise
browsing only when a functioning host is attached.

One integration owner first lands request/result, held-input, and
output-expectation types, capability advertisement, cross-language wire
fixtures, and session-driver interface. Then the callback server and Weaver
executor can proceed independently against those definitions. Handle
resolution/checkpoint work has one harness owner; Ask cards can proceed against
the driver interface. Merge at each checkpoint and run its joined test before
changing the shared contract again.

Avoid concurrent restructuring of `interactive-chat-service.ts`,
`prompt-loop.ts`, `HarnessRunner.swift`, or Ask's `RootView` bindings. Keep
visual work on card rendering, chat typography, and other pill features
independent. Reconsider
[labs #7216](https://github.com/commonfabric/labs/pull/7216) within the handles
work; it can be superseded rather than becoming a dependency. Integrate
[labs #8058](https://github.com/commonfabric/labs/pull/8058)'s research guidance
with output expectation in checkpoint 3. It supplies task refinement, not the
decision about whether to run opening research. GivenRun is absent after #830;
CT-2489 item 3 requires no work here.

## Sizing

Checkpoint 1 is about two to three agent-days in labs plus about one and a half
in the Weaver. Checkpoint 2 is about three to five, landed as two pull requests:
persistence and read behavior first, then the move into `handles/`, which
touches about 64 importers plus `packages/cli`. Checkpoint 3 is several days.
Checkpoint 4 is multi-day as written.

## Code organization

Paths below are relative to `packages/cf-harness/src/`, unless qualified.
Proposed extraction names are implementation choices; their responsibilities and
single ownership are the constraints.

| Boundary                | Change and removal                                                                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Callback coordinator    | Extract pending requests, settlement, cancellation, and event ordering from `interactive-chat-service.ts`. HTTP and stdio use the same validation and coordinator. Keep `tools/weaver-action.ts` thin. Remove duplicated transport bookkeeping.                                                  |
| Handles                 | One `handles/` module owns identity, lifecycle, description, reading, transfer, and snapshots. Tools and engine code use its public interface; checkpoint 2 defines the moves and deletions.                                                                                                     |
| Session checkpoint      | The interactive service chooses the resumable transcript and combines a handle snapshot with research, CFC, and skill state. SQLite persists that unit; remove separately assembled copies.                                                                                                      |
| Session behavior        | Assemble tool availability, opening-research policy, and shared guidance through `session-assembly.ts` and existing chat policy. Remove instructions that require a pattern just to inspect a handle. Avoid a separate Ask planner or tool router.                                               |
| Weaver execution and UI | Separate target-bound execution/raw results in `ServedCommandExecutor.swift` from human receipts. `HarnessRunner` and `shared/Harness*.swift` supply one driver/reducer behind a common session board. Both command names call it; remove command-specific presentation and automatic placement. |

Extract while implementing the relevant checkpoint, with behavior tests around
the moved responsibility. Do not make a preliminary repository-wide cleanup. The
callback coordinator's scope is decided in checkpoint 1: the browser-host
channel (`console/browser-host.ts`) is a second coordinator on main, and that
checkpoint settles whether one coordinator serves both.

## 1. Prove a typed command round trip

**Question resolved:** can an agent obtain a real command result through Weaver
without scraping a UI acknowledgment?

Define one typed mid-session invocation/result contract, updating labs and
Weaver together. Separate it from final-outcome presentation:
`contracts/client-action.ts` is also used by `finish-task.ts` and
`contracts/task-outcome.ts`. Use one current-protocol check and refuse
mismatched versions before starting work. Callback-only slash-text parsing lives
in the Weaver; delete it there with its descriptions, limits, and old-wire
fixtures. In labs the deletion amounts to replacing the one-line `command.line`
validation with a typed `weaver_action` input schema. Preserve human slash
parsing and final-action decoding used by ordinary Loom chat; those are active
features, not historical callback compatibility.

**The agent talks to Weaver.** Weaver owns command discovery and invocation; it
executes local operations or forwards data operations through its existing
backend adapters. Moving off Loom's `/chat` endpoint does not move Loom's data
or replace the backend implementations of Weaver commands. Today
`ServedCommandExecutor` is bound to one pill submission (`SkillFire`): it posts
the free-text shim body to `/command/<id>` and settles through pill activities.
Only `apple/FabricShared/LoomCommandClient.swift`, used by the connector family,
sends Loom's structured `POST /command {id, args, context}`. The typed adapter
is new code that reuses `LoomCommandClient`'s door, separate from `SkillFire`.
Loom's registry is an internal descriptor source for that adapter, not another
interface the harness must understand or call.

Expose supported Weaver command IDs, descriptions, target scopes, and JSON
schemas through the callback channel, with full descriptions fetched on demand.
Invoke `{command, args, target?}`; Weaver supplies origin, pinned service, and
agent attribution. Discovery must describe what the adapter can execute. Start
with one real query through the full Swift path, deferring action admission to
checkpoint 3 without refactoring the whole registry.

Represent these two facts separately:

- Callback settlement: executed, declined, failed to deliver, or interrupted.
- Command outcome: retain the existing structured response, including `ok`,
  `code`, `error`, `result`, `outputs`, partial completion, and
  `may_have_landed` where present. A received version conflict is an execution
  result, not a broken callback channel.

Retain the complete JSON body and transport status in the executor's result;
derive human receipts from it. Avoid widening `CommandManifest.Reply` one output
field at a time or returning “answered in the pill” as the query's value.

Store result JSON using the existing `document` handle referent. No cell or
second result store is needed. A document referent today admits only
`labelSource` `row` or `query`, which the persisted format validates, and
carries an IFC label. A command result needs a new label source and a stated
label policy; record that CFC decision before implementation. Return outcome
metadata and a handle to the model; keep user receipts separate and avoid
duplicating raw result data in resolved events. Replace the callback's small
text-summary limit with separately bounded JSON and receipt limits. Reject
oversized requests before execution; an oversized response must still report
whether the action happened.

Keep one callback coordinator and one Weaver approval queue. Main already holds
a second callback coordinator, the browser-host channel
(`console/browser-host.ts`), with its own pending map, settlement, withdrawal,
and a per-turn, token-gated stream. Whether typed commands ride the chat event
log, a per-turn channel like the browser host's, or one coordinator serving both
is an open decision for this checkpoint. The coordinator commits request state
before delivering its event and keeps a settlement that arrives during that
delivery, resolved event included, without a reentrant event-queue deadlock; the
extraction preserves that. Extend the Weaver's existing per-run, in-memory
action ledger (`shared/WeaverHarnessRun.swift`, `State.performed`) to retain the
complete bounded result until acknowledged. Labs keeps only settled action IDs,
so the console must accept a duplicate result idempotently. Reconnect resends
that result without executing again; distinguish unexecuted, performed, and
execution-uncertain actions. Durable client restoration is a separate follow-up.
Pending requests become interrupted after console restart; they are not replayed
as commands. Do not promise exactly-once mutation across a lost command
response.

**Gate:** a deterministic Swift-to-console fixture executes a Loom query and
verifies the full JSON referent and command outcome. Extend
`client-actions.test.ts` and Weaver's harness submission fixture for HTTP/stdio
parity, immediate settlement, duplicate events/results, decline, unknown action
IDs, cancellation, console restart, and response loss after a mutation. Verify
the current Swift/TypeScript wire round trip. Keep the tests that resolve an
action from its request-event delivery callback and assert an accepted result
plus exactly one resolved event, and keep fixture waits on explicit
delivery/settlement signals through the extraction.

## 2. Make held results readable across turns

**Question resolved:** can later turns use held values without creating patterns
or losing the authority associated with them?

Consolidate lifecycle and access into `handles/`, with one public interface:
create/restore, hold, describe, read, authorized materialization,
delegate/adopt, and snapshot. One running engine owns its mutable table;
parallel consumers must not overwrite each other's additions. Suggested internal
layout:

| Module                      | Owns                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `index.ts`                  | Public interface used by engine, tools, and result export.                                             |
| `table.ts` / `contracts.ts` | Identity, minting, validation, merge rules, and snapshot shapes moved from the existing table modules. |
| `access.ts`                 | Membership/capability checks, description, path/schema selection, and held-value/Fabric adapters.      |
| `transfer.ts`               | Subagent seeding, adoption, and custody scrubbing moved from `prompt-loop.ts`.                         |

Make `tools/describe-handle.ts` and the new `tools/read-handle.ts` thin
adapters. Move `tools/handle-values.ts` and duplicated kind-specific resolution
behind the module. Remove research-content reading from `describe_handle`; route
callers through `read_handle`, retaining stored research provenance. Update
imports and package exports together, deleting displaced implementations rather
than keeping parallel helpers. The interactive service still owns session
checkpoint policy; the handles module supplies a validated snapshot, not a
second persistence service.

`read_handle` takes a handle, explicit path, and bounded selection/schema.
Support held JSON, research results, and permitted Fabric reads. A selected
string must actually be returned when admitted: `run_pattern`'s
structured-result sanitizer seals unconstrained strings independently of policy
and is unsuitable here.

Document referents have no schema today: preserve known result schemas,
otherwise report absence or admit a bounded shape through the read policy. Reuse
labeled observations and provisional Loom-result labels. `result-writer.ts` must
export held references through this module and derive model influence from
actual observations. Holding/transporting data is not disclosure; describing it
must not silently read it. Preserve source scope/integrity and child/skill
custody, including sealed browser returns, through the shared admission seam.

The first implementation probe must select a nested value from both held JSON
and a Fabric cell, omit siblings, and demonstrate bounded fetching. Use runner
cell/schema/transaction primitives; an output-size cap after an unbounded read
does not satisfy this. Decide path representation and selection limits in that
probe. Define missing versus null, arrays, truncation, denied reads, and cyclic
links explicitly. Do not import the CLI's projection subsystem into cf-harness.

Checkpoint the handle table and acquired-skill records alongside transcript,
research, and CFC state. Restore handles before the engine seeds its startup
handles: `engine.establishInputCells()` and the well-known grants both mint into
the engine's handle table, so restoring a table means an engine option applied
in the constructor, before either runs; preserve salt/tokens but create fresh
run IDs and execution state. Retain merge validation. The interactive service
selects the transcript: final on completion, last resumable batch on
cancellation, eligible failure recovery only. Handles follow that selection;
late callbacks cannot amend canceled checkpoints, and failed persistence
advances neither half. Migrate SQLite, accepting sessions without a table.
Retain skill artifacts or report them unavailable without bypassing
activation/delegation checks.

Exclude the new tools from blanket handle-token-to-address rewriting; consumers
resolve references deliberately. `cf` in bash cannot access an in-process handle
table or inherit its authority and is not the read mechanism. Keep `run_pattern`
for computation and reusable artifacts. Browser/skill consumers use the same
module with their existing destination checks. Compatibility is required for
persisted tables, optional absent tables, tokens, and provenance; it does not
require preserving internal module paths or superseded describe/read behavior.

**Gate:** in `handle-values`, `handle-table`, `describe-handle`,
session-context, SQLite, and subagent-transfer tests, turn two reads the same
JSON/string, research, and permitted cell handles after turn one and after
console restart. Also verify compaction, canceled-turn boundaries, unavailable
sources, unpassed child tokens, skill capability continuity, and labeled/denied
reads. Console restart interrupts an active model turn; this gate promises
durable context for subsequent turns, not resumption of the interrupted
computation. Review all existing handle consumers before declaring the module
complete; the gate includes removal of duplicate resolution and lifecycle logic.

## 3. Collapse both commands into one session experience

**Question resolved:** can both entry points serve general tasks and pattern
creation through the same multi-session interaction?

Reuse `HarnessRunner`, `HarnessConsole`, shared `Harness*`, and
`WeaverHarnessRun` behind `submit(text, expectedOutput, context)`. The Ask card
today is the ordinary Loom chat card on a `weaver-ask:` conversation, and its
follow-ups are chat turns; the card body and follow-up input for console
sessions are built new, not extracted. `WeaverChatWire.Ask.Board` is the pure
value model that can be extracted. Harness already keeps multiple active runs
but publishes only the newest; expose the collection through one board. Queued
Stop removes unsent work; running Stop targets its turn. Sessions may run
concurrently; follow-ups serialize within a session.

Delete separate harness presentation and automatic placement triggers. Routing
`/ask` to the harness before that deletion would drop a live placeholder panel
into every Loom, so the routing switch lands with it or after it. Keep shared
opening/placement primitives for explicit result selection, recording the
piece/session relationship after successful placement. Retain attached-piece
completion updates and closed-session handling. Both aliases use this same path.
Text-only results do not keep a continuable session today: a session is
remembered only with an attached pane or a landed piece, and continuation is
looked up by pane, so keeping one is new work. Continue without a piece; show
`continuable:false` rather than replacing the session. The piece-to-session map
is only a continuation lookup into this driver.

The in-memory board holds request IDs, expectation, pinned
service/configuration, origin, session/turn IDs, cursor, outcome, and callback
ledger. The console owns the durable transcript/context. Keep `RootView` changes
to capture/binding; durable app-board restoration is outside this cutover.

Capture screen context separately from command authority. Expand the single
pattern attachment to the console's `inputCells` array. Add bounded held input
to `/api/task` and the turn contract for panel order, component/reference IDs,
last-touched marker, and screen metadata; give the model its document handle.
Keep page/person references queryable. Ask currently captures neither selected
text nor page contents. Follow-ups retain context unless explicitly replaced;
preserve omitted `inputCells` (reuse) versus `[]` (clear).

### Recovery scope: preserve the baseline, fix the new dependency

Current chat already pins accepted endpoints, remembers pre-accept Stop intent,
and rejects stale-turn cancellation. Its native send uses a client message ID
and Loom's receipt fence, but does not implement full lost-response receipt
reconciliation. Ask's board and the harness's cursors are memory-only. These
distinctions determine this change's requirements:

| Concern                         | Required now and why                                                                                                                                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Callback event delivery         | The harness's permanent result-poll fallback cannot deliver a command request a live agent is awaiting. Recover the event channel or visibly interrupt; terminal polling alone is insufficient. This becomes critical when commands are the agent's normal data path. |
| Stop, targeting, stale events   | Preserve existing chat guarantees for every card. Pin the continuation head read; recheck cancellation/configuration after asynchronous preparation, immediately before effects. Match session/turn IDs and retain Stop intent while submission is in flight.         |
| Start or mutation response lost | Keep the submission identity and show an unconfirmed/uncertain outcome. Never silently retry fresh work, fall back to chat, or repeat a mutation. Full automatic recovery is not required for the cutover.                                                            |
| Callback acknowledgment lost    | Extend the existing in-memory performed-result ledger to typed JSON. Resend the result, not the command. This is necessary for the new round trip; disk journaling is not.                                                                                            |
| Client/backend mismatch         | One explicit current-protocol/required-feature check before execution. An old backend ignoring new fields must not silently run the wrong behavior.                                                                                                                   |

Defer durable app-board restoration, disk-backed callback recovery, and
automatic start reconciliation. Revisit server deduplication/receipt lookup
before adding automatic submission retries. Backend handle/session persistence
in checkpoint 2 remains required for follow-up turns; it does not depend on
those UI features.

Fold the #830 Harness triage into the touched code: fix the head-read pinning,
effect-boundary cancellation, and `HarnessTurnResult.question` round trip now.
The new card summary must fold newlines while retaining full result text. Remove
the obsolete live-panel URL path and encode developer transcript URL components
correctly. Standalone `/patterns`/`/feedback` endpoint resolution, whitespace in
`use <id>`, and Codex setup URL validation are bounded follow-ups unless their
code is touched here; they do not gate the unified session flow.

Now expand the command adapter to the required Loom operations. Use a small
reviewed allowlist to run queries automatically and route actions through
existing approval controls. Loom's registry carries no query/action or read-only
flag (it records `reversible`, `locality`, `tier`, `grant`, `actors`, and
`origins_refused`), so the allowlist is a static reviewed list. 106 verbs refuse
the `session` origin and an omitted actor defaults to `user`, so the adapter
must send an agent actor; how is a question for the CFS side. Add missing
structured query/action forms incrementally. Preserve supplied version
preconditions and Loom's agent/provenance checks; never turn a stale-version
refusal into a newly authorized write automatically. Exclude commands that open
interactive pickers or launch another agent session: calling `/cf-harness`
inside a waiting callback can create a nested wait cycle. Final suggested
actions and callbacks awaiting settlement remain distinct.

Use these candidate implementations to begin hands-on verification:

| Need                        | Existing implementation or bounded addition                                                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List/find/open Looms        | Weaver listing and native open; no new search backend. `/looms-find` is a GET route, not a Loom command, and Loom has no list or find command for looms.                                                                   |
| Inspect layout              | `loom.inspect` returns manifest, component IDs, and version.                                                                                                                                                               |
| Read contents               | Add a structured query resolving a selected component through the page/source reader or a Fabric handle. Manifest inspection is insufficient; `search.run` creates a panel and is not a read query.                        |
| Add pages/panels; rearrange | `page.write` supplies page contents, `loom.add` attaches a component, and `loom.move` rearranges it. Verify the complete create-and-place flow; use `create.note` where its behavior fits. Preserve version preconditions. |

Verify these candidates hands-on in a disposable Loom with Ben once the first
query/action/card flow works, before declaring the unified UX complete. Check
what is read or changed, where it appears, focus, approval/decline, and
follow-up references. Test store refresh and visible state as well as JSON:
creating page data alone does not satisfy “add a page to this Loom.” Evolve
commands and presentation from those observations.

Pass output expectation through existing session assembly. Pattern-building
tasks use the existing opening-research path, including #8058's `refinedTask`
and `missing` guidance. General tasks can answer or run commands promptly, using
that same research path on demand. Stop inferring expected pattern output merely
from the availability of `assign_slug`; keep one tool set and control flow.
Plain completion already fits `finish_task`. Expose effective behavior in the
console policy report and verify both alias defaults. Output expectation guides
the work; it does not force every follow-up to create another pattern.

Delete Ask-only chat submission, preambles, history polling, and `loom_compose`
outcome scraping, plus the separate harness presentation/automatic-placement
orchestration. Preserve ordinary chat and stored history. Update shared Swift
source lists and platform bridges together; no platform should retain a second
alias implementation.

**Gate:** `WeaverHarnessRunTests`, `HarnessPolicyTests`,
`HarnessTaskPolicyTests`, and `apple/PillProbe/harness-submission-fixture.py`
cover both aliases' identical UI and execution, queued cancellation, concurrent
sessions, text-only continuation, questions, and required recovery. Move
applicable Ask cases from `apple/WeaverProbe/ChatProbe.swift` with the model.
Include “summarize the last-touched panel” for a non-Fabric page, and follow-up
after foreground focus changes. Run the supported app builds and a real
card-to-Loom round trip. Mock reducer tests alone do not establish UI or network
integration.

## 4. Establish the demo iteration loop

**Question resolved:** can improvements be measured against the complete product
flow without changing its communication architecture each time?

`packages/cf-harness/scripts/run-measurement-batch.ts` is a single-turn HTTP
client that starts a fresh session per task and has no host seam; the host seams
on main are the browser-host channel and #8328's client-action callbacks. Extend
it and its existing cell-spec/preflight machinery with multi-turn scenarios,
driven by a scripted host stub on the browser-host channel first and the real
Weaver adapter after. Reuse SSE parsing, run artifacts, policy/model snapshots,
and `measure-runs.ts` cost/latency reporting. Add fixture-state and
visible-outcome assertions; tool success and a final paragraph do not prove the
requested change happened. Keep deterministic protocol faults separate from
model task scores.

Run against disposable Loom/Fabric fixtures. Fixtures with known state do not
exist yet (Loom's `acceptance up` clones real data), so building them is part of
this checkpoint. Start each scenario from known state; retain its session for
intentional follow-ups. Cover:

- Find a named Loom, inspect a selected part, and answer without creating a
  piece.
- Open the chosen Loom; add a page and panel, then rearrange them with approval.
- Mix `/ask` and `/cf-harness` submissions on the same board; stop one queued or
  running request without affecting another. Only output expectation differs.
- Say “keep going” after text and after an artifact result; preserve the
  original target when focus changes.
- Recover from stream loss while a callback is pending, Stop, a version
  conflict, and an uncertain mutation outcome without duplicated changes.
- Open an outcome and the developer transcript; verify card dismissal semantics.

Add browser scenarios when Weaver's native host is attached. Pin and record the
model, policy, tool set, service revisions, and fixture state. Retain failed-run
artifacts and classify infrastructure failures separately. Teach the harness
clearer guidance and evolve command coverage against these tasks; do not add a
second evaluation framework or blanket retries to hide failures.

**Freeze gate:** all required protocol/recovery tests pass, every required Loom
operation is demonstrated through the unified UI, and the scenario runner
reproduces both successes and diagnosable failures. Remaining work can be task
success, latency, and UX refinement within these interfaces. Run each
repository's required checks before submitting its implementation changes;
update caller-facing API/tool docs alongside them. Archive this plan only after
all four gates are satisfied.
