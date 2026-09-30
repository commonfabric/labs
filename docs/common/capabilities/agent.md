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
  ? "working"
  : recommendation.error
  ? `failed: ${recommendation.error}`
  : recommendation.result?.picks.map((pick) => pick.book).join(", ");
```

- `task` is context for the run, not a command to execute. It is the one
  value the request carries, so the sink gate measures it: interpolating
  labeled data into the text puts that label on the request. Pass the cell
  under `inputs` instead.
- `inputs` are cells, keyed by the names the run sees them under. Each
  reaches the run as a reference, and the run reads through it with the
  tools it has; nothing here is copied into the request.
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
  `packages/runner/src/builtins/agent-schemas.ts`). A name the user's
  registered runner does not offer fails the request with `INVALID_INPUT`
  before it is staged; with no runner registered the request queues.

## Reading the result

- `pending` is `true` from the moment the request is staged until the run
  reaches a terminal state: `completed`, `failed`, `refused`, or `cancelled`.
- `result` is a link to the document the run's harness wrote, present once
  the run has completed. Reading through it resolves that document, and every
  reference in it keeps its own label.
- `error` carries the run's error code when it ended any other way —
  `INVALID_INPUT`, `LIMIT_REACHED`, `PROVIDER_FAILURE`, `RUNNER_LOST`,
  `CANCELLED`, `REFUSED` — or the refusal text when the request never left
  the graph.
- `run` is a link to the run's `AgentRun` record: its `state`, `stateSince`,
  and, once finished, `outcome`, `usage`, `modelTurns`, and `toolCalls`, for
  a pattern that wants to show progress or cost. `host` is the origin of the
  toolshed serving the record's space, for a reader on another host.
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
`packages/patterns/system/agent-run.tsx` does — and the runner ends it
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
