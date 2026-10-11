---
status: historical
created: 2026-10-10
archived: 2026-10-10
reason: "Point-in-time record of a re-measurement after six merged PRs, the lunch-poll analysis, the #8660 revert, and the state of its re-landing at handoff."
---

# Server execution: re-measurement, the lunch-poll cost, and re-landing #8660

All figures come from one 4-core container, every run serial with nothing else
on the box, a fresh local toolshed per arm (`--dangerously-clear-all-spaces`).
"ON" is server execution on; where a row says "ON + read-through" the store
read-through flag was on as well. "Base" is 5c8cad1, the commit the
2026-10-09/10 analysis measured. Measurement scripts were kept out of the tree;
the section at the end says how each number was taken.

## What was merged, and what was then reverted

Six PRs from the 2026-10-09/10 analysis merged on 2026-10-10: #8661 and #8662
(CI fixes on main), #8665 (records-preload fixtures transpile under the
repository's options), #8660 (a stream send stops pulling the whole result
root), #8658 (a pending `set` layer is frozen once, at mint), and #8663 (serving
runtimes share one compiled-module byte cache).

#8660 was reverted by #8673. With it, main's CI was red on two lanes:

- **Server-execution lane.** The revert names `fabrichat spaces across
  runtimes` and `Home catalog revisions across execution modes`. The job logs,
  read afterwards, show the fabrichat tests passing in every run that ran
  them, and one failure of the Home catalog test in 1 of 6 runs: a receipt
  read through `sendEvent` and `receipt.pull()` returning before the receipt
  was written, a path `PieceController.set()` does not reach. Both files pass
  on this box with and without the change. The reading of a send that returned
  ahead of the serving runtime's run, which the re-landing below was built on,
  is not what the logs show;
  [the 2026-10-11 record](2026-10-11-server-execution-send-wait-and-session-fan-out.md)
  carries the log evidence.
- **Default lane.** `Topics board demo > opens a topic from its card, follows
  its backlink, and adds a comment the thread shows`, timing out on the
  backlink to the citing topic. The seed stopped deriving each topic's
  published result, and a reader that opens one topic runs only that topic.

## Re-measurement on main with all six merged (576e52f)

Topics seed (`topic-board-seed.ts`, no browser):

| seed | OFF base | OFF | ON base | ON |
| --- | --- | --- | --- | --- |
| 30 topics | 59.9 s | 32.2 s | 89.2 s | 75.6 s |
| 100 topics | 313.8 s | 104.4 s | 491.0 s | 298.6 s |

The ON figures at 576e52f are not comparable to a correct client: that seed ran
about 25 `addTopic` events ahead of the serving loop (75 of 100 index rows
stored when it returned).

Lunch-poll read-scale fixture seed (`seed` event to settled):

| votes | OFF base | OFF | ON base | ON |
| --- | --- | --- | --- | --- |
| 296 | ~46 s | 24.9 s | 48.1 s | 24.4 s |
| 1184 | 160 s | 152.8 s | 584.8 s | 232.2 s |

Vote burst (`lunch-poll-vote-burst.bench.ts`): 5x5 OFF 0.52 s before, 0.58 s
after; 5x5 ON 15.3 s before, 13.8 s after; 10x10 OFF 2.60 s before, 2.07 s
after; 10x10 ON never completes, before or after. No rejected commits and no
rolled-back writes in either arm.

The browser benches (navigation, scale, read-scale; ON + read-through and OFF)
moved within run-to-run noise except as noted above.

## Why the lunch poll is slow under server execution

There was no conflict storm to remove. `castVote` is a keyed write, so the OFF
burst already commits 25 concurrent votes with 0 rejections. What server
execution adds is a second, serial, heavier run of every vote:

- **Every vote is an event the serving loop runs again.** One vote alone costs
  0.45 to 0.57 s of server settle under ON, against 0.08 to 0.13 s end to end
  OFF.
- **The serving runtime settles every session's demand.** A vote dirties the
  vote list and the serving runtime recomputes every demanded instance that
  reads it: 594 at 5x5 and 888 at 10x10, about 120 per session.
- **Cost is linear in votes on one thread.** Five votes from one session take
  4.7 s; five from five sessions 2.8 s; 25 take 12.8 s. All 25 are covered at
  the same instant, since the watermark moves at quiescence of the whole
  cascade.
- **Wave overhead is 15 to 20%.** The 100 ms flush deadline cuts a 25-vote
  burst into 84 waves. With the deadline at 3 s for one run the burst took 6
  waves and 11.6 s instead of 13.8 s. Coalescing events into one wave can buy
  at most that.

Profile of the serving loop over eight 5x5 bursts (135 s busy):

| phase | inclusive | share |
| --- | --- | --- |
| scheduler runs (pattern lifts, map reconcile) | 46.0 s | 34% |
| schema reads inside those runs | 22.4 s | 17% |
| finalize | 17.3 s | 13% |
| resubscribe (`sortAndCompactPaths`, `comparePaths`) | 12.1 s | 9% |
| wave commit to SQLite | 12.9 s | 10% |
| push refresh to sessions | 12.0 s | 9% |
| GC | 7.3 s | 5% |

