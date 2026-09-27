# CFC observation classes (`PathLabelTemplate`) — design

_Epic C, stage C0, of
[`docs/history/plans/cfc-future-work-implementation.md`](../history/plans/cfc-future-work-implementation.md).
Spec: `commonfabric/specs` `cfc/04-label-representation.md` §4.6.3 (the
primitive read profile) and §4.5.2; the residuals are SC-4 / SC-8 in
[`cfc-spec-changes.md`](./cfc-spec-changes.md). This doc settles the semantics
before C1–C5 land code — the design has real open choices and they should be
written down first._

## 1. Problem

Today one label lives at a path and is consumed identically by every read,
regardless of what the read actually observed. That collapses distinct
observation channels that the spec (§4.6.3) keeps separate — `value`, `shape`
(existence/type), `enumerate` (membership/keys/length/order), `count`,
`followRef` (which reference sits at a slot). Two consequences, both documented
residuals:

- **SC-4 — existence channel.** When a derived label is *replaced* on overwrite
  (§8.12.8 replace-on-overwrite for the `derived` component), the replacement
  also shrinks the label covering **existence**: "this path was once written"
  becomes a public bit. Acknowledged in-code at `prepare.ts` (the derived-clear
  comment near the flow-read exclusion).
- **SC-8 — pointer-identity-at-a-slot.** Reading *which* reference sits at a
  slot without dereferencing it (a `linkResolutionProbe`) observes the link's
  identity, but that observation is currently **excluded** from the flow join —
  so the fact-of-which-element is unlabeled. The `structure` labelMap component
  is only a partial container-shape mitigation.

Both are under-restrictions of a *channel*, not of a value — exactly what
observation classes exist to separate.

## 2. What already exists (the substrate C builds on)

Better than the audit implied — most of the plumbing is present:

- **A provenance axis on the persisted entry.** `LabelMapEntry.origin`
  (`declared` | `link` | `derived` | `structure` | `external-ingest`,
  `packages/runner/src/cfc/types.ts`) already tags *update discipline*. This is
  orthogonal to the *consumption* axis this epic adds.
- **Reads already distinguish shape.** `IReadActivity.nonRecursive`
  (`storage/interface.ts`) marks shape-only observations (key-add, length);
  `linkResolutionProbe` (`storage/reactivity-log.ts`) marks "is there a link
  here?" probes — currently *excluded* from flow taint (this exclusion **is**
  the SC-8 residual).
- **Read-side resolution already threads `nonRecursive`.**
  `effectiveReadLabel(metadata, logicalPath, nonRecursive, { excludeLinkOrigin
  })` inside `deriveFlowJoin` (`prepare.ts`) already selects labels by a
  boolean shape flag and by origin.
- **The `structure` origin already labels container shape** at exact paths
  (`prepare.ts` persist region), applying to reads *at* the container path and
  to recursive ancestor reads, never to reads strictly below it (per the
  `types.ts` component contract and the SC-7 note in `cfc-spec-changes.md`).

So C is a *refinement* of existing axes, not new machinery.

## 3. Design decision: an additive `observes?` axis

Add an optional consumption axis to the persisted entry, orthogonal to `origin`:

```ts
// Shown for illustration only.
type LabelObservationClass = "value" | "shape" | "enumerate" | "followRef";

type LabelMapEntry = {
  path: readonly string[];
  label: IFCLabel;
  origin?: LabelEntryOrigin; // update discipline (unchanged)
  observes?: LabelObservationClass; // consumption class (NEW; absent = covering)
};
```

- **`origin` stays the update-discipline axis; `observes` is the consumption
  axis.** They are independent: a `derived` entry can be `observes:"value"`, a
  `structure` entry `observes:"shape"`, etc.
- **Absent `observes` = a covering entry** consumed by *every* read class. Every
  legacy (pre-C) entry is therefore covering, so a class-unaware reader
  over-taints (fail-safe) and old persisted data needs no migration. This is the
  same wire-compat move as the clause `anyOf` wrapper in Epic A.
