# Measuring the pattern index loop

How to measure whether the pattern index is doing its job, in a way that a run
next week can be compared against a run tonight.

The loop under measurement: a console session builds something, publishes it to
the index, and a later session finds and composes it by naming its identifier.
`search_patterns` answers with a description, shapes and an import specifier and
never with source, so a composing session works from what a pattern is for
rather than from what it says.

That last property is the tools' to hold, not this document's to assert, and the
boundary it holds is the **tool result**. A run's artifact directory is a
different question: the file tools reserve it, `bash` does not, and `bash`
stdout is model-facing, so anything written beside a run is reachable from
inside it (CT-2117). What this measurement can say is narrower and checkable —
across the phase-2 corpus, no artifact of a run that ran a published pattern by
identifier held that pattern's source.

The question this protocol answers is narrower still, and worth stating exactly
— **does a session that was never told the index exists find a published part
and wire it in?** Everything below exists to keep that question answerable.

## The rule the whole thing rests on

**A task must not mention the pattern index.**

Not "search the index for a counter", not "reuse an existing pattern if there is
one", not "check what's already published". A task worded that way measures
whether the model follows an instruction, which is not in doubt and is not
interesting. A run that was told to search and then searched has established
nothing about discovery.

The finding this instrument exists to produce is spontaneous reuse: a session
given an ordinary request, holding tools it was not pointed at, that reaches for
a published part because reaching for it was the cheapest way to answer. That
finding means something only because the session was never told.

The same rule reaches further than the word "index". A task must not name a
published pattern, describe one closely enough to be quoting it, or use the word
"reuse". Ask for the thing a person would ask for.

Keep task text verbatim in the batch record so instructed composition remains
distinguishable from ordinary discovery. Identify each run by the console's
returned session and turn ids; the console uses its turn id as the root run id.
Repeated task text and host context messages do not change that identity.

There is a second kind of run that is worth doing and must never be filed
alongside the first: telling a session explicitly to import a named pattern.
That measures whether composition _can_ happen — whether the mechanism works at
all — and it is how the "can, but won't" reading was arrived at. Run it when the
mechanism is in doubt. Record it as its own batch, labeled as instructed, and
never merge its numbers into a discovery batch's.

## What a comparable run is

Six things have to match for two batches to be compared, and a batch report
records every one of them: the tasks verbatim, the index readings either side,
the model, the CFC posture the sessions ran under, the skills tree the runs
scanned, and what the fabric server reported it was running. A reading that
could not be taken is named as not taken rather than left out.

1. **The tasks, worded identically.** The standing suite is
   [`scripts/pattern-index-suite.json`](../scripts/pattern-index-suite.json).
   Its `notes` field carries the same rule this document does. Adding a task
   leaves the earlier tasks comparable; rewording one does not, so add rather
   than reword.
2. **A fresh session per task, one task at a time.** A session that has already
   searched is not a session discovering. Running one at a time is also what
   makes an index change attributable to the task that caused it — two sessions
   publishing concurrently leave a diff nobody can split.
3. **The index state going in.** The report records what `listPatterns` returned
   before the first task and after the last, the difference between them, and
   how much of it was findable rather than merely recorded. A batch against a
   29-entry index of near-duplicates and a batch against a seeded, gardened
   corpus are different experiments with the same tasks — and the corpus does
   change between batches, by seeding, archiving and rescoring. A comparison
   across two batches whose index readings differ has to say so, or the
   difference reads as an effect of the harness alone.
4. **The console's CFC posture and its skills root.** Every turn scans the
   skills root before its first model call and records what it found in the
   run's own `skill-registry.json`, which the report reads — for the whole run
   family, not the parent alone. A `delegate_task` child is where authoring
   happens, so a parent that scanned a root while its children did not is the
   shape that matters, and `read_skill_resource` answers nothing in a run with
   no registry.
