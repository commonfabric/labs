# v2 detail: built-in contracts

Normative expansion of [README.md](README.md) §3.5. One entry per
built-in family; an implementer should be able to port a built-in to the
serving loop from its row plus the referenced sections.

## Anchors

- Inventory: `packages/runner/src/builtins/` (registered via
  `registerBuiltins(runtime)` in `index.ts`).
- Raw builtin shape (from `navigate-to.ts`): a factory
  `(inputsCell, sendResult, addCancel, cause, parentCell, runtime) =>
  RawBuiltinResult` whose `action(tx)` runs under the scheduler. Served
  built-ins keep this shape — the serving loop hosts the same runtime.

The negotiated
[view-scoped client mode](../../features/view-scoped-client-replication.md) uses
stored output links for raw builtin boundaries. It constructs neither their
factories nor request-input hash computations. This also conservatively defers
pure raw structural builtins and dynamic child setup; the ordinary client's
speculation permissions below remain broader. The UI keeps authoritative
pending/error state until the server updates it.

## 1. Pure structural — serve as-is, speculable

`map`, `filter`, `flatmap`, `if-else`, `when`, `unless`,
`inspect-conf-label`, `wish`. (`list-element-link`,
`list-op-argument-usage`, `list-result-schema`, `op-pattern-ref` and
`scope-policy` are helper modules, not registered built-ins — nothing
to place.)

Contract: deterministic functions of their resolved inputs; no memo, no
authority, no outbox. They run wherever the graph runs (server
authoritatively, client speculatively) with zero code difference. Port
cost: none beyond running the existing registration server-side.

`wish` note: destination-fixedness (v1 task) is subsumed — a wish
resolves to data; any enactment goes through the client-effect channel
if it ever needs one.

## 2. Effectful — server-only, memoized, outbox-driven

Common contract (serving-loop.md §4–5): memo key from resolved request;
hit ⇒ stored result is the value; miss ⇒ outbox; result + key in one
derived commit; error results advance the same way; in-flight dedupe by
key; client speculation reads through (speculation.md §2).

A request reaches the outbox only if the commit that staged it succeeds. A
rejected commit clears the outbox, so nothing is sent and no receipt stands for
a request that never ran, and the action is attempted again. When the scheduler
stops attempting it, the transaction is abandoned and the builtin settles its
result with the refusal as its error, recording the request hash so the same
request is not staged afresh. `enqueueSinkRequestPostCommitEffect` carries that
as its `onRejected` hook, and every builtin on this table settles through it:
`llm` and its two siblings, `fetch`, `fetch-program`, `llm-dialog` and
`stream-data`. `sqlite*` reaches the same ending without the seam, giving its
effect an `abandon` directly, because it enqueues that effect by hand rather
than as a sink request.

The settled shape differs by builtin, and each writes what its own result
surface reads: an error beside a pending flag for `fetch` and `stream-data`, an
`error` cache entry for `fetch-program`, a settled `QueryState` for `sqlite*`.
`llm-dialog` is the one that settles by leaving the conversation alone: the
turn's user message, pending flag and request id all rode the abandoned
transaction, so an assistant error message would answer a turn no reader can
see. It takes the pending flag down and re-announces, and the refusal is
reported rather than written into the conversation.

| built-in | request inputs (memo key basis) | result cell | authority | notes |
| --- | --- | --- | --- | --- |
| `fetch` (`fetchData`) | url, method, headers (allowlisted), body, response schema | `{ result?, error?, pending }`; the memo hash is committed in the internal cell `{requestId, lastActivity, inputHash}` (`fetch.ts`) | capability handle bound at wiring (README §3.8) | redirects/deadlines per existing `fetch-request-deadlines` doc; the memo base is `` `${kind.name}:${inputHash}` ``; the served outbox key also names the target document and its resolved user or session instance |
| `fetch-program` | URL | `{ pending, result?, error? }`; successful `result` contains source `files` and `main` | same | the durable cache is keyed by input hash; served outbox keys also name the cache document and resolved user or session instance |
| `llm` (`generateText` / `generateObject`) | model, messages/prompt, schema, params | settled result only (protocol.md §6 — no partial commits in v2); `requestHash` on the result cell selects the pending request and accompanies its settled result or error | broker-held provider keys; grant from handle | temperature etc. are inputs, so nondeterminism is memo-stable by construction |
| `llm-dialog` | dialog state + params | settled turns | same | multi-turn = new key per turn |
| `sqlite*` | database link, statement, params, reader principal, the run's effective read ceiling (the serving runtime's option met with the ceiling of the session the run acts as — `WaveRunContext.readCeiling`, serving-loop.md §3c) | one cleared result cell per (query, reader) | read served under the reader's clearance and the run's ceiling | clearance = per-reader materialization (RULED 2026-08-02) — see below; a ceiling applies to a session-scoped result only, so two sessions of different ceilings hold different cells and different hashes |
| `agent` | task text, input links, result schema, `maxConfidentiality`, tool names | `{ pending, result?, error?, requestHash?, run?, host? }`; `result` and `run` are links, to the result document the run's harness wrote and to the `AgentRun` record | the requester's, held by the runner that claims the record | the outbox effect creates the `AgentRun` record (per user, in the requesting space) and indexes it in the requester's home space; the result cell derives from the record, so the memo is the record's existence; behind the `agentBuiltin` flag |