- **One carve-out, forced by the §6 parity contract: legacy `origin:"link"`
  entries.** Read literally, "absent = covering" would make a plain value read
  start consuming link-origin entries — but today `deriveFlowJoin` *drops*
  them via `excludeLinkOrigin`, so the literal reading would break §6's
  byte-identity contract for `value`/`shape`/`enumerate` reads on day one.
  Normative rule: **an entry with `origin:"link"` and absent `observes` is
  implicitly `observes:"followRef"`** — consumed by `followRef` reads only,
  never as a covering entry. This reproduces today's behavior exactly
  (dropped for value reads), and the followRef consumption it enables is the
  new SC-8 behavior, arriving under §9's reader-first rollout. Every other
  origin keeps the plain covering rule.

**Alternative considered and rejected:** a single `PathLabelTemplate`-shaped
entry carrying per-class label fields (`{ value?, shape?, enumerate? }`). It
loses on two counts: (a) wire-compat — a template entry is not a covering
entry for old readers, so it needs migration; (b) it duplicates the existing
longest-prefix resolution machinery, whereas additive per-class entries reuse
it unchanged. Additive entries win.

## 4. Read-classification table (the SC-8 normative mapping)

Which observation class(es) each concrete runtime read consumes at its path.
A read consumes the join of every entry whose class is in its consumed set:

| Runtime read | Consumes classes | Notes |
|---|---|---|
| recursive value read | `value` + `shape` + `enumerate` | reading content also reveals presence/type and, for containers, membership |
| `nonRecursive` read (key-add, length) | `shape` + `enumerate` | observes presence/cardinality, not element content |
| `linkResolutionProbe` / slot-pointer read (no deref) | `followRef` | which reference sits here — **stops being excluded**; consumes the link-origin entry's `followRef` class |
| dereference (follow a ref to its target) | the dereference trace pair it already is | unchanged; target read classified at the target path |

The load-bearing change is the third row: the `followRef` observation, today
dropped from the flow join, becomes a consumed class carrying the link entry's
label — closing SC-8.

Two runtime reads have no row here, though the walk classifies them like any
other: the stream-marker probe the write path makes to choose between an
event send and a stored write, and the diff's read of the address it is about
to write. `deriveFlowJoin()` drops them after classification, so neither
consumes any of the classes above, and the walk's other consumers see them
unchanged. Per §18.6.2 each is a runtime-internal read rather than a handler
observation —
[`cfc-write-destination-reads.md`](./cfc-write-destination-reads.md) covers
them.

**Where `count` went.** The spec's fifth class (§4.6.3) deliberately does not
get its own axis value: a count observation (cardinality without membership)
is strictly weaker than `enumerate`, so count-shaped reads (length, `COUNT`)
consume the `enumerate` class — a sound over-approximation. A distinct
`count` value is additive later if a consumer ever needs the precision (e.g.
releasing a count more widely than membership); nothing in C1–C5 depends on
the distinction.

## 5. SC-4: existence grows, value replaces

On a value overwrite:

- **`observes:"value"` derived entries are REPLACED** by the committing
  attempt's derivation — the §8.12.8 replace-on-overwrite rule, unchanged. A
  less-tainted recomputation legitimately lowers the *value* label.
- **The `observes:"shape"` (existence) entry GROWS** — the join of the old and
  new derivation's flow labels. Existence reveals *every* writer across the
  path's history, so it must never shrink on overwrite. Stated explicitly
  against §8.12.8: replace-on-overwrite is a `value`-class rule; the `shape`
  class is monotone-growing like `declared`.

This is the crux of SC-4: separating the two classes lets `value` replace (the
precision win) while `shape` grows (the soundness fix), where today one label
does both and the existence bit leaks.

