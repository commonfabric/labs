# Agent Harness Specifications

Status: draft 0.1

This directory defines implementation-independent contracts for agent harnesses
used by Common Fabric products. They live with the `cf-harness` implementation
so changes to behavior, tests, and the governing contract can land together.
The package documents what one implementation does; these specifications state
the behavior on which callers, policy runtimes, and other harness
implementations may rely.

Package-specific CLI flags, file layouts, experimental defaults, and deployment
recipes remain with their owning implementation. Product-specific routing,
mounts, brokers, and rollout choices remain with their adapters.

## Status and interpretation

These documents are an initial draft extracted from the behavior already used by
Loom, Pattern Factory, `cf-harness`, and the CFC runtime profile. They are not
yet a claim that every implementation conforms.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY**
are normative. A conforming implementation publishes a conformance statement as
described in [03-conformance.md](03-conformance.md), including every known
deviation and reduced-assurance mode.

Each normative clause carries an identifier made of `AH`, for agent harness, an
area, and a number, such as `AH-CFC-16`. Conformance statements and the audit in
`packages/cf-harness/audit` cite clauses by that identifier.

## Reading order

1. [01-runtime-contract.md](01-runtime-contract.md) — invocation, lifecycle,
   capabilities, context management, tools, delegation, interactive sessions,
   opaque references, immutable observations, artifacts, and resource
   accounting.
2. [02-cfc-integration.md](02-cfc-integration.md) — the CFC transport and
   enforcement profile for agent harnesses.
3. [03-conformance.md](03-conformance.md) — conformance classes, evidence, and
   implementation-profile requirements.
4. [04-cfc-spec-correspondence.md](04-cfc-spec-correspondence.md) — which
   section of the CFC specification each `AH-CFC-*` clause derives from, the
   two clauses that are narrower than their counterpart, and the CFC
   obligations no clause here carries.

## Ownership boundary

The specification owns:

- caller-visible lifecycle and capability meaning;
- authority and containment invariants;
- durable evidence required for audit, replay, and resume;
- model-bound reference and immutable-observation semantics;
- provider-neutral model-usage and cost-evidence semantics;
- the contract between a harness and an authoritative CFC runtime.

An implementation profile owns:

- exact commands, flags, schemas, defaults, and artifact filenames;
- supported tools, model gateways, sandboxes, and product adapters;
- experimental features and documented deviations;
- test evidence for its conformance claims.

The first [implementation profile](../../../packages/cf-harness/docs/IMPLEMENTATION_PROFILE.md)
is maintained with `@commonfabric/cf-harness`. Loom and Pattern Factory
maintain separate adapter documents because their routing, mounts, brokers, and
product rollout choices are not universal harness behavior.

## Non-goals

This draft does not standardize a model-provider API, a universal tool catalog,
a UI protocol, a sandbox technology, or a product's agent-routing policy. It
also does not elevate an implementation's temporary bridge into a platform
guarantee.
