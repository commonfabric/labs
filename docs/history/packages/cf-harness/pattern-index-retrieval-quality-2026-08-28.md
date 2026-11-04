---
status: historical
created: 2026-08-28
archived: 2026-08-28
reason: "Record of the first retrieval-quality measurement of the pattern index's search (CT-2115, CT-2066)."
---

# What `searchPatterns` returns, measured

The pattern index has been searched by every authoring run since it existed,
and nobody had measured what it hands back. This is that measurement: a
labelled query set, a score against it, and the individual failures rather
than only their mean.

Read-only throughout. `listPatterns`, `searchPatterns` and `getPattern` were
the only calls made; nothing was published, no event was recorded, and no
entry's discoverability was changed. An authoring batch was writing to the
same corpus while this ran, which is why every number below names its reading.

## What this found, in the order that matters

Ordered by what each finding changes, which is not the order of how striking
they are. The first is the least quotable and the most consequential; the third
is the one that will get quoted.

1. **The ranking function has an evidence term the data cannot exercise.** The
   sort is matched terms, then quality tier, then weighted score. 24 of the 26
   discoverable entries sit at score 0 and tier `unproven`, and matched terms
   rarely ties, so **the two evidence keys are almost never reached**: 83 of the
   91 first-place slots in this run are held by entries with zero
   `run_succeeded` and zero `thumbs_up`. The sort is lexical in practice. No
   change to the weights touches this, because there is nothing for a weight to
   act on. Every argument about selection pressure percolating good atoms upward
   has been an argument about a code path that does not execute.

2. **Search serves component-shopping queries worst of the four registers** —
   MRR 0.37, against 0.74 for the queries runs really issue. A session that
   knows it wants a part to wire into something larger is the session search
   helps least, which is the retrieval-side face of composition never happening.

3. **Free text does not fail by returning nothing; it fails by returning a
   confident wrong page.** 12 of 15 negative queries were answered, and every
   sentence-form one was answered with a full ten. This is the vivid finding and
   the one most likely to be quoted; it is third because it describes how a
   known-loose matcher is loose, rather than changing what the index is
   understood to be.

4. **Two of the corpus's most confidently-retrieved entries are static
   mockups.** Both rank #1 on perfect term matches for real queries, and neither
   can do what its description claims.

Free-text search only — see the boundary immediately below before quoting any
of it.

## The reading

`listPatterns '{"includeNonDiscoverable":true}'`, 2026-08-28T13:50:31Z:
**53 entries, 26 discoverable, 27 hidden.** The corpus grew from 51 to 53
during the two hours this work took, so a number here is a number about that
reading and not about the index.

Event weights at the same reading: `created` 0, `instantiated` 0.5,
`run_succeeded` 1, `run_failed` -0.5, `thumbs_up` 2, `thumbs_down` -2.

## The instrument, and why its construction is the argument

[`scripts/pattern-index-retrieval-queries.json`](../../../../runtime/cf-harness/scripts/pattern-index-retrieval-queries.json)
holds 13 capabilities, 73 capability queries and 15 negatives. Choosing a
fixture is choosing a population, so the choices are stated in the file and
summarized here.

These recorded measurements predate pattern-index #10 (`ded05dd`), which
narrowed ranking to visible metadata; they use the earlier, wider haystack
that included the private query fields described below.

**Labels come from behaviour, not from wording.** Every discoverable entry was
fetched with `getPattern` `includeSource: true` and its program and both
declared schemas were read. An entry answers a need when a session could use
it without rewriting its behaviour; it is `partial` when it has the right
subject and the wrong shape. `partial` earns no credit, because a session
handed one has been misled rather than served.

**Phrasing is a measured variable, not an assumption.** The retrieval brief
that commissioned this asked for queries "phrased as a task, the way an agent
actually searches". That assumption turned out to be false, and checking it
is the single most useful thing this instrument does.

All 64 console run transcripts under
`packages/cf-harness/.cf-harness-console/runs/` were read; all 64 parsed and
none was unreadable. They hold **70 `search_patterns` calls across 38 runs**:
44 carried free text, 26 carried tags alone. The 44 distinct texts are **all
keyword bags**. Not one is a sentence, has a first-person pronoun, or has a
verb in a finite clause. Median five words; the shortest are `app`,
`reactive`, `double` and `doubling`.

