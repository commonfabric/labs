# Sealed state machine: findings

What building `sealed-state-machine.tsx` (Memory, with a sealed state, one
writer and one released projection) showed about the runtime, as of commit
`7be4b18d9b` on 2026-11-21.

Each finding says how it is known:

- **Ran** means a test in this change pins it, and the test is cited.
- **Ran, not kept** means a development run showed it and no committed test pins
  it.
- **Read** means it comes from reading the cited code or document, and nothing
  here ran it.
- **Inferred** means a conclusion drawn from the others.

The tests are `sealed-state-machine.test.tsx` and
`sealed-state-machine-multi-user.test.tsx` beside this file (pattern tests),
`runtime/runner/test/cfc-transformed-by-input-witness-state-machine.test.ts`
(the "state probe" below) and
`runtime/html/test/worker-display-fit-sealed-state-machine.test.ts` (the
"display test" below). The state probe and the display test each run one client
runtime over emulated storage. Nothing here ran in a browser or against a
toolshed.

## Caveat about the machine these ran on

The repository pins Deno 2.9.8 (`mise.toml:2`). The machine had Deno 2.5.6 and
no other. Two things failed there that are not this change's:

- `deno lint` fails on all 9,327 files, because the `cf-package/no-self-import`
  plugin (`tasks/lint-self-import.ts:84`) is refused a file read. With that one
  rule excluded the files of this change lint clean.
- `runtime/runner/test/cfc-transformed-by-input-witness-compiled.test.ts`, which
  this change does not touch, fails six runs of six with "Leaks detected: A
  timer was started in this test, but never completed", every step passing. The
  state probe fails the same way in about half its runs, every step passing.

So a result below that turns on runtime behavior should be run again on the
pinned Deno before anyone relies on it. The finding most exposed to that is 2.

## The findings that decide the design

### 1. The witnessed release fires on the first move, at the display boundary

**Ran.** After the table's first move, every field of the observer view fits the
ceiling a render gives a reader of the table's space (display test, "releases
every field after the first move", line 161), and again after the deal and after
a later move (lines 169 and 175). A principal who reads no space, or another
space, is refused (lines 192 and 197). The sealed state itself, and what `peek`,
a function no rule names, computes from it, are refused to a reader (lines 214
and 219).