**C2 note (2026-07-03): existence entries carry confidentiality only.** "The
join of the old and new derivation's flow labels" above is a
confidentiality-channel rule. The persisted `observes:"shape"` entry does not
carry J's integrity: integrity composes by meet, never join, so growing an
existence entry's integrity across writers would *union* certification claims
— an over-claim. The `value` entry keeps the full J (confidentiality +
integrity, replace-on-overwrite); the frozen `structure` existence entry is
confidentiality-only for the same reason. Consequence: a
`nonRecursive` (shape) read of a split-labeled path taints with the existence
confidentiality but no longer inherits content certification into the
hereditary meet — an intended under-claim (SC-9's fail-safe direction).

**Derivation provenance on membership stamps.** The `structure` membership
stamps — the container's `observes:"enumerate"` entry and its `*`-child class
templates — are re-minted from the current join rather than frozen, so they
carry J's `TransformedBy` atom (and no other integrity). Without it a read of
the container node resolves confidentiality with no derivation evidence at all,
and an exchange rule guarded on `TransformedBy` cannot release an object a
single function computed. The atom is present only when the flow stage minted
it, which it does only when every non-privileged write of the transaction was
authored under one identity. Membership stamps survive a slot write that adds or
replaces a child, so attribution on any carried `derived` or `structure` entry
meets across the writers of its path: a transaction writing at, above, or below
the entry's path (for a `*` template, its container's) leaves on it only the
`TransformedBy` atoms its own join carries. A later writer under another
identity, or under none, therefore leaves the entry naming no function — also
when that transaction read nothing and carries no labels of its own, since a
write below a stamp carrying `TransformedBy` admits its document to the persist
step whatever the join. The meet covers `TransformedBy` only: a hereditary
integrity atom on an ancestor's `derived` entry still survives another writer
adding a child. The declared structure-container route (filter/flatMap result
containers) re-mints its stamps from each reconcile's join without writing the
container, so there the atom names the builtin that reconciled, not every writer
of every slot. The hereditary atoms stay off these stamps: they would feed the
next transaction's hereditary meet through container reads, which is a change to
certification propagation rather than to attribution.

**C3 note (2026-07-03, superseded 2026-07-06): grow shipped, then the
discipline was settled with the spec as freeze-at-creation.** C3's interim
fix grew the existence entry on every overwrite; running the open questions
against the spec (§8.12.8 as amended on specs branch
`cfc/existence-freeze-at-creation`) settled the final disciplines:

- **`observes:"shape"` (existence) entries FREEZE at creation**: minted
  once with the creating attempt's join (legacy pre-class entries are
  absorbed at the one-time migration, conservatively over-attributed to
  the first labeled stamping), never cleared and never grown by overwrites
  of a still-existing path. Soundness: a writer conditional on existence
  journals that observation itself (§8.10.1/§8.9.2). **Delete +
  re-create re-mints (resolved 2026-07-10)**: §8.12.8 makes re-creation a
  fresh creation event — the frozen entry is REPLACED at the re-creating
  attempt's join (`recreate_remints` in the spec's
  `formal/Cfc/StoreExistence.lean`), since carrying the stale join would
  UNDERSTATE the re-created path's existence channel, the direction the
  spec forbids. The carry in `prepare.ts` refuses a frozen entry whose
  path shows the per-path transition absent-before → present-after against
  the recorded writes' pre-transaction snapshots (`previousValue`, probed
  relative to each write's materialization point; the probes walk own-key
  PRESENCE — a slot holding `undefined` is present, per the storage patch
  layer — and at the recorded path itself the detail's `previousPresent`
  flag decides, with value-definedness as the fallback for transactions
  that do not provide it), and a
  replacement mints at the entry's own path with the current join — empty join mints nothing
  (a cleanly re-created path's existence is public; pre-deletion
  observations stay protected by their journaled reads). Remaining
  residual: deletion alone leaves the frozen entry in place until a
  re-creation (over-taint, the fail-safe direction — documentable).
- **`origin:"structure"` membership stamps are `observes:"enumerate"`**,
  replace-from-criteria per §8.12.8 (normative — its rationale names and
  rejects accumulate-forever). Axis-mapping note: the labs `observes` axis
  is read-op shaped, so labs `enumerate` at a container approximates the
  spec's container-level `iterate.{order,count}` label classes; the
  spec's per-child `shape` encoding of membership is a recorded residual
  (see SC note in `cfc-spec-changes.md`: a static per-child existence
  probe does not consume the container-anchored stamp).
- Cleared `link` entries never fold (pointer labels; folding them into
  content shape would re-smear the pointer/content split). Legacy
  migration conf not covered by any stamp path lands as a frozen shape
  entry at the shallowest covering written path, or the entry's own path.

## 6. What `deriveFlowJoin` consumes per read shape

`forEachFlowObservation` (`prepare.ts`) already visits each read with its
`nonRecursive` flag. C1 extends it to classify each observation (value / shape
via `nonRecursive` / followRef via `linkResolutionProbe`) and select entries by
class-compatibility rather than the boolean. `excludeLinkOrigin` becomes class
selection: link-origin entries are consumed by `followRef` reads.

Parity contract for C1 — **scoped, because SC-8 is an intentional behavioral
change, not a refactor.** Today `forEachFlowObservation` *skips*
`linkResolutionProbe` reads and `deriveFlowJoin` *drops* `origin==="link"`
entries via `excludeLinkOrigin: true` (`prepare.ts`). Two distinct effects:

- **value / shape / enumerate reads** must stay **byte-identical** on legacy
  covering entries — every such read consumes every covering entry, the current
  behavior. This is the real parity test.
- **the `followRef` path** deliberately **changes**: making a slot-pointer read
  consume the link-origin entry is exactly the SC-8 fix, so the derived join for
  that path is *wider* than today by design. The parity test must exempt this
  path (or assert the new, wider result) — it is not, and must not be, claimed
  byte-identical.

### 6.1 C1 code-validation refinements (2026-07-03)

Landing C1 (`cfc/observation-classes.ts`, `forEachFlowObservation` /
`effectiveReadLabel` in `prepare.ts`) validated the §4 mapping in code and
forced three refinements the text above leaves ambiguous. Each was measured
against the phase-B pointwise suite (`cfc-flow-pointwise.test.ts`), whose
reader-visible guarantees break under the naive readings; all three are
normative from C1 on:

- **followRef reads consume only followRef-class entries — covering entries
  are content.** §3's "absent `observes` = consumed by every read class"
  holds for the content classes (`value`/`shape`/`enumerate`) only. A
  followRef observation reads a pointer, not content: letting it consume
  covering entries would taint the terminal resolution probe of every blind
  pass-through with the target doc's content label, re-smearing the §2
  pointer/content substrate. Still strictly wider than pre-C1, which
  consumed nothing for probes.
- **The §4 row 3 / row 4 boundary is the dereference trace.** A probe issued
  while *following* a reference — its slot path covered at-or-above by a
  same-tx recorded trace source — is resolution machinery (row 4,
  unchanged); the follow's taint arrives via the ordinary reads of the
  target. Only standalone probes (no covering trace: `lastNode:"top"` link
  reads, raw link handles, unfollowed redirect checks) are row-3 followRef
  observations. Without this boundary every value read's own traversal
  probes consume each hop's pointer label, and a list coordinator's J joins
  every slot's transport label — the same pointwise re-smear.
- **followRef observations contribute confidentiality only.** The §8.9.3
  hereditary integrity meet quantifies over the transformation's *content*
  inputs; standalone probes rarely resolve any label, and admitting them
  would empty the weakest-link meet on virtually every transaction,
  silently ending TransformedBy / PolicyCertified propagation. Pointer
  integrity evidence stays on the link entry (the LinkReference chain).

### 6.2 The runtime's own wiring is the second non-standalone probe (2026-09-16)

The dereference trace of §6.1 is not the only thing that makes a probe
something other than a standalone observation. A probe carrying the
machinery marker (`machineryRead`) is one the RUNTIME issued while wiring an
operation up or plumbing a result, and no pattern or handler code runs inside
a marked scope. §4.6.3's reference-identity row is about a read the
computation made and then did something with; what a wiring probe does with
the reference it finds is write that same reference into another slot, and
the link write carries the source document's label to that slot as an
`origin:"link"` entry. The pointer's protection therefore arrives pointwise
at the destination without the flow stamp, and joining it into the stamp as
well spreads it over every other path the wiring transaction wrote.
`forEachFlowObservation` skips a marked probe alongside a trace-covered one,
so such a read consumes nothing; a marked read that materializes content is
unaffected and keeps consuming its ordinary labels.

The measurement that forced this: at the strict dials with server execution
on, `packages/patterns/integration/cfc-render-policy-demo.test.ts` lost each
sub-piece's entire user interface to the §8.10.6 display ceiling. The
transaction that wired the two sub-patterns up probed the sigil interior of
the document holding the confidential health cell's reference, consumed the
`origin:"link"` entry there, and the §8.12.5 route-2 declaration then wrote
that clause at the ROOT of four documents at once — the sub-piece result
projections among them, so the ceiling denied their `$UI` whole. Four such
declarations per failing run before the skip, none after.

The list coordinators are the case this could have under-tainted. `map`,
`filter` and `flatMap` mark the presence probe and the slot-identity diffs
over their prior slots, and each of the three then differs in what it reads
outside that scope. `filter` reads every predicate result there, and `flatMap`
reads every child result there, so membership and content in those two still
depend on reads that taint. `map` reads no element value anywhere: it
republishes references, so the link-origin entry at each output slot is the
whole of an element's protection in its output.

