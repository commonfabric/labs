---
paths:
  - "packages/runner/src/cfc/**"
  - "packages/runner/src/cfc.ts"
  - "packages/runner/test/cfc*.test.ts"
  - "packages/runner/test/cfc/**"
  - "packages/html/src/worker/reconciler.ts"
  - "packages/html/src/worker/display-fit.ts"
  - "packages/cf-harness/src/cfc-*.ts"
  - "packages/cf-harness/src/contracts/cfc-*.ts"
  - "packages/cf-harness/src/sandbox/runsc-cfc-result.ts"
  - "docs/specs/cfc-*.md"
---

# Changing Contextual Flow Control

Contextual Flow Control is specified outside this repository, in
`commonfabric/specs` under `cfc/`, and the code you are about to change is held
to it. Read `docs/development/cfc-spec-correspondence.md` in this repository
before the first edit: it says how to find the governing section, how to
classify the change (host arrangement, conforming implementation, or semantic
gap), that a semantic gap opens a specs pull request before code lands here,
and how a gap or a migrated change-list entry is filed as one. The specs
repository is private and this one is public, so you may not be able to read
it; the document's section "Without access to the specification" says what to
do then.

`deno task check-cfc-correspondence` holds the CFC sources to the specification
snapshot at `packages/runner/src/cfc/kernel/spec-snapshot.json`: every `§`
citation here names a section it lists, every kernel function's `@spec` header
hash is the one it records, and `SPEC-PENDING` markers stay under budget.
`deno task cfc-spec-snapshot` regenerates the snapshot from a specs checkout;
the manifest beside it, `packages/runner/src/cfc/kernel/manifest.ts`, is the
row you update when a critical function moves into the kernel.
