# Test waits: prefer events over polling `waitFor`

A test wait should resolve on a real event, not a poll loop or a fixed delay.
This note is the working guidance for doing that: why polling waits flake,
which primitives to reach for instead, how the packages that control time in
their tests do it, why a wait the initial state already satisfies is not
evidence, how to prove a negative, the check that keeps new polling `waitFor`
out of the integration suites, and the specific places where a bounded
`waitFor` poll is still the right tool.

A companion document, [Test waits: rationale and case
studies](waiting-in-tests-rationale.md), holds the analysis behind these
rules: the full argument for why a bounded timeout is never a guarantee, the
sizing of the deno-web-test backstop, how the runner clock classifies timers
across SES lockdown, the real-clock exemptions that were retired, why the
runtime-client suite keeps the real clock, why neither runtime-disposal
teardown carries a bound, the CSP suite worked through as a
proving-a-negative example, the FUSE exec suite's design, and the production
waits that apply the same principle outside tests. Nothing there is needed to
write an ordinary test; read it when you need to know why a rule is what it
is, or before changing the machinery a rule describes.

## Why avoid `waitFor`

`waitFor(predicate, { timeout, delay })` (in `packages/integration/utils.ts`)
re-runs `predicate` every `delay` milliseconds (50 by default) and throws once
`timeout` (60 seconds by default) elapses. In a browser test each tick is also a
DevTools Protocol round-trip. Two problems follow. The timeout puts a ceiling on
success: anything slower than the timeout can never be observed, even when it
would have completed. The fixed delay puts a floor on latency and, in
performance measurements, quantizes timings to the poll interval.

