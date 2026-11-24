---
status: historical
created: 2026-10-16
archived: 2026-10-16
reason: "Measurement of a thirty-message FabriChat room's reload before and after the resume pre-sync's inputs documents kept their link schemas as references and each node's binding was held across the load, October 2026: bindings computed and documents minted per reload, and the profile shares of the mint and of the pre-sync, over three interleaved pairs on one machine."
---

# A FabriChat room's inputs documents, October 2026

[`2026-10-16-fabrichat-room-cold-load-phases.md`](2026-10-16-fabrichat-room-cold-load-phases.md)
left the resume pre-sync's inputs-document mint as the next cost of a
room's cold load: every node's bound inputs became an immutable document
with each link's content-addressed schema rewritten to its inline form, so
each document carried 10 to 30 KB of schema and was hashed whole, and the
same node was bound and minted more than once in a load. This record is
the measurement of the two changes that followed, before and after, on the
same room.

## Setup

- The server: `dist/toolshed` built with `EXPERIMENTAL_SERVER_EXECUTION=false`
  baked in, one binary per arm, each over a store directory of its own and a
  port no other session used (8571, 8572), server execution off at both
  ends. The before arm is `main` at `7302d70e64`; the after arm is that plus
  the two changes.
- The room: `packages/patterns/integration/fabrichat-room-seed.ts`, twelve
  members, thirty messages, one thread of five replies, a reaction every
  third message, seeded once on the before arm's store; the after arm's
  store is a copy taken with the server stopped, so both arms load one room.
- The client: the throwaway harness of the record above (a headless browser,
  signed in as the room's starter, the worker profiler attached after
  sign-in, waiting for the last message and every member's badge), writing
  the worker's CPU profile and logger counts per load. Each arm's runner
  carried four temporary `logger.info` lines, not committed: one per call
  of a node binding, keyed by site, by whether a binding of the same
  `(instance, node)` had been asked for before, and by which key member
  differed from that earlier ask; one per binding computed; one per inputs
  document minted.
- The machine: an M3 Max with sixteen cores, its one-minute load 55 to 72
  while the pairs ran. The loads below are the room's second and later; the
  first load after seeding is the untimed row-building load. The three
  pairs ran one load per arm, alternating before and after.

## What the before arm does

On every reload the before arm computed 1,711 bindings of javascript,
passthrough and raw nodes and minted 1,711 inputs documents, for 1,668
first asks: 1,610 nodes bound against a stored argument, 4 against a
stand-in, 52 pattern nodes and 2 pattern nodes against a stand-in. The
repeats, from the key-member trace:

| repeat asks | what differed from the first ask | what the memo did |
| --- | --- | --- |
| 1,596 | nothing | hit, and dropped the binding, since the ask was the instantiation's |
| 180 | nothing | hit where the binding was still held; 79 of these came after the instantiation had dropped it, and computed again |
| 14 | the pattern object and the node object | missed: the instance's own start resolved its pattern by identity, a different object from the one embedded in the parent's graph |
| 4 | the pattern object, the node object, the argument address and its schema | missed: a stand-in instance's instantiation against the argument its setup wrote |

So 97 bindings per reload were computed twice, 79 for the drop at
instantiation and 18 for the pattern object, and every one of the 1,711
mints hashed a document carrying its links' schemas inline.

## Before and after

Per reload, from the runner's counts:

| per reload | before | after |
| --- | --- | --- |
| node bindings computed (javascript, passthrough, raw) | 1,711 | 1,618 |
| pattern node bindings computed | 57 | 57 |
| inputs documents minted | 1,711 | 1,618 |
| `start/syncCellsForRunningPattern` | 2 | 2 |
| `start/resumeListChildSync` | 1,663 | 1,663 |
| `start/resumeCellSync` | 285 | 285 |

The 1,618 are the 1,614 distinct `(instance, node)` pairs bound against a
stored argument plus the 4 stand-in instances bound once more at their
instantiation, which the memo never holds. The 14 asks that differed in the
pattern object still differ in it and hit.

The profile, by the share each frame has of the worker's busy samples
(idle samples left out, since the machine's load set the idle share between
14% and 47%), each pair's before arm then its after arm:

| frame | pair 1 | pair 2 | pair 3 |
| --- | --- | --- | --- |
| `getImmutableCell` | 3.5% → 1.6% | 4.9% → 2.6% | 6.2% → 1.1% |
| `#findSnapshot` | 2.1% → 1.1% | 2.8% → 1.3% | 3.6% → 0.9% |
| `hashStringOf` | 5.2% → 4.4% | 6.3% → 4.6% | 6.6% → 4.8% |
| `#nodePlan` | 7.0% → 4.3% | 8.3% → 6.4% | 10.4% → 3.9% |
| `#syncCellsForRunningPatternInner` | 7.5% → 5.2% | 8.6% → 7.3% | 11.3% → 3.8% |
| `renderRoot` | 16.8% → 15.1% | 15.5% → 15.0% | 17.0% → 12.4% |
| `validateAndTransform` | 14.3% → 13.8% | 13.7% → 12.6% | 12.9% → 14.3% |

The mint's share falls by half in two pairs and by four fifths in the
third, and the hashing under it (`#findSnapshot`) by half or more; the
render's frames move within their noise. Sign-in to the last message rendered, per pair, before then after:
38.7 s → 38.5 s, 27.8 s → 27.0 s, 28.0 s → 25.0 s, at a load where the
same binary spans 25 to 39 s, so the wall times say only that the after arm
was not slower.

## What the after arm still pays

The pre-sync is 4 to 7% of the busy samples where it was 7 to 11%, and the
render's sinks remain the largest frame. Of the 1,618 bindings an after
reload computes, 4 are the stand-in instances' second bindings, which the
memo never holds because the first was against a document no later plan
names. The remaining mint cost is the hash of each inputs document over its
links alone.
