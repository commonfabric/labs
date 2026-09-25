# Pattern update testing

Two CI gates stand between an incompatible pattern and every piece running it.
This document specifies what each one proves, what it deliberately does not,
and what an author does to participate.

## Why the gates exist

The automatic pattern updater performs **no structural check at all**. `cf
piece setsrc` refuses an incompatible replacement by calling
`assertPatternSchemasBackwardCompatible`, but the automatic path compiles the
new source, verifies the entry identity, and applies it. So CI is the only
thing standing between an incompatible pattern and a running piece, and a bad
update does not throw — it leaves a piece that can no longer materialize.

The two gates guard different halves of the same risk:

| | Gate | CI job | What it proves |
| --- | --- | --- | --- |
| Tier 1 | `deno task pattern-compat` | Pattern Update Compatibility | The **contract** a pattern declares can still be applied over every contract it has declared before |
| Tier 2 | `deno task pattern-vintage` | Pattern Update State and Baseline Integrity | A real **document** written by an older version is still readable, and its data survives |

Tier 1 is a statement about schemas. Tier 2 proves the stronger thing schemas
cannot say. Neither subsumes the other: a contract can stay compatible while
the data goes unreachable, and a fixture can only cover patterns some test
actually instantiates.

## Tier 1 — contract compatibility

Compiles **every** authored pattern under `packages/patterns/`, derives its
argument and result schemas, and proves the current contract can be applied
over every contract recorded for it under `packages/patterns/baselines/`.
There is no opt-in: a pattern is covered by existing.

Baselines are **append-only**, enforced mechanically by
`tasks/check-baselines-append-only.ts` in the Pattern Update State and Baseline
Integrity job. An author-run `--update` that could remove a baseline could
remove the very one that would have caught a break. A break the repository
decides to ship is declared instead, in `tasks/pattern-compat-accepted-breaks.ts`
— see the finding it answers below.

### Findings and their remedies

- **`contract <hash> is not recorded`** — the pattern's contract changed and
  the new one has no baseline. Run `deno task pattern-compat --update` and
  commit the recorded baseline. Routine.
- **`cannot be applied over baseline <label>`** — the change would break
  pieces running an older version. This **cannot be recorded away**:
  `--update` records only when "not recorded" is the *sole* finding, so an
  incompatible contract is never written to a baseline. The remedy is to
  change the pattern, usually by giving a new required field a `Default<>`.

  This is deliberate. An incompatible contract cannot merge, so it never
  ships; recording it would force a later corrected contract to prove itself
  against a version that only ever existed in a failed CI run, with no way to
  remove it.

  The exception is a break the repository decides to ship: a surface removed on
  purpose, its held state an accepted casualty. No pattern change satisfies the
  check then, because the check is measuring the decision. That case is written
  down in `tasks/pattern-compat-accepted-breaks.ts`, and only there — deleting
  the offending baselines is the laundering the append-only gate exists to
  stop.

  An entry is bounded twice. It forgives specific `(pattern, baseline)` pairs,
  so the contract recorded once the break ships is a baseline no entry names
  and the next change to that pattern is gated again. Within a pair it forgives
  only the schema paths it names: one finding carries every issue the proof
  found against that baseline, so accepting by pair alone would suppress an
  unintended break landing beside the decided one — and `--update` would then
  record that contract. A finding blaming any unnamed path stands, and so does
  one whose paths cannot be parsed. What the proof reports is at most one issue
  per role, so a second problem in a role whose issue is an accepted path can
  still hide behind it; name as few paths as the removal needs.

  An entry also names its decision record under `docs/history/` (`record`),
  and may not name a required pattern — the home and default-app roots update
  aggressively and unconditionally, so a break there is never accepted. Both
  are enforced whenever either gate runs
  (`tasks/pattern-break-registry-guards.ts`).

  The run prints every pair it forgave, and fails on one that no longer needs
  forgiving, so the list can only shrink. That audit is asked per pattern rather
  than of the whole list, because the CI job always sets `PATTERN_COMPAT_SHARD`
  — the shard that examined a pattern is the one that can judge its entries,
  and the shards between them cover all of them. An entry whose pattern file
  no longer exists keeps that pattern among the ones the gate divides between
  its runs, and the run given the pattern fails on the entry.

  Reaching for any of this is a decision to strand data on running pieces; a
  break that also strands state needs the Tier 2 entry below.
