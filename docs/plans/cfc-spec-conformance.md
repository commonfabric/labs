# CFC spec conformance: runner, cf-harness, FUSE and runsc-cfc

The CFC specification in `commonfabric/specs` defines how labels move between
fabric cells, a sandbox filesystem, and external sources: the worked cases in
§13.11, the decisions behind them in `cfc/13-11-decisions.md`, and the
normative text they rest on (§4.6.1, §5.3–5.6, §8.7.1, §8.12.5, §15, §18.2–18.3,
§18.8). This plan brings the runner, cf-harness, the FUSE adapter, and the
runsc-cfc sandbox into conformance with that text.

Every item is a small pull request that keeps the tree working. None adds a
flag or a compatibility mode: the replaced behavior is deleted in the same
change. Each pull request updates the live documents that describe what it
changes, and each item is ordered by the demo step it unblocks: the hostile
fetched skill (CT-2091) or two connectors joined into one dashboard (CT-2189).

## Rules that hold across items

- **Two operators.** Value labels combine by confidentiality join and the
  class-aware integrity meet (§3.1.6.2). A node's `pc` updates by
  confidentiality join and the plain integrity intersection (§3.4).
- **Exchange** never modifies a persisted label. It is evaluated wherever a
  label is consumed. A value-intrinsic rule's result travels with derived
  values, with the evidence that satisfied it recorded as a `TransformedBy`
  witness; that witness is the only record of why the derived value is less
  confidential, because the rule cannot fire again later. Boundary-scoped and
  grant-guarded results are evaluated per access and never travel (§5.3).
- **No execution provenance before measurement.** A sandbox output carries no
  `TransformedBy` until runsc-cfc measures what ran. Until then the requested
  script and standard-input digests and the input references live in the
  harness run record, which is audited but is not an integrity claim.
- **Ordering.** Source-entry caveats (runner-2, harness-1) land only after
  sink-fit disposition (harness-5). Otherwise every command output after the
  first fetched skill becomes opaque.

## Wave 0: floors

Independent of each other; each changes one seam.

- [ ] **fuse-1 · Read-only Fabric mount** (CT-2313). A harness-provisioned
  `fabric-fuse` bind is always read-only; an explicit writable request is
  refused before Docker. The writable path waits for a trusted writeback
  transport.
- [ ] **runner-1 · Registry correction** (CT-2315). The integrity propagation
  map lists only integrity families, with the §15 classes; `Caveat`,
  `Resource` and `Origin` leave it. Add `ConnectorObserved` and
  `NetworkProvenance` carriers and mint-gate entries. `LlmDerived` is removed
  later, with runner-5.
- [ ] **runner-3 · Exact `TransformedBy`.** One fresh atom per operation,
  `{codeHash, operation?, inputs: [{ref, witnesses?}]}`, keeping the existing
  input-witness substrate and deleting the `{identity, inputWitness}` form and
  every reader of it. `codeHash` comes from a build-stable artifact identity,
  not a function's source text.
- [ ] **runner-3b · Builtin `codeHash`** (after runner-3). A builtin's
  `codeHash` covers the shipped implementation, not only its builtin id.
- [ ] **runner-7 · Untrusted-label parser** (CT-2314). One runner-owned parse of
  a label from untrusted JSON; unparseable refuses rather than reads as
  unlabeled. No callers in this change.
- [ ] **runner-8 + harness-9 · One sink decision** (CT-2314). The host-side
  release check and the committed sink share one exchange-aware decision. The
  host check never consumes single-use grants, so rules that need one fail
  closed there.
- [ ] **gvisor-2 · Protected label xattrs** (runsc-cfc). Both spellings of every
  CFC label xattr are hidden from and refused to sandboxed processes, including
  root, with a kernel-internal path kept for the trusted transport.

## Wave 1: the agent node and what it observes

- [ ] **harness-4 · Agent-kernel node.** A per-turn node carrying `pc`, its
  confidentiality ceiling, and an observation policy, with explicit rebaseline
  and child attenuation: a child may admit more caveat kinds, never wider
  confidentiality. Sibling tool calls already use the turn-start `pc`.
