---
status: historical
created: 2026-09-17
archived: 2026-09-17
reason: "Review of the random space identity plan as it stood at 59e8a2540c; its findings were applied to the live plan and specification."
superseded-by: docs/plans/random-space-identities.md
---

# Review of the random space identity plan

This is a review of `docs/plans/random-space-identities.md` and
`docs/specs/random-space-identities.md` as they stood at `59e8a2540c`, which
added both in a documentation-only commit on 2026-09-15. The brief was to
assess whether the plan could be implemented as a single pull request, and to
prepare for that. The finding is that it could not, and the reasons are below.
The live plan and specification were rewritten to reflect them.

## What the code did at the time of the review

Each of these was read in the working tree at `e4f878a03e`.

- `createSession({ identity, spaceName })` computed the space key as
  `Identity.fromPassphrase("common user").derive(spaceName)`
  (`packages/identity/src/session.ts:31`). The calling identity was unused, so
  anyone who knew a space's name could recompute that space's private key, and
  two users choosing the same name got one space.
- The derived key was handed to the storage manager as bootstrap authority
  through `registerSpaceIdentity`. At the space's first mount, a short-lived
  session authenticating as the space wrote the genesis access-control
  document.
- The genesis document for a fresh non-Home space was
  `{ [creator]: "OWNER", "*": "WRITE" }`. The wildcard came from
  `DEFAULT_GENESIS_GRANTS` (`packages/runner/src/storage/v2.ts:778`), whose own
  comment said that retiring it was one edit and one rollout decision. The only
  caller supplying its own genesis document was a test-support helper, and no
  user-facing surface narrowed an access-control document afterwards, so an
  ordinary space was born world-writable and stayed that way.
- The Memory server granted OWNER to any principal equal to the space DID, with
  no access-control entry and no expiry (`packages/memory/v2/server.ts:1958`
  for ordinary authorization, `:7691` for the cross-space provisioning probe).
- `PatternFactory.inSpace("name")` and the anonymous `PatternFactory.inSpace()`
  both resolved through that derivation. The anonymous form first computed a
  name by hashing the handler frame's cause together with a per-frame counter
  (`packages/runner/src/builder/pattern.ts:1145`), which is what made a re-run
  of one handler reach the same space.
- `Runtime.resolveSpaceName` (`packages/runner/src/runtime.ts:3674`) cached
  resolved names in process memory only. Nothing durable recorded which name
  had become which DID, because until then the mapping was recomputable.
- The Home space already carried a per-user table addressed by a canonical
  cause rather than by the Home pattern's output: the site table, mapping a
  space DID to the host serving it (`packages/home-schemas/spaces.ts:89`).
- The Home pattern's managed space list was `defaultPattern.spaces`, an array
  of `{ name, did? }` in which only `name` was required
  (`packages/patterns/system/home.tsx`). Adding a space was typing a name, and
  the DID was derived when the link was opened.
- `spaceName` appeared 1017 times across 230 files. About twenty of those files
  were production code; the rest were tests and fixtures wanting a repeatable
  space DID from a string.
- `tasks/check-tripwires.ts` was set to fail continuous integration as soon as
  the derivation stopped colliding across users. Its stated obligation was four
  operational steps: audit issued ingest channels, retire them, sweep space
  access-control documents for owner grants nobody could account for, and audit
  again.
- The Memory server already had a staging mode for access-control decisions.
  Under `MEMORY_ACL_MODE: observe` it counted what it would have refused and
  warned, rather than refusing (`packages/memory/v2/server.ts:2021`).

## Findings

### The plan was three changes welded together

The plan combined making new space DIDs random and creator-owned; removing the
permanent implicit ownership that equality with the space DID conferred; and
building an idempotent, crash-recoverable, cross-provider space-creation
service. Only the first was the stated goal. The second was needed for the
first to be worth anything. The third was a response to a requirement the
specification asserted without justifying.

### The idempotency requirement produced nearly all the complexity

The specification required that repeating one create action return the same DID
and genesis transaction, keyed by an opaque idempotency key scoped to the
creator, a normalized target origin, and a provider-advertised
control-namespace version. Everything downstream followed from that sentence:
the durable creation record, the states `intent-recorded`, `home-authorized`,
`allocated`, `genesis-committed`, `complete`, `rejected`, `abandoning`,
`abandoned` and `inconsistent`, the content-authorization rules enforcing the
transition graph, the deferred marker and the continuation generation, and the
operator recovery evidence.

