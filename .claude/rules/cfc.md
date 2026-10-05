---
paths:
  - "packages/runner/src/cfc/**"
  - "packages/runner/src/cfc.ts"
  - "packages/runner/test/cfc-*.test.ts"
  - "packages/html/src/worker/reconciler.ts"
  - "docs/specs/cfc-*.md"
---

# Changing Contextual Flow Control

Contextual Flow Control is specified outside this repository, in
`commonfabric/specs` under `cfc/`, and the code you are about to change
implements it. Read `docs/development/cfc-spec-correspondence.md` before the
first edit: it says how to find the governing section, how to classify the
change (host arrangement, conforming implementation, or semantic gap), and that
a semantic gap opens a specs pull request before code lands here. The one-line
version is in `AGENTS.md` under "Runtime Development"; the procedure is not
restated here so that it has one home.