Reach for a poll only for the cases catalogued under [Where the polling
`waitFor` stays](#where-the-polling-waitfor-stays). Everywhere else, wait on an
event.

## Wall-clock time is not a measure of progress

The ceiling above assumes the bound is exceeded because the work was slow.
There is a worse way to exceed it: the clock jumps forward while the work made
no progress and nothing was wrong. A timeout counts wall-clock time, and
wall-clock time diverges from real progress whenever the world outside the
process pauses — a closed laptop lid, a paused or live-migrated CI virtual
machine, a frozen container, a clock stepped by NTP. Each advances wall time,
sometimes by a large, arbitrary amount, while the timed operation did not run
at all, so a timeout fires on it exactly as it would on a genuine hang. It
cannot tell "stuck" from "everyone was stopped," padding the bound does not
help — no fixed bound survives an arbitrary jump — and no choice of clock
closes every case. The full argument, including which clocks count which
pauses, is in [the rationale
document](waiting-in-tests-rationale.md#why-a-bounded-timeout-is-never-a-guarantee).

So a bounded timeout is never a guarantee, only a heuristic with a real
false-positive mode, and the test for whether one is acceptable is not "is the
bound comfortably large" but "is firing early safe." Does the code still reach
a correct outcome when the bound trips on a healthy operation? A bound whose
early fire only repeats cleanup work is tolerable. A bound whose early fire
fails a passing test, drops a real result, or corrupts state is not — and
wanting one there is the signal to make the wait event-driven instead.

The bounds the repository keeps sort into those two kinds. The shutdown
escalation in the FUSE mount handshake keeps a bound whose early fire is
harmless — it `SIGKILL`s a child that was already exiting, reaching the same
end either way; the rationale document's [case
studies](waiting-in-tests-rationale.md#production-case-studies) walk through
it. The rest — the polling waits under [Where the polling `waitFor`
stays](#where-the-polling-waitfor-stays), the [deno-web-test per-test stuck
detector](#browser-hosted-unit-tests-have-a-harness-backstop), and the FUSE
exec suite's teardown bound (in [the rationale
document](waiting-in-tests-rationale.md#the-fuse-exec-suite)) — keep a bound
whose early fire fails the run. They exist because no event reports the
condition they wait on, so a large-enough clock jump can trip one on a healthy
run and fail it. That is a fragility we accept for want of an alternative,
sized so only a multi-minute jump reaches it — except the stuck detector,
which a competing ceiling keeps lower; its section explains. When an event
boundary does exist, use it, and neither kind of exception arises.

One bound sits between the two kinds, and is written down here because its
cost is easy to understate. The browser load summary in
`packages/patterns/integration/cfc-browser-helpers.ts` gives the worker a
budget to answer the request for its statistics. Reading them is itself a
request, and a request carries no deadline, so a worker that has stopped
answering would hold the collection open for as long as the page lived. An
early fire fails no test and corrupts nothing, but it does drop a real
result: a worker that was slow rather than stopped loses the statistics it
was about to return, and the summary reports the worker half as missing. That
is the price of a collection that always returns, paid because the summary
exists to explain a run already in trouble. The budget is a caller's option,
so a case that wants the backstop exercised asks for a short one rather than
waiting out the default.

One bound a browser test runs under is not the repository's to sort, and
belongs in an audit of these for that reason: astral puts its own deadline on
every `page.evaluate`, so a page that never answers ends the call whether or
not anything here asked for that. It sorts differently from the ones above,
because it re-waits on the one in-flight call rather than reissuing it, which
leaves a late answer still returned. [Sizing the deno-web-test
backstop](waiting-in-tests-rationale.md#sizing-the-deno-web-test-backstop)
works that mechanism through and says what each of the two harnesses running
under it sets the deadline to; [Tearing a runtime down waits on its
worker](#tearing-a-runtime-down-waits-on-its-worker) is where a test leans on
it hardest.

## The primitives to use instead

Waits split into two groups with different primitives.

**Browser integration tests** have a page to attach an in-page waiter to:

- `waitForCondition(page, predicate, { args, events })` installs a single waiter
  inside the page. A shared MutationObserver hub watches the document and every
  shadow root — including shadow roots created after the wait began — and
  re-evaluates the predicate the instant the DOM reflects new state, then signals
  the test process over a protocol binding. It takes no caller-supplied timeout: a
  built-in five-minute stuck-condition safety net bounds a condition that never
  holds, and a coarse 500-millisecond in-page backstop covers conditions that
  flip with no DOM mutation (for example a runtime global being set). A nonempty
  `events` list additionally observes those window events and disables the
  polling backstop. The waiter checks once immediately, so an event that fired
  before the wait is also covered. `waitForShellReady(page)` uses `cf-shell-ready`, which the shell dispatches
  after publishing `globalThis.app` at the end of bootstrap. The predicate is
  serialized and runs in the page, so it closes over nothing from the test module
  — inline any collection it needs, and pass values in through `args`. A predicate that returns a truthy value instead of `true` hands that
  value back to the caller in the same binding notification, so it must be a
  `PageConditionValue`: a plain JSON value. Maps, functions, class instances,
  cycles, and other lossy JSON inputs are rejected at the boundary instead of
  being changed silently. A wait that runs out reports the page it ran out
  against: the predicate source and its arguments, the document URL and title,
  `x-root-view`, whether `globalThis.app` is present and the view it holds,
  outstanding runtime requests, and a console tail. That report is
  `waitForCondition`'s own message, so a helper that wraps the failure with a
  message of its own carries the report one level down, in the cause. Read the
  cause before adding a probe of your own; what it prints is usually the thing
  the probe was going to collect.
- `awaitViewSettled(page)` resolves once the worker has settled reactively, the
  resulting vdom batch has crossed to the main thread and been applied, and Lit
  has finished its update cycle. This is the "is the control interactive yet"
  signal.
- The higher-level wrappers in
  `packages/patterns/integration/cfc-browser-helpers.ts` compose the two
  primitives above for common waits and interactions. Each of them settles and
  marks the exact rendered target before acting on it; what differs between them
  is only how they recognize that target. `clickCfButton` takes the first match,
  reaches through a host's shadow root for its inner `[data-cf-button]`, and
  answers only while neither the host nor that control is disabled;
  `clickCfButtonsConcurrently` does the same for a group. `clickNthCfButton`
  takes the `index`-th match of a selector that already resolves to the buttons
  themselves and waits for that match and its wrapped control to become enabled,
  counting disabled matches when locating the index. `clickTrustedAction` takes
  the first enabled match of a `data-ui-action` value. The note-button helpers
  take the first enabled button matching a text or a title. `submitViaEnter`
  focuses a field and presses Enter rather than clicking, and settles around
  resolving that field the same way.

To click a control that appears asynchronously, follow the `clickCfButton`
shape rather than a find-and-click retry loop: a `waitForCondition` predicate
waits until a matching, rendered control is present and tags its click target,
then the test dispatches a single trusted click on that element. Require the
target to be rendered — laid out, and not `display:none` or `visibility:hidden`
— so a control still inside a collapsed menu is skipped until it becomes
clickable rather than tagged while it has no layout box and then failing to
click.

Require it to be enabled as well, in that same predicate. A disabled control
has a layout box, so rendered-ness alone answers it, and it still takes no
click. A pattern disables a control while the state behind it is arriving — a
row's "This is me" is disabled until the acting identity resolves — so the
wait holds until that state lands.

Resolve the target before settling the view inside that predicate. Let the
check pass only when the same rendered element remains after the settle. A
target that appears or is replaced during the settle is checked again after
the DOM mutation. The next check gives that exact element a complete settle
before marking it for the click.

Do not reach instead for a check that only watches the DOM. Asking the worker
whether it is idle queues runnable pull work that nothing else would start, so a
control that appears only once the page's own pending work runs never arrives
under a purely passive wait. The settle is both the barrier and the pump, which
is why it belongs inside the predicate rather than in front of it.

When several controls are clicked as a group, prove that every target is stable
before marking any of them. Mark the targets inside the successful predicate so
the click addresses the elements that passed the settle check.

Every marked click runs the same step to get there, `settleAndMarkTargets`, so
`clickCfButton`, `clickCfButtonsConcurrently`, `clickNthCfButton`,
`clickTrustedAction` and the note-button helpers in
`packages/patterns/integration/note-button-helpers.ts` all mark under these
rules. A helper supplies only a finder: which elements qualify, answered from
the page. Resolving them either side of the settle, requiring the same elements
both times, and marking them is the shared step's work. `submitViaEnter`
focuses a field and presses Enter rather than clicking, and goes through the
same step to resolve that field.

Ask `probe.isRendered` for that check rather than hand-rolling it, and note that
it is deliberately not `probe.isVisible`, which additionally requires the
element to be on-screen. A click scrolls its element into view before it
dispatches, so where the element sits at tagging time does not decide whether
the click lands. Requiring it on-screen only adds ways to wait forever: the
shell sets `html { scroll-behavior: smooth }`, so a `scrollIntoView()` a
predicate issues animates over several hundred milliseconds, and a viewport
check within the same predicate reads a position the scroll has not reached yet.

Check the element the click is dispatched on, not the host that matched the
selector. Hiding the host or any ancestor reaches the inner control either way:
`display:none` zeroes the control's layout box, and `visibility:hidden` inherits
into its computed visibility. So the click target's own check covers the whole
chain, and checking the host as well buys nothing.

Being rendered is a question about whether a click can be delivered, which is
why it belongs in the predicate that tags the control. Being enabled is the same
question, so it belongs there too. The browser raises no click on a disabled
control, and `cf-button` additionally gives one `pointer-events: none`, which
sends the press to the host that wraps it. Either way the control is not
activated, and the interceptor stops an interaction that did not carry the mark,
so the aim tries again where the control still stands until it repeats a pixel
and reports.

Ask that of the host as well as of the control it wraps. Here being enabled
parts company with being rendered: hiding an ancestor reaches the control
through layout and inheritance, but `disabled` does not inherit, so a host
carrying `disabled` or `aria-disabled="true"` over a control carrying neither
has to be asked in its own right.

Asking inside the predicate is what makes the element that was checked the
element that gets marked. `waitForDisabled(page, selector, false)` ahead of a
click does not give that: the element it inspects and the element the click
marks are resolved by separate round trips, and a re-render between them —
which is what landing the state that enables a control looks like — leaves the
mark on a replacement the check never saw. Such a call still earns its place
as an assertion that the page enabled the control, which is a claim about the
pattern rather than a guard on the click.

A control has to be rendered when the predicate tags it, but that alone does
not make the click that follows safe. The page keeps running between the tag and
the click, and the surface the control sits in can still be settling: a join
card's profile surface toggles display through its entrance, a re-render relays
out the region, or a piece re-render replaces the control with an equivalent one.
So `clickMarked` settles the control and works out where to click it in a single
page turn. That turn holds until the tagged control's bounding box is unchanged
across two consecutive animation frames. It then scrolls the control into view
and measures the point without handing control back to the test process in
between. The hold is frame-driven and drops its baseline whenever the box
disappears. A control hidden partway through is picked up once it returns rather
than clicked mid-shift. The stuck-condition net bounds a box that never settles.

The point that measurement answers is the middle of the part of the control's
box that lies inside the page, which for a control the page has room for is the
middle of the whole box. A control reaching past the edge of the page — a
surface positioned towards that edge in a narrow viewport, a control wider than
the space it is drawn in — can have the middle of its whole box outside the
page. The browser accepts a trusted click dispatched outside the page, delivers
it to nothing, and reports no error for having done so, so a click aimed there
leaves the caller told that a control was pressed which never was. A control
with no part of it inside the page has no point to aim at, and `clickMarked`
reports it, naming the control's box and the size of the page. What the page
shows of a control is a wider question than this one: an ancestor's overflow can
clip it, and anything painted over it can cover it. Neither moves this point.

The page can move again after that first measurement. An interaction observer
also runs before the trusted click and can give the page time to change. Just
before dispatch, `clickMarked` resolves the marked control in one page turn and
reads its current point. If the control has moved or disappeared, the helper
settles it again and applies the caller's tagging predicate to any replacement.
It takes one final current measurement after that settle, then dispatches the
single trusted click at that point.

Deciding and measuring in one turn is the point of the design, not an
optimization. Split across protocol round trips, the measurement describes a
different moment from the decision. A control the page dropped in between then
measures as nothing at all. This is what "Unable to get stable box model to
click on" means. A helper that tags a control by name also passes its tagging
predicate to `clickMarked`. A control the page rebuilt is therefore tagged
again on whatever took its place, under that helper's own readiness rules,
rather than reported as gone.

The dispatch that follows still crosses the protocol, and the page keeps running
while it does. A surface that relays out in that crossing carries the control
off the point the click is already aimed at, and the click lands on whatever
moved into the space. So the same page turn that measures the point also arms an
interceptor: it watches the window, in the capture phase, for the pointer and
mouse events of that one click. The first of them to arrive decides what happens
to the rest. If the mark is on its composed path, every event of the interaction
goes through to the page. If it is not, every event is stopped at the window.
One decision for the whole interaction is what makes the control take the press
and the release together or take neither.

Whether the click was delivered is decided separately, at the click event,
because that is the event a control acts on. The press and the release cross the
protocol one at a time, so the page can carry the control away between them, and
the browser then raises the click on the nearest ancestor the two have in common
rather than on the control. A click that does not carry the mark is stopped like
any other miss. So is a control that declines the interaction outright, and a
disabled one arrives here two ways: it takes the press and raises no click at
all, or, where a stylesheet has given it `pointer-events: none`, the press
reaches the host that wraps it and the click is raised there, without the
mark.

What the interceptor stops is the press, the release and the click — the events
a control acts on. The pointer moves to the point before it presses, and the
hover events that produces reach the page like any other. It also leaves the
page's own clicks alone: a label forwarding to its control, or a component
clicking itself from a key handler, raises an untrusted event, which the
interceptor passes through and does not read a verdict from.

A miss did not activate the control, so `clickMarked` aims again at wherever the
control now stands and dispatches again. What bounds that is progress: the aim
has to answer a pixel no dispatch has lost yet. A control that has not moved
answers the same pixel, and a page that shuffles a control between a few
positions comes back to one of them, so both stop at the second aim that repeats
itself. The report then names every pixel tried and what the click reached at
each, which says whether the control was covered, was declining the click, or
was being carried around the page.

This is the one place in the interaction helpers where a failed operation is
retried. It is not the kind of retry the rule above forbids, because a click the
interceptor stopped is not a failed attempt that might have worked — it provably
did nothing to the page — and because it cannot repeat itself: a second dispatch
only happens at a pixel that has never been dispatched at.

Those steps look like one another and are not. Each answers a different question
about the control, and dropping any of them leaves a click that quietly does
nothing:

- Is it wired up? The settle either side of the mark answers this, and nothing
  later can. A click that reaches a control whose handler has not been bound is
  delivered and discarded, so every other check passes and the test waits on an
  effect that will not come.
- Is it the control the settle ran for? Resolving before and after the settle
  and requiring the same elements answers this. A surface that rebuilt its
  control mid-settle otherwise hands the mark to an element that never settled.
- Is there a point to aim at? The single page turn that holds for a stable box
  and measures it answers this. A control with no box makes the measurement come
  back empty and the click throw before any of it reaches the page.
- Did the click land on it? The interceptor answers this, and only this. It is
  what turns a click carried off its target into a re-aim rather than a silent
  success.

That error message covers more than a missing layout box: the underlying
`DOM.getBoxModel` reports a node the browser's DOM agent no longer knows about
the same way it reports a node with no box, and the agent forgets every
outstanding node the moment anything queries the document afresh. Any diagnosis
that reads the message as "the element had no layout box" is therefore reading
in more than it says. `Page`'s own click measures through the element rather
than through a node handle, and names the condition it found — detached from
the document, no layout box, or a handle that no longer resolves.

Waiting for a click's effect carries the same requirement, for the same reason.
Nothing in an integration test holds a UI subscription, so between one check and
the next nothing drives the page. A rendering the page has to produce for
itself — a tally recomputed from a vote, a card drawn for a list entry that
has just arrived — can sit as runnable work no one schedules, one settle away
from showing it. The wait then runs to the stuck-condition net, and the
failure reads as "the state never arrived" when it had arrived and was never
drawn. So `waitForText`, which only watches the DOM, is for text already there
or that something else is already drawing. When the text is the effect of a
stimulus, including one delivered to another browser sharing the same piece, use
`waitForSettledText`, which settles the page on every check. The lunch-poll
two-browser vote test uses it for all of its cross-browser waits.

**Non-browser and off-page waits** have no page to observe. Resolve a `defer()`
(from `packages/utils/src/defer.ts`) inside a callback the test already registers
— a cell `sink`/`subscribe`, a storage subscription's `next`, a scheduler
`onError`, a telemetry listener, or a counter incremented inside a test-owned
transport. A read of a cell that a sink already observes belongs here too: the
sink wakes the waiter, and the waiter compares the cell against the target.
Because the sink fires once on registration and then on every committed change,
the waiter can resolve immediately when the value is already there and otherwise
on the next change the sink reports.

**Suites that drive a live memory server** — the runner's serving-loop,
events-down, speculation and effect-channel families — watch a third kind of
state: what only the server produces. A wave's derived writes, a document
outside every replica's watch set, a scan over the space's own commit table, a
counter the loop moves inside a wave cycle. A cell sink sees none of it, which
is what made a poll over the engine the reflex in those files.

A set of edges carries them, and
`packages/runner/test/support/serving-waits.ts` holds the waits built on each:

- `Server.watchAdmittedCommits` reports every commit the store admits — a
  session transact, a delegated append, the server's own direct write, and the
  serving loop's wave commits — after the engine has applied it. It sits beside
  the single observer slot the ExecutorHost owns, so any number of watchers
  attach. `awaitAdmitted(server, predicate)` sleeps on it and reads the engine
  on each commit.
- `SpaceServerOptions.onWaveCycle`, forwarded by `ExecutorHostOptions`, reports
  each wave cycle as it ends — committed or not, thrown or not. The loop's
  counters move inside a cycle and are visible only as numbers afterwards, so
  `awaitEach(log, predicate)` re-reads them when one has run.
- `SpaceServerOptions.onRootEnsure` reports each space-root ensure attempt's
  outcome. A skip writes nothing at all, and a deadline failure reports
  `failed` while the ensure it gave up on runs on detached and may write later,
  so at the moment either is reported there is no commit for a test to wait
  on.
- `SpaceServerOptions.onEventDrainPass` reports the end of a drain pass, which
  is where `events.processed` moves. A pass ends before the settle that
  follows it, so a wait on that counter at the cycle boundary instead sleeps
  through a whole flush deadline for nothing.
- `ExecutorHostOptions.onActivationSettled` reports each activation attempt as
  it ends, and how it ended. `onSpaceParked` beside it reports each tenure's
  park. Activation is driven from the admission feed and from session opens
  and finishes on neither of their edges.
- `SpaceServerOptions.onDrainInFlightSkip` and `onEventDeferred`, forwarded the
  same way, report the two things that happen INSIDE a drain pass rather than
  at its boundary: a re-drain the in-flight guard turned away, and a served
  dispatch that deferred. A pin that holds a drain parked to build the window
  it is about is holding the pass whose end the cycle edge above reports, so
  those two are the only edges left to it.
- A client's own `storageManager.subscribe`, through
  `awaitReplica(manager, predicate)`, for what a push to that client reports and
  the watermark does not: a retirement, which is the loop's own bookkeeping, or
  a re-issue after a requeue. Its predicate may read the engine rather than the
  client: the server commits before it fans out, so any such state is already
  true when the delivery that wakes this wait arrives.

`settleServing(engine, runtime, space)` is the barrier the assertions stand
behind: it flushes the runtime, reads the highest AUTHORED seq in the space, and
waits for W to cover it through `waitForSettled`. `W >= seq` is the settled
contract as a client applies it, so past the barrier a consequence that never
arrived is an absence to assert on. It is a barrier, not a delivery signal: a
wave that requeues the event it drained still commits, and its advance still
covers that event's seq, so a test whose subject is the re-run's own output
waits for that output on the replica.

`ArrivalLog` records what a callback the test already registers hands it — a
navigate callback, a scheduler `onError`, a fault injector, a settle gate — with
a promise per arrival, so a test waits on the arrival rather than on a count
turning true. A test that installs its own gate or fault seam owns that seam's
edge already: record each hit on a log rather than incrementing a counter, and
the counter's readers become the log's, with a wait available for free.

A serving-side value that exists only in the SERVING runtime's view — a write
sealed into an open wave, which the store does not hold yet — has no edge in
that list, and the `waitForCellValue` shape below is wrong for it: idling the
serving runtime runs whatever the pin parked there to completion, which in
these files is the choreography under test. The wait for one of those sleeps
on the cell's own sink and compares the cell as the sink reports it, without
idling.
`awaitServingView` in `executor-events-down.test.ts` is that shape. A cell the
test's own code writes is better still: report the write from the code that
makes it, and the wait names the write rather than the view of it.

Each of the SpaceServer and ExecutorHost options above is marked `DIAGNOSTIC
(tests)` where it is declared. So are two more that serve one suite each:
`EventAppendQueue.onPacedHold`, which reports each pacing hold as it begins, and
`SpaceOutbox.onEffectRetired`, which reports each in-flight effect as the outbox
retires it, once the counts that drop with it have moved. `ExecutorHostOptions`
forwards the second, the way it forwards `onWaveCycle`, so a suite that does not
build the outbox can still reach it. They exist because the state they report
has no other boundary, and adding one is the alternative the note above prefers
to keeping a poll.

These waits carry a stuck-condition net, which the waits in the sections above
do not. A live SpaceServer renews its lease on a repeating timer, so a process
running one never goes quiet and the fail-fast described below never fires;
without a net a wait whose condition never arrives burns the whole job instead
of failing. `stuckNet` in `@commonfabric/test-support/stuck-net` is that net,
and it is one definition for every wait that needs one: the waits here,
`wait-on-delivery.ts` below, and `waitForCellValue` for a caller talking to a
live server, which arms it by passing `stuckLabel`. It is a stuck detector,
not a bound at the call site: reaching it says the condition never came, which
is why its span is measured in minutes against waits that take seconds. It
lives under `test/` so that the fake clock, which classifies a timer by the
file that armed it, freezes it along with every other test-armed timer.

The read-a-cell-the-sink-observes shape is packaged as `waitForCellValue` in
`@commonfabric/integration/wait-for-cell-value`, usable from any package's
tests. It sleeps on the sink and applies its predicate to the cell only after
`runtime.idle()`, so the wait has neither a poll interval under it nor an
iteration cap over it. Its predicate takes `T | undefined`, since a cell holds
no value until its piece writes one.

When that wait fails, its error includes the cell address, predicate, and last
read value, with the original failure as its cause. An Error's name is retained
on the wrapper. The value is rendered only at failure, with bounded depth and
length; a live value reflects its state at that point. This keeps healthy waits
from traversing data just for diagnostics.

The runner's llm tests wait on that shape often enough to have a name for it.
`waitForLlmSettled`, in `packages/runner/test/support/llm-result.ts`, resolves
once `llm`, `generateText` or `generateObject` has finished a request. It is a
call to `waitForCellValue` carrying the predicate those builtins settle on,
`pending === false`, and it holds no wait machinery of its own. Its neighbor
`waitForLlmMessages` adds a message count to that predicate, which is how an
`llmDialog` test names the turn it is waiting for — every turn ends in the same
settled state, so the count is what tells one from the next. Reach for them
rather than re-deriving those predicates: reading at quiescence is what makes
them honest, and the helpers' comments record why.

Some traps are worth knowing before you hand-roll one of these against a
runtime. They cost real debugging to find, and they are why the helper takes a
runtime.

Where a runtime is in reach, test the value the cell holds once the scheduler
is quiescent, not the one the sink handed the callback. A cell passes through
states that exist only until the scheduler drains, and a predicate can accept
one that is about to be superseded — a query that has not yet re-run against
new inputs still holds its previous settled result, so "settled and without
error" matches the stale value. Waking on the sink but reading after
`runtime.idle()` keeps those states away from the predicate. The waits above
that have no runtime to idle, such as the shell's result-cell reads, do compare
the callback's value, and have to keep their predicates specific enough that no
passing state is a stale one.

A cell's value is a live view either way, so whatever a wait returns can still
move afterwards, and a test that accepts a value and then awaits something else
before reading it can assert against a state the predicate never approved.
Reading at quiescence narrows that window rather than closing it: there is no
pending reactive work left to drive the value on, but `runtime.idle()` settles
reactivity only, not storage sync, so a value arriving from another runtime can
still land late. Read what a wait hands back before awaiting anything else.

Cancelling the sink is a trap of its own. Resolving from inside the callback
wakes the waiting code while the action that reported the value is still
finishing, and finalizing an action resubscribes it, so a cancel issued from
that continuation is undone and the sink goes on firing afterwards. Await
`runtime.idle()` before cancelling.

An in-process wait like this needs no timeout backstop. When the value never
arrives and the runtime goes quiet, Deno's test runner reports `Promise
resolution is still pending but the event loop has already resolved` and fails
the test at once, rather than hanging. The message names the test, not the wait
inside it, so a test holding several waits needs the last step printed without
an `ok` to place the failure. It still beats a deadline, which reports only that
time ran out, and reports it later.

That argument covers the in-process waits in this section and nothing else. It
holds because nothing in these tests keeps the event loop alive by itself: the
runner's one repeating timer is unref'd and gated behind `CF_TRAVERSE_CAPTURE`,
and an unsatisfiable wait still fails in seconds in the heaviest setup we have,
two runtimes over an in-process memory server. It does not carry over to the
browser waits above, where a live DevTools Protocol connection holds the loop
open and a waiter that never fires would hang instead. A client talking to a
live server holds the loop open the same way, and so does a process running a
live SpaceServer, whose lease renews on a repeating timer. A wait against one
runs to the ambient test or CI limit rather than failing fast, which is what
the stuck-condition net above is for. The CLI suite's readiness probe is such a
client. It disposes its controller once the wait returns, which also keeps a
finished wait from holding the loop open for the rest of the suite.

### Reading a pattern-test assertion

A pattern test (`*.test.tsx`, run by `cf test`) states each expectation as an
assertion step, and the runner reads each one exactly once. A false value is a
failure rather than a reason to read again. The count does not depend on what a
read found, which is the point: reading again because the first read said
`false` is a retry however tightly it is bounded, and a pattern whose value
converges only sometimes passes on the second attempt.

Reading once takes a separation that a single read cannot make on its own. An
asynchronous built-in — a fetch, a model call, a query — is a computation that
runs only while something demands its result, so a read is also what starts
one, and a read that starts the work cannot be the read that observes it. The
runner therefore demands the assertion first, through `cell.sink()`, and holds
that demand while `runtime.settled()` waits for the work the demand set going.
Holding it across the wait is what keeps the built-in's cascade alive long
enough to reach the assertion. Then the assertion is read, once, and reported.
With nothing in flight the wait returns at once, so an assertion that is false
on its own terms is reported as fast as one that never waited.

`Cell.pull()` is what makes a single read enough, over a scope worth stating.
It subscribes an effect that reads the cell, awaits `scheduler.idle()`, drives
the link-target loads that read kicked off to convergence, and takes the value
after all of it, so the read waits for the computations it depends on and for
the links it followed. It waits for neither the storage sync nor an async
built-in's own work: those are what `runtime.settled()` before it covers, which
is why the demand and the wait are not redundant with the read. Its convergence
also carries a bound of a hundred rounds, and a pull that exhausts it resolves
anyway, with loads still pending and a warning naming the cell.

`packages/cli/test/test-runner-assertion-reads.test.ts` states the count, for
an assertion that holds, one that does not, and one whose value an async
built-in produces.

### Naming the arrival, across runtimes

A wait for state a *different* runtime wrote takes the same `defer()`-from-a-sink
shape, once the arrival it waits on is named. `cf test`'s multi-user mode
(`packages/cli/lib/multi-user-test-runner.ts`) runs each participant in its own
worker realm against one shared space, and its `{ label }` / `{ await }` markers
are writes to a marker document in that space — one per participant, so no
document has two writers. Announcing a marker commits it after everything the
announcing participant has already committed, and the orchestrator announces
only once that commit is confirmed. Crossing a marker resolves a `defer()` from
that document's sink in the awaiting worker.

By the time the marker arrives, the server holds what the announcing participant
wrote before it, so the reads that follow resolve against a server that has it.
Two mechanisms deliver it and both are ordered behind the marker. A document
already in the awaiting replica's watch set arrives in a fan-out frame the
server computes by diffing current storage, so a frame carrying the marker
cannot omit an earlier write it has not yet sent. A document outside that set is
fetched on demand by the assertion's own `pull()`, and the response reflects
current server state. The assertion is therefore read once, at quiescence, with
no convergence loop around it: a false value is a failure.

Reach for this rather than a settle-and-retry loop whenever the write is
something the test can name — name the arrival, wait on it, then read. Worker
requests wait for a response without a wall-clock limit. A worker error rejects
its pending and future requests. If every unfinished participant is waiting for
an unannounced marker, the orchestrator reports a deadlock. An announced marker
that never arrives leaves the request pending: the shared server keeps the
event loop open, so the CI step or job limit, or local cancellation, ends that
run.

### Browser-hosted unit tests have a harness backstop

That fail-fast is Deno's, and the browser-hosted unit tests that
`packages/deno-web-test` runs do not get it — `iframe-sandbox`, `identity`,
`static`, and the `ui` browser tests. Their waits are the
`defer()`-from-a-callback shape described above, but they run inside a page,
whose event loop the page itself holds open, so a wait that never resolves hangs
rather than failing.

One bound at the harness level covers them. `deno-web-test` stops waiting on a
test after `testTimeout` — 40 seconds by default, set per suite in
`deno-web-test.config.ts` — and fails that test with a message naming it and
saying how long it waited, leaving the rest of the run to report as usual.

This is the distinction `waitForCondition`'s safety net draws, one level up: a
stuck-condition bound rather than a bound at the call site. It is why a
wait inside one of these tests still takes no timeout of its own — adding one
per call site would cap what each wait can observe, which is the thing being
avoided, while the harness bound only decides when to stop believing a test will
ever finish.

By the test in [Wall-clock time is not a measure of
progress](#wall-clock-time-is-not-a-measure-of-progress), the backstop's early
fire is not safe: it fails a passing test. It is kept because the alternative —
letting astral's own retried deadline expire — takes the whole run down without
naming a test, and that alternative also caps the bound: a suite that somehow
needs more than the default should raise `testTimeout` and keep it under
astral's fifty-second floor. Where the forty-second default comes from, and why
this bound is the most clock-jump-exposed one the repository keeps, is worked
through in [the rationale
document](waiting-in-tests-rationale.md#sizing-the-deno-web-test-backstop).

`packages/deno-web-test/README.md` records what the bound does not cover: a test
blocking the event loop outright, and the stuck test's own work, which goes on
running in the page afterwards.

## Tearing a runtime down waits on its worker

A teardown that drops a runtime waits for the worker to say it is done.
`RuntimeConnection.dispose()` sends a `Dispose` request and waits for the
reply before it touches the transport, so that the storage the worker has
buffered is flushed before the thread carrying it stops. Requests here carry
no deadline, and this one is exempt from the abort that settles every other
request in flight, which leaves the reply as the only thing that settles it. A
worker that has stopped answering therefore never lets `dispose()` return.
Neither of the two teardowns that await one adds a bound of its own, and what
each is left exposed to differs.

The browser teardown, `disposePageRuntime` in
`packages/integration/shell-utils.ts`, asks the page through `page.evaluate`,
which astral bounds on its own account at about five minutes for these suites
— [the rationale
document](waiting-in-tests-rationale.md#sizing-the-deno-web-test-backstop)
has the mechanism and the arithmetic. That is a bound relied on rather than
kept, and the teardown adds none of its own.

What astral's bound does not supply is a name: a `RetryError` says only that
the attempts ran out. So the catch reports the page instead, through the probe
[the shared state primitive](#a-shared-state-primitive) describes. Nothing
settled the disposal's request, so it is still in flight when the probe reads
it, and the pending-request lines name it and say how long it has been
outstanding. Those come from `RuntimeClient.getPendingRequests`, which reads
main-thread bookkeeping and needs no round trip, so a wedged worker is the
case it still answers. A failure warns rather than throws, since this is
cleanup: a caller whose work is done has nothing left for it to fail, and a
`finally` reaching it has a failure of its own to carry.

The in-process suite, `packages/runtime-client/integration/client.test.ts`,
binds each client with `await using`, so its teardown is `dispose()` itself
with nothing between. Nothing bounds that: the worker holds Deno's event loop
open, so the fail-fast the in-process waits above rely on never fires, and the
run reaches the CI step limit. What places such a hang is the runner's own
output — the last test printed without an `ok` is the one whose teardown is
waiting — and what it is waiting for is a `Dispose` reply by construction,
since that is the only request a teardown sends. Why a bound is not the answer
there is in [the rationale
document](waiting-in-tests-rationale.md#the-runtime-disposal-teardowns).

## Waiting for the scheduler and for the worker reconciler

Two pieces of machinery come up often enough in unit tests, and dispatch
differently enough from each other, that guessing at their timing is where fixed
delays tend to creep back in.

The **scheduler** delivers a runtime-backed cell's updates through `queueTask`
(`packages/runner/src/scheduler/diagnostics.ts`), which is `setTimeout(fn, 0)`.
That is a macrotask, so yielding to the microtask queue never reaches a change
made through a real cell, however many times the test yields. Wait for these
with `runtime.idle()`, which resolves once the scheduler has settled.

The **worker reconciler** (`packages/html/src/worker/reconciler.ts`) is
synchronous apart from one line. It queues its VDOM ops as it renders and
flushes them from a `queueMicrotask` callback, which hands the batch to the
`onOps` callback the test registered. So once the change itself has landed, the
ops are one microtask away, and a microtask the test queues afterwards runs
after the flush, because microtasks run in the order they were queued.

The reconciler tests in `packages/html/test/` write plain `Deno.test` and wait
through `t.settle`, added to the test context by a preload:

```ts
// Shown for illustration only.
Deno.test("...", async (t) => {
  cell.set(next);
  await t.settle();
  assertEquals(collector.getOpsOfType("set-prop"), expected);
});
```

Nothing is imported. The package's test task runs `test/clock-preload.ts`
before the test modules (through Deno's `--preload`); it replaces `Deno.test`
so each test runs under a clock that freezes only positive-delay timers, and it
adds `settle` to the context. `test/clock.d.ts` gives `t.settle` its type, which
`deno check` sees because it type-checks the package directory as one program.
The preload is a thin wrapper: it calls `installFakeClock` from the shared
harness in `packages/test-support/test/clock-preload.ts`, selecting that harness's
`freeze-all` mode. The runner preload calls the same harness in its
`auto-advance` mode (below), so the timer-faking core lives in one place.

A zero-delay `setTimeout(fn, 0)` still fires, driven through the real event
loop, so the scheduler's dispatch, the reconciler's flush, and teardown all
resolve on their own. `t.settle` resolves once every zero-delay timer and
microtask has run to a fixpoint, so it covers both the mock-cell and
runtime-cell trees these tests mix, and needs no runtime argument.

A `setImmediate` counts as one of those zero-delay timers. The harness replaces
it too, and registers what it schedules exactly as it registers a
`setTimeout(fn, 0)`, so a turn taken through `setImmediate` fires in the same
batch and is counted by the same census. Without that it would run beside the
harness rather than under it, ahead of every turn the harness was holding, and
neither `settle()` nor `tick(ms)` could hold it back.

`t.settle` is an ordering guarantee rather than a deadline, so it cannot lose a
race under load. It also holds for a test asserting that an op is *absent*: once
it returns, every op the change was going to produce has been delivered, so no
later batch can falsify the absence. Those tests pass vacuously when nothing has
flushed at all, so their teeth come from the wait being long enough to have seen
an unwanted op.

The frozen clock is what keeps a fixed delay from creeping back in. A
`setTimeout(resolve, 10)` sleep, in any spelling since they all bottom out in
the same timer, is a positive-delay timer, so it is never fired and the promise
it backs never resolves. A test that waits on one deadlocks, which the async-op
sanitizer reports at once rather than letting the sleep pass by luck. No test in
the package needs a real positive-delay timer; one that did would deadlock and
announce itself.

## The runner suite: advancing the runtime's own timers

`packages/runner` loads the same shared harness — its
`packages/runner/test/clock-preload.ts` calls `installFakeClock` in the
`auto-advance` mode, wired through `--preload` on the package test task — and
follows the same rule for test sleeps, but it cannot simply freeze positive-delay
timers the way the reconciler tests do. Runner's own reactivity is time-coupled: the scheduler, the wake
shaper, and storage arm positive-delay timers — throttle and debounce windows,
committed-write backoff, conflict retries — that `runtime.idle()`,
`cell.pull()`, and commit then await. Freeze those and a plain reactive test
deadlocks on the runtime's own machinery, not on any sleep it wrote.

So the runner clock sorts a positive-delay `setTimeout` by who scheduled it,
using the immediate stack frame:

- A timer scheduled from `src/` — the runtime's own — **auto-advances**: once
  the event loop is idle, every zero-delay turn that was armed having run,
  logical time jumps to the earliest pending one and fires it, in fire order,
  with `Date.now` and `performance.now` moving in lockstep. So a throttle window
  or a backoff retry elapses instantly and deterministically, and the reactive
  waits above resolve on their own, with no real time passing — and never ahead
  of a turn that was already queued. That last clause is what keeps a frame's
  delivery ahead of a production deadline: the loopback transport and the
  memory server's refresh each take a turn per frame, and the pump lets the
  whole chain run before it jumps. Why it has to is worked through in [the
  rationale
  document](waiting-in-tests-rationale.md#the-pump-waits-for-the-loop-to-go-idle).
- A timer scheduled from a `test/` file — a wall-clock sleep — **freezes**, so a
  test that waits on one still deadlocks and the sanitizer reports it. Delete
  the sleep and wait on `runtime.idle()`/`cell.pull()`/`runtime.settled()`,
  which now settle on their own.

Because the runner tests are mostly `describe`/`it` blocks, whose callbacks
receive the framework's context rather than the one the preload wraps, the
controls are a global `clock` (typed in `test/clock.d.ts`) rather than methods
on the test context. `clock.settle()` drains reactive work without moving time,
and pauses auto-advance while it does, so a test can observe a state partway
through a window before the timer that ends it fires. `clock.tick(ms)` advances
logical time explicitly, firing the runtime's and the test's own timers, so a
test that genuinely measures time — a throttle expiring, a debounce trailing
run, a backoff schedule — steps through its windows deterministically instead of
sleeping. An intermediate "has not fired yet" check uses `clock.settle()`; the
step that lets the window elapse uses `clock.tick`. `clock.reset()` returns
logical time to zero and drops pending timers: one frozen clock wraps a whole
`describe`, so a suite whose cases each read absolute coarsened time (the `#now`
grid tests) calls it from `beforeEach` to start each case from a known instant.

The idle rule decides how a test may wait. A loop of round trips — `pull()`,
`idle()`, `synced()`, repeated a fixed number of times — never lets the loop go
idle, so no production timer fires inside it: the memory server's refresh
cadence, a convergence backoff, a claim's staleness bound all stand still, and
a value the fan-out would have delivered never arrives. That is the timing
dependence such a loop has, failing the same way every time rather than
passing on the cadence of the loop. Wait on the event instead —
`waitForCellValue` on the cell that will change, `synced()` on the commit whose
marker the fan-out carries, `clock.tick()` where the test genuinely measures a
window — and the wait itself idles the loop, which is what fires the timer. A
`pull()` computes and reads; for a document the replica already holds it
fetches nothing, so what it returns after another replica's write is what the
fan-out has delivered so far.

One file stays on the real clock, listed with its reason in the runner preload's
`realClockFiles` list. It is a resume test that holds the per-element documents
in its transport so the coordinator reconciles while they are absent, which is
the state it exists to observe. A commit carrying a read of a withheld document
is rejected as stale, and the catch-up the rejection waits on cannot arrive
while the hold is on, so the retry cycle repeats until the test releases it.
Real time paces that cycle; auto-advance fires each round's timer as soon as it
is armed, and the loop allocates until the process runs out of heap. A hold that
spans a reconcile therefore needs the real clock; a shorter one, that no retry
outlives, does not. The test itself waits on transport edges, never on a delay.
[The rationale
document](waiting-in-tests-rationale.md#the-runner-clock-retired-exemptions-and-converted-waits)
works that retry loop through in full.

Other entries have been retired from that list as the deadlines and test
designs behind them were fixed. [The rationale
document](waiting-in-tests-rationale.md#the-runner-clock-retired-exemptions-and-converted-waits)
records what each hang turned out to be; read it before adding a new entry,
because every retired one looked like it needed the real clock and did not.

The `test/` versus `src/` classification reads the scheduling frame from a
stack trace, and it keeps working after a runtime has run SES lockdown: a
positive-delay `setTimeout` written in test code freezes before and after the
first `Runtime` exists. How the harness reads frames that lockdown's error
taming would otherwise blank is in [the rationale
document](waiting-in-tests-rationale.md#how-the-runner-clock-classifies-timers-across-ses-lockdown).

When auto-advance runs away, the harness stops the test rather than letting the
process die: past a fixed number of fires within one test it throws, naming the
arming site that accounted for most of them. That is a runaway detector rather
than a wait with a deadline — a healthy test never approaches the count, and
what it reports is a livelock. Where the ceiling sits and why is in [the
rationale
document](waiting-in-tests-rationale.md#sizing-the-auto-advance-runaway-ceiling).

### A production backstop cannot carry a test

A production backstop — a timer that lets a wait give up and proceed as if the
event it waited for had arrived — is the one kind of `src/` timer the pump must
not be allowed to fire quietly. It fires the moment nothing else is pending, so
a test whose awaited event never arrives passes anyway, riding a logical jump
in place of the event; and where the module's logger sits above the warn the
backstop logs, the count behind that warn is the only trace. The runner preload
therefore installs a guard over every test, `test/support/silent-backstop-guard.ts`,
that snapshots the count behind each listed backstop around the test body and
fails the test when one moved, naming the backstop and what its firing means.

The listed backstop is the conflict read-repair wait in `src/storage/v2.ts`: a
commit's rejection returns after `CONFLICT_READ_REPAIR_TIMEOUT_MS` when the
caught-up frame its retry is gated on never arrives. A test that trips the
guard is either withholding that frame — a manual fan-out it never flushed — or
has found a regression in the caught-up path. Either way the remedy is the
event, never a wider backstop. `test/silent-backstop-guard.test.ts` holds the
guard to this by running a test built to ride the backstop under the package
preload and expecting the guard to fail it.

One consequence is worth stating because it is easy to trip over. A test that
guards a wait with its own wall-clock deadline — a `setTimeout(reject, ms)` — has
that deadline frozen along with every other test sleep, so it never fires and
backstops nothing. The remedy is the one the rest of this note prescribes:
resolve the wait on the event itself with no deadline, and let a signal that
never arrives quiesce the loop so Deno fails the pending wait. The multi-space
mergeable-commit test's move onto the fake clock is the worked example, in [the
rationale
document](waiting-in-tests-rationale.md#the-runner-clock-retired-exemptions-and-converted-waits).

### Gating storage fan-out: manual flush, not a long delay

A multi-session storage test whose premise is controlled staleness — one
replica provably NOT having received a concurrent write — gates the shared
in-process memory server's fan-out rather than racing it. The primitive is the
server's `subscriptionRefreshDelayMs: "manual"` mode (via
`newSharedServer({ subscriptionRefreshDelayMs: "manual" })` in the runner's
test utils, or `newLoopbackServer` for other packages): the flush timer is
never armed, dirty spaces accumulate, and frames spread only at the explicit
synchronization points — `server.flushSessions([space])` at the point delivery
is wanted, or `server.idle()`, which drains held fan-out to keep its
quiescence contract.

A large numeric delay is not a substitute. Under auto-advance the pump fires
the earliest pending `src/`-armed timer regardless of its nominal delay, so a
"held" 60-second flush timer fires as soon as the event loop idles — the hold
only ever worked by accident. Manual mode has no timer to fire, on any clock.

Single-manager `StorageManager.emulate()` harnesses need none of this: their
private server flushes on a zero-delay turn, so awaited round trips deliver
their own fan-out and there is no second session to keep stale. The loopback
transport itself delivers each server frame on its own turn, so
`clock.settle()` drains in-flight deliveries without letting any coalescing
window elapse.

Both take that turn through `armTurn` in `packages/memory/v2/turn.ts`, which
claims it twice over: a zero-delay timer, which is what `settle()` counts, and
a `setImmediate`, which is the same turn for a fraction of the cost. Whichever
arrives first runs the handler and cancels the other. So an outstanding turn
is always an armed zero-delay timer that `settle()` can see, while the waiting
itself costs microseconds rather than the two milliseconds Deno takes to wake
its event loop for a timer.

## The background-piece-service suite: the same clock for a polling loop

`packages/background-piece-service` loads the same shared harness — its
`packages/background-piece-service/test/clock-preload.ts` calls
`installFakeClock` in the `auto-advance` mode, wired through `--preload` on the
package test task, with the controls exposed as a global `clock` typed in
`test/clock.d.ts` — and follows the same rule for test sleeps. It needs the
clock for the same reason the runner does: the service's own machinery is
time-coupled, so freezing every positive-delay timer would deadlock a plain test
on the service's own loop rather than on any sleep the test wrote.

Three pieces of the service arm positive-delay timers. `SpaceManager.#execLoop`
parks on `sleep(pollingIntervalMs)` between polls of its task queue.
`SpaceManager.stop` races a `setInterval` that watches for the active job to
finish against a `sleep(deactivationTimeoutMs)` deadline. And
`WorkerController.#exec` arms a `setTimeout(timeoutMs)` that rejects a worker
request the worker never answers. Each of these is scheduled from `src/`, so the
clock reads it as a production timer. The poll and the deactivation deadline
reach `setTimeout` indirectly, through the `sleep` helper in
`@commonfabric/utils`; that does not change the classification, because the
clock reads the immediate caller's frame, and `sleep`'s own frame is a `src/`
frame too. They therefore auto-advance: the poll interval elapses instantly,
and an unanswered worker request's timeout fires on its own.
The auto-advance mechanism is the runner's, described just above.

Each wait these tests need goes through the clock. A test that exercises one
branch of the exec loop and then stops it starts the loop, calls
`clock.settle()` to let it reach its parked `sleep`, clears `isRunning`, and
calls `clock.tick(1)` to fire that parked sleep so the loop sees the flag and
exits. A test that waits for a worker's initialize request to time out calls
`clock.tick(1)` to fire the `timeoutMs` timer. A test that needs only the next
reactive turn — a sink firing, a shutdown callback running — waits on
`clock.settle()`.

One file stays on the real clock, listed in the preload's `realClockFiles`:
`otel.test.ts`. It exercises the real OpenTelemetry SDK against a real loopback
OTLP receiver. The provider's `forceFlush` and `shutdown` guard each flush with
their own `setTimeout`, armed inside the vendored SDK rather than from `src/`;
under auto-advance that guard fires against the real HTTP round trip before it
completes, and the flush reports that the span processor did not finish within
its timeout. The SDK's periodic metric reader arms a repeating interval that is
a production timer too. These tests carry no sleeps or deadlines to convert, so
the fake clock would buy them no determinism; they keep real time, already opt
out of the op sanitizer for those timers, and tear them down through
`shutdownOpenTelemetry`.

## The runtime-client suite stays on the real clock

`packages/runtime-client` keeps its unit tests on the real clock. Most of its
tests need no wait at all, or only a macrotask drain — a `setTimeout(fn, 0)`
that lets the scheduler's own `queueTask` dispatch land, an awaited round-trip,
or a sink fire once. Those drains cross one macrotask boundary, carry no
real-time floor, and stay as they are. A positive-delay sleep is still the
shape to avoid here: the waits that once needed one are event-driven instead —
draining the task queue to prove a `dispose()` stays pending, and stepping a
frozen `performance.now()` to make one request measurably older than another.

Two tests genuinely measure real time and stay on it: the main-thread and
worker loop-lag probes, which block the thread past a 100-millisecond
interval's tick and then read how late it fired. A fake clock fires timers
exactly on schedule and cannot advance under a synchronous busy-wait, so it
cannot reproduce loop lag at all; the busy-wait plus a short trailing yield is
the honest way to observe a late fire.

Do not move the package onto the runner preload. The loop-lag intervals are
armed unconditionally and only unref'd, and auto-advance ignores unref, so
every connection a test builds would drive the fake clock to its runaway
guard. The full analysis is in [the rationale
document](waiting-in-tests-rationale.md#why-the-runtime-client-suite-stays-on-the-real-clock).

One case opens a `FakeTime` of its own, which is the directly-imported tool
described below rather than the preload the paragraph above rules out. It pins
that a request the worker has not answered settles on nothing but its reply or
the connection's disposal. Proving that a request stays pending means proving
a negative over time, and a task drain cannot: it crosses one macrotask
boundary, which no positive-delay timer is due within, so it would pass just
as well against a connection that rejects the request a minute later. The
fake clock advances an hour and runs every timer any bound would have been
armed on.

Two things make that case safe here, and both are worth repeating in any other
case that reaches for the same tool. It builds its connection before opening
the clock, so the loop-lag interval is armed on the real one: `unrefTimer`
hands the id it is given to `Deno.unrefTimer`, and a faked id would name an
unrelated real timer. Building first also keeps that interval off the fake
clock, where an hour of ticks would run it thirty-six thousand times for
nothing.

## The utils package: a fake clock the test imports

The reconciler and runner harnesses above install their fake clock through a
`--preload` that wraps every `Deno.test` in the package, so a test gets the
frozen clock whether or not it asked for one. That default is deliberate there:
it catches a wall-clock sleep written anywhere in a suite that is meant to wait
on events instead. `packages/utils` does not want that default. It is a grab-bag
of utilities; most of its tests are not about time at all, and some — the
logger's timing tests, for one — busy-spin against the real `performance.now`,
which a faked clock would leave spinning forever. Only the `sleep` and `timeout`
tests want controlled time.

So `packages/utils/test/sleep.test.ts` takes the opposite approach: instead of a
preload forcing a clock on the whole package, the two suites that want one import
it and open it themselves. They use `FakeTime` from `@std/testing/time`, opened
with a `using` declaration so it restores the clock when the block ends:

- `using time = new FakeTime()` freezes the real timer that `sleep` or `timeout`
  arms, so nothing resolves until the test advances the clock.
- `await time.tickAsync(ms)` advances the fake clock by `ms` and settles the
  promises the fired timers resolve.
- `Date.now()` reports the faked time, so a `sleep(5)` is observed as still
  pending after `tickAsync(4)` and resolved after a further `tickAsync(1)`, with
  the elapsed time reading exactly five milliseconds — an exact assertion with no
  real waiting and no flake.

Nothing global is installed for the package, so the other suites in the same file
need no exception list: `yieldToEventLoop` and `unrefTimer` open no `FakeTime` and
run on the real clock, which is what they need — `yieldToEventLoop`'s timer-turn
budget is measured against the real `performance.now` and its test drives a real
CPU-bound spin, and `unrefTimer` detaches a real Deno timer from the event loop's
ref-count. This is the lighter tool: reach for the preload harness when a whole
suite should be held to controlled time, and for a directly-imported `FakeTime`
when only a test or two measures a delay.

## A wait the initial state already satisfies establishes nothing

A wait is evidence only while its condition cannot hold before the thing it
waits on has happened. One that can hold earlier returns at once, and
everything after it reads a state the test never established. Nothing reports
that: the wait returns, the assertions run, and the case is green.

Test selection is what makes this more than a redundant line. A case running
after a sibling inherits the sibling's effect, so an early-satisfiable wait
costs it nothing; the same case selected alone
([the selection plan](../plans/pull-request-test-selection.md)) has only its
hooks behind it, and the wait is then the whole of what stands between the
case and a state nothing produced. So the shape is most dangerous exactly
where an independence check would have to catch it, and that check cannot:
running the case by itself is what produces the green.

`clickCfButtonAndWaitForText` in
`packages/patterns/integration/cfc-browser-helpers.ts` is the browser
instance. It returns when the expected text is already present, which is what
an idempotent re-entry wants and what a case whose expected text is also an
initial state must not have: that case passes having clicked nothing. Such a
case wants an expectation only its own click can produce, or wants to be one
case with whichever case produces it.

The setup wait in
`packages/patterns/integration/sqlite-read-clearance-multi-runtime.test.ts` is
the other side of the rule, and needs no page. Each of its `STEADY_ROWS`
entries requires a query to have settled with no error and on a stated row
count, and the state before the seed is neither: a read of a row-rule-bearing
SQLite database that no write has created yet refuses for want of column
provenance, so the result document carries an `error` and no rows. Neither
half of the condition is reachable early.

Making a case independent is what most often creates this, which is worth
knowing before applying the rule to another file. A case given its own write
so that it can stand alone then writes a value some neighbor also writes, and
in file order the wait is handed the state it was going to observe.
`waitForCondition` evaluates its predicate once as it installs
(`packages/integration/utils.ts`, "Check immediately; the condition may
already hold"), so the case observes nothing, and the propagation it appears
to check is being checked by the neighbor. Give such a case a value no other
case in the file writes, and its wait has a change to observe in either
ordering.

Run that rather than reason about it: delete the write, run the case alone,
and confirm it fails reporting the value its wait names. A failure naming
anything else means the wait was not resting on that write.

Whether the case claims to observe a change is the boundary. A case whose
subject is the initial state — named for the state it asserts, asserting the
state the page loads in — is not this defect, and giving it a value of its own
to write would take away what it tests.

Both properties come from one choice — name the exact state the case expects,
not a weaker fact that state implies. A wait for "settled" alone is satisfied
by a settled emptiness; a wait for "settled on alice's two rows" is satisfied
neither by the state before the write nor by a cleared query returning a row
it should have withheld. The second fails setup naming the reader and the
query; the first would let the case run on and read a state it did not
establish.

## Proving a negative

A test that asserts something never happens has no event of its own to wait for.
Waiting a fixed interval and then declaring success is the shape to avoid. It
puts a floor under what the test costs and a ceiling on what it can catch, since
whatever arrives after the interval is missed, and it reports the same pass
either way — the assertion never depends on the wait having been long enough.

Send something that must arrive after the thing being ruled out, wait for that,
then assert the thing never came. Any channel that preserves order carries this.
A `postMessage` between a fixed pair of windows does, and so does a chain of
them: `packages/iframe-sandbox/test/iframe-csp.browser.test.ts` has each
guest document write a marker back to the host once its load event fires, and
a CSP error from the same guest travels the same two hops — guest to outer
frame, outer frame to host — so a test holding the marker holds any error that
fired. The "subscribes"
and "cancels subscriptions between documents" tests in
`packages/iframe-sandbox/test/iframe.browser.test.ts` use the same idea against
the update stream: write to a key that is still subscribed, and once the guest
reports it, an update for the unsubscribed key would already have arrived had
one been sent.

Two things decide whether this works, and both are worth checking rather than
assuming.

The barrier has to be genuinely ordered after the event, which is a claim about
the specific mechanism and not about elapsed time — for one browser and one
policy, the CSP suite's violation reports land on both sides of the document's
load event depending on the resource type. Where no such ordering exists, say
so and leave the case on its interval rather than inventing a barrier that only
looks like one; `unbarrierable` in that file records the cases that stay.

A barrier that is not really ordered after the event fails silently: the test
goes on passing while asserting nothing. Pair the conversion with a control — the
same fixture and the same wait against input that does trigger the event, which
must observe it by the time the barrier lands. `barrierControls` in the CSP suite
is that check. Moving its barrier earlier leaves every negative case green while
the controls that can speak to ordering go red, which is the point of having
them.

A barrier is not the only way out of an interval, and it is not the first
thing to look for. Where the thing being ruled out is a component failing to
settle, the settling itself is a positive event, and observing it asserts
more than any interval could. `packages/runner/test/executor-fan-out.test.ts`'s
OW29 storm pin is the worked example: the storm it rules out is a serving
loop whose cycles keep finding work, which never suspends on its input wait,
so the test waits for that suspension (`SpaceServer.suspendedOnInput`) and
reads its wave bound there. The memory server's fan-out and the serving
runtime settle INSIDE that predicate, between two readings of the
suspension, so a frame still held or a run still owed un-suspends the loop
before the second rather than landing after the wait returns — the fan-out
on both sides of the runtime settle, since that settle can itself run work
that commits. The reading is taken again on each wave cycle the serving loop
reports, because the loop arms its input wait synchronously after one. Hold
`#hasWork()` true and that wait never returns while the three-second interval
it replaced passes — the storm's cadence is the flush deadline, which on that
host is longer than any interval a test can afford. The control is the same
reading taken while the edits are being covered, which must go false; a
reading pinned true would satisfy the wait on its first attempt. What stays
out of reach there is a wake from work neither settle covers, and the
comment says which shape that leaves rather than implying the assertion
covers everything.

Which controls those are is worth working out rather than assuming, because a
control can be written so that it cannot fail: only an event that can arrive
after the page's own scripts have run tests the ordering at all. A control that
raises its error from a synchronous throw while the document parses stays green
however early the barrier moves — it shows the error channel is live for its
fixture's shape, not that the ordering holds. Sort the controls deliberately
and say which is which, or the group reads as proof it does not supply. The CSP
suite is worked through as the example — which violations order where, and
which of its controls can actually fail — in [the rationale
document](waiting-in-tests-rationale.md#proving-a-negative-the-csp-suite-as-a-worked-example).

## Guard against new usage

A check prevents new integration tests from importing the polling `waitFor`.
`tasks/check-no-waitfor.ts` scans the `.ts` files under any `integration/`
directory beneath `packages/` (excluding the `@commonfabric/integration` package,
which defines `waitFor`) and fails when one takes `waitFor` as a value from an
import of that package and is not on the check's allowlist. Two spellings reach
it and both count: the bare `@commonfabric/integration` specifier, and a relative
path ending at the package's `utils.ts` or `index.ts`. Commenting the import out
clears the check, so it stays out of the way while a test is being migrated —
text inside a comment or a string is not an import. A type-only import, whether
`import type { waitFor }` or an inline `{ type waitFor }`, is erased before the
test runs and polls nothing, so it does not count either. Run it with
`deno task check-no-waitfor`;
the CI "Check" job runs it on every pull request. The error names the offending
file and points at `waitForCondition`, `awaitViewSettled`, the in-process
`defer()` replacement, and this report.

The check is a speed bump against reaching for `waitFor` out of habit, not a seal
against a determined evasion. It reads the import statement and nothing else, so
a namespace import — `import * as I from "@commonfabric/integration"` followed by
`I.waitFor(...)` — passes it. Every import of the package in the repository uses
the named form. Treat a green check as "no new polling `waitFor` was imported the
usual way", not as proof that a suite polls nowhere.

The allowlist inside `tasks/check-no-waitfor.ts` covers only the exceptions the
check can see: the integration-test files that import the shared `waitFor` from
`@commonfabric/integration`. That is a subset of the exceptions listed below.
The others fall outside the scan and are not on the allowlist — the in-process
`test/` files that each define their own local `waitFor` poll loop (the check
never reads a named import there), the `MultiRuntimeHarness.waitFor` method and
its callers (a different `waitFor`), `packages/runner/integration/sqlite-cfc-commit-eval.test.ts`
(which waits through a local helper rather than the shared import), and
`packages/integration/shell-utils.ts` (inside the excluded package that defines
`waitFor`). Do not add those to the allowlist: the check never scans them, so the
stale-entry test would reject the entry.

For the in-scope entries, the check's own tests assert that the allowlist and the
set of integration-test files still importing the shared `waitFor` stay in step:
a new offender fails the check, and an allowlisted file that later drops `waitFor`
fails the tests until its entry is removed. When a new in-scope usage is genuinely
one of the exception shapes below, add the file to the allowlist with a one-line
reason and record it here.

## Where the polling `waitFor` stays

These are grouped by the reason the poll stays, and the reasons are not equally
good. For most of them a bounded `waitFor` is the honest observation, and
replacing it would add coupling or complexity rather than remove flakiness. Two
groups are here on weaker grounds: files that nothing automated runs, where a
conversion would not pay for itself, and a few waits in files that CI does run
which are simply not converted yet. Those two say so where they appear; do not
read them as endorsements.

### No page, and no callback to hang a promise on

These observe in-process state that becomes true as a side effect, with no event
boundary the test can await without adding one to production code.

- `packages/runtime-client/integration/client.test.ts` — the `MockDoc`'s
  rendered `innerHTML` waits. The worker's render pipeline applies the HTML with
  no completion callback the test can hook, and a fresh `cell.sync()` round-trip
  has no registered subscription. There is no event boundary to resolve a
  deferred from without adding a render hook to the mock purely for the test.
- `packages/shell/integration/piece.test.ts` — the one poll that reads a freshly
  reloaded piece (`cc.get(pieceId, true)`) has no registered sink, so it stays a
  bounded poll on its own sync round trip. The other result-cell reads in this
  file wait through `waitForCellValue`, which sinks on the result cell and reads
  it at quiescence. The equivalent reads in `counter.test.ts` and
  `nested-counter.test.ts` resolve a `defer()` from an existing
  `resultCell.sink(...)`.
- `packages/runner/test/support/wait-until.ts` — the `waitUntil` the runner's
  server-execution suites once shared. Six test files still wait through it on
  state the serving loop produces as a side effect of its own cycles: an engine
  row, a watermark advance, a stats counter. They are
  `executor-compile-and-run`, `engine-read-through`, `executor-lifecycle-verbs`,
  `executor-fetch-program-instances`, `executor-fetch-instances` and
  `executor-sqlite-instances`. What they poll is the same material the
  boundaries listed under "Suites that drive a live memory server" above
  report — an engine row, a watermark seq, a stats counter, whether a tenure is
  active, a cell read after `sync()` — so each is a conversion left undone
  rather than a poll this section endorses, and the helper stays for as long as
  they do and no longer. Its deadline is a
  stuck-condition backstop of the same kind, for the same reason — the serving
  loop holds the event loop open through its lease-renew interval, so the
  fail-fast described above never fires. What the poll interval under it costs
  is a latency floor on every one of those waits, and that is what converting a
  file removes. The failure names elapsed milliseconds and the poll count, which
  is what separates a predicate that never came true from one the test never got
  to evaluate.

  One class of that state does have a reporter after all: an engine row the
  serving loop writes that also fans out to a flag-ON client — the served
  intent landing in the firing session's effects instance is the canonical
  case — reaches that client's storage-notification relay, the same relay the
  effects channel consumes. `wait-on-delivery.ts` beside `wait-until.ts` wakes
  on those deliveries and re-reads an engine predicate on each, subscribing
  before its first check so an arrival cannot slip between the two; the engine
  holds any such state before delivering it, which is what makes an engine
  predicate safe to re-check on the client's wake. Its deadline is the same
  kind of stuck-condition net, and crossing it proves only that the predicate
  did not come true within the window — no fixed bound can tell a stuck wait
  from one delayed past it. Its width, generous headroom over any healthy
  arrival observed, is what keeps a crossing pointing at a stuck wait rather
  than at contention stretching a passing run — the reading a deadline close
  to the healthy latency cannot support. It is the shared `stuckNet` above.
  The bounded poll stays for the rest:
  the watermark, the stats counters, and engine rows nothing delivers.

### A pull that drives its own loading

`packages/generated-patterns/integration/pattern-harness.ts` compares a runtime
`Cell` value, headless. There is no page to attach an in-page waiter to. A
callback does exist — the harness registers `result.sink(() => {})` to keep the
result reactive — but that callback is empty and records nothing, so today there
is no latest value for a waiter to resolve against. It also sits on the root
`result` cell, while each assertion walks a path of `key()` steps down to a
nested cell and waits on `targetCell.pull()`.

The pull is not purely an observation, which is what makes it hard to swap for a
sink. It awaits the scheduler, and when the read reached a link whose target this
replica had never loaded, it settles those loads and re-reads as each arrival
reveals the next hop, for a bounded number of rounds. A sink reports committed
changes; it does not drive that traversal. Polling the pull until it converges is
the honest wait.

Reaching a lazily scheduled node, on the other hand, is not a reason to keep a
pull, and that is where this section is easiest to over-read. The scheduler
runs a computation only while it is reachable from a live root — an effect, a
materializer, or a node marked as provisionally demanded — so a node whose
output nothing observes stays dormant however long a test waits. `pull()`
supplies such a root: it subscribes an action that reads the cell, marked as an
effect, and cancels it once the scheduler goes idle. `cell.sink()` subscribes
the same kind of root and holds it until the caller cancels, so a wait built on
`waitForCellValue` keeps the node awake for the whole wait rather than for one
scheduler cycle. Where demand is the only thing the pull supplied, the sink
supplies it too and the loop around the pull was doing nothing.

`packages/runner/test/cfc-inspect-conf-label-builtin.test.ts` is the worked
example. Its waits were a bounded `pull()` poll, on the grounds that the pull
drives the `inspectConfLabel` builtin's node; they are now single
`waitForCellValue` calls with no loop and no bound. That the demand is what
matters, and not the pull, is checkable: replace the wait with
`runtime.settled()` followed by a storage sync and a plain read, and every case
reads the result cell as undefined, because nothing ever asked for its value.

### Race, backpressure, and convergence tests

Here the poll measures eventual convergence across timing the test does not
control, and there is no single "it converged" promise to await.

- `packages/runner/test/scheduler-commit-backpressure.test.ts` — the committed
  total or list lands only after the runtime works through several
  backoff-delayed retry attempts, each parked on a real timer. `runtime.idle()`
  returns between retries, so it does not span the wait.
- `packages/runner/test/memory-v2-pull-reactivity.test.ts` — waits on
  `runtime.scheduler.isDirty(action)`, which reads membership in the scheduler's
  internal dirty set. Nothing fires when one specific action flips to dirty;
  de-polling would mean adding a scheduler hook purely for the test.
- `packages/runner/test/effect-conflict-recovery.test.ts` — recovery after a
  cross-replica conflict is driven autonomously by the runtime's catch-up
  re-queue, and one case deliberately disables the reader-dirty fast path so only
  the timing-sensitive re-queue can recover. The automatic re-run is the behavior
  under test; there is by construction no event to await.
- `packages/runner/test/memory-v2-reconnect-race.test.ts` and
  `packages/memory/test/v2-restore-flush.test.ts` — the waits that watch for a
  deliberate mid-flight sabotage or a restore replay to reach a specific in-flight
  point. These are race checkpoints the surrounding interleaving depends on;
  bounded polling expresses "wait until the sabotage/replay happened" without
  coupling test control to the race window.
- `packages/runner/test/memory-v2-stacked-commit.test.ts` — the wait for a
  conflict rejection to reach the runner, read as the `commit-conflict` logger
  count. `pushCommit`'s catch moves that count synchronously before it calls
  `finalizeRejection`, and the logger exposes counts through readers only, with
  no subscription, so nothing fires when one moves. The commit the test is
  watching must not settle — that is the assertion — so its own promise is not
  the signal either.
- `packages/runner/integration/sqlite-cfc-commit-eval.test.ts` — the predicates
  read derived pattern result cells that settle only after a full server round
  trip (handler send, scheduler run, server commit, server-side re-derivation,
  re-query). The helper already drains with `runtime.idle()` and
  `storageManager.synced()` each iteration; the poll observes eventual
  convergence of that multi-stage evaluation.
- The frontier-cardinality waits in `memory-v2-subscription.test.ts`,
  `memory-v2-pull-reactivity.test.ts`, and `memory-v2-reconnect-race.test.ts`
  ("all N reachable ids present") are soft: event-driven only via a counting
  `defer()` over several integrate batches, which is a poll wearing a callback.
  They stay bounded convergence checks.

### A different `waitFor`

`packages/patterns/integration/cfc-group-chat-demo-multi-runtime.test.ts` and
`packages/patterns/integration/sqlite-read-clearance-multi-runtime.test.ts` call
`MultiRuntimeHarness.waitFor` (defined in
`packages/patterns/integration/multi-runtime-harness.ts`), a different method
that settles several in-process Deno-worker runtimes and reads durable cells
across them. It is not the `@commonfabric/integration` `waitFor`, has no page,
and its cross-runtime convergence poll is the honest mechanism for a caller
that names only the state it wants and not the write that produces it.

A caller that can name the write does better, and the multi-user `cf test`
markers are that shape: a marker committed after the writes it stands for turns
"has it converged yet" into "has this arrived", which a sink answers. [Naming
the arrival, across runtimes](#naming-the-arrival-across-runtimes) describes it.

### Cross-page joint condition

`packages/patterns/integration/lunch-poll-vote.test.ts` waits on a condition
joined across two different browser pages (both must show both voters).
`waitForCondition` installs its waiter in one page and resolves on that page's
binding, so it cannot express a two-page condition; the cross-browser
propagation wait stays a poll.

### Instrumentation one-shots

`packages/patterns/integration/default-app.test.ts` keeps `waitFor` for one-shot
instrumentation: arm a trace, reset a logger baseline. Each such call returns
false only until a runtime API is present, so it observes runtime API readiness
rather than a UI condition, and it is profiling scaffolding rather than an
assertion. Every one sits behind a `CF_CAPTURE_*` environment gate that defaults
to off, so a normal run never reaches them.

The notebook regression test in that same file resets the event-invocation trace
on every pass, and needs no wait for it. The reset returns false only until the
runtime exposes its telemetry methods, and the click that opened the note modal
settled the view, so those methods are already present; the reset is called once
and its success asserted. A wait on runtime-API readiness would have been no
better, because that condition flips with no DOM mutation behind it and would
fall back to the in-page waiter's coarse backstop for something already true.

### A shared state primitive

`packages/integration/shell-utils.ts`'s `waitForState` compares the shell's
serialized `AppState` (view plus identity DID), read through
`globalThis.app.serialize()`. A handful of test files call it directly, but
`ShellIntegration.goto()` also calls it internally after every navigation, so
every suite that navigates through the shell depends on it.

An in-page predicate could reach the state it reads: `globalThis.app` is a page
global, and a `waitForCondition` predicate runs in the page, so it could call
`serialize()` for itself. Two other things block the conversion.

First, the predicate is serialized into the page and closes over nothing from the
test module, so everything it needs has to be inlined. `waitForState` compares
views through `isAppViewEqual` from `@commonfabric/navigation`, and it compares
identities by DID — which the serialized state does not carry. `serialize()`
writes the identity out as a raw key pair, and `deserialize()` recovers the DID by
importing that private key through `Identity.fromRaw`. An in-page predicate can
import neither module, so converting means re-implementing both view equality and
private-key import inside the page, forking logic the shell relies on.

Second, an `AppState` transition does not reliably mutate the DOM, so the
MutationObserver hub would have nothing to pulse on and the wait would fall back
to the coarse 500-millisecond in-page backstop. That polls more slowly than the
50-millisecond loop it would replace.

So the poll stays, and what it reports when it gives up is what has to carry the
diagnosis. On its own, a `waitFor` timeout says only that a predicate did not
come true, with a stack that points at `waitFor` and nothing about the page.
`waitForState` catches that and adds a block naming the view it was awaiting,
the identity it was awaiting where one was given, the last state it managed to
read, and what the page held at the moment it gave up: the document's URL,
title, and HTTP status, whether the shell's `x-root-view` element is in it,
whether `globalThis.app` is there and which view it holds, the requests its
runtime has sent the worker and has no reply to, and the tail of
console messages `Page.applyConsoleFormatter` retains in the page. The page half
of that is `readShellPageProbe` in
`packages/integration/shell-page-probe.ts`; `describeStateWaitFailure` in
`shell-utils.ts` assembles the whole block, and a test may call it directly to
report a wait of its own the same way.

`ShellIntegration.goto()` checks one of those facts before it starts waiting at
all. The shell's entry document carries an `x-root-view` element, so a document
without one is not the shell, and every wait that follows reads state through
`globalThis.app`, which such a document never defines. `assertShellDocument`
fails the navigation there and then, naming the document that arrived. The case
this catches is a server answering with something other than the shell — for
instance the toolshed's `Failed to proxy to ...` page, served with a 502 when
its own fetch to the shell dev server fails. Without the check, every test in
the run waits out the full minute and reports nothing that names the cause.

`waitForCondition` carries the same block, and carries it for every wait rather
than for a wrapped few. A wait that reaches the stuck-condition net renders the
source the page ran, the arguments it was handed one to a line, the last throw
the predicate itself made where it made one, and the page it ran out against;
`describeConditionWaitFailure` in `packages/integration/utils.ts` assembles
that. The source is usually what names the wait, waits carrying no names of
their own, and where several sites share one predicate the arguments are what
tell them apart. The predicate's own throw is the part nothing else can supply:
a predicate that throws on every evaluation leaves a page identical to one a
predicate merely reads as false.

The net is five minutes and no test can sit through one, so its length for a
single wait is read from `CF_WAIT_FOR_CONDITION_TIMEOUT_MS`. That exists for
the tests that drive this report and for nothing else: shortening the net in a
run caps what a wait may observe, which is what the net is written to avoid.

`login()` reports the same block, and adds what the wait cannot know. It waits
on `waitForCondition` for the shell to publish `globalThis.app`, which a
document that is not the shell never publishes, and the runtime handshake after
it names which of its two stages ran out and nothing about the page it ran
against. Both are wrapped, so any login failure names the identity being logged
in as and what the page held. `readAndDescribeShellPage` is the
whole of what a report needs from a page — it reads the probe, renders it, and
reports a page it could not read at all rather than replacing the failure being
reported with a second one. Reach for it, rather than pairing the read and the
render, when adding page context to an error of your own.

The first line of each of these messages comes from `describeThrown` in
`packages/integration/describe-thrown.ts`, because a failure inside the page
does not arrive as an `Error`. The browser protocol reports an uncaught page
exception as a detail record, and stringifying one yields `[object Object]`.
`describeThrown` takes an `Error`'s message, the first line of a page
exception's description, and for anything else points at the cause, which the
thrower attaches and Deno prints below the message.

### A shell script observing another process through a kernel mount

`packages/cli/integration/fuse-exec.sh` drives the FUSE daemon as a separate
process through a real mount, and observes it from bash. Its poll loops —
`wait_for_path`, `wait_for_json`, `resolve_entity_dir`, `wait_for_piece_value`,
`wait_for_trace_line` and `resolve_traced_write_fh` — stay polls.

There is no event channel to convert them to. The state each loop waits on lives
in another process: the daemon's tree for the path and JSON loops, the server's
cell for the value loop, and the daemon's log file for the two trace loops. Bash
has no callback to resolve a `defer()` from.

Watching the filesystem does not substitute for one. A mounted path appears
because the daemon added a node to its own tree, and that is not a filesystem
operation passing through the mount, which is what the kernel raises inotify
events for. The daemon's two notification calls, `notify_inval_entry` and
`notify_inval_inode`, tell the kernel to drop cache entries; they do not announce
new state to a watcher.

The two path loops also drive the work they wait for, which is the same shape as
the pattern harness's `pull()` above. The lookup behind a `test -e` is what makes
the daemon fetch: for the space root it runs `connectSpace`, and for the piece
paths beneath it `CellBridge.prepareLookup`, which hydrates the piece property.
Polling the probe until it converges is the honest wait.

Two waits in this script are not polls, and should not become polls.

Mount readiness needs no timing loop. `cf fuse mount --background` calls
`awaitBackgroundMountStartup`, which waits for the daemon to report the
`mounted` supervisor state and confirms both the supervisor and the child are
alive before the command prints the PID. Every other exit from that function
throws, and a throw kills the child and fails the command, so a script that has
parsed a PID has a daemon that reported mounted. That wait is itself
event-driven, carried by the pipe that [the FUSE mount
handshake](waiting-in-tests-rationale.md#the-fuse-mount-handshake) describes.

The daemon reports that state once its session loop is dispatched, so the mount
serves requests, but the paths under it still hydrate lazily and the documents at
those paths settle on a debounce after the path first answers a lookup. A path
existing is not the same as its content being final. Those gaps belong to
`wait_for_path` and `wait_for_json`, which poll a lookup and a rendered document
until each converges, each carrying its own timeout. What is left for the script
directly is one check that the daemon survived the handshake.

The rest of the suite's design — the stale-descriptor assertion that reads the
daemon's trace rather than the cell, the cleanup that hard-kills on a failure
and unmounts gracefully on a pass, and why polling the daemon's `.status` file
is avoidable — is studied in [the rationale
document](waiting-in-tests-rationale.md#the-fuse-exec-suite).
