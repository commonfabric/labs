# Test waits: rationale and case studies

[waiting-in-tests.md](waiting-in-tests.md) is the working guidance for waiting
in tests: the primitives that resolve on real events, the harnesses that
control time, the check that keeps new polling `waitFor` out of the
integration suites, and the catalog of places where a bounded poll stays.
This document holds the analysis behind that guidance: the full argument for
why a bounded timeout is never a guarantee, the sizing of the one backstop
that argument bears on hardest, how the runner clock classifies timers across
SES lockdown, the real-clock exemptions that were retired and what each hang
turned out to be, why the runtime-client suite keeps the real clock, why
neither runtime-disposal teardown carries a bound, worked
examples studied in enough depth to copy — proving a negative in the CSP
suite and the FUSE exec suite's design — how a pattern-test assertion comes to
be read exactly once, and the production waits that apply the same principle
outside tests.

Nothing here is needed to write an ordinary test. Come here when you need to
know why a rule is what it is, or before changing the machinery a rule
describes.

## Why a bounded timeout is never a guarantee

This is the full argument behind [Wall-clock time is not a measure of
progress](waiting-in-tests.md#wall-clock-time-is-not-a-measure-of-progress):
why no fixed bound, on any clock, can tell "stuck" from "everyone was
stopped."

A timeout counts wall-clock time, and wall-clock time diverges from real
progress whenever the world outside the process pauses. A laptop is closed and
reopened. A CI virtual machine is paused for an hour of host maintenance, or
is live-migrated to another host, and resumes where it left off. A container
is frozen by the cgroup freezer or a checkpoint. The clock is stepped by NTP.
Each of these advances wall time — sometimes by a large, arbitrary amount —
while the timed operation did not run at all, so a timeout fires on it exactly
as it would on a genuine hang.

This is a stronger objection than "the machine might be slow, so pad the
bound." Slowness you can pad against; a clock discontinuity you cannot,
because no fixed bound survives an arbitrary jump — a suspend one second past
the deadline trips a fifteen-second bound as surely as a one-second one. A
bound sized "comfortably above how long the operation ever takes" is therefore
safe against slowness only, not against this. The exposure also turns on
details you do not control: GNU `timeout` arms a `CLOCK_REALTIME` timer, which
counts suspend time, so the bound fires on resume; a `CLOCK_MONOTONIC` bound
would survive a suspend-to-RAM but not a frozen process whose system clock
kept running. No clock is safe against every kind of pause.

So a bounded timeout is never a guarantee, only a heuristic with a real
false-positive mode. That is what grounds the acceptability test [the main
document](waiting-in-tests.md#wall-clock-time-is-not-a-measure-of-progress)
states — not "is the bound comfortably large" but "is firing early safe" — and
the two kinds it sorts bounds into: the harmless early fire, which only
repeats work, and the harmful one, which fails a passing test, drops a real
result, or corrupts state.

Those two kinds map onto the bounds the repository keeps. The shutdown
escalation in [the FUSE mount handshake](#the-fuse-mount-handshake) keeps a
bound whose early fire is harmless — it `SIGKILL`s a child that was already
exiting, reaching the same end either way. The rest — the polling waits under
[Where the polling `waitFor`
stays](waiting-in-tests.md#where-the-polling-waitfor-stays) and [the FUSE
cleanup's teardown
bound](#cleanup-hard-kills-on-a-failure-unmounts-gracefully-on-a-pass) — keep
a bound whose early fire fails the run. They exist because no event reports
the condition they wait on, so a large-enough clock jump can trip one on a
healthy run and fail it. That is a fragility we accept for want of an
alternative, sized so only a multi-minute jump reaches it — not one we have
designed away. The deno-web-test per-test stuck detector ([next
section](#sizing-the-deno-web-test-backstop)) is another bound of this kind,
and the most exposed: a competing ceiling keeps it from being sized that high.
When an event boundary does exist, use it, and neither kind of exception
arises.

## Sizing the deno-web-test backstop

[Browser-hosted unit tests have a harness
backstop](waiting-in-tests.md#browser-hosted-unit-tests-have-a-harness-backstop)
describes the `testTimeout` bound `packages/deno-web-test` places on each
test. This section records what the bound replaced and the competing ceiling
that sizes it.

Without the harness bound, a stuck test ran until astral's retried deadline on
`page.evaluate` ran out of attempts, 53 to 57 seconds later, and threw a
`RetryError` that named no test, printed no summary, and abandoned every test
file still queued.

That deadline is on every `page.evaluate` a browser test makes, not only the
ones this harness issues, so it is worth knowing what it comes to elsewhere.
Astral wraps the protocol call in `retry(() => deadline(call, timeout))` over
a promise it creates once, so the five attempts re-wait on that same in-flight
call rather than reissuing it: the evaluate runs once, and an answer that
arrives late is still returned by whichever attempt is live for it. What
differs between harnesses is the timeout. `deno-web-test` leaves astral's own
ten seconds, which is where the fifty-second floor above comes from.
`packages/integration`'s `Browser.launch` writes sixty seconds onto the page
instead, so an evaluate the browser integration suites make ends after five
minutes of deadline plus up to fifteen seconds of the retry's backoff. Neither
is a bound this repository keeps, and neither wants a second one underneath
it.

By the test in [the section
above](#why-a-bounded-timeout-is-never-a-guarantee), the harness bound's early
fire is not safe: it fails a passing test. So it is a bound kept for want of
an alternative, alongside the polling waits and the FUSE teardown bound —
there is no event for "this test will never finish." It is the worst-placed
member of that group, and the reason is worth stating plainly. Those other
bounds sit so far above their work that only a multi-minute clock jump reaches
them. This one cannot: astral's own deadline runs out around fifty seconds and
takes the run down unnamed, so the bound has to fire below that, and a clock
jump between the bound and fifty seconds fails a healthy test. Astral's retry
would have ridden that jump out — it re-wraps the same evaluate across five
attempts, so a test that finishes late is still returned — where this single
timer does not. The bound is kept only because astral's un-named, whole-run
failure is the worse outcome on a genuine hang, not because it escapes the
clock-jump fault.

That trade is what sets the default, and it sets it high rather than low. The
window in which this bound fires but astral would not is exactly the gap
between the bound and astral's floor, so the bound wants to sit as close under
that floor as reliable naming allows — the opposite of the "leave a wide
margin" instinct, which here only widens the exposure. Astral's floor is a
hard fifty seconds, five ten-second timers that no machine runs through
faster, so forty seconds clears it with room for the retry's backoff on top
while keeping the clock-jump window down to about ten seconds. The slowest
healthy test in any of these suites is about a second, and that one is
deliberately waiting out a timer, so real work never approaches forty. A suite
that somehow needs more should raise `testTimeout`, and keep it under the
fifty-second floor.

## How the runner clock classifies timers across SES lockdown

[The runner suite's fake
clock](waiting-in-tests.md#the-runner-suite-advancing-the-runtimes-own-timers)
sorts each positive-delay `setTimeout` by who scheduled it, reading the
scheduling frame from a stack trace — and that has to keep working after a
runtime is running. SES's `errorTaming` blanks `new Error().stack` from the
first `Runtime` a test builds onward — safe taming still captures each error's
frames but hides them behind the tamed `stack` accessor, which reads back
empty for the rest of the process. So the harness does not read the frame that
way. It reads it through `getStackString`, the hook SES installs on the global
during lockdown, which still returns the real frames after the plain accessor
has gone empty; the runtime's own error mapping reads stacks through the same
hook. A positive-delay `setTimeout` written in test code is therefore
classified as a `test/` timer and freezes across the lockdown boundary,
exactly as it does before any runtime exists.

## The runner clock: retired exemptions and converted waits

The runner preload's `realClockFiles` list names each file that stays on the
real clock and its reason; [the main
document](waiting-in-tests.md#the-runner-suite-advancing-the-runtimes-own-timers)
describes the one current entry. The histories below record entries and
wall-clock waits that were retired rather than justified. Read them before
adding a new entry: each of these looked timing- or transport-bound from the
failure, and was not.

The list used to carry two more entries, for a reason worth recording because
it shows what a production deadline costs a test suite. Both held tool-calling
cases whose delegate runs a child agent against a result schema the model
supplies in the tool input, so the child could not form its own request until
that input had settled through the graph, and the round trip carried the
delegate's completion across a macrotask boundary. The pump read that boundary
as an idle event loop and jumped logical time to the earliest pending
production timer, which was the deadline the tool-calling path armed around
its wait, and the delegate aborted while its child was still in flight.
Retiring that deadline retired the exemptions with it. ([Retiring the LLM
Tool-Call
Deadline](../history/development/proposals/retiring-llm-tool-call-deadlines.md)
is the archived proposal.)

A frozen wall-clock guard converts rather than exempts. [The main
document](waiting-in-tests.md#the-runner-suite-advancing-the-runtimes-own-timers)
notes that a `setTimeout(reject, ms)` guarding a wait freezes along with every
other test sleep and backstops nothing; the remedy is to resolve the wait on
the event itself and let a signal that never arrives quiesce the loop. That is
what let the multi-space mergeable-commit test move onto the fake clock — its
retry backoff is a `src/` timer that auto-advances, and the
fast-fail-versus-windowed distinction it checks is decided by the rejection's
error type rather than by elapsed time, so collapsing the backoff timing
preserves the outcome each case asserts.

A third exemption was retired rather than justified. The
`list-resume-container-defer` suite looked transport-bound — a resuming
runtime over a loopback memory client that never settled under the fake
clock — but the hang was the test's own design. Its transport withheld the
result-container document from the resuming client's syncs while the server
still held it, a state no client can reconcile: every commit carrying the
client's read of that document as absent at seq 0 is rejected as stale, the
catch-up the rejection waits on can never deliver the withheld document, and
the retry loop runs forever. On the real clock the test passed anyway, because
the server's effect-batching timer left short quiet windows in each retry
cycle in which `runtime.idle()` resolved and the test read its locally
recovered value; the fake clock's auto-advance closes those windows, so the
wait for quiescence never returned. The fix modeled the scenario the suite
claims — a container that was never persisted — by redirecting the container's
operations out of the first runtime's commits, so the server genuinely never
stores the document, the resume's seed write is accepted, and the system
settles on both clocks. The suite's sequence tests do still withhold the
server's answers about that one document — but bounded, and released within
the test: the hold proves the recovery waits for the absence confirmation
before writing, and it ends before any retry can accumulate against the
withheld answer.

## Sizing the auto-advance runaway ceiling

Auto-advance turns a `src/` backoff into a hot loop whenever the condition it
retries against cannot change — a withheld document, a commit that will be
rejected the same way every round. Each round arms a fresh timer, the pump fires
it on the next turn of the event loop, and the cycle allocates. Left to run it
ends as a V8 out-of-memory abort, which names no test and leaves nothing to
read.

The ceiling therefore has to sit below the point where such a loop exhausts the
heap, not at a round number far above it. Measured across the runner suite, the
heaviest user of auto-advance, one test reaches 160 fires and every other one
stays under a hundred, so a ceiling an order of magnitude above that separates a
livelock from every healthy test while still tripping long before memory runs
out. The error names the arming site that accounted for most of the fires, which
is the frame worth having: in a stalled resume it is the storage layer's
conflict repair or the memory server's refresh scheduler, and either one
identifies the condition that cannot clear.

A test that legitimately advances through many windows should say so with
`clock.tick(ms)` rather than lean on the pump. One whose work logical time
cannot pace at all belongs in `realClockFiles`.

## The pump waits for the loop to go idle

[The runner
clock](waiting-in-tests.md#the-runner-suite-advancing-the-runtimes-own-timers)
fires a production timer only once every zero-delay turn that was armed has
run. What that ordering protects is any wait that races an event against a
deadline where the event arrives across several turns and the deadline is one
`src/` timer.

The conflict read-repair wait in `packages/runner/src/storage/v2.ts` is that
shape. A commit the server refuses for a stale basis carries a retry gate, the
caught-up frame the server stages for the session, and the storage layer holds
the rejection until that frame has landed — or until a 30 s backstop lets it
through with the replica still behind, logging one warn its module logger sits
above. The frame crosses the loopback transport a turn at a time, and the
memory server's refresh takes turns of its own, so at the moment the rejection
arms the backstop the frame is still several turns away.

A pump that fired the earliest production timer on the next turn of the real
event loop, whatever zero-delay turns were still queued, fired that backstop
between those turns. Instrumenting the race across the runner suite found 371
such waits: 33 of them the backstop arm won, each with exactly 30 s of logical
time elapsed and the frame landing at that same instant, queued behind the
jump, and 12 more the caught-up arm won only because a sibling wait's jump had
already moved the clock. Every one of those tests passed. One, the refused
`fetchProgram` takeover, passed only because the jumps had aged a claim that
the test's own `clock.tick` was written to age; with the turns run first, the
same test hung on an event its fixture never produced — which is the failure
its design had always described, and the test now ages the claim before the
run that reads it.

So the pump yields. When a zero-delay turn is armed, or a kick is queued to
run one, it re-queues itself behind the kick and looks again, and it jumps
only when no turn is left. A turn chain that never ends starves the pump
rather than hanging the test: past `AUTO_ADVANCE_STARVATION_LIMIT` consecutive
yields it throws, naming the condition, as `settle()` does for zero-delay work
that regenerates. `packages/runner/test/clock-preload-auto-advance.test.ts`
pins the ordering, and the SES-lockdown classification pin waits on the
`src/` sleep it arms rather than on one turn, because one turn no longer
carries a jump.

Two convergence tests drained in fixed rounds of round trips — `pull()`,
`idle()`, `synced()` — and read the value at the end. Such a loop never lets
the loop go idle, so under the idle rule the memory server's refresh never
fired inside it and the value never arrived; on the real clock the refresh
fires on wall time, in the middle of whichever round is running, which is the
dependence the fixed rounds had been riding. Both now wait on the value they
converge to, through `waitForCellValue`, which idles the loop between
committed changes and so fires the timers the convergence rides on. The pump
also fires every production timer armed for the instant the clock stands at:
two armed together for one instant both fire, where the second had been passed
over as already past, and the same pin file holds that.

The ordering makes the read-repair wait resolve on the frame, at one refresh
cadence of logical time. It does not make the backstop's firing visible when
the frame genuinely never comes; that is the silent-backstop guard's job,
described in [the main
document](waiting-in-tests.md#a-production-backstop-cannot-carry-a-test).

## Why the runtime-client suite stays on the real clock

`packages/runtime-client` keeps its unit tests on the real clock, and the
reasons are worth recording because the package looks, at a glance, like a
candidate for the runner preload. [The main
document](waiting-in-tests.md#the-runtime-client-suite-stays-on-the-real-clock)
states the working rules; this is the analysis behind them.

Most of its tests need no wait at all, or only a macrotask drain — a
`setTimeout(fn, 0)` that lets the scheduler's own `queueTask` dispatch land,
an awaited round-trip, or a sink fire once. Those drains cross one macrotask
boundary, carry no real-time floor, and stay as they are. The two
positive-delay sleeps that were not drains have been made event-driven
instead. The test that proves `dispose()` stays pending until the worker
confirms its flush now drains the task queue rather than sleeping ten
milliseconds: nothing resolves the held Dispose reply, so once every queued
continuation has run a correct dispose is still pending. The pending-request
age-ordering test steps a frozen `performance.now()` forward between its two
sends rather than sleeping, so the first request is measurably older and the
descending-age sort is exercised deterministically — with equal ages a stable
sort preserves insertion order whichever way the comparator runs, leaving the
direction untested.

Two tests genuinely measure real time and cannot move to a fake clock: the
main-thread loop-lag probe (`loop/mainLag`, armed in `client/connection.ts`)
and its worker twin (`runner.loop/workerLag`, armed at the
`backends/web-worker` entry). Each arms a 100-millisecond `setInterval` and
records how far past schedule a tick fires; each test blocks the thread with a
busy-wait past one sample so the due tick can only fire late, then reads the
recorded lag. A fake clock fires timers exactly on schedule, never late, and
cannot advance while a synchronous busy-wait holds the thread, so it cannot
reproduce loop lag at all. These stay on real wall-clock time, and their
busy-wait plus short trailing yield is the honest way to observe a late fire.

The package also cannot adopt the runner preload wholesale. Those two loop-lag
intervals are armed unconditionally — in the connection constructor and at the
worker entry's import — and only unref'd, not gated behind an off-by-default
flag the way runner's one repeating timer is. Unref keeps them from tripping
Deno's op-leak sanitizer under the real clock, but auto-advance ignores unref:
a `setInterval` scheduled from `src/` re-arms forever, so every connection a
test builds would drive the clock to the runaway guard. Adopting the harness
would mean excluding the very files that own timers, and no test in the suite
observes a controllable time window a fake clock would help with.

## The runtime disposal teardowns

[Tearing a runtime down waits on its
worker](waiting-in-tests.md#tearing-a-runtime-down-waits-on-its-worker) states
what the two teardowns do. This is the analysis behind the part of it that
looks like an omission: the failure each is exposed to is a worker that
answers nothing, and neither carries a clock.

The browser half needs none because it already has one, astral's, described in
[the section above](#sizing-the-deno-web-test-backstop). Not capping a slow
call is what makes that bound tolerable, and the property is astral's rather
than ours.

So what the browser half was missing was never a bound but a name. A
`RetryError` names no request, and the teardown that catches it is cleanup, so
a run ends with a warning that says a disposal failed and nothing about why.
Reporting the page closes that, because `RuntimeClient.getPendingRequests` is
main-thread bookkeeping: the request records live on the page's side of the
boundary, and reading them asks the worker for nothing. A worker that has
stopped answering is the case the read still answers, and what it answers with
is the disposal's own request and its age.

The in-process half is the one where a bound is arguable, and the argument is
worth setting out because the first two objections to it are weaker than they
look.

The first is that an early fire drops writes. It would: the reply the teardown
waits for is the worker's confirmation that it has flushed, so terminating the
worker before that reply arrives loses whatever was still buffered. How much
that is, the main thread cannot tell. The worker flushes before it replies, so
a reply that never arrived leaves every state open: nothing written, part of
it, or all of it with the reply lost afterwards.

What narrows the objection is not how far the flush got but what terminating
adds to it. A worker that is genuinely stuck writes nothing further whether it
is terminated or left alone, so a bound firing on one costs only the wait it
ends. The exposure is the slow-but-healthy disposal — a large flush, a
contended machine, a clock jump — which a bound would kill mid-flush, losing
writes that were still on their way. In this suite even that is local: each
test opens a space under a fresh random name and disposes as the last thing in
its scope, so no later read reaches the writes a killed flush dropped. By the
test in [Wall-clock time is not a measure of
progress](waiting-in-tests.md#wall-clock-time-is-not-a-measure-of-progress),
an early fire there is safe.

The second is the cost of writing it. The teardown is `dispose()` itself,
reached through `Symbol.asyncDispose` at every `await using` in the file, so a
bound has nowhere to sit that is neither production code — which would put a
clock back on the path production deliberately does without — nor a change to
what the file's helper hands back at every one of those bindings.

What settles it is neither of those. It is that a hang there is already
placed, and a bound adds one fact to that. Deno's runner prints a test's name
when it starts and its verdict when it ends, so the last test printed without
an `ok` is the one whose teardown is waiting, and what it waits for is a
`Dispose` reply by construction — that is the only request a teardown sends.
A bound would add the age of the wait, which the step's own duration already
gives, and it would add a timer on a cleanup path to do it. The step limit
ends the run either way. The runner prints that name unbuffered only while it
runs the file's tests in sequence, which is what this package's test task
does; `--parallel` withholds it.

Two claims there were checked rather than assumed, because the whole argument
rests on them. A live `Worker` holds Deno's event loop open, so the fail-fast
that [the primitives
section](waiting-in-tests.md#the-primitives-to-use-instead) relies on for
in-process waits does not fire: a test awaiting a promise nothing resolves
fails on its own in milliseconds, and the same test with a live `Worker`
beside it runs until it is killed. That run's output ends at the test's name
followed by its `...`, which is the line a reader places the hang by.

## Proving a negative: the CSP suite as a worked example

[Proving a negative](waiting-in-tests.md#proving-a-negative) gives the shape:
send a barrier that must arrive after the event being ruled out, wait for the
barrier, and pair the conversion with a control that can fail. The
iframe-sandbox CSP suite
(`packages/iframe-sandbox/test/iframe-csp.browser.test.ts`) is the worked
example of how much checking both requirements take.

The barrier has to be genuinely ordered after the event, which is a claim
about the specific mechanism and not about elapsed time. The CSP suite is a
good illustration of how far that varies for one browser and one policy: a
blocked `<img>` or `<link rel=stylesheet>` reports its violation before the
document's load event, while a blocked `<script src>`, an image a stylesheet
asks for, and a `fetch()` all report theirs after it. A `fetch()` is the
extreme — its violation lands a macrotask turn after the request has already
rejected, so no marker the page can post is ordered after it. Where no such
ordering exists, say so and leave the case on its interval rather than
inventing a barrier that only looks like one; `unbarrierable` in that file
records the cases that stay.

A barrier that is not really ordered after the event fails silently: the test
goes on passing while asserting nothing. Pair the conversion with a control —
the same fixture and the same wait against input that does trigger the event,
which must observe it by the time the barrier lands. `barrierControls` in the
CSP suite is that check. Moving its barrier earlier leaves every negative case
green while the controls that can speak to ordering go red, which is the point
of having them.

Which controls those are is worth working out rather than assuming, because a
control can be written so that it cannot fail. Only an event that can arrive
after the page's own scripts have run tests the ordering at all. Two of that
suite's eight controls are of that kind; the other six raise their error from
a synchronous throw while the document parses, which no barrier could be
posted before, so they stay green however early the barrier moves. They still
earn their place — they show the error channel is live for their fixture's
shape — but they are evidence of that and not of ordering. Sort them
deliberately and say which is which, or the group reads as proof it does not
supply.

## The FUSE exec suite

`packages/cli/integration/fuse-exec.sh` appears in [Where the polling
`waitFor` stays](waiting-in-tests.md#where-the-polling-waitfor-stays) for its
poll loops: a shell script observing another process through a kernel mount
has no event channel to convert them to. The three studies below cover the
rest of the suite's design — an assertion that cannot rest on the cell value,
a teardown that must not hang on the mount it is tearing down, and a status
file that would tempt a poll the suite does not need.

### The stale-descriptor assertion reads the daemon's trace, not the cell

The stale-descriptor assertion — that truncating a path does not let an
already open descriptor write its old buffer back — asserts that something
does not happen. It needs no delay, and the reason is specific to how the
daemon's write path is built.

Both truncate paths — `open` with `O_TRUNC` on Linux, and the handle-less
`setattr` that FUSE-T issues on macOS — reach `handles.truncateByIno`, which
empties the buffer of every handle on the inode and clears `dirty` on all of
them, leaving `truncatePending` set only on the truncating handle.
`flushHandle`, `flushCb` and `releaseCb` all gate on `dirty ||
truncatePending`, so a descriptor with both clear is inert. A descriptor that
stayed armed instead flushes from the callback the kernel sends on `close()`.

The cell value cannot carry that assertion, for two separate reasons.

The first is that the value cannot see the likeliest regression at all.
`truncateByIno` empties the buffer of every handle on the inode
unconditionally and gates only `truncatePending`, so a descriptor left armed
holds an empty buffer and flushes `""` — byte-identical to what the truncate
wanted. Drop the `{ pendingFh }` argument at any of the three call sites in
`mod.ts` and every handle arms; the descriptor then writes back on `close()`,
and a check on the settled value passes every single time. That regression
also passes every test in `handles.test.ts`, which calls `truncateByIno`
directly and so never exercises a call site — and which blesses the
argument-less form besides.

The second applies when the buffer does survive to be written. The armed
descriptor's write and the truncate's write are then two fire-and-forget
optimistic transactions racing for the same cell: `PieceController.set` calls
`runtime.editWithRetry`, which applies the write to a transaction
synchronously and then commits asynchronously, and a commit that loses a
conflict re-runs the callback and re-applies its own value. The value settles
on whichever write reaches the server second, and nothing in the daemon orders
that. Issue order makes the stale write the likely winner, but "likely" is
what a test must not rest on.

Waiting for the truncate's `""` to land before closing the descriptor does not
rescue the value check either: it makes the cell hold `""` at the moment of
the close, so a poll for `""` succeeds before the stale write could arrive.
Any "the value stays `""`" check needs a barrier proving the stale write has
landed if it was going to, and the retry-on-conflict behavior above means no
later write supplies one — a write issued after the stale write can still
commit before it.

So the assertion observes the disarm where it happens, in the daemon's
`[write-trace]` log. `releaseCb` traces the handle's `dirty`, `flushing` and
`pending` fields before it decides anything, so that one line states whether
`close()` found the descriptor armed. It says so on either truncate path, and
whichever callback ends up doing the flushing. The script resolves the handle
number from the `write` line its own `printf` produced, waits for that
handle's `release` line, and requires it to report `pending=false` — the gate
itself — and `flushing=false`, since a flush already in flight carries the
buffer it copied when it started, which the truncate cannot recall.

The write and the truncate have to reach the descriptor's handle with no flush
between them, or the buffer never survives to the close the assertion is
about. That is why the script issues both under one redirect of the
descriptor's fd rather than writing through a transient `>&9`. On Linux the
kernel sends a FUSE flush on every `close()`, including the `close()` of the
duplicate fd a transient redirect makes and then drops when it ends — so
`printf … >&9` would flush the buffered write before the truncate ran, and the
release would report a handle that was never armed across a truncate at all.
Grouping the write and the truncate keeps the buffer on the handle until the
group ends, after the truncate has disarmed it, so every flush of that handle
happens post-disarm. macOS does not forward the flush on that duplicate close,
so the grouping is a no-op there and the write stays buffered until the real
close either way.

One case escapes that line: a flush that started and finished before `release`
arrived clears the same fields the disarm clears. So the script also requires
no `flush-fire` line for the handle. `flushCb` traces `flush-fire` only for a
handle that got past the gate, which is exactly the case the release line
would have lost. Neither check subsumes the other. Between them they catch the
descriptors `flushCb` flushed and the ones `releaseCb` flushed, which is every
descriptor this sequence can arm.

Waiting for `release` is what makes this an observation rather than a guess.
`close()` sends `flush` and blocks on its reply before the kernel queues
`release`, and the daemon runs its callbacks on one thread through
`fuse_session_loop`, appending trace lines in that order. A `release` line for
a handle therefore cannot appear before that handle's flush decision has been
traced. The release check does not depend on `flush` being delivered; only the
supplementary `flush-fire` check does, and it is the one whose job the release
line already covers when `flush` is missing.

Both checks do depend on `release` being delivered, and one platform does not
deliver it: `scheduleFlush(handle, 500)` exists because Docker Desktop's
VirtioFS does not forward `flush` or `release` through a FUSE-T mount. Run the
suite there and it fails on the wait for the release line rather than
reporting a broken disarm. CI runs it on Linux against libfuse3, which
delivers both.

That deferred flush is the one path the trace cannot see at all: the timer
calls `flushHandle` directly, tracing nothing. It cannot resurrect anything,
because `truncateByIno` has already closed `flushHandle`'s guard by the time
it fires — half a second after a write the script follows within three
syscalls. The window where it could pick up a still-armed buffer is not
reachable from this sequence, so nothing here observes it; it is out of the
assertion's reach rather than covered by it.

The `flush-fire` check passes by a line being absent, so a reword in `mod.ts`
would quietly turn it into a no-op that still passes. The other two lines fail
loudly if reworded — the script cannot resolve the handle, or times out
waiting for the release line — but they fail far from the cause.
`mod.test.ts` pins the shape of all three lines, so a reword fails there,
naming what it broke.

The value check stays, after the trace checks, as the end-to-end statement
that the cell really is empty. It is the weaker of the two instruments and is
not what makes a broken disarm fail.

### Cleanup hard-kills on a failure, unmounts gracefully on a pass

The daemon can wedge — a hang that hits a meaningful share of CI runs, with
its own root-cause investigation. When it does, every filesystem call that
crosses the mount blocks with no time limit, because the daemon that would
answer it never does. The exit-trap `cleanup` would run `cf fuse unmount` and
check whether the mount is still active; both touch the mount, so left
unbounded on a wedge the script neither reports nor exits. On CI the job then
runs to its step timeout and is cancelled with the streamed log truncated at
the hang, so no diagnostics survive — the original failure this guards
against.

`cleanup` handles the two ways it is reached differently, keyed on the pending
exit status it captures before doing anything. If the test has **already
failed** — a `wait_for_path` deadline, an assertion, anything — we no longer
care how the mount is torn down, only that the process exits and reports the
failure to CI. So it hard-kills the daemon and detaches: `SIGKILL` on the
worker that holds `/dev/fuse` makes the kernel abort the connection, which is
non-blocking and needs no timeout, and `error` has already dumped the daemon
state on the way in. No graceful unmount is attempted, because a graceful
unmount of a wedged mount is the very thing that would hang. The failure code
is preserved — an exit trap that returns without calling `exit` keeps the
status that triggered it — so nothing here can mask the failure.

If the test **passed**, `cleanup` unmounts gracefully: the only path that
exercises the real `cf fuse unmount`, and the one that avoids leaving a stale
FUSE-T mount on macOS. That unmount is bounded, but by the shared outer
deadline, not a fixed few seconds — so a slow-but-succeeding unmount is never
cut short, and only a teardown that cannot finish before the deadline (the
daemon wedging during its own shutdown) reaches the bound. That is a real
failure a passing run must not hide, so `cleanup` dumps the daemon state,
hard-kills it, detaches, and fails the run. The bound is still a ceiling, so a
clock jump can trip it early on a healthy unmount
([above](#why-a-bounded-timeout-is-never-a-guarantee)); but it sits minutes
above how long an unmount takes, so only a multi-minute jump does, and at that
point we are out of diagnostic margin either way. Reporting is the honest
response — preferred over masking a genuine wedge whenever we cannot prove it
was a clock jump.

Killing the worker, not the bound, is what actually unsticks the mount. Once
the process holding `/dev/fuse` exits, the kernel aborts the connection and
every pending call returns an error. That exit is the event this path leans
on, the same way the shutdown escalation in [the mount
handshake](#the-fuse-mount-handshake) leans on the child's exit and only sends
`SIGKILL` after a grace period as a fallback.

Before touching the mount at all, `error` dumps the daemon's own state — the
tail of its log file, which is a regular file off the mount, and on Linux each
daemon thread's scheduling state and kernel wait channel from `/proc`. A
wedged mount parks the worker thread in uninterruptible sleep in a FUSE wait,
so that per-thread state names the hang. Reading both crosses nothing that can
block, so the diagnostics survive even when the mount-tree dump that follows
stalls. The `/proc` state in particular has to be read here rather than from
CI's post-run log step: by the time that step runs, `cleanup` has killed the
daemon and its `/proc` entries are gone.

### The daemon's `.status` file is a probe, not a signal

The FUSE daemon keeps write statistics (`writeStats` in `packages/fuse/mod.ts`)
and publishes them through the `.status` file at the mount root. A script can
read that file to see how many descriptors the daemon has opened, written and
flushed. The counts it reads are the ones the daemon held when it answered, so
a loop around `.status` would converge on the write-path event it waits for.
The `fuse-exec.sh` suite does not use it that way — it reads `.status` once,
to confirm the generated file is served as one coherent document, and waits on
the events it already has better signals for. Polling `.status` would be a
poll it can avoid.

That works because nothing writes `.status`. `CellBridge.initStatus` registers
it through `FsTree.addGeneratedFile`, which hands the tree a function that
renders the status JSON from the daemon's current counters. The callbacks that
report the file's size run that renderer and publish what it returns, and
reads serve the published bytes. The write path announces nothing: a flush
increments `writeStats.flushed` and stops there. No refresh has to be ordered
after a counter, because no refresh exists to be ordered.

The kernel caches are set to match. `replyEntry` and the getattr callback
treat a generated inode as dynamic and reply with a zero entry and attribute
timeout, so on Linux a lookup and a getattr precede each read. Publishing
bumps the node's mtime whenever the bytes change, and `.status` reports it, so
a client that validates its cached copy against the timestamp and the size
notices a counter going from 9 to 10 even though the document's length did not
change.

A macOS mount cannot use those timeouts, because FUSE-T ignores the ones a
reply carries; it bounds staleness through an NFS attribute-cache mount option
instead, the `attrcache-timeout` default described in
`packages/fuse/mount-options.ts`. A `.status` poll on macOS is therefore only
as sharp as that option allows: a reader that has read the file once holds the
NFS client's cached copy until it expires, so a count arrives a beat after the
write that caused it. That the counts advance is settled by the
`CellBridge.status` unit tests, which drive the tree directly and need no
mount and no wait.

## Reading a pattern-test assertion exactly once

[Reading a pattern-test
assertion](waiting-in-tests.md#reading-a-pattern-test-assertion) says the
pattern test runner demands an assertion, waits, and reads it once. Two things
about that are easy to get wrong, and both were once wrong here.

The first is why a single read needs the demand in front of it. A read of a
lazy value does two jobs at once: it supplies the demand that makes the
computation run, and it observes the result. For an asynchronous built-in those
two cannot be the same read, because the work has not started until the demand
arrives. A runner that just reads therefore observes nothing, and a runner that
reads, waits, and reads again has separated the jobs by giving the first read
away — at the cost of a read count that depends on what the first read found,
which is a retry wearing a bound. Demanding through `cell.sink()` separates
them without that cost, and holding the demand across the wait is the part
worth stating: the scheduler runs a computation only while it is reachable from
a live root, so releasing the demand to wait would let the cascade the built-in
feeds go dormant before the assertion sees it.

The second is whether anything must drain the scheduler between that wait and
the read. `Runtime.settled()` in `packages/runner/src/runtime.ts` loops
`scheduler.idleWithPendingCommits()`, `storageManager.synced()`, and a wait on
every in-flight async built-in, returning from the round in which nothing is
left to track — so the last thing it awaits is the storage sync. Applying what
a sync delivered schedules reactive work, so the graph looks as though it could
be dirty when `settled()` returns.

It cannot matter, because of what the read itself does. `Cell.pull()`
subscribes an effect that reads the cell, awaits `scheduler.idle()`, drives the
link-target loads that read kicked off to convergence, and takes the value
after all of it. A drain placed before the read observes a subset of what the
read observes for itself, and observes it earlier.

Two waits elsewhere look like precedent for one here and are narrower than
their shape. The runner's initial settle drains after its sync because
`replica.poll()` fires without await during `mount()`, and a pattern mounts
once. The serving loop in `packages/runner/src/executor/space-server.ts` yields
a macrotask because it then probes `scheduler.isIdle()`, which is synchronous
and cannot wait, where `runtime.idle()` waits and `Scheduler.queueExecution`
marks the scheduler scheduled when it arms its task rather than when the task
runs.

Measurement agreed before the argument was found. Probing `scheduler.isIdle()`
on return from `settled()` after every assertion the pattern suite runs
answered idle every time, including the assertions whose barrier had async
built-in work to wait for; a macrotask yield placed after every action and
render settle never found the scheduler other than idle either. Probe the same
way before adding a wait here.

## Production case studies

The "wait on an event, not a poll" principle of
[waiting-in-tests.md](waiting-in-tests.md) applies to production code too. The
three studies below are where the shape is worth knowing: a deliberate
exception where no event exists to await, and two readiness handshakes that
stay event-driven across process boundaries that look like they rule an event
out.

### Production reconnect backoff

One loop that looks like a violation is a deliberate exception:
`MemoryClient.#reconnect()` in `packages/memory/v2/client.ts`. When the
websocket to the memory server drops, the client loops — it re-runs the
`hello` handshake, re-opens every mounted space's session, and, when an
attempt fails, waits a short, growing delay before trying again. That
inter-attempt delay is the exception.

The connection attempt itself is event-driven. `hello()` calls
`transport.send()`, which opens the websocket. The websocket transport
(`WebSocketTransport` in `packages/runner/src/storage/v2-remote-session.ts`)
resolves the open on the real `open` event and rejects it on the real `error`
or `close` event. The client never polls to discover whether a connection
attempt has succeeded; it awaits the transport event. On the success path
there is no timer standing in for a missing event.

The delay is only the pause between one failed attempt and the next, and that
pause cannot be replaced by awaiting an event, because there is no event to
await. A server that is down or restarting is, from the client's point of
view, just a host that refuses the connection. When the host refuses, the
websocket `error` event fires almost immediately, and nothing tells the client
when the server has come back — the only way to find out is to try again.
Without a delay between attempts the loop would open a socket, receive an
instant error, and open another as fast as the event loop allows, a busy loop
hammering the host. The growing backoff — 25 milliseconds doubling to a
30-second cap, with up to 20 percent jitter — is the honest way to keep
checking whether the server is back without flooding it. It is the same shape
as the committed-write backoff in [committed-write
backpressure](../features/committed-write-backpressure.md), where a capped exponential
backoff also stands in for a retry that has no event to wait on.

Cancelling an in-progress backoff stays event-driven: the pause between
attempts is a single timer that `close()` cancels directly, so a client closed
mid-backoff settles at once and nothing wakes on an interval. The backoff
delay between attempts stays; its cancellation carries no poll.

### The FUSE mount handshake

`cf fuse mount --background` has to find out whether a daemon it did not spawn
directly came up. It spawns a supervisor, the supervisor spawns the FUSE
daemon, and the daemon is therefore a grandchild the command holds no handle
to. Both halves of the handshake wake on an event rather than a poll. The
shape is worth knowing, because "the processes are detached" reads like an
argument that no channel is available, and it is not one.

The daemon publishes readiness states — starting, mounted, failed, exiting,
exited — through a child-status file next to the mount state, refreshed by a
one-second heartbeat. Those states are the signal `cf fuse status` reads. A
file cannot wake a reader, though, so readiness for the handshake itself
travels over a pipe. The command spawns the supervisor with a piped stdout and
blocks reading it; the supervisor passes that descriptor down to the daemon,
so the daemon's readiness line arrives at the command directly and the read
wakes on the write. The status file serves `cf fuse status`, and the heartbeat
keeps it fresh; only the one-shot startup transitions go through the pipe, so
the heartbeat does not flood a channel nobody reads once the command has
returned.

Detachment does not rule the pipe out, and the reasons are worth stating
because each one looks like a blocker.

The daemon must outlive the command. It does: the descriptor is inherited at
spawn, and closing the read end has no effect on the processes holding the
write end. The command reads one line, cancels the reader and exits, and the
mount stays up.

A daemon whose parent has gone must not die. It does not. Deno ignores SIGPIPE
and surfaces a write to a readerless pipe as a catchable `BrokenPipe`, so the
readiness write catches and the mount continues unobserved. Nothing else
reaches that descriptor: a background daemon redirects `console.log` and
friends into its log file, and only tees to stderr when stderr is a terminal,
which for a background mount it is not.

The supervisor is unreferenced only after the handshake. `unref` keeps the
child from holding the command's event loop open, which is what the command
wants once the mount is up and outlives it. Unreferencing before the read
would stop the readiness read from holding the loop open too, and the command
would exit mid-handshake with a zero status and no output.

Failure is an event as well, and this is the part a poll cannot match. Two
things end the read besides a report. End of stream means every process
holding the write end has exited. The supervisor's exit — which the command
already holds, because the supervisor is the child it spawned — means no
report is coming from a daemon that cannot send one. Both fire the moment they
happen rather than on the next liveness tick, and a daemon that fails during
startup publishes its own error first, so the command reports the cause rather
than only that the process went away.

Watching the supervisor's exit is not belt-and-braces on top of end of stream;
without it the command can hang. The daemon inherits the write end, so a
daemon orphaned by a dead supervisor holds the stream open on its own and end
of stream never arrives. A supervisor killed while its daemon sits there
silently would otherwise leave the read outstanding forever.

The pipe is private to one invocation, which is why the handshake carries no
correlation. The status file is a shared namespace — a stale file from an
earlier mount at the same mountpoint sits at the same path — so a reader of
that file would need a correlation token, a mountpoint check and a cross-check
against the mount state to tell its own child's report from a leftover. A line
on the pipe came from this invocation's daemon and nothing else, so the
handshake needs none of that.

The supervisor owns the mount state file, because it is the process that
spawns the daemon and so the only one that knows both pids; it writes the file
once and completely. The command prepares the containing directory and the
path, and the supervisor holds write access to that one file and no read
access.

What lets the readiness read stay pure-event is where the daemon announces
`mounted`. It announces only after it has dispatched its FUSE session loop and
installed its signal handlers, so a command that has read `mounted` has a
mount that serves requests and tears down cleanly on a signal. The
announcement carries that guarantee, so the command trusts it on arrival: it
confirms the child and the supervisor are alive at that instant — a
point-in-time probe, not a wait — and returns. An announcement made earlier,
before the loop was dispatched, would report a mount that might still fail in
the loop, and to catch that the command would have to wait out a fixed
confirmation window on every successful mount, a genuine timing bet because
nothing announces that a process intends to keep running. Moving the
announcement behind the loop dispatch retires that wait rather than tuning it.

The status file the daemon also writes, the record `cf fuse status` reads, is
written to survive a concurrent reader, because its startup, readiness,
heartbeat and signal paths all write it without coordinating. Each write lands
under a scratch name and is renamed into place, so a reader woken mid-write
sees a whole document rather than a truncated one. And the writes are
serialized through a queue, so the file ends on the state of the most recent
call: without that, two renames could complete in either order and let a
heartbeat still in flight replace a terminal state, leaving the file claiming
a mount that has already gone.

One wait in the handshake keeps a real duration: `cleanupFuseChild`'s shutdown
escalation. It sends SIGTERM, allows the child five seconds to exit, then
sends SIGKILL. The wait for the child's exit is event-driven — it races the
real status promise — and the timeout is the escalation policy, not a stand-in
for a missing signal. A process ignoring SIGTERM never announces that it
intends to keep ignoring it.

There is no deadline on the readiness read. A daemon that neither mounts nor
exits, under a supervisor that is also still there, blocks the command
indefinitely — which is what a foreground mount does too, and the user
interrupts it or a CI job limit catches it. Every way the pair can actually
fail ends the read instead. A ceiling over the read would instead fail a mount
that would have succeeded on a loaded machine, the ceiling
[waiting-in-tests.md](waiting-in-tests.md) warns about throughout.

### The toolshed background handshake

`toolshed --background` carries the same pipe-borne readiness signal into
starting the server. The command spawns a second copy of itself as the server,
waits until that copy reports it has bound its port, and only then returns. A
caller that runs it starts the toolshed and moves straight on to work that
needs it, with no readiness poll of its own. The CI integration jobs start the
toolshed this way and go straight to their tests.

Readiness travels over the child's stdout. The child writes a single marker
line the moment `Deno.serve`'s `onListen` fires — the point the port is
listening and a connection stops being refused — and the parent reads that
pipe until the marker arrives. The read wakes on the write, so the wait
resolves on the event with no poll interval. Failure ends the read the same
way the FUSE handshake's does: if the child exits before it binds, its stdout
closes, the parent reaches end of stream without the marker, and the command
fails with the child's exit code and prints the child's log.

The child keeps the pipe clean by sending its own logs to a file rather than
to stdout, so once the parent has read the marker and detached, the child
never writes the pipe again and a later log cannot land on a closed reader.
Its stderr is discarded for the same reason: a detached server that inherited
a launcher's stderr would hold a descriptor the launcher waits on after it has
moved on. The one line the parent needs is on stdout; everything else the
server says is in its log file.

There is no deadline on this read either. A server that neither binds nor
exits blocks the command, which is what a foreground start does too, and the
outer job limit catches it. A per-command ceiling would instead fail a start
that a loaded machine would have completed.
