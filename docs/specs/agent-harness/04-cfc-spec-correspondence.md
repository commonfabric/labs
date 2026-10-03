# Correspondence with the CFC Specification

Status: draft 0.1

The `AH-CFC-*` clauses in [02-cfc-integration.md](02-cfc-integration.md) are a
derivation. The authority they derive from is the Common Fabric Contextual Flow
Control specification, `commonfabric/specs`, and in particular
`cfc/18-runtime-implementation-profiles.md` §18.2-18.4. This document is the
derivation itself: which CFC section each `AH-CFC` clause rests on, which
clauses go beyond the authority, which if any are narrower than it, and which CFC
obligations no `AH-CFC` clause carries.

It exists because the audit in `packages/cf-harness/audit` cites `AH-CFC`
clauses as its authority. A reader following that citation should be able to
reach the specification that actually governs, and should be able to tell when
a finding rests on a CFC requirement and when it rests on a labs decision.

## How to read a row

The **CFC section** column names where the obligation lives in the CFC
specification. The **relation** column says what kind of derivation the clause
is:

| Relation   | Meaning                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| `faithful` | The clause restates a CFC obligation in harness-facing terms without changing what it requires.             |
| `narrow`   | The clause requires less than its CFC counterpart. The row says what it leaves out.                          |
| `beyond`   | The clause has no CFC counterpart and imposes an obligation the CFC specification does not.                 |
| `fused`    | The clause draws on more than one CFC section and states them as a single harness obligation.                |

No `AH-CFC` clause **contradicts** or is narrower than the CFC specification, so
a conformance claim resting on an `AH-CFC` clause does not overstate what the
authority requires. What `AH-CFC` does not carry at all is listed under "CFC
obligations no clause carries" below; a claim resting on `AH-CFC` alone is
silent there rather than wrong.

## The pin

Section numbers and quotations refer to `commonfabric/specs` at commit
`8b8613ea`. When that pin moves, this document is what gets re-derived: the
correspondence is a claim about two texts, and it is only true of the texts it
was read against.

## Clause-by-clause correspondence

### 1. Architectural split

| Clause      | CFC section                    | Relation   | Notes                                                                                                                                                              |
| ----------- | ------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AH-CFC-1`  | §18.3 (profile preamble), §18.2.4 | `faithful` | §18.3 makes the harness "the trusted control plane" and the model, plans, tool documentation, and sandboxed outputs "untrusted labeled inputs". §18.2.4 adds that sandboxed code "cannot resolve handles, downgrade ceilings, consume intents, or mark side-effecting work replay-safe". |
| `AH-CFC-2`  | §18.2.2, §18.2.4, §18.2.4.1    | `fused`    | The invocation record of §18.2.2 is what an observation binds to. The prohibition on relabeling by parsing is §18.2.4's: "Plain stdout/stderr, chat text, or sandbox-generated JSON without that validation is ordinary labeled data and cannot authorize a side effect." |

### 2. Prompt authority

| Clause     | CFC section | Relation | Notes                                                                                                                                                                                                                                                                                                                 |
| ---------- | ----------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AH-CFC-3` | §18.3.1     | `faithful` | §18.3.1 requires a UI mint to replay the render reference and a non-UI mint to supply "an equivalent trusted input-capture record such as `UserSurfaceInput`" binding subject, surface, value digest, role, and kernel name. `AH-CFC-3` requires the same five fields, distinguishes the UI path from the non-UI path, and refuses a surface that can supply neither. |
| `AH-CFC-4` | §18.3.1     | `faithful` | §18.3.1: "Application code and model output may request that a value be displayed or submitted, but they cannot assign the load-bearing prompt role themselves", and "a README or webpage containing "ignore previous instructions" remains `quote` or ordinary labeled content, even if it is imperatively phrased."     |
| `AH-CFC-5` | §18.3.1     | `faithful` | §18.3.1's fail-closed list covers a stale target path and a changed source value. `AH-CFC-5` states the same rule for the non-render cases — copying, summarizing, resuming — which §18.3.1 does not enumerate but whose principle it fixes.                                                                             |

### 3. Observation mediation and model context

