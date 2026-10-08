---
status: historical
created: 2026-10-07
archived: 2026-10-07
reason: "Investigation record of the Estuary toolshed pegged at 100% CPU on 2026-10-07 by four client sessions re-persisting the same computed documents of the shared Topics space with values that differed only in scope; the runtime change that followed is live code."
---

# The Topics space write storm, October 2026

On 2026-10-07 the Estuary toolshed instance serving the shared Topics space
(`topics-dev-476ea34f`, `did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk`)
ran its main thread at about 95% CPU for the whole day, and every client of
that space felt it. This is what the host said, what the space's own history
said, and what the mechanism turned out to be. The runtime change that ends
the loop is described at the end; it is live code and this record does not
describe it beyond naming it.

## The host

Twenty-one toolshed instances run on the host, one per port; nginx routes a
space's websocket to one of them by a consistent hash of the space DID. Port
8020 owned the Topics space. Its `/api/health/stats` at 23 hours of life:

| Row | Count | Total | Mean |
| --- | ---: | ---: | ---: |
| `memory/frame/handle` | 1,997,811 | 69,982 s | 35 ms |
| `memory/frame/queue` | 1,997,811 | 10,127 s | 5 ms |
| `traverse` | 7,844,853 | 1,482 s | 0.19 ms |

The process had spent 19.4 of its 23 hours handling frames. A five-minute
diff of the two additive fields put the live rate at 26 frames per second at
a 62 ms mean. The hundred most recent slow queries were all `transact`
operations on the Topics space, each a single operation with four or five
confirmed reads, each about 180 ms with no lock wait. The document cache for
that space sat at its 65,536-entry cap with 2.0 million evictions and 2.7
million patch replays.

The next busiest instance, port 8008, was not pegged. Its signature was
different: one piece result document in another space re-traversed about
5,700 times in six hours at about 260 ms each, a watch fan-out over a wide
`anyOf` schema. It is noted here because it was the other instance the host's
process list showed, and it is a separate problem.

## The space

The space's SQLite file was 21 GB and held 2.29 million commits. Sampling the
commit sequence against its timestamps:

| Window | Rate |
| --- | ---: |
| 2026-10-02 to 2026-10-06 21:20 | about 0.3 commits/s |
| 2026-10-06 23:02 to 23:39 | about 2/s |
| 2026-10-06 23:39 to 23:49 | about 50/s |
| 2026-10-07, daytime | about 6 to 10/s |

The deploy of `b0649f3d` landed at 23:07 on 2026-10-06. The storm began
thirty minutes later, as the first client sessions came up against the new
build.

The last 600 revisions: 590 of them in the six documents below, grouped by
writing session, document and the spelling of the value written, and the
other ten one-off writes by a fifth session to ten further documents.

| Identity | Session | Document | Value written | Count |
| --- | --- | --- | --- | ---: |
| Robin | `4ba3…` | `computed:…tJfi…` | link, `scope: "session"` | 48 |
| Robin | `696f…` | `computed:…tJfi…` | link, `scope: "space"` | 48 |
| Robin | `4ba3…` | `computed:…iNR5…` | link, `scope: "session"` | 48 |
| Robin | `696f…` | `computed:…iNR5…` | `""` | 49 |
| Robin | `4ba3…` | `computed:…UNwz…` | link, `scope: "space"` | 49 |
| Robin | `696f…` | `computed:…UNwz…` | `""` | 50 |
| Robin | `ec0e…` | `computed:…ZPrn…` | link, `scope: "session"` | 50 |
| Gideon | `5a14…` | `computed:…ZPrn…` | link, `scope: "space"` | 49 |
| Robin | `ec0e…` | `computed:…hFkA…` | link, `scope: "session"` | 50 |
| Gideon | `5a14…` | `computed:…hFkA…` | `""` | 50 |
| Robin | `ec0e…` | `computed:…_vh6…` | link, `scope: "space"` | 50 |
| Gideon | `5a14…` | `computed:…_vh6…` | `""` | 49 |

Six documents, each rewritten in turn by two sessions, each session writing
its own spelling of the same result: a link to the topic's content redirect
spelled at session scope, the same link at space scope, or the empty string
that is the content link's declared default. The last 300 revisions of one
document held exactly two distinct byte strings. Every commit confirmed its
reads and was accepted. Since the storm began, 46,729 distinct computed
documents had been rewritten 671,434 times.

The session-scoped instances of the redirect document that two of the
writers followed were created at 23:38 on 2026-10-06, by those sessions.

## The mechanism

A computation's output is placed by a ratchet on its transaction: the
narrowest scope of the addresses its reads landed on. A reader holding a
session instance of a declared-session position reads at that instance and
its output becomes a session-scoped link in the broad output location. A
reader holding no such instance lands on the broad address, reads whatever it
holds, and its ratchet never moves, so it writes its plain result over the
link. The deep-equal guard on writes does not help: the values differ. Each
session's write invalidates the other's derivation, which re-runs and writes
its own spelling back.

The specification places a computation's output by the narrowest scope of its
input schemas. The implementation placed it by the narrowest instance that
happened to exist for the reader. The two agree for every reader that holds
an instance, and disagree for every reader that does not.

The deploy's change to read an absent link target as the link's declared
default is consistent with the empty-string arm and with the timing, and was
not reproduced in isolation.

## What followed

The transaction now also narrows its read scope at a followed link whose
source position is declared narrower than the link's own scope, so every
reader of such a position places its output the same way; and a broad output
location holding a link to its own narrower instance keeps it, with a
less-narrowed run writing behind the link rather than over it. The
specification's computation rules were amended to say both.

The space's history is unchanged by that: 21 GB and 2.29 million commits,
with patch replays dominating a cold load of it.