What a duplicate create actually costs is one space that exists, is owned by
its creator, holds nothing, and appears in no list — one access-control
document, unreachable by anyone.

Replay stability is genuinely required in one place, and the code already
provided most of it. An anonymous `PatternFactory.inSpace()` derives its name
from the handler frame's cause, so a re-run computes the same name. What the
random change takes away is only the ability to recompute a DID from that name.
A durable name-to-DID map restores it, and the creator's Home space is already
a single logical writable history with conditional transactions, which is the
mutual exclusion the provider control spaces were built to supply.

### The provider-private control spaces held nothing that needed a new store

With no creation record there is nothing for them to hold. Removing them also
removes their append-only version catalog, their fixed shard sets, the
domain-separated hash that selected a shard, the load test that sized them, and
the requirement that a deployment provision them before enabling creation.

### The server-to-server allocation fetch defended a surface the design created

The plan had the Home provider fetch the allocation result over authenticated
HTTPS from the target provider, reject cross-origin redirects, resolve and pin
the connected address, and refuse loopback, link-local, private, multicast and
other special-use addresses. That request existed only because the allocation
record sat on one provider and the registration on another. The creating client
holds the bootstrap key and writes both, so there is no such request.

The one caller that is not a client is server-side execution resolving an
`inSpace()` name during a served run. That runtime already addresses spaces by
DID through `MEMORY_URL` and already reaches the acting user's Home space, so
it writes the map directly.

### Persisting the signed genesis transaction was unnecessary

The plan recorded the complete signed genesis transaction durably before
submitting it, so that a process which crashed could resubmit it without the
key. Submitting genesis first and recording the mapping afterwards makes that
unnecessary. A crash before submission leaves nothing; a crash after it leaves
a space that is complete and unreferenced. The private key then exists in one
process, for one signature.

### The migration ledger and the write barrier preserved compromised spaces

The plan proposed inventorying every populated space, establishing a verified
owner for each from evidence other than the old public key, refusing cutover
until every populated space had one, then stopping all writes globally,
draining every process, applying the migration, publishing a cutover marker,
and resuming.

That work was to let existing spaces survive the removal of implicit space-DID
ownership. Narrowing that ownership does end what a recomputed key can do from
that point on, so the narrow claim that a space cannot be repaired at all is
wrong. What the repair cannot undo is what the key could already do, and four
verified facts show that the ledger does not address any of it:

- Every ordinary space was born granting every principal write access, and
  write implies read, so confidentiality was already gone independently of the
  key. `docs/features/self-serve-ingest-channels.md` states this in the
  repository's own voice.
- The ledger's own rule accepted "an owner proven by an existing concrete ACL
  grant", which is exactly the planted entry that
  `tasks/check-tripwires.ts` warns is not optional to sweep for.
- The ledger never removed the wildcard grant, and `hasConcreteOwner` in
  `packages/memory/acl.ts` ignores the wildcard, so a space that is still
  world-writable satisfies the cutover gate.
- Per-commit authorship was never recorded.
  `docs/specs/memory-v2/04-protocol.md` defers it, and
  `packages/memory/v2/engine.ts` writes a sentinel or null, so "effective owner
  evidence" cannot be reconstructed from the store.

The ledger is therefore not implementable as written, and the write barrier
that existed to apply it is not needed. What replaces both is narrower: a sweep
of each legacy space's access-control document, which the tripwire already owes,
removing the wildcard grant and any owner grant nobody can account for.

This review first concluded that existing spaces should be retired rather than
preserved. Team review rejected that: existing spaces have to keep working,
including the name-bearing URLs already in circulation. "The team decision"
below records what that changed.

### A global write barrier was proposed where a staging mode already existed

The barrier's purpose was to learn which spaces would lose access under the
narrowed rule before enforcing it. `MEMORY_ACL_MODE: observe` already counts
and reports what an access-control decision would have refused, without
refusing it. Giving the narrowed rule the same arm answers the same question
from a running deployment.

### Three preparation items could not be in a Labs pull request

