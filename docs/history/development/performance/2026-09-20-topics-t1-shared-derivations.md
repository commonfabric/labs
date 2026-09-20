---
status: historical
created: 2026-09-20
archived: 2026-09-20
reason: "T1's measured result for the Topics computation-cost arc: what sharing the topic body's retraction filter costs and saves, measured against a purpose-built instrument because T0's two tiers cannot see body derivations."
---

# Sharing the Topics retraction filter: T1's measured result

Stage T1 of `docs/plans/topics-computation-cost.md` shares the "not retracted"
predicate that a topic's body applied three times over links and twice over
comments. This records what that changed, and how it was measured.

Every figure below is in
[`2026-09-20-topics-t1-shared-derivations.results.json`](2026-09-20-topics-t1-shared-derivations.results.json)
beside this file — the six derivation samples under `samples`, the probe
comparison under `boardDemandComparison`, and the suite counts under
`behavior`. The two arms are `394db11c23`, T1's merge base, and `933632931c`,
the change.

## Why a new instrument was needed

Neither T0 tier can see this change, and T0 recorded that in advance. The
baseline report says of the rendering derivations:

> In the headless tier they never run. The fixture starts the four lifts
> directly over emulated storage and instantiates no pattern body, so the
> derivations that rendering performs never start, and are absent by
> construction rather than measured at zero.

and of the browser tier, that `hasLinks` and `hasComments` "all fall into the
sample's `remaining` row, which the helper aggregates without keeping any run's
identity." The plan states the consequence: "T1, whose target is exactly these
derivations, has no rendering baseline to improve on."

So the measurement reaches the derivations directly. `topic.tsx`'s hoisted
lifts register by name under the module's content identity, so the arm's
derivations can be resolved from the runtime's artifact index and started over
the T0 fixture's synthetic topics, under the same read accounting the probe
uses. Four topics, `lazyMaterialization` on, `serverExecution` off, demand
`aggregates`, and no mentions, so the pivot contributes nothing.

**The instrument that did this is not committed, deliberately.** It resolves
each derivation by its hoist number — `__cfLift_4` through `__cfLift_7`, and
`__cfLift_32` in the before arm — and hoist numbers are exactly what an
ordinary edit to `topic.tsx` renumbers. A committed instrument naming them
would go on running after the next edit and measure whichever derivations had
inherited those numbers, reporting figures rather than failing. That is a worse
artifact than none.

What stands in for it is the run count below, which is a structural check on
whether the intended derivations were the ones started: it lands on the number
the change predicts, and does so identically at every fixture size. Making the
instrument durable means resolving these derivations by a stable name rather
than by hoist number, which `topic.tsx` does not currently offer for a body
derivation — `presentCommentCountOf`, the one module-scope lift among them, is
the exception and is resolved by its authored name here.

## What it cost before, and costs now

Initialization, the sampler bucket the started derivations' runs land in:

| fixture | measure | before | after | change |
| --- | --- | --- | --- | --- |
| 100 comments, 100 links | proxy accesses | 4,544 | 2,144 | −53% |
| | link resolutions | 2,892 | 1,409 | −51% |
| | registered dependencies | 13,456 | 6,993 | −48% |
| | graph nodes / edges | 967 / 4,584 | 947 / 3,097 | −20 / −1,487 |
| 3 comments, 1,000 links | proxy accesses | 24,076 | 8,052 | −67% |
| | link resolutions | 17,458 | 6,763 | −61% |
| | graph nodes / edges | 4,179 / 21,586 | 4,159 / 10,887 | −20 / −10,699 |
| 1,000 comments, 3 links | proxy accesses | 21,416 | 13,368 | −38% |
| | link resolutions | 10,808 | 6,761 | −37% |
| | graph nodes / edges | 4,179 / 22,912 | 4,159 / 18,861 | −20 / −4,051 |

Warm updates, same bucket:

| fixture | phase | proxy accesses | runs |
| --- | --- | --- | --- |
| 100c / 100l | comment retraction | 530 → 330 | 6 → 6 |
| 100c / 100l | link removal | 603 → 203 | 6 → 4 |
| 3c / 1,000l | link removal | 6,003 → 2,003 | 6 → 4 |
| 1,000c / 3l | comment retraction | 5,330 → 3,330 | 6 → 6 |