The inductor pool's snag 6 (`patterns/showcase/inductor/pool/README.md:329`,
top/3226) is that a witness naming a handler that read nothing confidential does
not match. It does not arise here, for a reason worth copying: the state has a
sealed default (`Default<StoredGame, "">`), and `move` reads the state before it
writes it, so its first run reads something labeled and is attributed
(`docs/specs/cfc-transformed-by-input-witnesses.md:330`, "An unattributed
input"). The state probe shows the same for a public release at a write gate
("releases a projection of a scalar the writer read and set, from its first
write", line 379). This does not say the pool's case is fixed: the pool's writer
pushes to a list, and this one sets a scalar.

### 2. With server execution on, a witnessed release at a write gate is refused, and CI does not run that

**Ran.**
`deno task cf test patterns/examples/cfc-exchange-rules/witnessed-chain.test.tsx`,
unmodified, on this machine: with `EXPERIMENTAL_SERVER_EXECUTION=false`, 8
passed; with the flag unset, which resolves to on
(`runtime/memory/v2/server-execution-default.ts:46`), 7 passed and 1 failed: the
honest chain's publish is refused ("maxConfidentiality failed at /roomTally",
from the serving loop). `blessed-computation.test.tsx`, whose rule names no
witness, passes with it on.

**Read.** CI runs the pattern tests with server execution off only:
`tasks/integration.ts:71` lists `pattern-tests` in `PACKAGES_WITHOUT_SERVER`,
and line 798 sets `EXPERIMENTAL_SERVER_EXECUTION: "false"` for those.

**Ran, not kept.** A development probe with a witnessed `dropClause` rule over a
scalar state released at a write gate with the flag off and was refused with it
on, for every state shape tried.

**Not run.** Whether the display boundary releases the observer view with server
execution on. The display test runs a client runtime. The two pattern tests pass
with the flag on and off (42 and 81 assertions each way), but they never depend
on a release.

This is the open question that matters most for a real table, since server
execution is the first-party default. The cause was not looked for.

### 3. A mutable state must be one scalar, or the witness is lost

**Ran** (state probe). A handler that reads its state and then sets it keeps the
witness when the state is a scalar (line 379), and loses it when the state is a
record, whether the set changes one field (line 409) or every field (line 418).
A record the writer sets whole without reading it is witnessed, and stops being
witnessed at the first read-then-set (line 428).

**Read.** This matches the specification: a `Cell.set` destination is stamped as
written only when the transaction "read no content at or beneath it"
(`docs/specs/cfc-transformed-by-input-witnesses.md:189`), a container a
`Default` put in place "keeps no writer at all" (line 169), and a write beneath
a stamped destination withdraws the overlapping stamp's attribution (line 175).
A state machine reads its state by definition, so its record's own node never
carries the writer's stamp.

So `StoredGame` is the state's JSON form in one string
(`sealed-state-machine.tsx:129`), parsed by a total parser (line 146). State and
history in one cell is workable only this way. Its cost is that every move
rewrites the whole state, and a concurrent move conflicts on the whole state,
which a turn-based game wants anyway.

**Ran** (state probe, line 443). The other shape that works keeps records: two
record stores and a scalar cursor, where each move reads the current record and
sets the other one whole. It is more machinery than a string for no gain here.

### 4. Only scalar fields of the projection are released, each read on its own

**Ran** (display test, line 184). One read of the whole view record is refused,
while each of its eight scalar fields is released.

**Ran, not kept.** An earlier view had `players: string[]`, `scores: number[]`
and `slots: ObserverSlot[]`. A read of a non-empty list was refused, and so was
a read of one slot object; a scalar reached through them (`players/0`,
`slots/1/face`) was released. An empty list was released.

**Read.** The rule mixes a `TransformedBy` guard with `HasRole`, so it is not
value-intrinsic (`runtime/runner/src/cfc/exchange-eval.ts:233`) and is evaluated
over the join of the locations a read consumed
(`runtime/runner/src/cfc/prepare.ts:11980`), not at each location. That is the
likely reason a read spanning several locations fails where each alone passes,
but the failing location was not identified.

So `ObserverView` is flat, and lists are strings: `board` is one character a
slot, `?` for a hidden card (`sealed-state-machine.tsx:328`). The brief asked
for "an opaque hidden placeholder with a stable per-slot id"; here the id is the
slot's position in `board`, which is also what `reveal` takes. That is a weaker
form than an object per slot, taken because an object per slot is not released.

**Inferred.** A UI cannot derive anything from the view. A `computed()`, or a
`.map()` over a list in the view, is computed by code the rule does not name, so
the display boundary would seal it. The UI therefore renders the view's fields
directly and draws one reveal button for every slot a table can deal, 24 of
them, from a constant (`sealed-state-machine.tsx:448`). No browser run confirms
either half.

### 5. A projection run before the first move poisons the fields that do not change

**Ran, not kept.** With `observe` returning a view of the default state, the
first move's view had `version` carrying the witness and `board` (still `""`)
carrying only `TransformedBy{observe}`, and `board` was refused.

**Read.** `docs/specs/cfc-transformed-by-input-witnesses.md:417`, "An output
that does not change": a stamp is replaced only when its value is written. The
run over the default state has no witness, because nothing wrote the default,
and any field the first move leaves equal keeps that run's stamp.

So `observe` returns `undefined` until the state is non-empty
(`sealed-state-machine.tsx:401`), and the first move's run writes every field
fresh. After that every run is over a state `move` wrote, so an unchanged field
keeps a witnessed stamp (display test, line 175: `phase`, `owners`, `players`,
`scores` and `turn` are unchanged by a reveal and still released).

The same passage is a limit of the design, not only a snag: re-running the
projector over inputs someone else chose leaves an equal output's earlier stamp
in place.

### 6. Lending the table its state from another pattern strips the witness

**Ran** (display test, line 203). A table given its `state` by the pattern
around it plays normally, and every field of its view is refused.

**Read.** The outer pattern's cell reaches the table as a link in the table's
argument, and a reference "stored any way other than by anchoring" earns its
slot no value stamp (`docs/specs/cfc-transformed-by-input-witnesses.md:337`).

So the table must hold its own state. A consequence for tests: a test can reach
the sealed state only by lending it, which is how
`sealed-state-machine.test.tsx` probes the raw state (line 236) and a forged
write (line 241), and a lent table is not a released one.

## The questions the brief asked

### Does the witnessed release fire on the first deal?

Yes at the display boundary on a client runtime (finding 1). Not shown with
server execution on (finding 2).

### How does "one flow label per transaction" constrain the handler? Can it write anything public?

**Ran** (state probe). No. A move that advances the state and also writes a
literal to a public store is refused whole, the state write included (line 455).
A run whose handler body touches only the public store is refused too, because
the handler's binding names the sealed stores (line 467).

So `move` cannot publish "illegal move", a turn counter, or a clock. A refused
move writes nothing and does not throw (`sealed-state-machine.tsx:304`), and its
sender learns only that `version` did not advance. Anything public about the
table has to be a field of the released view. The pattern tests check the
refusals that way (`sealed-state-machine-multi-user.test.tsx:238` to 242).

### Does an input labeled to one user contaminate projections?

**Ran** (state probe), with a second module policy standing in for a user's
clause.

- A value bound into the handler: every write of the sealed state is refused,
  "writer-fit confidentiality misfit ... (canWrite, §8.12.4)", whether or not
  the handler uses the value (line 477). The sealed store's own clause is its
  write ceiling, so a foreign clause cannot enter the state, and cannot reach a
  projection. It also means `move` cannot take a private per-player input, such
  as a hand, through its binding.
- A value sent in the event's payload by another handler that read it: on a
  client runtime the payload arrives without its sender's label, the write
  lands, and the projection is released (line 487). This is the gap the pool
  README records as top/3175 (`patterns/showcase/inductor/pool/README.md:30`).
  It was not run with server execution on.

### What does the projector do when it is re-run?

Finding 5. Also **ran** (state probe, line 394): a public store that already
holds one release refuses the next release into it, and keeps the first. The
pool works around the same family of refusal by not storing its release
(`patterns/showcase/inductor/pool/README.md:217`). The table stores no release
either: the view is read where it is computed.

### What does a handler run do on a client and on the server?

**Read.** With server execution off, the client runs the handler and commits its
writes. With it on, the client commits only the event; it also runs the handler
as speculation whose writes go to a memory-only overlay, and the server's run is
the authoritative one (`docs/specs/server-side-execution/README.md:208` and 320
to 331). A speculative run "may diverge from the authoritative one (clock,
randomness)" (line 328), and `docs/common/concepts/handler.md:109` says the same
of `Math.random()`.

