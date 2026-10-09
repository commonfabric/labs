---
status: historical
created: 2026-10-08
archived: 2026-10-08
reason: "Investigation record: the July 2026 write storms and the quiet weeks after them in the 2026-08-18 export of the Topics social space, replayed through the remote-echo breaker's detector to check its thresholds against the cadence the loops actually ran at; the fixture and test that came out of it are live code."
---

# The Topics export's loops and quiet weeks, replayed through the echo breaker

The remote-echo breaker (`docs/plans/scheduler-remote-echo-breaker.md`) bounds
a loop in which two sessions keep rewriting one document with differing
values. Its detector trips a `(action, document)` pair once that pair has
counted `ECHO_TRIP_THRESHOLD` changed rewrites within `ECHO_WINDOW_MS`, and
the design set those at twelve within ten seconds from the space-wide rate of
the 2026-10-07 storm. This record checks that choice against what the Topics
social space (`topics-dev-476ea34f`) actually wrote, using the one copy of its
history on hand: the export of 2026-08-18, which holds the space from its
creation on 2026-07-09 through the three storms of July and the three quiet
weeks after them. The October storm itself is not in the export; what its
investigation record says about it is used where it bears.

## What the export holds

325,549 commits and 385,408 revisions over 44,350 documents, by 1,817
sessions. Grouped by day, the commit count is flat at a few hundred to two
thousand except on five days:

| Day | Commits | Shape |
| --- | ---: | --- |
| 2026-07-10 | 43,293 | 3 result slots, 6 sessions, 5 link spellings |
| 2026-07-21 | 75,066 | 18 result slots, 6 to 8 sessions each, 3 to 5 spellings |
| 2026-07-22 | 106,976 | 15 result slots, 2 sessions each on 7 of them, 2 spellings |
| 2026-07-24 | 61,737 | 7 result slots, 2 sessions each, 2 spellings |
| 2026-07-27 | 15,037 | 7 result slots, 2 sessions each, 2 spellings |

Each heavy day is a handful of documents rewritten tens of thousands of times.
Every one of those documents is a piece result slot (an `of:` document whose
`/value` holds a link), and every rewrite replaces that link with another
spelling of it: a link to a different session-scoped instance, or to a
different computed document. The same document holds exactly as many distinct
values as there are writers that disagree, and consecutive revisions
alternate between them. This is the shape the 2026-10-07 record describes for
October, three months earlier and with a different trigger.

The quiet weeks, 2026-07-28 to 2026-08-18, hold 15,700 commits. No document
was written more than 539 times in them, and the busiest documents are a cold
board load re-persisting user-scoped derivations once per session.

## The cadence per session

The breaker counts per session, because each session is its own runtime with
its own breaker, and per document. What matters to its window is therefore
how often one session rewrote one document, not how fast the space moved. For
the five most rewritten storm documents, over each one's busiest hour:

| Document | Day | Sessions | Busiest session's echoes | Per 10 s |
| --- | --- | ---: | ---: | ---: |
| `of:fid1:XEmjo…` | 07-22 | 2 | 4,673 | 13.0 |
| `of:fid1:aY7Ks…` | 07-21 | 8 | 7,323 | 20.3 |
| `of:fid1:AFIqG…` | 07-24 | 2 | 1,302 | 3.6 |
| `of:fid1:761KP…` | 07-21 | 7 | 996 | 2.8 |
| `of:fid1:c8bVT…` | 07-21 | 8 | 994 | 2.8 |

Two of the five loops ran fast enough to put twelve echoes in a ten-second
window many times over, and a third reached twelve in exactly one of its
ten-second stretches. The other two ran at about three per ten seconds, for
hours, and wrote more than five thousand revisions each. A loop's cadence is
set by the round trip between the two sessions through the server, and a
server already busy with the loop answers slowly: the July 24 document
alternated once every two seconds between two sessions of one identity for
three days.

The October record gives the space-wide rate as six to ten commits per second
in daytime, spread over twelve `(session, document)` pairs in its last six
hundred revisions. That is under one echo per second per pair, five to eight
per ten seconds, which is also under the threshold.

