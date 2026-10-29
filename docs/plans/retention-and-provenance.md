# Retention and CFC execution provenance — implementation plan

Two related pieces of work on what an invocation leaves behind: how long the
record of one is kept, and what the runtime knows about who caused it. Both are
about the invocation surface rather than about verbs, which is why they are
sequenced here rather than alongside
[the verbs plan](verbs-implementation.md).

**This plan is gated on a CFC review that has not happened.** Nothing below is
started, and nothing should be until that review resolves. The verbs plan does
not advance any of it, and none of it blocks the verbs plan — the two can be
read, scheduled, and finished independently.

Size L, and more of it is unknown than settled. It touches `runtime/runner`,
`runtime/piece`, `runtime/cli`, and `patterns/apps/topics`.

## What has to resolve first

The retention half waits on three resolutions, in order:

1. The default retention window, which bounds the idempotency guarantee: a
   replayed invocation id returns the original outcome only while the record
   that carries it survives.
2. The CFC label review for stored invocation records, against
   [label metadata confidentiality](../specs/cfc-label-metadata-confidentiality.md).
3. Confirmation of the storage layer's collection story for unreferenced cells.
   An expiry policy that cannot actually release storage is a policy in name
   only.

## Retention

**The record itself.** Timestamps and a typed error shape, with the schema
authored open-world so protocol fields can be added without a migration.

**The collection that holds them.** Linked from the piece, carrying a
pattern-declared range plus a default, and read-and-expire.

**A single rejection taxonomy.** Two "fix your input" signals reach a caller
today, and neither carries a stable code: `VerbInputValidationError`, the CLI's
pre-dispatch refusal, and a thrown `Error` in a verb body, whose typed carrier
derives from `FabricError`. Codes reach the invocation surface here, and when
they do both must speak one taxonomy — a reserved `INVALID_INPUT` among them —
so an agent branches one way rather than two. No code field ships before this.

## Provenance

A separate CFC-gated track, and the four items are ordered by dependency.
Attribution rides CFC provenance rather than a parallel `actor` field on the
invocation envelope, which is why the last item can exist at all:
`topics.agentName` is an interim atomic argument, and it is what the provenance
path replaces.

- **Specify a runtime-minted provenance atom**, provisionally `AgentActor`, for
  trusted execution context at ingress. Its metadata may carry an agent role,
  tool or session context, or a protected reference to the triggering request.
  It is not reduced to a display name.
- **Mint it at the external `cf` call boundary** from trusted client context and
  attach it to the invocation input. The proof is CFC inspection: flow labels
  carry the atom to every write the input affects.
- **Define metadata confidentiality and the extraction and display helpers**
  before any rich context is exposed. Prompt content and user-request content
  must never be copied into an ordinary invocation payload.
- **Retire `AgentAuthoredEvent { agentName }` from `topics`** once the
  provenance path works end to end, and not before — it is the interim carrier
  of attribution and stays until something else carries it. Dropping the
  required input field is argument widening, so the update gate permits it.

*Exit:* records are enumerable and expire per policy; CFC inspection proves
execution provenance reaches affected writes from `cf`; `topics` can omit
`agentName` without losing display attribution; and the invocation record has
no independent canonical actor field.

## Issue breakdown

Importable one-to-one into the tracker; `depends on` names the dependency edge.

| id | title | size | depends on |
| --- | --- | --- | --- |
| E1 | timestamps, error shape + linked retention collection | L | the retention window, the CFC review, the collection story |
| E2 | CFC: specify `AgentActor` mint, propagation, metadata protection + extraction | L | CFC review |
| E3 | cli: trusted ingress provenance for `cf` calls | M | E2 |
| E4 | topics: retire AgentAuthoredEvent | S | E3 + end-to-end provenance proof |
