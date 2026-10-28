---
status: historical
created: 2026-10-27
archived: 2026-10-28
reason: "Executed plan; local jobs take messages through POST /jobs/<id>/messages, steering a running job and following up a finished one, across #9283, #9287 and #9286 (stages 1 to 3) and #9288 (stages 4 and 5)."
---

# Sending a message to a local job

Status: executed. Stages 1 to 3 landed as #9283, #9287 and #9286; stages 4
and 5 landed together as #9288. Stage 5 changed several rules sections 1 to
3 state; the stage 5 entry under "Stages" lists them, and it governs where
they differ.

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

### What becomes of a message

Every accepted message waits on one job, its *holder*, and ends with exactly
one outcome:

- **`delivered`:** the holder's run took it at a turn boundary, so the
  holder's result answers it.
- **`follow-up`:** it opened a follow-up job, whose result answers it.
- **`dropped`,** with a `reason`, when nothing will answer it:
  - `cancelled`: a cancel request arrived after the message;
  - `not_continuable`: its holder ended with no run to continue;
  - `interrupted`: a stop or crash cut its holder off.

A job *has a recorded run* when its run reached a complete checkpoint, a
point at which every tool call had its result, that a follow-up can start
from. The lane tells the store which, as it ends the job. A job that failed
`PROFILE_UNAVAILABLE` has none, and neither has a job cancelled while
queued. A run that the harness ended itself, by finishing, failing or being
cancelled, recorded where it stopped, and section 2 says how a follow-up
treats a turn it cut off. An `interrupted` job never counts as having a
recorded run. A stop or crash ended it outside the harness, so the runner
cannot tell whether the run's records are intact, or which of its commands
ran after the last checkpoint. That is the same reason the store never
reruns an interrupted job.

**At acceptance**, the head's state decides:

| Head | The message |
|---|---|
| `queued` or `running`, no cancel requested | Waits on the head. Its run may take it. One that carries `instructions` is refused `instructions_on_steer`. |
| `running`, cancel requested | Waits on the head. Its run will not take it, because the run is stopping. |
| Finished, with a recorded run | Opens a follow-up at once. |
| Finished, with no recorded run | Refused `not_continuable`. |

**At a turn boundary**, the run takes the messages waiting on its job in
acceptance order. It stops at the first message it cannot answer, which is
one of two kinds:

- a message that carries `instructions`, which only a follow-up of its own
  can answer;
- a message accepted on this job after its cancel request, because the
  run is stopping. This restriction belongs to the cancelled job. A message
  that moves on from it is ordinary on the job it moves to.

Messages behind the first one the run cannot answer wait with it, so the
model never reads a message before an earlier one.

**When the holder ends**, every message still waiting on it gets its outcome
or moves, in the transaction that writes the holder's terminal event:

1. If the holder ends `cancelled`, the messages accepted before the cancel
   request are `dropped` as `cancelled`. The caller cancelled that work, and
   a message accepted after the request is a new request.
2. If the holder has no recorded run, the remaining messages are `dropped`
   as `not_continuable`, or as `interrupted` when restart recovery ends it.
3. Otherwise, the first remaining message opens the holder's follow-up,
   carrying that message's `instructions` if it has any. Every other
   remaining message *moves* to the follow-up in order, and waits there
   under the same rules. The moved messages ahead of the first one carrying
   `instructions` are therefore taken before the follow-up's first model
   call. That message and every message behind it wait for the follow-up to
   end, and then it opens the next follow-up. Each instruction replacement
   gets its own job, each message is answered under the instructions in
   force when its turn comes, and the chain never forks.

### The answer

`201` on first acceptance, `200` for a replay:

```json
{
  "message": {"key": "chat-msg-81", "target": "job-a", "message": "Use the April numbers instead.", "acceptedAt": "…", "delivery": "pending", "jobId": "job-a"},
  "job": {"id": "job-a", "state": "running", "…": "…"}
}
```

`message` is the message's record:

- `key`, `target` (the job id the request named), `message`, `instructions`
  (when the request gave them) and `acceptedAt` are fixed at acceptance.
- `delivery` is `pending` or one of the outcomes. `jobId` is the job it
  waits on, or the job whose result answers it. `turn` is set once a run has
  delivered it, and `reason` once it has been dropped. These fields always
  hold the current values.

`job` is the current snapshot of the job `jobId` names. On first acceptance,
`delivery` is `pending` (waiting on the head) or `follow-up` (a finished head
opened a new job).