So the set asks each capability in four registers and scores them apart:

| register | what it is | queries |
|---|---|---|
| `observed` | the real queries, verbatim, from the transcripts | 34 |
| `keywords` | a synthetic keyword bag | 13 |
| `task` | the user's sentence, the register the brief assumed | 13 |
| `capability` | component-shopping phrasing | 13 |

The observed register is kept alongside the synthetic ones rather than
replacing them, because the observed shape is **taught by the system prompt** —
which instructs the model to search "from the whole to the parts" by naming
interaction verbs — and that prose is being varied. A fixture pinned only to
observed phrasing is pinned to a moving target.

Three real queries sought a calculator the corpus does not hold and are scored
as negatives. Seven were generic scaffolding (`app`, `reactive`,
`form input button state`) and are listed unscored: no honest relevance label
exists for them, and that 7-of-44 class is itself a finding, since the prompt
directs the model into a query shape the corpus has no answer for.

### The largest gap: tag-only search is 37 percent of real traffic and nothing measures it

**Read no number in this document as covering the whole search surface.** Of
the 70 real `search_patterns` calls, **26 passed tags with no text at all**.
Every figure below describes free-text search and says nothing whatever about
the other 37 percent.

Tag search is a different mechanism, not a variant of this one: it is a
Firestore `array-contains-any` over author-chosen hashtags, capped at ten tags,
and it does not reach `matchedTerms` or any of the substring behaviour that
produces the results here. So none of the failures found below can be assumed
to occur there, and none of them can be assumed not to. **This is the first
thing to measure next**, and it needs its own labelled set, because the
hashtags entries carry are chosen by whichever run published them and are
largely unshared across the corpus.

### What this instrument does not cover, beyond that

- **The 36 live searches** cited in the index's own source comment as the
  evidence for disjunctive matching. Their text was never committed and was
  **not read**; the 70 calls above are a different and larger sample.
- **Second and later searches** within a session, after the corpus's
  vocabulary is already on screen.
- The author of the fixture read the corpus's source, which a harness session
  never does. That buys correct labels and costs any claim that the queries
  were written in ignorance. The four registers and a published
  wording-overlap statistic are the compensating controls, not a fix.

## The numbers

At the ranks the tool actually shows the model. `search_patterns` reports **ten**
hits and fetches declared argument and result shapes for the **first five**, so
an answer at rank 7 reaches the model without the types it needs to wire it in.
Both cut-offs are scored.

| register | queries | hit@5 | hit@10 | MRR | P@5 | R@5 |
|---|---|---|---|---|---|---|
| observed | 34 | 28 (0.82) | 29 | 0.74 | 0.28 | 0.77 |
| keywords | 13 | 10 (0.77) | 10 | 0.64 | 0.22 | 0.71 |
| task | 13 | 9 (0.69) | 10 | 0.59 | 0.14 | 0.50 |
| capability | 13 | 8 (0.62) | 9 | 0.37 | 0.15 | 0.48 |
| **all** | **73** | **55 (0.75)** | **58** | **0.63** | **0.22** | **0.66** |

Precision@5 is low against a ceiling: most capabilities have one to three
answering entries in a 26-entry corpus, so five slots cannot be filled with
relevant hits. Hit rate and reciprocal rank are the numbers that describe the
decision a session actually makes, which is reuse or rebuild.

**The register ordering is the result.** The queries the loop really issues do
best; the sentence register the brief assumed does worse; component-shopping
phrasing does worst by a wide margin on MRR. A session that knows it wants a
part to wire in is the session search serves least well.

## The negative queries, which is where it breaks

15 queries nothing in the corpus should answer. **12 returned results.**

