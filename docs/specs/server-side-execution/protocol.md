# v2 detail: protocol — commit classes, admission, push, watermark

Normative. Assumes [README.md](README.md); details Phases 1–4 surface
between client, memory server, and SpaceServer.

## Anchors

- Memory server: `packages/memory/v2.ts`, toolshed mount
  `/api/storage/memory` (`packages/toolshed/routes/storage/memory/`).
- Client storage stack: `packages/runner/src/storage/` (`interface.ts`,
  `extended-storage-transaction.ts`, `query.ts`, `reactivity-log.ts`).
- Store tables: `commit`, `revision`, `head`, `branch` (engine-v3), and
  `execution_lease` (serving-loop.md §2 — the
  reduced three-field shape; the v1-branch shape was prior art only).

## 1. Commit classes

Every commit carries a `class` in its metadata. Three values, closed set:

| class | producer | contents |
| --- | --- | --- |
| `authored` | any authorized session; server-produced only via delegated capability (§2) | doc writes (UI bindings, widget edits) or event appends (events.md §1). Client HANDLER writes ended with Phase 3's events-down (F10's interim — events.md §7): a handler fire commits only the event |
| `derived` | the space's SpaceServer (lease holder) | derivation results, watermark advance, `consequenceOf` |
| `system` | memory server itself — its own direct writes, outside any session and outside the wave (PRODUCER-defined; note below) | e.g. space bootstrap, authorization changes, blob metadata — EXEMPLARY, not a closed list (RULED 2026-08-05) |

FORBIDDEN: a fourth class; per-class subtypes that alter admission;
clients producing `derived` (there must be no client code path that can
even construct one).

**Which work moves to the server — the scheduler tell (RULED, owner
2026-08-07; the classification that closes the instantiation-write
question).** ONLY scheduler-driven work moves to the server:
scheduler-stamped runs — the derivation and event-handler kinds — are
server work under the flag, and their writes DIVERT on clients
(speculation.md §2 carries the overlay half of this rule) —
derivation-kind writes since Phase 2; handler-kind writes since
Phase 3's events-down (F10's interim ENDED — events.md §7: the
client handler-write commit path is deleted, and the fire's one
authored act is the event append). Commits
made OUTSIDE the scheduler are the client's authored acts and commit
as today: the setup/instantiation transactions, imperative creation —
a `cf piece new`-style client writing the result doc with its links
and the pattern metadata IS the creation act; it may do nothing else
and `.pull` on that result to have the server run round one — UI
bindings, and widget edits. In the owner's words:

> a pattern instantiated within a lift (or a map/filter/etc for that
> matter) is reactive in nature, just a derived computation like any
> other. you can tell because the causes are all pre-determined, so
> the server will eventually do the same thing. but a client like the
> `cf` binary (which acts as client here) can instantiate a new piece
> (`cf piece new`) and that should create the piece including
> probably writing the initial result, as writing that doc with the
> result and the meta data about which pattern it runs is what
> creates the piece. it might not do anything else than that and then
> .pull on that result to get the server to actually run it for one
> round. one big tell: those are commits that happen outside the
> scheduler. only scheduler-driven work can move to the server, the
> rest stays on the client. — owner, 2026-08-07

Ratified corollaries, stated so none is inferred: there is NO
creation carve-out — a pattern instantiated within a lift (or a
map/filter) is a derived computation like any other, so its first run
stays diverted even at instantiation (the server converges because
the causes are pre-determined); README §1's "never computation
results" sentence stands UNQUALIFIED; and the
pull-then-server-runs-round-one flow above is the SANCTIONED
imperative-creation shape. The code's existing stamping boundary
already implements the rule — an unstamped setup transaction is
authored, and the scheduler's stamping choke points are exactly where
derivation-kind runs divert (speculation.md §2's posture rows) — so
this ruling NAMES the landed boundary rather than changing it.

*(AMENDED 2026-09-09 — the pattern-lifecycle verbs as server calls,
RULED 2026-08-24 and BUILT: the client-authored classification above is
the posture of a runtime running the whole stack. A `cf` client connected
to a deployment running the serving loop no longer performs the
instantiation transaction itself: `cf piece new` sends the program it
resolved to `/api/pattern-lifecycle/*`, and the space's serving runtime
compiles it and materializes the piece — the setup transaction, stamped
`bookkeeping` under the space's lease and carrying the requester's trust
snapshot — as a step of a wave cycle
([docs/features/server-pattern-lifecycle.md](../../features/server-pattern-lifecycle.md)).
The scheduler tell is unchanged: the verb's writes are still commits made
outside the scheduler, made now by the serving side on the requester's
behalf, the registry entry and the slug in the same transaction as the
piece. A source replacement (AMENDED 2026-09-11) is a served verb too:
it publishes module update authority, which module-loading.md requires
from an owned setup transaction that commits to storage, and since a
wave's withdrawable acceptance cannot supply that, its setup transaction
commits directly to the store as the serving loop's own derived-class
commit, outside the wave (serving-loop.md §3e). Every other client of
the piece controller, such as the shell, keeps the client-side shape
until its own migration.)*

**The `system` class is PRODUCER-defined, its contents exemplary
(RULED 2026-08-05).** The stamp rides the memory server's generic
direct-write path (`Server.writeDocument`,
`packages/memory/v2/server.ts` — envelope `server:<uuid>`): `system`
means "the memory server's own direct write, outside any session and
outside the wave", and the row's contents column is examples, not a
closed set — beyond bootstrap and authorization changes, the one
production caller today is the toolshed blob-upload route writing
`cid:<hash>` metadata docs
(`packages/toolshed/routes/blobs/blobs.index.ts`). Two consequences,
stated so neither is inferred: (i) because the stamp rides the PATH,
any NEW direct-write caller is a spec decision — this list is
extended deliberately, never silently by pointing more code at the
path. (ii) `system` commits carry no user attribution in the commit
ledger — the envelope is the server's own session — which is
deliberately accepted; per-user attribution for blob writes is a
named future hardening, out of v2 scope, in the same family as §2's
grant-scoped foreign reads.

**Both arms carry a class; only the ON arm enforces one.** `class`
metadata is WRITTEN in every arm from stage A onward and ENFORCED
(the §2 admission rows) only under the flag. `class` is
SERVER-DETERMINED at admission — assigned by which admission
row/endpoint processed the commit, never a client-supplied field
the server trusts (FP15, closed 2026-08-03 by derivation: the
FORBIDDEN clause below — no client code path can even construct
`derived` — holds only if no client-supplied value can influence
the class). In the OFF arm the
client still commits derivation results (plan §Interim postures, OFF
baseline) — those commits are `authored`, exactly like every other
client commit today. `derived` names the single-deriver posture, so
nothing outside the flag may claim it; the OFF arm therefore has no
unclassed commit and no third answer.

**The SpaceServer's own writes.** Not every write inside a derived
commit belongs to a user. The watermark advance (§4) and the
retirement of acked effect entries (§5) are the SpaceServer's OWN
writes under its SERVICE identity — the same identity before any
per-user delegation exists and after it does. They carry addressing
(a `scope_key` where the target is scoped) and NO acting principal;
nothing is being attributed to a user, so nothing is missing. **The
narrowing redirect written at a broad slot (scopes.md §2) is NOT one
of them (AMENDED — RULED 2026-08-16, the fan-out design §B6/§I.3;
fan-out stage B):** under the per-demander run supply the redirect
is written inside the DISCOVERING run's own transaction, so its
annotation carries that run's scope-derived attribution (below) —
the discovering principal — recorded, not read, like every
attribution; the redirect's value is a constant shape (no user data)
and annotations are not pushed, so no client observes who narrowed
first. One coupling to state plainly: the shared broad-slot redirect
rides a per-user run's transaction, so its durability is hostage to
that run's commit — a withdrawn discovering contribution withdraws
the shared redirect its siblings' narrowing needs, delaying them by
one wave.

Threat model, stated honestly (RULED, owner 2026-08-02): the
single-deriver invariant is by construction against HONEST clients —
no client code path constructs a `derived` commit. It is NOT new ACL
protection: derived-output docs get none in v2, so a malicious client
holding today's write authority on a doc can still author into it,
docs the SpaceServer derives into and the watermark doc included
(watermark forgery is possible and accepted for now). v2 defines the
outcome, not a defense: such a write is an ordinary authored input;
whether it triggers a recompute is governed by serving-loop.md §3d's
dependency-only rule (RULED 2026-08-05) — a derivation that reads
the intruded-on doc recomputes through the ordinary dependency path;
one that only writes it (a blind writer) is NOT re-armed, and the
derived output waits for the next input change. v2 adds no
security guarantees beyond today's unless trivial (owner,
2026-08-02); tightening is future work.