- [ ] **harness-5 · Sink-fit disposition** (CT-2314). Whether a sandbox output
  is observed or opaque is the fit of its label against the node's ceiling and
  observation policy, not whether its label is empty.
- [ ] **runner-9 · Exchange on consumption** (after runner-3). Value-intrinsic
  rules applied at observation and at store fit, carried with their witnesses;
  no cache.
- [ ] **harness-6 · Cell-by-handle labels.** Reading a cell through a handle
  returns its exchanged label and a stable reference, and counts as an
  observation.

## Wave 1b: labels at the source (after harness-5)

- [ ] **runner-2 + harness-1 · Fetched sources** (CT-2315). A fetch admits bytes
  with `Origin`, both prompt caveats on free text, and `NetworkProvenance`
  beside `ExternalIngest`; recognized legacy caveat spellings are normalized or
  refused.
- [ ] **harness-2 · Connector sources** (with the Service). Rows arrive in an
  authenticated envelope carrying `User{subject}`, a stable source reference,
  the full label, and the owner-release policy reference of display-2; rows
  without one are refused.

## Wave 1c: a visible dashboard (CT-2189)

A module policy may rewrite only a clause that carries its reference (§5.3.2),
so the release of connector data is arranged where its label is created.

- [ ] **display-0 · The display consults policy.** The render resolver loads the
  policy manifests of the spaces a label came from and the standard
  prompt-caveat profile, beside its existing `Space` rule.
- [ ] **display-1 · Disclosure evidence.** Trusted UI that shows a disclosure
  mints `DisclosureRendered` bound to that display, and the prompt-influence
  caveat is released by the discharge rule rather than by kind.
- [ ] **display-2 · Owner-release policy at the source.** A standard module
  policy, guarded on the owner's role, whose reference the Service attaches to
  each `Resource` and `Origin` clause at source entry.
- [ ] **display-3 · Screened display text.** Releasing an injection-risk caveat
  requires `InjectionSafe` on the exact value (§10.1). Amounts, dates and counts
  get it from trusted schema sanitization; free text is shown redacted until an
  ingestion-time detector exists.

## Wave 2: writes, mounts, model output

- [ ] **runner-4 · Privileged external-write transaction.** Value, label and
  generation commit together; the one write seam for FUSE and sandbox
  ingestion.
- [ ] **runner-6 · Store fit options.** `ifc.upgradable`, and option 2's atomic
  tightening through runner-4.
- [ ] **harness-3 · Mount records** (CT-2313). Every mount is recorded; a host
  bind without its own labels falls back to `Origin{file://…}` plus both prompt
  caveats with empty integrity; an unrecorded mount is refused.
- [ ] **harness-7 · Run-record provenance.** Input references beside the
  recorded digests, and an explicit `stdin.role = "program"` in the invocation
  context so the sandbox can measure a program read from standard input.
- [ ] **runner-5 + harness-10 · Model output** (CT-2315). A model-authored value
  carries its turn's confidentiality and a fresh `TransformedBy`; `LlmDerived`
  is removed.

## Wave 3: measured execution (runsc-cfc)

- [ ] **gvisor-1 · Canonical atoms**: the runner's structured atoms, propagation
  classes and the two operators inside the sandbox.
- [ ] **gvisor-3 · Mount labels** from the invocation record.
- [ ] **gvisor-4 → harness-8 · Tighten on write**: a write raises the file's
  label before the effect instead of being refused, and fails closed where the
  label cannot persist; `edit_file` then works on existing files.
- [ ] **gvisor-5 · Influencing-input references** per invocation.
- [ ] **gvisor-7 · Measured execution bundle**, including program standard input.
- [ ] **gvisor-8 · Result v2**: one bundle per invocation and one evidence record
  per created or tightened output; the runner then mints execution
  `TransformedBy` from it.

## Not in this plan

A writable Fabric mount and the rest of the FUSE writeback path, full path and
namespace mediation in the sandbox, and the two §8.10.6 questions open in
`commonfabric/specs#33`.
