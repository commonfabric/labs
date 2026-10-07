---
status: historical
created: 2026-10-06
archived: 2026-10-06
reason: "Executed integration plan; availability changes delivered in PR #4677."
---

# Unavailable runtime integration

## Contract

Use the canonical `FabricUnavailable` primitive for async result boundaries.
`pending` and `syncing` are transient; every `error` is terminal, including
`errorKind: "schemaMismatch"`. Computations propagate unaccepted markers through
their ordinary result-writing path. Availability guards opt in at exact captured
paths; `resultOf()` preserves the reactive identity while exposing the usable
type. `latestComplete()` retains an atomic, schema-projected complete snapshot.

Preserve the runtime's local-read readiness, speculative transaction parking,
scoping, CFC policy, and durable async operation identity. Async API changes and
their callers ship together. Pending render continuity preserves only previously
usable content and disables it while pending.

## Implementation

- [x] Compare the canonical primitive and runtime readiness with the intended
      behavior.
- [x] Replace duplicate primitive infrastructure with canonical types, codecs,
      error kinds, and prefab instances.
- [x] Integrate computation preflight and exact-path availability observation
      with current runner, scheduler, and transformer contracts.
- [x] Integrate async producers, streaming projections, and complete snapshots;
      migrate current consumers and preserve persisted operation compatibility.
- [x] Integrate pending rendering with current CFC rendering boundaries.
- [x] Integrate per-space reconnect observation with current memory restoration
      and storage readiness machinery.
- [x] Update live documentation and behavioral regressions.
- [x] Run affected package tests, pattern checks, repository gates, and a
      changeset-scoped self-review.
- [x] Update the existing PR, complete CI, and audit review surfaces.

## Acceptance

No second unavailable primitive or codec is introduced. Ordinary computations
never receive unaccepted markers. Guard-only reads do not demand usable payloads.
Unavailable transitions notify live consumers. Error-kind selection is explicit
at producer boundaries. Scoped snapshots preserve live Cell identity and advance
atomically. Reconnect notifications follow successful watch and commit
restoration. Current main is contained in the delivered branch.
