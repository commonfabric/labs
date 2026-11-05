---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Executed A3 plan; pattern-test read budgets shipped in #7257."
superseded-by: docs/features/read-accounting.md
---

# Pattern-test read budgets

Status: completed. A3 landed in
[PR #7257](https://github.com/commontoolsinc/labs/pull/7257) after all 69 CI gates
and clean Cubic and antagonistic reviews. The authoring surface and measurement boundaries are documented in the
[read-accounting contract](../../features/read-accounting.md#pattern-test-budgets).
This plan tracks acceptance in the
[computation-cost sequence](pattern-computation-cost-implementation.md).

## Author contract

A test opts in with a module-level `readBudgets` export. The harness reads this
export after compilation and before starting the pattern, at the existing
module-export seam used for fetch mocks. This makes initialization measurable
without enabling accounting for every unbudgeted test or trying to discover a
budget after the work it limits has already run.

The export provides separate initialization limits and default step limits. Each
interval can limit total proxy accesses and the maximum proxy accesses of any
single reactive action run. A step can override its limits with optional
`readBudget` metadata. Step overrides require the module-level opt-in; silently
ignoring an override is an error. Numeric limits are finite nonnegative safe
integers. Zero is a valid limit, equality passes, and absent limits impose no
constraint. Invalid module-level declarations fail before pattern instantiation.
Validate a step override before executing that step, without demanding later
step descriptors early merely to validate them.

The first surface limits proxy accesses, the quantity the design targets. Link
hops, document cardinality, and dependencies remain diagnostic counters with
their existing meanings. Extending enforcement to those quantities requires an
explicit contract, especially for cardinality across runs.

## Interval ownership

Initialization starts before pattern instantiation and ends after initial
settlement and continuous UI mounting, when enabled. A budgeted step starts
before the harness demands its descriptor or dispatches its event. It ends only
after scheduler, storage, pending commits, and asynchronous builtin work settle.
Assertion work belongs to its own step. Skipped steps execute no operation and
enforce no limits; their declarations are still validated, and work observed in
their interval remains visible.

Use `runtime.settled(Infinity)` at budget boundaries so a fixed round count
cannot silently end measurement early. Do not add sleeps or polling. Unbudgeted
tests keep their existing demand and settlement behavior. A budget does not
itself demand a subject's UI: tests must declare a render step or opt into
continuous UI demand for that workload.

Measure every participating runtime locally. The initial implementation may
support single-runtime tests only, provided multi-user declarations fail
explicitly rather than appearing to enforce incomplete cross-runtime limits.
Multi-user support requires participant-local intervals and an explicit
aggregation policy; synchronized labels alone do not define a global step.

## Extend execution coverage before enforcing totals

The current scheduler completion event reports body-only work. Preserve that
event's meaning so the A0 baseline stays interpretable. Add completion records
for measured transaction attempts that cover reactive bodies, event handlers,
and their commit preparation. Count failed attempts and retries independently.
Avoid adding a parent-inclusive total to its already-counted children.

Per-action limits use each reactive body's completed sample, including builtin
and coordinator runs. Step totals use the extended transaction-attempt stream,
not the sum of that stream and body telemetry. An attempt has one owner and one
completion record even when it throws, aborts, or its commit rejects. The
accounting setting is captured when the attempt begins. Transaction wrappers
preserve ownership, and diagnostic idempotency rechecks stay excluded.

Document cardinality remains a body diagnostic. The collector retains document
objects independently of storage logs, while attempt completion publishes only
proxy and hop counters. These counters can be checkpointed at body completion
while remaining active through commit preparation. Do not count storage-server
CPU or network traffic as local proxy accesses. Explicitly describe any
maintenance work outside these boundaries before naming the resulting report a
whole-step cost.

Relevant seams to examine and cover:

- `scheduler/run.ts`: body completion, fan-out instances, and commit kickoff.
- `scheduler/events.ts`: handler invocation and asynchronous commit verdicts;
  commit outcomes can be excluded from existing telemetry even when an attempt
  consumed work, so cost records need their own unconditional completion path.
  Include the separate preflight dependency transaction as its own attempt.
- `storage/extended-storage-transaction.ts`: commit preparation and early
  rejection. Preserve speculative commit scheduling and pending-commit barriers.
- `runtime.editWithRetry`: include each attempt, covering asynchronous builtin
  writebacks as well as failed callbacks and retried transactions.
- `cli/lib/test-runner.ts`: named exports, descriptor metadata, initialization,
  step settlement, and result aggregation. The harness's direct `runtime.run`
  transaction must be measured; scheduler and event hooks alone do not cover
  pattern instantiation. Exclude harness environment setup before instantiation
  explicitly, rather than mixing it into the pattern's initialization budget.

## Failure and observable demo

Evaluate limits after settlement. Budget failure is a test failure with the
interval, declared limit, measured count, and largest attributed contributors.
Keep the original functional or runtime error when both occur; include budget
diagnostics alongside it. Failed render and settle operations still publish
completed costs. Do not stop measurement at the first excess or hide work by
truncating the displayed rows.

The demo will present one passing workload and one failing workload, backed by
the real CLI: a single expensive derivation violates the per-run limit; many
individually cheap derivations violate only the total. Display the failing
diagnostic and exact reproduction command in the progress dashboard. No timing
claim is needed to show the guard working.

## Acceptance sequence

- [x] Implement attempt lifecycle and verify body/commit attribution, error,
      abort, retry, fan-out, wrapper, and concurrent-runtime ownership.
- [x] Parse opt-in declarations before initialization; validate malformed limits
      and unsupported multi-user use explicitly.
- [x] Enforce exact-boundary pass and one-over failure for per-run and total
      limits, with separate initialization and step intervals.
- [x] Verify many cheap runs, removed actions, and failed attempts cannot evade
      the total. Verify unbudgeted execution is unchanged.
- [x] Publish the executable pass/fail demo, update author documentation, and
      review both accounting completeness and failure diagnostics.
