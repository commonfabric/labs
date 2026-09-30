---
status: historical
created: 2026-09-14
archived: 2026-09-14
reason: "Investigation of the August 28 topic-board load benchmark step and the shell readiness notification that removes its polling delay."
---

# Topic-board load waited for a polling tick

The August 28 increase in `topic board/load` came from a browser change exposing
a missed shell readiness notification. The benchmark waited for a JavaScript
property through a DOM observer. Publishing that property did not change the
DOM, so the next check came from the observer's 500 ms fallback interval.

## Historical window

The last run before the step was
[33188792223](https://github.com/commontoolsinc/labs/actions/runs/33188792223),
at `e8f5eaee1`. The first after it was
[33214774858](https://github.com/commontoolsinc/labs/actions/runs/33214774858),
at `0561791db`. The dashboard's cached benchmark artifact metrics give these
samples; durations are means in milliseconds. Rows compare the same processor
model.

| Processor                 | Run                 |  Load |  Board | Journey |
| ------------------------- | ------------------- | ----: | -----: | ------: |
| AMD EPYC 7763             | 33168918012, before | 329.7 | 3556.1 |  5839.5 |
| AMD EPYC 7763             | 33214774858, after  | 807.8 | 2858.9 |  5697.1 |
| Intel Xeon Platinum 8573C | 33188792223, before | 294.2 | 2767.9 |  4930.6 |
| Intel Xeon Platinum 8573C | 33233250032, after  | 766.4 | 2235.4 |  4734.2 |

The 23-commit interval includes
[`28173f01bd`, #6516](https://github.com/commontoolsinc/labs/pull/6516). It
changes `Browser.launch()` to call `astralBinaryPath()`, which selects an
installed Chrome before Astral's downloaded Chrome 125. Unlike the browser
integration workflow, the benchmark workflow in this interval does not set
`ASTRAL_BIN_PATH`.

The earlier Topics investigation inferred that `load` had absorbed work from
`board`, since the full journey had not increased. That comparison alone does
not establish where work ran. The load segment finishes before the benchmark
logs in with the fixture identity. It can reproduce the delay against an
unseeded route, with no board data to render.

## Controlled browser comparison

The same application and harness at `26d867fa0c` were run against Chrome 152 and
the cached Chrome 125 on an Apple M5 Max, macOS arm64, Deno 2.9.4. Both browsers
were headless and each navigation used a fresh profile. The local shell and
toolshed used `serverExecution=false`. Only `ASTRAL_BIN_PATH` changed between
these diagnostic runs.

| Browser    | Page navigation, minimum | Navigation and route wait, minimum |
| ---------- | -----------------------: | ---------------------------------: |
| Chrome 152 |                 127.3 ms |                           635.7 ms |
| Chrome 125 |                 225.6 ms |                           304.3 ms |

These are six samples per browser, taken as a diagnostic comparison rather than
an interleaved performance claim. Current Chrome loads the page sooner, but the
following wait adds approximately 505 ms. The older browser does not show that
half-second wait.

A separate diagnostic recorded the assignment to `globalThis.app` without
changing when the shell performed it. In three current-Chrome navigations, the
property was absent when checked at document times 136.7–140.7 ms and published
at 151.8–154.2 ms. The complete route wait still took 643.0–650.5 ms from the
driver starting navigation. This capture instruments publication and is used to
locate the delay, not to measure the fix.

## Mechanism and correction

The shell's entry module awaits the browser key store, installs navigation, and
then publishes `globalThis.app`. That publication can follow the browser's
document-ready event. `BoardSession.load()` called `waitForPieceView()`, whose
predicate read the global through `waitForCondition()`. Its DOM observer
received no notification for the assignment. Its fallback interval eventually
found the already-ready app.

The correction publishes an explicit shell-ready event immediately after the app
handle. The readiness waiter checks the current value and subscribes to that
event. The route waiter waits for readiness before checking the selected view.
Readiness uses event notifications without the generic waiter's polling
interval; other waiters retain their documented fallback.

The completion condition remains the shell's published handle and the requested
route. It does not require topic cards, sign-in, or a runtime to settle. The
browser-selection change remains in place.

## Same-browser validation

The corrected and original load waits were alternated on the same seeded
30-topic board, with the default two citations from each of three citing topics
and 120 words per body. Both used Chrome 152 on the machine above, a fresh
browser profile per journey, and the same application, fixture, and post-login
operations. The baseline reproduced the original `load()` calls; the corrected
arm used the readiness notification. Pair order reversed on each iteration. One
warm-up per arm was discarded, leaving five samples per arm. No publication
instrumentation ran during this comparison.

| Segment    | Original minimum | Corrected minimum | Original median | Corrected median |
| ---------- | ---------------: | ----------------: | --------------: | ---------------: |
| Load       |         632.2 ms |          154.8 ms |        639.1 ms |         157.9 ms |
| Sign in    |         243.0 ms |          241.0 ms |        245.4 ms |         244.8 ms |
| Board      |         506.6 ms |          503.2 ms |        513.2 ms |         515.1 ms |
| Open topic |         212.3 ms |          211.7 ms |        215.3 ms |         222.1 ms |
| Crossref   |         154.8 ms |          164.5 ms |        166.5 ms |         167.0 ms |
| Journey    |        1768.9 ms |         1302.1 ms |       1791.4 ms |        1317.4 ms |

The removed load delay is approximately 477 ms by the minimum of five. The
complete benchmark journey loses approximately 467 ms. The board segment stays
at approximately 510 ms: the saved load time was a wait in the harness, not
board computation moving between segments. These are local benchmark
measurements, not deployed-product latency measurements.

The focused browser test holds the app unpublished through an early readiness
event, then publishes it without changing the DOM. It checks the resulting state
and removal of the readiness listener. Its page refuses any polling interval, so
restoring the original readiness call fails specifically with
`The shell readiness wait must not poll.` Existing already-published and
non-shell document cases remain covered.

The canonical `topic-board-navigation.bench.ts` completed all six segments on a
newly seeded default board. Its load mean was 161.0 ms and its journey mean was
1336.9 ms. These are a separate validation run, not the alternating comparison
above.

Validation also passed repository-wide `deno fmt --check`, `deno lint`, and
`deno task check`; the shell, integration, and patterns package test tasks; the
shell login integration file, including login while the app is unpublished;
`check-docs-history-index`; and `check-no-waitfor`.
