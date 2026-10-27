# Sending a message to a local job

Status: design, not built. Nothing here is implemented yet.

A local job today is one task, run once: the caller enqueues it, watches its
events, and reads its result. This plan adds a single generic way to send
that job a new message:

- **To a running job, the message is a steer.** It joins the running
  conversation at the job's next turn boundary, and the job's result is
  whatever the model submits after reading it.
- **To a finished job, the message is a follow-up.** It starts a new job that
  carries the finished job's conversation, with the message as its next user
  turn.

The runner stays generic. A message is text from the job's own caller, with
nothing in it the runner interprets. Loom uses it in two ways, both outside
this plan. Steering a pill job sends the edit of the want's words as a
message. Moving chat onto the runner makes each chat message a message to the
chat's job.

## The model in one paragraph

A conversation is a chain of jobs. Each job is one harness run, with one
result, one set of receipts and one terminal state, exactly as now. A steer
adds a user message inside the running job's run. A follow-up is a new job,
linked to the job it follows by `continues`, whose run starts from that job's
last checkpoint. A finished job is never reopened, so the store's rule that
no write moves a job out of a terminal state still holds, and so does the
event stream's rule that a job's terminal event is its last.

## 1. The contract

### The route

```http
POST /jobs/<id>/messages
{"caller": "cfs:weaver", "idempotencyKey": "chat-msg-81", "message": "Use the April numbers instead."}
```

- `caller` must be the caller that enqueued the job.
- `idempotencyKey` is the caller's request id. It shares one namespace per
  caller with the key of `POST /jobs`, because a follow-up's new job is
  stored under it (below).
- `message` is a nonempty string. The request body is bounded at 1 MiB, the
  same as an enqueue.
- `instructions` is optional, and only a follow-up accepts it. It replaces
  the follow-up's system prompt framing, the request's `instructions`, for
  that job and the jobs that follow it. A steer refuses it, because a run's
  system prompt cannot change mid-run. The caller owns the content: the
  runner passes it through and reads nothing in it. Loom's chat uses it to
  give each message the eligible wants recomputed for it.
- The request names no profile, tools, schema or limits. A follow-up runs
  under the request of the job it follows, so a message can never widen what
  a conversation may do. Replacing `instructions` grants nothing either:
  they reach the model as the system prompt, and the profile is still the
  authority.

### Where the message lands

The message is addressed to job `<id>`, but it lands on the newest job of
`<id>`'s conversation, the *head*. The runner reaches the head by following
`continuedBy` links from `<id>` until a job has none. Because every message
lands on the head, a conversation never forks, and a caller that holds any
job id of a chat can keep talking to it.

What happens next depends on the head's state:

| Head state | What the message becomes |
|---|---|
| `queued` or `running`, no cancel requested | A **steer**, delivered before the head's next model call. |
| `running`, cancel requested | A **follow-up**, started when the head ends `cancelled`. |
| `completed`, `failed` or `cancelled`, with a recorded run | A **follow-up**, started now. |
| `interrupted`, or `failed` with no recorded run | Refused as `not_continuable`. |

A job "has a recorded run" when the harness wrote a run state the job can be
continued from. A job that failed `PROFILE_UNAVAILABLE` never started a run.
An `interrupted` job is refused because a stop or crash cut its turn off
partway. Its last checkpoint may predate commands that already ran, and a
follow-up from it could run them again. That is the same reason the store
never reruns an interrupted job.

### The answer

`201` on first acceptance, `200` for a replay of the same request:

```json
{
  "message": {"key": "chat-msg-81", "mode": "steer", "jobId": "job-…", "acceptedAt": "…"},
  "job": {"id": "job-…", "state": "running", "…": "…"}
}
```

`mode` is `steer` or `follow-up`. `job` is the job that takes the message:
for a steer, that is the head itself; for a follow-up, it is the new job.
For a follow-up held back by a pending cancel, `job` is the head, and the new
job's id arrives on the head's event stream (below).

### Events on the existing stream

A steer appends `message` events to the job that takes it, in the job's
usual `seq` order:

- `{key, delivery: "pending"}` when the steer is accepted.
- `{key, delivery: "delivered", turn}` when the run takes it, with the model
  turn it joins.