| query | register | returned |
|---|---|---|
| "I need something that counts the seconds while it is running…" | sentence | 10 |
| "Draw me a bar chart showing how much each category came to" | sentence | 10 |
| "Roll dice and keep every past roll so I can see the distribution…" | sentence | 10 |
| "Convert an amount from one currency into another at today's rate" | sentence | 10 |
| "A board with columns where I drag cards between the columns…" | sentence | 10 |
| "An editor where what I type in Markdown shows up formatted beside it" | sentence | 10 |
| "A sign-in form that checks a password before letting someone in" | sentence | 10 |
| "Show me a month laid out as a grid of weeks with the days numbered" | sentence | 10 |
| `interactive calculator editable fields UI` | observed | 10 |
| `interactive calculator inputs TSX` | observed | 10 |
| `simple tip calculator bill amount tip percentage` | observed | 8 |
| `elapsed seconds start stop clock` | keywords | 1 |
| `weather forecast temperature outside` | keywords | 0 |
| `upload file attach document` | keywords | 0 |
| `xylophone quantifier brackish` | control | 0 |

**Every sentence-form negative returned a full page of ten.** Every
keyword-form negative returned nothing or one. The split is exact, and it has
a mechanism.

### The mechanism

Free-text matching is `haystack.includes(term)` over raw whitespace-split
terms, with no stop list and no word boundary. Taking the kanban query, which
the corpus cannot answer at all:

> "A board with columns where I drag cards between the columns as work moves along"

| matched term | entries containing it, of 26 |
|---|---|
| `a` | 26 |
| `i` | 26 |
| `with` | 13 |
| `as` | 10 |
| `the` | 6 |
| `board` | 3 |
| `columns`, `cards`, `moves`, `along` | 1 each |

Seven of its fourteen terms match. **Five of those seven are function words.**
The sixth, `board`, matches only by being a substring of `dashboard` — a word
whose meaning is close to the opposite of the query's. `matchedTerms` then
ranks a minimal counter third for a kanban board.

Two consequences worth stating separately:

- **`{"text":"a"}` returns the entire discoverable corpus.** Any query
  containing a common short token cannot return empty, so the
  `matchedTerms > 0` filter does not filter English.
- **Substring matching is directional.** A query term matches when it is
  contained in the entry's text, so `column` matches `column headers` and
  `columns` does not. A plural can cost a match its singular would have made.

### Why this inverts the question the brief asked

The commissioning brief asked what search should return when a query matches
only withheld entries, on the premise that it returns nothing, which "reads
identically to nobody has built this". That premise holds only for keyword
queries. For the sentence-shaped queries the tool's own description encourages
— it tells the model that "more words widen the net rather than narrowing it" —
search returns **a full page of confident, irrelevant hits**.

That is worse than silence, in a specific way. Silence at least prompts
building the right thing. Ten wrong hits invite either a bad composition or the
correct decision to stop trusting search, and the second one is learned once
and kept.

## Failures individually

36 failures over 73 queries: 16 misleading, 12 false-positive, 5 miss, 3
buried. A mean would hide all of the following.

### Misses — nothing answering in ten results

- **`multiply-number`, all four registers.** "I have a figure and I want twice
  as much", `twice as much figure`, "a part taking one numeric field and
  returning it multiplied", and the real query `doubling`. The corpus holds a
  doubler with the best evidence record in it (8 `run_succeeded`, score 13) and
  none of these reach it. The real query `double` finds it at 1/1; `doubling`
  finds nothing, because the index tests whether `doubling` is contained in
  the entry text, and the entry says `Doubles`. **One inflectional ending is
  the whole difference between the corpus's best-evidenced entry and no result
  at all.**
- **`sortable-table.capability`.** "a part I hand arbitrary records and field
  definitions to that reorders them on a header press" does not reach the
  sortable-table atom, which is the one entry that does exactly this. The real
  query `sortable table` puts it at #1. Wording, not capability, decides.

### Buried — answer at rank 6-10, so the model sees it without shapes

- `single-select.task` — the option-picker atom at rank 7.
- `labelled-notes.capability` — rank 6.
- The real query `add delete list form interactive` — rank 6.

### Misleading — a `partial` outranked every answering entry

Sixteen cases. The two that matter most are both **static mockups published
tonight, ranking #1 on perfect term matches**:

- `2h0TVvTMdh` is **#1 at 8/8 matched terms** for the real query
  `trip itinerary travel timeline day schedule chronological planner`, and #1
  again for `add activity form timeline schedule` and
  `interactive planner add item`. Its source is a hardcoded five-row array
  rendered as static JSX: no `Writable`, no `cell`, no `action`, no event
  handler. Its description promises "an add-activity control".
