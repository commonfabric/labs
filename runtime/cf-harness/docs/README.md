# cf-harness Documentation

This directory contains live documentation for the current `cf-harness`
implementation. The repository-wide lifecycle rules in
[`../../../docs/README.md`](../../../docs/README.md) apply here: current
reference and intended designs stay live; completed plans and point-in-time
migration notes live under `docs/history/` at the repository root.

## Start here

- [Package README](../README.md) — operator entry point, commands, and detailed
  feature reference.
- [CURRENT_STATE.md](CURRENT_STATE.md) — concise current architecture,
  integrations, and known gaps.
- [IMPLEMENTATION_PROFILE.md](IMPLEMENTATION_PROFILE.md) — conformance statement
  against the Agent Harness specification.
- [ROADMAP.md](ROADMAP.md) — remaining work only; shipped milestones are not
  repeated as a plan.
- [SKILLS_SUPPORT_SPEC.md](SKILLS_SUPPORT_SPEC.md) — live
  implementation-specific skills contract and future dynamic-activation design.
- [pattern-index-measurement.md](pattern-index-measurement.md) — how a run
  against the pattern index is measured so two runs can be compared: the task
  wording rule the finding rests on, what a batch records, and what its counts
  do and do not establish.
- [DEMOS.md](DEMOS.md) — the four proven demos in the order to run them, with
  the prompt verbatim, what appears, when to stop, and the one thing that can go
  wrong with each. Read this to run them.
- [DEMOS-EVIDENCE.md](DEMOS-EVIDENCE.md) — the evidence behind those four: how
  often each worked and on which build, the demos deliberately kept off the run
  page and why, and the findings that came out of running them repeatedly. Read
  this to decide whether to trust a result.
- [WEAVER.md](WEAVER.md) — the operator procedure for driving the console from
  Weaver's command pill: loom, the console on loom's fabric, and Weaver
  configured, so a harness-built piece lands in the person's own space.
- [system-map/](system-map/README.md) — an interactive map of the harness and
  the runtime around it, drawn by trust boundary: where every gate sits and its
  status, where the threats lie and which are closed by planned work, guarded by
  CFC, or held by people and process; with the procedure for keeping it true.

The system map moves in lockstep with the implementation. A change that lands or
downgrades a gate, adds a boundary, threat, sink, or posture, or changes what
`CURRENT_STATE.md` or `IMPLEMENTATION_PROFILE.md` says updates the map's data
tables and `SNAPSHOT` in the same pull request, following the map's
[update procedure](system-map/README.md#updating-it). The map is a reading aid,
never a source of truth; when it disagrees with code, the map is wrong.

## Normative boundary

The implementation-independent runtime and CFC contracts live in
[`docs/specs/agent-harness/`](../../../docs/specs/agent-harness/README.md). This
package owns exact CLI flags, tools, profiles, schemas, defaults, artifacts, and
deviations. Loom and Pattern Factory own their adapter and rollout behavior.

## Historical records

- [`IMPLEMENTATION_PLAN.md`](../../../docs/history/packages/cf-harness/docs/IMPLEMENTATION_PLAN.md)
  — the April 2026 package bootstrap plan and checkpoint.
- [`LOOM_MIGRATION_NOTES.md`](../../../docs/history/packages/cf-harness/docs/LOOM_MIGRATION_NOTES.md)
  — the April 2026 pre-integration assessment of Loom's Codex paths.

Historical documents are useful background, not descriptions of the current
system.