**Inferred** for this pattern. `move` draws randomness only for `setup`
(`sealed-state-machine.tsx:313`), so the dealing client's echo holds a different
layout from the server's until the server's arrives. The view of a fresh deal is
all `?` under either layout, so the divergence is not visible, and no other move
draws randomness. `eventKey()` is not needed: the handler creates no record
named by the event.

**Inferred**, and the largest caveat on "no person can read it". With server
execution off, each player's runtime runs `move` over its own replica of the
sealed state, so every player's machine holds the whole layout. The seal is
enforced by each client's runtime at its display boundary and write gates, not
by the server withholding the bytes. The pool README says the same of its secret
(`patterns/showcase/inductor/pool/README.md:261`). Whether a client receives the
sealed document with server execution on was not looked at.

### Is the proposer a handler sees stamped by the memory server, or can a client set it?

**Read.** It depends on where the handler runs.

- `currentPrincipal()` is a frame check in front of
  `Runtime.actingPrincipalFor()` (`runtime/runner/src/runtime.ts:5032`). On a
  client it returns the runtime's own identity (line 5033). On a serving runtime
  it returns the actor of the run's wave context (line 5034, `waveRunActorOf()`
  at `runtime/runner/src/executor/wave.ts:386`).
- The serving loop takes that actor from the event's `firedAt.user`
  (`runtime/runner/src/scheduler/events.ts:2635`).
- The memory server writes `firedAt` when it admits the event append. For an
  ordinary client append it is `{ user: principal, session: sessionId }`, where
  `principal` is the session's authenticated principal
  (`runtime/memory/v2/engine.ts:4088`), an append with no authenticated
  principal is refused (line 4082), and a client-supplied `firedAt` that
  disagrees is rejected, not corrected (lines 4096 to 4104). The session's
  principal comes from the signed `session.open` the server verified
  (`runtime/memory/v2/server.ts:7175`). `clientSeq` is the only part of
  `firedAt` a client mints (`docs/specs/server-side-execution/events.md:48` to
  63).
