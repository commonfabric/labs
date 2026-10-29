---
status: historical
created: 2026-08-28
archived: 2026-08-28
reason: "Report on a completed pass: seeding the pattern index with curated atoms, gardening its corpus, and giving its publish path a rendering gate."
---

# Seeding and gardening the pattern index, August 2026

A record of one evening's pass over the pattern index feedback loop — the
Firestore-backed catalog of Common Fabric patterns that cf-harness publishes to
and searches. The pass had one goal: make the corpus something composition can
draw on, and make the loop able to tell a working pattern from a broken one.

For how the loop works now, read the live documents:
[`docs/pattern-index-measurement.md`](../../../../runtime/cf-harness/docs/pattern-index-measurement.md)
for how a measurement run is conducted, and the `pattern-index` repository's
`ONBOARDING.md` and `docs/gardening.md` for the index service itself.

## What the corpus looked like going in

29 entries. Two carried a positive quality score; the rest sat at zero or
below. Reading all 29 programs — rather than their metadata — found three
distinct problems.

**About a third were near-duplicates**, because a `pattern-author` child that
iterates published one entry per successful `run_pattern` rather than one per
session: four "Child interactive packing list app test", three grocery
checklists, three doublers, two reading lists, two sortable tables.

**Descriptions did not describe the programs.** Search ranks on description, so
this is the more damaging of the two:

| id | description says | source actually is |
|---|---|---|
| `JUHPJFzz…` | grocery checklist, quantities, remaining counter | a counter button (287 B) |
| `lKwZG1Z5…` | grocery checklist, quantities, remaining count | a doubler button (268 B) |
| `A1nMYjX3…` | reading list: title entry, toggles, finished/unread counts | no UI at all; returns `total` (232 B) |
| `unUSV9vN…`, `6aOfqRGP…`, `POygPwCF…` | "packing list app" | `computed(() => 2)` and `computed(() => items.length)` |
| `smoketest…001` | doubles a number | never imports `pattern`; could not compile |

A model searching "grocery checklist", finding `JUHPJFzz…` and running it gets
a counter — and no rendering check catches that, because the counter renders
perfectly well.

**Both sortable tables rendered every cell as `[object Object]`**, from
`String(row[column])` indexing a reactive row by a reactive key. One ranked
first for its query, and `lcGr-KTV…` imported one of them, so the defect had
already propagated across a composition edge.

## The composition graph, mapped for the first time

Four edges across 29 entries — and two of the four were aliases rather than
composition:

| importer | dependency | kind |
|---|---|---|
| `xZbe3l…` | `FgL8kX…` | bare re-export |
| `sS8nqs…` | `9lNyUb…` | near-alias (quadrupler over doubler) |
| `AgaGn7…` | `fJFEm…` | real composition (three dice plus a total) |
| `lcGr…` | `HOS6wW…` | real composition (expense summary over a sortable table) |

`xZbe3l…` was two lines — `import PackingList from "cf:pattern:FgL8kX…";
export default PackingList;` — re-exporting a fixture that had been thumbed
down, and outranking its own source by three points. Quality signal does not
cross a composition edge in either direction: a negative judgement does not
reach an alias, and a good atom earns nothing from what composes it.

## What the pass changed

**A curated seed.** Six parameterized atoms — Counter, CheckList,
SortableTable, AmountLedger, DiceRoller, OptionPicker — authored fresh in
current idiom and published discoverable. They were chosen against demand read
out of the corpus itself: every shape the 29 entries had rebuilt from scratch.
Two candidates proposed on evidence were cut on a different bar, expense to
rebuild: a component whose whole body is four lines of `computed` will not be
adopted however well evidenced its demand, because rebuilding it is cheaper
than importing it.

The seed was *not* taken from the `MODULE_METADATA` components in
`packages/patterns`. Those are tiered **legacy** in
[`packages/patterns/index.md`](../../../../patterns/index.md) — "a
parallel composition system; do not copy it" — and seeding them would have made
the index's exemplary building blocks a set the repository tells authors not to
imitate.

**Discoverability split from publication.** An entry can now be recorded in
full — `getPattern` answers it, `cf:pattern:` resolves it — while being absent
from search. Publishing and surfacing had been the same act.