| Clause     | CFC section         | Relation   | Notes                                                                                                                                                                                                              |
| ---------- | ------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AH-CFC-6` | §18.2.4, §18.2.4.2  | `faithful` | §18.2.4: raw bytes "are not rendered to a supervisor unless their labels satisfy the supervisor's observation policy; otherwise the runtime returns an opaque handle or a structured denied result." §18.2.4.2 gives that result its shape. |
| `AH-CFC-7` | §18.2.4, §18.2.4.2  | `faithful` | The accumulation rule is the `pc`-taint model: a child inherits the invocation `pc`, and resolving a handle "taints the callee `pc` by `payloadLabel`". The negative half — an opaque observation does not accumulate as if visible — is the handle model's own property: a transfer "does not reveal the payload". |
| `AH-CFC-8` | §18.2.4, §18.3      | `faithful` | §18.2.4: adding `InjectionSafe` "authorizes only the material-risk exchange rule; it does not clear `PROMPT_INFLUENCE`". §18.3: direct-command authority comes only from trusted evidence, "not from imperative text alone".                |

### 4. Side effects

| Clause      | CFC section          | Relation   | Notes                                                                                                                                                                                                     |
| ----------- | -------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AH-CFC-9`  | §18.3.3, §18.2.4     | `faithful` | §18.3.3 requires a claimant to document "how side-effecting tool calls bottom out in the same sink-specific intent and commit-point checks used outside the agent harness". `AH-CFC-9` is the harness-facing form of that requirement, minus its sink specificity — see the note under `AUD-14` below. |
| `AH-CFC-10` | §18.2.3, §18.2.4.3   | `faithful` | §18.2.3 requires fd-label tracking so that "later `read`, `write`, `fstat`, `mmap`, and `execve` calls inherit the path/content observations that produced the fd". `AH-CFC-10` generalizes that to a compound tool, which the CFC specification does not state separately but whose principle it fixes. |
| `AH-CFC-11` | §18.2.4.2            | `faithful` | §18.2.4.2 requires a sanitized structured error carrying an opaque handle id and forbids revealing blocked bytes in it.                                                                                    |

### 5. Delegation

| Clause      | CFC section          | Relation   | Notes                                                                                                                                                                                                          |
| ----------- | -------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AH-CFC-12` | §18.2.4.3, §18.3.3   | `faithful` | §18.2.4.3 attenuates a delegation in two dimensions. `AH-CFC-12` carries the capability half: a child receives only what its profile explicitly binds. |
| `AH-CFC-12a` | §18.2.4.3, §18.2.4.2, §18.3.3 | `faithful` | The observation half. §18.2.4.3 asks for a ceiling that is "an **upper bound** on what the callee is allowed to *observe*", with a read above it denied "even if the parent node could have observed it", and §18.2.4.2 requires handle substitution to respect it. `AH-CFC-12a` states both, and carries §18.3.3's obligation to say how ceilings apply before inherited handles resolve. It follows the CFC section's own modality: the ceiling is a `SHOULD`, and the denial and substitution rules are `MUST` wherever one is in force. |
| `AH-CFC-13` | §18.2.4, §18.2.4.2   | `faithful` | §18.2.4: schema-based `InjectionSafe` sanitization "is also a trusted-runtime transition, not a sandbox claim", and the runtime may add it "only after it validates the candidate against that trusted schema". §18.2.4.2's sanitizer sub-agent flow is the same shape from the caller's side. |

### 6. Enforcement modes

| Clause      | CFC section    | Relation | Notes                                                                                                                                                                                                              |
| ----------- | -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §6's ladder | —              | `beyond` | The CFC specification has no mode ladder. `disabled` / `observe` / `enforce-explicit` / `enforce-strict`, and the rule that `observe` "MUST NOT be described as CFC enforcement", are a labs vocabulary with no CFC counterpart. |
| `AH-CFC-14` | §18.2.2, §18.1 | `faithful` | §18.2.2 requires an invocation record carrying "profile digests for every CFC enforcement profile in effect", and §18.1 makes a profile a target an implementation "must satisfy". A mode that cannot be read off the run is a claim nobody can check. |
| `AH-CFC-15` | —              | `beyond` | **See "Where the derivation goes beyond" below.** No CFC section requires a deviation to carry an owner and a retirement condition, or forbids silent fallback in those words.                                       |

### 7. Evidence and retention

| Clause      | CFC section          | Relation   | Notes                                                                                                                                                                                                     |
| ----------- | -------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AH-CFC-16` | §18.2.2, §18.2.4.4   | `fused`    | §18.2.2's invocation record and §18.2.4.4's stored `(bytes, label)` per tool output are the two halves. `AH-CFC-16` states them as one artifact-boundary retention obligation.                             |
| `AH-CFC-17` | §18.2.4.2            | `faithful` | §18.2.4.2 requires potentially sensitive handle metadata — producer identity, source path, creation time, payload label — to be "omitted, replaced with profile-fixed fallbacks, or returned under a label that covers the revealed fact". |

### 8. Opaque reference presentation