**The run count is the check that this measures the intended thing.**
Initialization runs go from 84 to 72 in all three fixtures — twelve fewer,
which is the three removed passes across four topics, and it does not vary with
how many comments or links each topic holds. The proxy-access ratios follow
from it arithmetically: three passes over links become one, three over comments
become two.

## No latency conclusion

The same runs give initialization elapsed times that do not support one. The
after arm at 100 comments and 100 links took 1,401 ms against the before arm's
618 ms — the wrong direction from what the read counts predict. These runs
shared a machine with other work throughout, and a machine under memory
pressure for part of it. The read counts are deterministic and repeat exactly
across rounds; the timings sit in the extract beside them and are not a result.

## Demand narrowed rather than broadening

The stage's third exit condition is that sharing must not broaden board demand.
Four things were compared:

- **The two shared hoists' emitted input schemas**, from `cf check
  --show-transformed`. `hasLinks` went from declaring the whole `TopicLink[]`,
  with the full `TopicLink` and `TopicAuthor` definitions, to
  `{ linksView: { length: number } }`; `hasComments` from
  `StoredTopicComment[]` to `{ commentCount: number }`. Both read strictly less.
- **The four CI read-budget gates**, each gated count inside its limit. These
  gate the lifts the board demands, so they are what would register a widened
  read reaching the board.
- **The topic's own argument and result contract**, unchanged; nothing crossing
  the board/topic boundary moved.
- **The headless probe's 44 cases, run on both arms**, with every count
  identical: 10 cases from `--small` and 34 from a 32-topic and thread filter,
  0 differing. The comparison is on counts, so it sets aside `elapsedMs` and
  the memory gauges, which vary per run and measure nothing this stage changes.
  This is the weakest of the four and is a consistency check rather than proof:
  the probe starts the four demanded lifts and instantiates no pattern body,
  which is why a separate instrument was needed above, so an unchanged probe
  reading shows that nothing this stage did leaked into the demanded lifts —
  not that the body's own demand is narrower. The first item is what shows
  that. The comparison's terms and result are in the extract under
  `boardDemandComparison`.

## Hoist movement

The `handler` and `pattern` sequences do not move. The `lift` sequence goes from
33 hoists to 32, and three things happen in it, which are worth separating
because only the last is renumbering:

- Numbers 1 through 31 all keep their numbers. Twenty-nine of them also keep
  their bodies unchanged.
- Numbers 6 and 7 keep their numbers while their bodies change. They are the
  two shared predicates, and this is the revision the stage makes: `hasLinks`
  from a filter over every link record to `linksView.length > 0`, `hasComments`
  from a filter over every comment to `commentCount > 0`.
- Number 32, the removed third link filter, is gone, and the former 33 becomes
  32. That is the renumbering, and it is a shift of one applied from index 33
  onward — one entry.

The scope of the plan's hoist requirement against the second case was open when
this was recorded. `deno task pattern-vintage` replayed eight vintages, 134
recorded instantiations, with no state stranded.

## Behavior

The stage's first exit condition. Run at `933632931c`, with the before arm's
counts beside them: all nine authored `topics/*.test.tsx` suites, 194
assertions, identical pass counts in both arms — `topics` 56, `topics-rejections`
38, `naming` 31, `state-version` 28, `author-migration` 13, `view-identity` 9,
`multi-user` 7, `render-shape` 6, `author-migration-multi-user` 6.

The headless topics integration suites pass: the four read-budget files (34
steps), and `topic-author-migration`, `topic-board-fixture` and
`topics-headless-fixture` (93 steps). So do all six browser-backed suites —
`topic-retraction-controls`, `topic-board-seed`, `topic-create-onscreen`,
`topic-board-demo`, `topics-navigation` and `topic-board-child-contract` — each
against a toolshed built from the checkout under test, which matters because
these tests start no server themselves and otherwise drive whatever occupies
`API_URL`'s default port.

`deno task cfcheck` covers 361 pattern files, `pattern-compat` 289 patterns,
and `pattern-vintage` 8 vintages, all clean.

## What this does not establish

- Anything about a real board's stored data. The fixture builds synthetic
  topics; the stored-generation evidence is T5's.
- Anything at board scale. Every figure here is four topics, chosen so the
  per-topic derivations dominate; the counts are per-topic and the fixture
  varies comments and links rather than topic count.
- Anything under `serverExecution`. Both arms ran with it off.
