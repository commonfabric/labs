---
status: historical
created: 2026-09-21
archived: 2026-09-21
reason: "Decision record for moving the agent-run view's record scope from the value onto the handle once the schema generator stopped dropping it."
---

# Agent run: the record's scope moves onto the handle

`system/agent-run.tsx` declared a record as `PerUser<AgentRun>` and took it as
`run: Writable<AgentRunRecord>`. The schema generator dropped the scope of a
scope wrapper reached through a local alias, so every recorded contract for the
pattern has `run: { $ref: AgentRun, asCell: ["cell"] }` with no scope at all,
and the pattern ran as if `run` were an unscoped cell.

With the generator fixed, that spelling emits `scope: "user"` beside
`asCell: ["cell"]`, a scope on the value. Measured in the pattern's own test,
the view then read nothing: a value scope makes the binding address the user
instance of the argument slot (`scopedLinkForPath`,
`packages/runner/src/pattern-binding.ts`), while the link the caller passed in
is stored in the slot's space instance (`data-updating.ts`), so the reader
finds an empty slot. That held whether the caller's cell was space- or
user-scoped.

The `agent` builtin creates each record as a user-scoped document
(`agentRunRecordCell`, `packages/runner/src/builtins/agent.ts`), and the queue
holds records as `PerUser<Cell<AgentRun>>` handles. The record's scope belongs
on the handle, as a cap on which link it may follow, so `AgentRunRecord` is now
`PerUser<Writable<AgentRun>>`, and the view's `run` argument emits
`asCell: [{ kind: "cell", scope: "user" }]`. The view reads the record through
the passed link, as it did before, and its result is unchanged.

## The break

The argument's `asCell` entry changes from `"cell"` to the scoped object form,
which the compatibility proof reports as `argument.run: asCell changed` against
both recorded baselines. No stored state is stranded: the argument slot holds a
link to the record, the link is unchanged, and every record the builtin creates
is user-scoped, which the cap admits. A piece whose `run` links to a
session-scoped cell would no longer follow it; the builtin never creates one.

Taken as part of the change that fixed the generator (scope wrappers reached
through aliases), on the ruling that agent runs are per-user.
