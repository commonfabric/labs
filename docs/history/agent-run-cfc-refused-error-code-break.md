---
status: historical
created: 2026-11-18
archived: 2026-11-18
reason: "Decision record for widening the agent-run result's errorCode taxonomy with CFC_REFUSED."
---

# Agent run: `CFC_REFUSED` joins the error taxonomy

A run can end because the runtime's information-flow rules stopped it: a read
the session's read ceiling withholds throws `CfcReadCeilingError`, and nothing
between the read and the prompt loop turns it into a result the model can act
on. Before this change the runner reported that run as `PROVIDER_FAILURE`, so a
client showing the code said the model had failed, which it had not.

`AGENT_RUN_ERROR_CODES` in `runtime/runner/src/agent-error-codes.ts`, and
`AgentRunErrorCode` in `patterns/system/agent-run/agent-run.tsx`, gained
`CFC_REFUSED`. A local job and an `AgentRun` record carry the same code.

## Why not an existing code

- `PROVIDER_FAILURE` says a model or tool failed. A ceiling refusal is the
  rules working as intended, and an owner who reads it as a model failure
  retries or reports the wrong thing.
- `REFUSED` goes with the `refused` state, a result the boundary would not
  release. A job in that state is not one every owner's bookkeeping counts as
  ended, so a run the ceiling stopped would look unfinished forever. A
  `CFC_REFUSED` run's state is `failed`.

A code kept to local jobs, mapped back to `PROVIDER_FAILURE` for `AgentRun`
records, was the alternative. It would leave two taxonomies to keep in step and
still tell a record's reader the untrue thing. Pre-release, with few users,
widening the shared taxonomy once is the smaller regret.

## The break

The pattern's result reaches `run.errorCode`, and a value its recorded readers
have never seen is a widened result. The compatibility proof reports
`result.run.errorCode: enum/const no longer accepts every previous value`
against the three `system/agent-run/agent-run.tsx` baselines recorded since
`INVALID_RESULT` joined the taxonomy. The earlier baselines are already
forgiven on that path by the entries that
[agent-run-invalid-result-error-code-break.md](agent-run-invalid-result-error-code-break.md)
and
[agent-run-record-handle-scope-break.md](agent-run-record-handle-scope-break.md)
record.

No stored state is stranded, and no reader misbehaves:

- A record holds `CFC_REFUSED` only once a runner reports it for a new run.
  Every record stored before holds one of the earlier codes, which the new
  schema still admits.
- Every reader treats the code as text, as the `INVALID_RESULT` record found:
  the view shows `error <code>`, the `agent` builtin reports the code as a
  string, and `cf`'s agent inspection carries it through as a field. A local
  job's store types the code as a string. None switches over the codes
  exhaustively; a client that turns codes into words falls back to its generic
  wording until it adds one.

Declared on Alex's decision (2026-11-18). The contracts of
`system/agent-queue.tsx` and `system/home.tsx`, which include the run's, are
recorded beside it.
