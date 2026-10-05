# Verb calls: working notes

**Sketches and investigation notes, not a plan.** The design lives in
[Reading Fabric data](fabric-read-model.md) and the two documents it points at:
[Shaped reads and verb results](shaped-reads-and-verb-results.md) for the read
layer and what a call adds to it, and [CLI surface shape](cli-surface-shape.md)
for the command surface.

What is kept here is call-specific detail those documents do not carry: what
produces a receipt and what its existence proves, how a receipt's address is
derived, the entity-URI change to `--piece`, error and
exit-status conventions, sequencing, and deferred work. Draw from it; do not
treat it as a settled contract.

Anything about how a result *renders* — which positions are references, how a
shape bounds a read — has moved. A verb result is the shared read layer applied
to the receipt cell, not a contract of its own.

This continues the identity work from
[Pattern verb contract — implementation plan](../history/plans/pattern-verb-contract-implementation.md)
(WS-F). The user-facing surface it changes is
[Verbs over the CLI](../common/verbs/over-the-cli.md).

## Orientation

[Reading Fabric data](fabric-read-model.md) defines space, cell, address, link,
pattern, piece, verb, receipt, schema, and shape. Four more terms appear here:

| Term | What it is |
| --- | --- |
| **Handler** (or `action`) | The function body that runs when a verb is invoked. |
| **Invocation** | One call to one verb. Its id is the idempotency key: replaying a settled id returns the original outcome without committing again — the handler body re-runs and loses the create-only receipt race, so effects outside the transaction can repeat. |
| **`of:`** | The URI scheme on an entity id (`of:fid1:<hash>`). From the memory protocol's fact record — `the` (type) / `of` (entity) / `is` (value) — so an entity id names the subject a fact is *of*. The unkinded default. |
| **`computed:`** | The same slot, marking an entity whose contents are re-derivable. Reduced to a bare hash it aliases its `of:` sibling, which is a different entity — the reason `--piece` must refuse it rather than strip it. |

## The call-specific problem

**Durable readback exists; a lost address does not recover.** Every call
envelope — the detached `--no-wait` exit included — publishes the receipt's
address, and re-reading the outcome is an ordinary cell read against it. What
remains unsolved is the caller who no longer holds that address: nothing in
the receipt is enumerable, and the only fallback is a same-id replay — which
returns the original outcome, yet re-runs the handler body, so effects
outside the transaction repeat.

## What it looks like

Calling a verb with an id the caller chose, so the outcome stays recoverable:

```bash
export CF_INVOCATION_SESSION="$(cf invocation-session new)"
cf piece call --piece <board> --invocation create-note-7 \
  createNote '{"title":"Notes"}'
```

The envelope carries the address of the cell holding this outcome. Field
spellings are the read layer's, not settled here:

```text
{ invocation: "create-note-7",
  status:     "settled",
  receipt:    <address of the cell holding this outcome>,
  result:     <what the verb returned, rendered by the read layer> }
```

Keeping that address means the result can be re-read later without running the
verb again — an ordinary read, since a receipt is an ordinary cell:

```bash
cf cell get --piece of:fid1:...
```

