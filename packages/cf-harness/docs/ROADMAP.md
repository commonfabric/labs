# cf-harness Roadmap

Status: live, non-normative\
Last reviewed: 2026-08-18

This document lists remaining work. Shipped milestones belong in
[CURRENT_STATE.md](CURRENT_STATE.md), tests, and history rather than in a
permanently growing implementation plan.

## 1. Complete the CFC transport boundary

- Carry trusted observation metadata from `runsc-cfc`/runner mediation through
  every tool path used by Loom and Pattern Factory.
- Exercise `enforce-explicit` in product adapter tests without losing ordinary
  tool observations.
- Remove the product `observe` bridges only after those suites prove the full
  path and retained run evidence explains every release/denial.
- Keep prompt-slot evidence, model-context influence, invocation inputs, and
  side-effect authorization distinct.

## 2. Make dependency readiness contractual

- Add a preflight surface for Docker daemon, selected runtime, sandbox image,
  model gateway, mounts, Browser Access lease, and trusted CFC sidecar paths.
- Let product adapters reject a run before its first model turn when a required
  dependency is unavailable.
- Keep capability discovery deterministic and side-effect free; report health
  separately rather than overloading capability presence.

## 3. Stabilize the interactive protocol

- Version and document the NDJSON request/response/event schemas as a supported
  compatibility surface.
- Finish product-level browser support and define any allowed turn concurrency.
- Expand crash/reconnect and cancellation integration tests before making the
  Loom adapter generally available.

## 4. Tighten delegation and artifacts

- Cover denial-path tool messages with the session handle table's swapping.
- Add value handles (`cfh:v:`, reserved in the token grammar) with a
  materialization story, and an explicit release/readback mechanism for
  parent/model-facing artifact references.
- Carry handle state across interactive sessions so tokens survive an
  interactive restart.
- A turn's delegations run together, apart from a `browser` delegation, which
  holds the calls after it, and its other calls run in order; specify budget and
  cancellation across turns, and the workspace isolation of children that share
  the parent's sandbox, before scheduling more than that.
- Extend resume only where external side-effect replay semantics can be made
  explicit and testable.

## 5. Mediate file-based pattern sources for `run_pattern`

- `run_pattern` accepts only inline `sourceText`; a workspace-file source (the
  former `sourcePath`) is a trusted-host read channel whose compile diagnostics
  can exfiltrate file content, so reintroduce it only as a mediated capability:
  reads routed through the same policy surface as `read_file`, with CFC
  observation metadata on the source bytes.

## 6. Bound, retain, and check `run_pattern` side effects

- Give each `run_pattern` invocation a resource ceiling and deadline, aligned
  with the hosted-pattern-authoring prerequisite that an agent session runs
  under configured limits on model tokens, tool invocations, CPU, memory, and
  disk. What bounds an invocation today is the run's abort signal, plus the
  scheduler's own convergence budget, which defers a reactive graph whose pass
  exhausted its budget — converging-but-slow and never-settling alike — and
  reports each deferring pass through the `scheduler.non-settling` telemetry
  marker. That covers reactive non-convergence only: a loop inside a single
  computation body, or an async builtin that never resolves, is bounded by
  neither.
- Define a retention and deletion story for the pieces `run_pattern` persists
  and for the run-state handle table. Each invocation leaves a
  stopped-but-never-deleted piece whose source-history revision is a
  storage-retention root the piece list does not reveal — a piece `register`
  named is as retained as one it did not, so registration changes findability
  and not retention — and handle-table entries accumulate per run with no
  expiry.
- Add an outbound CFC flow check on compiled pattern source. The current
  space-equality gate covers inbound input links only; nothing checks what a
  compiled pattern's own code sends out of the session space.

## 7. Evolve skills only from concrete needs

- Keep explicit caller preload and profile-scoped child skills as the stable
  path.
- Add model-driven `load_skill` activation only when a product needs it and the
  catalog, policy, digest, resume, and subagent semantics are agreed.
- Do not add remote/global skill installation into the skills root. External
  discovery and acquisition exist only as the pinned, handle-only path in
  `docs/plans/external-skill-acquisition.md`; its remaining stages (the mirror,
  the no-secrets discovery child) are sequenced on CT-2148, and a release
  boundary that reads the `ExternalIngest` stamp the acquisition mints is not
  built.

## Exit discipline

When a roadmap item ships, update the current reference and conformance profile,
add test evidence, and remove it from this file. If a proposed direction is
abandoned or superseded, preserve the decision as a historical record instead of
leaving a stale “next step” in live documentation.