**A rendering gate on the publish path.** A second, detached probe instance of
the compiled pattern is built from a synthetic instance of its own
`argumentSchema` and rendered host-side through the same reconciler and
applicator pair a browser mounts. Output carrying a default-`toString` marker
is recorded non-discoverable rather than refused, so nothing is lost and a
wrong call costs a field flip.

Two defects in that generator were invisible to inspection and surfaced only by
running it against the live broken table's real schema: honoring `default: []`
builds a table with no rows, which renders cleanly and passes; and drawing row
keys and column strings from two vocabularies makes every lookup miss, which
renders empty cells and also passes. Both would have shipped a gate that passes
the exact pattern it exists to catch.

**Gardening.** 16 of the 29 entries hidden from discovery, none deleted, each
carrying a stored reason. `getPattern` returns all 16 byte-for-byte unchanged
and all four composition edges still resolve — verified against the deployed
service, including by hiding a dependency while leaving its importer
discoverable and confirming the importer's closure still resolved.

## Corpus after the pass

36 entries: 19 discoverable, 17 withheld. Two `proven`, 17 `unproven` among the
discoverable set. The seeded atoms sit in `unproven` — demoted in ranking,
never excluded, which is the intended treatment of an entry with no evidence
either way.

The total reconciles as 29 entries going in, plus the six seeded atoms, plus
one self-describing row published as `discoverable: false` to exercise the
publish-time discoverability path against the deployed service. The withheld 17
are the 16 gardened entries and that verification row; the discoverable 19 are
the 13 surviving originals and the six seeded.

The query that had returned two `[object Object]` tables:

```
"sortable table rows columns click header to sort"   candidates 36
  7/8  1iaNBnIV…  Renders rows in a table and sorts them when a column header is clicked…
  6/8  wwVyvVWD…  Shows fixed monthly expenses in a polished USD table…
```

## Measurement corrections

Three counts reported during the preceding phase were wrong, all in the same
direction, and none because of a defect in the tooling:

- **"Zero empty searches across the six post-fix runs."** There was one. The
  extraction script printed it (`[child:1] search 'sortable table component
  columns rows' -> 0 hits`, run `cfc6cc76`) and it was lost summing per-run
  totals by eye. The corrected figures: 10 searches, 9 with hits, one empty,
  none refused — against 46 searches, 33 empty and 8 refused across the twelve
  runs of the preceding day. The empty rate fell from roughly 72% to 10%, which
  is the finding; "zero" was not.
- **"Eight refusals"** read as a background rate. All eight belong to one run
  family (`a2e29091`) where the index answered `403: DID is not allowlisted` to
  every query. The index was never consulted, and a total authorization failure
  recorded as an empty corpus.
- **"`read_skill_resource` 20 for 20"** counted calls where the interesting
  number was results: all 20 returned `status: "error"` with
  `skill_registry_missing`. The conclusion it was offered for still holds on
  different evidence — skill registries are present on exactly the 14 post-fix
  run directories, and all 20 failing calls came from runs predating that fix.

A fourth, found by review of the new extractor: `assign_slug` refusals counted
as assignments, so a reported 17 slugs was 13 assigned and 4 refused.

Each of these passed inspection and failed only when someone re-derived it from
the raw data. Each is now pinned by a test.

## What this pass did not establish

- **That any of it makes composition happen.** Seeding made the parts
  findable, gardening made the corpus honest, and the gate made publication
  conditional. None of that makes importing cheaper than writing, which is the
  thing that decides whether a session composes. The strong form of that
  experiment had already been run: a parameterized sortable table, ranked
  first, with its import specifier attached to the search hit, and the session
  rebuilt it from scratch anyway. A later measurement showing better search
  hits and a little more reuse-by-id, with composition still at zero, is that
  same result and not evidence of progress on it.

- **That an entry is what it claims to be.** The rendering gate certifies that
  a pattern produced a non-empty DOM containing no default-`toString` marker,
  for one synthetic instance of its declared argument schema. It cannot
  certify that a program matches its description, and search ranks on
  description.
