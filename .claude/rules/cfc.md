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

`deno task check-cfc-correspondence` reads the specification snapshot at
`packages/runner/src/cfc/kernel/spec-snapshot.json` and fails on: a `§`
citation in `packages/runner/src/cfc/` or `packages/runner/src/cfc.ts` naming
a section it does not list, unless the task's `EXEMPTIONS` table names that
file, citation and reason; a function exported under
`packages/runner/src/cfc/kernel/` without a `@spec` header, with a hash the
snapshot does not record, or with a value import from outside the kernel other
than the shared type module `@commonfabric/api/cfc` (type-only imports are
free); a critical pseudocode function in the snapshot that no manifest row or
companion entry in `packages/runner/src/cfc/kernel/manifest.ts` covers, or a
row the snapshot or the kernel contradicts; and more than three `SPEC-PENDING`
markers in the governed source files (the runner CFC sources and tests, the
two html worker modules, the harness's CFC sources), or one naming no specs
pull request. Citations in documents are not checked. `deno task
cfc-spec-snapshot` regenerates the snapshot from a specs checkout, and the
manifest row is what you update when a critical function moves into the
kernel.