### Events on the existing stream

A job's stream carries one `message` event each time a message starts
waiting on that job, gets its outcome while waiting there, or leaves it:

- `{key, delivery: "pending"}` when it starts waiting there, on acceptance or
  on moving in;
- `{key, delivery: "delivered", turn}` when the run takes it;
- `{key, delivery: "follow-up", jobId}` when it opens this job's follow-up;
- `{key, delivery: "moved", jobId}` when it moves to that follow-up;
- `{key, delivery: "dropped", reason}`.

Each message that waited on a job has its outcome or `moved` event before
that job's terminal `state` event. A `delivered` event is written while the
run goes on, when the run takes the message. Every message still waiting
when the job ends gets its outcome or `moved` event in the transaction that
writes the terminal event. A reader that follows a stream to its end therefore learns,
for every message that waited on that job, where it went. This holds for
every way a job ends: a run's own end, a cancel while queued,
`PROFILE_UNAVAILABLE`, and restart recovery.

A message sent to a head that had already finished never waits on any job,
so no stream carries an event for it. It appends nothing to that head,
whose stream has already ended. The new job's stream starts with `queued`,
as every job's does. That message's outcome, `follow-up`, is observable in
the answer, in a replay, and in the new job's view as `openedBy`.

### The job view

`GET /jobs/<id>` gains four fields:

- `continues`: the job this one follows, when it is a follow-up.
- `continuedBy`: the follow-up that followed this one, once there is one.
- `messages`: the records of the messages that waited on this job, in order.
- `openedBy`: on a follow-up, the record of the message that opened it.

A follow-up's `request` is the request of the job it follows, with `task`
replaced by the message that opened it, and `instructions` replaced when
that message carries them. Its `idempotencyKey` is that message's key.

### Replay

The store keeps `(caller, idempotencyKey)` unique across jobs and messages.
A message's fingerprint is its `target`, its `message`, and its
`instructions`, either absent or with their value. The runner checks replay
first, before it resolves the head or applies any state refusal:

- **Same key, same fingerprint:** `200`, with the message's record and the
  current snapshot, as under "The answer". Nothing new is written. This holds
  whatever has happened since, including a head that has moved on or a
  target that can no longer be continued.
- **Same key, another fingerprint:** `409 idempotency_conflict`.
- **A key already used by `POST /jobs`, or one that names a message on
  `POST /jobs`:** `409 idempotency_conflict`.

### Refusals

Every refusal is `{ok: false, code, error}`, as elsewhere on the socket.

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | The body is not JSON, a field is missing or the wrong type, or `message` is empty. |
| 413 | `too_large` | The body runs past 1 MiB. |
| 404 | `not_found` | No job has `<id>`. |
| 403 | `not_callers` | `caller` is not the caller that enqueued the conversation. |
| 409 | `not_continuable` | The head has finished with no recorded run. |
| 409 | `instructions_on_steer` | The message carries `instructions`, and the head is queued or running with no cancel requested. |
| 400 | `unknown_profile` | A follow-up would open now, and its profile is no longer one the host names. |
| 409 | `idempotency_conflict` | See "Replay". |

`not_callers` is not a security boundary: the socket and its token are the
authority, as for every other route. It keeps one client from steering
another client's conversation by mistake.

### Ordering

- The store accepts messages to one conversation one at a time, in its
  immediate write transaction. Acceptance order is the conversation's order.
- A run takes the waiting messages in acceptance order, up to the first it
  cannot answer, and appends each as its own user message.
- When a holder ends, the outcomes and moves above keep acceptance order. The
  first remaining message opens the follow-up, and the rest wait on the
  follow-up in their order.
- A message sent while a follow-up is still `queued` waits on it, behind
  any message already waiting there. It reaches the follow-up's first model
  call only when no message carrying `instructions` waits ahead of it.

## 2. What "running" and "finished" mean

The states stay the ones the store has now. For messages, `queued` and
`running` count as running, and `completed`, `failed` and `cancelled` count
as finished. `interrupted` counts as finished and cannot be continued.

**A steered job's result.** It is the last result the model submitted. When a
steer arrives after the model has already called `submit_result` and a
model turn remains, the run does not stop: the model reads the steer and may
submit again, which replaces the result. If it does not submit again, the
earlier result stands. When no turn remains, the run ends with the submitted
result, and the steer opens the follow-up. A steer adds a reason to keep
going and removes none: a run that still owes a piece keeps going after an
accepted result, steered or not, as it does today. A steered job's
`commands` hold every command of the run, and its `report` covers the whole
run. Steers spend model turns from the job's own `maxModelTurns`.