- **That a person found any of this useful.** Every event the index holds was
  emitted by the harness about its own run. `record_feedback` has never been
  called, so the thumbs weights are inert, and "unproven" means no evidence
  rather than unpopular.
- **Rendering, for eight of the sixteen hidden entries.** They were hidden on a
  structural or rendering claim read from source rather than observed. This is
  disclosed in the index repository's `docs/gardening.md`; nothing was deleted,
  and reversing a wrong call costs one API call.

## The failure this pass kept finding, including in itself

One shape recurred often enough during the pass to be worth stating on its own,
because the corpus defect and the tooling defects turned out to be the same
thing:

> A check that does no work reports the same thing as a check that ran and
> found nothing. Only a case where you already know the answer separates them.

Every instance below passed inspection first, and each was caught by
re-deriving a result from its source rather than by reading the code that
produced it.

- A search that returned `403: DID is not allowlisted` counted as a search that
  returned no results, so a run family that never reached the index at all
  recorded as an empty corpus.
- Twenty `read_skill_resource` calls that all returned
  `skill_registry_missing` were counted as twenty successful reads, which
  inverted the health of the one input surface that was working.
- A composition proof run in the space that already held its dependencies
  returned `materialized: []`: three ids requested, zero fetched, everything
  rendering, nothing exercised.
- The rendering gate tested for `$UI` on an unschema'd read, so twenty of
  twenty-four patterns recorded as "nothing to check" while the run looked like
  a pass. The mechanism is worth stating because it selects: a pattern that
  *declares* its result type — `pattern<Io, Io>` — declares a type that does
  not name `$UI`, and an unschema'd read returns only the declared fields. A
  loosely-declared `pattern<In, object>` permits anything and so read back
  fine. The gate therefore checked exactly the patterns that described
  themselves least well, and skipped the parameterized, self-describing atoms
  the index exists to accumulate. The first regression test written for this
  passed with the fix reverted; seven minimal fixtures failed to reproduce it
  because all seven declared `object`.
- A blanket `catch` in that same gate converted a defect in its own code into
  the gate's ordinary "probe failed" outcome.
- A test asserting only a refusal's header — printed for every refusal — stayed
  green while the code beneath it was failing for an unrelated reason. It was
  written to satisfy a coverage gate, which is the pressure that produces
  exactly this.
- A test named "the fixture is the whole live corpus" passed against a fixture
  that was provably not the whole live corpus. Its body checked non-emptiness,
  duplicate ids, and the presence of particular entries; it never checked
  completeness, and could not check freshness. **A test's name is a claim, and
  nothing checks it.** That is a third shape a gate fails in, beside not
  running and running vacuously: running, passing, and reporting something
  narrower than its own label.
- One reported figure ("no empty searches across six runs") was contradicted by
  the tool's own printed output, and lost in a total summed by eye.