**The transaction identity model (RULED, owner 2026-08-03 — the
modeling that closes ledger LD3 and LD5).** In the owner's words
(lightly edited):

> In the current state a transaction comes from one client, so one
> session id and one user principal. Inside the transaction, scopes
> are named by kind — `scope: "user"` — and it is in memory where
> that gets mapped to the actual user/session keys, derived from
> the session that had the commit. In this proposal, execution for
> all clients — at once, so acting as multiple users — moves to the
> server, and every derived data step combines into one
> transaction. That transaction comes from the server itself; it no
> longer carries user principals and session ids. Those become
> annotations on the actual changes inside, grouped by action — the
> scheduling information and CFC enforcement are by action, and so
> are the user and session keys. So yes, clients can't send keys —
> or rather they do, but as part of the session overall, not per
> commit — and we introduce a variant of server-driven commits that
> do contain those inside. — owner, 2026-08-03

(One sharpening where the quote meets the letter of this spec: "by
action" is normatively BY ACTION RUN — `action × instance` — per
the attribution bullet below and serving-loop.md §3c; under fan-out
one action acts as N principals in one wave, and action granularity
would merge them.)

Stated normatively, with anchors. Today every transaction
comes from ONE client, so identity rides the ENVELOPE: the session
carries the user principal and session id — established once, at
session open, never sent per commit — and scoped writes inside the
transaction name only the scope KIND (`scope: "user"`). The session
carries one more thing established at open: its READ CEILING
(`SessionDescriptor.readCeiling`, signed into the `session.open`
invocation; memory-v2 04-protocol.md §4.1.2), the confidentiality
bound every `db.query` served AS that session reads under — the
client runtime's `cfcReadMaxConfidentiality`, which under this flag
cannot bound queries where it sits because the serving runtime
performs them. The memory server records it on the session (fresh
per open; a resume re-declares it) and a server-assigned ceiling
lands in the same record; the SpaceServer stamps it onto every run
served as the session (serving-loop.md §3c) and the served query
reads under it (sqlite-builtin 06-cfc.md, "Runtime read ceiling").
A client with a ceiling REQUIRES the `sessionReadCeiling` protocol
flag of the server it opens against: an older server would accept
the descriptor and serve every query unbounded, so the client refuses
to open the session. It is the
memory server that maps kind → concrete `scope_key` at admission,
derived from the session that had the commit (the shared
`resolveScopeKey` in `packages/memory/v2.ts` — the wire-shape module
owns the one definition per LD3). That model is UNCHANGED for
every `authored` commit: clients never name keys, per commit or
otherwise; their keys keep deriving from the authenticated session.

The wave breaks that model's premise. The server executes for ALL
clients at once — acting as many users and sessions in one pass —
and combines every derived step into ONE transaction
(serving-loop.md §3). No single user principal or session id exists
for that transaction's envelope to carry, so it carries none: the
envelope principal is the SpaceServer's service identity, exactly
the lease holder §2 checks. The identity the envelope can no longer
express moves INSIDE the transaction, as ANNOTATIONS on the changes
themselves — at the grouping the commit already tracks per action
run, the same granularity as scheduling basis rows and CFC
provenance (serving-loop.md §3b–§3c). `derived` is therefore the
ONE sanctioned commit variant that carries explicit user/session
keys inside; §2's read row is the same variant's read half (ledger
LD5), and the shared key vocabulary the annotations force is ledger
LD3 (key-vocabulary.md §3).

**Implementer disorientation guide.** Every intuition today's code
teaches is the ENVELOPE model, so mid-implementation several v2
shapes look like bugs. If one of these feels wrong, re-read the
quote above before "fixing" it:

- *"This commit's envelope has no user principal or session id —
  where does identity come from?"* From inside: the per-action-run
  annotations. Only `authored` commits still carry identity at the
  envelope.
- *"`resolveScopeKey` throws without a principal / would resolve
  `user:<serviceDID>` here."* The function itself is a pure
  constructor; it is its admission-side CALLERS that feed it
  identity derived from the authenticated session
  (`#decideTransaction()` in `packages/memory/v2/server.ts` threads
  the session's principal and id into `Engine.applyCommit`, whose
  `applyCommitTransaction` constructs the key) — the client-commit
  model. Server-side
  runs never derive identity from their own session: identity
  arrives WITH the work (the demand, or the stamped `firedAt`) and
  is carried into keys, not resolved from ambient state (scopes.md
  §5; key-vocabulary.md §3).
- *"One transaction writes as MANY different users at once — is
  that a bug?"* It is the point of the variant: the server acts for
  every client in one pass, which is exactly why its envelope
  cannot name one principal.
- *"Clients get rejected for naming a `scope_key` but the server
  does not — inconsistent?"* Two halves of one model: a client's
  keys derive from its session (sent as part of the session
  overall, never per commit); the lease holder names keys
  explicitly because no session of its own could supply them (§2's
  derived and read rows).

Identity at the derived envelope (R-Q6b, RULED, owner 2026-08-02):
`derived` is a DIFFERENT TRUST CLASS from `authored`. An authored
commit crosses a trust boundary — a session did work the server
never saw, so the envelope identity is the check. A derived commit
does not: the server admitting it also DID the work, so producer
and admitter share one trust environment at the envelope, and
envelope identity verifies nothing there. The SpaceServer therefore
commits under its own service identity — the envelope principal IS
the lease holder §2 checks — and TWO DISTINCT things ride WITHIN
the commit. Conflating them is the error this paragraph exists to
prevent:

- **ADDRESSING — the explicit `scope_key`, one per scoped write.**
  It names WHICH INSTANCE the row is. The engine keys rows by it
  (`(branch, id, scope_key)`, scopes.md §Anchors), and memo and
  clearance identity read it (builtins.md §2, scopes.md §6). It
  attributes nothing to anybody: an address is not a claim about
  who acted.
- **ATTRIBUTION — the acting identity, one per action RUN.** The
  user principal plus, where the run has one, the session — the
  same pair the envelope carries for an authored commit (and the
  pair the stamped `firedAt` supplies for handler runs), relocated
  to the granularity where it is true. The unit is the RUN,
  `action × instance`, NEVER the action: under
  fan-out one action runs N times as N principals inside ONE wave
  commit (scopes.md §2), so per-ACTION attribution would merge N
  principals' provenance inside the load-bearing enforcement
  (serving-loop.md §3c). CFC labels evaluate per instance run for
  the same reason. A run with no acting identity — a space-scope
  derivation before any narrowing — carries none, like the
  SpaceServer's own writes above. **A run's RESOLUTION identity and
  its ATTRIBUTION are two things (RULED 2026-08-16, the fan-out
  design §F/§I.2; fan-out stage B).** The demand supplies a FULL
  (user, session) pair as the run's resolution identity (a narrower
  read the run discovers must still resolve to a real demanded
  instance — for a user-scoped instance the session is the
  REPRESENTATIVE one, scaffolding only); what the run ACTS AS derives
  from the scope it DISCOVERS by running: space → no actor; user →
  the user (a user-scoped instance value belongs to all of the user's
  sessions — its events carry `firedAt.session = "server"`, events.md
  §2); session → the pair. Settled at the seal from the transaction's
  read-scope ratchet — the write annotations, the foreign-write
  accept gate, the delegated carriage (`demanded-run:<user>`) and
  the outbox carriage a completion inherits all read the settled
  pair. A MID-RUN emission (a derivation's `.send()`) derives its
  actor from the ratchet so far, never broader than the node's known
  scope for that principal, and the seal REFUSES the contribution
  fail-closed if the run then discovers a NARROWER scope than the
  emission was attributed at (the early-emit guard, design risk 4:
  an under-attributed event never commits; the retry — at the moved
  known scope — attributes it right; counted as
  `earlyEmitRefusals`). Handler runs are unchanged (the event's
  server-stamped `firedAt` is their explicit actor, LD1).

Attributed, not signed, today — and RECORDED, not read, today
(stated after the 2026-08-03 provenance audit asked): no
enforcement path consumes the attribution annotation — CFC labels
are the load-bearing enforcement — so its present consumers are
audit/forensics and the anticipated signature graduation below; a
mechanism that starts DECIDING from attribution needs a spec edit
here first. The considered alternative — N
commits per wave, one per session, each attributed at its
envelope — is recorded and rejected as the other extreme of the
same axis: the wave stays ONE
commit (§7's amplification budget). Anticipated, not built:
per-user server-generated keys under user-delegated authority; when
delegation exists, attribution graduates to acting-key signatures
without changing the envelope model. CFC labels remain the
load-bearing enforcement; commit-level identity is not load-bearing
(owner).

## 2. Admission, the whole table

| commit class | checks, in order |
| --- | --- |
| `authored` doc write | session authenticated → write authority on doc/path (existing ACL) → CAS on base revision |
| `authored` event append | session authenticated → append authority on stream doc → `eventId` unique among stream entries above the stream's `eventWatermark` (CAS — the dedupe horizon, events.md §4) → the memory server STAMPS `firedAt` from the commit envelope (authenticated principal + session); a client-supplied `firedAt` that disagrees is REJECTED, never corrected |
| `authored`, server-produced (outbox event append, `.inSpace` provisioning) | commit metadata carries the acting identity (`actingPrincipal` + `actingSession` — the ORIGINATING chain actor, events.md §2) + `capabilityRef` → admission validates that capability grant against the target doc/stream (a delegated-capability check, NEVER session-identity impersonation) → for event appends, `firedAt` stamps from the validated acting identity (the stamping paragraph below) → CAS. *(Phase-1 bound, stage D/F: the landed validation is carriage PRESENCE + COMPLETENESS — authored class only, non-empty `actingPrincipal` + `capabilityRef`, a sessionless batch refused for session-scoped writes (scopes.md §5) — with scoped writes keyed from the carried identity; RESOLVING the grant against the target doc/stream awaits per-doc grants, which today's ACL model does not hold, and is the named owed hardening — verification-coverage.md OW13.)* **Genesis of a provisioned space (RULED 2026-08-18):** the FIRST commit into a `.inSpace()`-minted space is its ACL, signed by the SPACE'S OWN identity (its keys derive from the creation name, CT-1650), and that same commit names the ACTING user OWNER (`{ [actor]: "OWNER", "*": "WRITE" }` — the shape a client mints); every later write into the space is the actor's, through this row's delegated carriage or a client's own session; the serving identity is neither owner nor actor at any step and appears nowhere in the ACL (verification-coverage.md OW31 — the build is owed post-merge, before the flip). |
| `derived` | producer holds the live `execution_lease` for the space (one equality check) → CAS |
| `system` | unchanged from today |
| READ naming an explicit `entity_scope_key` (not a commit — the read side of R-Q6b; S1; widened by FP2, RULED 2026-08-03) | requester holds A live `execution_lease` on the co-hosted memory server — its OWN space's lease, not necessarily the read space's (the read-side twin of §2's inter-server trust ruling: a home SpaceServer reads FOREIGN scoped instances for cross-space derivations, closing the silent-empty-instance trap cross-space) → the named instance is read. A non-lease-holder naming a `scope_key` is REJECTED (today the wire cannot even express one); a request naming none resolves from the authenticated session as today (the shared `resolveScopeKey` in `packages/memory/v2.ts`). *(Fan-out stage A, 2026-08-16 — the runner ISSUES these: a serving runtime's per-instance run whose read of a scoped doc names an instance other than the runtime's own — the demand-supplied identity's — loads it as an explicit-instance read (`Cell.sync`/`syncCell` with the run identity, the transaction layer's kick for a never-loaded instance, the presync of a served event's inputs as the event's actor), so the serving replica holds that principal's instance keyed apart from the service's; own-identity reads name nothing and keep the no-key admission fast path. A live lease holder may name TWO instances of one (branch, id, scope) — its frames carry `scope_key` (§3) — the wire collapse guard now applies to non-holders only.)* |

That is the ENTIRE admission surface — the last row is the one
READ-side check; every row above it is commit admission. No scope
reasoning, no read-set
validation, no certificates: no commit ever asserts that an execution
happened elsewhere. If an admission question cannot be answered by
(target, principal, lease, CAS), the design is drifting — stop.

**`capabilityRef` — the vocabulary, stated (adjudicated by the Phase-7
independent review, 2026-08-15; spec-sentence, no rename).** The value
is a provenance TAG naming the authorizing CONTEXT of a server-produced
authored write, from a closed vocabulary: `stream-append:<sidecarId>`
(an outbox event append), `event-consequence:<eventId>` (a consequence
of a processed event), `demanded-run:<user>` (a demanded instance run's
provisioning). Admission checks its PRESENCE (the completeness floor
above; wave.ts's staging refusal), never RESOLVES it — resolution
against a per-doc grant is the owed hardening OW13/FP7 — and the name
does NOT denote a capability object: nothing is looked up, delegated,
or transferred through it today. Renaming it would churn the outbox
column `capability_ref`, the executable model and their pins for no
semantic gain; when OW13 lands, the value becomes the key of the
resolved grant and this sentence retires.

**The Phase-3 floor carve-out for sessionless space-scope emissions
(SHAPE RULED 2026-08-05; implementation lands with Phase 3).** The
server-produced row's completeness floor admits an ABSENT acting
principal iff the entry is declared sessionless-space-scope: its
`firedAt` stamps `{ session: "server" }` with NO user key, and grant
presence (`capabilityRef`) stays mandatory — events.md §2 and the
executable model already carry exactly these semantics, so neither
needs an edit. What Phase 3's implementation lifts, by name: the
source refusal in `enqueueOutboundAppend` (wave.ts — today a
userless or grantless entry is a loud error at staging, fail-closed
ahead of this floor), the delivery path's `?? ""` acting-principal
mapping (the memory server's delegated-append admission), plus the
floor negatives BOTH ways (userless
space-scope-declared admitted; userless without the declaration
still refused) and the model pin. Tracked in verification-coverage
§3's Phase-3 bucket.

**Derived-envelope defense-in-depth (RULED 2026-08-05; the engine
check LANDED with Phase 1 stage F).** At admission, a `derived`
commit's producing SESSION must be the lease holder's own service
session: a derived commit arriving under a user session — or any
session other than the declared holder's — is REFUSED. This mirrors
the executable model's `admitDerived`, which compares the envelope
principal to `holderId`, and closes the "single honest internal
caller" gap before stage F multiplies the callers of the co-hosted
engine plane. The operand mapping (stage F design, landed): the
holder's own service session IS the engine session whose resolved
commit session key equals the DR1 holder identity — the wave sink
commits with `sessionId == holder` and no principal
(`applyCommitTransaction`, `packages/memory/v2/engine.ts`; the
sink's replay keying doc records the same choice), so the check is
one equality, `resolveCommitSessionKey(sessionId, principal) ==
holder`, and "the envelope principal IS the lease holder" (§1) reads
literally in the stored session column too.

**`firedAt` is SERVER-STAMPED, never client-minted (T1 + S6).** It
carries BOTH the acting user and the session —
`{ user, session, clientSeq }` — because scopes.md §5 resolves a
handler's scoped reads and writes against the user, not the session
alone. It steers consequences: which scope INSTANCES a handler's
writes land in (scopes.md §5), and which session an effect intent is
addressed to (§5, builtins.md §4). Nothing else in the append binds
it. STAMPING beats checking: the memory server writes `user` and
`session` from the authenticated commit envelope at admission, so a
forged actor is UNREPRESENTABLE rather than merely validated, and a
disagreeing client value is rejected rather than silently overwritten.
`clientSeq` stays client-minted — it orders one session's own appends
and steers nothing.
Delegated appends (the server-produced authored row above) stamp
from the CARRIED DELEGATION, never the delegating envelope:
`firedAt` := the validated acting identity in the commit metadata
(`actingPrincipal` + `actingSession`) — which, by the
actor-inheritance rule (events.md §2, owner 2026-08-03), is the
ORIGINATING chain actor: **events run as the session they
originated from**, so the target's session-scoped consequences and
its navigateTo intents land in the session that actually acted.
`actingSession` is absent only for a chain with no acting session
(a derivation-emitted event), which stamps
`firedAt.session = "server"`. The carriage is admissible on the
same one-trust-environment footing as §1's derived annotations —
the producer is a lease-holding SpaceServer on the same co-hosted
memory server, and the delegating commit's own ENVELOPE identity
is that SpaceServer's service identity (LT5, RULED 2026-08-03) —
the same envelope model as its derived commits; admissibility
comes from the validated grant, never the envelope. The trust
footing is RULED explicitly (owner, 2026-08-03): servers trust
each other's carried actor claims — for writes and events alike —
as if the principal and session had written directly; hardening
that trust (remote attestation) is anticipated future work.
Stamping from the
outbox's own envelope would instead run the target handler as
`user:<serviceDID>`, the silent-empty-instance trap this section
exists to prevent. A server-emitted SAME-SPACE event needs no
stamping row at all: the SpaceServer writes the inherited
`firedAt` into the derived-carried entry itself (events.md §2's
same-space carriage — LT1), producer and admitter being one trust
environment (§1).
This PRESERVES a guarantee the store gives today rather than adding
one: `resolveScopeKey` binds scope to the authenticated session
(scopes.md §7 M3), so cross-principal scoped writes are impossible on
main. It is the trivial case README §1's no-new-guarantees rule
exempts — one equality check at one site.

**Read addressing, and why it needed a row.** Writes name their
instance explicitly (R-Q6b); reads did not, and the asymmetry was a
hole, not a simplification. A SpaceServer reading under its service
envelope would resolve `user:<serviceDID>` — `resolveScopeKey` throws
only on a MISSING principal, never on a wrong one, so the failure
mode is a SILENT read of an empty instance, not an error. The row
above closes it by extending Q6b's own trust argument symmetrically:
the lease holder is the party the server already trusts to derive
every instance, so it may NAME an instance to read. RATIFIED
(owner, 2026-08-03; was ledger LD5): this row is the read half of
§1's transaction identity model — the server-driven variant names
keys on both sides of the wire, while the client-facing protocol is
untouched: a non-holder naming a `scope_key` is rejected (today the
wire cannot even express one — the field is new), and client reads
keep resolving from the session. FP2 (RULED 2026-08-03) widens the
holder condition to ANY live lease holder on the co-hosted memory
server, so cross-space scoped reads (§2b's free read row) can name
their foreign instance instead of silently resolving
`user:<serviceDID>`. **Phase 5 LANDED both halves the Phase-1 bound
deferred:** the read space's own lease is checked first, then FP2's
cross-engine fallback — any live lease on the co-hosted server; and
the equality is SHARPENED to the FULL DR1 holder minted by the
co-hosted process (service identity + process-instance component),
retiring the Phase-1 recorded acceptance under which a second
process sharing the service DID passed on the first process's lease
row (verification-coverage.md's stage-F read-row entry).

**The grant-scoped read DESIGN (Phase 5; the RULED 2026-08-13
precondition — the design, or an explicit fail-closed refusal, lands
BEFORE any delegated-scoped-read producer ships, and producer and
refusal land together as one stack).** A DELEGATED scoped read — the
home SpaceServer reading a FOREIGN scoped instance on behalf of a
carried actor — resolves against the CARRIED actor's instance under
an explicit grant, NEVER the delegating envelope, and NEVER silently
empty (the FP2 silent-empty-instance trap is the failure mode this
kills). The design, stated for the implementation that follows the
per-doc grant store (OW13's trigger): the read carries the acting
identity + `capabilityRef` exactly like the server-produced authored
row; admission resolves the grant against the target doc and admits
the NAMED instance (`entity_scope_key` constructed from the CARRIED
actor); a read whose grant does not resolve REFUSES — it never falls
back to lease-wide trust or the envelope. Until that store exists,
the FAIL-CLOSED interim is normative and LANDED with Phase 5's
producers, at both ends of the stack: (i) the serving runtime's
storage plane REFUSES scoped (user/session) reads of any non-home
space outright — a foreign scoped read cannot leave the producer,
named or unnamed; (ii) admission REFUSES an UNNAMED scoped root from
a co-hosted serving session (a live-lease principal) reading a space
whose lease it does not hold — the shape that would silently resolve
`user:<serviceDID>`. Cross-space serving therefore reads foreign
SPACE-scope state freely (§2b's free-read row) and foreign SCOPED
state not at all; lifting that refusal is exactly the grant
resolution above, never a lease-trust widening. Remote attestation
stays anticipated future work.

**Run identity for a derivation (S1).** A derivation runs PER
DEMANDED INSTANCE and the DEMAND supplies the identity — a
subscribing client demands its own instance, and that instance is
what the run reads and writes as. Before any narrowing, a node runs
at space scope and needs NO principal at all. Handlers are the other
case and keep the event's actor (scopes.md §5, server-stamped
`firedAt` above). There is no third source of run identity, and
"whatever the SpaceServer's own envelope resolves to" is never one.

Note what the table does NOT do: `authored` admission checks write
authority on the TARGET only — nothing marks a doc as derived-output,
so admission protects derived docs no more than today does (§1's
threat model, sharpened by serving-loop.md §3d's dependency-only
recompute rule, RULED 2026-08-05).

## 2b. Cross-space writes

The storage layer already enforces the load-bearing rule: **one
transaction writes one space — by DEFAULT, with one explicit opt-in.**
A transaction FAILS if a writer for a different space was already
opened on it (`V2StorageTransaction.#claimWriteSpace()` in
`packages/runner/src/storage/v2-transaction.ts` returns the
`StorageTransactionWriteIsolationError` that
`packages/runner/src/storage/interface.ts` declares) unless it opted
in through `enableMultiSpaceWrites` (`interface.ts`), reachable only
via the `.inSpace()` chain below —
which is what makes an UNMARKED crossing always a bug. Reads cross
freely (serving-loop.md §3b; cross-space label metadata flows with
them). v2 keeps that invariant and adds the class discipline:

| crossing | mechanism |
| --- | --- |
| read a foreign doc | free — logged read + server-internal wake (§3b). *Mechanism (OW31, RULED 2026-08-18/19, BUILT — retires the Phase-7 OWNER posture): the serving runtime's loopback sessions carry a session-level delegated READ binding (`actingAs: "space-owner"`, signed into the session.open descriptor), admitted only for the memory ACL's DELEGATING class — under the flag the co-hosted process identity (`memoryAclPrincipalsFor`), OFF the flag empty; the operator's OWNER-class `serviceDids` list is verbatim on both arms and the process identity is never in it by default. The memory server resolves the binding ITSELF from the space's ACL — the ruled "ACL can be read with service identity" — and the session's READ-class capability decisions (session.open, queries, watches) then run as the space's OWNER: the user whose space it is, `session.open` on an owner-only home space included. WRITE/OWNER-class requirements keep resolving against the ENVELOPE principal, so the binding grants no session-plane write path (served writes ride this table's delegated carriage; the observe-mode canary counts any residual); a delegating principal may not initialize a genesis; revocation judges the acting user, so an ownership change revokes the bound session and the next mount re-resolves. Spaces with no valid concrete-owner ACL bind nothing (fresh → authenticated READ, populated-legacy → the compat arm, malformed → fail closed). Trust footing: LT5's — the co-hosted process is already trusted for carried actor claims on the write plane; the binding ATTRIBUTES reads that were previously ambient under the blanket. If this posture proves wrong live, the ruling's own escape hatch is a flagged follow-up, never a quiet re-widening — verification-coverage.md OW31.* |
| derive FROM foreign state | home derivation reading foreign inputs; result commits HOME |
| mutate a foreign space | **an event append to a foreign stream — the ONLY cross-space mutation** |
| `derived` commit into a foreign space | FORBIDDEN — SpaceServer(B) is B's only deriver; A never derives into B |
| provision a foreign/new space (`.inSpace`) | authored-class, foreign-first split at the wave commit step — see below |
| client authored writes to several spaces | unchanged from today: separate per-space commits, per-space ACL + CAS |

The event append crosses as an ordinary `authored` commit under the
piece's append capability, carried by the OUTBOX (serving-loop.md §5):
at-least-once, deduped by `eventId` at the target's admission, FIFO per
(source wave → target stream). The commit carries the acting
identity (`actingPrincipal` + `actingSession` — the originating
chain actor, events.md §2) + `capabilityRef` metadata; the target's
admission
validates that grant (§2) — delegation, never impersonation — and
stamps `firedAt` from the carried actor, so the event RUNS AS THE
SESSION IT ORIGINATED FROM even across the space boundary. The
target's SpaceServer processes it like any event.
Rejection at the target (LT4, RULED 2026-08-03): the outbox's
at-least-once retry covers TRANSPORT failures only; a
DETERMINISTIC admission rejection — an invalid capability grant —
is not retried. It surfaces in the SOURCE space per events.md §5's
error-is-the-consequence shape: a failure notice on the source
event's stream entry, written by the source SpaceServer in a later
wave; the source event's own already-committed consequences stand. This matches the
codebase's own convention — patterns already mutate cross-space through
exported streams — and it is now the rule, not a style: a server action
tx that opens a foreign-space writer is a runtime error naming this
section.

**Provisioning writes — the second sanctioned crossing
(`.inSpace(...)`)**: the profile-system patterns create foreign spaces —
even mint new ones — from a handler (`profile-create.tsx`,
`ProfileHome.inSpace()`). The real chain is an explicit opt-in
end to end: `.inSpace()` → `optIntoInSpaceMultiSpaceCommit`
(`builder/pattern.ts`) → `Runner.enableCrossSpaceChildCommit()`
(`runner.ts`, commit order `[children..., parent]`) →
`enableMultiSpaceWrites` (`interface.ts`) →
`V2StorageTransaction.#commitMultiSpace()`/`#runSplitCommits()`
(`v2-transaction.ts` — sequential, stop at first failure): today
already foreign-first, home-after-success. v2 keeps the API, the
split, and the order,
relocated into the wave's commit step:

- Provisioning writes seal as AUTHORED-class commits into the
  destination space, under the **acting principal of the event** whose
  handler produced them (creating THEIR space — RULED; the only
  effect-authority residual is quota attribution, README §3.8),
  carried as the acting identity (`actingPrincipal` +
  `actingSession`) + `capabilityRef` commit metadata
  for the target's admission (§2). Never derived-class: single-deriver
  per space is untouched, and the minted space's own SpaceServer
  activates later (first session or event) as its only deriver.
- Sequencing at the wave commit step: foreign provisioning commits land
  FIRST (per destination space), then the home derived commit carrying
  the links and the `eventWatermark` advance. Same host, same process —
  this is store sequencing, not a network await.
- Failure: foreign fails ⇒ home never commits ⇒ the event stays
  unconsequenced and replays; persistent failure falls to the
  error-is-the-consequence rule (events.md §5).
- Replay safety: destination DIDs/ids derive from the creation event
  (CT-1650 — anonymous `inSpace()`, DID unique per user + creation
  event), so a replayed handler re-derives the SAME ids and the
  re-provisioning is a CAS no-op. The today-orphan window (foreign
  landed, home did not) becomes convergent instead of dangling.
  Provisioning handlers MUST therefore be deterministic given
  payload + cells — no clock, no randomness (events.md §3); replay
  convergence depends on it. A transformer lint can trail.
- The foreign-writer runtime error therefore narrows to ACCIDENTAL
  crossings: a server action tx may write a foreign space exactly
  where the API opted in (the `.inSpace()` chain above). Unmarked
  foreign writes remain an error naming this section — one tx, one
  space is the default, so an unmarked crossing is always a bug.
- Sharded future (spaces not co-hosted): provisioning becomes
  outbox-carried and the home commit defers a wave. Out of v2 scope.

**Atomicity, stated plainly:** nothing spanning two spaces is atomic —
not today, not in v2. A wave is per-space; cross-space influence is
asynchronous (reads/wakes inward, events outward). What v2 adds is that
the non-atomic boundary is EXPLICIT and carries defined failure
semantics: the outbox retries the append, the eventId dedupes it, and
the target's `eventWatermark` makes processing exactly-once.

## 3. Subscription and push

A server with execution enabled advertises optional `viewScopedReplicationV1`.
Clients without that capability use ordinary watches. An opted-in web client
adds session-owned `views` to `session.watch.set`; omitting `views` preserves
existing view ownership, while an empty array removes it. Ordinary watches keep
separate ownership. View revisions and server-side session/view lifetime tokens
reject stale publications, and `viewPlans` in a session sync frame apply after
the frame's documents. A plan-only frame is meaningful and must be delivered.

Visible roots contribute execution demand. The additional complete documents
selected for local previews contribute delivery only, under the same READ and
instance-scoping rules. The optional plan includes eligible graph positions,
source identities, admitted inputs, observed write surfaces, and fingerprints of
settled producer inputs/outputs. These are compact eligibility evidence, not the
durable scheduler-basis table. See the
[feature contract](../../features/view-scoped-client-replication.md) for guarded
execution and downgrade behavior.

- Clients subscribe to docs/queries as today
  (`packages/runner/src/storage/query.ts` path). The SpaceServer
  subscribes to the whole space's accepted-commit feed from a seq.
- **Push is FILTERED PER RECIPIENT by `scope_key`** (T4). One derived
  commit legitimately carries several principals' instances (§1's
  fan-out); pushing it whole would replicate other principals'
  scoped state to every subscriber and break scopes.md §4's promise
  that a client never holds a foreign instance. A subscriber
  therefore receives ONLY the rows whose `scope_key` is in its
  APPLICABLE SET — `space`, `user:me`, `session:me:<sid>` — the
  predicate `scopeKeyApplicableTo` in `packages/memory/v2.ts`,
  applied per session by `syncSessionForConnection` in
  `packages/memory/v2/server.ts` (a CURRENT lease holder admitted
  explicit-instance reads is exempt, per §2's read row). The commit's
  remaining rows are invisible to that subscriber: not redacted, not
  empty — absent.
  This pairs with scopes.md §7 M4's re-keying: the push path must
  key dirtiness by `scope_key`, and the same key decides delivery.
  *(Fan-out stage A, 2026-08-16 — the ONE wire addition on the push
  side: frames to a session that has been ADMITTED an explicit-instance
  read (§2's read row) carry `scope_key` on every upsert and remove
  (`SessionSyncUpsert.scopeKey`, `SessionSyncRemove.scopeKey`;
  graph.query snapshots to such a session carry `EntitySnapshot.scopeKey`),
  because that session legitimately receives EVERY instance it serves
  and may hold two instances of one (branch, id, scope) — the serving
  replica keys them apart by it. Every other session's frames carry
  scope NAMES only and resolve instances from the session, exactly as
  before — the OFF-arm wire is byte-identical. Amended 2026-08-17 (the
  stage-A independent review's finding 1): the keying is the session's
  STICKY wire vocabulary — armed by the admission, kept for the
  session's life, never hung from the live lease — so an instance
  delivered keyed is always retracted keyed (an unkeyed remove would
  name the client's OWN instance: a former holder's catch-up wiped the
  service's doc and kept the stale foreign one). Whether FOREIGN
  instances are DELIVERED stays the per-pass live-lease question of
  §2's read row: a lapse withholds them (incremental) or retracts them
  keyed (full evaluation), and the first live pass afterwards RE-ARMS
  with a full evaluation that re-delivers what the lapse withheld — a
  renewal blip the SpaceServer survives in-process reports the reacquire
  so that pass runs promptly (`Server.noteLeaseReacquired`), rather
  than leaving the serving replica silently stale until an unrelated
  write.)*
- **Basis-index rows are NOT part of the pushed commit** (T2). They
  ride the loopback store TRANSACTION only (serving-loop.md §1 plane
  (a), §3b); nothing about them crosses the wire to a subscriber,
  and admission never reads them.
- **Push priority** (Phase 6 hardening, but the contract is fixed now):
  when flushing a batch to a client socket, `derived` commits touching
  docs that client subscribes to go first; everything else follows.
  Bookkeeping MUST NOT ride the commit stream at all (lease renewals are
  table updates; watermarks piggyback on derived commits), so in practice
  priority is about big authored blobs vs small derived values.
  *(LANDED Phase 6 — the implementation shape, stated so no one infers a
  stronger one: each session gets ONE frame per flush cycle, so priority
  orders the serialized per-session evaluation/send chain — a two-phase
  fan-out runs every connection's derived-subscribed sessions before any
  bulk-only session — never the content of a frame; a session whose one
  frame mixes derived and bulk carries the whole frame at derived
  priority, because frames apply atomically and splitting one would put
  the catch-up marker ahead of undelivered covered docs — an INV-5
  hazard. Counters: `servingLoop.push.{prioritizedSessions,
  followerSessions, mixedFlushes}`, all-zero in the OFF arm by
  construction; the deterministic order pin is
  `packages/memory/test/v2-push-priority.test.ts`.)*
- Self-echo: SpaceServer skips its own `derived` commits on receipt
  (serving-loop.md §3).

## 4. The watermark

- Definition (sharpened by the 2026-08-02 demand ruling): `W(space)` =
  highest seq such that every authored commit ≤ W has all handler
  consequences committed AND all DEMANDED derivations current through
  W (demand per serving-loop.md §1/§3b — undemanded derivations stay
  dirty-unmaterialized without holding W back).
- **The drain-settle quiescence advance (RULED 2026-08-19 — owner, on
  the coordinator's S1 recommendation from the swatch-stall root-cause
  report: "S1 sounds good"):** the definition above quantifies over
  AUTHORED commits, so mid-stream the input-driven advance stops at the
  input batch head and the wave's own derived commits sit above W — and
  before this ruling nothing ever lifted W over them on a then-quiet
  space, which stranded every client retirement predicate gated on
  `W ≥ floor` whose floor includes a pushed derived commit's seq (the
  swatch stall:
  `docs/history/plans/server-execution-v2/stage-c/swatch-stall-rootcause.md`
  §3 — a diverged speculation layer with no reachable retirement until
  the next authored commit anywhere in the space). Amendment: at
  drain-settle — the serving loop reaching TRUE quiescence for a space
  (a settled, non-exhausted cycle; no contributions, no pending
  events, the drain empty) — W additionally advances over the space's
  committed TAIL DERIVATIONS: the loop's own derived commits whose
  seqs lie contiguously above the input coverage point. Reading taken,
  stated because the pre-amendment text was silent on it: W may sit
  above seqs that are not authored commits — the definition's
  quantifier ranges over authored commits only, and the tail
  derivations are already committed and delivered, so the advance
  asserts nothing new about coverage; it closes the quiescence gap
  ("each new input lifts the previous generation" now holds without
  requiring a next input). Bounds, normative: the advance covers only
  COMMITTED seqs — no speculative advance; it fires at most once per
  quiescence transition (armed by content-carrying own derived commits,
  including standalone effect completions,
  consumed on seal); its own advance-only commit is NEVER chased — the
  one derived commit W does not cover at quiescence is the final
  advance-carrying bookkeeping commit itself, definitionally (covering
  it would mint a successor — the commit-storm class the input-driven
  rule existed to prevent); and any non-own seq above the coverage
  point (an in-flight authored notice, a foreign commit) is a hole the
  advance stops below, fail-closed — its coverage arrives on the
  ordinary input-driven path. Counted as `settleAdvances` (count, last
  delta, series) so §4 amplification arithmetic and settle metrics can
  subtract the advance-only waves. Seat:
  `packages/runner/src/executor/space-server.ts` (the wave cycle's
  advance computation); pins: `executor-settle-advance.test.ts`.
- Carried: in every `derived` commit's metadata (`derivedThrough: W`) and
  in one well-known doc per space (updated in the same transaction; never
  its own commit). *(RULED 2026-08-05: "never its own commit" is the
  bookkeeping-off-the-commit-stream / push-priority rule — the advance
  rides whatever the wave commits, never a separate commit alongside
  it. It is NOT a ban on advance-only waves: an input batch that
  demanded nothing commits the watermark advance as that batch's ONE
  derived commit — serving-loop.md §3's per-batch commit, with the
  advance as its only content.)* The watermark doc is a SPACE-scoped
  instance —
  `scope_key = "space"` — stated explicitly so no one infers it.
- Client use: "settled" for a client = `W ≥ seq(my last authored
  commit)`. Integration tests MUST wait on this instead of text-polling
  (testing.md §3). Sync indicators read the same signal.
- W covers DEMANDED derivations (pull-based laziness, serving-loop.md
  §3b). Client subscriptions are demand, so a fresh subscription
  arriving after W may still trigger a recompute, whose results land in
  a later derived commit. Under fan-out (fan-out stage B, RULED
  2026-08-16) "demanded derivations" means every DEMANDED INSTANCE of
  every demanded node — `instances(known scope, demanders)`, serving-
  loop.md §3b — including the siblings a discovery re-armed in the
  same wave; an instance that was NOT demanded when W advanced (a
  later arrival) is ordinary later demand. One integer, no
  per-instance watermark.
- The watermark is ONE integer per space. Not per-doc, not per-piece, not
  vectorized. If a consumer seems to need a finer watermark, escalate
  before building it.

## 5. The client-effect channel (Phase 4)

Session-scoped, server-computed, client-enacted effects (README §3.7).

- One doc per session, addressed as a SESSION-SCOPED INSTANCE — not
  a path convention (T9, RULED here; owner-notable, it changes this
  section's addressing). The effects doc is one well-known doc id
  whose per-session instances are keyed by `scope_key`
  (`session:<principal>:<sessionId>`) exactly like every other
  session-scoped instance (scopes.md §Anchors). A path form
  (`session/<id>/effects`) was the earlier draft and is REJECTED: it
  would make the effects doc the one session-lifetime thing NOT
  instanced by `scope_key`, and scopes.md §3 promises ONE retirement
  rule for both. One doc id constant, exported once; the instance
  comes from the key, never from the path.
- **Write authority for the ack** is the owning session's own scope
  instance: the session writes its ack marks into the instance its
  authenticated `scope_key` resolves to, so no session can ack
  another's intents and no new ACL is needed. The SpaceServer
  writes the intents into the same instance by naming the
  `scope_key` explicitly (§1 addressing).
- Shape: the instance value is `{ entries, acks }` — `entries` an
  append-list of `{ nonce, kind, args, issuedIn: <derived commit
  seq> }`, `acks` a PER-NONCE map of the session's ack marks
  (`acks[nonce] = true`). v2 ships exactly one kind: `navigate`
  with `args = { target: <entity link> }`. The ack's map shape is
  RULED (owner, 2026-08-13 — ratifying the implemented shape; the
  earlier scalar `{ ackedNonce }` draft is REJECTED): a scalar
  last-ack field loses an earlier un-retired ack whenever two
  intents ack between retirement observations.
- The SpaceServer writes intents as part of ordinary derived commits
  (navigateTo's output). The session's client subscribes to its own
  effects doc, enacts, then commits an authored ack write — its own
  `acks[nonce] = true` mark; the next wave retires acked entries,
  pruning each retired entry AND its mark together. A stale mark
  (an ack naming no stored entry — a re-ack landing after
  retirement) is pruned by the same scan as a defined no-op, so
  re-acks are idempotent and marks never accumulate; map growth is
  bounded by per-wave retirement, and the session-lifetime GC
  (below) covers abandoned instances.
- Exactly-once enactment per nonce is the CLIENT's duty (it may enact
  optimistically from speculation, then reconcile by nonce —
  navigation is reversible). Reconciliation holds in either order. An
  intent that arrives, and begins enacting, before the client's own
  speculative run seals records the nonce, and that run's optimistic
  enactment converges on the record rather than enacting a second
  time. An enactment still in flight is awaited rather than assumed,
  since its failure retracts the record and the caller that found it
  must then enact. Nonce reconciliation covers only the
  intent-ARRIVES case: when the authoritative run computes no intent
  for an optimistically enacted navigation (branch divergence on a
  speculative read), the enactment STANDS un-reconciled — ruled PUNT
  (owner, 2026-08-27; register OW45) — and consumers must be robust
  to it. Reload between intent and ack: on resubscribe the client
  sees unacked intents and enacts them; nonces make re-enactment
  detectable. The reload × optimistic-enactment window MAY re-enact
  a nonce — the enacted-nonce record lives in the reload-wiped
  overlay — and that is ACCEPTED for reversible effects, which
  every shipped kind is (LT8, RULED 2026-08-03).
- **Failure postures (both RULED, owner 2026-08-13 — the Phase-4
  P1-1 residuals).** A FAILED enactment is never acked: the entry
  stays unacked in the store, and retry is DELIVERY-DRIVEN and
  RELOAD-DRIVEN only — the next delivery of the instance (any
  commit touching it) or the resubscribe re-read on reload
  re-enacts. No client-side backoff timer exists or may be added:
  the FORBIDDEN server-side retries below are not to be rebuilt as
  client timers. A PERMANENTLY MALFORMED entry — an unknown kind,
  an unstageable target — is never synthetically acked and never
  tombstoned: it stays unacked and LOUD (a warning per delivery)
  until the session-lifetime GC retires the instance with its
  session.
- Session lifecycle: `sessionId` is minted at client connect, persisted
  client-side across reloads, and retired explicitly on logout or by
  TTL. `sessionId` is CLIENT-GLOBAL (LT2, RULED 2026-08-03): one
  value identifies the session in every space it touches, so
  `session:<principal>:<sessionId>` is a well-formed instance key
  in ANY space — a foreign server accepts the carried pair as if
  the principal and session had written directly (§2's trust
  ruling). Retirement applies across every space holding the
  session's instances (scopes.md §3; the §8-item-2 GC design must
  reach them all). Effects docs are session-lifetime: a dead session's unacked
  intents retire with its effects doc — which, being a session-scoped
  instance, is retired by the SAME session-data GC as every other
  session instance (scopes.md §3, §8 item 2). One mechanism, as
  scopes.md §3 already claims.

FORBIDDEN: new kinds without a spec edit here; a push channel outside the
doc/subscription model; server-side retries of enactment.

## 6. Streaming (deferred, boundary fixed)

Settled-result-only commits are the v2 baseline; the interim loss of
LLM token streaming under the flag is ACCEPTED (owner, 2026-08-02).
If/when LLM partials ship, they use an ephemeral session channel
OUTSIDE the commit stream — partials never become commits, never touch
the watermark, never wake the serving loop. `stream-data` stays
disabled (README §3.5).

## 7. Wire-shape discipline

- Commit metadata additions in v2, complete list: `class`, `holder`
  (derived only), `derivedThrough` (derived only), `consequenceOf`
  (derived only), `eventId`/`firedAt` (event appends),
  `actingPrincipal`+`actingSession`/`capabilityRef` (server-produced
  authored commits
  only — §2; the acting identity is the ORIGINATING chain actor,
  events.md §2); plus, WITHIN a derived commit's body, the ADDRESSING
  and ATTRIBUTION pair §1 defines — never envelope identity (R-Q6b):
  the explicit `scope_key` on every scoped write (addressing) and
  the acting identity on every action RUN's writes, where the run
  has one — §1 (attribution,
  `action × instance`). The pair's CARRIAGE is server-internal
  admission input (like `commitClass`/`holder`: `ClientCommit`
  cannot express it), and its STORED form is a per-op-indexed
  sidecar on the commit row — recorded, never wire, never pushed;
  admission consumes only the addressing half, to key scoped rows
  (§1's recorded-not-read attribution). Anything further needs a
  spec edit here first.
- **`scope_key` is thereby PROTOCOL vocabulary**, no longer
  engine-internal vocabulary: it appears inside derived commit
  bodies and on lease-holder reads, so its format is defined ONCE
  in the wire-shape module (`packages/memory/v2.ts`, beside
  `CellScope` and `SessionId`) and imported by engine and runner
  alike — the LD3 ruling, key-vocabulary.md §3.
- **`eventId` and `firedAt` are ENVELOPE fields for admission** (T8),
  not payload: admission reads them (`eventId` for the uniqueness
  CAS above the dedupe horizon, `firedAt` because the server STAMPS
  it from the authenticated envelope — §2). events.md §1 states the
  same classification; if the two ever disagree, this section and
  events.md §1 are the pair to reconcile, and neither is a payload
  claim. For server-emitted SAME-SPACE events (events.md §2's
  same-space carriage — LT1) the pair rides instead as WRITE-LEVEL
  fields on the stream entry inside the derived commit — sanctioned
  carriage like the basis rows: admission never reads them there
  (the lease check admits the commit), and the closed metadata list
  is not breached.
- **A read may name an `entity_scope_key`** (S1, §2's read row;
  ledger LD5 ratified 2026-08-03 — the read half of §1's
  transaction identity model). That is the only read-side addition
  to the wire: one optional field on the read, admissible only for
  a live lease holder on the co-hosted memory server — its own
  space's lease (FP2, ruled 2026-08-03). Reads that name nothing
  are unchanged.
- Basis-index rows (serving-loop.md §3b) ride INSIDE the derived
  commit's store TRANSACTION as engine table rows — sanctioned
  carriage, NOT metadata and NOT part of the commit representation:
  nothing about them crosses the wire (§3 excludes them from push),
  admission never reads them, and the closed list above is not
  breached by them.
- The OUTBOX's identity carriage (serving-loop.md §4–§5: the
  result-cell address with its `scope_key`, the acting
  identity, AND — FP6, ruled 2026-08-03 — the run's CFC label
  basis, carried STRUCTURALLY as the basis reference, never as
  frozen label values: per the 2026-08-05 FP6 ruling the
  completion's writeback transaction re-reads the request inputs,
  so its labels derive from the basis AS IT STANDS at writeback —
  a frozen at-seal snapshot would write stale labels over a
  re-labeled basis) is likewise
  sanctioned NON-WIRE carriage: process-local, never a commit and
  never metadata — it exists so the completion commit can carry
  §1's IDENTITY annotations without re-deriving them (labels are
  the re-derived half, by design), and it does not
  breach the closed list. The DURABLE exception (FP1, ruled
  2026-08-03): cross-space APPEND entries are engine-table rows
  inside the emitting wave's store transaction, deleted on
  delivery-ack — the basis-row carriage pattern; still never wire,
  never metadata, never read at admission.
- All metadata is small and fixed-shape, with one bounded carve-out:
  `consequenceOf` scales with the wave's INPUT (the events drained that
  wave), never with graph size. The v1 failure mode — 130 KB of
  serialized read links per record — is structurally impossible if this
  list is respected. A metadata field that scales with GRAPH size is
  FORBIDDEN.
- Writes inside a `derived` commit keep PER-ACTION-RUN provenance for
  CFC label purposes (serving-loop.md §3c), carried in the write
  PAYLOAD, never as commit metadata: the commit is a transport batch,
  never a label boundary. R-Q6b's attribution (§1) rides at the same
  granularity — acting identity per action RUN (`action ×
  instance`), with the `scope_key` per scoped write doing the
  separate ADDRESSING job — attributed, not signed, today; when
  per-user delegated keys exist (anticipated, not built),
  attribution graduates to acting-key signatures without changing the
  envelope model.
