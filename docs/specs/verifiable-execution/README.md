# CF Protocol: Verifiable State Update & Provenance

**Status:** Draft

This spec was originally a single document and is now split into smaller files
for easier review and iteration.

## Document Map

- [Foundations](01-foundations.md) covers Sections 1–4.
- [Commit model](02-commit-model.md) covers Section 5.
- [Capabilities API](03-capabilities-api.md) covers Section 6.
- [Receipts](04-receipts.md) covers Section 7.
- [Log and authorization](05-log-and-authorization.md) covers Sections 8–9.
- [CFC and trust](06-cfc-and-trust.md) covers Sections 10–12.
- [Extensions and appendices](07-extensions-and-appendices.md) covers Sections
  13–17 and the appendices.
- [Implementation plan](implementation-plan.md) tracks implementation status
  across the specification.

## Proposals (Editorial + Spec Clarifications)

These are improvements that make the spec easier to implement and verify without changing core design goals:

- Keep the Capabilities/API section aligned with the Memory v2 protocol (`docs/specs/memory-v2/04-protocol.md`, `runtime/memory/v2.ts`) for endpoint names, selector shapes, and error semantics.
- Clarify that labels are schema-derived and may vary by JSON path (`docs/specs/json_schema.md#ifc`), while `Labels.classification` remains a coarse/legacy summary.
- Make “Receipt” vs “Commit” terminology explicit (current implementation centers on commit facts; richer receipts are described as future work).
- Specify a canonical form for “label maps” (path addressing, ordering/canonicalization, and what must be committed vs what can be derived from schemas).
- Tighten the conflict/compare-and-swap story (define “expected vs actual” precisely and what information a client can rely on when retrying).
- Specify signature and multi-signer receipt formats (including how signatures bind to code/policy/label commitments).
