# Agent Requests

`agent()` asks an agent runner to do a piece of work — find and read data
through tools, and answer in a shape the pattern declares — as the pattern's
user. It is a reactive node like `generateObject`, never a promise: call it in
the pattern body and read `pending` / `error` / `result` reactively.

The builtin is behind the `agentBuiltin` experimental flag, which is **on by
default**; see
[`EXPERIMENTAL_OPTIONS.md`](../../development/EXPERIMENTAL_OPTIONS.md#agentbuiltin).
With the flag set to `false`, every request settles with `pending: false`
and an `error` naming the flag.

## Calling it

```typescript
// Shown inside a pattern body.
const recommendation = agent<{ picks: { book: string; why: string }[] }>({
  progress: true,
  task: "Which of the finished books would a reader who likes the listed " +
    "authors enjoy? Return up to five.",
  inputs: { finished: booksRead, likes: favoriteAuthors },
  resultSchema: {
    type: "object",
    properties: {
      picks: {
        type: "array",
        items: {
          type: "object",
          properties: { book: { type: "string" }, why: { type: "string" } },
          required: ["book", "why"],
        },
      },
    },
    required: ["picks"],
  },
  tools: ["loom_search", "loom_page_read"],
});

const view = recommendation.pending
  ? recommendation.progress?.message ?? "working"
  : recommendation.error
  ? `failed: ${recommendation.error}`
  : recommendation.result?.picks.map((pick) => pick.book).join(", ");
```

- `task` is context for the run, not a command to execute. It is the one
  value the request carries, so the sink gate measures it: interpolating
  labeled data into the text puts that label on the request. Pass the cell
  under `inputs` instead.
- `inputs` are cells, keyed by the names the run sees them under. Each
  reaches the run as a handle; nothing here is copied into the request. The
  run looks at a handle with `describe_handle`, which reports its shape and
  never its value, and reads one `describe_handle` has described with
  `read_value`. A read is measured against the run's read ceiling before it is
  released, and the label of what was read joins the run's context, so
  everything the model writes afterwards carries it. Every run has those two
  tools, whatever `tools` selects.
- `resultSchema` is the schema the run's structured result is validated
  against before it is written.
- `maxConfidentiality` (optional) bounds what the run may observe. Declared,
  it can only tighten what the deployment allows, and a request whose own
  reads already exceed it is refused before it is staged. Absent, the run's
  ceiling is the deployment's; a deployment whose `agent` sink ceiling is
  `[]` refuses every labeled read in the request, references included, whether
  or not this is declared (see below).
- `tools` (optional) names the tools the run may use, from the list the
  deployment publishes (`AGENT_TOOL_NAMES` in
  `runtime/runner/src/builtins/agent-schemas.ts`); `describe_handle` and
  `read_value` come with every run and need not be named. A name the user's
  registered runner does not offer fails the request with `INVALID_INPUT`
  before it is staged; with no runner registered the request queues.

## Interim progress

Set `progress: true` to give the run a `report_progress` tool and instructions
in that tool's description to report short, user-facing milestones. With the
option absent or false, neither the tool nor its reporting instructions is
provided. Reports are optional: a short run may finish without one.

Read `request.progress?.message` reactively. The latest report contains
`message`, a `sequence` starting at 1 for each execution attempt, and an ISO
`updatedAt` timestamp. Each report replaces the current progress link while
`pending` remains true; `result` still appears only after completion. The latest
report remains available after the run finishes. If a lost runner's run is
reclaimed, progress is cleared and numbering restarts for that attempt. A
different request starts without progress, and opting in changes the request
hash. Explicit false and omission identify the same request.

Progress is a labeled model output. Its document goes through the same writer
as the final result, carrying the run's observed-input labels and the
`LlmDerived` stamp when enforcement is enabled. A pattern's ordinary display
policy governs whether it can render the report. Raw tool output, reasoning,
and child transcripts are not published as progress.

The harness declares the run's observation ceiling as the store policy for
every report. A generic message therefore does not make a report less
confidential, and reports from one harness run share that declared ceiling.
Replacing a progress link does not carry the previous report's label into the
new one: a reader can recover when a later independently labeled report fits
its ceiling. That return-channel property does not make the harness produce
lower-confidentiality reports after observing confidential input.

For a `cf-iframe` guest, pass `request.progress` in `$context` with the resource
kind `readonly`, alongside `pending`, `error`, and `result`. The guest subscribes
to that resource and renders its `message`, with a fallback before the first
report. The [iframe guide's example](../ai/iframe-pattern-guide.md#optional-streams)
shows the wrapper and the user-triggered request.

The runner advertises support in its registration's `progress` field. A request
opting in fails with `INVALID_INPUT` when the registered runner does not
advertise support. Without a registered runner it queues as usual. Pattern
authors do not add `report_progress` to `tools`: the option provides the return
channel independently of the selected task tools.

## Reading the result

- `pending` is `true` from the moment the request is staged until the run
  reaches a terminal state: `completed`, `failed`, `refused`, or `cancelled`.
- `result` is a link to the document the run's harness wrote, present once
  the run has completed. Reading through it resolves that document, and every
  reference in it keeps its own label.
- `error` carries the run's error code when it ended any other way —
  `INVALID_INPUT`, `INVALID_RESULT`, `LIMIT_REACHED`, `PROVIDER_FAILURE`, `RUNNER_LOST`,
  `CANCELLED`, `REFUSED` — or the refusal text when the request never left
  the graph.
- `INVALID_RESULT` means the model loop completed without a structured result
  satisfying `resultSchema`: the result was missing, malformed JSON, or
  schema-invalid. The model returns its result through `submit_result`, which
  must be the only tool call in its model turn; a turn that pairs it with
  another call is refused and the run continues. Model and tool failures use
  `PROVIDER_FAILURE`.
- `run` is a link to the run's `AgentRun` record: its `state`, `stateSince`,
  and, once finished, `outcome`, `usage`, `modelTurns`, and `toolCalls`, for
  a pattern that wants to show progress or cost. Optional `modelResponses`
  records the model ID returned for each direct model response, with `null`
  when the provider omitted it; `actualModels` lists the distinct observed IDs.
  `modelAttributionComplete` is true only when every direct model turn has an
  observed ID. Missing attribution fields mean unknown, including on older
  records. `host` is the origin of the toolshed serving the record's space, for
  a reader on another host.
- `requestHash` identifies the request. The same request in the same user
  instance yields the same record, so a re-run of the node over unchanged
  inputs is a memo hit and creates nothing; a pattern that wants a fresh run
  includes an input that changes.

## Who runs the request

A request becomes an `AgentRun` record in the requesting space, listed in the
requester's home-space agent queue
([`HOME_SPACE.md`](../conventions/HOME_SPACE.md#agent-queue)). The requester's
runner, `cf agent runner`, claims it from there and runs it; with no runner
started, the record stays `queued`. A pattern reads whether one is registered
from `wish({ query: "#agent_queue" })`, whose `agentRunner` is absent until a
runner starts. A request made where the home space holds no queue ends
`refused`.

To stop a run, set `cancelRequestedAt` on its record — the `cancel` stream of
`patterns/system/agent-run/agent-run.tsx` does — and the runner ends it
`cancelled`.

## What the request carries, and what is measured

The request is staged under the `agent` sink and measured at the commit
boundary like any other sink request. What the transaction consumed is the
task text and the pointer label of each input reference — a link position
carries its target's label.

**Present limit.** Under the max-enforcement posture the `agent` sink's
ceiling is `[]`, so a request passing a labeled cell by reference is refused,
as is a task built from labeled data; only a request over unlabeled
references and a plain task fits. Declaring `maxConfidentiality` does not
change that, since it can only tighten. A deployment that declares no ceiling
for the `agent` sink applies no gate to the request. A refused
request settles with `pending: false` and an `error` naming the sink; the
reason's detail is not handed to the pattern.
