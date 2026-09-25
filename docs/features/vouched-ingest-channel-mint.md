# Vouched Ingest Channel — the split-mint seam

How a runtime-minted `ExternalIngest` mark is attached to data that arrived
from an outside source, so that the untrusted bytes and the trusted mark never
share an authoring identity. The
[ingest channels and journal sink plan](../plans/ingest-channels-journal-sink.md)
builds on this seam.

`ExternalIngest` is one provenance family with two type-level variants. The
vouched-channel variant described here carries the channel and the audience
the grant vouches for. The weaker `kind: "fetch"` variant carries only a
`pinnedSource` URL and commit SHA: the trusted host attests to the immutable
source it read, and nobody vouches for a presenter or audience. The fetch
variant therefore has no `audience` field for a later policy to
equality-consume as though it were a grant claim.

The obvious construction — push the mark into the builtin-authored flow join,
the way `TransformedBy` is minted inline — is both unsafe and incorrect. The
two sections below say why, and each gives the construction the runtime uses
instead. The contract is the same in either case: same atom, same invariant.

## An unconditional flow-join push would be a forge oracle

`TransformedBy` is unforgeable because of a **two-part interplay**: (a)
`gateRuntimeMintedIntegrity` (`prepare.ts:~2680`) strips runtime-minted atoms
from any write whose authoring identity is not `builtin`, screening on the
**per-write captured identity**; and (b) `deriveFlowJoin` mints `TransformedBy`
**only** when `writeIdentity.identity` is defined and uniform
(`prepare.ts:~1372`).

Untrusted pattern/handler code **does** reach `cell.tx` (the SES sandbox does not
interpose on host `IExtendedStorageTransaction` methods —
`ses-runtime.ts` / `query-result-proxy.ts`). So a method like
`setCfcExternalIngest` on the public interface, feeding an **unconditional**
`ExternalIngest` push into the builtin-authored flow join, would let *any*
handler stamp a trusted "this arrived via external source X" mark on its own
outputs — and because the push is builtin-authored by construction, the gate
is a no-op for it. That is strictly worse than the existing atoms, which are
all screened on write identity.

**Resolution:** the ingest stamp lives **off** `IExtendedStorageTransaction`,
in a runner module-private `WeakMap<tx, meta>` (mirroring the posture of
`setCfcSinkMaxConfidentiality`, which is deliberately not on the public
interface). It is set only by trusted host code (the toolshed `custodyIngest`
helper for vouched channels, or a pinned-fetch helper), via a runner-internal
helper that pattern code cannot import or reach. The mint reads the stamp from
the same module. No public surface ⇒ no forge oracle.

## Piggybacking the flow join is broken for appends

`cell.set([...arr, x])` (the live webhook idiom, `webhooks.utils.ts`) diffs
**element-wise** (`data-updating.ts` `normalizeAndDiff`): an append writes at
`[...P, "N"]` and `[...P, "length"]`, **never at the array path `P`**. So:

- the flow-join's per-value clearing (`prepare.ts:~3392`, `isPrefix(written,
  entryPath)`) never fires for a prior mark at `P` — stale `ExternalIngest`
  marks, each frozen with the digest of whatever payload first wrote that path,
  **accumulate**;
- the fresh per-tx stamp lands on the element slot and on `length` — a digest
  of the whole payload stamped on "the integer 4." Dishonest.

**Resolution:** a **dedicated mint pass** in `prepareBoundaryCommit`, gated on
the ingest stamp, independent of the `flowLabels` dial:

1. **Anchor:** one `ExternalIngest` entry per ingest tx at the **ingest target
   path the helper declares** (the cell/path `custodyIngest` is writing into) —
   not per-written-path. A label entry there is a prefix of every read under it,
   so reads of the ingested data carry the mark. Honest and stable under
   element-wise diffing.
2. **Clear-by-origin:** drop any prior entry with the ingest origin at the
   anchor, then append the fresh one. The target carries the **latest** ingest's
   provenance (channel, time, payload digest). Per-element historical digests are
   **explicitly out of scope for v1** (operator-trusted ingest; the inspect-UI
   per-entry view is future work).
3. **Survives the gate** the same way the flow-derived component does: pushed
   directly into `persistedLabelEntries` with a runtime origin, never passed
   through `gateRuntimeMintedIntegrity`; the member-authored *payload* label is
   still gated (strips smuggled marks). Reuses the existing persistence tail
   (`targetKeys` + the privileged `writeOrThrow(["cfc"])`).

## Running prepare in an otherwise-CFC-disabled runtime

A runtime can be explicitly configured with `cfcEnforcementMode: "disabled"`
(the types-level `DEFAULT_CFC_ENFORCEMENT_MODE = "disabled"` is only the
bare-transaction fallback — toolshed runs at `enforce-strict`, which its
production preset pins through `presetCfcOptions` and the `Runtime`
constructor resolves to as well), and the pre-commit CFC
step early-returns when disabled — so the mint would never run there. Rather
than abuse `enforcement = "observe"` to force prepare (a smell: it's not
observing anything, and it desyncs ingest txs from the operator's real mode),
the ingest path adds an **explicit carve-out**: the step also proceeds when the
tx carries an ingest stamp ("run prepare to mint provenance even when
enforcement is disabled"). The step runs inside `commit()` as well as at
`Runtime.prepareTxForCommit` (see
[CFC commit preparation](../specs/cfc-commit-preparation.md)), so the mint
reaches an ingest commit either way. Documented and pinned with a test that
breaks if the early-return moves.

## Invariants the helper must hold (tested)

- `markCfcRelevant` is **load-bearing**: `flowLabelWorkExists` is false for a
  fresh (unlabeled) doc, so without explicit relevance the mint silently
  vanishes. The stamp setter marks relevance.
- `receivedAt` is **operator wall-clock**, captured **outside** the
  `editWithRetry` `fn` (retries must not re-stamp the time), and **never**
  accepted from the payload (preserves "touches zero attacker bytes").
- `valueDigest` is computed from the payload the helper actually writes.
- `audience` is **recorded, not enforced** (federation PR5 dependency); no
  downstream policy may read it as a verified binding yet. It exists only on
  the vouched-channel variant.

## What the seam shares with the ordinary atoms

Same `ExternalIngest` atom + constructor + `value-bound` class + gate
registration; same split-mint invariant; the payload bytes authored under the
ordinary member identity; the grant/ACL story unchanged; `prf` stays `[]`, `aud`
unset.
