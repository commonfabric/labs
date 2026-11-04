# Demo-round analysis ledger — 2026-09-01

Same practice as `../2026-09-02-round4/round4-ledger.md` and
`../2026-09-01-ct2122/ct2122-ledger.md`: append-only, absences recorded as
absences, a count that cannot be derived written "not read".

Console at `f5d4398aac`, toolshed `:8063` at `180d006f87` — both diagnostic
collapses and the doc caps live. Cell-spec enforced on both batches: the
candidate prompt by hash (`a2dd4986…`), `acquire_skill` forbidden,
`pattern-author` required, and the fabric space pinned to `demo-2026-09-01`.
Marker check re-run by hand and agrees on every run: candidate present, historic
absent, child bullets present.

## Cell — the five-phrase demo batch

Report: `demo-run/report.json`, store `.cf-harness-console-demo2`. Ran 09:54:57Z
to 10:26:24Z, 31.5 minutes. Five phrases, five `turn_completed`, five pieces.

| Phrase   | searches | run_pattern | source | composing | outcomes       | refs block |     docs read | child wall |
| -------- | -------: | ----------: | -----: | --------: | -------------- | :--------: | ------------: | ---------: |
| poll-a   |        5 |           3 |      3 |         0 | 1 ok, 2 ce     |     no     | 2 (39,892 ch) |       317s |
| poll-b   |        6 |           4 |      4 |         0 | 2 ok, 2 ce     |  **yes**   | 3 (22,282 ch) |       340s |
| rsvp     |        5 |           3 |      3 |         0 | 1 ok, 2 ce     |     no     | 2 (11,305 ch) |       302s |
| budget   |        6 |           4 |      4 |         0 | 2 ok, 2 ce     |     no     | 2 (14,060 ch) |       439s |
| research |        3 |           2 |      2 |         0 | 1 ok, 1 ce     |     no     |             0 |       254s |
| **cell** |   **25** |      **16** | **16** |     **0** | **7 ok, 9 ce** |   1 of 5   | 9 (87,539 ch) |          — |

Against the round-4 demo cell: **28 `run_pattern` / 5 ok / 23 ce → 16 / 7 / 9**.
Leaner on every axis, and the `ok` share rises from 18% to 44%.

**Composition is zero across all five phrases**, as it was in round 4. One
parent (poll-b) attached a ref; the other four attached none. No by-id run
anywhere.

Corpus 29 discoverable before and after; non-discoverable 141 → 148. Which is
the next entry.

### Console publishes are not discoverable (CT-2166)

The batch's loop-closure leg could not fire. Seven entries were added to the
corpus and every one landed non-discoverable, so nothing this batch built could
be found by a later search. `publishDiscoverable` is CLI-only. This is the third
recorded instance of the console lagging the CLI in this programme, after
`acquire_skill` (CT-2160) and the subagent-profile policy difference found in
the Block-3 CLI attempts.

### (b) Turn times — first data on the post-#6690 build

Children spend 96-98% of wall in model turns, unchanged. On
`responseCompleteDurationMs`:

| Build          |       clean turn | post-failure turn |     ratio | child ok-rate |
| -------------- | ---------------: | ----------------: | --------: | ------------: |
| ct2122 morning |     35.6s (n=13) |      54.5s (n=19) |     1.53× |           38% |
| demo batch     | **39.9s (n=25)** |  **46.6s (n=13)** | **1.17×** |           50% |

On the older gap proxy, for continuity with round 4: 3.22× → 2.85×.

The post-failure penalty continues to shrink — 6.28× (round 4, gap proxy),
3.22×, then 1.53× and now 1.17× on the honest field. The two-prior-failure
bucket here sits _below_ the clean mean (23.1s against 39.9s), though on n=4.

**Not yet enough to call the CT-2158 falsifier met.** The falsifier wants
post-failure turns back at the floor with the `ok` rate holding. The `ok` rate
held and improved; 1.17× is close to parity and within noise at this n. But this
batch produced only five child failures, so the post-failure arm rests on 13
samples across three buckets. The trend across three builds is monotone and in
the falsifier's direction; one more cell with a fuller failure arm would settle
it.

Per-phrase child wall clock ran 254-439s. Slowest single turns: 125s (budget),
127s (research).

### (c) Budget composed nothing, and this time attached nothing either

The parent searched three times and saw both halves of what it needed:

- `DRCFljoU…` — the cents-ledger part, `kind: part`, "keeps a list of labeled
  amounts, sums them in integer cents, and shows the formatted running total" —
  returned twice, at 2/7 and 2/5 matched terms.
- `DWl3kXPQc1qR…` — `kind: app`, `quality: proven`, "interactive monthly expense
  tracker that adds categorized expenses, totals spending, sorts by amount" —
  returned at 4/10 and 2/5.

**It attached neither.** No `patternRefs` on the delegation, no refs block in
the child, four `run_pattern` calls all from source, zero importing.

So budget hand-rolled again, and did so from a weaker position than round 4,
where its parent at least attached the cents-ledger part and the sortable table.
Two rounds running, the one task whose arithmetic a published part exists to do
has rebuilt that arithmetic instead.

Not attaching the `app` is defensible on its face — the demo phrase asks for a
dashboard "from my transaction data", and the published tracker does not ingest
data, so it does not answer the whole request. Not attaching the `part` has no
such defence: totals-by-category is exactly what it does.

The round-4 `$NaN.undefined` defect did **not** recur; the operator's browser
verification records this piece as passing once a required date is supplied.

