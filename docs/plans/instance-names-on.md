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

A _naming runtime_ is one with the flag on, and a _positional runtime_ is one
with it off, which is every runtime today. The plan records eight decisions.
Each one can be contested, and the section that states it says what it rests
on. The rule the memory server enforces is INV-16 in
[`09-invariants.md`](../specs/memory-v2/09-invariants.md#inv-16--instance-naming-admission),
and its wire form is in [`04-protocol.md`](../specs/memory-v2/04-protocol.md)
§4.1.1 and §4.1.2.

## Why a boundary comes first

A positional runtime binds a parent's children by position, and a naming
runtime binds the parent's named instances by name. Two such runtimes on one
space bind the same parent to different documents, and neither refuses.
`runtime/runner/test/instance-naming-modes.test.ts` pins what a positional
runtime does to a parent a naming runtime set up or carried over:

- after a naming runtime updates a parent to a source that inserts a sibling
  ahead of a named instance, a positional runtime runs the sibling on the
  named instance's document, and the named instance on a fresh one, so each
  handler writes another child's state;
- a positional runtime reopening a parent a naming runtime set up runs fresh
  children in place of the named ones, and a naming runtime that later starts
  the parent carries over those fresh children, so the state written first is
  unreachable for good;
- once a positional runtime starts such a parent, every runtime viewing it
  sees the fresh children.

A runtime of the other mode reaches a space by ordinary means, in either
direction: a browser tab loaded before a deployment changed its posture, a
`cf` binary older than the flag, a `cf` run with `CF_ADOPT_SERVER_FLAGS=false`
and its own value for the flag, a client that cannot read `/api/meta` and
keeps its own default, or a toolshed process of the previous release during a
rolling deploy. Nothing excludes any of them today.

## Decisions

### D1. A one-way mark on each space

A space is either unmarked or marked as holding data a naming runtime wrote.
The memory server admits a positional runtime to an unmarked space only, and
nothing removes a mark once it is recorded.

The alternative is one posture for a whole deployment, enforced at admission
by every toolshed. It needs no new stored state, but a deployment switched back
to off then admits positional runtimes to data a naming runtime wrote, which is
exactly the hazard above. A mark on each space keeps that data closed to them
whatever the deployment's posture, and lets a rollout proceed one space at a
time. The posture still decides where a mark may be made (D8).

### D2. The first commit from a naming session marks the space

The mark is recorded in the same store transaction as the first commit a
session declaring naming makes to the space, including a genesis commit. From
that transaction on, the server refuses every commit to the space from a
positional session, and it revokes the space's positional sessions to tell
their clients. A naming session that only opens and reads leaves the space
unmarked.

Every hazard above needs a naming runtime's write: a setup, a start that
records `instanceChildren`, or a handler run. A naming session that never
commits leaves the stored data as a positional runtime wrote it, which a naming
runtime carries over when it does commit. Marking at the first commit also
means that only a principal that can write the space can close it to
positional runtimes. Marking at the first open would let a reader with READ
alone record state on a space it cannot otherwise change.

The commit refusal is what keeps a positional commit out once the space is
marked; the revocation only tells the client. An access-list change works the
same way: every commit is authorized as it arrives, and revoking a
deauthorized session is notification, so a late or lost revocation admits
nothing.

### D3. A session declares its mode in `session.open`

A naming runtime declares `instanceNames: true` in the signed session
descriptor of every open. A session that declares nothing is positional, which
is what every runtime of a build older than the declaration sends. A server
advertises the `instanceNameMark` `hello` capability when it records and
enforces the mark. A naming runtime that connects to a server that does not
advertise it fails the connection permanently, before signing any open, with
update-required guidance, as a runtime does today with a server that does not
advertise `stableExpressionResultIds`: an older server would admit its commits
and record no mark. A positional runtime needs nothing from the server.

The declaration is self-reported. That is enough for every build that carries
it: the hazard is a runtime of the other mode doing what its code does, not a
writer that lies about its mode, and a writer that lies already holds WRITE on
the space.

The one writer the boundary cannot see is a naming runtime of a build older
than the declaration. No environment reaches the flag in such a build, so it
can only be made through `RuntimeOptions.experimental.instanceNames`, in a test
or a hand-built `Runtime`. It declares nothing, is admitted as positional, and
writes named data without marking the space.

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

A space's database is the store the toolshed owning the space opens, so
whichever toolshed owns it next reads the mark from there. The server reads
the mark when it admits an open and when it admits a commit, as it reads the
space's kind. Nothing reports the mark to a client: a marked space admits only
naming sessions, which need no report of it.

### D5. A refusal is terminal and says what to do

A runtime refused for its naming mode gets the refusal the expression-result
identity check already sends: a `SessionRevokedError` with
`clientUpdateRequired: true`. The client and storage manager already keep that
refusal across mounts and spaces, never retry it, and report it to the shell,
which shows persistent guidance and warns about unconfirmed writes
(`docs/features/authorization-failure-surfacing.md`, "Runtime incompatibility:
replace the client").

There are three refusals, and they call for different remedies, so each
carries its own message:

| Refused | Message | Remedy |
| --- | --- | --- |
| a positional session's open of a marked space | `Space <space> holds data written with instance names, which this runtime does not use` | load a runtime that names instances: reload the tab, or update the `cf` checkout |
| a positional session open on a space when a naming commit marks it | `Space <space> now holds data written with instance names, which this runtime does not use` | the same |
| a naming session's open of an unmarked space on a server whose posture names none (D8) | `The server of space <space> does not name instances, and this runtime does` | adopt the deployment's posture: reload the tab, or run `cf` without `CF_ADOPT_SERVER_FLAGS=false` |

The second refusal reaches the client as a `session/revoked` with the reason
`instance-names`, which carries no message, so the client makes the message
from the reason and the space. A client today turns every revocation into a
plain `SessionRevokedError` without `clientUpdateRequired`, and the storage
manager keeps only a refusal that carries it; stage 1 makes the client mark
this one, so it is kept like the others.

The shell's card for a kept refusal shows the refusal's message under "Update
required", and then a fixed line: "Reload this tab to load the current
version." That line is wrong for a deployment switched back to off, where a
reload loads a positional runtime that a marked space still refuses. Stage 1
replaces the fixed line with one that fits every refusal it shows: reloading
loads the runtime this deployment serves, and if the same message comes back,
this deployment cannot open that space.

### D6. A rollback fails closed

A deployment switched back to off keeps the boundary code. Its positional
runtimes are refused every marked space and admitted to the rest, and under D8
no naming runtime still connected to it, such as a tab loaded before the
switch, can mark another space. A marked space is then unavailable, not
damaged, and the set of marked spaces stops growing. A rollback of the code
itself must stay at or past the release that carries the boundary, since an
older memory server admits every runtime. No tool unmarks a space.

### D7. The mark is per space, and covers a child in another space

The mark is recorded where each naming commit lands. A parent's
`instanceChildren` meta lives in the parent's space and links each child by
`{ space, id, scope }` (`runtime/runner/src/meta-seam.ts`), so a child can live
in another space, as a profile Home creates does. Binding a named instance to
its child is decided by the parent, and recorded or re-derived only where the
parent lives. A positional runtime that could rebind the child would have to
run the parent, and so open the parent's space, which the parent's first
naming commit marked. Sessions are per space, so the parent's naming runtime
marks the child's space at its first write there, the child's creation
included; until then the child's space holds only what a positional runtime
wrote. This is inferred from where the meta is stored and how binding reads
it, not measured.

### D8. A space is marked only where its deployment names instances

A server admits a naming session's open of an unmarked space only while its own
posture names instances, and refuses it otherwise with the same
`clientUpdateRequired` refusal (D5). A naming session's open of a marked space
is admitted whatever the posture.

Without this, any naming runtime that reaches a deployment whose posture is off
marks every unmarked space it writes, and so closes it to every positional
runtime that deployment serves, its own serving runtimes among them: a `cf` run
with `CF_ADOPT_SERVER_FLAGS=false` and the flag on, a client that cannot read
`/api/meta` once the runtime's default is on, or a tab left open across a
rollback. That fails closed, but one misconfigured client could close shared
spaces for a whole deployment. With D8, no space is marked until the toolshed
owning it has turned the posture on.

The toolshed knows its posture: it publishes it on `/api/meta` from
`experimentalPosture()` (`runtime/toolshed/lib/experimental-posture.ts`), and
the memory server it hosts is given the same value. A toolshed reads its
posture at startup, so a posture change is a restart, which drops every
connection, and every session opens again under the new posture. A server
given no posture names no instances. While a deployment's toolsheds restart one
by one, a naming client that has adopted the new posture is refused an unmarked
space whose owning toolshed has not restarted yet, and again on each reload
until it has, so the refusal names the space's server rather than the
deployment.

## Stages

### 1. The boundary, with the posture off

The memory server records the mark, enforces INV-16, and advertises
`instanceNameMark`. In routed mode, the router's public offer is the
intersection of its endpoints' flags, including flags the router does not
know, so the router needs no change
([`routed-mode-a.md`](../specs/memory-v2/routed-mode-a.md)). The memory
client declares the runtime's mode, fails the connection permanently when it
names instances and the server does not advertise the capability, and marks the
three refusals and the `instance-names` revocation `clientUpdateRequired` (D5).
The shell's card gets the guidance D5 gives it. The flag stays unreachable from
the environment, so every runtime is positional, and D8 refuses a naming one
anywhere.

The hazards `instance-naming-modes.test.ts` pins under `TODO(danfuzz)` become
refusals: the positional runtime is refused the space, the test asserts the
refusal, and the `TODO(danfuzz)` in `runtime/runner/src/runtime.ts` that names
the boundary goes. The memory package tests INV-16's clauses directly: a
naming commit records the mark in its own transaction, a positional commit to
a marked space is refused, the space's positional sessions are revoked, a
marked space refuses a positional open and resume, an unmarked space admits
both modes while the posture names instances, and refuses a naming open while
it names none. Tools that copy a space's store, among them
[space-clone rehearsal](../development/space-clone-rehearsal.md), carry the
mark's row with it.

### 2. The flag becomes reachable on servers

`EXPERIMENTAL_INSTANCE_NAMES` is mapped in the canonical env registry, so a
toolshed deployment chooses the posture. The flag is already
server-authoritative and a `"deployment"` shell source, so `cf`, the connectors
and the shell adopt what the server publishes. The same mapping lets a client
that does not adopt the server's flags set its own value, and D8 is what makes
that safe: a naming client is refused every unmarked space of a deployment
whose posture is off, and a positional client is refused every marked space. A
deployment turns the posture on only once every toolshed it runs carries stage
1, since one without it admits any runtime and records no mark, and once each
router has restarted after that: a router's public offer is fixed for its
process's lifetime, so one taken while an endpoint lacked `instanceNameMark`
omits it, and every routed naming client then fails its connection.

### 3. Tests that pass with the flag forced on

The runner and piece suites pass with the runtime's default forced on, and so
do the patterns, shell and CLI suites, the integration tests, and `cf test` over
the pattern unit tests, run the same way before the flip. The failures such a
run finds are made to pass in either mode, so the flip is a change to the
default and to nothing else. The ones a forced-on run of the runner and piece
suites has found so far are test assumptions rather than product bugs:
compile-cache tests that read the positional cache variant's key, a
`stored-setup-build-repair.test.ts` helper that takes a positional descriptor
that is now named, and the assertions of the default in
`experimental-options.test.ts`.

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
The mark, the declaration and INV-16 stay as long as a positional runtime can
reach a deployment's spaces.

## What this leaves open

- A naming runtime of a build older than the declaration, made through
  `RuntimeOptions.experimental.instanceNames`, declares nothing and writes
  named data without marking the space (D3). Nothing on the server can tell it
  from a positional runtime.
- What a client of a build older than `instanceNameMark` does with the
  `session/revoked` reason `instance-names`, which its message parser does not
  recognize, as it does not recognize `deleted`. The commit refusal keeps its
  later commits out of the store, and its reopen is refused at admission, so
  the revocation is about what the client shows, not about what reaches the
  store. A client of such a build that only watches the space and never
  reopens it keeps its session's view without learning why updates stopped.
- Whether a space can be marked other than by a write, for an operator who wants
  a space closed to positional runtimes before anything writes it.
- Server-side execution runs in the deployment's runtimes, which open spaces
  through the same admission as any other, so a served run's sessions declare
  the deployment's mode. Under D8 a space is not marked before the toolshed
  owning it names instances, so its serving runtimes are never refused for
  their mode while the deployment's posture holds. A served runtime refused
  after a rollback leaves that space unserved; nothing more is planned for that
  case.

Server admission and the memory protocol are the area of @mathpirate, who
built client attribution and the refusal kept across mounts, and of @ubik2;
the compiler and pattern identity side touches @seefeldb's area.
