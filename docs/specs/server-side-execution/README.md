# Server-primary execution, v2

Status: **live spec** — governs the rebuild. The first implementation
(2026-07-07 → 2026-08-02) was concluded as a learning run; its design
documents and the full lesson log are archived under
[`docs/history/specs/server-side-execution/`](../../history/specs/server-side-execution/README.md),
with the standing-knowledge record in
[`passivity-arc-orchestration.md`](../../history/specs/server-side-execution/passivity-arc-orchestration.md).
This document states what we now know we are building and the lessons that
constrain how. It replaces the archived design and implementation plan;
the v2 implementation is sequenced in
[`docs/plans/server-execution-v2.md`](../../plans/server-execution-v2.md),
which carries the task and success-criteria checkboxes.

This README is the constitution: goal, invariant, lessons, budgets,
deletion list. The normative engineering detail — written to be executed
by implementing agents without re-deriving design decisions — is split by
domain:

| doc | governs | plan phases |
| --- | --- | --- |
| [`serving-loop.md`](serving-loop.md) | executor host, lease, wake→fixpoint→commit, memoization, outbox, recovery, counters | 1 |
| [`speculation.md`](speculation.md) | client overlay, read-through, reconciliation, offline | 2 |
| [`events.md`](events.md) | handler events end to end, payload capture, idempotency, failure semantics | 3 |
| [`scopes.md`](scopes.md) | the scope lattice, run-time scope discovery, redirect narrowing, instance fan-out, per-instance speculation/events/effects | 0, 1–5 |
| [`key-vocabulary.md`](key-vocabulary.md) | inventory: every site that builds a scope-NAME identity key today, its required instance dimension, and its OFF-arm-neutral form (the M2 re-keying surface) | 0, 1 |
| [`protocol.md`](protocol.md) | commit classes, the whole admission table, push, watermark, client-effect channel, wire discipline | 1–4 |
| [`builtins.md`](builtins.md) | per-built-in contracts: placement, memo keys, navigateTo split, deferred list | 1, 4, 5 |
| [`testing.md`](testing.md) | harness rules, CI arms, watermark-based settling, counter gates per phase | all |
| [`scenario-traces.md`](scenario-traces.md) | VERIFICATION INSTRUMENT (non-normative): fifteen canonical end-to-end journeys traced cell by cell with citations; gaps/flags/contradictions feed the rulings ledger; re-run after every ruling batch | all |
| [`field-provenance.md`](field-provenance.md) | VERIFICATION INSTRUMENT (non-normative): per-field producer→carrier→consumer→retirement chains, closure-checked across six path families — the bottom-up complement to the traces | all |
| [`verification-coverage.md`](verification-coverage.md) | VERIFICATION REGISTER (non-normative): every binding rule mapped to the instrument that checks it, or to an adjudicated reason none does; the owed list with phase triggers; the stopping criterion for spec-time verification | all |
| [`runtime-mapping.md`](runtime-mapping.md) | today's runtime, behavior by behavior → its v2 placement, statused COVERED/CHANGED/GAP | all |

Each detail doc opens with **Anchors** — module paths verified on main
2026-08-02, to re-verify before coding — and closes with FORBIDDEN
tripwires. A change that contradicts a detail doc edits the doc in the
same PR or does not land.
(The v1 branches, `codex/server-execution-w1-2-shared-pool` and
`codex/server-execution-flags-on`, are archives — do not merge.)

## 1. The goal

**Servers do all the compute that is stored. Clients may compute anything,
and commit nothing but intent.**

- The server runs **every reactive computation whose result is durable**:
  derived cells, `computed`/`lift`, `map`, `generateText`/`generateObject`,
  `fetchData`, sqlite queries — everything downstream of committed state.
- The client runs **rendering effects** (invisible to the server anyway)
  and **any amount of speculative execution it likes** — the same derived
  graph, run locally for latency, with results that are never committed.
- The client's durable output is **authored facts**: handler events, and
  direct writes from UI bindings and widget edits (§3.6) — never
  computation results.
- External side effects (webhooks, outbound fetch, LLM calls that bill)
  are performed **only** by the server executor.