- `{key, delivery: "follow-up", jobId}` when the run ended before taking it.
  The runner then starts a follow-up with it, described under "Ordering".
- `{key, delivery: "dropped", reason: "cancelled"}` when a cancel arrived
  after the steer and before the run took it.

When a run ends with steers still pending, the store writes their
`follow-up` events, the new job and the terminal `state` event in one
transaction, with the terminal event last. A reader that follows the stream
to its end therefore always learns where its message went.

A follow-up of a job that had already finished appends nothing to that job:
its stream has already ended. The new job's own stream starts with `queued`,
as every job's does.

### The job view

`GET /jobs/<id>` gains three fields:

- `continues`: the job this one follows, when it is a follow-up.
- `continuedBy`: the follow-up that followed this one, once there is one.
- `messages`: the steers this job took or was sent, in order, each as
  `{key, message, acceptedAt, delivery, turn?, jobId?}`.

A follow-up's `request` is the request of the job it follows, with `task`
replaced by the message, and `instructions` replaced when the message
carries them. Its `idempotencyKey` is the message's key.

### Replay

The store keeps `(caller, idempotencyKey)` unique across jobs and messages:

- **Same key, same target, same message and instructions:** the original answer, `200`,
  nothing new written. This holds whatever the job has done since. A steer
  replayed after it was delivered still answers `mode: "steer"`, and the
  current `delivery` is in the job view.
- **Same key, another message or target:** `409 idempotency_conflict`.
- **A key already used by `POST /jobs`:** `409 idempotency_conflict`.

### Refusals

Every refusal is `{ok: false, code, error}`, as elsewhere on the socket.

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | The body is not JSON, a field is missing or the wrong type, or `message` is empty. |
| 413 | `too_large` | The body runs past 1 MiB. |
| 404 | `not_found` | No job has `<id>`. |
| 403 | `not_callers` | `caller` is not the caller that enqueued the conversation. |
| 409 | `not_continuable` | The head is `interrupted`, or it failed before any run was recorded. |
| 409 | `cannot_steer` | The head is running, and its run has no way to take a message. |
| 409 | `instructions_on_steer` | The message carries `instructions`, and the head would take it as a steer. |
| 400 | `unknown_profile` | A follow-up's profile is no longer one the host names. |
| 409 | `idempotency_conflict` | See "Replay". |

`not_callers` is not a security boundary: the socket and its token are the
authority, as for every other route. It keeps one client from steering
another client's conversation by mistake.

`cannot_steer` exists for a run that cannot drain messages, for example a
lane given a `runJob` that does not take the seam. Every job that runs
through `runHarnessJob` will be able to take messages once stage 1 lands.

### Ordering

- The store accepts messages to one conversation one at a time, in its
  immediate write transaction. Acceptance order is the conversation's order.
- At a turn boundary, the run takes every steer pending at that moment and
  appends each as its own user message, in acceptance order.
- When a run ends with steers still pending, the first one becomes the
  follow-up's `task`. The rest become pending steers on the follow-up, which
  takes them before its first model call. The model therefore reads them in
  acceptance order, before it answers anything.
- A message sent while a follow-up is still `queued` is a steer on that
  follow-up, so it also arrives before the first model call.
- A cancel drops the steers accepted before it. A message accepted after a
  cancel request waits for the job to end, then starts its follow-up. The
  caller cancelled the earlier work, and the later message is a new request.

## 2. What "running" and "finished" mean

The states stay the ones the store has now. For messages, `queued` and
`running` count as running, and `completed`, `failed` and `cancelled` count
as finished. `interrupted` counts as finished and cannot be continued.

**A steered job's result.** It is the last result the model submitted. When a
steer arrives after the model has already called `submit_result`, the run
does not stop: the model reads the steer and may submit again, which replaces
the result. If it does not submit again, the earlier result stands. A steered
job's `commands` hold every command of the run, and its `report` covers the
whole run. Steers spend model turns from the job's own `maxModelTurns`.

**A follow-up's result.** A follow-up is a job in full. Its result is
validated against the schema of the job it follows, and its `commands` and
`report` are its own. The job it follows is untouched. A conversation's
current answer is its head's result. A follow-up gets a fresh turn budget from
its profile.

**What a follow-up carries.**