5. **The model.** `--model` or `CF_HARNESS_MODEL`.
6. **The fabric server the console talks to.** Read from its `/api/meta` and
   recorded whole; see [below](#the-server-the-runs-ran-against).

## Running a batch

Start the console with an index configured, from `packages/cf-harness`:

```sh
CF_HARNESS_CONSOLE_PORT=8103 \
CF_HARNESS_FABRIC_API_URL=http://localhost:8000 \
CF_HARNESS_FABRIC_IDENTITY="$HOME/.cf/my-key.pkcs8" \
CF_HARNESS_FABRIC_SPACE=pattern-index-demo \
CF_HARNESS_PATTERN_INDEX_URL=https://index.example \
deno task console
```

[The console README](../console/README.md) covers the rest of its prerequisites
— a local toolshed, a running Docker daemon, a connected model provider, and a
space named by name rather than by `did:key`.

Then, in another shell, run the suite:

```sh
CF_HARNESS_PATTERN_INDEX_URL=https://index.example \
deno task measure-batch scripts/pattern-index-suite.json \
  --console=http://127.0.0.1:8103 \
  --fabric-api-url=http://localhost:8000 \
  --out=.cf-harness-console/measurements/tonight
```

`--fabric-api-url` names the server whose `/api/meta` the report records; it
defaults to `CF_HARNESS_FABRIC_API_URL`, then to `http://localhost:8000`. Point
it at the same server the console was started against, or the report describes a
machine the runs never touched. Add `--expect-git-sha=<sha>` to refuse the batch
unless that server reports the commit you meant to measure. `--base` defaults to
`origin/main`, the remote-tracking ref in the local clone. Run
`git fetch origin` to refresh it before a measurement, or pass `--base=<ref>` to
select another base. A commit known to be off that base also refuses by default.
`--allow-diverged` is the explicit opt-out for a batch that intentionally
measures such a server; a commit that cannot be checked remains a non-fatal
`unchecked` reading.

`--cell-spec=<file>` states what this experiment requires of the console, and
refuses the whole batch before the first task when the console is something
else. See [The cell spec](#the-cell-spec).

The runner asks `/api/health` first, which is what distinguishes a console from
nothing listening. Before reading the index or starting a paid model turn, it
requires `/api/status` to carry an absolute top-level `artifactRoot` and a
`sessions` array, and — when a cell spec was named — the console's `/api/policy`
to satisfy every field of it. It then reads the index and runs each task in its
own session. It waits on the console's own `turn_completed`, `turn_failed` or
`turn_canceled` event, read off the server-sent event stream, and on nothing
else. There is no timeout: a turn that hangs is a batch that hangs, which an
operator can see and release with a `POST /api/cancel`, rather than a bound that
turns a slow run into a failed one.

After a turn settles, the runner locates its root run under the session's
`artifactRoot`, falling back to the console-wide root. The root directory and
stored run id must equal the returned turn id, the run must have been created
after the batch began, and it must not have child lineage. A missing or invalid
identity is recorded as not measured. Unreadable artifacts belonging to other
turns do not affect this join. The runner writes `report.md` and `report.json`
under `--out`, and exits non-zero if any task ended other than completed.

Measuring runs that are already on disk needs no console:

```sh
deno task measure-runs                                  # every family under the default root
deno task measure-runs 9f9bdfe6-20fe-4eac-9346-6ecfa102119e
deno task measure-runs --artifact-root=/elsewhere/runs --json
```

A run family is a parent run and the `delegate_task` children the harness named
`<run-id>.subagent.<n>`. Both commands report the family, never the parent
alone: a parent commonly delegates the authoring and then names the child's work
as its own.

Source measurements read saved `run-pattern-source` artifacts by output id. A
collapsed transcript marker without its artifact is unread source, never a
program with zero imports. Research activity is read from each run's own report
and raw research artifacts, including host opening calls, private model turns,
tool calls, exact reads, and elapsed time. An inherited kit contributes no new
research work to a child's measurement. Browser behavior and token accounting
remain separate readings.

## The suite file

A suite is JSON. `label` names the batch, `notes` is rendered into the report
verbatim, and `tasks` is a list of `{id, text}` — the id files the task in the
report, the text is given to the session unaltered.

Three optional fields describe the corpus the batch is measured against, and
they exist because the identifiers alone cannot say what they are:

- `seededPatternIds` — patterns put into the index for this batch to find.
- `supersededPatternIds` — seeded patterns a later publication of the same atom
  replaced. Re-formatting a seed's source changes its bytes, and the index
  identity is a content hash, so re-running a seed after `deno fmt` publishes a
  second entry for the same program. Both entries are the seeder's work, and
  only one is reproducible from the committed source.

Every identifier a batch composed is then reported as one of:

| mark                               | meaning                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **(seeded)**                       | named in `seededPatternIds`                                                                              |
| **(seeded, superseded duplicate)** | named in `supersededPatternIds`; the program is the seeder's, and the committed source cannot rebuild it |
| **(seeded, via alias of …)**       | its own identifier is in neither list, but one dependency hop reaches one that is                        |
| (pre-existing)                     | neither, one hop deep                                                                                    |
| (ORIGIN NOT RESOLVED)              | the index would not say what it depends on                                                               |

The three seeded marks are kept apart rather than merged because each answers a
different question. Composing a seeded atom is the claim seeding was made for.
Composing a superseded duplicate is the duplicate problem happening _under
measurement_, which merging into "seeded" would hide. And a bare re-export
carries its own identifier, so without the hop it would read as pre-existing and
count a composition of seeded work as evidence against the seeding.

Hops beyond the first are not resolved, and the report says so.

## The cell spec

A suite says what the batch asks the model. A cell spec says what the console
has to be for those answers to mean anything, and it is checked before the first
task rather than read out of the artifacts afterwards. A console whose policy
cannot offer the tool an experiment exists to test produces a night of runs that
look, in every other artifact, exactly like runs that chose not to use it.

The file is JSON, passed as `--cell-spec`. Every field is optional and every
field present is asserted; a field left out is not checked and the report says
so. `label` names the spec and asserts nothing, and a file carrying nothing else
is refused — a check that checks nothing is indistinguishable from one that
passed.

```json
{
  "label": "phase 3, composition under the authored prompt",
  "systemPromptSha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "requiredToolIds": ["run_pattern", "search_patterns", "record_feedback"],
  "forbiddenToolIds": ["web_search"],
  "requiredSubagentProfiles": ["pattern-author"],
  "fabricSpace": "pattern-index-demo",
  "artifactRoot": "/Users/me/labs/packages/cf-harness/.cf-harness-console/runs",
  "sessionDbPath": "/Users/me/labs/packages/cf-harness/.cf-harness-console/sessions.sqlite"
}
```

| field                                                    | asserts                                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `systemPromptSha256`                                     | the SHA-256 of the seeded system prompt, or `null` for a console seeding none |
| `allowedToolIds`                                         | the whole tool set, compared as a set                                         |
| `requiredToolIds` / `forbiddenToolIds`                   | tools the policy must offer, and must not                                     |
| `allowedSubagentProfiles`                                | the whole profile set                                                         |
| `requiredSubagentProfiles` / `forbiddenSubagentProfiles` | profiles the policy must authorize, and must not                              |
| `fabricSpace`                                            | the space the runs write into                                                 |
| `artifactRoot`                                           | where the console files its runs                                              |
| `sessionDbPath`                                          | the durable session store, or `null` for sessions held in memory              |

Stating a set as a whole and in parts at once is refused rather than resolved:
`allowedToolIds` beside `requiredToolIds` is a file that has not decided which
claim it makes. So is a name in both the required and the forbidden list, and a
field name nothing asserts, which would otherwise pass silently as a typo. An
empty required or forbidden list is refused for the same reason: every console
offers at least nothing, so the field looks like a check and is not. An empty
whole set is kept, because there it is the strongest claim the file can make —
that the policy offers nothing at all.

A mismatch refuses the batch with exit code 6, names every disagreeing field
with expected against actual, and starts no task. So does a console that will
not disclose its policy at all: a spec was named, and nothing can report it
satisfied.

The prompt crosses as a digest and never as text. Take one with
`shasum -a 256 <the prompt file>` and paste the hex.

Two limits worth holding. `/api/policy` reports what the console's policy
**asks** for, and the prompt loop withholds a tool again when its backing is
absent — so a spec naming `search_patterns` proves the policy offers it, not
that a turn will hold it; the index pre-flight is what says the backing answers.
And the digest covers the seeded system prompt alone, not the tool descriptors
or the subagent guidance that also reach a model.

The spec describes a console, because a console is the only thing this runner
starts work on. `measure-runs` reads runs that are already on disk and spends
nothing, so it has nothing to refuse; a `cf-harness` CLI run states its own
policy in the flags that start it, where it is visible in the command rather
than in a server somebody else configured.

## The batch publishes into the corpus it is measuring

It does, and that is deliberate rather than an oversight. The loop under
measurement **is** the publishing loop: a session that builds something
contributes it, and a run made publish-inert would measure a different system
from the one the question is about. The console cannot be made inert in any case
— `--no-pattern-index-publish` is the `cf-harness` CLI's flag and the console
never reads it (CT-2119).

What makes the reading sound is the ordering, not stillness. The index snapshot
is taken **before the first task** and again **after the last**, so the "before"
reading is of a corpus that was verified, and everything the batch adds appears
as the difference between the two rather than as an unexplained delta. A reader
who sees "the batch publishes into the corpus it is measuring" without that
ordering will reasonably conclude someone made a mistake.

Two consequences worth stating. A batch is not repeatable against the same
corpus — the second run starts from what the first one left, and its "index
before" will say so. And a batch run before a publish gate lands accumulates
entries that gate never saw, which is a fact about the corpus that outlives the
batch; where that is the case, the report's preamble should say it.

## What the report holds

Per task: the exact text the session was given, the session and run identifiers,
how the turn ended, then one line per call the run made against the index and a
totals block.

The counts, and the distinctions worth knowing about:

- **Searches**, partitioned into hits, empty, refused, and not read. A search
  the index _refused_ — a 403 for an identity that is not allowlisted, say — is
  counted apart from a search that found nothing, because it says nothing about
  the corpus. Collapsing the two is how a broken deployment reads as an empty
  index. Eight of the 58 phase-2 searches were refusals — and all eight sit in a
  single pre-fix run family whose identity the index would not serve, so that is
  one broken run rather than a background refusal rate.
- **`run_pattern` calls**, split by whether they named a published pattern or
  carried source. This is the reuse signal: a run that names an id found
  something, a run that carries source wrote it.
- **`cf:pattern:` imports** in that source, split three ways: source that
  **composes** an imported pattern, source that is a **bare re-export** of one,
  and source whose only reference is a **bare import** —
  `import
  "cf:pattern:…"` with no bindings, which references a pattern and
  cannot put it to work. That split is not fussiness. The live index holds
  entries whose whole program is
  `import P from "cf:pattern:…"; export default P` — one of them ranked third
  overall — and a re-export composes nothing while looking identical to
  composition in an import count. The two are reported apart, never as one
  "compositions" figure. The classifier is a heuristic on the source text, and
  it errs towards calling unusual source composition rather than quietly
  discounting it, which is why all three figures are printed rather than one.
  The totals print **referenced patterns** and **composed patterns** as two
  lines, and the batch report's "what composed what" section lists only the
  identifiers a composing call put to work, because a reference is not a
  composition.
- **`run_pattern` outcomes**, counted by whatever status the tool reported.
- **Delegations**, by profile.
- **Slugs**, split into assigned, refused, and not read. Only an assigned slug
  is named: a slug the tool refused was requested and answers to nothing, so
  counting the request would put a name in the report that opens no piece.
- **Tool surfaces**, every tool the runs called and how each call ended, with a
  denial counted apart from a failure. A surface every one of whose calls was
  denied is marked `WITHHELD`, and one that ran and never succeeded is marked
  too. Without that line a reader infers that the model chose not to use a
  surface that was in fact unavailable to it — across the phase-2 corpus, `bash`
  was 38 calls and 38 denials, and `read_file` never once returned a file. These
  are derived here from each tool's own recorded result, not taken from any
  classified field of the run report.

Everything the reader could not read is counted as not read, never as zero: a
run directory with no transcript, a call whose result the run never wrote, a
tool result that carried no status. Those readings appear in the rendered report
as `NOT READ`, with the reason.

## What this measures, and what it does not

It **counts what a run did**. Every number above is a count of calls in a
transcript.

It **does not say whether what a run built works.** Nothing in this protocol
renders a piece. `run_pattern` reporting `ok` means the pattern compiled and its
result matched the schema it declared, and that is the whole of it: the phase-2
sortable table rendered every cell as `[object Object]`, reported `ok`,
published clean, and ranked first for its query. Whether a published pattern
works is CT-2107's subject. A batch report read as answering it is worse than no
batch report, because the numbers look like evidence.

Two consequences follow, and both are load-bearing:

- A rise in "ran by id" is a rise in **reuse**, not in **quality**. It rises
  just as readily when the index fills with broken parts that rank well.
- Confirming that a run built something that works means opening it. The report
  records each run's assigned slug so the piece can be opened; that check is a
  person's, and its result belongs in whatever records it, not in a count here.

It **does not say whether a run found what it asked for.** A search hit is a hit
against a pattern's _description_, and a description in this index is not
reliably a description of the program behind it. Read against the live corpus:
one entry advertising a grocery checklist is a 287-byte counter, one advertising
a reading list has no interface at all, and three "packing list apps" are
`computed(() => 2)`. So a hit counted here is a hit, not a match, and a rise in
hits is not by itself a rise in useful answers.

It **does not establish why** a run did what it did. A run that wrote its own
counter with a working counter sitting at the top of its search results is
evidence about incentive, not about mechanism, and the instructed-composition
batch above is what separates those two.

It **does not read a classified failure field.** Everything above is derived
from the raw results in the transcript. That is deliberate: a classifier ranks
causes by a priority ordering chosen for another purpose, and a measurement that
inherits one reports that ordering rather than what happened.

It **does not measure the index's own ranking.** The report records each listed
pattern's score, and score is computed from recorded events; a score is close to
a count of "an agent started this and nothing threw". Retrieval quality — what a
search actually hands back, and at which rank — is a separate instrument with a
separate query set, described in [Measuring retrieval](#measuring-retrieval)
below. Keep the two apart: this protocol asks whether a session reached for the
index at all, and that one asks whether what it was handed was the right thing.

## Measuring retrieval

[`scripts/pattern-index-retrieval-queries.json`](../scripts/pattern-index-retrieval-queries.json)
is a labelled query set, and `scripts/score-retrieval.ts` scores
`searchPatterns` against it. Both are read-only against the index, so a run is
safe while a batch is publishing.

```sh
PATTERN_INDEX_BASE_URL=https://index.example \
CF_IDENTITY="$HOME/.cf/my-key.pkcs8" \
deno run -A scripts/score-retrieval.ts --out=report.json \
  --min-hit-at-5=0.5 --max-dirty-negatives=15
```

**The exit code is the verdict; the printed lines are not.** The thresholds are
arguments rather than constants because the corpus moves, and a gate with a
baked-in expected value stops being readable the first time someone publishes.
Before trusting a passing run, make it fail once — raising `--min-hit-at-5`
above the reported rate is the cheapest way.

Three properties of the set decide what its numbers mean, and all three are
stated in the file itself rather than here, so that editing one edits its own
documentation:

- **Labels are derived from source and declared schemas, never from
  descriptions.** A query set written by reading descriptions retrieves those
  descriptions and measures nothing.
- **Queries are asked in four registers**, one of them the real queries
  extracted verbatim from console run transcripts. Registers are scored apart,
  because phrasing changes the answer far more than the corpus does.
- **Negative queries carry the weight.** A query nothing should answer is where
  loose matching shows up; a capability query cannot distinguish a good index
  from a permissive one.

Adding a query leaves the earlier ones comparable. Rewording one does not, so
add rather than reword — the same rule the task suite carries, for the same
reason.

**The set measures free-text search only.** Tag-only searches — `tags` passed
with no `text` — are a different mechanism, an `array-contains-any` over
author-chosen hashtags, and they are a large minority of what runs actually
issue. Nothing measures them yet, so a retrieval number from this set describes
part of the search surface and should be quoted that way.

## The server the runs ran against

The console talks to a fabric server, and which one — and which commit it is
built from — decides what the runs were actually exercising. A server left
running from another worktree's branch is not running the code a measurement
reports on, and nothing in a run artifact says so.

So the report reads the server's `/api/meta` before the first task and records
what it says: the commit, the CFC block, and the experimental flags. It also
asks the local repository whether that commit is on `main`, and records
`ancestor`, `diverged`, or `unchecked` — a commit this clone does not hold is
`unchecked`, which is not the same reading as one known to be off the branch.

Two rules about that reading, both load-bearing.

**Knowing a commit is wrong differs from not knowing.** A `diverged` reading
refuses before the first task unless the operator passes `--allow-diverged` to
record an intentional mismatch. An `unchecked` reading stays non-fatal: a clone
that does not hold the commit, or a git command that could not answer, has not
shown the server to be off the branch. An explicit `--expect-git-sha=<sha>` is
stricter still and refuses whenever the server reports a different commit.

**The server's CFC block is never differenced against the console's.** They
describe different runtimes. `cfcFlowLabels` is core-default off and the
`MAX_ENFORCEMENT_CFC_OPTIONS` bundle is applied by the `remoteClient` and
`browserWorker` presets — which is what cf-harness's fabric session is — while
the toolshed runs a production-server preset. A server built from `main` reports
`flowLabels: "off"` and that is correct. A check that read the difference as a
contradiction would refuse every correctly configured night. The report prints
the server's block as the server's, beside the console's as the console's, and
leaves the comparison to a reader who knows which runtime they are asking about.

The comment above `ServerMeta` in `scripts/run-measurement-batch.ts` is the
canonical statement of that rule, and is the thing to read before treating the
server's block as evidence about anything a run wrote.

## Which dial decides whether a label is written

**The writing session's, and only the writing session's.** A `labelMap` is a
field of the document a transaction commits, written by the runtime that commits
it — the fabric session's runtime here, whose dials `--fabric-cfc-flow-labels`
and `--fabric-cfc-posture` set. The memory server stores what it is given and
mints no label of its own, so no server configuration turns label persistence on
or off for these runs, and there is no toolshed environment variable that would.
A toolshed reporting `flowLabels: "off"` while a session writes labeled
documents into it is the system working.

Two consequences worth stating, because assuming either way round is expensive:

- The server's posture is **not** evidence about what a run wrote. To find out
  what a run wrote, read the space.
- A run's own `cell-labels.json` is not evidence either, unless it says
  `status: "read"`. An `unavailable` snapshot is a reader that never reached the
  store, which is the section below.

## Reading the labels back

The labels live in the serving toolshed's own store, and a run reads them from
that file rather than over the wire. Finding it is the operator's job whenever
the harness and the toolshed do not share a working tree.

The search walks up from the working directory looking for
`packages/toolshed/cache/memory` and `cache/memory` at each level, so it finds
the store of a toolshed serving from the same checkout and no other. A
measurement run from a second worktree — the ordinary arrangement, since the
toolshed holds a branch still while the work moves on — shares no ancestor with
the serving tree, and the search comes up empty. That reads as
`unavailableReason: "space-not-found"`, under which every cell of the run is
recorded as unasked-about.

The worse case is a second worktree that has served the same space itself at
some point, and so holds a file of the same name. The search finds that one,
opens it, and finds none of the cells the run wrote. Each such cell is recorded
with `unreadReason: "no-document"` rather than with an empty entry list, and a
snapshot in which every cell reads that way is warned about as the wrong store.
Neither reading is "the run wrote no labels".

Point it at the store instead. Either of these names the same place:

```sh
# The environment the search consults first, for any run.
MEMORY_DIR=/path/to/serving-tree/packages/toolshed/cache/memory

# The flag, which names one database file directly.
--space-db /path/to/serving-tree/packages/toolshed/cache/memory/engine-v3/engine-v3/<did>.sqlite
```

`--space-db` (`CF_HARNESS_SPACE_DB`) takes a file and needs the three fabric
session flags beside it. `MEMORY_DIR` takes the cache directory and lets the
space the session names resolve within it, which is what a batch spanning
several spaces wants.

A snapshot that then says `status: "read"` is a positive finding: the cells it
lists carry the labels it shows, and a cell with an empty `entries` and no
`unreadReason` is a cell the space holds no label for. The read follows the
links out of each cell as far as the pattern's shape runs — a piece names its
results, and each result may name cells of its own — so a label derived on a
computed value sits in the snapshot under the path of links that reaches it,
naming the cell it was read from as `source`.

## The failure this measurement exists to not commit

Three separate things went wrong in the same shape while this was being built,
and every one of them was **a confident wrong answer where an honest refusal
belonged**:

- An index that answered `403` to every query recorded as an index that held
  nothing. A whole run family searched, found "nothing", and wrote its own
  patterns. Nobody noticed.
- A classifier mapped every denied policy event to one cause at the highest
  priority, so a run whose `bash` was denied reported that as its terminal cause
  whatever actually ended it.
- A server's CFC block was read as contradicting the console's, when the two
  describe different runtimes under different presets. That one was caught
  before it shipped, and it would have refused every correct night.

Each was cheap to prevent and expensive to discover, and none of them looked
wrong from the inside — that is the whole difficulty. The rules that follow from
it are the ones this document keeps repeating: an unread reading is recorded as
unread and never as a zero; two readings that could differ are printed side by
side rather than differenced; a refusal is a refusal rather than a warning; and
a known-diverged server refuses unless the operator explicitly allows that
mismatch, while an unread ancestry remains non-fatal.

## Changing this

The scripts are [`scripts/measure-runs.ts`](../scripts/measure-runs.ts) — the
extractor, whose counting rules are pinned by `test/measure-runs.test.ts`
against hand-authored transcripts — and
[`scripts/run-measurement-batch.ts`](../scripts/run-measurement-batch.ts) — the
runner, pinned by `test/run-measurement-batch.test.ts` against a stand-in
console server.

Two rules for changing either. A new count is an addition; a changed count
breaks comparison with every report already written, so say so in the report's
notes when you do it. And nothing may collapse an unread reading into a zero —
the whole value of a report a colleague did not run is that it distinguishes
what happened from what nobody looked at.