- No field of the payload is consulted (`docs/features/current-principal.md`,
  "Where it does not come from").

So with server execution on, the proposer is the server's stamp from the
authenticated session and a client cannot set it. With it off, the handler runs
on the proposer's own client and the value is that client's word; a modified
client could return anything, though it could as easily write the state directly
(`docs/features/current-principal.md:74`). A table that has to hold against a
modified client has to run served, which is the posture finding 2 leaves
unverified.

**Ran.** A reveal whose payload names the player whose turn it is, as `proposer`
and as `acting`, sent by the other player, is refused
(`sealed-state-machine-multi-user.test.tsx:210` and 239), with server execution
on and off. A deal by a player who does not own the table is refused (line 226),
and so is every move by a principal with no seat (line 264).

## Against the inductor pool's snags

| Pool snag (`pool/README.md:284`)                                                | Here                                                                                                                 |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1. Public array of objects beside a labeled sibling (top/3205)                  | Not reached: the table has no public store. The same-store refusal in "re-run" above may be related.                 |
| 2. Confidential default beside a public field fails the start commit (top/3102) | Not reached: the table's only input is the sealed state, and a sealed default with no public sibling starts cleanly. |
| 3. `principalOf` after an in-place set                                          | Not used: the state holds players' DIDs as `move` read them from `currentPrincipal()`.                               |
| 4. A ceiling naming a `PolicyOf` atom refuses every write (top/3207)            | Not used. A `Confidential` store already refuses a foreign clause (state probe, line 477).                           |
| 5. A ceiling binds only a writer that repeats it (top/3219)                     | Not re-tested. Every probe here types its destination with the ceiling.                                              |
| 6. The witnessed release is refused (top/3226)                                  | Avoided by the sealed default the writer reads (finding 1), with server execution off. With it on, finding 2.        |

## Smaller snags

- **A labeled scalar is not a `string` to the type checker.** `state.get()` on
  `Writable<StoredGame>` is `Readonly<StoredGame>`, which a `string` parameter
  refuses, so `move` wraps it in `String()` (`sealed-state-machine.tsx:309`).
  **Ran** (the compiler's error).
- **`cf test` has no display boundary.** `HasRole` is minted only in
  `runtime/runner/src/cfc/render-ceiling.ts:268` and 314; the write gate
  (`runtime/runner/src/cfc/prepare.ts:11898`) passes none. So a rule that
  releases to readers cannot be shown firing in a pattern test, and a pattern
  test can show only that a public store refuses the view
  (`sealed-state-machine.test.tsx:226`). **Ran and read.**
- **The policy's identity covers the view.** The rule names
  `THIS_POLICY.moduleIdentity`, and the pattern and its JSX are in the policy's
  module, because the brief asked for one file. An edit to the UI changes the
  identity, and a table dealt before the edit is not released after it. The pool
  keeps its policy in a module of its own for this reason
  (`patterns/showcase/inductor/pool/pool-policy.tsx:14`). **Read.**
- **A watcher can try to sit.** Carol, at `READ`, is refused only because the
  deal has happened (`sealed-state-machine-multi-user.test.tsx:264`). Before the
  deal anyone who can send an event can take a seat. The pattern test's access
  list is not enforced by its storage
  (`docs/common/workflows/pattern-testing.md:141`), so nothing here shows what a
  server in `enforce` mode would refuse. **Read.**
- **The first seat is not the owner's by rule.** The owner deals; anyone seated
  plays. The tests seat the owner first by ordering their steps.

## What was not done

- No run with server execution on shows a release.
- No browser run, so nothing shows the UI rendering the released fields, or a
  button click reaching `move` as a trusted gesture.
- No test of a concurrent move by two players.
- The multi-user test's two players and watcher assert the same view at the
  markers they share; nothing compares two principals' display decisions,
  because the display test has one runtime.
- No test that a forged state (written by other code into a table that holds its
  own state) is refused release: the only way a test reaches the state is to
  lend it, and a lent table is already not released (finding 6). The forged
  write itself is refused by `WriteAuthorizedBy`
  (`sealed-state-machine.test.tsx:241`).
