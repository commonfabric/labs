# Specs

Technical specifications of current and intended behavior. Everything here is
live documentation: when the behavior a spec describes changes, the spec must
change in the same commit (see [`../README.md`](../README.md)).

Two kinds of documents graduate out of this tree into
[`../history/specs/`](../history/specs/):

- an implementation plan or work order whose work is complete or abandoned;
- a design document for a change that shipped, where the document describes
  the delta or the decision rather than the resulting system.

Two kinds stay here even when the work behind them is finished: a spec that
remains the best description of the shipped subsystem, and a decision record
whose decision still governs current behavior (archive it only when the
decision is reversed or superseded).

## Index

- [Protected initialization](cfc-protected-initialization.md) — transaction-scoped initialization of protected cells, new defaulted fields, and references a collection builtin hands a sub-pattern

### Addressing and navigation

- [Random space identities](random-space-identities.md) (proposed; active
  deployment direction)
- [Common Fabric URLs](fabric-urls.md) (concept; no deployment planned)

### Pattern construction and authoring

- [Pattern testing](PATTERN_TESTING_SPEC.md)
- [Pattern update testing](pattern-update-testing.md)
- [Pattern construction](pattern-construction/README.md)
- [Pattern imports](pattern-imports/README.md)
- [TypeScript transformer](ts-transformer/README.md)
- [Schema generator](schema-generator/README.md)
- [Computed-cell identity](computed-cell-identity.md)
- [Content-addressed action identity](content-addressed-action-identity.md)
- [Content-addressed module loading](module-loading.md)
- [Piece source lifecycle](piece-source-lifecycle.md)
- [Hosted pattern authoring](hosted-pattern-authoring.md)
- [Scoped cell instances](scoped-cell-instances.md)

### Agent execution

- [Agent harness](agent-harness/README.md)

### Data, storage, and execution

- [JSON Schema](json_schema.md)
- [Link-schema precedence](link-schema-precedence.md)
- [Content-addressed schemas](content-addressed-schemas.md)
- [Sigil data model](data-model/sigil.md)
- [Sparse-array preservation](sparse-array-preservation.md)
- [Space model](space-model/README.md)
- [Formal space-model data specification](space-model-formal-spec/README.md)
- [Naming in collections](collection-naming.md)
- [The cell reference grammar](cell-reference-grammar.md)
- [Memory v2](memory-v2/README.md)
- [FUSE filesystem](fuse-filesystem/README.md)
- [SQLite builtins](sqlite-builtin/README.md)
- [Runner child-run ownership](runner-child-run-ownership.md)
- [Scheduler v2](scheduler-v2/README.md)
- [Server-primary execution](server-side-execution/README.md)
- [Verifiable execution](verifiable-execution/README.md)
- [Webhook ingress](webhook-ingress/README.md)
- [Test-run records](test-records.md)
- [Choosing which tests a change runs](test-selection.md)

### Contextual flow control and security

- [CFC commit preparation](cfc-commit-preparation.md)
- [Content-addressed CFC labels](content-addressed-cfc-labels.md)
- [CFC enforcement mode matrix](cfc-enforcement-matrix.md)
- [CFC specification change list](cfc-spec-changes.md)
- [Cross-space integrity](cfc-cross-space-integrity.md)
- [Exchange-rule authoring](cfc-exchange-rules-authoring.md)
- [Exchange-rule authoring extensions](cfc-exchange-rules-authoring-extensions.md)
- [Label-metadata confidentiality](cfc-label-metadata-confidentiality.md)
- [Observation classes](cfc-observation-classes.md)
- [Persisted declassification](cfc-persisted-declassification.md)
- [Sealed custody](cfc-custody-seal.md)
- [Range-scoped integrity](cfc-range-scoped-integrity.md)
- [Render-boundary composition](cfc-render-boundary-composition.md)
- [Runner future work](cfc-runner-future-work.md)
- [The stored CFC envelope](cfc-stored-envelope.md)
- [Template population](cfc-template-population.md)
- [Input-witnessed `TransformedBy`](cfc-transformed-by-input-witnesses.md)
- [Value-level provenance](cfc-value-level-provenance.md)
- [Per-write read-prefix provenance](cfc-write-prefix-provenance.md)
- [Write-destination reads](cfc-write-destination-reads.md)
- [Sandboxing](sandboxing/README.md)
- [Toolshed access control](toolshed-access-control.md)

### Shared profiles

- [Shared profile space](shared-profile-space.md)
- [Shared-profile participant rosters](shared-profile-rosters.md)