## The replay

`packages/runner/test/fixtures/topics-echo-traces.json.gz` holds two minutes
of each of the five storm documents and every document written four or more
times in the quiet weeks, as `[session, seconds, valueIndex]` commits. The two
fast documents are at their densest two minutes. The three slow ones are at
the two minutes of their busiest hour closest to that hour's average density,
because their densest two minutes run at five to six echoes per session per
ten seconds, twice the cadence they sustained for hours, and a window held to
a peak would be held to the wrong thing.
`packages/runner/test/scheduler-remote-echo-breaker-traces.test.ts` replays
each document through one `RemoteEchoBreaker` per session, counting a commit
as an echo step when it changed the document's value and as a convergence
step otherwise. For the storm documents, whose every commit was a derivation
rewriting the document that had just re-triggered it, that is the count a
breaker on the session would have kept, on the assumption that one action per
session wrote the slot; for the quiet ones it is an upper bound, since the
export records what was committed and not what triggered the run. Feeding
every commit, including those a tripped breaker would have deferred, can only
raise the count.

The breaker's window opens at a pair's first counted echo and the count starts
over once it has run out, so a steady cadence of one echo every `p` seconds
trips only when `floor(window / p) + 1` reaches the threshold: at a minute and
twelve, a period of 5.45 s or shorter, about 2.2 echoes per ten seconds.

The window swept against those traces, with the threshold at twelve:

| Window | Storm documents tripped | Quiet documents tripped | Quiet reactive max cycles |
| ---: | ---: | ---: | ---: |
| 10 s | 2 of 5 | 0 of 201 | 3 |
| 20 s | 3 of 5 | 2 of 201 | 4 |
| 30 s | 4 of 5 | 2 of 201 | 4 |
| 40 s | 5 of 5 | 2 of 201 | 4 |
| 60 s | 5 of 5 | 2 of 201 | 5 |
| 120 s | 5 of 5 | 2 of 201 | 7 |

"Quiet reactive max cycles" is the most changed rewrites any one session put
on one space- or user-scoped document inside the window. The two quiet
documents that trip at every window of twenty seconds or more are the same
two in each row: session-scoped draft cells that a person typed into, up to
ten commits in ten seconds and a hundred in five minutes. Those are an event
handler's writes, which the breaker never classifies, so the replay's trip on
them is the over-approximation and not a false positive the breaker would
produce. With no window at all, derivations that legitimately change over
days would trip: a board title recomputed as topics were added, a timestamp
cell rewritten on each cold load, and the user-scoped document one session
changed 57 times in three weeks. A window is what separates a loop from a
slow drift. Forty seconds is the shortest one in the sweep that catches every
July loop at the cadence it sustained; sixty leaves margin for a window that
opens between two of a slow loop's echoes, and keeps the honest maximum at
five against a threshold of twelve.

## Two probes of the runtime on the branch under review

Two attempts to manufacture the loop through a compiled pattern rather than a
hand-written effect, on the branch carrying the breaker with the placement fix
of commonfabric/labs#8553 merged beneath it:

- Two runtimes running different versions of one program against one result
  cell converge: the source reconciler moves the first runtime onto the second
  program, and both then derive the same value.
- Two runtimes running one program under different `computedCellIds` postures
  do not loop either.

The placement split that drove October is fixed, so no trigger the branch
still carries produces the loop through a pattern. What does reproduce it is
an effect that only writes a shared document, with no read of its own: the
write's diff-base read is a scheduling dependency, so the other session's
commit re-triggers the effect, and two such effects with differing values
loop at one commit per exchange. That is the self-referential shape the
breaker keys on, and it trips at the same exchange with or without an explicit
read.

## What followed

The window was widened to sixty seconds with the threshold left at twelve,
the quiet reset was derived from the window and the backoff cap together so
that it stays longer than both, and the trace replay test holds the detector
to every storm document in the export and to none of the quiet reactive ones.