### The docs-compete hypothesis is untestable in this cell

Four of five children read docs (87,539 characters in total) and composed
nothing; the fifth read none and also composed nothing. With no variance in the
outcome, this cell neither supports nor weakens the alignment seen in the
CT-2122 morning cell. Recorded so that a later reader does not count it as a
second observation.

## Cell — the CLI publish leg

Artifacts under `.cf-harness-demo-cli/runs`, run `2dc9b079`. Ran through the CLI
because the console cannot publish discoverably.

The parent searched three times, delegated once to `pattern-author`, took a
handle back, and slugged it `dinner-poll`. The child authored and ran the
pattern, reaching `ok` on `run_pattern:13` with a result reference and a schema
carrying `question`, `totalVotes`, `$NAME` and `$UI`.

Published discoverable: **corpus 29 → 30**, entry
`aHmly5HYfchuzY4s1IH7xWGlfnuis7G1wpOB1dFKtH4`.

**Disclosed deviation.** The operator's task text added "make the question and
options configurable" to the round-4 poll phrase. The delegation goal repeats it
— "build and run a complete reusable shared poll app… it must start with
question 'What should we eat for dinner?'". This is demo engineering, not the
round-4 phrase, and it is what made the published entry parameterized. It is
also, as the next cell shows, what excluded the entry from the reuse path.

## Cell — the encore

Report: `encore-run/report.json`, same console store. Ran 10:38:16Z to
10:41:29Z, 193 seconds. One task, natural phrasing, no mention of the index:
"Make a poll for which board game to play tonight — chess, catan, or uno — one
vote per person, and show everyone the running tally."

### (a) What actually happened, from the artifacts

Confirmed, and one step further than the summary:

1. The parent searched once and the new entry came back — `aHmly5…`,
   `kind: "part"`, `quality: "unproven"`, 4 of 6 matched terms, described as
   "runs a configurable shared live poll with vote-once name enforcement,
   tallies and percentages, validated option editing, and confirmed vote reset".
   Top hit, as the operator read it.
2. **The parent attached it as a `patternRef`** — one entry, with a
   parent-authored note, no refusal.
3. **The child received it complete**: the generated block is present in the
   child's own text with the exact description, import hint, argument shape and
   result shape.
4. **The child neither ran it by id nor imported it.** Two `run_pattern` calls,
   both from source, zero importing, zero composing — 1 compile-error then 1 ok.

So the miss is two-stage, and only the first stage is the classifier's:

- **Stage one, the parent.** The classifier called a parameterized whole a
  `part`, so the decision policy's whole-answer branch — "if one entry answers
  the whole request, run it by patternId" — never applied. The parent did the
  correct thing for a part: it attached it and delegated.
- **Stage two, the child.** Holding a complete record for an entry that does
  exactly the requested job, with the composition bullets present, it wrote the
  poll from scratch anyway.

Stage two is the same behaviour as round-4's `team-picker` and the CT-2122
cell's `dice-tally` and `team-picker`. This child also read docs — three
released reads of `pattern-development-guide.md`, `reactivity.md` and
`new-cells.md` — which is consistent with the docs-compete hypothesis and, at
n=1, is one more observation rather than evidence.

Fixing the classifier alone would have changed stage one. It would not, on this
evidence, have been sufficient: the child had everything it needed and still
rebuilt.

### (f) The taxonomy finding, stated precisely

**The `kind` classifier and the decision policy disagree about what "answers the
whole request" means, and the disagreement makes parameterized wholes
structurally invisible to the by-id path.**

- The classifier reads the published `argumentSchema`: an object schema is a
  `part`, an absent or `false` schema is an `app`. It is a statement about
  _whether the entry takes arguments_.
- The decision policy reads `kind` as a statement about _whether the entry
  answers the request whole_: `app` → run it by id, `part` → attach it and
  delegate.

For an unparameterized application those two questions have the same answer,
which is why the round-4 reuse cell worked — six `kind: app` entries, six by-id
runs, no source authored. They come apart exactly when an entry is a finished
application that also takes arguments. `aHmly5…` is that case: a complete poll
application whose question and options are configurable. The parameterization
that makes it reusable is what classifies it as a part, and being a part is what
routes it away from the branch that would have reused it.

The perverse consequence is worth stating plainly: **making a published
application configurable removes it from the reuse path.** The corpus is being
gardened toward parameterized atoms — that is what the seeding programme did —
and every step in that direction shrinks what the by-id branch can answer.

This is a design question rather than a defect with an obvious fix, and it is
the one for the operator regroup. The two candidate directions the evidence
supports, neither measured:

- Give the endpoint a classification that answers the policy's question —
  whether the entry stands alone — separately from whether it takes arguments.
  An entry could then be a parameterized whole: runnable by id with defaults,
  composable with arguments.
- Or teach the decision policy to read shapes rather than `kind`: an entry whose
  arguments are all optional answers whole, whatever its schema shape.

Both are testable with the committed suites and one corpus entry, since
`aHmly5…` is now in the corpus as a live instance of the case.

## Provenance and gaps

Model `gpt-5.6-sol` throughout; skills root scanned, 26 skills, no run without a
registry; CFC `enforce-explicit`, same dials. Console commit is recorded here
from the operator's message (`f5d4398aac`) and still appears in **no artifact**
— the gap named in the round-4 record, unchanged, and now load-bearing since
console and toolshed are at different commits.
