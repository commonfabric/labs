# Security and privacy: current boundaries and roadmap

<!-- Publication prerequisite: verify that CFC enforcement is enabled by default
and direct sandbox fetch has been removed in the deployed release. The prose
below assumes both changes have shipped. -->

## Overview

Common Fabric is designed to let untrusted programs work with sensitive data
under policies enforced by the runtime. The architecture already includes
isolated execution, mediated rendering, and Contextual Flow Control (CFC)
enforcement enabled by default. These are working foundations, not yet an
end-to-end privacy guarantee.

**The production environment is currently a test-net. Builders and operators can
log into servers and access user data.** Enforcement has known gaps and
deliberate development shortcuts. Our goal is to exclude ourselves from that
access: run in confidential compute, release protected keys only to verified
execution environments, and operate and update the service without an
administrative back door. This roadmap describes intended work, not completed
guarantees.

The roadmap has two successive milestones:

1. **A secure runtime with a trusted operator.** Finish component isolation,
   reader authorization, identity delegation, and core policies with trusted
   interactions. Completing the
   [server-side execution rollout](server-execution-v2.md) is central: it lets
   us authorize data before delivering it to a client and establish
   authoritative execution history. Close these boundaries before claiming
   operator exclusion. [Details: A–C](#a-rendering-and-interaction).
2. **Remove the need to trust the operator.** Perform remote attestation,
   protect data and keys inside confidential compute, and close administrative
   access. Updates remain automatic, with public binary and release
   transparency. Approval starts with us and should move toward independent
   authority; that transition is part of removing operator trust.
   [Details: D](#d-confidential-hosting-models-and-updates).

In parallel, build the means to operate privately: aggregate analytics,
user-approved diagnostics, confidential quotas, and helper services that reduce
disclosure to outside providers. These make operator exclusion practical;
contractual model providers remain a distinct trust choice that users must be
able to reject. [Details: E–F](#e-private-operations).

Verification runs throughout: adversarial tests and external review, with Lean
proofs of the design and an implementation kept close to it. Full runtime
verification, likely with a Rust rewrite, is the long-term goal.
[Details: G](#g-verification-and-completion-criteria).

## Appendix: remaining work and technical references

### A. Rendering and interaction

**Rendering and interaction.** The virtual-DOM architecture supports isolation,
but HTML and CSS sanitization are incomplete. We will narrow the expressive
surface to trusted components and a restricted CSS subset. Mutually untrusted
components must not interfere or observe private interactions. A parent that
only needs to know that a click occurred should not learn which private child
control was clicked. Iframe policies still permit external script and font
services; these dependencies must move behind controlled hosting.

### B. Server-side execution, reader authorization, and provenance

Completing the [server-side execution rollout](server-execution-v2.md) will let
us finish enforcing reader policy before data reaches a client. The
[server architecture](../specs/server-side-execution/README.md#31-server) places
clearance checks where reads are served, and the
[builtin contract](../specs/server-side-execution/builtins.md) defines results
scoped to the reader. The remaining delivery work must preserve those
restrictions: current
[view-scoped replication](../features/view-scoped-client-replication.md)
delivers whole documents, not private field projections.

Developer mode allows people to inspect what reaches their own machine,
including debugging output. Confidentiality therefore has to govern delivery,
not just the visible interface. Logs, errors, and telemetry also need to respect
these boundaries.

The [server execution protocol](../specs/server-side-execution/protocol.md)
establishes authoritative derived commits and attribution to their causes.
Completing this path supplies execution records and provenance; we then need to
verify that the history has no gaps against the
[verifiable-execution contract](../specs/verifiable-execution/README.md).

### C. Identity, policies, and trusted interactions

**Identity and authority.** Named spaces currently derive their keys from
publicly known inputs, permitting takeover.
[Random space identities](random-space-identities.md) must replace that
shortcut, with name lookup separate from authority. Migration also needs to
retire old authority and permissive access for legacy spaces without explicit
access-control lists. Complete delegation should provide scoped, revocable
device and agent access, key rotation, and recovery. Private delegation should
remove the identity-level link between a person's profiles; it does not by
itself prevent correlation through content or traffic.

**Core policies and trusted interactions.** We need to finish writing the core
policies and the core trusted interactions that authorize releases and create
inspectable, revocable grants. Default policies are currently ours; users need
open, configurable policies, including which model providers may receive which
data. Configurability must preserve the authority of everyone whose restrictions
attach to shared or derived data.

The [policy-authoring plan](cfc-exchange-rule-authoring.md) tracks the remaining
policy and trusted-authority work; the
[enforcement matrix](../specs/cfc-enforcement-matrix.md) maps runtime coverage.

### D. Confidential hosting, models, and updates

**Remote attestation** must verify the running code, configuration, and policy
posture before data or keys are released. This connects confidential hosting to
the runtime guarantees and must cover the environments handling persistence,
recovery, and migration as well as ordinary execution.

**Model access** currently relies on our selection of providers: confidential
compute services or large providers with zero-retention contracts. This is the
current protection at the model boundary;
[per-call CFC admission](cfc-llm-sink-admission.md) remains to be completed. We
need full attestation for confidential inference and user policies that can
reject contractual providers. Contracts and attestation are different trust
assumptions. Hosting models ourselves inside confidential compute is a later
option, not a prerequisite if third-party services are sufficiently verifiable
and reliable.

**Updates will be automatic, with binary and release transparency:** anyone must
be able to audit the artifacts we approve. We initially remain the release
authority; moving that authority toward independent governance is an explicit
goal. Transparency makes approval decisions auditable, but does not itself
prevent a malicious update. Our approval authority remains a trust assumption
until independent controls constrain it. The process must also bind approved
releases to attested execution and define how vulnerable versions are retired.

### E. Private operations

Removing operator access requires replacements for how we diagnose, support, and
fund the service. These must be developed alongside confidential hosting.

- **Analytics:** release aggregate statistics with differential privacy and
  minimum population thresholds. Noise, contribution limits, and repeated-query
  budgets need a defined privacy model; low-volume statistics stay withheld.
- **Diagnostics:** turn known failure investigations into reusable agent skills.
  With user permission, an agent using confidential inference can inspect an
  issue and prepare a report for the user to review before sending it to us.
  Restricted diagnostic agents may emit only a small vocabulary of problem
  categories. Agents may also propose fixes, with user review and a separate
  agent checking reports and patches for leaked data. Those checks support,
  rather than replace, enforceable output restrictions.
- **Exceptional support:** an explicit opt-in may move a space to a separate VM
  for operator access through a fully recorded SSH session. This deliberately
  grants access; the recording itself needs restricted handling.
- **Private quotas:** an external payments system should add quota without
  learning consumption, remaining balance, or space ownership. The user alone
  should see detailed usage and balance through a confidential path. The aim is
  for the company to know who paid how much without learning their primary DID
  or linking their spaces.

### F. External services

A caching proxy and controlled package mirror should reduce direct requests to
external sites, including script CDNs, with a potentially restricted package
catalog. Attestable, non-logging map tiles and geospatial services are a
priority because requests often reveal location. Mirrored datasets can support
private catalog queries; confidential, agent-friendly web search is a
longer-term partnership goal. A proxy alone does not establish confidentiality:
its access to requests and what it forwards upstream must be covered by the same
model.

### G. Verification and completion criteria

Runtime security comes before operator exclusion; private operations and helper
services can develop alongside it. Each milestone needs a stated threat model,
executable acceptance tests, published deployment posture, and external review.
Runtime completion requires enforcement across supported paths and migration of
existing data and authority. Operator exclusion must cover administration,
recovery, and updates.

Our interim verification strategy is to prove the design in Lean through
formalized pseudocode and keep the implementation as close to that specification
as possible. We already have Lean proofs for parts of that design; extending
their coverage and checking that the implementation mirrors it are ongoing work.
These proofs do not yet formally verify the shipped runtime. The long-term plan
is full formal verification of the runtime, likely alongside a rewrite in Rust.
Throughout, we will state the scope of the proofs and remaining assumptions,
including hardware trust and metadata or side-channel limits.