The shared `fetch.ts` builtins retain independent request lifecycles for each
served result instance. The requesting run's identity resolves the outbox key
and every asynchronous claim, completion, error, abandonment, and teardown
transaction before its first cell read. A served mutex claim commits the
validated input hash with its claim id and activity timestamp, so a subsequent
unchanged-input run recognizes that in-flight request. Each issuance captures
its own run identity, including when a shared scope changes representatives.
One graph-level cancellation callback visits retained instances; completed or
idle instances retire after their accepted outbox requests, active work, and
pending publications settle.
Late refusal callbacks cannot mutate a replacement instance. Each result
instance retains one latest pending publication per physical output-binding
instance; declared result-container scope does not determine that address.
Accepted publication, including memo and empty results, supersedes older
requests selecting another target for the same binding. Distinct bindings can
announce a shared result independently without changing another request's
result fields. Unstamped client runs use the runtime's own identity and keep
one local lifecycle.

`fetchProgram` retains accepted requests per resolved cache instance and input
hash, including requests waiting for dispatch. Cell handles are shared per
symbolic scope; each request captures its issuing identity for completion,
refusal, and teardown reads and writes. Different URLs may resolve concurrently
and remain cached, so returning to an earlier URL can use its original request.
Only the selected URL is projected into the published result. Stopping the node
releases its accepted claims and suppresses writeback from every dispatched
resolution. Cancellation does not reach `HttpProgramResolver` network requests.
Accepted publication owns the raw node's physical binding independently from
cache state. A late refusal cannot replace another actor's accepted target, while
distinct bindings can announce the same pending result. Attempts for one physical
binding share an accepted-publication sequence; a retry supersedes an earlier
refusal only when its publication commits. Staging retains one record per binding
and target, including after a refusal write fails, until an accepted publication
covers it or the node stops. A rejected release check
releases a claim with no dispatched owner. Accepted request records retire when
their work settles.

Served `llmDialog` captures the issuing handler's identity for transcript reads,
claim checks, and turn-completion writes. Each asynchronous read phase uses a
fresh transaction for that identity. Cell handles are shared per symbolic
scope, while active turns are tracked per resolved result instance and retire
when their model, tool, and error-write work settles. Stream markers are
initialized independently in each instance. A cancellation takes effect only
after its transaction and wave accept; withdrawing it leaves the accepted turn
running. Refusal restores a binding while its attempt owns that physical
publication coordinate; an accepted selection of another target supersedes it,
while a withdrawn publication does not. Refusal does not append an assistant
response for an uncommitted user message. Accepted claims retain local ownership
before outbox dispatch, even when the stored `lastActivity` timestamp is older
than the five-minute threshold for considering another replica's request
inactive (`REQUEST_TIMEOUT` in `llm-dialog.ts`). Graph stop aborts active turns
and clears matching accepted claims; later acceptance or
dispatch cannot restart the stopped dialog. A provider release rejection clears
its undispatched claim without replacing an active turn. These lifecycle
guarantees do not establish actor partitioning for management-tool reads or the
tool input integrity gate; those remain tracked under verification-coverage.md
OW28 and OW53.

Served `llm`, `generateText`, and `generateObject` bind lifecycle state and
outbox identity to the resolved output instance. The pending request writes
`requestHash` with `pending: true`; only a settled result or error constitutes a
memo hit. Unqueued completion checks the selected hash under the issuing
identity and reads the current input label basis before writing. An A→B→A selection can
therefore reuse the original in-flight A while a stale B response leaves the
current result alone. A refused staging attempt can restore its own output
binding without replacing an accepted request's pending state or result. Each
live result instance retains the latest staging attempt per resolved output
binding; a retry replaces that binding's prior attempt. Binding ownership uses
the raw node's physical publication coordinate, which can differ from its
declared result or container scope. An accepted publication
to a different target supersedes older attempts for the same binding, including
memo hits that publish an unchanged link and terminal refusal announcements.
Publication acceptance waits for the wave verdict. Work from a withdrawn
contribution does not reach the model.
Parent binding publication follows the selected target separately from request
state, so a scope change can return to an existing target. Settled in-memory
instance state retires once no staging or dispatched work owns it; durable
result cells retain memoization.