- **`<role> schema is not valid on its own terms`** — the schema fails
  definition validation independently of any baseline.
- **`has N baseline(s) but yields no contract now`** — a file that used to be
  a pattern no longer exports one. Every piece tracking that path is pinned to
  its current pattern **forever**: the updater's identity probe fails and
  nothing surfaces on the piece. Restore the pattern, or delete its baseline
  directory to record the retirement deliberately. A pattern whose file is
  gone is still one of the patterns the gate divides between its runs, for as
  long as its baselines remain, so `--only` names it as it would any other.
- **`newly fails to evaluate`** — a pattern that cannot evaluate gets no
  contract, so no baseline, so no check, forever. Fix it, or add it to
  `tasks/pattern-compat-unevaluable.ts` with a reason. That allowlist can only
  shrink: a listed pattern that evaluates again must leave the list, or its
  exemption outlives the breakage it was granted for. It may never name a
  required pattern, and the gate refuses one that does: listing a root is a
  wider exemption than any accepted break — not one finding forgiven but the
  pattern not gated at all — and the roots that update aggressively and
  unconditionally are the ones that can least afford it. For those, fixing
  the pattern is the only move.

An already-recorded contract is not re-validated. It was proved when recorded
and has not changed since, and both the definition validator and the subset
proof blow up combinatorially on some real schemas — so the steady state, where
no contract changed, costs nothing beyond the compile.

Compatibility is directional by role. Existing invocations must still satisfy
the candidate argument schema, so a newly required argument needs a default or
must be optional. A newly required result does not need a schema default: the
candidate pattern generates it during setup. This admits the forward migration;
add a result default as well when an older concurrently running generation must
still be able to write its previous result shape.

Cell wrappers (`asCell`), storage scopes (`scope`), and the write markers
(`readOnly`, `writeOnly`) are default-stable: they say how a value is
delivered, stored, or written, not what shape it has, so a default beneath one
may be introduced or changed under the same rules as beneath a plain object
node. That covers an empty-object default on a record reached through a
`$ref`, a default that changes value on an unchanged cell, a verb's event
below its stream marker (a newly required event field is rescued by a valid
default the candidate carries, including a newly introduced one), and a
durable-link proof whose target declares a default below a cell. The metadata
itself must still compare equal across an update: a changed `asCell`, `scope`,
`readOnly`, or `writeOnly` is refused on its own. Value constraints that
default insertion can invalidate, such as `maxProperties`, continue to require
equal defaults beneath them.

`ifc` is the one semantic extension deliberately not on that list: a label is
policy the write-authority comparison reasons about, and whether a materialized
default satisfies a labeled node's floor is that comparison's question, so a
changed default beneath an `ifc` stays refused until it is decided there.

A verb's event follows argument compatibility rules even when declared in a
result. A caller supplies the event, so it does not receive the result-side
exemption for newly required fields that a pattern generates itself. A field
the candidate event newly requires therefore needs a valid default, exactly
as an argument does. Dispatch fills missing fields in a present event object
from defaults; an entirely absent event payload remains absent.

## Tier 2 — state continuity

Replays committed SQLite stores — real state, written through a pattern's own
handlers by running its own tests — under today's pattern source.

### What a green run asserts

Per fixture:

- the vintage **restored**: its manifest contains the identity the filename
  records, checked before anything is applied;
- today's source **resolves and compiles** for every recorded instantiation;
- the fixture actually **holds** each recorded root, checked per target before
  anything is applied to it;
- the setup commit carrying the artifact onto that root is **not refused** and
  completes — for every AUTHORED target. A transformer-derived hoist (a mapped
  row's anonymous sub-pattern, `__cfPattern_N`) whose STORED ARGUMENTS today's
  schema refuses is held back and reported instead of failing: a hoist's
  arguments are the captures of a derivation the updated source re-runs and
  re-supplies wholesale, and the real update channel validates only the root
  contract, so a capture that drifted is not a stranded piece. A hoist today's
  source no longer even defines is the same supersession — hoist ids are
  builder node ids, renumbered by ordinary edits — and is held back the same
  way. Only those two refusal shapes are held back, for hoists only: any other
  error on a hoist fails, an authored export that disappeared fails as the
  retirement it is, and a hoist that applies is compared like everything else,
  which is what keeps a row-allocated cell's cause-stability (the
  moved-`.for()` class) gated. Telling the two apart is spelling, and spelling
  is decisive because the namespace is reserved: the runner refuses a module
  that exports a builder artifact named `__cfPattern_<n>`, so a recorded
  instantiation with that shape can only be the compiler's own
  (`docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md` §11.3);