- An instrument answered confidently about a subject nobody had asked it
  about. `gh pr checks --watch` binds to whichever check run exists when it
  starts and does not follow a later push, so it reported success three times
  during this pass for a commit that was not the head — once when the head
  carried a single queued check. The pull-request-level rollup has the same
  property. Neither was lying; both were answering a question that had not been
  asked. Naming the commit in the request (`commits/<sha>/check-runs`) settles
  *which* subject the answer is about, because a request that names a subject
  cannot answer about a different one. It does not settle whether the caller's
  own condition means what the caller thinks: the first replacement written
  against that API inverted its `until` condition and reported a run "settled"
  with fifty checks outstanding — an instrument that named its subject
  correctly and still reported a state it had never checked. Naming the subject
  is necessary and not sufficient. Nor does it settle *how much* of the subject
  was read: that endpoint pages at thirty by default, the pull requests in
  question carried sixty-three checks, and the unqualified request returned
  half — with every conclusion in the missing half reading as absent rather
  than as unread. Comparing the returned count against `total_count` is what
  makes the truncation say so. And a check that has not been *created* is
  likewise indistinguishable from one that passed, if the reader counts only
  what exists: the coverage gate — the one that failed twice during this pass —
  is not created as a check run until the jobs it depends on finish, so a
  waiter that stops when every visible check run is complete declares success
  while the decisive gate has never started. The workflow run is the level at
  which "complete" means complete.

  Comparing `returned` against `total_count` does not close it either, and for
  a reason distinct from paging: the list **materializes progressively**. Early
  in a run the endpoint answers `total=1, returned=1` — one check run existed,
  and the count agrees that one was all there was. The API is not truncating;
  it is answering completely about a state that is not final. Both read as
  "nothing more to see", and only the second survives a completeness check.

  The same joint sits one layer below the reporting API, in any artifact a
  producer writes. **A truncated run's output and a complete run's output are
  the same shape.** A coverage profile from a test run killed by its own
  timeout parses exactly like one from a run that finished, and a reader that
  reports a file absent from such a profile as zero uncovered lines renders
  four unmeasured files as perfectly covered. Anything reading a profile, a
  log, or a page has to establish that the *producer* finished, not merely that
  the output parsed.

  Nor does the workflow level close it by itself: it reports that the runs
  which *exist* have finished, not that every run exists. An empty list of
  workflow runs satisfies "all complete" vacuously, which is exactly the state
  a just-pushed commit is in. What closes it is an
  expected set — naming the gate, and knowing the number of checks a complete
  answer carries — because until then "the coverage gate is absent" and "the
  coverage gate passed" are the same observation.

  These are one failure at different joints, and it is the invariant CT-2100
  established, reappearing in the reporting layer rather than in the code:
  *anything not read must be recorded as not read.* That was written for a cell
  nobody read rendering as a cell with no label. The same sentence covers
  thirty-three checks nobody fetched rendering as thirty-three checks that are
  not there. And it carries the same precondition it did there: **to record
  that something was not read, you have to know what should have been read.**
  CT-2100's label reader had to be told its bound before a miss could be
  marked; a check-run reader has to be told the gate's name before an absence
  can be distinguished from a pass.
- The sandbox transport guard checked that two directories were *named* in a
  runtime's configuration, never that the runtime read them, and then reported
  `invocationContextTransport: "sidecar"` into the run's policy snapshot on the
  strength of that name. A test asserted the same claim from a bare
  configuration with no runtime present, so the behavior was pinned rather than
  merely unnoticed.

The seeded atoms mattered here beyond the corpus. The rendering gate's
`no-ui` result had an alibi: the pre-existing corpus genuinely is full of
entries with no meaningful UI, so "nothing to check" was a plausible reading of
real data. A set of entries whose UI is known to work removed that alibi. The
same is true of the composition proof: only a space known not to hold the
dependencies could distinguish a fetch that succeeded from a fetch that never
ran.

Two rules generalize the list, and both were arrived at only after the
instances had accumulated.

**When a tool summarizes, ask what population it summarized over.** Every
instrument failure above is one answer to that question going unasked. The
watcher: *which run*. The page: *how many rows*. The check-run list: *which
checks existed yet*. `--detailed` against `--lcov`: *which lines, under which
reader*. A review tool's check conclusion: *whether it finished*, not what it
found. A package-scoped linter: *which configuration*. None of them was wrong
about its own population; each was asked a question about a different one.

**Whether an absence is evidence depends on whether the thing would
necessarily have been present.** A configuration flag that is missing would
have been written if it applied, so its absence is positive evidence and
justifies refusing. A rendered `[object Object]` that is missing proves
nothing, because a pattern with no text renders none either — so its absence is
recorded uncertified rather than treated as a pass. The same distinction
settles a missing check run (absent because not yet created — unknown) against
a missing runtime argument (absent because nothing registered it — known).

A third rule follows from the second, and it decides what to *do* about an
unexercised branch. **"This cannot be reached" and "this cannot be reached by
anything I can construct" are different claims, and only the first justifies
deletion.** Several branches were removed during this pass on the strong claim,
each demonstrated from the call path: a guard the caller's own validation made
unreachable, a fallback the constructor made unreachable, a publish path the
engine made unreachable. One resisted. Five malformed `$UI` shapes — a
non-node child, an invalid tag, a non-object style, a cyclic tree, a bare
string — all rendered with zero errors, so the arm reading those errors was a
verdict drawn from a channel nobody had seen fire.

