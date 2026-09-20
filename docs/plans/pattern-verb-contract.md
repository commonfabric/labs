# Pattern verb contract

**Status:** design draft, partially implemented. The contract itself (Part 1) is
not agreed. Part 2's runtime and dispatch pieces have since landed — see the
2026-07-30 amendment below — so this document is still argued with, but no
longer ahead of all its code.

**Summary.** A pattern's declared verbs are its agent API: the CLI is a generic
projection of them, so each pattern defines its own command surface and no
pattern-specific CLI code exists to write or drift. Today that projection is
lossy — a create returns no handle, a rejection looks like success, a retry can
duplicate. Part 1 is the authoring contract for verbs: named fields, atomic
units, declared results, typed rejections, no call-order dependence. Part 2
makes results durable and retries idempotent by exposing the scheduler's
existing event-id and receipt machinery through the callable layer. The core
invocation path needs one small runtime change; general execution attribution
is a separate, CFC-gated track.

**Review update (2026-07-24).** Post-merge review of PR #4968 corrected three
boundaries in the draft: generic actor attribution belongs in CFC provenance,
not a parallel invocation field; patterns return child references while clients
render their ids and paths; and client-local `@name` bindings are deferred
because they overlap confusingly with fabric-side slugs.

**Context added (2026-07-28)**, from a further review pass — additive, no
decision changed. Prior art records the llm-dialog builtin as a second in-tree
precedent for the invocation protocol. The "no third callable kind" decision is
restated as a deferral rather than a rejection, with the two properties that
keep a create verb additive later. Discovery records two deferred `cf piece
get` read-control flags, and the machinery that would make verb sets structural
interfaces — along with the unsettled question of how a verb is identified,
which that machinery depends on. Rule 6 and the schema-evolution section each
gain the second reason they are load-bearing.

**Amendment (2026-07-30)**, from repointing this document's source citations at
symbols rather than line numbers. Verifying each one against the tree showed
that WS-D has landed whole, and the claims below are corrected in place:
`Cell.send` accepts a caller-supplied event id and scopes it by the session
that chose it and the stream it was sent to; `resolveInvocationIdentity` mints
the id–session pair for every `cf piece call`, so the pair is always supplied
rather than only when a caller passes `--invocation`;
`executeResolvedCallable` forwards it, then reads the handling's outcome back
off `tx.handlingReceiptLink` and returns it as `invocation.result` — including
on a receipt-exists collision, where the original handling's outcome settles
the retry. The plain-JSON-return-into-the-receipt change exists behind the
`plainResultReceipts` option — default-on since the three-topic integration
proof (#5244) satisfied governing decision 2's gate (the flip's staging is
recorded in the implementation plan). What remains open is all of Part 1.

## Goal

Any pattern drivable by an agent, with no pattern-specific CLI code. Filing one
topic on the team board took six CLI invocations, returned no handle, hid
rejections, and duplicated on retry; `topics` is now down to three and surfaces
its refusals, which is what adopting this contract buys. The fix was smaller
than it looked, because the hard parts already exist in the runtime: a durable
id per event, a per-invocation result cell addressed by it, and an exactly-once
receipt. Retry idempotence is the part still outstanding.

The design is two halves. **Part 1, the verb contract**: rules pattern authors
adopt so their verbs are drivable — pattern-owned vocabulary, no new machinery.
**Part 2, the invocation protocol**: the scheduler's existing invocation
machinery exposed through the callable layer — caller-supplied ids in, durable
results back. Patterns choose the words; the runtime carries them.

`topics` / `topic` is the running example and the intended first adopter.

## The problem

Filing one topic headlessly takes three CLI invocations:

| invocations | what | cause |
| --- | --- | --- |
| 1 | `addTopic {title, body, agentName}` | the create itself, carrying the body and handing back the topic it made |
| 2 | `addComment` / `addLink` | the real work, and not protocol tax |

That is what this contract asks of a create, and `topics` has reached it: the
body rides the create, so no `setBody` finishes one; a declared result hands
the topic back, so the caller neither searches a list for what it just made nor
reads it back to learn whether the call did anything; and a refusal throws
rather than returning quietly. What remains below is stated against the shape
that got here.

Three consequences the contract exists to remove, two of them now removed in
`topics`:

- **A create with no declared result returns no handle**, leaving the caller to
  search a list for the thing it just made. `addTopic` declares one
  (`AddTopicResult.topic`) and hands back the piece itself, which is the shape
  this contract asks of every create.
- **Semantic rejection is invisible.** Runtime failures surface; a verb
  declining on its own terms does not. `addTopic` now throws through
  `rejectMutation` on an empty title and on a blank `agentName`, which surfaces
  — as prose in a failure message, not yet as a typed code.
- **Retries can duplicate.** One reported headless session saw creates report a
  sync timeout after the write had committed, so retrying minted duplicates.
  The topics skill advises "retry once" on an initial-sync timeout — safe only
  when initial-sync and post-send timeouts are distinguishable to the caller.

The redesign below starts from the machinery that already exists, states which
of its properties are load-bearing, and then changes only the rest.

## What already exists

The CLI has two callable contracts (`callableCommandSpec`,
`packages/cli/lib/callable.ts`), and both of them block:

**`handler`** — default verb `invoke`, input schema only. Execution sends into
the stream, awaits `runtime.idle()` and `manager.synced()`, then inspects the
transaction and throws on runtime failure (`executeResolvedCallable`'s handler
branch, same file). It returned nothing when this was written; it now returns
an `invocation` carrying the id, status, and the result read back off the
receipt.

**`tool`** — default verb `run`, input schema plus `outputSchemaSummary`. A tool
is a *bound sub-pattern*: execution calls
`runtime.run(tx, pattern, mergeToolInput(input, extraParams), resultCell)` to
instantiate the pattern with the caller's arguments merged over the bound ones,
into a freshly minted result cell (`runtime.getCell(space, crypto.randomUUID(),
…)`), then returns that cell's value as `outputText` (`executeResolvedCallable`'s
tool branch, same file).

And beneath the CLI, the scheduler already has invocation machinery that the
callable layer predates:

