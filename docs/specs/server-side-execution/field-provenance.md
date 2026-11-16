# v2 verification: field provenance — follow every value

**Verification instrument, NON-NORMATIVE** — the second of the pair
(see [scenario-traces.md](scenario-traces.md), which owns the
shared execution protocol). Traces evaluate the spec top-down along
thirteen hand-picked journeys; this audit is the bottom-up
complement: for each load-bearing FIELD, enumerate every producer,
every carrier hop, every consumer, and every retirement, and check
that the chain CLOSES on every path family — mechanically, over
all paths, not thirteen samples.

Origin (2026-08-03): every heavyweight defect of the review week
was one shape — *a value needed downstream, destroyed or dropped
at a hop*. The outbox losing the run's identity; the same-space
cascade event with no carriage at all (LT1); `actingSession`
missing from one of three metadata statements; the enacted-nonce
record dying at reload (LT8). Journeys catch these only where one
happens to walk the broken hop. Chains catch them wherever they
are.

## 1. Protocol

scenario-traces.md §1 applies verbatim (cite-or-GAP — never fill
by analogy; FLAG-don't-fix; CONTRADICTION-don't-pick; positive
evidence only; deferrals are answers; docs only, never code).
Audit-specific rules on top:

1. **The chain table.** Per field, four rows of life — BORN (who
   mints it, when, from what), CARRIED (every hop: commit
   metadata / write-level field / wire request field / engine
   table / outbox entry / client memory / client durable), CONSUMED
   (every reader and what it DECIDES), RETIRED (overwrite,
   compaction, GC, or never) — every cell cited.
2. **Closure verdicts, per path family** (§2): a field
   participating in a path must connect producer → consumer with
   no dropped hop. Report per (field, path): `CLOSED` |
   `BROKEN-AT: <hop>` | `N/A` (field does not ride this path —
   say why).
3. **Three structural checks** beyond closure:
   - **Orphan consumer** — a reader whose value has no producer on
     some path that reaches it;
   - **Dead producer** — a written value nothing ever reads
     (wire-shape discipline: flag it, it may be vestigial or
     load-bearing-elsewhere);
   - **Unsanctioned carriage** — the field rides a hop that
     protocol.md §7's closed metadata list (or its named
     sanctions: write-level event fields, the durable outbox rows) does not
     cover.
4. **Output format**: per field — the chain table, then the
   closure verdict lines, then structural-check results — followed
   by a FINDINGS section (GAP/FLAG/CONTRADICTION items only) and a
   per-cluster verdict line: `CLUSTER <X>: CLEAN | FINDINGS(k)`.

## 2. Path families

Check each field against the families it plausibly rides;
declaring `N/A` requires a reason.

- **P1 client-authored** — doc write / event append from an
  authenticated session (admission, stamping).
- **P2 server-derived wave** — seal → wave commit, including
  same-space cascade entries (write-level carriage) and the
  SpaceServer's own writes.
- **P3 delegated / outbox crossing** — cross-space event appends
  and `.inSpace` provisioning (metadata, validation, stamping at
  the target).
- **P4 effect completion** — memo miss → outbox → external call →
  completion commit (the derived commit that never passes
  sealing).
- **P5 recovery / activation** — crash, lease handover,
  recompute on demand, event reprocessing, park/activate.
- **P6 client lifecycle** — speculation overlay, offline queue,
  reload, push filtering, enact/ack.

## 3. The roster (sixteen fields, six clusters)

- **Cluster A — event identity**: `firedAt.user`,
  `firedAt.session`, `clientSeq`, `eventId`. All six families.
- **Cluster B — delegation & authority**: `actingPrincipal`,
  `actingSession`, `capabilityRef`, the effect authority handle.
  P2–P5.
- **Cluster C — instance & attribution**: `scope_key` in all four
  roles (storage row key, derived-commit ADDRESSING annotation,
  lease-holder read field, basis `action_scope_key` /
  `entity_scope_key`), the ATTRIBUTION acting-identity annotation
  (per action run), CFC per-run provenance labels. All families.
- **Cluster D — commit & watermark metadata**: `class`, `holder`,
  `derivedThrough` + the watermark doc (`W`), `eventWatermark`,
  `consequenceOf`. P1–P2, P5, P6 (settledness).
- **Cluster E — effect channel & memo**: `nonce`, `ackedNonce`,
  `issuedIn`, `requestHash` (the memo key), the outbox identity
  carriage (result-cell address + acting identity). P2, P4, P6.
- **Cluster F — client-side state**: `sessionId` itself (mint →
  persist → carry → retire → GC), overlay `origin` +
  `baseSeq`, the offline event queue's entries. P1, P3 (carried
  identity), P6, P5 (retirement/GC).

## 4. Reference chains

