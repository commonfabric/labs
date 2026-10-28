---
status: historical
created: 2026-10-13
archived: 2026-10-13
reason: "Second measurement of what holding a pattern's schemas deep-frozen removes from a fabrichat room's reload, taken after main began holding a node's binding from the pre-sync to its instantiation, with the first measurement's profiles counted again by samples, October 2026."
---

# A pattern's deep-frozen schemas on a room's reload, measured again, October 2026

[`2026-10-13-pattern-schema-narrowing.md`](2026-10-13-pattern-schema-narrowing.md)
records what a room's reload stopped paying when a pattern began holding its
argument and result schemas deep-frozen, against main at `83c5203f2e`. Later
the same day main began holding a node's binding from the resume pre-sync to
the node's instantiation (`packages/runner/src/node-binding-memo.ts`), so a
reload binds a node fewer times. This records the same comparison against
that main, and counts the first measurement's profiles the way this one is
counted.

## Setup

- The server, the room and the client are the first record's: a local
  toolshed at a port offset with `serverExecution` off, a room of thirty
  messages and twelve members, and a Deno `cf piece render` of the room
  through `skills/perf-investigation/scripts/profile-cf.ts` with a V8
  profile.
- The code: main at `1ed00a44f1` for the base arm, forty-three commits after
  `83c5203f2e`, and that commit with the change for the new arm. The change
  is the builder's deep-frozen schemas, the frozen schema copies in each
  pattern graph the builder's binding walk rebuilds, and the removal of
  `frozenSchemaStandIn()`.
- Two pairs of renders, each pair started together with the arm that started
  first alternating. The machine ran at a one-minute load of 330 to 470, and
  a render took fifteen to thirty-two minutes.

Every share here is of the samples a profile took outside `(idle)`, counted
as samples. The first record summed the time between samples instead. At
this load most of that time is time the process was descheduled, and the sum
weighs a function by where the process happened to be parked: the two base
renders here sum to 1,743 and 775 seconds outside `(idle)` for the same
work, while the sample counts of a function in the two arms of one pair
stay comparable. The first measurement's three pairs are counted again below
for that reason. Their shares by samples differ from the shares the first
record gives by up to 1.2 percentage points for the binding walk, 11.53%
here against 12.77% there in the first pair, and by about half a point at
most for the other functions.

## Shares

| base | pair | arm | samples | `selectReferencedCfcSchemaDefs` | `schemaAtPath` | `unwrapOneLevelAndBindToDoc` | `sanitizeSchemaForLinksInternal` | `factoryFromPattern` |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `83c5203f2e` | 1 | base | 114,904 | 4.36% | 5.05% | 11.53% | 1.78% | 0.68% |
| | 1 | new | 104,874 | 0.62% | 0.83% | 4.82% | 0.46% | 0.76% |
| | 2 | base | 127,666 | 4.43% | 5.10% | 11.71% | 2.28% | 0.66% |
| | 2 | new | 117,413 | 0.68% | 2.06% | 5.09% | 0.50% | 0.75% |
| | 3 | base | 129,276 | 4.51% | 5.09% | 11.46% | 1.80% | 0.73% |
| | 3 | new | 115,215 | 0.64% | 0.83% | 5.16% | 0.49% | 0.80% |
| `1ed00a44f1` | 4 | base | 99,104 | 1.81% | 2.16% | 3.64% | 0.87% | 0.77% |
| | 4 | new | 96,792 | 0.53% | 0.67% | 1.16% | 0.24% | 0.79% |
| | 5 | base | 69,355 | 1.24% | 1.51% | 2.12% | 0.47% | 0.54% |
| | 5 | new | 68,833 | 0.42% | 0.73% | 0.91% | 0.25% | 0.45% |

At `83c5203f2e` the binding walk fell from 11.5–11.7% of the samples to
4.8–5.2%, and `selectReferencedCfcSchemaDefs` from 4.4–4.5% to 0.6–0.7%.
The new arm of each pair took 8 to 11% fewer samples outside `(idle)` than
the base arm it ran beside.

At `1ed00a44f1` the walk fell from 2.1–3.6% to 0.9–1.2%, and
`selectReferencedCfcSchemaDefs` from 1.2–1.8% to 0.4–0.5%. The new arm took
2.3% and 0.8% fewer samples. A reload that binds a node fewer times makes
fewer narrowings for the change to remove. The first record's counts of
narrowings were not taken again at this commit.

The builder's own share rose by 0.07 to 0.09 of a percentage point in each
pair at `83c5203f2e`, for the freezing it does, and moved by less than the
two pairs differ at `1ed00a44f1`.

## The rendered output

At `83c5203f2e` every render wrote the same 232,190 bytes of HTML. At
`1ed00a44f1` the four renders wrote 232,190 bytes each that differ in the
order of the declarations inside `style` attributes and in nothing else:
sorting each attribute's declarations makes the four equal to one another
and to the earlier renders.

The order is not something the change moves. The two base renders differ
from each other in 140 places, and one base render and the new render
beside it are byte for byte the same. An element carrying `hidden="true"`
reads `display: none; gap: 0.25rem; align-items: center` in one render and
`align-items: center; display: none; gap: 0.25rem` in another.
