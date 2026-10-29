---
name: spec-audit
description: Map and verify the CTS/schema documentation corpus against its normative contracts, implementation, tests, fixtures, and runtime consumers. Use for claim-level audits or updates in docs/specs/ts-transformer, docs/specs/schema-generator, package guidance, and author-facing CTS docs, especially after transformer/schema changes or before releases.
---

# Spec audit: docs vs code for the CTS compiler surface

## Why this exists

The 2026-07 audit found the current-behavior spec denying an implemented,
fixture-pinned CFC `ifc.*` lowering subsystem. Use this map to distinguish
normative disagreement from descriptive drift and to find the repository's
load-bearing evidence quickly.

## The map

- Start at `docs/specs/ts-transformer/README.md` for the corpus and each
  document's authority. Normative target-language/lowering contracts win over
  code; descriptive current-behavior and schema-mapping specs follow code and
  passing tests.
- Ground implementation claims in the relevant canonical constant or source,
  targeted tests, and—where output shape matters—the
  `base/ts-transformers/test/fixtures/**` input/expected corpus. Inspect live
  emission with `deno task cf check <file> --show-transformed --no-run`.
- Canonical constants the specs cite (spot-check the citations still resolve):
  `CFC_TRANSFORMER_STAGES` (cf-pipeline.ts),
  `COMMONFABRIC_RUNTIME_EXPORT_REGISTRY` (+ its runner-factory guard test),
  `CrossStageState`, `getExpressionContainerKind`,
  `SES_SELF_CONTAINED_CALLBACK_BOUNDARIES`, wrapper vocabulary in
  `schema-generator/src/typescript/wrapper-names.ts`,
  `CFC_CANONICAL_ALIAS_NAMES` in `base/api/cfc.ts`, and the `JSONSchema` type in
  `base/api/index.ts`. Mechanical stage claims are pinned by
  `base/ts-transformers/test/spec-sync.test.ts`.
- Cross-package contracts with no single home (historically the blind spot):
  transformer emission ↔ runner sandbox verifier
  (`@commonfabric/pattern-contract/sandbox-contract`); pattern-coverage ↔ runner
  line-offset/cache couplings (runner/harness/engine.ts); bare WeakMap boundary
  with schema-generator (cross-stage-state.ts header); CFC aliases/policy
  markers ↔ schema generator ↔ policy compilation ↔ runner fail-closed IFC
  validation.

## Known drift patterns (seeds, not the boundary)

- Landing-gap: a feature ships, spec sections that deny it stay (grep the spec
  for "not implemented", "no …yet", "draft" and test each such claim).
- Enumeration drift: prose lists (diagnostic ids, registry entries, stages,
  fixture suites) vs their constants — including the inverse direction (ids in
  code the spec never mentions).
- Rename shadows: file/symbol references in older docs after renames; git touch
  dates lie (mechanical rename PRs refresh mtimes without verifying).
- PR-scoped artifacts aging in place; "Effective date"/status headers nobody
  updates.
- Author-layer contradictions: docs/common, tutorials, and skills teaching
  constructs the validators reject — verify against `validation.test.ts` and the
  target-language matrix, and check the critic skills especially (their errors
  get amplified by automation).

## Audit values

- Name the authority direction for every disagreement before deciding which side
  changes.
- Treat source, tests, and emitted output as evidence; another document's claim
  is only a lead.
- Use independent passes to raise confidence, never as a substitute for cited
  evidence.
- Preserve point-in-time records under `docs/history/`; correct live docs or
  implementation according to the task and the authority split.
- Make load-bearing enumerable facts mechanically checkable when practical.
  Historical audit precedents live at `docs/history/cfc-spec-audit.md` and
  `docs/history/cts-docs-audit-2026-07.md`.