- the root then **reads as something** rather than nothing;
- every value the vintage held is **still readable** afterwards.

The restore and per-root controls are not ceremony. An empty or truncated
store presents as a fresh space, today's source materializes onto a fresh space
happily, and without those controls every remaining check passes while nothing
has been replayed. A root can also be absent while the fixture is otherwise
good — recorded in a space that did not travel, in a companion store that
restored empty, or at a cell id nothing ever wrote.

Across the run, `isClean` additionally requires a positive number of fixtures
replayed, a positive number of candidates, and a positive number of upgrade
targets. A run that examined nothing is a failure, not a pass. A `beforeunload`
guard turns "the process ended without reaching a verdict" into exit 1 — a
pattern that does not compile and a corrupt fixture both reject a promise
nobody awaits while the promise the replay awaits never settles.

### The class this catches that Tier 1 cannot

Move where a field is stored — `.for("journal")` becomes `.for("journalMoved")`
— and the declared contract does not change by a byte, while every document
written under the old name goes unreachable. Nothing throws. Measured on the
real `home.tsx`, that exits 1 naming the key and showing what was there.

Emptiness is judged **per leaf at any depth**, so partial loss counts: two of
three rows disappearing is a finding, not a warning. Judged only at the top, a
`.for()` list would fail solely when it emptied entirely.

### What it compares, and what it excludes

The comparison reads the vintage under the root's **own stored schema**, so it
sees the data as the version that wrote it did, and compares only keys that
were present before. An update may legitimately add a generated result field,
and the candidate setup materializes it during replay; arguments and ordinary
durable document fields still need defaults when existing state must supply a
newly required value.

That schema is relaxed at its `unknown` positions first, on both sides: a
schema-driven read resolves nothing there, so a key an index signature covers
would otherwise arrive as `undefined` however much state it holds,
indistinguishable from a key the document does not hold.

It compares **state, not renderings**. `$UI` and its variants are recomputed by
the setup and a stored rendering never matches a fresh one, so comparing them
would red every pattern edit while saying nothing about data. Every other key
is compared, `$NAME` included. Excluding those names is not sufficient on its
own — a `map`-body hoist is a recorded instantiation whose whole result is a
vnode under no `$UI` — so a rendering is also recognized by shape, wherever it
sits.

What a root holds at a cell or stream position is compared as the **document it
points at**, so a field that moved to a different document is still a finding.

State a pattern **stopped holding on purpose** is taken off both sides before
the comparison, from the entry for that pattern in
`tasks/pattern-vintage-accepted-drops.ts`. It is the Tier 2 half of an accepted
break, and reaches here only after Tier 1 has accepted the contract change:
where the surface is gone, no pattern change makes the vintage readable, so the
comparison would otherwise measure the decision itself.

An entry names **paths**, not fixtures and not bare field names.
`crossrefs` forgives the root key of that name; `topics[].crossrefs` forgives it
on each element of the `topics` list. A same-named field anywhere else is
compared exactly as before, so a removal that also strands a body or a timestamp
still fails. Nothing off the path to a drop is rebuilt either — a subtree that
lost nothing is returned as itself, and a reduction (`{"[cell]": …}` and its
kin) is never opened, because it stands for something the comparison must weigh
whole.

An entry names its decision record the same way Tier 1's does (`record`), and
the required-pattern refusal applies here identically.

The run prints every path it held back, and fails on one that no vintage needed,
so this list can only shrink too. A pattern no fixture records is reported
separately: nothing replayed could have needed its entry, so the run has no
evidence either way, and an exemption nothing can audit is one nobody can
retire.

### Corrections of stale derived state

An approved correction of calculated state is recorded separately in
`tasks/pattern-vintage-derived-corrections.ts`. Its scope includes the exact
fixture provenance and SHA-256, absence of companion stores, recorded root and
pattern identities, field, and before/after values. Different fixture bytes or
additional stores receive no correction policy.

The comparison still runs on all fields. Only an exact approved transition is
graded as a reported change instead of a loss; a missing field, nested loss, or
other transition retains its ordinary grade. The run prints each correction and
its decision record. A verified fixture whose correction is unused fails, so
an exemption must be removed or reassessed when the evidence changes.