- Every event gets a **durable event id minted at send time**
  (`packages/runner/src/scheduler/event-identity.ts`; spec scheduler-v2 §7.5),
  and `queueEvent` already accepts a **caller-supplied id** — its `opts.eventId?`
  (`Scheduler.queueEvent`, `packages/runner/src/scheduler/facade.ts`), with its
  own passing test suite
  (`packages/runner/test/scheduler-event-receipts.test.ts`). `Cell.send` now
  takes that id as its third argument and `Cell.set`'s stream branch forwards
  it through `scopeCallerEventId` (`packages/runner/src/cell.ts`), which binds
  an opaque caller key to the specific stream so two verbs sharing input
  bindings cannot collide on one receipt.
- Every handling gets a **canonical per-invocation result cell** addressed
  `{ resultFor: cause }`, where `cause = { $ctx: <bound closure>, $event:
  <event id> }` — `Runner.#instantiateJavaScriptHandlerNode` builds the `cause`
  (`$event: tx.dispatchedEventId ?? crypto.randomUUID()`) and
  `Runner.#handleJavaScriptHandlerResult` mints the cell from it, both in
  `packages/runner/src/runner.ts`; the `$ctx`/`$event` argument shape comes
  from `generateHandlerSchema` (`packages/runner/src/schema.ts`). So the
  address folds in the handler's binding, not the id alone. A return value
  **containing reactives or cells** is run as a result pattern into that cell
  (`navigateTo` is the existing UI consumer); a **plain JSON return projects
  into the receipt** under the `plainResultReceipts` experimental option
  (default on — an explicit `false` restores the discard, where the
  receipt-only branch writes `{}`). The receipt write uses the standard
  cell-write conversion, so a bare cell return that launches nothing — e.g.
  the chained return of an expression-body `action(() => cell.set(...))` —
  records as a link to that cell.
- That result cell doubles as the **exactly-once receipt**: its create is
  create-only, so a second handling of the same id — including from another
  replica against a shared server — collides, and its commit is rejected as
  `PreconditionFailedError` / `precondition: "receipt-exists"`,
  programmatically distinguishable from a real failure (spec §7.6, invariant
  I11). The governing `commitPreconditions` flag is on by default on the CLI's
  runtime path (its entry in `runtime-presets.ts`'s experimental-option table
  → `experimentalOptionsFromEnv`). Exactly-once is **per commit, not per
  execution**: a colliding delivery still runs the handler body and then loses
  the commit, so a handler must keep side effects in its writes — which the
  model already demands.

Measured against the problem above, what is absent is not machinery but
plumbing through the callable layer:

1. **No caller-supplied id from the CLI.** *Closed.* Written when `cf piece
   call` sent without an `eventId`, so a client retry minted a fresh event and
   re-executed rather than colliding on the receipt. `resolveInvocationIdentity`
   (`packages/cli/commands/piece.ts`) now mints the id–session pair whenever
   neither is named — refusing an `--invocation` named without its session —
   and `executeResolvedCallable`'s handler branch
   (`packages/cli/lib/callable.ts`) forwards it as
   `{ eventId: invocation.id, session: invocation.session }`.
2. **No readback.** *Closed.* The same handler branch reads the receipt at
   `tx.handlingReceiptLink` through `runtime.getCellFromLink`, pulls it, and
   returns the value as `invocation.result`, treating a value-less verb's
   empty record as existence-only. A receipt-exists collision reads back the
   ORIGINAL handling's outcome, so a retry settles as a success without
   committing again — the redelivered body still runs, and then loses the
   race for the receipt.
3. **Patterns return nothing.** All of `topics` is handlers that return no
   value — `addTopic: Stream<AddTopicEvent>` on the board, and the
   `AgentAuthoredEvent` family (`addComment`, `addLink`, `setBody`) on the
   child — so the result cells that would carry their outcomes are empty.
   (Tools do return values, but a tool instantiates a bound sub-pattern into a
   fresh cell — external logic, not a mutation of the host piece. It is the
   wrong fit for verbs, and no third callable kind is needed: handlers already
   have the result channel.)

## What the current shape requires, and what is incidental

This section states what we take the current design to require, so a reader can
flag a wrong assumption before it becomes a wrong choice: the redesign keeps
what is load-bearing and changes only what is not.

**Fire-and-forget streams are essential** — in a narrow sense worth pinning
down, because the loom FUSE audit calls a neighboring behavior a bug.
Essential: a handler's *effect* is writes that propagate, not a value returned
into the stream. *Not* essential, and what the audit flags as a spec violation,
is *acknowledging a write before its transaction commits*. The runtime's own
result-cell path confirms this reading: a handler's outcome is itself a write —
the result pattern committed with the handler's transaction — never a
synchronous channel bolted into the stream. This design adds nothing to that
model; it exposes it.

**The CLI's silences are incidental.** Not passing an `eventId` and not reading
the result cell are omissions in the callable layer, not properties the system
relies on. Closing them is safe; what it costs is two commitments:

- **Honoring caller-supplied ids** obliges us to define what a repeated id
  means and to trust callers not to collide — though the collision behavior
  itself (create-only receipt) is already the scheduler's invariant, not new
  machinery.
- **Handing out result-cell addresses** commits the runtime to those addresses
  still resolving later — a lifetime it does not owe today. Receipts already
  persist per event with no stated retention, so this obligation exists on the
  platform now, unnamed; this design inherits and names it rather than creating
  it.

### Obligations of idempotency

- **The retention window becomes the guarantee window.** Idempotency means
  "this id will not take effect twice"; how long that holds is exactly how long
  the record survives. A promise of idempotency without a stated duration is
  not a promise.
- **Repeated id, different payload** is already answered by the machinery,
  silently: the receipt address excludes the payload, so the second call
  collides regardless and the caller reads back a result computed from the
  *first* payload. The remaining decision is narrower — accept silent
  first-payload-wins, or carry a payload digest in the envelope so a mismatch
  is reported rather than masked.
- **Concurrent calls on one id must converge to one outcome** — but they need
  not serialize, and the platform does not: each executes optimistically and
  the create-only receipt arbitrates at commit. First committer wins; every
  loser is rejected with `receipt-exists` and reads the winner's outcome back.
  Harmless by construction, because a losing execution's effects roll back
  with its transaction.
- **The record and the effects must commit together.** Effects without a record
  make a retry duplicate; a record without effects makes a retry silently skip.
  The receipt's create-only write rides the handler's own transaction, so for
  same-space effects this holds by construction. The spec carves out the
  exception itself: cross-space child-first materialization is "a non-atomic
  phase with the current I11 gap" (scheduler-v2 §7.6), so a verb whose effects
  span spaces does not yet get this guarantee.