Lifts with the most time: `poll-option-card.tsx` (4.6 s, 3.4 s of it the
per-option scan of the whole vote list) and four lifts in `lunch-poll/main.tsx`
(about 10.8 s together). Map reconcile spends 4.0 s starting sub-patterns in a
steady-state burst. A voter session's worker is 91% idle over the same run.

The levers, in order: not deriving every session's view on the server for a
vote only one view needs; keyed lookups in place of per-vote list walks in
`poll-option-card` and the `main.tsx` lifts; the finalize and resubscribe path;
sub-pattern starts in a steady state.

## Re-landing #8660: state at handoff

Branch `claude/loving-euler-y7vi89-send-relanded`, the same commits as the
first eight of `claude/loving-euler-y7vi89` (which adds only this record):

1. Reapply #8660.
2. `PiecePropIo.edit()` waits, after a stream send under server execution, for
   the speculation overlay to see that event's terminal consequence
   (`waitForIntentConsequence` under the event's scoped caller id). Pinned by
   `packages/piece/test/piece-controller-served-send.test.ts`.
3. `piece-result-stream-retry.test.ts` stubs that wait beside the event-append
   stub it already had.
4. A stream reached through the input waits the same way, and pulls no result
   root.
5. The Topics seed reads the board's crossref table once after seeding, and
   each topic's whole result once after its mentions.
6. A comment correction in the seed.

Verified on this box at the branch head before the comment correction (2e6ddf2):
repo-wide `deno fmt --check`, `deno lint`, `deno task check` and
`deno task check-skill-facts`; `packages/piece` `deno task test` (77 passed);
`topic-board-demo.test.ts` OFF (28 s) and ON + read-through (35 s, where main
with #8660 timed out at 300 s); `topic-board-seed.test.ts` and
`topic-board-child-contract.test.ts` ON;
`fabrichat-spaces-multi-runtime.test.ts` and
`home-shared-space-catalog.test.ts` under server execution.

Topics seed with the branch:

| seed | OFF | ON |
| --- | --- | --- |
| 30 topics | 27.3 s | 60.1 s |
| 100 topics | 83.7 s | 384.5 s |

The baseline on main after the revert (ebca26e) was not measured; that run was
stopped at handoff. It is the comparison the PR needs.

## Open items at handoff

- **Measure the baseline** on ebca26e (both arms, 30 and 100 topics) and open
  the PR from the re-land branch with both tables.
- **An untracked first intent can hang the wait.** The overlay is created
  lazily. If a client's first act is a stream send, the intent is tracked only
  if the overlay already exists; if the overlay comes into being between the
  send and the wait, the wait has no tracked intent to resolve. The new test
  shows the overlay present before its send, so this did not occur there.
  `Runtime.subscribeEventIntentOutcomes` installs the overlay eagerly and is
  the likely fix: subscribe before the edit, release after the wait.
- **The wait ignores the outcome.** An errored, dropped or refused consequence
  returns like a consequenced one. The behavior before #8660 did not surface
  them either.
- **Red on main that is not #8660's:** `Tests (21/25)` (`stage D
  seal-into-wave > OW31 B3+B4`, red before #8660), and
  `default-app-golden-replay.test.ts` failing about half the time since #8666,
  which asserts a computed `summary` right after `runtime.idle()` where waiting
  on the sink would be event-driven.
- **Analysis targets not landed:** coalescing events into one wave (worth 15 to
  20% of a burst at most, measured above); `backlinksOf` looking its row up by
  topic (no measured effect at 30 and 100 topics); validating a write along the
  path prefix rather than the root (measured as a regression); an incremental
  demand pass; commit-path width (`sortAndCompactPaths`, the deep-frozen
  validity walk).

## How the numbers were taken

- **Topics seed:** `packages/patterns/integration/topic-board-seed.ts` with
  `--topics=N --demand=index --crossrefs=2 --citing-topics=3 --body-words=120`
  against a fresh `scripts/restart-local-dev.sh`, timed end to end.
- **Lunch-poll seed:** the `lunch-poll-read-scale` fixture created through
  `PiecesController`, its `seed` stream sent with `voteCount`, then
  `runtime.settled()` and `synced()`, timed from the send.
- **Vote burst:** `deno bench` on `lunch-poll-vote-burst.bench.ts` with
  `CF_LUNCH_POLL_VOTERS` and `CF_LUNCH_POLL_OPTIONS`; serving-loop counters read
  with `getServingLoopStats()` after each burst.
- **Per-vote probe:** `MultiRuntimeHarness` over the `lunch-poll-keyed-votes`
  fixture, timing each session's `awaitEventConsequences()` and reading the
  serving loop's per-input settle series.
- **Profile:** the bench body run under `deno run --cpu-prof`; the main
  profile is the serving loop, the worker profiles are the voter sessions.
- **Browser benches:** `deno bench` on the topic-board and lunch-poll bench
  files with `HEADLESS=1` and Chromium run with `--no-sandbox`.