That entry is what makes the exclusion sound, and it does not come from any
read. `list.set(members)` writes a link per member, and the link write mints
the source document's own label at the slot the link lands in, so a reader
reaching an element through the container consumes it there.
`cfc-template-population.test.ts` measures that over a labeled element, beside
the case that measures the marked probe adding nothing on top;
`cfc-reference-identity-reads.test.ts` measures the same route for a wiring
read that carries one reference onward.

## 7. Observation ceiling (LLM path) and render

C4 makes the two big consumers class-aware, both via the §4 table — same
classification, same longest-prefix resolution, applied to the ceiling fit
instead of the flow join:

- **LLM observation ceiling (`llm.ts` / llm-dialog).** Serializing a value
  into a prompt or tool context is a **recursive value read**: the ceiling
  fit consumes `value + shape + enumerate` entries at each serialized path.
  The genuinely new case is **opaque link handles**
  (`cfcOpaqueLinkForPath`): rendering WHICH reference sits at a slot without
  dereferencing it is a `followRef` observation, so an opaque handle
  consumes the link entry's `followRef` label only — not the target's
  `value` label. An opaque handle to a secret document taints the prompt
  with the pointer's label, not the secret's. Mechanically, the ceiling-fit
  path applies the same read-classification helper C1 adds for
  `forEachFlowObservation`; C4 settles which call site carries it.
- **Render label views** consume per-class the same way: a public `value`
  read of a child under a secret container `shape` no longer inherits the
  container's shape label (today the flat model takes the max).

That precision win is what pays for the epic on the LLM/agent surface.

## 8. Staging (C1–C5)

1. **C1 — read-shape plumbing.** Classify flow observations; `effectiveReadLabel`
   selects by class; `followRef` stops being excluded. Parity test: legacy
   covering entries → byte-identical derived join.
2. **C2 — persist split.** Write `observes:"value"` derived entries + a `shape`
   entry per written path; `structure` stamps become
   `origin:"structure", observes:"shape"`. Per-class idempotence (SC-11).
3. **C3 — the two channel fixes (red-first).** SC-4: overwrite keeps the grown
   existence/shape label. SC-8: reading which link sits at a slot now taints.
4. **C4 — consumer precision.** Observation ceiling + render views consume
   per-class; public child reads under a secret container shed the shape label.
5. **C5 — sqlite precision.** `deriveNullOriginIfc` narrows to the classes
   actually consumed.

## 9. Rollout

Two rollout regimes, because the mixed-version fail-safe holds for the additive
classes but **not** for the SC-8 change:

- **`value` / `shape` / `enumerate` — additively safe, no dial.** These are new
  covering-compatible entries; a class-unaware (old) reader consumes them as
  covering entries and **over-taints** (fail-safe). Persist-before-read is fine.
- **`followRef` (SC-8) — needs a reader-first (or dialed) rollout.** The
  fail-safe-by-construction claim does **not** hold here: a class-unaware reader
  does not treat a `origin:"link"` entry as covering — `deriveFlowJoin` **drops**
  it via `excludeLinkOrigin`. So if a new writer persists
  `origin:"link", observes:"followRef"` entries while old readers are live,
  those readers keep *dropping* the slot-pointer label — an **under-taint**, not
  a conservative over-taint. C2 must therefore either deploy the class-aware
  reader before the writer, or gate followRef persistence behind a dial flipped
  only after readers understand it. State this as a hard prerequisite for the
  SC-8 slice.

Perf: the labelMap grows ~2× entries per written path; bench
`cfc-label-sync-strategy` and `cfc-canonicalize` before/after. A spec PR to
`commonfabric/specs` records the §4.6.3 read-classification table and the SC-4
grow-vs-replace split when this doc settles (tracked in `cfc-spec-changes.md`).

## Provenance

Grounded in the C0 outline of `cfc-future-work-implementation.md` plus the
seam map over `cfc/types.ts` (`LabelMapEntry`/`LabelEntryOrigin`),
`storage/interface.ts` (`IReadActivity.nonRecursive`),
`storage/reactivity-log.ts` (`linkResolutionProbe`), and `prepare.ts`
(`forEachFlowObservation`, `effectiveReadLabel`, `deriveFlowJoin`, the persist
region). Residuals SC-4 / SC-8 are from `cfc-spec-changes.md`.