- the resumable transcript of the job it follows, meaning every message
  except the harness's turn-local notices;
- that job's handle table, so the handles the model holds still resolve;
- its structured-result configuration;
- its CFC record;
- its workspace. A conversation has one workspace, its first job's, so files
  the model wrote stay where it left them. Only the head of a conversation
  runs, so no two runs write that workspace at once.

Its artifacts are its own, under its own job id.

## 3. How cf-harness takes a message

Today, batch mode takes no input once a run starts. `--resume-run` re-enters
the same run, under the same run id, and refuses a new prompt. The
interactive chat service runs each turn as a new run and refuses a second
turn while one runs, so it has no steer either. Two harness changes are
needed.

**The steer seam.** `CfHarnessPromptLoop` takes one new optional option,
`takeMessages: () => readonly string[]`.

- The loop calls it at the top of each model turn, before the model request.
  That point follows the previous turn's tool results and checkpoint, and on
  the first turn it follows the prompt.
- The loop appends each message verbatim as a user message and persists it.
  The harness adds no framing; any framing is the caller's, and so are the
  evals of what it tells the model. These are ordinary transcript messages,
  not turn-local notices, so they stay in the resumable history.
- The loop also calls it before each of its two exits: a final text answer,
  and an accepted `submit_result` under `stopOnStructuredResult`. If either
  call returns anything, the loop takes another turn instead of ending.
- Once the loop has ended, it never calls `takeMessages` again. A message is
  therefore delivered exactly when the loop takes it, and the lane marks it
  `delivered` at that point.
- Only the root loop takes messages. A delegated child loop does not.

`harness-job.ts` already wraps `createPromptLoop`, so the lane passes the
seam in through `HarnessJobOptions`, with no CLI flag.

**Continuing a recorded run.** This is a new run started from another run's
checkpoint. It uses the chat service's per-turn shape, driven from batch mode
by a new flag, `--continue-run <run root> --prompt=<message>`:

- a new run id, with lineage naming the run it continues;
- a fresh engine and sandbox;
- the seeded history: the prior run's resumable transcript, then the new
  prompt. A `--system-prompt` given with `--continue-run` replaces the prior
  transcript's system message, which is how a follow-up's new
  `instructions` arrive;
- the prior handle table, structured-result configuration and CFC record,
  passed on explicitly (`AH-REF-3`);
- the provider, model, credential owner and read ceiling checked against the
  prior run's, refusing anything broader (`AH-ART-4`, `AH-ART-5`,
  `AH-INT-4`). The checks are the ones `--resume-run` already makes;
- refusal of a subagent run, as `--resume-run` refuses one now.

Each run still reaches exactly one terminal state (`AH-LIFE-1`). This is why
a follow-up is a new run and does not re-enter the old one.

`harness-job.ts` today wraps only `runPrompt`. It will wrap `runTranscript`
the same way, so the job's abort signal, events and usage reach a continued
run too.

**Authority.** A steer and a follow-up's message bind at the profile's
`taskRole`, the same role as the job's task. They come from the same caller
under the same profile, and the request cannot set the role.

Under `docs/development/cfc-spec-correspondence.md`, the steer seam is a host
arrangement. Batch mode binds one prompt slot per run, naming its role and
its subject (the workspace or resumed run), and digests no prompt text. The
interactive chat service already binds every later user turn of a session
under that session's one binding. A steer is one more user message from the
same driver under the run's existing binding, and the seam changes no CFC
enforcement source. A steer reaches the model by the same path as the task
prompt, so whatever records the prompt as model context records the steer
too.

## 4. The surface CFS calls

There is one route, `POST /jobs/<id>/messages`, on the existing private
socket, with the body, answers and events above. Nothing in it is about
wants or chat.

Loom's adapter, `src/lib/agent_jobs.py`, would gain a `message` action
beside `start` and `cancel`, and would read `continues`, `continuedBy` and
`messages` from the job view. When an answer says `mode: "follow-up"`, the
adapter follows the returned job. That adapter work is track D's.

How the two loom uses fit:

- **Steering a pill job.** The wants layer edits the want's words, then sends
  the edit as a message to the pill's job. If the job is still running, it
  takes the edit at its next turn. If it has finished, the follow-up revises
  the work it already did, with that work in context.