The Confidential Fabric Computing specification amendment and the corresponding
change to the Lean membership model live in `commonfabric/specs`. The
`MEMORY_URL` change pointing each production process at the host-internal
routed endpoint lives in `commonfabric/infra`. The ingest-channel retirement,
the existing-space retirement, and the access-control sweep are operational runs
against production. A plan calling for one pull request while listing
cross-repository and operational prerequisites contradicts itself.

### The largest mechanical cost was not mentioned

The plan said to remove public interfaces whose only purpose was deriving a
space DID from a name, without saying what the 1017 `spaceName` call sites
would do instead. Nearly all of them are tests wanting a repeatable space DID
from a string, and converting them is the single biggest part of the diff.

### The wildcard genesis grant was folded into the cutover

Every new non-Home space being born world-writable is, on its own, at least as
large a hole as the recomputable key: a random DID that anyone may write to is
no more private than a derived one. Retiring `DEFAULT_GENESIS_GRANTS` is one
edit, is independent of random identity, and is testable alone. The plan placed
it inside the barrier cutover.

### The tripwire's effect on continuous integration was not stated

`tasks/check-tripwires.ts` fails as soon as the derivation stops colliding, and
its obligation is four operational steps that must precede deleting it. A
single pull request that changes the derivation is therefore red from its first
commit until those steps are done and the tripwire is removed in the same diff.

## The adversarial pass

The rewritten specification and plan were then reviewed against the code by two
subagents that were given the old and new documents unlabeled. Both chose the
new one. Both found real defects in it, and the findings below were applied
before it landed.

### A key destroyed too early can strand a space permanently

The first rewrite destroyed the bootstrap key once the genesis transaction had
been submitted. If that submission's outcome is indeterminate and genesis did
not land, the key is gone, the space sits at sequence zero with no
access-control document, and `#resolveCapability` hands out READ forever with
nothing able to write the genesis that would repair it. The fix is an ordering
change: resubmit the identical transaction until the commit is confirmed,
destroy the key then, and return the DID only after that.

### The allocation record belongs beside the link, not in a directory

The first rewrite put a name-to-DID map in the creator's Home space. The thing
that needs the DID on replay is the parent space: the handler already writes a
cross-space link there in the same transaction, and
`enableCrossSpaceChildCommit` already admits that commit. Recording the
allocation in the calling space removes the cross-space write from a serving
runtime into a user's Home space, removes the per-user global namespace and the
contention between unrelated users, and commits the allocation with the
reference that needs it. `inSpace("notebook")` then means "the space this space
calls notebook".

### A list is not a mutual exclusion

The first rewrite said to follow the site table's shape. That table is an array
with no uniqueness constraint whose reader takes the last matching row, so a
later writer takes a name over without ever losing a compare-and-set. An
allocation record has to be one immutable document per name, addressed by a
canonical cause, so that a compare-and-set against a document that does not yet
exist is the whole mechanism.

### Name resolution has no retry bound

`packages/runner/src/scheduler/types.ts` records that `RetryImmediately` is
bounded by the monotonic space-name cache and by nothing else: each re-run
resolves at least one previously unresolved name, and a resolved name never
becomes pending again. Any design that can forget a resolved name, or leave one
unresolved after an attempt, turns the retry into an unbounded loop. The first
rewrite did not state this constraint.

### Genesis depends on the arm being narrowed

A genesis commit is admitted by `#validateAclCommit` and then by an ordinary
capability check requiring OWNER, and that OWNER comes only from
`#resolveCapability`'s space-identity arm. Two consequences were missed. The
narrowing has to keep that arm alive for a space with no access-control document
at sequence zero, or genesis stops working. And a populated Home space with no
access-control document loses its repair permanently, because that check is not
gated by `MEMORY_ACL_MODE` and so the loss cannot be staged or observed first.
The first rewrite gave the right prerequisite for the wrong reason: such a space
is not private today, since the compatibility rule already grants write access
to any authenticated principal.

### Retired spaces left served are still dangerous

The first rewrite said old DIDs are left unreferenced. A retired space that
stays served stays writable by anyone holding any key, so a surviving link into
it from a live space is a surface an attacker controls, whose contents a
reader's runtime loads under the reader's own authority. Retirement has to end
with the store offline or denying everyone, and with no live space linking into
it.

### Claims that were overstated