The boundary is **commit authority, not compute location**. The prior arc's
"client passivity / no dual execution" framing was wrong in a way that
generated machinery: dual *execution* is fine and deliberate (that is what
speculation is); dual *commitment* is what must never happen. Stated as the
invariant it actually is:

> **Derived state has exactly one deriving committer — the space's
> server runtime — and this holds by construction, not by enforcement:
> the client has no code path that commits a derivation result.**
>
> Authored state is the opposite and stays exactly as it is today: any
> number of writers with authority may write (handler events, UI
> bindings, several widgets editing the same document path), made sound
> by the pre-existing CAS/conflict/retry machinery. An authored write
> happens exactly once by definition — there is nothing to re-run, so
> no "who runs it" question exists. That question only exists for
> derivations (standing functions that fire repeatedly), and v2 answers
> it with a constant. Two committing derivers is what CAS cannot
> absorb: effects fire twice, stale results flap against fresh ones,
> and N clients recomputing everything is the conflict storm itself.

"By construction" binds honest clients; it is not a new ACL. A
malicious client holding today's write authority on a doc can still
author into it — derived-output docs and the watermark doc included
(forgery possible, accepted for now). v2 defines the outcome rather
than a defense: the intruding write is ordinary authored input;
recompute over it is NOT automatic — it follows serving-loop.md
§3d's dependency-only rule (RULED 2026-08-05), so a derivation that
never reads the doc it writes is not re-armed by the intrusion
(protocol.md §1). **v2 adds no security guarantees beyond today's
unless trivial (owner, 2026-08-02); tightening is future work.**

The egress rule falls out of the same line: **speculate on anything you can
throw away; never on anything you can't take back.** A derived value is
discarded for free, so clients may speculate it. A webhook cannot be
un-sent, so only the committing side may perform it. Effectful nodes are
therefore excluded from client speculation entirely (§3.5) — speculation
reads *through* them, reusing their last committed result.

### Why this is also the *fast* design for multiplayer

With client-side execution, N clients race to recompute and commit the same
derived state, and the merge machinery digests the conflict storm. With one
committing runtime per space there is exactly one authoritative run and one
commit per change. Server-primary execution should therefore be *faster*
than today for multi-user spaces, not tolerably slower. The v1 measurements
(§4) showed slower — and the slowdown was traced to v1's own scaffolding,
not to the architecture. Fast is the requirement, not the hope.

## 2. The central lesson of v1

> The recurring problem in this arc is that we tried to partially move to
> the server and invented all kinds of things to support that, when the
> easier solution would have been to move all at once. All the rank stuff
> is to a large degree that. — owner, 2026-08-01

Partial migration means the server must **accept work it did not do**, and
that single obligation generated the bulk of v1's complexity:

- **Claims / candidates / settlements / fences** — arbitration over who may
  commit an action, meaningful only while two parties might.
- **The rank ladder and context-lattice negotiation** — which subset of
  actions the server had authority over, meaningful only mid-migration.
- **`completeSchedulerScopeSummary` / `completeActionScopeSummary`
  certificates** — compiler-issued
  evidence bounding a computation's writes so a commit produced elsewhere
  could be admitted. 13 source files, 214 golden fixtures, reaching from
  ts-transformers through the runner into the memory protocol. Both
  identifiers name the same surface; an inventory that greps only the
  first undercounts it.
- **Shadow/authoritative double execution** — every served action ran
  twice: once privately to prove a candidate, once for real after the claim
  round trip.
- **The observation evidence log** — every server-side run durably
  persisted its full read/write link sets plus a copy of the certificate
  (42–158 KB per record) as admission evidence.

**The survival test** for any mechanism in the rebuild: *ask what it
decides, not where it lives.* If what it decides is only meaningful while
clients can also commit derived state, it is scaffolding — do not build it.
If a v1 mechanism seems needed, the first question is what deletes it,
never how to make it more correct.

Corollaries already ruled:

- Write bounding is done by **capability handles + CFC checks at write
  time**, by whoever holds the handle. Untrusted pattern code only gets
  handles to what it may write. No commit-time certificates
  (D-2026-08-02). Under §3.6, **execution admission is deleted as a
  category**: no client commit ever asserts "I ran something," so the
  server never reconstructs an execution from evidence (certificates,
  read-set provenance, claim matching). Every client commit is an
  authored fact admitted by target + principal — append authority on the
  stream for an event, write authority on the doc/path for a direct edit
  — plus CAS for soundness. Both checks pre-date v1 and are robust; v1's
  layer on top was about *where things run*, and v2 makes that question
  unaskable by construction.
- Placement is determined **from input links**, as the pre-arc runner
  already does. No static scope discovery before first run; scope is
  discovered *by running* (D11).
- Crash recovery is **recomputation from current state** for pure nodes —
  reactive computations are deterministic functions of cells — and
  **committed-result reuse** for effectful nodes (§3.5): a
  `fetchData`/`generateObject` node is memoized by request hash, so
  recovery re-derives the hash and reuses the committed result unless the
  inputs actually changed. Never replay of persisted run logs. Handler
  *events* remain durable (they are intent, not derivation) with their
  scheduler-v2 durable IDs (#4288), which is also what makes handler
  processing idempotent across restarts: an event whose consequence commit
  landed is not re-run.
- Toolshed routes its own pattern needs through the executor (D12).

## 3. Architecture

### 3.1 Server

One committing runtime per space, hosted by the executor host — a
Phase 1 rebuild; the v1 branch's pool is prior art, not existing
substrate.

- Subscribes to its space; on any accepted commit, runs the affected
  reactive graph to fixpoint and commits the derived changes. One
  authoritative run per change; no shadow pass, no claim round trip.
- Performs all external effects (`"server-executor"` returns, rebuilt,
  as the one declaration of `externalSinkDisposition: "allow"` — v1
  prior art; nothing of it exists on main).
- Processes **events** (§3.6): an event appended to a stream — by a
  client, by another piece, or by a server-run computation calling
  `stream.send()` — is handled by the server-side handler run, whose
  writes commit as the event's consequences.
- Runs `generate*` / `fetch*` / sqlite as ordinary served computations —
  reactive nodes whose evaluation reaches out, memoized by request hash.
- **Cross-space**: a piece's graph is run by its home space's runtime.
  Foreign-space reads are server-internal subscriptions: the home runtime
  reads with the piece's granted authority, and a foreign commit wakes the
  home runtime the same way a home commit does. Per-reader clearance
  (sqlite row admissibility, CFC labels) is enforced where the read is
  served. v1's cross-space claims and cohort fences delete; what remains
  is subscription plus an authority check. Writes LEAVE a space only
  through the two sanctioned crossings — event appends and the
  `.inSpace` provisioning split (protocol.md §2b) — and derived
  commits never target foreign spaces.
- Recovery: on restart, re-derive from current cell state (with
  memoized-effect reuse per §2). No observation replay.

### 3.2 Client

A full runtime that has lost exactly one right: committing computation
results.

- **Handlers** run locally as *speculation* (instant echo) and their
  triggering event is committed as intent; the authoritative handler run
  happens server-side (§3.6).
- **Speculation**: on any local input the client may run the derived graph
  locally and render immediately. Speculative results are overlay-only;
  when the authoritative value arrives it replaces the overlay. Effectful
  nodes are never speculated — the local run reads through them to their
  last committed result. Keep v1's one surviving insight here: *drop only
  the authority of a local run, never the ability to run* (the
  "speculation for rendering, not rerun for authority" rule).
- **UI bindings** (`$value` on `cf-checkbox` and friends) commit direct
  authored writes — the normal, pre-existing write path under ACL + CAS.
  Not an exception and not transitional (§3.6).
- **Rendering effects** stay client-side; the server never sees them.
- Client-effect enactment: the client subscribes to its session's effect
  cells (§3.7) and enacts what lands there (navigation, etc.).

### 3.3 The push path is THE hot path

The user-visible cost of this architecture is a single number: **how fast
an observing client sees another user's committed change.** The actor hides
behind local echo; every other participant waits on
intent → serve → derived commit → push. v1 measured 500–1800 ms for this
hop and the rebuild must design it deliberately:

- **Budget: ≤ 300 ms p50 LAN** for intent-commit → observing client's
  derived update (v1's residual after removing its self-inflicted storm
  was 306–453 ms with double execution still on; mainbase's
  client-computed equivalent is 92–294 ms; beating mainbase is the
  eventual bar, per §1).
- **Priority**: user-facing derived values before any bookkeeping on the
  subscription channel.
- **Commit amplification budget: ~1 protocol commit per logical write.**
  v1 hit ~60× (595 notifications for ~10 writes) and buried the hot path
  under its own bookkeeping. Every proposed durable record must answer
  "who reads this, and what do they decide with it?"
- **A settled-ness watermark rides the push**: "derived state is current
  through commit seq N." Clients need it for sync indicators, tests need
  it instead of text-polling, and it is one integer. Without it, "is the
  server done reacting?" is unanswerable from the outside — v1's
  integration tests resorted to 60 s condition polls.
- **Streaming results do not ride the commit stream.** `generateText`
  emits partial tokens; committing per token would rebuild the
  amplification storm at the protocol layer. Partials flow on an ephemeral
  session channel (or throttled coarse snapshots); only the settled result
  commits. The ephemeral channel may defer along with `stream-data` —
  settled-result-only commits are a complete v2 baseline.

### 3.4 Configuration

Exactly two states, one flag: `EXPERIMENTAL_SERVER_EXECUTION`
(RuntimeOptions key `serverExecution`), named deliberately unlike
v1's `SERVER_PRIMARY_EXECUTION` so the archived docs never alias it.
OFF is today's behavior byte-for-byte; ON is
the full v2 posture. **No shippable intermediate states** — partial flag
combinations exist only as debugging affordances during bring-up, and the
v1 dial set (eight interlocking dials) is the cautionary tale. Both halves
of any coupled behavior (e.g. "client suppresses egress" and "server
performs egress") move on the same flag — v1 shipped one half unconditional
and silently dropped side effects in the OFF arm.

### 3.5 Built-in coverage — every one, placed

The full inventory (from `packages/runner/src/builtins/`), so nothing is
discovered mid-rebuild. Five placement classes:

| class | built-ins | runs on | client speculation |
| --- | --- | --- | --- |
| **Pure structural** | `map`, `filter`, `flatmap`, `if-else`/`when`/`unless`, `inspect-conf-label`, `wish` (the `list-*` modules, `op-pattern-ref` and `scope-policy` are helper modules, not registered built-ins — builtins.md §1) | server | yes — free to discard |
| **Deferred** | `stream-data` | disabled in the v2 interim (unused today; the low-latency UI it promises likely wants a different mechanism — owner, 2026-08-02) | — |
| **Effectful / network** | `fetch` (`fetchData`), `fetch-program`, `llm` (`generateText`/`generateObject`), `llm-dialog`, `sqlite*` | **server only** | **never** — speculation reads through to the last committed result |
| **Compile / instantiate** | `compile-and-run` (piece creation, incl. from handlers) | server (sandboxed worker; toolshed already compiles) | no |
| **Client-enacted effect** | `navigate-to` | server *computes*, client *enacts* (§3.7) | echo allowed (navigate optimistically, reconcile) |

Why effectful nodes are server-only rather than merely server-preferred:
a speculative re-execution would double the side effect (double fetch,
double LLM bill), leak credentials to clients that should never hold them,
and bind results to the wrong network vantage point. The request-hash
memoization these built-ins already carry is what makes reading-through
sound: same inputs → the committed result *is* the value.

`resume-republish`: re-evaluate under v2 recovery — currently
load-bearing on main in `filter.ts`/`flatmap.ts` (#4367, #4438);
builtins.md §5 carries the call.

### 3.6 Events are the client's computational commit (D-v2-1, RULED 2026-08-02)

The end state was always: the client sends the *event* down; the server
processes the handler. v2 builds that **now** rather than after another
partial state, for one decisive reason: **server-side handler execution
must exist in v2 anyway** — an event created server-side
(`stream.send()` from a served computation, or piece-to-piece) has no
client to run its handler. Once the server can run handlers for its own
events, routing client events through the same path is wiring, not
architecture. Building v2 with client-committed handler *writes* instead
would recreate the root-cause pattern: client write admission for
arbitrary cells, CFC-at-client-commit, and conflict handling between
client handler writes and server derivations — all machinery that
dissolves the day handlers move. The survival test fails it.

Ruled YES by the owner 2026-08-02: events-down from day one. "Day one"
binds the ARCHITECTURE (v2 is built toward events-down; no
client-write-admission machinery is invested in), not the flip's
calendar: the ROLLOUT stages it as F10's interim — client handler
WRITES keep committing authored-class until Phase 3 lands the events
channel (protocol.md §1's `authored` row; the Phase-2 flag ON serves
derivations while handlers stay client-committed). So in v2, at
Phase 3:

- A handler firing on the client commits **only the event** (payload +
  target stream). Admission is an append-capability check.
- The client *also* runs the handler + downstream graph locally as
  speculation, for instant echo. The authoritative consequences are the
  server's handler run, reacting to the event commit.
- Events are the *only* computational client commit. **All pattern-bound
  computation thereby moves server-side.**
- Handler determinism caveat: a speculative handler run may diverge from
  the authoritative one (clock, randomness); that is ordinary speculation
  divergence and reconciles the same way. Handlers whose body reaches an
  effectful built-in speculate up to it and read through (§3.5).

**UI-binding writes are not an exception.** Bidirectional `$value`
bindings (and any widget editing a document path) are *state authorship*,
not computation: authored facts under existing write authority and CAS,
multi-writer by design (§1). They coexist indefinitely with events;
whether components later migrate to events is a product choice, not an
architectural requirement. What §1 requires is only that *derived* state
downstream of those writes is committed by the server alone.

**Handler inputs are explicit** — the event payload plus the cells the
handler reads. A client-only ephemeral value the handler needs (viewport
size, selection) travels *in the payload*, captured at fire time; that
keeps the server run deterministic and makes echo divergence transient by
construction. A handler reaching for ambient client state outside the
payload is a pattern bug the transformer can flag.

### 3.7 The client-effect channel (navigateTo and its future siblings)

`navigateTo` computes *where to go* from committed state — that part runs
on the server like any derived node. But navigation itself is a
session-scoped client act. The wiring:

- The served computation writes a **navigation intent** into a
  session-scoped effect cell (target piece link + a nonce).
- The session's client subscribes to its effect cells, enacts the
  navigation, and acknowledges (writes the nonce back), which retires the
  intent.
- This is not new protocol — it is a cell with a defined consumer. The
  same channel carries any future server-computed, client-enacted effect
  (focus, toast, download). One shape, audited once.
- The client may enact optimistically from its speculative run
  (navigate immediately), reconciling by nonce against the
  authoritative intent — whichever of the two enacts first is the
  journey's one navigation, and the other stands down. Navigation is
  reversible, so the egress rule permits it.

### 3.8 Authority and budgets for server-run effects

- **Effect authority**: a server-run `fetchData`/LLM call executes under
  the authority *bound into the capability handle at wiring time* — the
  granting user's token, not an ambient server credential. Clients never
  hold provider secrets; the executor's broker does. For an effectful
  node serving multiple users, run CARDINALITY is not open — cell
  scopes already determine it (a user-scoped effectful node runs once
  per user; RULED 2026-08-02). The one deferred question is QUOTA
  attribution: whose quota a served run is charged against (§6,
  later). The rest of the identity surface is RULED (R-Q6b,
  2026-08-02) — Q6 is fully closed: derived commits are a different
  trust class from authored ones (the server admitting them also did
  the work — one trust environment at the envelope), so the
  SpaceServer commits under its own service identity and attribution
  rides WITHIN the commit — explicit scope_key per scoped write,
  acting identity per action RUN — never a SpaceServer-ambient user
  identity for served work (protocol.md §1's transaction identity
  model, §7; runtime-mapping.md N57). CFC labels stay the
  load-bearing enforcement; commit-level
  identity is not. Anticipated: per-user server-generated keys with
  user-delegated authority graduate attribution to acting-key
  signatures, envelope model unchanged.
- **Multi-tenancy**: one executor host serves many spaces. Per-space
  budgets (CPU time per wave, outstanding LLM calls, egress rate) are part
  of the executor contract from day one — a runaway pattern (an LLM
  fan-out loop) must degrade its own space, not the host. v1's pool
  already isolates workers; v2 adds the budgets.
- **Backpressure**: event floods (key-repeat driving `stream.send()`)
  are rate-shaped at the binding layer before they become commits.
  *Implementation (OW27, RULED (a) by the owner 2026-08-15; Phase 7):
  the client's event-append queue PACES per stream — a token bucket per
  stream between the queue and the wire, `burst` sends immediate,
  sustained sends at `ratePerSecond`, a flood HELD in that stream's
  fired order and never dropped (events are intent). Streams are
  INDEPENDENT (ruled 2026-08-16 with the P7 review): a paced stream
  holds only its own later sends — the queue sends the earliest-fired
  entry whose stream has a token, so a flood on one stream never delays
  another stream's sends (no cross-stream head-of-line hold), while
  each stream's own fired order stays exact. The default posture 20/s
  sustained, 20 burst, is a dial —* `DEFAULT_EVENT_APPEND_PACING` *in
  `packages/runner/src/storage/event-append-queue.ts` — flagged for the
  owner. The OFF arm never constructs the queue.*

## 4. Measured constraints (what the learning run bought)

All measurements 2026-08-02, quiet box, `deno task integration`
harness, byte-identical workloads across arms unless noted. Full detail in
the archived
[orchestration log §2.5c](../../history/specs/server-side-execution/passivity-arc-orchestration.md).

| fact | number | consequence for v2 |
| --- | --- | --- |
| Single-user interactive latency, v1 flags-on vs off | 292 ms vs 318 ms (parity) | the architecture is not inherently slow for the actor |
| Cross-user propagation, v1 | 92–294 ms → 767–1821 ms (4–6×) | the push path was drowned by v1's own evidence log |
| — after ablating the evidence log only | 306–453 ms | remaining cost is the extra hop + double execution; the ≤300 ms budget is reachable |
| Commit amplification, v1 | ~60× (595 notifications / ~10 writes) | bookkeeping must never ride the commit stream |
| Store growth, v1 | ~80 MB per space per test run; 72% observation evidence | durable records need a reader and a decision |
| One `map` run's evidence record | 158 KB (130 KB serialized read links + certificate copy) | never persist per-run provenance for recovery a recompute can do |
| Teardown, v1 | 2.9 s → 8.1 s (drains the storm) | session close must be O(1), not O(traffic) |
| ts-transformers certificate surface | 13 src files, 214 goldens, 321 marker sites | deleting at the source (don't emit) collapses all of it |
| Suite-context degradation | same test 4 s isolated, 138 s in-suite (34×) | dropped as a question (v1-run minutiae — ruled 2026-08-02); the requirement stands: server stays flat as spaces accumulate (plan Phase 6 gate) |

Also bought, as method: compare arms only on byte-identical workloads;
measurement instrumentation must not touch the measured path (v1's own
probes *warmed* the flags-on arm and understated its cost); prove causation
by ablation, not correlation; counters are load-insensitive, latencies
above load ~5 are not quotable.

## 5. What v2 explicitly deletes from v1

In a world where only servers commit derived state and clients commit only
intent, the following have no decision left to make:

- the claim lifecycle (candidates, issuance, revocation, settlement,
  fences, incarnations) and its storage tables
- rank ladder, context-lattice claim negotiation, per-rank candidate dials
- `completeSchedulerScopeSummary` / `completeActionScopeSummary`
  emission and every consumer, through to
  the memory protocol's claimed-commit admission
- shadow/authoritative action-transaction routing
- the observation evidence log (observation / snapshot / replay tables
  at derived-run frequency; `persistentSchedulerState`'s persisted form
  reduces to the v2 basis index — see below)
- unserved markers, demand-shrink compensation, the legacy-background
  exclusion protocol, `resume-republish`-style compensations
- the arc's write-firewall-as-admission (write bounding moves to handle
  grant time; client computational commits narrow to event appends)

Two entries lived on MAIN, not only on the archived branches:
`completeSchedulerScopeSummary`/`completeActionScopeSummary` emission
and its consumers, and `persistentSchedulerState`'s observation tables
(full-JSON payloads, OFF by default). For those two, "delete" was live
Phase 1 stage C deletion work on main, not merely "do not rebuild":
the certificate surface deleted at its transformer source and every
consumer, and the observation tables reduced to the v2 basis index
(serving-loop.md §3b).

Anything on this list that seems needed during the rebuild triggers the
survival test before it triggers implementation.

## 6. Open questions (owner rulings or experiments required)

The 2026-08-02 ruling pass closed most of this section; the answers
live in the governing detail docs — offline discharge and
conflict-dropped events in events.md §5 + speculation.md §5, the
durable event shape (complete as specced) and its
integrity-provenance follow-up in events.md §1, reconciliation UX in
speculation.md §4, sqlite clearance in builtins.md §2, and cell
scopes (Q7 — who derives and commits user- and session-scoped
derived state) in scopes.md: the SpaceServer derives EVERY instance
of every scoped node, and scope keys instances, never authority
(RULED 2026-08-02, batch 3; runtime-mapping.md N56). Its run-supply
half — a node narrowed to `user` runs once per demanding principal,
`session` once per session-deep principal, materialized on demand —
was RULED 2026-08-16 and landed by fan-out stages A and B (scopes.md
§2; verification-coverage.md OW17, CLOSED as a row, its flagged
residuals owed there as refinements). Q6's non-quota remainder,
which that review had inherited (was ledger L10), is ruled — R-Q6b
(§3.8; protocol.md §1, §7). Two former questions dropped outright:
the 34× suite-context mechanism (v1-run minutiae; the
flat-accumulation requirement stands — plan Phase 6) and cross-space
read clearance (Phase 5 builds it by construction). Still open:

1. **Quota attribution for server-run effects (Q6 residual — later).**
   §3.8 settles authority and identity (R-Q6b) and cell scopes settle
   run cardinality; the one deferred question is whose quota a served
   effect's run is charged against.
2. **Session-data GC (scopes.md §8 item 2).** The mechanism that
   retires a retired session's scoped instances, which must also
   cover the basis rows narrowing strands at `space` and `user:<p>`
   keys. A deferred design, not a gap in the built mechanism
   (verification-coverage.md §1); the mechanism's own flagged
   residuals are OW17's, in the register.

## 7. Relationship to prior documents

- The eight v1 design documents, including the orchestration log with the
  complete environment-trap and measurement-discipline record, are frozen
  under
  [`docs/history/specs/server-side-execution/`](../../history/specs/server-side-execution/).
  Cite them as history, not as descriptions of the system.
- [`docs/development/EXPERIMENTAL_OPTIONS.md`](../../development/EXPERIMENTAL_OPTIONS.md)
  documents the v1 dials as they exist on the archived branches; the
  entries retire when v2 lands its single flag.
- The pre-arc, still-live behavior specs this document leans on:
  [`scheduler-v2/`](../scheduler-v2/), [`memory-v2/`](../memory-v2/).
- [`persistent-scheduler-state.md`](../../history/specs/persistent-scheduler-state.md)
  did NOT return to its pre-arc scope, as an earlier draft of this
  section claimed. Phase 1 stage C dropped the entire PERSISTED form it
  specified — the observation, snapshot, replay, read-index,
  write-index, action-state and context-floor tables — and REPLACED
  it with the v2 basis index (serving-loop.md §3b). What the feature
  decided (warm start from recorded reads) survives in a new schema
  under a new owner; the spec describing the old form is archived, along
  with the persisted-form account extracted from
  [`scheduler-v2/per-doc-rehydration.md`](../scheduler-v2/per-doc-rehydration.md).