**A follow-up's result.** A follow-up is a job in full. Its result is
validated against the schema of the job it follows, and its `commands` and
`report` are its own. The job it follows is untouched. A conversation's
current answer is its head's result. A follow-up gets a fresh turn budget from
its profile.

**What a follow-up carries.**

- the transcript of the job it follows, up to that run's last complete
  checkpoint, meaning the last point at which every tool call had its
  result. The harness's turn-local notices are left out;
- that job's handle table, so the handles the model holds still resolve;
- its result schema. Each job writes its result to a file of its own, named
  for the job, so a follow-up never overwrites or deletes the result file of
  the job it follows;
- its CFC record;
- its workspace. A conversation has one workspace, its first job's, so files
  the model wrote stay where it left them. Only the head of a conversation
  runs, so no two runs write that workspace at once.

Its artifacts are its own, under its own job id.

**A run cut off partway.** A job that ended `cancelled` or `failed` may have
stopped in the middle of a turn, after some of that turn's commands ran and
before their results were recorded. Its follow-up starts from the last
complete checkpoint. The harness then adds its interrupted-turn notice ahead
of the new message, as the interactive chat service does after a cancelled
turn. The model is told that the turn was cut off and that its effects are
unknown, rather than finding the turn missing. A job whose run never reached
a complete checkpoint has no recorded run, and a message to it is refused
`not_continuable`.

## 3. How cf-harness takes a message

Today, batch mode takes no input once a run starts. `--resume-run` re-enters
the same run, under the same run id, and refuses a new prompt. The
interactive chat service runs each turn as a new run and refuses a second
turn while one runs, so it has no steer either. Two harness changes are
needed.

**The steer seam.** `CfHarnessPromptLoop` takes one new optional option,
`takeMessages: (turn) => readonly string[]`, which may also return a promise.
`turn` is the number of the model turn whose request will include the
messages.

- The loop calls it at the top of each model turn, before the model request.
  That point follows the previous turn's tool results and checkpoint, and on
  the first turn it follows the prompt.
- The loop appends each message verbatim as a user message and persists it.
  The harness adds no framing; any framing is the caller's, and so are the
  evals of what it tells the model. These are ordinary transcript messages,
  not turn-local notices, so they stay in the resumable history.
- The loop also calls it before each of its exits: a final text answer, an
  accepted `submit_result`, and an admitted task ending. These are the
  points where the loop would end today, so an accepted result from a run
  that still owes a piece is not an exit. The loop calls it only while a
  model turn remains, and only while the run's signal has not aborted. At a
  tool-batch exit, it takes and appends the messages before the turn's
  checkpoint, so the checkpoint holds every message the run goes on to
  answer. If the call
  returns anything, the loop takes another turn instead of ending. On the
  last permitted turn the loop ends without calling it, so a message
  arriving then stays waiting and opens the follow-up.
- Once the loop has ended, it never calls `takeMessages` again. Every
  message it takes is followed by a model request. A message is therefore
  delivered exactly when the loop takes it, and the lane marks it
  `delivered` at that point.
- Only the root loop takes messages. A delegated child loop does not.

`harness-job.ts` already wraps `createPromptLoop`, so the lane passes the
seam in through `HarnessJobOptions`, with no CLI flag.

**Continuing a recorded run.** This is a new run started from another run's
checkpoint. It uses the chat service's per-turn shape, driven from batch mode
by a new flag, `--continue-run <run root> --prompt=<message>`:

- a new run id, with lineage naming the run it continues;
- a fresh engine and sandbox;
- the seeded history: the prior run's transcript up to its last complete
  checkpoint, then the interrupted-turn notice when the run went past that
  checkpoint, then the new prompt. With no complete checkpoint, the flag is
  refused. The harness always rebuilds the system message from the prior
  run's recorded builder inputs and the new result contract, using the same
  builder as a fresh run. Explicit flags override the recorded inputs:
  `--system-prompt` replaces the additional instructions, which is how a
  follow-up's new `instructions` arrive. A run without recorded builder
  inputs is refused;
- the prior handle table, result schema and CFC record, passed on
  explicitly (`AH-REF-3`). The result path is the new run's own;