The [derived-state correction decision](../history/development/2026-09-14-derived-state-correction.md)
records the approved case and alternatives. This policy does not classify
derived values generally as expendable.

### Findings are graded

A replay recomputes as well as reads, so a derived value the vintage never
pulled on can resolve to something better this time. A value that merely
**changed** is reported with `console.warn` and does not fail; a non-empty
value that went **empty** does fail.

The limit this buys, pinned by name in `tasks/pattern-vintage-run.test.ts`: a
moved `.for()` key whose new slot the pattern *seeds* reads back non-empty and
only warns. The same move into a slot that stays empty fails. Weighting a key
by whether it is backed by an `of:` document rather than a `computed:` one is
the candidate for closing that gap.

## Fixture layout

```
packages/piece/test/vintages/<test key>/<tier>/<iso>-<identity>.sqlite
packages/piece/test/vintages/<test key>/<tier>/<iso>-<identity>.sqlite.spaces/<did>.sqlite
```

- **`<test key>`** is the path under `packages/patterns/` of the **test** that
  produced the fixture. Keyed by test rather than by pattern because a test
  need not be named after what it drives, and one fixture routinely covers
  several patterns.
- **`<identity>`** is provenance, not an address: it records which version
  wrote the state. Nothing looks a fixture up by it — the replay enumerates the
  directory and replays everything it finds. A gate that selected fixtures by
  identity would silently cover nothing the moment naming drifted; enumeration
  cannot.
- **`<iso>`** is a capture timestamp, with `:` substituted so the name is legal
  on Windows and still sorts chronologically. Retention sorts on this field.
- The **`.sqlite.spaces/`** directory carries the run's other spaces. A capture
  that instantiates a pattern via `Factory.inSpace(...)` writes a second store,
  and a fixture holding only the first would record roots whose state it does
  not have. It is part of the fixture, not a fixture itself, so
  `parseVintagePath` declines everything inside one.

The tree is deliberately **not** under `packages/patterns/`.
`tasks/build-binaries.ts` passes that whole directory to `deno compile
--include`, which is recursive over non-source files, so fixtures would ship
inside the toolshed binary; and `PatternsServer` serves the same directory by
path, so they would be fetchable from any deployment.

Fixtures are stored **raw**, not compressed. A store is mostly slack and gzips
15–48x, so pre-compressing looks free — but it defeats git's *delta*
compression, which is the mechanism that makes accumulating vintages cheap. Two
raw captures of `home.tsx` cost 232.86 KiB packed against 232.50 KiB for one; two
gzipped ones cost between +21 KiB and the entire second file depending on the
compression level.

### The two tiers

- **`pinned/`** — never pruned, and the only tier that credits coverage.
- **`auto/`** — generations captured automatically, pruned to the newest
  `AUTO_GENERATIONS_KEPT` (4) per test key.

An auto generation credits no coverage by design: it is regenerable and pruned
by count, so letting one satisfy the coverage requirement would let retention
delete a pattern's only evidence while the gate still read green.

Accumulating generations is what makes the gate get *stronger* over time rather
than merely staying green. One pinned vintage proves today's source can read
one old world; a run of generations proves it can read every world the pattern
has passed through. That is affordable because git deltas adjacent generations
to roughly 9 KiB, while each costs a few MB of working-tree disk in every
clone — which is what the retention bound exists for. It bounds **checkouts**,
not history.

## Commands

```
deno task pattern-vintage                                  # replay every fixture (what CI runs)
deno task pattern-vintage --update topics/topics.test.tsx  # capture a first pinned fixture
deno task pattern-vintage --capture-changed                # capture a generation where due
deno task pattern-vintage --pin topics/topics.test.tsx     # promote the newest generation
```

`--update` and `--pin` name a **test** path, never a pattern path: a fixture is
produced by running a test and covers whatever that test instantiates.
`system/home.tsx` names no test and captures nothing.

There is no bare `--update` and no list of what CI replays. Every fixture under
the vintages tree is replayed by the plain command, so committing a captured
fixture is the whole of adding one. A default seed set would only ever serve a
*missing* fixture, which is exactly when nothing on disk knows which test covers
the pattern.