- `2QGxpAuh-T` is **#1 at 6/6** for the real query
  `birthday tracker upcoming birthdays add friend` — including the word `add`,
  which it cannot do. Same shape: no state, no handler, `$UI` the only
  declared result.

Also: the RPG character sheet outranks the dice atom for both real dice
queries (`random roll button`, `random d20 roll button`), because its
description happens to carry all three or four query words.

## Description-match and evidence are currently indistinguishable

The brief warned that six seeded atoms rank #1 on hand-written descriptions
with zero usage events. The measurement is stronger than the warning.

Across the 91 queries that returned anything, **83 of the 91 #1 slots are held
by an entry with zero `run_succeeded` and zero `thumbs_up`.** Ranking is
decided by wording in 91 percent of cases. Only two entries in the corpus carry
any positive evidence at all, and between them they hold 8 of the 91 top slots.

The six seeded atoms hold 29 of the 91, every one of them on `score: 0`,
`quality: "unproven"`, events `{created: 1}`.

This is not a defect in the sort. The sort orders by matched terms, then
quality tier, then score — but with 24 of 26 discoverable entries at score 0
and tier `unproven`, the two evidence keys are almost never reached. **The
ranking function has an evidence term that the data cannot currently exercise.**

### A correction, and a distinction

The brief said the thumbs have never fired, and `quality.ts` says
`record_feedback` "has been called zero times in the project's life". At this
reading that is **false**: the corpus carries one `thumbs_up` and two
`thumbs_down`. The more useful statement is the precise one — all three sit on
**non-discoverable** entries, so no thumb has ever influenced a live search
result. `quality.ts`'s comment should be corrected rather than relied on.

### A signal the searcher cannot see

The haystack includes `directQuery`, `rootQuery` and `parentQuery` — the task
prose of the run that published the entry — which are ranked on and never
returned. This is why the real query `app` matches five entries whose
descriptions contain no such word. The model is told to "judge closeness by the
ratio" of `matchedTerms` to `queryTerms`, but that ratio is computed partly
against text the model cannot see and could not have predicted, which makes it
uninterpretable as a closeness signal.

## Reproducing this

From `packages/cf-harness`:

```sh
PATTERN_INDEX_BASE_URL=https://us-central1-pattern-index.cloudfunctions.net \
CF_IDENTITY="$HOME/.cf/my-key.pkcs8" \
deno run -A scripts/score-retrieval.ts --out=report.json \
  --min-hit-at-5=0.5 --max-dirty-negatives=15
```

The thresholds are arguments, not constants, because the corpus moves and a
gate with a baked-in expected value stops being readable the first time
someone publishes. The exit code is the verdict; the printed lines are not.
Verified in both directions against this reading: `--min-hit-at-5=0.5
--max-dirty-negatives=15` exits 0, and `--min-hit-at-5=0.9
--max-dirty-negatives=0` exits 1 naming both breaches.

## What was not verified

- No entry was run. `partial` and `answers` labels rest on reading source and
  declared schemas, not on observing behaviour in a browser. An entry that
  looks interactive in source and fails at runtime is labelled as answering.
- Tag search is unmeasured, and it is 37 percent of real traffic.
- The negative queries assert an absence across a corpus read once. An entry
  published after 13:50:31Z could answer one of them.
- `quality: "proven"` is asymmetric with no marker: rows published after the
  render gate carry a render check and earlier rows do not, and nothing in the
  data distinguishes them. No claim here depends on the tier.
- `discoverabilityChangedBy` records the signing key rather than the actor
  (CT-2136), so the hidden entries' provenance was read as a key and not as a
  person.

## Judgement on ranking

The sort is `matchedTerms`, then quality tier, then weighted score, then
newest. The score is an event-weight sum over `created` 0, `instantiated` 0.5,
`run_succeeded` 1, `run_failed` -0.5, `thumbs_up` 2, `thumbs_down` -2.

The finding above bounds what any change to the score can buy. With 24 of 26
discoverable entries at score 0 and tier `unproven`, **the evidence keys are
almost never reached**, because `matchedTerms` decides first and rarely ties.
Reweighting events changes nothing a session sees. Separating what needs new
signal from what does not is therefore the whole of the judgement.