Losing that address is the case these notes do not solve; see
[Recovering a lost outcome](#recovering-a-lost-outcome--deferred).

## Reading a receipt

### What produces one

Only JavaScript handler dispatches.
`handleJavaScriptHandlerResult` (`packages/runner/src/runner.ts`) mints the
receipt cell **unconditionally at its top**, before any branching, and all three
downstream sub-paths resolve to that one address — a second `Cell` object is
minted later for it, so the sharing is address-level, not object-level: the
receipt-only branch writes it, the
`deferForNavigate` branch is the **sole** caller of
`setupDeferredHandlerResultPattern` (the navigateTo case, not the reactive one),
and ordinary reactive results go through `runWithStartOwnership`. Other
`{ resultFor: … }` cells in the same file take a resolved output-redirect spot
as cause and are **not** receipts — do not pattern-match on `resultFor` alone.

Tools take a different path — `runtime.run` into a fresh result cell, surfaced
as `resultRef` — and produce no receipt.

Publication also requires `commitPreconditions`, on by default and not
env-reachable
([EXPERIMENTAL_OPTIONS.md](../development/EXPERIMENTAL_OPTIONS.md)). When the
runtime produces none, the response omits `receipt` — absent, never fabricated.

**Not every receipt comes from `cf piece call`.** Shell clicks and
pattern-internal chains also dispatch handlers and write receipts with
deterministic ids: `queueSchedulerEvent`
(`packages/runner/src/scheduler/events.ts`, behind the `queueEvent` facade) sets
`id = args.eventId ?? mintEventId(eventLink, originTx)`. The fallback branch is
a per-transaction key plus a sequence, or a random UUID — so those receipts are
**not** re-derivable, and only dispatches that supply an id are nameable at all.
That bounds any recovery scheme to callers who chose an id in advance, and is a
reason to prefer fixing replay in the runner over deriving addresses in a
client: replay safety helps every dispatch, nameable or not.

**Should recovery ever get a name, `invocation` not `receipt`.** CFC single-use grants write a
*consumption receipt* under the reserved `grant:cfc:` scheme
(`packages/runner/src/cfc/grants.ts`), deliberately avoiding the `resultFor`
idiom so `noteSystemWrite` gates it. `cf receipt` would be ambiguous between the
two and invite the expectation that it reads the policy-state kind.

### What its existence proves

Settlement — not that the handler ran. Two cases with opposite behavior:

- **The handler throws.** The error is rethrown out of
  `invokeJavaScriptImplementation` and never reaches `postRun`, so no receipt is
  written. At readback, failure is indistinguishable from never having happened.
- **The argument fails validation** (`isValidArgument` false). The handler does
  not run, but `result` stays `undefined` and `postRun(undefined)` runs anyway,
  writing `{}` — exactly the shape a value-less success writes.

`cf piece call` catches the second in its pre-dispatch payload gate, so CLI
callers see a refusal that does not spend the id. Other dispatchers may not.

| Question | Answer |
| --- | --- |
| Did this invocation settle? | yes |
| What value is in the receipt? | yes |
| Did the handler fail? | no — failure and absence look alike |
| Did the handler body run? | no — validation non-runs write `{}` |
| Was this attempt deduplicated? | no — that belongs to the attempt |
| What invocations ran on this piece? | no — receipts are not enumerable |

This is result readback, not invocation history.

### How addresses are derived

Any scheme for re-deriving a receipt's address has to reproduce this exactly.

```text
receipt address = getCell(patternResultCell.space, { resultFor: cause })
cause           = { ...inputs, $event: tx.dispatchedEventId ?? <random uuid> }
```

`inputs` is the handler node's bound closure. The receipt lives in the **pattern
result cell's space**, not necessarily the caller's, and is created with **no
scope argument**, so receipts are space-scoped today.

**`$event` is not the caller's id.** A caller-supplied id is bound to the
session that chose it and to the stream it was sent to before it becomes an
event id: `scopeCallerEventId`
(`packages/runner/src/scheduler/event-identity.ts`) hashes
`{caller, id, path, scope, session, space}` — the id string, the session, and
the whole stream link — into `evt:caller:<hash>`, and `Cell.send` routes every
supplied id through it. That binding is deliberate: two verbs sharing input
bindings must not collide on one receipt, and neither must two callers that
picked the same word for their own invocation. The hash is deterministic
across processes, so a retry from a fresh CLI invocation derives the same id —
which is what makes any re-derivation scheme possible at all.

Where no id is supplied, `mintEventId` produces
`evt:<per-transaction key>:<seq>:<stream link id>` or
`evt:<random uuid>:<stream link id>`. Both end in the stream link's id, and
neither is re-derivable.

Holding the address already, a caller needs nothing verb-aware: a receipt is a
cell and reading it is an ordinary read. Deriving the address without it is the
deferred case below.

Either way the reader loads the link through `runtime.getCellFromLink(link)` and
`pull()`, the same path `executeResolvedCallable` already uses. A raw storage
read would bypass the CFC checks attached to the stored result.

### Waiting, and detached calls

A detached caller knows the receipt address before the receipt exists, so the
reader **subscribes and wakes when it appears**; it must not poll
(AGENTS.md, "Avoid timeouts, retry loops, and sleeps";
[waiting-in-tests.md](../development/waiting-in-tests.md)). `--wait <seconds>`
bounds a caller's own patience, as on `cf piece call`.

`tx.handlingReceiptLink` is set during handling — before the commit, and only
when receipts are enabled — which is what lets `--no-wait` return `receipt`:
its exit is `{invocation, status: "committed", deduplicated?, receipt}`, the
address published before the outcome was read (migration step 2, landed as
#5694). It also returns the invocation id — minted or supplied — both on
stdout and, once, on stderr at the dispatch phase, with the session announced
beside it. So collect-later does **not** require supplying an id. Supplying
one buys something narrower: it is known *before* the call, so it survives
losing the process's output entirely.

### Retry versus readback

| What the caller knows | Correct action |
| --- | --- |
| The invocation settled, and its receipt address was kept | Read that address — an ordinary read |
| Uncertain whether the commit happened, or whether the handler failed | Repeat `cf piece call` with the same `--invocation` id |
| Response lost, including the receipt address | Replay, or accept the loss — see the deferred section |
| No caller-chosen id retained | Recovery is not guaranteed |

An absent receipt cannot distinguish never-dispatched, not-yet-committed,
threw, expired, or wrong-handle. Under uncertainty only same-id replay safely
finishes the work.

### What a repeated read costs

Each `cf` invocation is a separate process with a **cold replica** —
`loadPieces` builds a `runtimePresets.remoteClient` runtime over a remote
`StorageManager`, and nothing persists between runs. Expect process start,
session setup, a connection, and a sync; the walkthrough's `--verbose` output
puts `initial_sync → dispatched` around 400ms against a warm local toolshed.

So: **ask broadly once.** One read returns the whole envelope. Repeated reads
are for questions you did not anticipate — recovery, detached collection, a
follow-up from another process — not a read-per-field idiom. A readback remains
far cheaper than the same-id replay it replaces, which pays all of the above
plus a handler execution and a refused commit.

## Errors and output conventions

These notes inherit `packages/cli/README.md` §"Output Conventions" rather than
restating them: **stdout carries command output only, with hints and diagnostics
on stderr**, and **`-q/--quiet` suppresses the hint and next-step blocks**
without touching the log floor, deliberately, because consumers parse `--quiet`
runs' stderr for runtime warnings.

stdout is always the Invocation JSON. Nothing narrows it to a bare value, so
no envelope field is ever displaced onto stderr and no rule is needed for
where it lands.

Advisory notices about what a read could not materialize belong to the read
layer and follow its conventions, not a call-specific rule.

Unchanged: the `invocation: <id>` line announced once on stderr at the dispatch
phase, so a caller whose process dies past that point still holds the id. Note
what that does and does not survive: dispatch comes after the initial sync, so
the id outlives a lost commit but not a sync that never completes.

### Exit status

Two call-specific cases. Failures inside a shaped read report under the read
layer's rules.

**`cf piece call` is unchanged.** A refused or failed call reports on stderr with
the existing `invocation: <id> phase: <phase>` line and exits non-zero. A settled
call exits zero.

**A read that finds no receipt says so, and no more.** The message is "no
receipt at this address" and must **not** claim the invocation never happened:
absence cannot distinguish collected, never-created, failed, and wrong-handle.

One property worth carrying into the read layer's design: a position that could
not be materialized should still yield its address rather than an error, so a
caller retains the part it can act on. Whether that degradation is uniform, and
what is named on stderr, is the read layer's call.

## `--piece` and the entity URI

`--piece` accepts the entity-URI form (migration step 1, landed as #5459), so
an address emitted by one command is accepted by the next without reshaping.

`isSlugAddress` is `!value.includes(":")`, so the input forms are unambiguous:

| Form | Example | `--piece` | Denotes |
| --- | --- | --- | --- |
| Slug | `my-board` | accepted | a **stable name** that redirects; reassignable |
| Bare hash | `fid1:…` | accepted | a hash — **not a complete identity** |
| Entity URI | `of:fid1:…` | accepted | this entity, in its stored spelling |
| Kinded URI | `computed:fid1:…` | **refused, by name** | a *different* entity from the `of:` one over the same hash |

**Where the scheme is understood.** `entityIdFrom`
(`packages/runner/src/create-ref.ts`) is the entity-specific intake seam: it
accepts the `of:` scheme and **refuses `computed:` rather than stripping it**,
because stripping would rename an id to its `of:` sibling, a different
entity. Not one layer lower: `FabricHash.fromString` parses any tagged hash,
whatever it names, and `of:` is a URI scheme, not a hash tag — the schemed
form is not a parseable tagged hash.

**One seam reaches most callers.** The address-string paths that matter go
through `entityIdFrom`: the CLI, the shell (`runtime-processor`), and slug
resolution. Two residual cautions carry forward: anything keying on the *raw
input string* has two keys per entity
now that two spellings resolve (the cell layer keys on the normalized URI and
is fine; CLI-level raw-string comparisons are where to look), and the old
hand-stripping workarounds remain correct, since stripping `of:` from an
already-bare id is a no-op.

**What stays out of scope.** Ten hand-rolled prefix conversions exist across
eleven files in five packages — `lib-shell`, `patterns` (three files, two in
user-space pattern code), `fuse`, `state-inspector` (two inside embedded browser
JS), and `runtime-client` (three) — running in **both** directions, with roughly
eight more hand-rolled sites outside those packages in `shell`, `toolshed`,
`memory`, and `runner`. Removing them is
follow-up cleanup on a separate review path, and nothing here depends on it.

**A bare hash is not a complete identity**, which is why the emitted form keeps
its scheme. An entity's kind lives only there and the hash preimage is kind-free
([computed-cell-identity.md](../specs/computed-cell-identity.md)), so stripping
to `fid1:<h>` discards the distinction and re-resolving silently defaults to the
`of:` sibling.

## Resolved questions

### Is the invocation id namespace per-user? — resolved: per-session (#5610)

**The finding that opened it: nothing in a receipt's address identified the
caller.** `inputs` is graph structure, identical for every caller; scope is a
symbolic tag, not a user identifier; and the payload is excluded by design —
which is what lets a same-id retry replay instead of execute. An unscoped id
was therefore a read key shared per (space, verb binding): two callers picking
the same word computed one address and read one receipt, and a guessed id
computed an address from public inputs alone. The human-friendly convention
the walkthrough teaches (`add-comment-1`, `add-1`) is exactly what two agents
following it would derive systematically.

**The resolution: the session is in the hash.** `scopeCallerEventId` binds the
caller's id to the session it was chosen within and to the whole stream link
(see "How addresses are derived" above), so the same id under two sessions
names two invocations, and an address is computable only by a caller holding
the session — minted, unguessable, and explicit. The scope is a **session**,
not a principal, on purpose: agents work under their human user's key rather
than mint their own, so the collision that happens in practice is two agents
under one key, which a DID would not separate — and a DID is public, so
identity scoping would have left addresses computable from a piece, a verb,
and a conventional id.

The mechanism is the explicit invocation session: `cf invocation-session new`
mints one, `CF_INVOCATION_SESSION` or `--invocation-session` carries it, and
`--invocation` without a session is refused rather than scoped to something
implicit — a session minted per request would make the id mean a different
receipt next time, silently breaking the replay the id exists for.

Deliberate sharing moves to passing the address rather than two callers
deriving one id from a convention. That is unambiguous, and it removes the
only thing the shared key was good for.

## Migration

**The read layer is on main**, and a selection can render a reference as its
address (`$link`) instead of its expanded value. `--show-links` remains for
the unshaped case — it annotates identity back onto a payload that destroyed
it — and whether it retires once marked selections are the habit is the read
layer's call, not this half's.

**The call-specific steps, all landed:**

1. **`--piece` accepts the entity URI** (#5459) — the `entityIdFrom` change,
   refusing `computed:`. The same id works with and without its scheme, and
   an emitted address composes into a following command.
2. **`receipt` as a top-level envelope field** (#5694), published from
   `tx.handlingReceiptLink` so a detached caller holds an address before the
   receipt exists.
3. **Receipt cells created with a schema** (#5468) — descriptive, plain
   results only; see
   [Shaped reads and verb results](shaped-reads-and-verb-results.md) for the
   split and the open declared-sourced question.
4. **`cf piece call` gains the read options** — `--select`, `--schema`,
   `--filter` — through the shared read implementation (#5505, re-landed as
   #5610) rather than a second output path.

Reading a receipt directly needs no step of its own: it is an ordinary cell
read. Recovering an outcome whose address was lost is deliberately absent —
see below.

## Recovering a lost outcome — deferred

**The problem.** A verb settled, and the caller no longer has its receipt
address — the process died, output was lost, or a detached dispatch was never
collected. The outcome exists and is durable, but nothing enumerates receipts,
so without the address it is unreachable.

**Why this is narrower than it sounds.** Three ways to want an outcome you do
not have, and only the third is unserved:

- *Dispatched detached.* `--no-wait` returns the invocation id on stderr
  before any network work, and its exit carries the receipt address. Keeping
  that address is the answer.
- *Lost the response, verb has no effects outside its transaction.* Replaying
  with the same invocation id returns the original outcome. The body re-runs and
  loses the create-only race, so the commit is refused and nothing is duplicated.
- *Lost the response, verb has effects outside its transaction.* Replay would
  re-send the mail or re-spend the model call. This is the case with no answer.

**Option A — derive the address in the client.** Rebuild the cause from piece,
verb, and a caller-chosen invocation id, per "How addresses are derived" above.
The cost is coupling: addressing must be byte-identical across replicas, and a
handler node's bound `inputs` are runner-internal, so the runner would have to
export something like `receiptLinkFor(streamCell, eventId)` purely to serve this.
Duplicating the cause-building in a client instead would create a two-place
invariant that silently breaks addressing when either side drifts.

**Option B — make replay safe instead.** If the harm is a re-executed effectful
body, the fix may belong in the runner rather than the client: the receipt cell
is minted unconditionally at the top of a dispatch, before any branching, so its
address is known before the body runs. Checking for an existing receipt there
would let a replay return the original outcome without re-executing — and would
cover shell clicks and pattern-internal chains, not only callers holding a
terminal.

**Option C — keep the address.** Treat the receipt address as the thing worth
persisting, and make losing it the caller's problem to avoid. Costs nothing and
is what the detached path already assumes.

**When to revisit.** When a verb exists whose body has effects outside its
transaction *and* whose caller cannot retain the address. Until both hold,
Option C covers the ground and Option B is the better place to spend if the
first condition arrives on its own.

## Documentation owed

- [Verbs over the CLI](../common/verbs/over-the-cli.md) documents the
  `--show-links` shape, and its examples teach hand-written invocation ids
  beside the session that scopes them — safe now that an id names an
  invocation only within its session.
- `packages/cli/README.md` §"Output Conventions" is the source these notes
  inherit their stdout/stderr rules from. It also carries the projection and
  filter contract the read layer extends.

## Deferred work

- **Batching.** The answer to O(N) fan-out — resolving many references in one
  request. A parent's **compact index** (one row per child carrying a reference
  plus summary fields, per the verb contract's Discovery section) already covers
  the designed case in one read, and composes well here: the row's reference
  renders as a `$link` while its summary fields render inline. Batching is for
  the ad-hoc and exploratory cases an index does not anticipate.
- **Collection windowing.** Carried by the read layer; see
  [Shaped reads and verb results](shaped-reads-and-verb-results.md).
- **A host in the canonical locator.** The fabric's canonical reference syntax
  — `/[@did/]<id>[@scope][/path]`, what a rendered address is written in and
  what `--piece` reads back — carries space, id, scope and path, so a
  path-bearing address already travels as one string. The host does not, so a
  reference still means "wherever this command is pointed".
- **A local receipt cache.** `markCreateOnly` makes a receipt **write-once** and
  its address deterministic, so the *document* is safely cacheable. Its rendered
  value is not: the receipt holds links into live cells, so a materialized copy
  goes stale the moment a referenced child changes. Cache the links, never the
  materialization. Three further constraints decide it: identity-keyed (values
  inherit CFC labels), confidential at rest (the CLI persists nothing today),
  and it must not outlive server retention.
- **A retention policy** and the linked receipt collection that would make expiry
  distinguishable from error.
- **Removing the hand-rolled `of:` conversions** — a dozen in the packages
  inventoried above, plus more outside them.
- **Recovering an outcome whose address was lost** — discussed above, with its
  three options and the condition that would make it worth building.