**Run 2026-08-03** — six Sonnet cluster auditors, Fable
adjudication. 29 raw findings → 8 determined-direction fixes
applied in the same batch (see the fold commit) + 16 consolidated
ledger items (§6) + a handful of dedups/downgrades. Compressed
per-cluster reference state below (the full chain tables live in
the run outputs; these lines are the diff baseline — a doc edit
touching a field's producer/carrier/consumer re-derives that
field's chain):

- **A — event identity.** `firedAt.user`/`.session`: CLOSED on
  P1/P2/P3/P5 (stamp → carry → consume → compact chains all cited);
  N/A on P4/P6 by field scoping. `eventId`: CLOSED everywhere it
  rides (the most-consumed field in the corpus). `clientSeq`:
  BROKEN-AT consumption on every path it rides — carried, stored,
  reload-preserved, read by NOTHING (→ FP5); its §1
  "identical shape" tension with LT7 was a contradiction in the
  LT1 fold text, FIXED (events §1 now carves it out).
- **B — delegation & authority.** `actingPrincipal`/`actingSession`:
  CLOSED on P3 (their home — seal → outbox → metadata → validate →
  stamp, including the LT4 rejection leg); N/A on P2/P4 (those
  carry Cluster C's unnamed annotations, not these named fields);
  BROKEN on P5 — nothing regenerates a lost outbox entry (→ FP1,
  the run's heavyweight). `capabilityRef`: consumed exactly once
  (grant validation), producer unstated (→ FP7). Effect authority
  handle: consumed by outbox/broker; "bound at wiring time" never
  mechanized (→ FP8).
- **C — instance & attribution.** `scope_key` storage-row role:
  CLOSED P1/P2/P4/P5/P6; the delegated-WRITE target keying is
  unstated (→ FP3) and the cross-space scoped READ cannot use the
  lease-holder read row at all (→ FP2, heavyweight). ADDRESSING
  annotation: CLOSED P2/P4, N/A elsewhere. ATTRIBUTION annotation:
  BORN/CARRIED closed, deliberately RECORDED-not-read today —
  now stated in protocol §1 (fix applied; consumers = audit +
  future signatures). CFC labels: the pre-commit gate is closed;
  post-commit label propagation and completion-commit labeling are
  open (→ FP6). testing §4's stale session-grouping gate: FIXED
  (reworded to the identity model).
- **D — commit & watermark metadata.** `class`, `holder`,
  `derivedThrough`/W, `eventWatermark`: CLOSED on their families,
  richly consumed; `consequenceOf`: closed EXCEPT the commit-split
  distribution, now FIXED (splits repeat the full list — the
  filtered-push argument made the direction determined). Watermark
  doc's `scope_key = "space"` now explicit (fix). Commit-log
  retention posture is the shared open (→ FP14); `class`'s wire
  origination is minor-open (→ FP15).
- **E — effect channel & memo.** `nonce`/`ackedNonce`: CLOSED on
  P2/P6 with LT8's accepted reload window; ack shape + stale-ack
  semantics open (→ FP11). `issuedIn`: DEAD PRODUCER — written,
  pushed, never read (→ FP12); its shape contradiction between
  builtins §4 and protocol §5 FIXED (§5 normative). `requestHash`:
  CLOSED P2/P4; the client-side "memo key differs" mechanism is
  uncited (→ FP16). Outbox identity carriage: CLOSED P2/P4; its
  missing §7 sanction FIXED (now named in §7).
- **F — client-side state.** `sessionId`: CLOSED P1/P3/P6; minting
  + uniqueness unstated — elevated by LT2's cross-space trust
  (→ FP9); TTL × durable-offline-queue interaction unstated
  (→ FP10); cross-space GC remains the acknowledged scopes §8
  item 2 open (cited deferral, not re-raised). Overlay `origin`:
  CLOSED P6. `baseSeq`: DEAD PRODUCER (→ FP12). The enacted-nonce
  record has no home in the overlay entry shape (→ FP11). Offline
  queue: CLOSED P1/P6 except entry-removal condition (→ FP13).

## 5. Findings routing

Identical to scenario-traces.md §5: GAP / FLAG / CONTRADICTION →
the PR rulings ledger; governing docs win until a ruling lands; a
ruling updates the affected reference chains in the same PR.

## 6. Open items from run 2026-08-03 (FP1–FP16)

Rulings needed; consolidated and deduped from the six clusters.
FP1 and FP2 are the heavyweights.

- **FP1 — lost outbox entries after a crash (B; P5) — RULED
  2026-08-03: durable append rows.** Cross-space event appends are
  engine-table rows written inside the emitting wave's own store
  transaction (basis-row carriage pattern, protocol §7 sanction),
  deleted on delivery-ack; activation re-sends pending rows;
  `eventId` horizon dedupes. EFFECT requests stay process-local
  (memo re-miss covers them); `.inSpace` provisioning needs
  neither — it is foreign-first SEQUENCED at the commit step, not
  outbox-carried (serving-loop §5, §6 step 5). Verified: the
  model's C2-FP1 flipped from characterization to closure.
- **FP2 — cross-space scoped reads (C; P3/P5) — RULED 2026-08-03:
  the read row widens to ANY live lease holder on the co-hosted
  memory server** (its own space's lease) — the read-side twin of
  the inter-server trust ruling, closing the silent-empty-instance
  trap cross-space and giving the basis `entity_scope_key` its
  population path. Anticipated hardening, out of v2 scope, named
  without design: grant-scoped foreign reads (protocol §2).
- **FP3 — delegated-write target keying (C; P3).** What feeds
  `scope_key` resolution for the WRITTEN rows of a server-produced
  authored commit at its target (no session exists there)?
  Candidate, symmetric with `firedAt` stamping: the validated
  carried acting identity.
- **FP4 — authored-commit push visibility (A; P6).** §3's
  `scope_key` filter is stated for `derived` commits. Are authored
  stream entries (carrying `firedAt.user` — who acted) pushed
  unfiltered to every subscriber of the stream doc? Presumably
  intended (a shared stream is shared data) — state the regime.
- **FP5 — `clientSeq` (A).** Carried, stored, reload-preserved —
  and read by nothing anywhere ("orders one session's own appends"
  names no mechanism). Name the consumer, or declare it inert and
  soften the "orders" language. Also state whether it crosses on
  delegation (candidate: no, per LT7's spirit).
- **FP6 — CFC label carriage (C; P2/P4) — RULED 2026-08-03, both
  halves, no new mechanism:** the carried provenance's reader is
  main's existing READ-TIME label derivation (a later run reading
  the cell seeds its ladder from the cell's labels — the carriage
  just makes that input available across waves; serving-loop §3c);
  and the effect completion's labels derive from the REQUEST's
  label basis, carried on the outbox entry with the identity
  carriage — an external result inherits its request's
  confidentiality, never default-unlabeled (serving-loop §4;
  protocol §7). RULED 2026-08-05, the basis is STRUCTURAL, not a
  frozen snapshot: the completion's writeback transaction re-reads
  the request inputs, so the labels derive from the basis AS IT
  STANDS at writeback — a tightening mid-flight yields the stricter
  label (conservative), a loosening matches today's OFF-arm
  write-time derivation exactly, and a frozen at-seal snapshot is
  REJECTED because it would write stale labels over a re-labeled
  basis.
- **FP7 — `capabilityRef` origin (B).** Grant minting/acquisition
  is never stated. If it is the existing capability system,
  deliberately not re-litigated, say so the way the ACL rows say
  "(existing ACL)".
- **FP8 — effect authority handle mechanics (B).** "Bound at
  wiring time" is stated three times and mechanized nowhere: what
  is wiring, where does the bound handle durably live, how does it
  differentiate per granting user for per-user runs, and does
  memo-miss re-fire re-resolve it identically post-crash?
- **FP9 — `sessionId` minting (F).** Who generates it (client or
  server), with what uniqueness guarantee — now that LT2 makes the
  same value a trusted identity component in EVERY space?
- **FP10 — session TTL × offline queue (F).** *(Re-tensed 2026-08-15:
  the queue is process-lifetime — LT9 re-ruled — so the reload half of
  this question is moot; the TTL half stands for a live client that
  reconnects after TTL with queued actions.)* A client
  reconnecting after TTL with queued actions: discharge fails?
  re-authenticate under a fresh session first (whose keys then
  differ)? TTL suspended while actions are queued?
- **FP11 — effect-channel client bookkeeping (E+F).** Where does
  the recorded enacted-nonce live (the overlay entry shape has no
  nonce field, yet three passages say "reconcile by nonce")? Is
  `ackedNonce` a scalar or a set, and what happens on a stale ack
  naming an already-retired entry (candidate: defined no-op)?
  (Ack half CLOSED 2026-08-13, RULED: a per-nonce map —
  `acks[nonce] = true` — and a stale ack IS the defined no-op,
  pruned by retirement as hygiene; protocol §5. The
  enacted-nonce-record home stays open.)
- **FP12 — dead fields (E+F).** `issuedIn` (written, pushed, never
  read) and overlay `baseSeq` (recorded, never read): name the
  intended consumer of each, or drop them from the shapes.
- **FP13 — offline-queue entry removal (F).** When does an entry
  leave the durable queue — on send, on admission ack, or on
  consequence arrival? (Candidate: admission ack; dedupe makes
  earlier removal unnecessary and later removal merely wasteful,
  while remove-before-ack risks losing an action to a
  crash-during-send.)
- **FP14 — commit-log retention (B+D).** Commit records and their
  metadata have no stated retention/compaction anywhere. If the
  posture is "engine-v3 unchanged, permanent, out of v2 scope,"
  one sentence in protocol §7 closes it for every future audit.
- **FP15 — who writes `class: "authored"` (D) — CLOSED 2026-08-03
  (by derivation, stage A dry-run):** `class` is SERVER-DETERMINED
  at admission, assigned by which admission row processed the
  commit — protocol §1's no-client-path-to-`derived` FORBIDDEN
  clause holds only if no client-supplied value can influence it.
  Stated in protocol.md §1.
- **FP16 — client-side memo-key comparison (E).** speculation §2's
  "if inputs changed so the memo key differs" implies a
  client-local hash comparison; does the client read the committed
  `requestHash` field, or recompute independently? Decides whether
  `requestHash` rides P6 at all.