`--capture-changed` captures for every test key whose fixtures have all fallen
behind today's source. The trigger needs no new measurement: the replay already
computes `changed` per target, so a fixture replaying with `changed === 0` **is**
the current generation, and once no fixture for a key reports zero the next is
due. A fixture with no targets proved nothing and a failed fixture is the gate's
own red, so neither counts as evidence of currency.

Unrecognized flags are rejected. An unknown flag matches no command, so the run
would otherwise fall through to the plain gate, replay everything and exit 0 —
reporting the tree healthy to someone who asked for something else.

**No writing command runs in CI**, and there are three of them: `--update`
captures a first pinned fixture, `--capture-changed` captures a generation, and
`--pin` promotes one. CI runs only the plain gate, which reads the tree and
never writes to it. All three land fixtures in the working tree to be committed
and reviewed like any other change; a gate that wrote its own evidence would be
grading its own homework.

## Invariants

- **A test pattern creates stores; it is never an upgrade target.** The replay
  path refuses a program whose entry resolves to a `*.test.tsx`. A
  test-populated store puts the *test* pattern at the top with the pattern
  under test as a nested instance, so applying the test pattern makes the gate
  weaker. Enforced mechanically rather than by comment, with its own case in
  `tasks/pattern-vintage-run.test.ts`: prose was already the plan's wording
  when the shortcut got taken anyway.
- **Capture only ever adds.** No command overwrites or deletes an existing
  fixture, in either tier. Deleting one is a deliberate act visible in a diff.
  Unlike Tier 1's baselines there is no mechanical checker here, so this rests
  on the commands' refusal plus review — a deliberate choice to operate on
  trust.
- **Retention cannot reach a pinned vintage.** `autoGenerationsToPrune` filters
  the tier *before* it sorts or slices, so no ordering of the later steps can
  name a pinned fixture, and `removeVintages` refuses one again at the point of
  deletion. A deep vintage cannot be recaptured — the pattern that wrote it no
  longer exists in runnable form — and a pruner is invoked by people doing
  something else.
- **Promotion never overwrites.** `git mv` refuses a destination file that
  exists, but moves a *directory* into an existing directory of the same name
  rather than refusing, so both the primary file and the companion directory
  are checked. The check is conditional on there being a source companion,
  which is what lets a re-run of `--pin` finish an interrupted promotion.
- **Each capture gets a fresh store.** Vintages are independent snapshots of
  one version's world, never one database migrated forward: a carried-forward
  lineage would already be shaped by every migration since, and would no longer
  be state written by a version that knew nothing about today's.
- **Required patterns come from the runtime's own constants.**
  `HOME_PATTERN_SOURCE` and `DEFAULT_APP_PATTERN_SOURCE` derive the set CI
  insists on, so the gate cannot drift from what actually auto-updates. A
  constant that stops deriving a key stops the run rather than emptying the
  requirement.

## Adding a pattern to Tier 2

```
deno task pattern-vintage --update <path to the test that drives it>
```

Commit the `.sqlite` file it writes. Capture refuses if the test fails — the
fixture would record a state the pattern never legitimately reaches — or if the
run made no assertions, since the fixture would hold no state. It also refuses
a run that instantiated no upgradable pattern, or one whose roots cannot be
mapped back to a file, because a capture the gate accepts must be a replay it
accepts.

## Adopting an externally captured fixture

`--update` compiles the old pattern with the **current** in-process toolchain,
so it structurally cannot capture the class that has actually broken production:
a stored source the current toolchain no longer compiles. For that, the capture
runs out of process — in a git worktree checked out at the old revision, under
that revision's own pinned Deno, compiler, runner and memory stack — and the
current tree **adopts** the resulting store:

```
deno run -A tasks/vintage-adopt.ts <snapshot.sqlite> <identity> <test key> <main> [cause] [--child=<cellId>=<main>]...
```

The snapshot file is the interchange format; reopening it in the current tree
runs the memory migration chain, exactly as reopening a real old space does.
The adopter derives the recorded root from its capture cause rather than
trusting the old tree's id formatting — cause-derived entity ids are stable
across revisions, and a mismatch here fails the adopt rather than producing a
fixture whose manifest addresses nothing. It then writes the in-store manifest
and emits a normal pinned fixture.

