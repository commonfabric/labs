# Turning instance names on

Nothing in this plan is built yet. It is the sequence that takes the
`instanceNames` experimental flag
([`EXPERIMENTAL_OPTIONS.md`](../development/EXPERIMENTAL_OPTIONS.md#instancenames))
from off everywhere to on everywhere, and then deletes it. Naming an instance
bound to a `const` is specified in
[`computed-cell-identity.md`](../specs/computed-cell-identity.md), "Sub-pattern
instance identity". Carrying a deployed parent's positional children over to
their names is built, and so is everything the flag gates. What is missing is
what has to come before any deployment turns it on.

The plan records seven decisions. Each one can be contested, and the section
that states it says what it rests on. The rule the memory server enforces is
INV-16 in [`09-invariants.md`](../specs/memory-v2/09-invariants.md#inv-16--instance-naming-admission),
and its wire form is in [`04-protocol.md`](../specs/memory-v2/04-protocol.md)
§4.1.1 and §4.1.2.

## Why a boundary comes first

A runtime with naming off binds a parent's children by position, and a runtime
with naming on binds the parent's named instances by name. Two such runtimes on
one space bind the same parent to different documents, and neither refuses.
`runtime/runner/test/instance-naming-modes.test.ts` pins what a runtime with
naming off does to a parent a naming runtime set up or carried over:

- after a naming runtime updates a parent to a source that inserts a sibling
  ahead of a named instance, a runtime with naming off runs the sibling on the
  named instance's document, and the named instance on a fresh one, so each
  handler writes another child's state;
- a runtime with naming off reopening a parent a naming runtime set up runs
  fresh children in place of the named ones, and a naming runtime that later
  starts the parent carries over those fresh children, so the state written
  first is unreachable for good;
- once a runtime with naming off starts such a parent, every runtime viewing it
  sees the fresh children.

A runtime of the other mode reaches a space by ordinary means: a browser tab
loaded before a deployment changed the posture, a `cf` binary older than the
flag, a `cf` run with `CF_ADOPT_SERVER_FLAGS=false`, a client that cannot read
`/api/meta`, or a toolshed process of the previous release during a rolling
deploy. Nothing excludes any of them today.

## Decisions

### D1. A one-way mark on each space

A space is either unmarked or marked as holding data a naming runtime wrote. The
memory server admits a runtime with naming off to an unmarked space only, and
nothing removes a mark once it is recorded.

The alternative is one posture for a whole deployment, enforced at admission by
every memory worker. It needs no new stored state, but a deployment switched
back to off then admits runtimes with naming off to data a naming runtime wrote,
which is exactly the hazard above. A mark on each space keeps that data closed
to them whatever the deployment's posture, and lets a rollout proceed one space
at a time.

### D2. The first commit from a naming session marks the space

The mark is recorded in the same store transaction as the first commit a session
declaring naming makes to the space, including a genesis commit. In the same
engine turn, the server revokes every session on the space that declares no
naming. A naming session that only opens and reads leaves the space unmarked.

Every hazard above needs a naming runtime's write: a setup, a start that records
`instanceChildren`, or a handler run. A naming session that never commits
leaves the stored data as a runtime with naming off wrote it, which a naming
runtime carries over when it does commit. Marking at the first commit also
means that only a principal that can write the space can close it to runtimes
with naming off. Marking at the first open would let a reader with READ alone
record state on a space it cannot otherwise change.

### D3. A session declares its mode in `session.open`

A naming runtime declares `instanceNames: true` in the signed session
descriptor of every open. A session that declares nothing is positional, which
is what every runtime older than this plan sends. A server advertises the
`instanceNameMark` `hello` capability when it records and enforces the mark. A
naming runtime refuses to open a session on a server that does not advertise
it, before signing an open, because an older server would admit its commits
and record no mark. A runtime with naming off needs nothing from the server.

The declaration is self-reported. That is enough: the hazard is a runtime of
the other mode doing what its code does, not a writer that lies about its mode,
and a writer that lies already holds WRITE on the space.

### D4. The mark lives in the space's store, recorded by the server

The server records the mark in its own row of the space's database, beside the
commit that set it, rather than in a field a commit carries or in a document.
Each choice mirrors something that exists and differs from it on purpose:

- `spaceKind` is a field of the genesis commit, which the committing session
  declares and the server holds to its declaration. The mark is not known at
  genesis for a space created before this plan, so it cannot be sealed there,
  and a commit field would require every commit from a naming session to carry
  it, though only the first one counts.
- Deleting a space (INV-15) writes a tombstone into the space's ACL document,
  through an ACL-only commit a principal makes. The mark is not a principal's
  act and grants or removes no access, and a document can be written by any
  commit that may write it. A server-recorded row is written by the server
  alone.

A space's database is the store every memory worker that owns the space opens,
so whichever worker owns it next reads the mark from there. Every open the
server admits reports it, as `instanceNamesMarked: true` in the
`session.open` result, as an open is told the space's kind.

### D5. A refusal is terminal and says what to do

A runtime refused for its naming mode gets the refusal the expression-result
identity check already sends: a `SessionRevokedError` with
`clientUpdateRequired: true`. The client and storage manager already keep that
refusal across mounts and spaces, never retry it, and report it to the shell,
which shows persistent reload guidance and warns about unconfirmed writes
(`docs/features/authorization-failure-surfacing.md`, "Runtime incompatibility:
replace the client"). A session revoked when its space is marked gets the
`session/revoked` reason `instance-names`, which a client of a build that
knows `instanceNameMark` treats as the same refusal.

The message names the mismatch, since reloading is not the fix for every
runtime that gets it: a tab reloads, a `cf` checkout updates, a `cf` run with
`CF_ADOPT_SERVER_FLAGS=false` adopts the server's flags, and in a deployment
switched back to off no runtime it serves can open a marked space until the
deployment is switched on again.

### D6. A rollback fails closed

A deployment switched back to off keeps the boundary code, so its runtimes are
refused every marked space and admitted to the rest. A marked space is then
unavailable, not damaged. A rollback of the code itself must stay at or past
the release that carries the boundary, since an older memory server admits
every runtime. No tool unmarks a space.

### D7. The mark is per space, and covers a child in another space

The mark is recorded where each naming commit lands. A parent's
`instanceChildren` meta lives in the parent's space and links each child by
`{ space, id, scope }` (`runtime/runner/src/meta-seam.ts`), so a child can live
in another space, as a profile Home creates does. Binding a named instance to
its child is decided by the parent, and recorded or re-derived only where the
parent lives. A runtime with naming off that could rebind the child would have
to run the parent, and so open the parent's space, which the parent's first
naming commit marked. The child's own space is marked by the first naming
commit made there, such as a start of the child that records its own
`instanceChildren`; until then it holds only what a runtime with naming off
wrote. This is inferred from where the meta is stored and how binding reads
it, not measured.

## Stages

### 1. The boundary, with the posture off

The memory server records the mark and enforces INV-16, and advertises
`instanceNameMark`. The memory client declares the runtime's mode, requires the
capability when it names instances, and treats the new refusal and revocation as
`clientUpdateRequired`. The flag stays unreachable from the environment.

The hazards `instance-naming-modes.test.ts` pins under `TODO(danfuzz)` become
refusals: the runtime with naming off is refused the space, the test asserts
the refusal, and the `TODO(danfuzz)` in `runtime/runner/src/runtime.ts` that
names the boundary goes. The memory package tests INV-16's clauses directly: a
naming commit records the mark and revokes positional sessions in the same
turn, a marked space refuses a positional open and resume, and an unmarked
space admits both modes. Tools that copy a space's store, among them
[space-clone rehearsal](../development/space-clone-rehearsal.md), carry the
mark's row with it.

### 2. The flag becomes reachable on servers

`EXPERIMENTAL_INSTANCE_NAMES` is mapped in the canonical env registry, so a
toolshed deployment chooses the posture. The flag is already
server-authoritative and a `"deployment"` shell source, so `cf`, the connectors
and the shell adopt what the server publishes. A deployment turns it on only
once every memory worker it runs carries stage 1: a worker without it admits
any runtime and records no mark.

### 3. Tests that pass with the flag forced on

With the default forced on at `6069111c7f` (2026-10-28), 11 runner tests (48
steps) and 1 piece test failed. Every failure inspected was a test assumption
rather than a product bug: compile-cache tests that read the positional cache
variant's key, a `stored-setup-build-repair.test.ts` helper that takes a
positional descriptor that is now named, and the assertions of the default in
`experimental-options.test.ts`. Those tests are made to pass in either mode, so
the flip is a change to the default and to nothing else. The forced-on run
covered the runner and piece suites only; the patterns, shell and CLI suites,
the integration tests, and `cf test` over the pattern unit tests are run the
same way before the flip.

### 4. The cause-assignment gate sees the flip

`deno task check-cause-assignments` compiles only when a change touches
`COMPILER_PATHS` in `tasks/check-cause-assignments.ts`, and
`runtime/runner/src/runtime.ts`, where the default is set, is not among them.
The gate is made to compile on a change to the default, so the flip is checked
against the numbering it is meant not to move.

### 5. The flip

A deployment turns the posture on, and its spaces are marked as naming runtimes
write to them. Once every deployment runs with it on, the runtime's default
becomes on. The flip invalidates every stored compiled closure, since a naming
compile is cached under its own variant, so each pattern compiles once more
after it.

### 6. Removing the flag

Once every deployment runs with it on, the flag, its env mapping, its authority
and shell-source entries, `namesInstances()`,
`TransformationOptions.instanceNames`, the cache variant, and the positional
compile of `const`-bound instances are deleted, as the registry entry lists.
The mark, the declaration and INV-16 stay as long as a runtime that names no
instances can reach a deployment's spaces.

## What this leaves open

- What a client of a build older than `instanceNameMark` does with the
  `session/revoked` reason `instance-names`, which its message parser does not
  recognize. The server forgets the session either way, so the client's later
  commands on it are refused, and its reopen is refused at admission. The
  revocation is about what the client shows, not about what reaches the store.
- Whether a space can be marked other than by a write, for an operator who wants
  a space closed to runtimes with naming off before anything writes it.
- Server-side execution runs in the deployment's runtimes, which open spaces
  through the same admission as any other, so a served run's sessions declare
  the deployment's mode. Nothing more is planned for them.

Server admission and the memory protocol are the area of @mathpirate, who
built client attribution and the refusal retained across mounts, and of @ubik2;
the compiler and pattern identity side touches @seefeldb's area.