- "Every production path goes through one function" was false: about a dozen
  production modules call `createSession({ spaceName })` without reaching
  `Runtime.resolveSpaceName`. Two of them resolve a name with no network at all,
  which makes routing them through a record a product change.
- "Nobody else holds any capability on it" contradicted the same plan's decision
  to keep configured service authority, which grants OWNER on every space.
- "A user whose create request was lost asks again and gets one space" was true
  only for a lost request. A lost response yields two spaces.
- The claim that an existing space stays compromised whatever is done to its
  access-control document was false as worded, and is replaced by the four
  verified facts recorded above.
- `foreignWriteAuthorityFor` grants any principal write authority to a space
  whose store does not exist, deliberately and with no mode gate. It is a
  separate hole, and the narrowing beside it does not close it.

## The team decision

After the adversarial pass, team review set a requirement the review had argued
against: every existing space keeps working, and a shared URL carrying a space
name keeps opening the space it always opened. Creating new spaces at
name-derived DIDs may stop; reaching existing ones may not. Two such URLs were
named, for the spaces called `team-lunch` and `topics-dev-476ea34f`.

Retirement was the wrong recommendation, and one of the two reviewers had said
so in passing: preserving existing DIDs was the single point on which the
original plan was the more defensible of the two. That observation was
dismissed rather than answered.

Three facts checked while applying the requirement made it much cheaper to
satisfy than the review had assumed:

- A name-bearing URL has to resolve for anyone who opens it, whatever identity
  they hold and whether or not they have opened it before. No per-user record
  can serve that, so it takes a fixed table — a closed list of name-to-DID
  facts, computed once from the derivation and then frozen, which the product
  reads and cannot add to.
- No shipped pattern uses the named `PatternFactory.inSpace(name)` form. The
  only production use is the anonymous form, in profile creation.
- A cross-space child is reached through the link its parent holds, not by
  resolving a name (`packages/runner/src/pattern-manager.ts`
  describes a fresh runtime loading an `inSpace` child from the child's own
  space). Every space an anonymous `inSpace()` call created therefore keeps
  working with no table entry and no allocation record.

So a table would be needed for user-facing name resolution alone.

Two attempts at one were rejected. Checking it into the repository was wrong
because several instances run in production with different sets of spaces, so
one table in the product would describe one instance and be wrong about the
rest. Having each provider serve its own was better, but cost what the first had
saved: resolving a name became a network operation, the two interfaces that
resolve offline had to take a provider and reach it, and the whole change came
to rest on an inventory whose every omission broke a URL.

Team review then asked the question that removes the table altogether: the names
can be derived as they always were. The derivation is a pure function of the
name, taking no host, no user and no clock, so it answers identically at every
provider and needs no record of which names exist. Keeping it as a resolver
costs nothing that was not already lost, because deleting it would not make a
legacy space's key secret — the passphrase and the algorithm are in this
repository's history and in every shipped bundle, so those keys are public
permanently. Only one use of the derivation has to stop, and that is creating a
space.

That removes the table, the inventory, the per-instance deployment data, the
provider read path, and the network dependency, and it leaves the two offline
resolvers offline. What it adds is one obligation: the surviving resolver must
return a DID rather than a key, and the `space-key-derivation` tripwire must be
rewritten to probe random creation, since its present probe asserts a property
of the derivation that the resolver keeps and would otherwise stay armed
forever.

A Home list entry carrying a DID stays authoritative over what a name would
derive, which covers a name mapped to something the derivation would not
produce. Nothing writes such an entry today: `addSpaceHandler` in
`packages/patterns/system/home.tsx` stores a name and nothing else.

## What was done

The specification and the plan were rewritten. The specification lost the
idempotency requirement, the control-namespace catalog, and the provider-private
creation record; it separates creating a space from opening one, records each
DID beside whatever refers to it, and keeps every existing space working through
a frozen legacy name table and through the links parents already hold. The plan
was restructured around one pull request, with three preparatory pull requests
in this repository, three operational runs, and two changes in other
repositories named as prerequisites.

The preparatory pull request that matters most routes every name resolution
through one seam and records allocations durably, while keeping the existing
derivation as the generator. It changes no DID and no behavior a user can see,
and after it the step that invents a DID for a name is one expression in one
function instead of being spread across a dozen modules.