- **Chat on the runner.** The chat's first message is `POST /jobs`. Every
  later message is `POST /jobs/<any job of the chat>/messages`, keyed by the
  chat message's id. A message typed while a reply is still running steers
  that reply. Otherwise it starts the next turn.

## 5. Tests

Each stage's tests are written first and fail before its change. They bind
to the route, the events and the job view, not to the store's tables.

**Stage 1: the steer seam,** in `packages/cf-harness`, with a scripted model
client:

- A message taken at a boundary is in the next model request, after the
  previous turn's tool results.
- A message pending before the first turn is in the first request, after the
  prompt.
- A message pending when the model submits a result keeps the loop running.
  The model sees the message, and its second submission is the result.
- Nothing is taken after the loop ends.
- A child loop takes nothing.

**Stage 2: `--continue-run`,** in `packages/cf-harness`:

- The new run has a new id, and its lineage names the prior run.
- Its first model request holds the prior resumable transcript, then the new
  prompt, and no turn-local notices.
- A handle from the prior run resolves.
- A new structured result is written and validated.
- A `--system-prompt` given with it replaces the prior system message.
- A broader read ceiling, a subagent run or a missing run root is refused.

**Stage 3: the route,** in `packages/agent-runner`, through the API with the
existing fake `runJob`:

- A steer to a running job returns `201` with `mode: "steer"`, appends
  `pending`, and then `delivered` with its turn once the fake run takes it.
- A follow-up of a completed job returns `201` with `mode: "follow-up"`. The
  new job is queued, with `continues` set and the message as its `task`. The
  old job's events are unchanged, and its view shows `continuedBy`.
- A follow-up carrying `instructions` runs with them in place of its
  predecessor's, and one without inherits them. A steer carrying
  `instructions` is `409 instructions_on_steer`.
- A message to a job that already has a follow-up lands on the head.
- A replay with the same key and message returns `200` and the same answer,
  and writes no event. The same key with another message, or a key used by
  `POST /jobs`, is `409 idempotency_conflict`.
- Each refusal in the table: `not_found`, `not_callers`, `not_continuable`
  for an interrupted job and for a `PROFILE_UNAVAILABLE` failure,
  `cannot_steer`, `instructions_on_steer`, `invalid_request` and
  `too_large`.
- Ordering:
  - Two steers pending at one boundary arrive in acceptance order.
  - Steers still pending when the run ends become one follow-up: the first is
    its task and the second a steer it takes first. The old job's terminal
    event comes after their `follow-up` events.
  - A cancel drops the steers accepted before it.
  - A message accepted after a cancel request starts a follow-up when the job
    ends.

**Stage 4: wiring,** one `harness-job` test with a scripted model. A
follow-up job's first request holds its predecessor's transcript and the new
message, and the follow-up writes to the predecessor's workspace.

## Stages

Each stage is one pull request. A GPT-6.1-Sol worker does the coding, and
the track lead reviews it.

1. **The steer seam** in `prompt-loop.ts`. It touches only the harness.
2. **`--continue-run`** in the harness CLI and engine. It can start once
   stage 1's diff is known, because both stages touch `prompt-loop.ts`.
3. **The route, store and lane,** in `packages/agent-runner`. Its contract
   tests can be written against the fake `runJob` while stages 1 and 2 are in
   review. It wires to the real harness only after they merge.
4. **The `harness-job` wiring:** the `takeMessages` pass-through, the
   `runTranscript` wrap, and a follow-up running `--continue-run` in the
   conversation's workspace.

Each stage updates the live documents it changes:

- `packages/cli/README.md`, "Local jobs";
- the headers of `api.ts` and `store.ts`, and `LOCAL_JOB_ROUTES`;
- `packages/cf-harness/README.md`, for steering and `--continue-run`;
- `docs/specs/agent-harness/01-runtime-contract.md` §8, which declares how a
  session takes interaction (`AH-INT-2`).

## Decided, and out of scope

- **A steer's text is appended verbatim.** The runner and the harness add no
  framing such as "the person sent this while you worked". Framing, and the
  wants-eval cases for it, belong to the caller.
- **Fabric-lane agent runs** are out of scope. Only local jobs take messages.