The remedy for the weaker claim is not deletion but a **seam that makes the
claim checkable**, plus a written record of what was tried, so the next person
holding a case that does error knows what did not. Deleting on the weaker claim
would be the same error as accepting a coverage marker: disposing of an unknown
by asserting it.

The practical rule this leaves: when a check reports an absence, establish that
the check would have reported a presence. That takes a case whose answer is
known independently, which is a different and more expensive thing than a test
that passes.

Where that independent case comes from is the operational half, and it is the
harder half: **re-derive from a source that cannot inherit the mistake.** A
system agreeing with itself is not evidence. Every real catch in this pass came
from stepping outside whatever produced the claim — running the test suite
outside the sandbox that was failing it, composing into a space that could not
already hold the dependencies, reverting a fix to watch its test fail, reading
a clock from a remote server's response header rather than from the machine
that had been reporting the time. Two parties agreeing is not independence
either, when one of them told the other.

The outside sources were all of different kinds, and that is worth stating
because the practice compresses badly. A control is constructed; a clock came
from a machine with no stake in the answer; a fresh clone came from the remote
rather than from the working tree that had drifted; a mutation came from
deliberately breaking something believed to be right; a positive control came
from a case whose answer was known in advance. Compressed to "add a control",
this gets applied wherever a control is cheap and skipped wherever the outside
source has to be found. The question that generalizes is the harder one:
**what could confirm this that does not share my error** — and the answer is
sometimes a remote server, sometimes another person, sometimes a build broken
on purpose.

None of this was derivable from inside any one line of work. Four of the
instrument failures above occurred in a single stream of it, and from inside
that stream they read as carelessness rather than as a shape — the same four,
agreeing with each other, were not evidence of anything. It became a method
only when the shape reappeared in work that could not have inherited it. **A
single source cannot distinguish a pattern from a habit**, which is this
section's own proposition applied to the reading of one's own mistakes.

The inverse failure is equally available, and this section should not be read
as licence for it: four instances agreeing in one stream can also be a habit
promoted to a method, after which outside confirmation is easy to find, because
a pattern stated broadly enough matches nearly anything. The count is not what
settles it. The question is the same one — what could tell me this is a pattern
that does not share my error — turned on a conclusion rather than on a
measurement.

Its companion, arrived at the hard way: **a regression test that has not been
seen to fail is not evidence.** The `no-ui` fix above shipped first with a
mechanism asserted rather than measured, and with a test that still passed when
the fix was reverted. Neither error was visible on its own — a plausible
mechanism and a green test agree with each other — and reverting the fix to
watch the test fail is what separated them. Every real defect in this pass was
invisible to reading and immediate to running.

## Conditions worth knowing about the environment of this pass

- The local toolshed serving `:8000` was running a commit that is not an
  ancestor of `main`, from a different working tree, having been started the
  previous day. A live `computed:` entity-id error against it was cleared as an
  environment fault only by standing up a matched server and reproducing there.
- A toolshed reporting `cfcFlowLabels: "off"` over `/api/meta` is not a
  misconfiguration: that is the core default, and `MAX_ENFORCEMENT_CFC_OPTIONS`
  is applied by the `remoteClient` and `browserWorker` presets — which is what
  cf-harness's fabric session uses. The console's posture line describes its own
  runtime; `/api/meta` describes the server's. Two presets, not a contradiction.
- Across 44 console runs, all 38 `bash` calls were denied for want of trusted
  CFC mediation metadata, and `read_file` never once returned a file. A child's
  read-and-inspect fallback was unavailable for the whole corpus.
- The `pattern-index` repository has no continuous integration. Nothing runs on
  a pull request or on merge there.

## Open work

CT-2107 (an entry is not certified to be what it claims), CT-2109 (no signal
that a person opened a pattern), CT-2114 (quality signal does not cross a
composition edge), CT-2115 (what earns discoverability, and what search should
answer when a query matches only withheld entries), CT-2116 (invocation-context
files written and never read, so input labels were dropped while enforcement
was reported), and CT-2105 (bash observation denials).