| Clause      | CFC section                   | Relation   | Notes                                                                                                                                                                                                                                 |
| ----------- | ----------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AH-CFC-18` | §18.2.4.2, §18.2.4.3, §8.13   | `faithful` | §18.2.4.2: handle substitution "is itself an information flow and MUST be enforced as a read". §18.2.4.3: substitution "MUST respect ceilings". The converse — that minting or returning a handle is not a release — is §18.2.4.2's transfer rule: "a caller may pass the token as an opaque capability, but doing so does not reveal the payload." The host-side fit uses the runner's complete sink decision while remaining non-consuming, so a single-use grant cannot satisfy the host observation. |
| `AH-CFC-19` | §18.2.4.2                     | `faithful` | §18.2.4.2 requires handles to be non-enumerable by sandboxed code and resolvable only by the trusted runtime, and labels their metadata separately.                                                                                     |

## Where the derivation carries weight

Two clauses do work that a reader may not expect from their length, because
each is the whole of what `AH-CFC` says about a mechanism the CFC specification
develops at length.

### `AH-CFC-3` carries the whole of prompt-slot binding

§18.3.1 splits minting into two paths. A UI-backed slot binds by replaying a
render reference: retrieve `renderRef.rootRef` at `renderRef.seq`, recompute
`snapshotDigest`, resolve `targetPath`, verify the DOM event target maps to that
node, verify the authenticated `subject` and named `surface`, compute
`valueDigest`, and mint over all of it. A non-UI surface may mint without
`renderRef` "only if they provide an equivalent trusted input-capture record
such as `UserSurfaceInput` and bind the same subject, surface, value digest,
role, and kernel name" — routes that "are implementation profiles with explicit
evidence, not fallbacks to text-shaped authority."

`AH-CFC-3` compresses that into one clause and keeps what makes it load-bearing:
the five bound fields, the split between the two paths, and the refusal for a
surface that can supply neither. The render-replay steps themselves stay in
§18.3.1; a harness implementing a UI surface reads them there.

### `AH-CFC-12` and `AH-CFC-12a` split attenuation in two

§18.2.4.3 attenuates a delegation along two axes at once, and separating them
is what makes each checkable. `AH-CFC-12` governs what a child is *given*.
`AH-CFC-12a` governs what a child may *observe* through what it was given —
the ceiling as "an **upper bound** on what the callee is allowed to *observe*
from the filesystem, CLI args, inherited opaque handles, and any other labeled
channels", the denial of a read above it "even if the parent node could have
observed it", and §18.2.4.2's rule that handle substitution respects it.

The two are not interchangeable: a child handed a read tool and a handle to a
cell above the parent's intended scope satisfies `AH-CFC-12` on its own.
`AH-CFC-13` closes the return direction, so the three together cover what a
child receives, what it may observe, and what it may hand back.

## Where the derivation goes beyond

`AH-CFC-15` requires that an integration forced into `observe` publish that as
"a reduced-assurance deviation with an owner and retirement condition", and
that it "MUST NOT silently fall back from an enforcing mode." The CFC
specification has no such clause. §18.2.7 and §18.3.3 require a claimant to
*document* a list of things; §18.1 says a profile is a conformance target. None
of that names a deviation record, an owner, or a retirement condition, and none
of it forbids a silent fallback in those words.

This is a labs obligation that the CFC specification would be improved by
having, and it should be read as such rather than as a CFC requirement. Two
consequences:

- A finding that cites only `AH-CFC-15` is a labs finding. The audit's
  `extends` / `required-by` distinction already carries that, and this is the
  clause where the distinction matters most.
- The runner's sink inventory implements `AH-CFC-15` directly: an ungated sink
  carries a reason, an owner, and a retirement condition, which is the deviation
  record `AH-CFC-15` describes and no CFC clause asks for.

§6's mode ladder is `beyond` on the same terms. It is a rollout vocabulary,
useful and not derived.

## CFC obligations no `AH-CFC` clause carries

Three parts of the CFC specification's harness surface have no counterpart in
`02-cfc-integration.md` at all. An implementation could satisfy every
`AH-CFC-*` clause and be silent on both.

- **§18.3.2, dynamic tool discovery and labeled tool descriptions.** The whole
  section: descriptor digests, registry snapshot digests, snapshot pinning and
  revocation, per-field descriptor observation labels, and the separation of
  `docRef` free-form documentation from structured capability metadata. Four of
  §18.3.3's nine checklist items rest on it. No `AH-CFC` clause mentions a tool
  descriptor.
- **§18.2.4.1, measured tool contracts.** The measured execution bundle, the
  contract predicate, the parser identity, and the rule that a contract may
  clear prompt-injection material risk by construction. `AH-CFC-2`'s
  prohibition on relabeling by parsing is the negative half; the positive half —
  how a runtime *may* mint structured output from a measured invocation — is
  absent.
A harness conformance statement that claims `CfcAgentHarnessProfile` has to
answer both regardless of what `AH-CFC` asks, because §18.3.3 asks.

## How the audit should cite

The audit's citation table is a table of in-tree clauses, checked verbatim
against the documents that hold them. That check is what keeps a rule from
drifting away from the words it was written for, and it needs the document to
be in this repository.

For a check whose authority is a CFC clause rather than an `AH-CFC` one, the
citation should carry an external reference — repository, pinned commit, and
section — rather than a quotation, and should render distinguishably from an
in-tree citation so a reader can tell which authority is drift-guarded and
which is pinned by commit. The pin belongs in one place rather than per
citation, so that moving it is a single visible edit that schedules a
re-derivation of this document.

## Maintaining this document

This correspondence is live: it is edited when either text moves. Two triggers.

- **An `AH-CFC` clause changes.** Re-derive its row. A clause that moves from
  `narrow` to `faithful` is progress worth recording; one that moves the other
  way is a weakening that should be visible in review.
- **The CFC pin moves.** Re-read §18.2-18.4 against every row. A section
  renumbered breaks the references silently, and a requirement reworded changes
  what the derivation claims.
