# TLA+ models: pending-stack commits and session delivery

`PendingStacks.tla` is a bounded, model-checked specification of the Memory v2
pending-stack commit protocol (`03-commit-model.md` §3.3–3.6), built to check
the invariant catalog (`09-invariants.md`) over **all** interleavings within
its bounds — including the interleavings nobody thought to hand-write a unit
test for. It reproduces the CT-1910 bug class as a machine-found
counterexample and certifies the repaired shapes. (The pre-#4606 scalar wire
shape — the legacy old-client/old-server dependency recording whose
under-recording produced the CT-1872 "1c" phantom — is deliberately not
modeled; only the shipped full-stack shape and the proposed overlap-filtered
refinement are.)

## Results

Checked with TLC 2.19 (the atomic configs finish in under a minute each, the
channel configs in one to three minutes, and the deep config in about five).
`IdentityMode` is `none` and `Values` is the single value `{"v"}` in every
row that does not say otherwise. It is the mode that keeps elision out of
those rows, not the alphabet: with one value a stale write of `v` onto a
path already holding `v` satisfies `IsIdentity` just the same, and would be
elided under `elide`. The single value is what leaves those rows' reachable
state graphs exactly the ones the earlier runs certified, to the digit.

| Config | DepMode | BasisMode | DeliveryMode | Result |
| --- | --- | --- | --- | --- |
| `PendingStacks_Current.cfg` | `fullstack` (shipped #4606) | `maxdep` (legacy: pending reads without `basisSeq`) | `atomic` | **ReadCoherence violated** — CT-1910: the pending-read staleness scan starts at the highest dependency's resolution seq, missing a foreign overlapping write that landed between the reader's confirmed basis and that seq. Kept as the regression witness for the legacy shape, which servers still serve. |
| `PendingStacks_Repaired.cfg` | `fullstack` | `confirmed` (CT-1910 repair — shipped: pending reads declaring `basisSeq`, scanned with own-session exclusion) | `atomic` | **All invariants hold** (14,504,005 distinct states, exhaustive at `MaxTotal = 4`). |
| `PendingStacks_Filtered.cfg` | `filtered` (proposed CT-1872 refinement) | `confirmed` | `atomic` | **All invariants hold** (same bound and state count). |
| `PendingStacks_Filtered5.cfg` | `filtered` | `confirmed` | `atomic` | **All invariants hold** at `MaxTotal = 5` with single-path writes (110.7M distinct states, ~5 min) — deep enough for a foreign write to reject a *middle* pending layer beneath a reader, the case where overlap-filtering actually drops a dependency. |
| `PendingStacks_Channel.cfg` | `fullstack` | `confirmed` | `channel` (delayed verdict delivery) | **All invariants hold**, including `AcceptedVersusDropped` (INV-6), at 39,966,805 distinct states, `MaxTotal = 4`, ~90s. Certifies the decided-but-unprocessed window: commits built there name decided-dead layers and are refused by the dead-dependency admission rule; commits built after the processed rejection's drop record sparse arrays (§3.5's view-relative completeness). Negative control: deleting `HasDeadDep` from `Process` violates `CascadeTotality` within a second — the rule is load-bearing, not decorative. |
| `PendingStacks_ChannelFiltered.cfg` | `filtered` | `confirmed` | `channel` | **All invariants hold** (39,967,453 distinct states, ~90s) — the overlap-filtered narrowing composed with delayed delivery, so the two live refinement directions are certified together rather than only separately. |
| `PendingStacks_Identity.cfg` | `fullstack` | `confirmed` | `atomic`, `IdentityMode = "elide"`, `Values = {"a", "b"}` | **All invariants hold** — `ContentCoherence`, `ElidedUnchanged`, `CascadeTotality`, `MonotonicResolution` — at 304,439,185 distinct states, `MaxTotal = 4`, ~14 min. Certifies the identity-commit acceptance of §3.6.1: a commit refused for staleness and proved to change no path's content, judged from the content its reader saw (its confirmed basis plus the values its own named layers wrote), is accepted with its writes elided, and no commit that wrote anything is ever admitted on an observation whose content differs from durable history — including a commit built on top of an elided layer. |
| `PendingStacks_IdentityWriterForm.cfg` | `fullstack` | `confirmed` | `atomic`, `IdentityMode = "elide"`, `Values = {"a", "b"}` | **ReadCoherenceOfWrites violated** at depth 8, within seconds — the same run as the row above held to the writer-set form of INV-1 over the commits that wrote something. The trace: a foreign commit writes `p1 = a`; the reader's own stale `p1 = a` is elided at the next seq; the reader integrates the foreign write, keeps its elided layer on the stack, and its next commit observes `p1` through that layer — contributors `{1, 2}` where durable history holds `{1}`, the same content either way. Kept as the witness that the content form is the statement under elision, not a weakening. |
| `PendingStacks_ChannelIdentity.cfg` | `fullstack` | `confirmed` | `channel`, `IdentityMode = "elide"`, `Values = {"a", "b"}` | **All invariants hold**, `AcceptedVersusDropped` included, at 169,592,041 distinct states, `MaxTotal = 4` with single-path writes (`WriteChoices <- SingletonWrites`, the Filtered5 bound), ~9 min. The identity acceptance composed with delayed delivery: an elided layer's accept is processed by `Deliver`, stands on the stack through the parking window, and is named by builds there without a durable write behind it. With multi-path writes this config passes 680M distinct states in half an hour without finishing, which is why the bound is narrowed rather than the depth. |