### Obligations of persistent results

- Storage grows with call volume and does not shrink on its own.
- Results embed whatever the handler read, so a stored record needs the same
  scoping and labels its source data carried.
- Stored results were written under older result schemas, and readers must cope.
- Once readable, invocation history is a feature people depend on, and its
  shape becomes a contract.

## Part 1 — the verb contract

1. **Named fields only.** Every argument is a named field in a declared input
   schema. A client may offer positional sugar when the schema has exactly one
   required field; the contract itself stays named. **An undeclared field is a
   typed rejection, never ignored**: input schemas are closed-world, and a
   client validates against the *deployed* schema before dispatch, so a caller
   targeting a newer contract than the live piece fails loudly instead of
   silently losing data — the live board accepted and discarded `agentName`
   exactly this way. A transitional compatibility field is declared like any
   other; tolerated-but-undeclared is the failure mode this rule exists to
   kill.
2. **Valid on its own.** A verb leaves the piece in a state a reader can accept,
   without depending on a follow-up call to become correct.
3. **Declared result.** A verb that produces something declares a result schema
   and returns a value. A verb that produces nothing says so.
4. **Rejection is a value.** Invalid input, wrong turn, precondition unmet — a
   typed error with a stable code. (Authorization is not the contract's job:
   CFC already rejects unauthorized commits and the runner surfaces the error —
   `Runner.setup`'s `editWithRetry` branch rethrows the
   `"CFC enforcement rejected commit"` abort instead of swallowing it as a lost
   race, `packages/runner/src/runner.ts`.)
5. **Address by identity, never by position.** Pass a child reference, or a
   client-rendered fid/path derived from one, never `{ index }`; indices shift
   under concurrent writes. A pattern need not and generally cannot manufacture
   its own runtime fid.
6. **No implicit dependence on state set by an earlier call.** A verb may take a
   cell reference as an explicit argument; what it may not do is read state that
   some prior verb was expected to set. Verbs written for UI convenience may
   still wrap a contract verb and read a session draft — the rule governs the
   agent-facing contract.

Rule 6 has teeth: any "call A, then call B" sequence where A configures B is a
race under concurrency. Its canonical instance is attribution.

Rule 6 is also what keeps a set of verbs an *interface* rather than a
*protocol*, which is why it is not merely an ergonomics rule. A verb set whose
members may depend on call order is a session type: conformance to it cannot be
decided from the schema alone, because the schema cannot express "only after
A". With rule 6 held, conformance is a plain structural question — the subset
check the repo already runs. See Discovery for what that buys, and for the
premise it still rests on.

### Attribution: principal and execution provenance

A write carries two attributions — who authorized it and who performed it.
Conflating them in one settable display-name cell that each caller resets
before mutating is the rule 6 race in its purest form. They are separate
facts and belong at different layers:

- The **principal** — whose key authorized the write — stays fabric-level:
  CFC carries it in its integrity labels (`RepresentsCurrentUser` /
  `AuthoredByCurrentUser` over `CurrentPrincipal`, `packages/api/cfc.ts`). For
  display, the browser path resolves the viewer's canonical Profile
  (`wish({ query: "#profileName" })`;
  `docs/common/patterns/multi-user-patterns.md:263-272` — "the viewer is
  whoever the runtime says they are") and stamps a structured
  `TopicAuthor { kind: "person", name, avatar? }`.
- The **execution provenance** — what performed the write on the principal's
  behalf and in what context — belongs in CFC labels. The intended general
  mechanism is a trusted-ingress-minted atom, provisionally `AgentActor`, whose
  metadata can carry more than a display name: for example an agent role,
  session/tool context, or a protected reference to the triggering request.
  CFC already has runtime-minted provenance families such as `ExternalIngest`,
  `LlmDerived`, and `TransformedBy` (all three in the atom-URI table in
  `packages/api/cfc.ts`), but
  no `AgentActor` atom exists and the external `cf` call path does not yet
  preserve this distinction.

Until that ingress path exists, `topics` keeps the explicit per-call
`AgentAuthoredEvent { agentName }`, stored as
`TopicAuthor { kind: "agent", … }`. Its own doc comment states the interim
contract: display attribution only; write authority remains the principal's.
This keeps attribution atomic with the mutation without pretending that a
topic-specific string is the generic provenance model.

The invocation protocol must not create a second canonical actor record.
Invocation output may eventually expose a policy-safe view extracted from CFC
provenance, but CFC remains the source of truth. Rich provenance metadata can
itself be confidential — a prompt or triggering user request is the obvious
case — so extraction and display are gated on the label-metadata confidentiality
rules, not merely on an open-world JSON shape. Authentication through a separate
agent key or delegation remains useful when cryptographic agent identity is
required, but is not a prerequisite for runtime-attested execution provenance
(open question 2).

### Discovery

A client holding only a board URL must reach the board's children without an
O(children) sweep of per-child reads. So a parent exposes a **compact index** on
its result — one row per child carrying a stable child reference and the summary
fields a survey needs (name, author, timestamps, counts) — making the whole
board one read. The pattern owns the reference and summary; the client, which
can inspect the backing cells, owns rendering the reference as a fid or full
path.

`topics.index` is the worked example: one reference-plus-summary row per child,
the reference declared through a title-only schema so no row can expand a topic
(the `TopicIndexRow` interface, `packages/patterns/topics/main.tsx`). A
reference-bearing result that does not do this is not an index — a row whose
reference expands to the full piece made a headless survey of the live board
produce over 300k tokens of output. Acceptance for an index: its serialization
contains no expanded piece, action, or runtime values, and a full-board read
stays bounded.

A row carries no authored identifier, and that is the general model: the row IS
the child, read through the narrow schema, so its address is the child's and a
survey can be followed without the pattern maintaining an address field it
cannot reliably see. A client asks for that address where it wants one —
`--select index[].@` names it, the `@` suffix being the concise address form.
Identity is a projection of a reference the result already holds, so no pattern
has to publish one.

Discovery is the parent's job; the child's own verbs are the child's. A comment
is addressed to the topic, not routed through the board — **but that depends on
the CLI dispatching a nested piece's streams, which today fails with
`Transaction required for .set()`** (the non-stream branch of `Cell.set`,
`packages/runner/src/cell.ts`; its own
board topic). Until that lands, board-level routing
(`addComment {topicFid, body}`) is the documented workaround — pragmatic, not
the target shape.

`cf cell get` lets an agent control how much data an exploratory read returns:
`--filter` narrows array membership and `--schema` constructs a projected value
from source-schema-selected reads. Both execute through computed pattern nodes
so their CFC behavior matches pattern expressions, without returning an
identity alias that can widen to a linked target's schema. A limit on the
number of records returned from a large array remains deferred, blocking
nothing. It is adjacent CLI work for when board scale demands it, not an ask on
any workstream in this implementation plan.

**A set of verbs is checkable as a structural interface with the machinery that
exists.** Schemas are the type system, so a verb set is a schema fragment and
conformance is a subset check the repo already computes (`schemaSubsetIssue`,
`packages/piece/src/schema-compatibility.ts`). Its variance is already correct
for the purpose: an implementer must accept at least the declared payload and
return at most the declared result, which is exactly the argument/result
direction pair above. Interface conformance and schema evolution are the same
rule — evolution is conformance to one's past self.

That covers the structural half and stops there.
[Designing verbs so they can change](verb-evolution.md) is the design of record
for what a verb's interface is and how it changes, and it puts an explicit
interface mechanism — **named, versioned interfaces**, with nominal
declaration and discovery by interface — on the road rather than in reserve,
because a name is a claim about meaning that no structural demand can make.
It is also the most machinery of anything in that design: an identity, a
registry, a place in the shape, a member-to-field mapping, and a
compatibility rule of its own, where what a version bump means and how a
declared minimum resolves against what a piece provides are both still to be
designed. So the subset check is the default and the interim, not an argument
that the named mechanism is unnecessary.

What is **not** yet true is the premise all of that rests on: that a piece's
verbs can be identified from its schema. Verb-ness had three independent
encodings — the cell's construction kind, `asCell: ["stream"]` in the schema,
and a stored `{$stream: true}` value — and `Cell.isStream` accepts any one of
them (`Cell.isStream`, `packages/runner/src/cell.ts`). The stored one is
retired (`docs/plans/stream-markers-out-of-stored-data.md`): nothing writes it,
and the schema now rides on every link that reaches a stream. A conformance
check filtering on the schema marker still misses a verb whose stored links
predate that stamp, and the CLI keeps a forced-stream fallback specifically to
dispatch such handlers until the stored value is no longer read at all.
Note where this does and does not bite: schema *generation* is not exposed to
it, because schema-generator decides stream-ness from the TypeScript type and
emits the marker as its own output — the divergence is a property of schemas
and values already stored. Conformance checking reads exactly those, so it is
exposed. Until the authoritative signal is settled, treat structural
conformance as available in principle rather than in hand.

One further precondition, cheap to hold and easy to lose: **verbs must stay in
the piece's own schema.** Moving the verb list into a separate index cell — a
plausible response to the read-size pressure this section describes — would
end the property without any error appearing.

### Composition: the atomic-unit rule

**A verb's payload matches the atomic unit of the domain — no smaller, no
larger.**

- **Too small** is a verb whose intermediate state is *invalid* and needs a
  follow-up call to repair — a rule 2 violation. `addTopic` without a body
  argument is this: a topic born with a body should appear with it; no reader
  should observe the halfway state.
- **Too large** is a verb that bundles independently-valid units to save round
  trips. `setBody`, `addComment`, and `addLink` are three verbs because a topic
  without its links yet is a legitimate observable state — a human mid-edit
  produces it constantly. Bundling buys a combinatorial verb surface, muddier
  rejection semantics (which part failed?), and coarser authorization
  granularity.

The corollary: **round-trip cost is never a reason to change a verb's size.**
The loom arc's evidence for fat verbs (Prior art) was earned under ~25 s per
fresh-replica CLI call — a client pathology, since a session or batch pays boot
once — and a verb surface shaped around it would outlive it. The costs small
verbs surface belong elsewhere:

- **Call cost** → the client: batching or a persistent session, no pattern
  change.
- **Atomicity** → the transaction: a handler's writes already commit
  atomically (spec scheduler-v2 §7.6), so a domain unit that must appear at
  once is expressed as one verb — which is what the rule already says. A
  client-side boundary spanning *several* invocations is out of scope here and
  belongs to the invocation layer.

### Positional arguments

One obvious subject reads well — `git checkout <branch>`, `docker run <image>` —
and it cuts quoting burden for agents. The risk is evolution: a second argument
makes ordering silently significant.

The compromise: patterns declare named fields; a client may accept a single bare
value **only when the schema has exactly one required field**. Adding a second
required field later stops the sugar applying rather than silently misbinding.

### Applied to `topics`

`topics` already satisfies the interim atomic-attribution rule, and Part 1 has
landed there: filing is `addTopic` (carrying the body, handing back the topic),
`addComment`, `addLink` — three invocations, one per thing the author meant to
do. The handle lookup and the verification read are gone with the declared
result, `setBody` is an editing verb rather than part of every create, and
`rejectMutation` throws where the verbs used to return quietly. The CLI renders
the returned reference as a usable address.

What is still owed is the typed rejection code — a refusal surfaces as prose in
a failure message — and Part 2's retry idempotence.

## Part 2 — the invocation protocol

Part 2 is the machinery from "What already exists" exposed through the callable
layer: the caller supplies the id `queueEvent` already accepts, and reads back
the record the runtime already writes.

### Shape

Every invocation is addressable by an id the caller supplies. The runtime
builds the `Invocation` and hands it back as the verb's return value:

```typescript
// Shown for illustration only.
interface Invocation<Out> {
  /** Caller-supplied. Doubles as the idempotency key. */
  id: string;
  status: "pending" | "settled" | "failed";
  result?: Out;
  error?: { code: string; message: string };
  startedAt: number;
  settledAt?: number;
}
```

The `Invocation` is both the value a caller receives from the call and the
durable entry that same caller can revisit later by id — deliberately not
named a result, which would capture only the first half. It is a **view over
the existing receipt cell** — per the
scheduler spec, "the receipt is the handling's result cell", not a new document
kind — plus envelope fields (timestamps and the error shape) that the receipt
does not carry today. Actor/execution attribution is deliberately absent: CFC
provenance is canonical, and a client may later render an authorized extracted
view beside this record.

What it provides:

- **Per-invocation isolation.** Each call has its own slot, so concurrent
  callers never collide. (Already true: one result cell per handling.)
- **Idempotency.** Same id, same slot; a retry after a timeout collides on the
  create-only receipt instead of re-committing, and the client reads back the
  original outcome. (The collision is the scheduler's existing I11 invariant;
  what is new is only that a *caller's* retry reuses the id and so takes the
  same path as a redelivery. Reading back the original result additionally
  requires the result to be in the receipt — the plain-return gap, open
  question 3.)
- **Durability.** An agent that dies mid-call reads its settled result
  afterwards. (Settled only: a failed handling commits no record — see Retries
  and failure.)
- **Rejections are values.** A declined verb returns a typed error to its
  caller rather than looking like success.

### Settlement and waiting

An invocation is **settled** when the verb's own execution has completed and its
transaction committed: `return` settles, `throw` fails. Effects that propagate
downstream are not part of settlement, which keeps the term bounded for verbs
with fan-out.

This is not a new semantic — it is when the receipt commits today. But the CLI
waits for far more than that: the handler branch awaits `runtime.idle()` and
`manager.synced()` — the whole reactive graph quiescing, then full sync — so
acknowledgment of an already-committed write is held hostage to every derived
recomputation it triggered. On the live topics board that is the board's own
index re-deriving over every topic; mutations were observed taking 60–80 s. The
work is exposure *and narrowing*: await this handling's commit, sync the
receipt, return — never the graph going quiet. An acceptance test must prove a
slow derived recomputation cannot delay acknowledgment (implementation plan,
WS-D).

Waiting is a caller-side choice — whether to wait at all, and for how long. The
tool path already observes settlement rather than polling for it —
`runtime.settled()` drains scheduler, storage, and in-flight async builtins
with no interval under it and no deadline over it (#4946); what remains is
making the wait bound caller-controlled.

### Choosing an id

Caller-supplied opaque string; the client generates a UUID by default and lets
the caller pass one explicitly. It flows through as the durable event id —
`queueEvent` already accepts `opts.eventId`, and `mintEventId`'s own contract
anticipates it: "ingress callers that already own a durable delivery id pass it
through instead." The CLI is now such an ingress caller: `Cell.send` takes the
id as its third argument, and `Cell.set`'s stream branch binds it to the
specific stream through `scopeCallerEventId` before handing it to
`queueEvent`.

Content-derived ids are available to a caller that wants them, but are not the
default, since posting the same message twice is a legitimate thing to want. A
stable caller-chosen key suits operations that are logically once-only, such as
`import-run-3/row-7`.

### Retention

Retention has three parts:

- The pattern declares an **allowable range and a default** for how long its
  invocation records are kept.
- A client may **request a value** within that range.
- A client may **request early expiry** — most usefully read-and-expire, where
  successfully collecting the result releases the record.

Because retention bounds the idempotency guarantee, these are correctness
parameters as much as storage ones.

### Storage and privacy

The underlying receipt cells already exist per event, addressed
deterministically from the event id **plus the handler's bound closure**
(`cause = { $ctx, $event }`) — verified byte-identical across independent
replicas, because a bound closure serializes to stable content-addressed links.
Reachable by a caller that can reconstruct that cause from the callable cell,
but enumerable by nobody. What retention needs on top is a **collection linked
from the piece**, so records can be listed and expired without touching piece
state. (This mirrors the unlinked-tool-result-cell defect below: deterministic
addressing without linkage is how storage becomes permanent and invisible at
once.)

Records carry the same scoping as the callable that produced them. Tool result
cells already inherit `resultScope` from the callable cell
(`executeResolvedCallable`, `packages/cli/lib/callable.ts`), so the mechanism
exists; today those
cells are unlinked and merely unguessable.

Scope is not the whole confidentiality story: a result derived from labeled
data carries CFC confidentiality labels of its own, so a stored invocation
record is subject to the same label rules as any other cell
(`docs/specs/cfc-label-metadata-confidentiality.md`). Retention and readback
therefore need checking against those rules, not only against cell scope. The
same is true of any extracted execution-provenance view: rich `AgentActor`
metadata may contain a role, tool/session context, or a reference to a
confidential prompt, so the invocation record must not copy it into ordinary
payload fields by default.

### Retries and failure

The existing machinery's semantics stand — **decided**. The receipt rides the
handler's own transaction, so a failed handling commits no receipt: same id
after a failure re-executes, safely, because nothing committed; same id after
success collides and returns the original. At-most-once *success* — which is
what a caller retrying effects actually wants.

The consequence accepted with it: a failure is **returned, not recorded**. The
caller sees the typed error; fabric storage keeps nothing. A durable failure
record would have to commit despite the verb's transaction failing — new
machinery, adopted only if a concrete need for fabric-side failure
observability appears. Until then, watching for failures is the client's job.

A caller that wants to hide retries from its own consumers can create a durable
request cell and populate it once an attempt succeeds. That composes from the
same primitives and needs no core support, so it belongs in guidance as a
pattern to follow rather than in the runtime.

### Results and schema evolution

A verb's result schema declares whether it carries a live piece reference or a
self-contained snapshot — the pattern knows which is meaningful for that verb.

The repo checks **a pattern's own** schema evolution:
`assertPatternSchemasBackwardCompatible`
(`packages/piece/src/schema-compatibility.ts`) runs on every `setsrc` unless
`--dangerously-allow-incompatible-schema` is passed
(`dangerouslyAllowIncompatibleSchema`,
`packages/piece/src/ops/piece-controller.ts`). It compares four schemas and no
others — the previous and candidate `Pattern`'s `argumentSchema` and
`resultSchema` — and it compares the two roles in **opposite directions**:

- **Arguments**: previous ⊆ candidate. Inputs may widen but not narrow; a new
  required field is incompatible.
- **Results**: candidate ⊆ previous. Results may narrow freely — but *adding* a
  result field is only compatible if the previous schema was open-world.

That second direction matters here: a pattern's declared result is easier to
shrink than to extend, so the result shape wants to be right early, or
deliberately open-world. The `Invocation` shape is the first schema this
applies to — it must be authored open-world so protocol fields such as a
payload digest or retention metadata can be added later.

"Results may narrow freely" governs *values*, not *named fields*. Removing a
named property from a **result** is rejected outright — `objectSubsetIssue`
returns "existing result field was removed" whenever the comparison is an
evolution, on the stated principle that a result's named fields are the
contract consumers read (`objectSubsetIssue`,
`packages/piece/src/schema-compatibility.ts`). An argument's named fields are
not held that way: dropping one gives up a demand, which the same function
accepts wherever the candidate object can still hold the value the piece
carries. The removed-field check recurses, so a nested removal is rejected on
a nested path
(`result.topic.title: existing result field was removed`) exactly as a flat one
is. Adding a **required** field is rejected at any depth unless it carries a
default; adding an **optional** one is allowed at any depth; narrowing a
*value* type is allowed at any depth. Nesting a pattern's result under a single
key therefore buys it nothing: "results may narrow freely" is true of values
and never of names, at every depth.

A verb's `asCell` marker is pinned the same way: it is a semantic extension key
compared for exact equality (`SEMANTIC_EXTENSION_KEYS`,
`packages/piece/src/schema-compatibility.ts`), so a field cannot change between
data and verb across a deploy. Verb names and their verb-ness are therefore
already a contract with teeth, before this document adds any rule.

**What a verb hands back sits outside all of it.** A verb's declared result
travels on `module.resultSchema` — the `CELL_RESULT_TYPE` doc comment
(`packages/api/index.ts`) states this, and `declaredVerbResults`
(`packages/cli/lib/piece.ts`) is what reads it back off a piece's compiled
graph — while the comparison above sees only `Pattern.argumentSchema` and
`Pattern.resultSchema`. There a verb is a property carrying its
`asCell: ["stream"]` marker and a reference to its event schema, and nothing
about its output. So no gate compares a verb's result across a deploy:
renaming a field of what a verb returns passes every check and breaks its
callers silently.

The advice stands; its enforcement does not. Publish as few names as the verb
can live with, and treat **every name a verb's result publishes as permanent
regardless of depth, with every later addition optional** — a discipline the
author and review hold, not one the update gate holds for them.
[Designing verbs so they can change](verb-evolution.md) is the design of record
for how a verb's interface changes, and it carries the same rule to its
conclusion: because nothing checks an output, a change to what a verb hands
back is treated exactly like a rename and gets a new verb name, until
Fabric-types records outputs in the shape and a check replaces the convention.

An envelope remains a reasonable readability choice — the llm-dialog tool path
returns a single-key shape from both of its branches, an `@resultLocation`
link, the value, and its schema together (both `"@resultLocation"` sites in
`handleInvoke`, `packages/runner/src/builtins/llm-dialog.ts`).

### Authoring

```tsx
// Shown for illustration only.
// The result is declared by explicit type arguments — never inferred from
// the body, and a return-type annotation on the callback alone does not
// declare one.
const addTopic = action<AddTopicInput, AddTopicResult>(
  ({ title, body }) => {
    const trimmed = (title ?? "").trim();
    if (!trimmed) throw new Error("title must be non-empty");
    const piece = Topic({ title: trimmed, body, mentionable: topics });
    topics.push(piece);
    return { topic: piece };
  },
);
```

`throw` becomes `status: "failed"`; `return` becomes `status: "settled"` with
the result. Only settlement is durable — a failed status is returned to the
caller, not recorded (Retries and failure). The typed-rejection carrier that
puts a stable `code` beside the message is deliberately not minted as its own
class: a separate `FabricError` effort is underway, and the verb-rejection
type will derive from it. Until then a rejection is a plain thrown `Error`
and the message is the whole signal.

### Verb discovery

An agent holding a piece URL must be able to ask "what can I call here?"
without reading pattern source. The pieces exist:

- **Per verb**, `cf piece call --piece <piece> <verb> --help --json` already emits the
  machine-readable command spec — kind, default verb, input schema — derived
  from the pattern's own types (`callableCommandSpec`,
  `packages/cli/lib/callable.ts`).
- **Enumeration**: `cf piece verbs --json` lists every callable — name, kind
  (handler/tool), which cell it lives on, and its input schema (tools also
  carry their output schema) — read off the compiled pattern the piece is
  pinned to: its declared result type, its result graph, and its declared
  argument type, without loading the piece's result tree. FUSE independently
  classifies the same entries (`classifyCallableEntry`,
  `packages/fuse/callables.ts`) into `.handler` / `.tool` files plus a
  `.handlers` listing — flagged on the board as neither universal nor
  complete.

The listing also carries the deployed pattern's source identity, so a client
or skill can detect that it targets a newer contract than the live piece
instead of discovering skew through a silently dropped field.

What remains:

1. **Result schemas for handlers.** The command spec carries an output schema
   only for tools, because handlers return nothing today. Rule 3's declared
   result must reach the piece's **durable schema** — otherwise introspection
   can name a verb and its arguments but never what it returns. This rides
   staging step 4, where verbs first return values.

**What gets listed: everything is publishable; hiding is a view default, never
a boundary.** The verbs live in the durable schema, which any reader of the
piece can already enumerate — so omission from a listing removes nothing and
must not pretend to. Whether a call is *permitted* stays where it is: CFC
decides at commit; the listing shows availability, not permission. The useful
distinction is instead rule 6's two tiers, which `topics` already exhibits:
contract verbs (`addComment`, `setBody`, `addLink`) versus UI-convenience
wrappers (`submitComment`, `startEditBody`, `saveBody`, `cancelEditBody`,
`submitLink`) that read session-local drafts and therefore silently no-op in a
headless replica — listing them unmarked hands an agent five trap verbs. A pattern may mark that
wrapper tier (a schema annotation, plausibly a type-level marker in the
`PerSession` family — apt, since reading per-session state is very nearly the
tier's definition); the default view shows the contract tier, and `--all`
always shows everything. The marker can ship after the listing; these
semantics are settled now so the unmarked v1 does not harden into the
contract.

### Client surface

```text
# An invocation id deduplicates only within the session it was chosen in,
# so a run mints one session and every call of that run shares it.
$ export CF_INVOCATION_SESSION="$(cf invocation-session new)"

$ cf piece call --url "$TOPICS_BOARD_URL" addTopic \
    --title "Verb contract" --body @body.md
{ "invocation": "inv_7f3a", "status": "settled",
  "result": { "topic": "fid1:abc" } }

# The client mints the id before sending and prints it — beside its session —
# even when its wait times out. Retrying the pair returns the original
# outcome: the body re-runs and loses the create-only receipt race, so
# nothing commits twice. An --invocation named without a session is refused.
$ cf piece call --url "$TOPICS_BOARD_URL" --invocation inv_7f3a addTopic \
    --title "Verb contract"
{ "invocation": "inv_7f3a", "status": "settled",
  "result": { "topic": "fid1:abc" } }

# The caller chooses whether to wait: a detached call exits at the commit
# acknowledgment with the receipt's address, and collecting the outcome
# later is an ordinary read of that address.
$ cf piece call --url "$TOPICS_BOARD_URL" --no-wait summarize \
    --topic fid1:abc
{ "invocation": "inv_9c1b", "status": "committed",
  "receipt": "/of:fid1:…" }
$ cf cell get --piece /of:fid1:… summary
"..."
```

Client-local `@name` bindings are deferred. They can encode host + space +
piece, while slugs (`cf piece set-slug`) are fabric-side names within a space,
but two overlapping naming systems are too easy to confuse and aliases are not
required for agent-drivable verbs. Revisit them separately only after concrete
usage shows that full URLs, configured host/space, and slugs are insufficient.

On any early exit — a timed-out wait, a lost connection — the client reports
the furthest phase it observed as a structured field beside the invocation id
it printed before network work began:
`initial_sync | dispatched | committed | readback`. Phase is diagnosis, not a
safety gate: with a caller-supplied id, a retry of that id is safe in every
phase — before dispatch nothing committed; after it, the retry collides on the
receipt and reads the original back. A `retrySafe` flag is derivable
client-side sugar, not protocol.

## Defects and unknowns in the current machinery

- **Tool result cells are unlinked, and their collection status is unknown.**
  Created with a random UUID; the CLI hands the address back to the caller
  (`resultRef`), but nothing in the fabric links the cell. A search of the
  memory and storage layers turned up no collection of unreferenced cells; that
  search was not exhaustive, and the answer should be confirmed before the
  retention design is settled. (A second defect once listed here — the tool
  result wait was a 25 ms poll under a 15 s deadline — is fixed: the wait is
  `runtime.settled()`, #4946.)

## Checking the design against other patterns

| pattern | verb | stresses | holds? |
| --- | --- | --- | --- |
| `topics/` | `addTopic` | returning a handle | yes |
| `battleship/` | `fire` | conditional rejection ("not your turn") | yes — a typed code lets the agent decide whether to wait or stop |
| `scoped-group-chat/` | `postMessage` | append-only under concurrency | yes, and this is where the idempotency key earns its keep: a blind retry double-posts today |
| `lunch-poll/` | `vote` | naturally idempotent update | yes; the key is harmless where it is unnecessary |
| `deep-research.tsx` | LLM-backed verb | result unavailable at return time | yes — the verb settles with a reference and the caller waits on that cell separately |
| `counter/` | `increment` | single-user, trivial verb | yes |

The chat case is the sharpest test: it is the one where today's behavior is not
merely inconvenient but wrong, and where client-side care cannot fix it.

## Prior art

The loom fuse-fabric-access arc (loom PR 4183) reached this territory first: it
put an agent handle on loom's mobile root piece and wrote down the conventions
that made it drivable. Its topics-board incarnation — the board topic *"Give
the topics board an agent handle"* (Ben + Claude, 2026-07-22) — asks for five
things: atomic `addTopic {title, body?}` returning the new topic reference,
idempotency on create, a board index cell, board-level
`addComment {topicFid}`, and an identity guard on mutating verbs. Every ask maps to a section above — the
identity guard is the interim required `agentName` on every mutating event,
pending general CFC ingress provenance. This document is their pattern-agnostic
generalization. Deeper detail lives in the arc's defect register and
`docs/development/projects/fuse-fabric-access/topics-agent-ergonomics.md` on
the loom PR.

Two refinements relative to the loom conventions: "complete-payload verbs" is
absorbed into the atomic-unit rule (Composition), and child-owned verbs are
preferred to parent-routed ones, with board-level routing as the documented
workaround until nested-stream dispatch lands (Discovery).

A second, independent confirmation arrived 2026-07-24: the first headless
session driving the live board through the current CLI needed ~24 remote
operations to create a three-topic graph — every extra call a handle lookup, a
`setBody` that could not ride the create, or a verification read — with four
fixed-timeout sync failures, roughly six minutes of mutation waits, and one
field silently discarded by a stale deployed schema. Each failure maps to a
section above, and the session's three-topic scenario is adopted as the
end-to-end acceptance fixture in the implementation plan.

Closer to home, the llm-dialog builtin already runs this invocation protocol in
miniature. Its **handler** path mints a result cell at a *caller-supplied* id
(`toolCall.id`), hands that cell to the handler as `result` — the code's own
comment reads "doesn't HAVE to be used, but can be" — and resolves off the
commit callback: `handler.withTx(tx).send({...input, result}, (completedTx) =>
…)` (`handleInvoke`, `packages/runner/src/builtins/llm-dialog.ts`).
That is this design's shape, already in production. Two qualifications keep the
citation honest. It is specifically the handler branch that is the precedent;
the sibling `runtime.run(tx, pattern, invocationArgs, result)` branch of the
same `if (pattern) … else if (handler)` in `handleInvoke`
is the tool-as-bound-sub-pattern path this document defers, and it resolves off
a sink rather than a commit. And llm-dialog bounds its caller-side wait with a
five-minute `REQUEST_TIMEOUT`, which also drops a user's message outright
when a turn is still running (the `addMessage` handler's pending guard, same
file) — the fixed-wait
failure class this document's own live-session evidence names one paragraph
above. So the precedent is precise: the ergonomics of a caller-supplied id
resolving to a durable result cell are proven, and the bounded wait wrapped
around them is exactly what returning an address and letting the client decide
whether to wait removes. The scheduler receipt remains the right substrate for
the reasons Part 2 gives — the create-only exactly-once collision is what a
client retry needs.

## Open questions

1. **What is the right default retention window**, given that it bounds the
   idempotency guarantee?
2. **What does `AgentActor` provenance attest, and when does it need a key?**
   Runtime-minted ingress provenance can attest that a trusted boundary
   observed a particular execution context without making the agent a
   cryptographic principal. That is enough for honest provenance and richer
   than an invocation-owned display name, but it does not authenticate a
   self-asserted real-world identity. When cryptographic agent identity is
   required, three arrangements remain unequal:

   | arrangement | cost | authenticated |
   | --- | --- | --- |
   | agent uses its human's key, declares itself | none | human only |
   | agent holds its own key | a DID, home space and profile per agent | agent only |
   | agent signs under a delegation from its human | delegation credentials | both |

   Only delegation cryptographically authenticates both, and it is
   infrastructure — issuance, expiry, revocation. A standalone agent key is
   cheaper but inverts the problem, leaving the accountable human unverified;
   it is also not small,
   since a key is a DID, a DID is a home space
   (`getHomeSpaceCell = getCell(did, did)`), and homes are private under
   now-default ACL enforcement — an agent key implies a home and profile, not
   just a credential. The CFC design must specify the atom's trusted mint,
   propagation, metadata confidentiality, and extraction helpers. A renderer
   should lead with the authenticated principal and distinguish
   runtime-attested execution context from cryptographically authenticated
   agent identity. Nothing here forecloses delegation or delivers it.
3. **How do plain JSON returns reach the receipt?** A return value containing
   reactives/cells projects into the receipt, while a **plain JSON return is
   discarded** — the receipt-only branch of
   `Runner.#handleJavaScriptHandlerResult` (`packages/runner/src/runner.ts`)
   writes `{}`. For `topics` this mostly does not bite — `{ topic: piece }`
   carries a cell — but "retry reads back the original result" is incomplete
   without it. Options: a small runtime change writing the validated plain
   return into the receipt instead of `{}`, or a contract rule that results
   carry at least one reactive. The first looks right; it is the one place this
   design asks the runtime for new behavior rather than exposure. That change
   now exists behind the `plainResultReceipts` experimental option (WS-C),
   default-on since the three-topic integration proof (#5244), so neither the
   mechanism nor the default remains open — an explicit `false` stays the
   rollback override while the flag exists.

## Design decisions worth recording

- **Positional arguments stay out of the contract**, available as client sugar
  under the one-required-field rule.
- **Retry composition lives in clients**, as guidance rather than runtime
  support, keeping the core small.
- **No `cf topic` command.** `packages/cli` is a layer-4 package (Operation) and
  patterns are layer 7 (End-User Programs); a pattern-specific command inverts
  that dependency and has no principled stopping point once the first one lands.
- **No third callable kind — tools are deferred, not rejected.** The protocol
  exposes the handler path rather than inventing beside it, because handlers
  already have per-invocation result cells at the runtime level. The sharper
  statement of why, from the 2026-07-28 pass: a "tool" is not a distinct kind
  of callable at all. Both branches of the runtime's tool path do the same
  thing — send an invocation, get a durable result cell at a caller-supplied
  id — and the pattern branch merely instantiates first, leaving behind a
  running instance that this path does not collect. So instantiation is *a verb
  whose
  result is a child reference*, which rule 5 and the child-reference decision
  already cover; it is out of scope here because its extra machinery (pattern
  resolution through `$patternRef`, the CFC observation flag and frozen request
  snapshot, and instance lifetime) is real and unrelated to the call protocol.
  Two properties keep a create verb additive later, and both are cheap to hold
  now: the result envelope must be able to carry a reference (already true —
  patterns return child references), and the payload model must be able to
  express a *declared but not caller-suppliable* field. The second already
  exists at the type layer as `FrameworkProvided<T>` and
  `FrameworkProvidedKeys<>` (`packages/api/index.ts`, used for the
  bash tool's `sandboxId`);
  only the runtime's strip list is hardcoded. Rule 1 should be worded so a
  declared field may be framework-owned rather than caller-supplied.
- **Failures are returned, not recorded.** The receipt's
  at-most-once-*success* semantics stand as built: no receipt commits on
  failure, the same id safely re-executes, and failure observability is the
  client's job unless a concrete fabric-side need appears.
- **Every verb is listable; hiding is a display default.** Omission from the
  listing is never a capability boundary — the schema already publishes every
  verb to any reader, and permission stays with CFC at commit. Patterns may
  mark UI-convenience wrappers so the default view shows the contract tier;
  `--all` always shows everything.
- **Execution attribution is CFC provenance, not an invocation payload field.**
  `topics.agentName` remains an atomic interim argument until trusted `cf`
  ingress can mint and propagate the general provenance.
- **Patterns return references; clients render identities.** A compact index
  carries stable child references and summaries. Generic `--include-ids`
  annotation belongs to the CLI because the pattern cannot reliably author its
  own fid.
- **Client-local `@name` bindings are deferred.** Their distinction from slugs
  is real but confusing, and they are unnecessary for the core contract.

## Staging

The engineering breakdown — what remains, in what order, and what each item
waits behind — lives in
[`verbs-implementation.md`](verbs-implementation.md); the steps below are the
design-level order.

1. Agree this document — particularly the open questions.
2. Finish the Part 1 rework of `topics` / `topic` — the attribution rules
   already hold. Remaining, with no runtime change: a body argument on
   `addTopic`, thrown rejections in place of silent early-returns — empty
   titles and blank agent names both drop without a trace today — and the
   reference-plus-summary discovery index (Discovery). (A thrown handler
   error already surfaces as a nonzero CLI exit; stable codes arrive with the
   protocol.)
3. Replace the tool-result poll with sink-based settlement and return the
   result cell's address to the caller. Standing fix, useful regardless.
4. Plumb the id and the readback: pass a caller-supplied `eventId` from
   `cf piece call` through `cell.send()` to `queueEvent`; have `topics` verbs
   return values; have the CLI reconstruct the cause and read the
   `{ resultFor }` cell after commit (explicit sync — a cold plain read
   returns `undefined`), and reclassify `precondition: "receipt-exists"` as
   success-with-readback rather than failure. Plus the one runtime change from
   open question 3 if plain returns are to survive.
5. Add timestamps, the typed error shape, and the linked retention collection.
   In a separate CFC-gated track, design trusted `cf` ingress provenance,
   `AgentActor` propagation, metadata protection, and extraction. Retire
   per-event `agentName` fields only after that path is proven end to end.
6. Add the client surface around invocation ids (mint-and-print,
   `--invocation`, `--await` / `--no-wait`), verb listing, and generic
   identity annotation for returned references and discovery indexes.

Steps 2 and 3 stand on their own regardless of how the open questions land.
