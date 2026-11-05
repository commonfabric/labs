---
status: historical
created: 2026-10-05
archived: 2026-10-05
reason: "Decision record for widening the agent-run result's errorCode taxonomy with INVALID_RESULT."
---

# Agent run: `INVALID_RESULT` joins the error taxonomy

#8461 gave a run a distinct error code for a completed model loop whose
result fails its schema. Before that, the runner reported it as
`PROVIDER_FAILURE`. `AgentRunErrorCode` in `system/agent-run.tsx`, and
`AGENT_RUN_ERROR_CODES` in `packages/runner/src/agent-error-codes.ts`, gained
`INVALID_RESULT`.

## The break

The pattern's result reaches `run.errorCode`, and a value its recorded readers
have never seen is a widened result. The compatibility proof reports it as
`result.run.errorCode: enum/const no longer accepts every previous value`
against all three recorded baselines. For the two older ones, the proof blames
it in the same finding as the `argument.run` break that
[agent-run-record-handle-scope-break.md](agent-run-record-handle-scope-break.md)
records. That's why the entry for those two baselines names both paths, and
this break's own entry covers only the third.

No stored state is stranded, and no reader misbehaves:

* A record holds `INVALID_RESULT` only once a runner reports it for a new run.
  Every record stored before holds one of the earlier codes, which the new
  schema still admits.
* Every reader treats the code as text. The view shows `error <code>`
  (`system/agent-run.tsx`). The `agent` builtin reports the code as a string
  (`packages/runner/src/builtins/agent.ts`). `cf`'s agent inspection carries it
  through as a field (`packages/cli/lib/agent-inspection.ts`). None switches
  over the codes exhaustively.

Declared on Dan's decision (2026-10-05), so that `main`'s `pattern-compat` gate
passes again after #8461. The baselines for `system/agent-queue.tsx` and
`system/home.tsx`, whose contracts include the run's, are recorded beside it.