### What can be had from signal already in the data

**1. Rank the atom/app distinction, and show it. This is the lead
recommendation.** `argumentSchema` is an object for the 8 composable atoms and
`false` for all 18 self-contained apps — a hard behavioural split, sitting in
the index, used by nothing. A session shopping for a part to wire into
something larger and a session wanting a finished page get the same list in the
same order, and the `capability` register's last-place MRR of 0.37 is that
showing up as a number. Two changes, neither needing a new event:

- Return the distinction in the search hit, so the model can act on it. Today
  `argumentType` is fetched only for the top five, so an atom at rank 6 is
  indistinguishable from an app at rank 6.
- Let a caller ask for one. A `composableOnly` filter, or a rank key that
  prefers a parameterized entry when the query is component-shaped, costs one
  field read.

*Evidence it worked:* the `capability` register's hit@5 and MRR rise while the
`observed` register's do not fall. That is measurable tonight, against this
same set, with no new instrumentation. The stronger evidence is downstream:
composition rate per authoring run, which is currently flat at roughly 1 in 14
regardless of how hard the prose pushes for it. If a session cannot tell an
atom it can wire from an app it cannot, prose telling it to compose gives it
nothing to compose with, and those two measurements are plausibly the same
defect seen from opposite ends.

**2. Stop counting function words as matches.** This costs a stop list and a
word-boundary check. It is the single change that would move the negative
results, and its effect is bounded and predictable: the eight sentence-form
negatives return their function-word matches only, which is nothing. The risk
is real and should be measured rather than argued — with no stop list, recall
is inflated but never zero, and adding boundaries would have cost `doubling`
its match against `Doubles` had it ever had one. Stemming is the fix for that,
and it is a larger change than the stop list.

*Evidence it worked:* dirty negatives fall from 12 toward the 3 the keyword
register already achieves, **while** `observed`-register hit@5 holds at 0.82.
The second half is the whole test; a stop list that also drops real hits has
traded a visible failure for an invisible one.

**3. Normalize `matchedTerms` by query length before sorting on it.** A hit at
7/16 currently outranks one at 3/4. The ratio is already computed and returned;
it is simply not what the sort uses.

*Evidence it worked:* fewer `misleading` failures at fixed hit@5, since the
long sentence queries are where partials currently win.

**4. Do not rank on text the searcher cannot see.** `directQuery`, `rootQuery`
and `parentQuery` are matched against and never returned, which is what makes
`matchedTerms` uninterpretable — and the model is explicitly instructed to
interpret it. Either return them or stop ranking on them. Returning them is
cheap and makes the ratio mean something; that is the version worth trying.

### What genuinely needs new signal

The thumbs cannot be fixed by reweighting, because they have essentially never
fired on anything discoverable: one `thumbs_up` and two `thumbs_down` in the
corpus's life, all three on hidden entries. A weight of 2 on an event that
occurs at a rate of about one per twenty entries is not a ranking signal, it is
a rounding error with a large coefficient.

What the corpus needs first is a signal that distinguishes **"a program ran"**
from **"a program did what it says"**. The measurement shows exactly where that
bites: two static mockups sit at #1 on perfect term matches for real queries,
and no signal the index holds — quality tier, score, event counts, the render
gate — separates them from an entry that works. Ranking cannot solve this,
because the defect is that the description and the program disagree, and
ranking only ever sees the description. That is CT-2107's territory and it is
the dependency, not the consequence.

The second is CT-2109's: an `instantiated` count that means "a harness run
started it" cannot distinguish popular from merely old, since the score is an
unnormalized sum over all time. Any decay or normalization applied to today's
score would be smoothing noise.

### What I would not do

**Do not raise the weights.** The gap between description-match and evidence is
not that evidence is underweighted; it is that 83 of 91 top slots are held by
entries with no evidence at all, so there is nothing for a weight to act on.
Raising the weights would change ranking only among the two entries that have
any, and would make the corpus's oldest test fixture harder to displace.

**Do not exclude `unproven` by default.** It is the state of everything freshly
published, so excluding it empties the index for exactly the unattended
overnight runs the loop depends on to bootstrap.