Read the violation together with the catalog: the maxdep counterexample is an
INV-1 failure through the staleness basis, orthogonal to dependency
recording — no choice of DepMode fixes it, which is why the repaired configs
change the basis dial. Conversely, dependency under-recording is the other
failure axis (INV-3(a): a recording shape that drops a layer overlapping the
read path re-creates the CT-1872 phantom); the filtered configs certify that
the proposed narrowing keeps every overlapping layer and stays sound.

**Scope of the certification.** The model checks the ADMISSION CORE under
two structural assumptions the runtime does not automatically share, so the
Repaired result certifies the rule, not the whole pipeline:

- **Canonical reads.** `Build` constructs one read per path directly from
  session state (`cbasis = csn`). The runner's raw-activity → wire
  compaction layer (`compactCommitReads`) is outside the model; losing a
  divergent basis there is guarded by a runner unit test (divergent basis
  overrides survive compaction), not by TLC.
- **FIFO by construction.** `Process` admits `Min(Unresolved(s))`, so a
  later same-session commit can never overtake an earlier one in any
  reachable state. The runner's hold-mode admission CAN reorder sends,
  which is one reason the shipped exclusion is the DECLARED SET (own
  commits the read's array names) rather than session-wide — an own write
  the array does not name conflicts like a foreign one, whether admitted
  out of order or omitted while durably integrated. Modeling issued
  versus admitted commits separately, with FIFO as a checked invariant
  rather than a structural given, is the natural refinement if this area
  churns.
- **Canonical dependency arrays.** `Build` records the layers of the
  CURRENT stack — under channel delivery that set can be sparse relative
  to session history (processed rejections are gone from `pend`), but it
  always names every layer the view sat on, so the model's session-wide
  scan exclusion coincides with the shipped declared-set exclusion on
  every reachable state. What the model therefore does NOT exercise is
  the declared-set scan's VALIDATION role (§3.6.3): a buggy client
  omitting a live layer whose write is durably integrated. That
  enforcement is checked by the engine unit tests
  (`packages/memory/test/v2-sparse-pending-dependencies.test.ts`) and the
  differential harness's sparse mutation; a `SkipLayers` build choice
  paired with a named-set `InvalidatedBy` — a violation witness under
  session-wide exclusion, a pass under named-set — is the natural
  refinement if omission ever becomes more than a hardening concern.

## Running

TLC needs Java and `tla2tools.jar`
(<https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar>);
neither is vendored.

```bash
java -cp tla2tools.jar tlc2.TLC -config PendingStacks_Current.cfg \
  -workers auto PendingStacks.tla
```

The delivery model runs the same way, one command per config:

```bash
java -cp tla2tools.jar tlc2.TLC -config SessionDelivery_Holdings.cfg \
  -workers auto SessionDelivery.tla
java -cp tla2tools.jar tlc2.TLC -config SessionDelivery_Memory.cfg \
  -workers auto SessionDelivery.tla
java -cp tla2tools.jar tlc2.TLC -config SessionDelivery_MemoryFull.cfg \
  -workers auto SessionDelivery.tla
```

Only the Holdings run is expected to pass. The Memory and MemoryFull runs
are regression witnesses: each MUST report the violation its table row
describes and exits nonzero doing so — a clean exit from either means the
old design's defect became unreproducible and the model needs examining,
exactly as a new violation in Holdings means the shipped design does.

A violated invariant prints the full state trace — each `State N` is one
atomic action (`Build`, `Process`, `Deliver`, `Integrate`); the last state's `log` entry
is the incoherently accepted commit, and comparing its read's `obsC`/`obsP`
(mapped through `res`) against the writes below it in `log` shows the phantom
or missed contributor directly.

## What the model is

- **State**: an accepted-commit `log` (index = canonical seq); per session, a
  pending stack `pend`, SERVER verdicts `res` (localSeq → accepted-at-seq /
  rejected), the client-PROCESSED fates `known` (trailing `res` in channel
  mode; receipt for accepts, application for rejections — see the variable
  comment for the asymmetry), the locally-rejected witness set `localrej`,
  a confirmed integration point `csn`, and a localSeq counter.
- **Actions**: `Build` (client constructs a commit against one snapshot —
  confirmed prefix plus pending stack — recording observations and the
  dependency set the active `DepMode` prescribes, and carrying one value
  from `Values` for every path it writes), `Process` (server FIFO
  admission: dead-dependency check, then staleness scan per `BasisMode`,
  then accept-and-append or reject — with the client's mirrored drop fused
  in under `atomic` delivery, server-side only under `channel`; under
  `IdentityMode = "elide"` a staleness refusal first proves the commit an
  identity over content, and an identity is accepted with its writes
  elided: it takes a seq and resolves its localSeq, and appends nothing to
  any path's content), `Deliver`
  (channel mode: the client processes the next verdict in submission
  order — for a rejection, the drop and transitive cascade), and
  `Integrate` (client advances its confirmed view one log entry; own
  accepted entries promote here, gated on the processed verdict).
- **The master invariant** `ReadCoherence` is observational, not mechanical:
  every accepted commit's recorded observation of a path — its confirmed
  contributors plus its pending-layer contributors mapped through resolution
  — must equal the exact set of accepted writes to that path below the
  commit's own seq. Phantom contributors (observed ⊃ durable) and missed
  concurrent writes (observed ⊂ durable) both break the set equality. This is
  INV-1 of `09-invariants.md`; `CascadeTotality` and `MonotonicResolution`
  cover INV-4 and INV-5, and `AcceptedVersusDropped` covers INV-6 (checked
  meaningfully in channel mode, where a local drop can precede or replace
  the victim's own server verdict). Under `IdentityMode = "elide"` the
  invariant is `ContentCoherence`, the same equality over the VALUES
  observed and durable rather than the writers: an elided layer stays in
  its session's stack and is observed there as a contributor while durable
  history holds the foreign write that carried the same value, so writer
  sets differ where content does not, and `ReadCoherenceOfWrites` is kept
  as the checked witness of that. `ElidedUnchanged` pins the premise of
  INV-1's recorded exemption: every path an elided commit would have
  written already held its value at its resolution point.

## Abstractions, and why each is safe to make

- **One document, overlap = path equality.** Real overlap is
  ancestor/descendant path structure plus the Tier-1 path-blind set/delete
  check; both only *widen* conflict detection relative to equality, i.e. move
  in INV-2's safe direction (more rejections, never more acceptances). A bug
  reachable under equality-overlap is reachable under the real matcher; the
  converse widenings can't introduce coherence violations, only retries. The
  model therefore under-approximates the matcher and is a sound bug-finder
  for admission logic, but it does NOT check the matcher's own
  refinements — that is the differential harness's job
  (`packages/memory/test/v2-differential-consistency.test.ts`).
- **Explicitly elidable dependencies.** Identity-mode reads represent callers
  whose observations decide only document operations. Required dependencies and
  external outcomes are outside this model; the engine must validate their
  staleness even when document operations elide. The engine/client required-read
  tests and Runtime effect race test cover that separate contract.
- **Appends-only values.** The value of a path is the set of accepted writes
  to it. This makes observations mergeable (a reader through a stack observes
  base + every contributing layer, exactly the mergeable-collection-writes
  situation CT-1872 arose from) and makes coherence a set equality instead of
  a value comparison. Last-writer-wins replace semantics would only coarsen
  observations, hiding contributor differences the set form exposes.
- **Content is a set of values.** Each commit carries one value from
  `Values` for every path it writes, and a path's content is the set of
  values its accepted writes carried. Writing a value the path already
  holds changes nothing, which is what an identity commit
  (`03-commit-model.md` §3.6.1) is in this abstraction, and the set-union
  fold is the idempotence the rule requires of it. The identity proof
  replays a write from the content the reader saw — a confirmed read's
  basis, or for a pending read the content at its confirmed basis plus the
  values its own named layers wrote, which is the reconstructed view the
  engine's `basisOf` builds — and asks that only the commit's own value
  landed since. Two values are enough to tell an identity from a real
  write. What the alphabet does not model is a commit's ordered sequence
  of operations on one document: a commit here is one write of one value
  per path, which is the engine's per-document rule with the sequence
  collapsed to its final effect. The replay of an arbitrary sequence, and
  what a patch can do to a document beyond adding a value, is the engine
  unit tests' and the differential harness's to check.
- **Verdict delivery is a mode.** `atomic` fuses the server's verdict with
  the client's mirrored cascade in one action — the original abstraction,
  kept so the historical configs certify the same state graphs (the
  Repaired/Filtered counts are unchanged to the digit). `channel` is the
  in-flight-verdict refinement: the server decides, and the client
  PROCESSES each verdict by an explicit `Deliver` step in submission order
  — for a rejection, the drop-and-cascade. `Deliver` is the processing
  point, not the transact response's arrival: the implementation holds a
  rejection's drop for the covering fan-out frame (the read-repair gate),
  so the revert and the winning data land as one visible transition and
  re-run actions read repaired state. That brings into
  scope the decided-but-not-yet-applied window of CT-1927 verdict parking
  (promotion still waits for `Integrate`, now guarded so a covering frame
  cannot precede its verdict — the §4.11 server obligation), INV-6 as the
  checked `AcceptedVersusDropped` invariant, and the sparse dependency
  arrays of §3.5 (a build after a processed rejection's drop records only
  survivors).
  Two collapses keep it tractable, argued in the module header: the
  response-to-processing window adds no observably distinct dependency
  arrays (so verdict-time and frame-time drop policies are covered alike),
  and a locally cascade-dropped commit models
  as never-decided (pre-send refusal) — the server-decides-first ordering
  is a separate reachable interleaving. Still outside scope: connection
  loss and replay (INV-11), which remain covered by reconnect unit tests
  only.
- **FIFO per-session admission.** INV-5 holds by construction, matching the
  current implementation (which rejects rather than holds). If admission is
  ever parallelized or holds are introduced, that assumption must become an
  explicit checked property, not a structural given — model that change here
  first.
- **No branches, scopes, preconditions, or schema sync.** Orthogonal to the
  pending-stack machinery under study.

## Model: session delivery across a reconnect

`SessionDelivery.tla` is a second, deliberately small model of the delivery
side that `PendingStacks.tla` leaves out of scope: one session's watch union,
the server's per-session delivery memory (`session.entities`), the client's
replica, and the diff base a reconnect's frame is computed against
(`04-protocol.md` §4.1.2, §4.3.5, §4.6). Pushes can be LOST by the client (the
OW61 absorb-defect class, bounded by `MaxLoss`), the replica can be WIPED under
a live session (`SpaceReplica.reset()` on route replacement, `AllowReset`), the
session can EXPIRE while disconnected (a re-establishing reconnect instead of a
resume), and the watch union can SHRINK — a lossy `Unwatch` whose removal frame
the client may fail to absorb, down to the zero-watch union, so a reconnect can
face a declared holding the union no longer covers (union growth is not
modeled: a grown union's never-held documents are ordinary deliveries,
indistinguishable from initial delivery). `Mode` selects the diff base:
`memory` is the server's own memory on resume and nothing on re-establishment
(the design before client-declared holdings); `holdings` is the client's
declaration on both paths.

Checked with TLC 2.19; every config finishes in seconds:

| Config | Mode | MaxLoss | AllowReset | Result |
| --- | --- | --- | --- | --- |
| `SessionDelivery_Memory.cfg` | `memory` | 1 | yes | **ReconnectConverges violated** at depth 4 — a push the server records as delivered and the client loses, a disconnect, a resume: the diff against the server's memory elides the lost document, and the replica stays behind. This is the schema-doc quarantine residual (verification-coverage.md OW61) as a machine-found trace; kept as the regression witness. (The same base fails the removal direction too — a lost removal the memory believes absorbed is never retracted — at greater depth; the reported trace is the shortest.) |
| `SessionDelivery_MemoryFull.cfg` | `memory` | 0 | no | **NoRedundantDelivery violated** — with a perfect client the old design converges (`ReconnectConverges` holds at 602 distinct states when checked alone), but a re-established session is delivered in full: the whole union again, held or not. |
| `SessionDelivery_Holdings.cfg` | `holdings` | 1 | yes | **All invariants hold** (2,164 distinct states, exhaustive at `MaxWrites = 3`): every reconnect — resumed or re-established, after any loss, wipe, or union shrink — brings the replica to the union's current state, retracts what the union no longer covers (the zero-watch reconcile included), and re-delivers nothing it holds. Negative control: emptying `Reconnect`'s `removed` set — the zero-watch shortcut — violates `ReconnectConverges` within a second (a lost removal, a disconnect, a resume: the stale document survives as held state), so the retraction clause is load-bearing, not decorative. |

`ReconnectConverges` is INV-14 of `09-invariants.md`, its uncovered-document
clause included; `NoRedundantDelivery` is its efficiency companion, stated as
an invariant so the full re-download the old design performed on a lapsed
session is a checked witness rather than an anecdote.

**Scope of the certification.** What the Holdings result certifies is the
SERVER's diff rule against a truthful declaration. The CLIENT's construction
of that declaration is an assumed input — the declaration IS the replica,
exactly — and each construction obligation is enforced by a unit test, not by
TLC:

- **Delivered state only.** The runtime derives the declaration from the last
  frame the replica absorbed per document, never from a locally promoted
  confirmed seq the server never sent — the replica in the model advances
  only by absorbed delivery, so a promotion-shaped over-declaration is
  unreachable here. Pinned by
  `packages/runner/test/memory-v2-reconnect-holdings.test.ts` (an own
  accepted write leaves the declared seq at the delivered frame's).
- **Branch identity.** Document state is a bare seq, so a same-id document on
  another branch is not representable; the wire type carries `branch` and the
  diff keys by it. Pinned by the cross-branch case in
  `packages/memory/test/v2-session-holdings.test.ts`.
- **The parse.** Malformed holdings fail the message rather than degrade to
  full delivery. Pinned at the wire boundary in the same file, with
  `v2-client-holdings.test.ts` covering which requests carry the declaration
  — and that a declaration-bearing session terminally fails restore against
  a server that cannot take one, rather than silently rejoining the `memory`
  row of this table.

A client declaring documents it does not hold is outside the model, in the
same trust class as a client fabricating reads. Catch-up frames are absorbed:
the pre-watch loss they were once subject to is fixed and pinned separately
(#6292, `precedingSyncs`), and the residual loss class the model exercises is
the steady-state push and the removal frame. Commit replay (INV-11) remains
outside both models.

## Changing the models

Per the change discipline in `09-invariants.md`: if a change introduces a new
dependency-recording shape, staleness basis, or acceptance rule, add it as a
`DepMode` / `BasisMode` / `IdentityMode` variant plus a config, and record
the expected/observed result in the table above. The delivery model has the same obligation on its own axes:
a change to the reconnect diff base, to what a declaration may claim or how
the server reads one, or to removal semantics (union shrink, the zero-watch
reconcile, uncovered-document retraction) is a reason to rerun all three
`SessionDelivery` configs, and a new base or declaration shape is added as a
`Mode` variant plus a config with its expected/observed row. Keep the
existing modes in both models — the violated configs are regression witnesses
(they document *why* the current shape is what it is), not dead code. If TLC
finds a violation in a mode expected to pass, the trace is the ticket:
minimal, complete, and replayable against the real engine as a unit test
(compare `packages/memory/test/v2-engine.test.ts` harness).