- the provider, model, credential owner and read ceiling checked against the
  prior run's, refusing anything broader (`AH-ART-4`, `AH-ART-5`,
  `AH-INT-4`). The checks are the ones `--resume-run` already makes;
- refusal of a subagent run, as `--resume-run` refuses one now;
- refusal of a prior run whose recorded prompt-slot binding carries a
  `valueDigest`, `slotDigest` or `snapshotDigest`. That binding authorizes
  one exact prompt value, and a follow-up's new prompt is not that value,
  for the same reason the loop refuses a steer under such a binding.

Each run still reaches exactly one terminal state (`AH-LIFE-1`). This is why
a follow-up is a new run and does not re-enter the old one.

`harness-job.ts` today wraps only `runPrompt`. It will wrap `runTranscript`
the same way, so the job's abort signal, events and usage reach a continued
run too.

**Authority.** A steer and a follow-up's message bind at the profile's
`taskRole`, the same role as the job's task. They come from the same caller
under the same profile, and the request cannot set the role.

Under `docs/development/cfc-spec-correspondence.md`, the steer seam is a host
arrangement. The binding a local job runs under is the one
`createCliPromptSlotBinding` builds. It names a role, a source and a subject
(the workspace), and it carries no `valueDigest`, `slotDigest` or
`snapshotDigest`. It therefore authorizes the run's driver at that role, not
one exact prompt value. The task itself is caller text arriving the same
way. The interactive chat service likewise runs a session's later user turns
under the session's binding whenever a turn supplies no replacement policy.
A steer is one more user message from the same driver, under the run's
existing binding, and the seam changes no CFC enforcement source. This rests
on a recorded deviation rather than on the specification: deviation 7 of
`packages/cf-harness/docs/IMPLEMENTATION_PROFILE.md` records that these
bindings carry no digest of the submitted value. A steer extends that
deviation to each later message of a run, and stage 1 records so in the
deviation, whose retirement then requires each steer to mint its own
binding. A steer
reaches the model by the same path as the task prompt, so whatever records
the prompt as model context records the steer too.

A binding can digest an exact value. A run manifest's `promptSlot` may carry
those digests, and then the binding covers that one prompt and nothing
appended to it. The prompt loop refuses `takeMessages` for a run whose
binding carries any of the three digests, before its first model request.
Such a run takes no messages, rather than lending one value's authority to
another.

## 4. The surface CFS calls

There is one route, `POST /jobs/<id>/messages`, on the existing private
socket, with the body, answers and events above. Nothing in it is about
wants or chat.

Loom's adapter, `src/lib/agent_jobs.py`, would gain a `message` action
beside `start` and `cancel`, and would read `continues`, `continuedBy`, `openedBy` and
`messages` from the job view. When an answer says `delivery: "follow-up"`, the
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
- With a model turn remaining, a message pending when the model submits a
  result keeps the loop running. The model sees the message, and its second
  submission is the result.
- On the last permitted turn, nothing is taken at the exit, whether the turn
  ends with a final text answer or an accepted result. The message is still
  waiting.
- Nothing is taken after the loop ends.
- A child loop takes nothing.
- A run given `takeMessages`, under a binding that carries a
  `valueDigest`, a `slotDigest` or a `snapshotDigest`, is refused before any
  model request, once for each of the three, and `takeMessages` is never
  called. The same binding without `takeMessages` runs as it does today.

**Stage 2: `--continue-run`,** in `packages/cf-harness`:

- The new run has a new id, and its lineage names the prior run.
- Its first model request holds the prior resumable transcript, then the new
  prompt, and no turn-local notices.
- A handle from the prior run resolves.
- A new structured result is written and validated.
- With or without `--system-prompt`, the system message is rebuilt from
  recorded builder inputs, with explicit flags overriding them. It holds
  the harness's guidance and the new result contract, never the old result
  path. `--system-prompt` replaces the recorded additional instructions.
- A run without recorded system-prompt builder inputs is refused before
  any model request.
- A prior run cut off in the middle of a turn is continued from its last
  complete checkpoint, with the interrupted-turn notice before the new
  prompt. A prior run with no complete checkpoint is refused.
- The new run writes its result to its own path, and the prior run's result
  file is unchanged.
- A broader read ceiling, a subagent run or a missing run root is refused.

**Stage 3: the route,** in `packages/agent-runner`, through the API with the
existing fake `runJob`:

- **A message the run takes.** A message to a running job returns `201`
  with `delivery: "pending"`. It appends `pending`, and then `delivered` with
  its turn once the fake run takes it.
