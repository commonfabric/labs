# CFC per-write read-prefix provenance (Epic D4) — soundness review

_Epic D, stage D4, of
[`docs/history/plans/cfc-future-work-implementation.md`](../history/plans/cfc-future-work-implementation.md).
This doc is a **soundness review** of the plan's proposed prefix approximation,
grounded in the CFC spec (`commonfabric/specs` `cfc/08-09-runtime-label-propagation.md`
§8.9, §8.9.1, §8.9.2). It found a real unsoundness in the plan text and fixes the
design before code lands. Written 2026-07-02 at owner request; amended
2026-07-03 (overlap-keyed bound, read positions in the digest, §8.9.2
citation)._

## 1. What D4 proposes and why

Today the `requiredIntegrity` gate (`verifyInputRequirements`) and the D3
write-side floor (`verifyWriteFloor`) quantify over the **transaction-global**
consumed-read set: *every* labeled read in the transaction must satisfy the
floor of *every* protected write. Two costs:

- **False rejects (audit S7).** An unrelated protected write is rejected because
  some *other* part of the transaction read low-integrity data. The current
  mitigation (`isProvenanceOnlyConsumedLabel`) is a blunt, transaction-global
  exemption.
- **Vacuous pass (audit #14).** A floor-declaring write whose consumed set is
  empty passes today (the gate only fires when `gatedReads.length > 0`). It
  should fail — no endorsed input means the floor is unmet.

D4's idea: gate each protected write on only the reads that **actually fed it**,
approximated by the reads that occur *before* the write in the transaction
journal (which orders reads and writes). The plan calls this the "prefix
approximation … strictly tighter than transaction-global; not value-level
dataflow, stated honestly."

## 2. What the spec actually requires

`08-09` §8.9.2 (*Propagation Algorithm* — *Normative definition,
`computePcConfidentiality`*) defines the consumed set `O` as **every read
recorded in the attempt's transaction journal** — transaction-global — plus
trigger/gating reads. §8.9.1's normative profile sets the baseline label
`L_default`, the conservative label "from all observable inputs plus PC
taint." So the spec's baseline is exactly today's transaction-global gating.

§8.9.1 (*Trusted Flow-Precision Claims* — *Decomposition before claims*) is
the only sanctioned way to be **more precise** than `L_default`, and it names
exactly two mechanisms:

1. **Transaction decomposition** — running a sub-operation in its own
   transaction whose journal *does not contain* the other reads. Then pointwise
   precision is a **structural fact**; no trust gate is involved.
2. **Trusted flow-precision claims** — a precision claim (`L_claim` less
   restrictive than `L_default`) is only honored when the executing
   implementation identity is trusted for the concept `flow-taint-precision`;
   otherwise the runtime MUST fall back to `L_default` (or reject).

**The prefix heuristic is neither of these as written.** The journal *does*
contain all the reads (one transaction), so it is not decomposition; and the
plan proposes to apply it unconditionally, not behind the `flow-taint-precision`
trust gate. So the review question is: **is the prefix a sound structural fact
(like decomposition), or an untrusted claim (which the spec forbids applying by
default)?** The answer depends entirely on which bound is used.

## 3. The unsoundness in the plan's bound

The plan says: gate a write on "reads with `journalIndex <` the write's **first
attempt**." This is **unsound** under write re-attempts.

Counterexample (single transaction, one path `P`, floor declared on `P`):

| journal index | activity |
|---|---|
| 5 | write `P` = a (first attempt) |
| 7 | read `R` (low-integrity) |
| 9 | write `P` = f(R) (re-attempt — the committed value) |

`P`'s committed value at index 9 **depends on `R`** (index 7). But the
first-attempt bound is 5, so the gate quantifies over reads before index 5 —
**excluding `R`**. A low-integrity value flows into a floored write and the gate
misses it. This is a real taint escape, not a mere false-accept of noise.

Re-attempts are not exotic: a reactive recompute, a retry, or a
read-modify-write of the same path all produce write-then-read-then-write on one
path within a transaction.

## 4. The sound bound: the last OVERLAPPING write attempt

Gate a write to path `P` on the reads with `journalIndex <` the **last write
whose target overlaps `P`** in the journal — overlap meaning **either prefix
direction**: the write's path is a prefix of `P` (an ancestor rewrite replaces
`P`'s value wholesale) *or* `P` is a prefix of the write's path (a child write
recomputes part of `P`'s subtree). This is exactly the floor-applicability
predicate already in the code (`ifcEntryAppliesToAttemptedWrite`,
`cfc/prepare.ts`: `concretePathHasPrefix(path, writePath) ||
concretePathHasPrefix(writePath, path)`), and the bound must use the same
match.

**Exact-path keying is NOT sufficient.** Because floor applicability matches
both prefix directions, keying "last write" on the exact address `P`
re-creates §3's taint escape one level down:

| journal index | activity |
|---|---|
| 5 | write `P` = a |
| 7 | read `R` (low-integrity) |
| 9 | write `P.child` = f(R) |

The write at index 9 targets `P`'s subtree — it is a later **overlapping**
write that consumed `R` — but a log keyed on the exact address `P` puts the
bound at index 5 and excludes `R`. The floored value at `P` commits with
low-integrity taint the gate never saw. The mirror case (floor on `P.child`,
late ancestor write to `P`) escapes the same way.

Soundness argument — this *is* a structural fact from the journal order, on par
with decomposition:

- The committed value of the subtree at `P` is fixed by the **last** write
  overlapping `P`. Call its index `w`.
- Any read at index `> w` occurs after `P` was finalized. No later write
  touches `P`'s value at any path — neither `P` itself, nor a descendant, nor
  an ancestor (by definition of "last overlapping") — so nothing recomputes any
  part of `P` from that read. Therefore a read after `w` **cannot** have fed
  `P`'s committed value.
- `P`'s own value is a plain datum or a *reference*; if it is a link, the
  reference was fixed at or before `w`, and the link target's label is tracked
  separately by the link machinery (§8.11) — not by `P`'s prefix.
- Reads at index `< w` are exactly the observations that *could* have fed any
  of the overlapping writes contributing to `P`'s committed value, up to and
  including the finalizing one. Keeping all of them is conservative within the
  dataflow-to-`P` question.

So the last-overlapping-write prefix drops only reads that provably did not
feed the value — the same character of structural argument §8.9.1 makes for
decomposition ("the journal simply does not contain the other elements"). It is
**not** an untrusted `L_claim`, so it does **not** require the
`flow-taint-precision` trust gate. It is a permitted precision, and it is sound.

The first-attempt bound fails this argument (reads between the first and last
write to `P` are dropped though they can feed the re-write). Exact-path
last-write keying fails it too (reads between the last write to exactly `P`
and a later overlapping write are dropped though they feed `P`'s committed
subtree). The last-overlapping-write bound satisfies it. **Use the last
overlapping write, matched in both prefix directions.**

### Trigger reads (§8.9.2 / H5)

Trigger reads have no journal index — they are the addresses whose invalidating
writes *scheduled the run*, i.e. they logically precede every write in the
attempt. They must be assigned index `−∞` (before all writes) so they gate
**every** protected write's prefix. Anything else would let the scheduling
channel escape the per-write gate. (H5 already folds trigger reads into the
transaction-global gate; D4 must keep them in every prefix.)

The address a trigger read names is the run's own read whose value the write
changed: the scheduler compares the value at each path the run read, and a
change at one of them is what schedules the run. A write that creates or
replaces a whole document schedules a reader of one field through that field,
so the labels of the document's other fields, which a change to them alone
would not have scheduled the run, do not join it. A trigger read is charged as
the same read in the journal is: one that names an array's `length` observes
the array's membership, so it also joins the labels that apply at the array
itself, such as an `observes: "enumerate"` or `structure` entry.

## 5. Consequences for the two payoffs

- **Vacuous-pass fix (#14).** Under the last-overlapping-write prefix a floored
  write whose prefix has **no** gating reads had no endorsed input and MUST
  fail. This is now sound *because the prefix is a true dataflow bound* — the
  reason the in-code comment (`isProvenanceOnlyConsumedLabel`, prepare.ts) says
  the #14 tightening "is unsound to apply without (a)": (a) is exactly this
  prefix, and it must be the *sound* (last-overlapping-write) prefix.
- **S7 narrowing.** The provenance-only exemption can shrink: a provenance read
  that occurs *after* the last write overlapping a protected path no longer
  gates it (it couldn't have fed it), so the exemption is needed only for
  provenance reads *within* the prefix. Port the group-chat regression scenario
  as a test.

## 6. Digest binding is mandatory (not optional)

The decision now depends on **journal order** — for each protected path, the
index of its last overlapping write and the set of read indices below it. But
`canonicalizePreparedDigestInput` (`cfc/canonical.ts`) **sorts `consumedReads`
and `writes` by address**, discarding order, and `ConsumedRead` (`cfc/types.ts`)
carries **no journal position at all**. So the prepare→commit digest recheck
would NOT detect a post-prepare reordering that changes which reads fall in a
write's prefix — a verification bypass (audit S2 shape).

Two requirements, both mandatory:

1. **Ordered write-attempt log, full addresses.** `PreparedDigestInput` gains
   an ordered log of **every** write attempt
   (`{ target: CfcAddress, journalIndex: number }`, in journal order),
   canonicalized **order-preserving** (or by `journalIndex`). It must NOT be
   reduced to one entry per exact address ("each path's last write"): the bound
   is the last *overlapping* write (§4), and computing it for a protected path
   `P` requires the write targets at their full paths, so the recheck can apply
   the same both-directions prefix match as floor applicability. An
   exact-address-keyed log cannot answer overlap queries and re-admits the §4
   aliasing escape at verification time.
2. **Read positions join the digest too.** A write-attempt log alone binds only
   the writes: with `consumedReads` sorted by address and carrying no index, a
   post-prepare reorder that moves a read from one side of a write to the other
   flips its prefix membership **without changing the digest** — exactly the S2
   shape this section exists to close. Each consumed read's `journalIndex` (or,
   equivalently, the full interleaved read|write activity order) MUST be part
   of `PreparedDigestInput` and survive canonicalization. **Source the order at
   the extended-transaction/CFC recording layer, backend-independent** — a
   per-transaction monotonic index stamped where `buildPreparedDigestInput`'s
   inputs are recorded (`getReadActivities()` / the reactivity log,
   `storage/extended-storage-transaction.ts`). Do NOT build the contract on
   `tx.journal.activity()`: that is a legacy-journal seam —
   `V2TransactionJournal.activity()` throws (`storage/v2-transaction.ts`), and
   V2's reactivity log reconstructs writes by sorted path, not temporal order.

Any post-prepare activity that changes the read/write interleaving then
invalidates the preparation. This is the same discipline
`trustSnapshot`/`policySnapshot` follow and is listed in the plan's
cross-cutting register — the review confirms it is **load-bearing for
soundness**, not bookkeeping.

## 7. Verdict and implementation constraints

D4 is sound **iff** it is built as follows:

1. **Bound = last write overlapping the path** — either prefix direction,
   matching floor applicability — not first-attempt and not exact-path
   last-write (§3–4). Trigger reads at `−∞`.
2. Framed and documented as a **structural precision fact** (§8.9.1
   decomposition-class), so it needs no `flow-taint-precision` trust gate — but
   the framing must be stated so a future reader does not mistake it for an
   untrusted `L_claim`.
3. **Journal interleaving in the digest** (§6) — the ordered full-address
   write-attempt log **and** consumed-read journal positions. Both mandatory.
4. Applies to the `requiredIntegrity` gate and the D3 write floor; the
   confidentiality **egress ceiling** stays transaction-global (a sink request
   records no per-write provenance — §8.10 / `collectConsumedConfidentiality`
   comment — so the whole consumed set is the sound over-approximation there).
   _Owner note: keeping the ceiling transaction-global while classing the
   integrity-side prefix as §8.9.1 decomposition is itself a
   spec-interpretation call — consider recording it as an SC entry in
   [`cfc-spec-changes.md`](./cfc-spec-changes.md)._
5. Red-first tests: the §3 re-attempt counterexample **rejects** under the
   last-overlapping-write bound (and would pass under the buggy first-attempt
   bound — a regression guard); the §4 child-write aliasing counterexample
   **rejects** (and would pass under exact-path keying); empty-prefix floored
   write fails; a post-prepare reorder — a write reorder *or* a read moved
   across a write — invalidates; the S7 group-chat scenario passes.

Stated honestly (as the plan asks): this is a **dataflow approximation**, but a
*sound* one — it never drops a read that could have fed the value. It is tighter
than the spec's `L_default` only in the decomposition-permitted direction.

## Implementation note (2026-07-06, the code PR)

Landed per §7 with two reconciliations, both recorded as
[SC-23](./cfc-spec-changes.md):

- **Order source.** As §6 requires, the order is stamped at the recording
  layer, backend-independent: one per-transaction monotonic **activity
  clock** in `V2StorageTransaction` shared by read activities
  (`IReadActivity.journalIndex`) and a new ordered **write-attempt log**
  (`getWriteAttemptLog()`, one entry per applied write, raw full-fidelity
  paths). Value-equal writes the storage layer elides never enter the log —
  it carries exactly the write set every other inspection surface sees. In
  the digest the clock values are **rank-normalized over the
  decision-relevant set** (non-internal reads + attempts): raw values would
  also encode how many runtime-internal verifier reads interleaved, which
  must not perturb the enforcement identity of otherwise-identical
  transactions; ranks preserve every relative order the gate consumes, so
  the §6 invalidation property is intact.
- **Vacuous-pass fix (#14) lands as a delegation, not a new rejection.**
  D3's write floor (§8.12.4.1, dial `cfcWriteFloor`) already rejects an
  empty-prefix floored write with no credited value under `enforce` — the §5
  end state — and its dial-off/observe byte-compat is pinned by tests as the
  staged-rollout contract. An unconditional read-side rejection would either
  duplicate the floor's reason under `enforce` or break that compat, so the
  read gate treats an empty prefix as "the value's own (evidence-gated)
  endorsement is the only possible input" and defers to the floor's dialed
  check. What the prefix contributes is exactness: an empty *prefix* means
  this write provably had no labeled input, so value-side judgment is the
  complete story for it — with the old *transaction-global* set that
  inference was only valid when the whole transaction read nothing labeled,
  which is why the old in-code comment called the #14 tightening unsound to
  apply without per-write provenance.

## Provenance

Grounded in `commonfabric/specs` `cfc/08-09-runtime-label-propagation.md`
§8.9.2 (*Propagation Algorithm* — the normative `computePcConfidentiality`
definition and trigger-read joining), §8.9.1 (*Trusted Flow-Precision Claims*
— *Decomposition before claims*, the `flow-taint-precision` normative
profile), and §8.9 read-time-journaling rationale; the runner seams are
`verifyInputRequirements`/`verifyWriteFloor` (`cfc/prepare.ts`),
`ifcEntryAppliesToAttemptedWrite` (`cfc/prepare.ts`, the both-directions
overlap predicate the §4 bound must match), `isProvenanceOnlyConsumedLabel`
(the #14/S7 comment), `buildPreparedDigestInput`/`getReadActivities`
(`storage/extended-storage-transaction.ts`, the recording layer where §6's
order stamp must live — the legacy `tx.journal.activity()` seam cannot carry
it: `V2TransactionJournal.activity()` throws, `storage/v2-transaction.ts`),
`ConsumedRead` (`cfc/types.ts`, which carries no journal position today), and
`canonicalizePreparedDigestInput` (`cfc/canonical.ts`, the address-sort that
motivates §6).