`agent` differs from the rest of the table in what its effect does: nothing is
sent. The post-commit effect writes an `AgentRun` record — the request fields,
`state: queued` — in the requesting space under the requester's user instance,
re-reading the request under its own transaction so the record carries that
read's labels, and appends a `{run, host}` entry to the home-space index a
runner process subscribes to. The runner claims the record, runs the harness as
the requester, and writes the terminal fields as an authored client; the
builtin reads the record and never writes it again, which is what keeps the
runner's authored writes and the effect's derived creation from ever
overlapping. Inputs reach the record as links, so what the sink gate measures
is the task text plus the pointer label of each reference. A request naming a
tool the requester's registered runner does not offer settles with
`INVALID_INPUT` before it is staged, and one whose consumed label exceeds its
own `maxConfidentiality` settles the same way.

Named queues retain their issued work when inputs are cleared. Queued
`generateText` and `generateObject` publish each completion even when a later
request is queued; `llm` publishes only its latest request's successful result.
Queue completion writes remain bound to the issuing identity and read the live
input label basis. This queue behavior applies with server execution on or off.

Served space-local `sqliteQuery` keeps equal non-clearance query hashes across readers,
while its outbox key and in-flight RPC set resolve the result's user or session
instance. Each completion and refusal captures its result target and binds the
issuing identity before reading the stored claim. Pending publication ownership
is separate for each result and physical output binding; accepted actions and
refusal publications supersede older targets only after commit and wave
acceptance. Distinct bindings may link the same pending or settled result.
These tokens retire on acceptance, refusal, or replacement; memoization stays
in the result cells.