- **A finished head.** A message to a completed job returns `201` with
  `delivery: "follow-up"`. The new job is queued, with `continues` set and
  the message as its `task`. The old job's events are unchanged, and its
  view shows `continuedBy`.
- **Instructions.** A follow-up carrying `instructions` runs with them in
  place of its predecessor's, and one without inherits them. A message
  carrying `instructions` to a running job with no cancel requested is
  `409 instructions_on_steer`.
- **The head.** A message to a job that already has a follow-up lands on
  the head.
- **Replay:**
  - The same key and fingerprint returns `200` with the current record, and
    writes no event.
  - The same holds after the head has moved on to a follow-up, and after
    the target can no longer be continued.
  - The same key with another message, with changed or added
    `instructions`, or with another target is `409 idempotency_conflict`.
  - So is a key already used by `POST /jobs`.
- **Refusals.** Each one in the table:
  - `not_found` and `not_callers`;
  - `not_continuable`, for an interrupted job, a `PROFILE_UNAVAILABLE`
    failure, and a job cancelled while queued;
  - `instructions_on_steer`;
  - `invalid_request` and `too_large`;
  - `unknown_profile`, for a message to a finished job whose profile the
    host no longer names.
- **Ordering and outcomes:**
  - Two messages waiting at one boundary arrive in acceptance order.
  - Messages still waiting when the run ends: the first opens one follow-up,
    the second moves to it and is taken first. On the old job's stream,
    the `follow-up` and `moved` events come before its terminal event.
  - A cancel drops the messages accepted before it.
  - Two messages accepted after a cancel request, each carrying different
    `instructions`, open two follow-ups in a chain. Each follow-up runs with
    its own message's instructions.
  - After a cancel request, accept A and B, each with different
    `instructions`, then C with none. A opens follow-up J, and B and C move
    to J. J's run takes neither. When J ends, B opens J's follow-up K, C
    moves to K, and K's run takes C before its first model call, under B's
    instructions. The same holds when C is sent instead while J is still
    queued.
  - A message waiting on a queued job that is then cancelled, one waiting on
    a job that fails `PROFILE_UNAVAILABLE`, and one waiting on a job that
    restart recovery ends `interrupted` each get `dropped`, with its reason,
    before that job's terminal event.

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
   conversation's workspace. Done in #9288.
5. **Continuation, completed.** Done in #9288, by Ben's decision to build
   continuation fully before Loom adopts it:
   - **One next-run builder** in cf-harness, used by `--continue-run` and
     the interactive chat service's turn path. It owns the checkpoint cut,
     turn-local exclusion by the `turnLocal` flag alone, one interrupted
     notice, the carried handle table, research retention through
     `selectResearchContext`, re-established grants and skills context,
     and the run-state fields a new run carries, re-derives or excludes, in
     one table a test holds complete. The loop marks replayed seed events
     with `seed: true`, and consumers skip them by that marker.
   - **The system prompt is rebuilt from recorded inputs.** Run state
     records the prompt builder's inputs (`systemPromptInputs`), and
     `--continue-run` always rebuilds the system message from them,
     overridden by explicit flags. A run without them cannot be continued.
   - **The interrupted notice is cause-neutral,** and it is added whenever
     the cut drops anything or the prior run's status is not `completed`.
   - **A conversation survives a runner restart.** The store records each
     job's run root when its run starts. On recovery,
     `canContinueHarnessRun` decides whether the interrupted job has a
     recorded run, and if it does, waiting and later messages open
     follow-ups. This replaces section 1's rule that an interrupted job is
     never continued.
   - **The steering switch is removed.** Every lane gives its runs the
     `takeMessages` hook, and `cannot_steer` no longer exists.
   - **`follow_up_only` replaces `instructions_on_steer`.** It is one
     refusal for a message carrying `instructions`, `imageAttachments` or
     `inputs` (with their `foreignSpaces`) that its head would take as a
     steer.
   - **Follow-ups carry attachments.** The message route accepts images and
     inputs on a follow-up, and `--continue-run` accepts `--image` and
     `--input-cell`. The continued run carries `assignedPieces`. A new input
     name that collides with one the prior run holds fails the follow-up
     before any model call.
   - **Text and usage stream.** A job's stream carries a `text` event for
     each root assistant message, whole, and a `usage` event after each
     model call. A job with no `resultSchema` completes with its final
     assistant text as a string `result`.

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