Record the sub-pattern roots too, via `--child`. A manifest holding only the
entry root leaves every child outside the gate's presence and state controls —
and for a pattern like home, the children ARE the state whose survival is in
question. A child's id is position-derived rather than cause-derived, so it
cannot be re-derived at adopt time: enumerate the snapshot's
`patternIdentity`-carrying cells (a SQL query over `head`/`revision` suffices)
and hand each one's id and source path to `--child`; the identity and symbol
come from the child's own stored marker.

Two accommodations exist for adopted fixtures, both in the harness:

- **Presence accepts either marker.** The per-root control looks for
  `patternSetupIdentity`, which postdates the stores this route exists to
  capture; a root stamped only with `patternIdentity` also counts. The older
  marker is a weaker claim, but for "was something really captured here" either
  stamp is evidence only a runner writes.
- **The restore control is stamped at adopt time.** A native capture pins the
  test run's result at the vintage-root cause; an adopted fixture has no test
  run, so the adopter writes a marker doc at the same cause. It travels in the
  same file, so its presence after restore proves restoration the same way.

The capture side is deliberately not a committed script: it compiles only
against the old revision's APIs, so it is written per capture from the
procedure in the history record for the first one
(`../history/two-toolchain-vintage-rehearsal.md`). An adopted fixture is
identity-compared like any repo-path target — it is not the served-route
accounting case, which materializes unconditionally and is counted apart from
`changed` — so it counts as *changed* and materializes on every run for as
long as its recorded identity differs from today's, which for a
filesystem-resolved old-toolchain capture is every run in practice. That
standing count is the cost of a fixture that exercises the load path nothing
regenerable can reach.

## Limits

Named rather than implied, because a gate's uncovered edges are part of its
specification:

- **Migration coverage is not built.** When a memory-engine schema change
  lands, the affected captures should be *promoted* to pinned rather than
  recaptured — a dump regenerated after a migration proves nothing, since the
  pre-migration state is the artifact. The selection rule differs from
  everything else here: the trigger is a memory change rather than a pattern
  change, and it wants breadth across *shapes* rather than depth per pattern.
- **A changed value only warns.** See "Findings are graded" above.
- **Fixture rot is real, measured, and survivable in replay — but only
  there.** The by-identity load falls back to recompiling the stored source
  closure on a compile-cache miss, which reintroduces "old source must still
  compile under today's API". The adopted 2026-06-18 `home.tsx` fixture
  demonstrates the failure live: during its replay the runtime attempts to
  load the vintage's child patterns from their stored closures and fails
  (`pattern-load-error`), then heals because the updated root re-instantiates
  children from today's compiled program. The gate stays green through those
  load failures — it has no eyes on them — so a path that *depends* on such a
  load succeeding is outside what a green run asserts. Two consequences worth
  naming: the replay runtime opens no piece, so nothing follows an origin
  during it (CFC enforcement stays at its `enforce-strict` default), and the
  heal above is the parent re-creating children, not the production
  roll-forward repair — that path has its own assertion in
  `packages/runner/test/pattern-pointer-unloadable-swap.test.ts`;
  and what an adopted fixture pins is old *source*, not old *storage format* —
  the memory migration chain runs once at adopt time, so the committed file
  already carries today's schema and CI does not re-exercise the migrations.
- **The open-argument residual.** The class is validated on every update route,
  but a root carrying no `patternSetupIdentity` marker at all still skips the
  re-stage, because absence cannot be told from a pending update. The window is
  one setup wide per root; closing it means deciding what a root with no marker
  and an unreadable argument should do at boot.
- **Cross-space fixtures are synthetic.** Every committed fixture is
  single-space. `tasks/pattern-vintage-run.test.ts` is the whole of the
  coverage for companion stores, and deliberately so: it can break a child on
  purpose, which a pinned fixture cannot.
- **Restore exercises the migration chain.** `snapshotSpaceStore` runs no
  migrations, but reopening an old store does. That is a feature — evidence
  that memory migrations preserve old spaces — but it means a red fixture can
  be a migration bug rather than a pattern bug. Worth knowing when triaging.

## References

- [`pattern-imports/pattern-updates.md`](pattern-imports/pattern-updates.md) —
  the updater these gates guard, and the section requiring this work
- [`../development/space-clone-rehearsal.md`](../development/space-clone-rehearsal.md)
  — rehearsing a pattern update against a clone of a real space
- [`../history/plans/pattern-update-state-continuity.md`](../history/plans/pattern-update-state-continuity.md)
  — the executed plan: the measurements that decided this design, including the
  ones that reversed it