Foreign `sqliteQuery` resolves the provider from the referenced handle's space,
narrows results to at least user scope, and includes the reader in request
identity (with session identity only for session-scoped results). Served foreign
reads carry the complete scoped reader identity to a server advertising
`sqliteQueryReader`. That server checks the source-space session and the carried
reader before and after the read, and resolves scoped databases against the
carried identity. Space-local queries retain transport-session database selection.
See [SQLite execution](../sqlite-builtin/04-server-execution-and-transactions.md#referenced-databases-and-reader-authorization).

`sqlite*` row clearance — RULED 2026-08-02: **per-reader
materialization**, today's shape. The reader principal is part of
the memo key, and each (query, reader) pair materializes its own
cleared result cell, cleared where the read is served — no two
readers ever share a result cell. The reader is taken at the
result's granularity (RULED 2026-08-22): a cleared result whose
scope is `session` (the result's scope is the narrowest of the
query's declared result scope, the db's scope, and the
clearance-forced `user` floor — either declaration takes it below
`user`) joins the run's SESSION to the
request identity alongside the user, one cleared cell per
query-and-reader-at-matching-granularity, so two sessions of one
user share neither hash nor effect key; at `user` scope the
request identity stays session-blind. Row admission is a user-principal
question at every granularity — the session splits the cell and
the keys, never which rows the user may read.

FORBIDDEN: any of these executing in a client runtime under the flag;
result caches outside the cell (no process LRU that survives the memo
rule); streaming partial commits.

## 3. Compile / instantiate — server-side, sandboxed

`compile-and-run`: compiles + instantiates patterns (piece creation),
including when invoked from a handler's consequences. Runs in the
SpaceServer's runtime; compilation itself already happens server-side in
toolshed — reuse that path. Async work stays on the post-commit outbox
(the v1 lesson that ported: never block the loop on compilation).
Instantiated pieces join the space's graph and are served like any other.

The request snapshots the resolved program, including attached data files,
and passes the `compileAndRun` sink ceiling before the outbox releases the
compiler. Dispatch also waits for the issuing contribution's acceptance;
a selectively withdrawn contribution launches no compile. Completion carries
the issuing instance's identity and checks the request hash in its memo cell.
The memo keeps a fixed shape: the request hash and a `pending`, `compiled`, or
`resolved` phase. Each transition updates that state without deleting fields
that a concurrently accepted completion may already have replaced.
Completion reads current source inputs for CFC labels without using those
values to select the request. A superseded completion writes no result and
releases its process-local issuance marker, so a withdrawn replacement can
reissue. A successful compilation records readiness; the derivation stages
child setup and resolves the request together. After restart, an unresolved
request reissues through the compile cache in the child's space before consuming a
process-cached artifact.

An empty main name and empty source-file list clear the request even when an
attachment list is present. Incomplete source hydration preserves the accepted
request. The full program, including attachments, remains the memo-key basis.

A deterministic scoped child may select different programs in different
instances. Its piece registration owns one node group per canonical program
identity; instances selecting the same program share that group. Each group
reads the current instance's program selection before executing. These reads
participate in dependency tracking and the commit basis. Static child setup
and passthrough bindings initialize separately in each instance's transaction;
the parent group retains each child once. A pointer coordinator observes
selection changes and restores the required groups on
resume. Clearing one instance clears its selection, and replacing it retires
the old group only after accepted replacement and only when no other
instance or pending setup selects it. Handler streams select the actor's
implementation during dependency preflight and again at dispatch.

Keyless pointer publication and program-group retirement wait for both the
transaction's acceptance and its deferred local callback. A local state change
with no storage writes still contributes its read dependencies to the wave, so
withdrawing a dependency also withdraws that change. These callbacks consume
neither network budgets nor builtin request metrics. Publishing a keyless
pointer wakes its coordinator and the installed guarded actions.

Result-as-pattern instantiation — a lift or handler RETURNING a
pattern, instantiated into a deterministic result cell — is a RUNNER
path distinct from `compile-and-run` (no compilation step), and it runs
server-side as an ordinary consequence of the graph run: the child
joins the space's graph the same way (runtime-mapping.md N37/N38).
Client speculation MAY instantiate result-as-pattern children
overlay-locally (owner, 2026-08-02 — REVERSING the earlier
no-speculative-children rule): child ids derive from cause, so the
speculative child converges with the authoritative one by identity;
overlay containment applies — nothing commits (speculation.md §2).
`compile-and-run` children stay unspeculated: compilation is an
effectful step, so the branch reads through until the authoritative
child arrives.

## 4. Client-enacted — `navigate-to`

Split contract (protocol.md §5): the SERVED half computes the target
(existing `navigate-to.ts` logic minus any client assumption) and writes
the §5 entry — `{ nonce, kind: "navigate", args: { target },
issuedIn }`; protocol.md §5 is normative for the shape — into the firing
session's effects INSTANCE — the effects doc addressed by that
session's `scope_key` (protocol.md §5, T9) — as part of the wave's
derived commit. The CLIENT half
subscribes to its effects doc, enacts, acks by nonce. Optimistic
enactment from the speculative handler run is allowed; the nonce
reconciles it in either order, so an intent that arrives before the
speculative run seals stands that run's enactment down.

Implementation note: the served half needs the firing session's
identity — it comes from the event's `firedAt`, which is
SERVER-STAMPED (from the authenticated commit envelope, or from the
validated carried actor for delegated appends — protocol.md §2) and
carries
both user and session (events.md §1, protocol.md §2). The served half
CONSUMES that value; it never re-derives, defaults, or trusts a
client-supplied one. Actor inheritance (events.md §2, owner
2026-08-03) is what makes this compose across chains: an event
emitted by a handler run carries that run's acting identity, so a
navigateTo computed several hops from the click — cascades and
cross-space appends included — still addresses the SESSION THAT
CLICKED. "Consequences of a client-fired event" below means the
whole inheritance chain, not just the first hop. A
navigation computed outside any event context (pure derivation) has no
session, and a sessionless event (`firedAt.session = "server"`,
events.md §2 — no acting session anywhere in its chain) has no
client to enact — both are the SAME runtime
ERROR: navigateTo MUST be reachable only from the consequences of a
client-fired event. Enforce with a runtime check, not a type dance.

**Cross-space navigateTo is DEFERRED (LT3, RULED 2026-08-03).** The
intent write additionally requires the acting session to be a
CONNECTED session of the COMPUTING space: sessions are valid across
spaces (protocol.md §5, LT2), but a space the client holds no
connection to has no channel to deliver the intent on — it would
compute an intent nobody enacts. A cross-space chain that computes
navigateTo is therefore the same runtime error, naming this
section. In practice this bites rarely: the navigateTo-producing
handler is an immediate consequence of a click, so the CONTEXT is
same-space even when the navigation TARGET is a cross-space link.
Anticipated redesign, out of v2 scope, recorded so the deferral has
a direction (owner, 2026-08-03): the client VENDS its own stream
target for effects — reversing the flow, the client's connected
stream is passed to other spaces, which then append intents to it.

## 5. Deferred / excluded

- `stream-data`: disabled under the flag (owner, 2026-08-02 — unused;
  low-latency UI wants a different mechanism). A pattern using it under
  the flag gets a clear runtime error naming this section.
- `resume-republish`: re-evaluate under v2 recovery — it is currently
  LOAD-BEARING on main in `filter.ts`/`flatmap.ts` (#4367, #4438), so
  "do not port" is not on the table; decide its end state against
  serving-loop.md §6 when Phase 1 lands the list coordinators.
- `wish` home-space materialization under serving — LIFTED by Phase 5
  as **per-demanding-identity wish resolution** (RULED 2026-08-14;
  supersedes the (c)-ruled interim refusal): on a serving runtime the
  wish's home-space targets (favorite hashtags and `#favorites`/`#journal`/`#profile`
  family) resolve against the RUN's demanding identity — the
  demand-supplied instance identity (P2-F's run supply) or the
  event's stamped actor, read from the stamped run context — NEVER
  the service identity (`Runtime.homeSpacePrincipalFor`); a
  home-space wish with NO demanding identity refuses loudly (a
  WishError at the resolution guards; a hard error at the cell
  resolution backstop). Its home-space bootstrap writes ride
  protocol.md §2b's `.inSpace` sanctioned crossing — authored-class,
  foreign-first, under the demanding principal's acting identity +
  grant, ADMITTED at the wave's accept gate because the target IS the
  demander's own home space (the gate's owner-by-identity structural
  grant, serving-loop.md §3d — carriage alone admits nothing). A
  carriage-less or UNGRANTED foreign write — the lunch-wall class,
  and an actor reaching beyond its authority — still refuses at
  accumulation, action-scoped and counted (`foreignWriteRefusals`).
  A sidecar's compile-cache context is the space its own piece lives
  in — the SERVED space on the serving side, never the service
  identity's own (the same class of ambient-identity leak, closed
  with the same lift) — which is also where the source lifecycle
  requires that piece's source to be resolvable. The sidecar
  SURFACES key per demanding identity: the result/ready cells, and
  the builtin's per-node record of the pattern each surface's piece
  runs (one wish node serves every demander; a shared slot would
  hand demander #2 demander #1's create surface and clobber the
  pending input).
  Client wishes are byte-identical to before (cardinality 1: the
  runtime's own user; the client suggestion-cell cause carries no
  user key, exactly as before). *Phase 7: on a flag-ON NON-serving
  runtime the sidecar surfaces (create/picker/suggestion) are the
  SpaceServer's compile-instantiate steps (§3) — the client's
  speculative wish run REFERENCES the served sidecar cell
  (cause-derived, so both sides name one doc) and never fetches,
  instantiates or writes it (pre-Phase-7 a flag-ON client's
  bookkeeping-stamped instantiation raced the server's on the same
  docs). The OFF arm and the serving runtime are unchanged.*
  *Read authority for the demanding user's home space (OW31, READ
  side RULED 2026-08-19; BUILT — supersedes the Phase-7 OWNER
  posture): the served wish's foreign reads ride the serving
  runtime's loopback plane, whose sessions carry the
  `actingAs: "space-owner"` delegated READ binding — admitted only
  for the flag-gated DELEGATING process identity
  (`memoryAclPrincipalsFor`; never an OWNER-class service DID by
  default) — so the session's READ-class capability on the demanding
  user's home space resolves as THAT USER (the space's ACL owner,
  which the memory server dereferences itself: the ruled
  service-identity ACL read). WRITE/OWNER-class requirements keep
  resolving against the service envelope — the binding grants no
  session-plane write path; the wish's home-space bootstrap writes
  ride the wave's §2b delegated carriage exactly as above, and a
  provisioned space's genesis is signed by the space's own keys
  naming the acting user OWNER (protocol.md §2's genesis clause).*

## 6. Adding a new built-in under v2 (checklist for future work)

1. Classify: pure / effectful / compile-instantiate / client-enacted /
   deferred — README §3.5's five classes. There is no sixth.
2. Pure ⇒ nothing else. Effectful ⇒ define the memo-key basis in §2's
   table via spec edit, wire the outbox, never the loop.
   Compile-instantiate ⇒ §3's contract (async on the outbox; the result
   joins the graph). Client-enacted ⇒ new `kind` in protocol.md §5 via
   spec edit. Deferred ⇒ disabled under the flag with a runtime error
   naming §5.
3. If the built-in seems to need per-run persisted provenance, a claim,
   or its own commit class — it does not; re-read README §2.
