# Timing side-channel mitigations

Status: Implementation in progress. Companion to `SES_SANDBOXING_SPEC.md`.

## Threat and scope

The threat is an untrusted pattern constructing a timer fine enough for a
Spectre-class cache-timing attack. A Spectre gadget needs a clock that advances
*during* the attacker's own synchronous secret-dependent operation, so it can
distinguish a cache hit from a miss.

- In scope: ordinary widgets that need roughly one-second-resolution time, such
  as a "3 minutes ago" label.
- Out of scope: games and apps that need precise event timing. These are not
  supported. There is no precise-timing capability, and patterns are denied fine
  time by default.

Principle: a pattern's perceived time is bounded by the coarsest of every signal
it can observe — both the *value* of a timestamp and the *cadence* at which
events and changes are delivered. So every such signal is floored to about one
second, and no fine clock is allowed to exist in pattern code.

## Structural barrier (verified, pinned by tests)

A pattern compartment cannot build a counter that advances during its own
synchronous computation:

- Single-threaded cooperative scheduling; no parallel execution of pattern code.
- Secure ECMAScript lockdown suppresses `SharedArrayBuffer` and `Atomics`, and
  the compartment global allow-list omits `Worker`, `SharedWorker`,
  `MessageChannel`, `MessagePort`, `performance`, `setTimeout`, `setInterval`,
  `queueMicrotask`, and `requestAnimationFrame`.
- Secure ECMAScript taming makes `Date.now()`, `new Date()`, and `Math.random()`
  yield no usable value inside a compartment.
- Cross-origin isolation is not enabled, so a browser would not expose
  `SharedArrayBuffer` or a high-resolution `performance.now()` regardless.

These invariants are pinned by `packages/runner/test/security-timing.test.ts`, so
a Secure ECMAScript upgrade or a widened global surface that re-opens a fine
clock fails loudly.

## Channel inventory and mitigations

Every real-time-correlated signal a pattern can reach, and how it is closed.

| # | Signal | Status | Mitigation |
|---|--------|--------|------------|
| 1 | Ambient `Date.now()` / no-argument `new Date()` / `Math.random()` — the clock/entropy intrinsics | reachable from lifts and handlers | W1 frame-gate, enforced at the intrinsic by W6 |
| 2 | A lift emitting an event to signal "I re-ran" | ungated | W1: frame-gate |
| 3 | Input-event cadence/count, and the post-block backlog | always-on: cadence shaped (W3), backlog capped (W4) | W3 delivery shaping (DONE) + W4 queue cap (DONE) |
| 4 | `#now` cell-flip arrival/ordering | value coarsened + tick grid-aligned (≥1 s); deliberately left unshaped (low value; ≥1 s + grid-aligned + W1) | — |
| 5 | Server-pushed cell changes (cross-tab/cross-machine), the `$value` write bypass, and own commit-completion latency | `$value` keystroke writes to a pattern reader are shaped through the cell-notification shaper (plan B, DONE); server pushes are NOT shaped — the adoption-era reason is deleted (server-execution v2 stage C; archived at [incremental observation adoption](../../history/specs/scheduler-v2/incremental-observation-adoption.md)), the shaping re-check is owed (runtime-mapping.md N10), and they are network-bounded (see below) | cell-notification shaper on the storage-notification hook |
| 6 | Builtin progress cells — `fetchData` `pending`, large-language-model `partial` (~15 Hz) | LLM `partial` coarsened to ≤1 Hz always-on (DONE); `fetchData` `pending` left to W1 (terminal, not a cadence) | coarsen at source |
| 7 | Raw `fetch()` exposed directly to patterns | CLOSED: a compartment endows no `fetch`, and the name is withheld from the authored surface, so calling one fails to compile | `SANDBOX_WITHHELD_GLOBALS` in `packages/utils/src/sandbox-contract.ts`, pinned by `runner/test/sandbox-global-contract.test.ts` (DONE) |
| 8 | `Date.now()` / `Math.random()` re-enabled by a Secure ECMAScript config drift | neutered by an implicit default | W0 (pinned by test) |

Randomness note: `Math.random()` is not itself a timing channel — random
numbers are neither monotonic nor time-correlated. It matters here because
randomness in a lift breaks idempotency, and idempotency is what lets the
reactive graph quiesce, so it rides the same W1 gate. It is otherwise a separate entropy/covert-channel
axis, tracked separately from the timing work, and with games out of scope it has
no replacement to design.

## Why the levers combine (event channel)

For in-scope user-interaction events we keep delivering them, but expose no clock
field and rate-cap the SUSTAINED delivery cadence. Shaping is limited to what is
strictly necessary. The threat is a SUSTAINED high-frequency stream (held-key
autorepeat, rhythmic tapping) used as a reference oscillator, so throttle the
sustained rate but leave ordinary interaction realtime — a short burst of
deliberate clicks is not an oscillator, and holding it adds latency for no
security gain (under W1 the sandbox cannot read the sub-second arrival phase a
per-event delay would hide; a red-team confirmed this — the only reader was the
raw `fetch()` clock, channel 7, now closed by withholding `fetch`). So two
levers:

- No clock field in events closes the timestamp-value channel.
- A token-bucket rate cap floors the SUSTAINED sample rate. Each pattern has a
  bucket of `BURST_CAPACITY` (~10) tokens, one consumed per delivery, refilling
  one per 1000 ms window. While tokens remain, input is delivered immediately
  (realtime); once the bucket empties, a sustained stream is floored to about one
  delivery per pattern per window. This is what defeats the counting attack and
  the reference-oscillator attack from a held key or rhythmic tapping — it denies
  the attacker a sustained high-frequency stream to use as a sub-second clock. The
  rate cap, not any per-event noise, is the load-bearing defense.

Why a burst is safe. The bucket is a bounded, one-time allowance — refilled only
by quiet time, not per window — not a sustained oscillator. It yields at most
`BURST_CAPACITY` fast samples, and with `fetch()` now closed (channel 7) there
is no sub-second operation left for a short burst to time. Tightening the burst
toward zero is a cheap future option if a fine clock ever leaks in; a per-event
random delay, tried and removed, is not needed because W1 already makes the
phase unreadable.

Nothing is dropped, up to a stated bound. Overflow beyond the burst is queued,
not discarded, and the two wake paths queue differently. The event path keeps
every overflow event in arrival order (first-in-first-out, not last-wins) and
releases them as one batch per window — one timing sample, counts preserved, so
a counter still counts every click. The bound on that claim: a released batch
still enters the W4-capped event queue, so every event is kept up to the
per-stream backlog cap (`MAX_EVENT_BACKLOG_PER_STREAM`, 256); a flood larger
than that within a window still collapses last-wins at the queue (under the
same-origin rules described in W4 below). The cell
path coalesces its overflow per cell to the latest value (a `$value` box
shows the newest text) — for a data cell only the current value is meaningful,
so keeping the intermediate values would add nothing a reader can use. The
bucket refills during quiet, so a later burst is realtime again. A sliding
window is wrong — it never sees a quiet gap under sustained interaction and
would starve the pattern of input.

Coalescing must be keyed per *pattern*, not per stream or per event type.
Per-type budgets let an attacker fire several event types from one gesture and
recover sub-second timing by counting the distinct deliveries in a window. Both
wake paths meet this today: the event path groups a pattern's streams into one
bucket (item 4 below), and the cell path's group key is the pattern instance
(split only by input class; see the interactive/passive split below).

## Plan of action (sequenced)

Landing order, smallest and safest first. Each is its own commit/PR.

- **W0 — Guardrail and Secure ECMAScript pin. DONE.**
  `packages/runner/test/security-timing.test.ts`. Non-breaking. Encodes the
  structural barrier above. (The `dateTaming`/`mathTaming` lockdown options do
  not exist in this Secure ECMAScript version; the test is the correct
  encoding.)

- **W2 — Close the raw `fetch()` clock (channel 7). DONE (no ambient fetch).**
  A compartment endows no `fetch`, and `fetch`, `Headers`, `Request`, and
  `Response` are on `SANDBOX_WITHHELD_GLOBALS`, so the type libraries a pattern
  compiles against do not declare them: authored code that reaches for one
  fails to compile rather than throwing once it runs.
  - **The channel it closes.** A pattern that can issue a request of its own
    choosing and observe when the promise settles holds a fine wall-clock edge.
    Reading the coarse clock, issuing a fetch of known round trip, and reading
    the clock again in the continuation reveals whether the sub-second phase was
    above or below a computed threshold; varying the round trip binary-searches
    the phase to arbitrary precision. Each fetch is another measurement, so
    repetition compounds the leak rather than diluting it. With no ambient
    `fetch` there is no such promise to time.
  - **Where network access lives instead.** The runtime's fetch builtins —
    `fetchJson`, `fetchText`, `fetchBinary`, `fetchJsonUnchecked`,
    `fetchProgram` — are reactive nodes the runtime issues on the pattern's
    behalf. Their completion drives a cell flip observed in reactive/lift
    context, where W1 denies any clock, so there is no handler-clock edge to
    correlate and nothing to coarsen. They also carry what an ambient `fetch`
    could not: the runtime records each request as a CFC sink request, holds it
    as a CFC sink request, which a deployment's ceiling then gates
    (`packages/runner/src/cfc/sink-inventory.ts`), and signs it when it targets
    a first-party route.
  - **Consequence — an imperative API client has no surface to run on.** A
    handler cannot await a reactive node, so a request sequence is declared as a
    chain of nodes whose inputs a handler writes rather than as awaited calls.
    Handler-initiated reads and per-item fan-out fit that shape. Two things do
    not: a non-idempotent mutation, because a node re-issues its request
    whenever its inputs change and a token refresh changes them, so a send would
    send twice; and a chain whose length is not known when the pattern body runs,
    such as following a pagination cursor, because the body declares the nodes.
  - Tested in `runner/test/sandbox-global-contract.test.ts` (every withheld
    global is absent from a real compartment, and the type libraries declare
    none of them) and `runner/test/security.test.ts` (module and callback
    compartments both withhold it).

- **W1 — Keystone: frame-gate the clock, entropy, and lift event-emit.**
  - **Clock/entropy gate: DONE (always-on, unconditional).** The gated ambient
    intrinsics `Date.now()` / no-argument `new Date()` / `Math.random()` route
    through `sandboxDateNow()`/`sandboxRandom()` (`builder/safe-builtins.ts`),
    which consult the active frame via `getTopFrame()`: they throw in a lift/pure
    context, and in a handler pass entropy through and return the clock.
  - **The handler clock is the event's time, frozen — not the live wall clock.**
    A handler reads the instant bound to the event that triggered it
    (`Frame.eventTime`), captured once when that event was created and coarsened
    to one second at the read, not `Date.now()` sampled live. Time therefore does
    not advance during a handler's own work: a read before and after an `await`
    (or any elapsed real time) returns the same value, so a handler has no clock
    that ticks during a synchronous secret-dependent operation. Events a handler
    emits carry the same instant forward (captured at the send site in
    `Scheduler.queueEvent`, threaded through the queued event onto the dispatched
    handler's `tx.dispatchedEventTime`), so a whole causal chain from one gesture
    shares one time and no derived handler can read a later clock than its cause.
    A renderer or root event captures a fresh coarse instant at creation; across
    separate events time still advances, bounded by how fast events arrive (which
    the delivery shaper already floors). The check is dynamic (call-time) because
    shared helpers are reached from both contexts.
    Tested in `packages/runner/test/time-capability.test.ts` (frozen across
    reads) and `packages/patterns/integration/time-capability-intrinsics.test.ts`
    (a handler reads the event's coarse time; the instant is carried forward to
    an emitted event so a chained handler reads the same value). The gate is
    breaking: about 297 call sites across about 77 pattern files — handler-context
    uses keep working (just coarser); lift-context "elapsed time" must migrate to
    the reactive `#now` clock (per-pattern judgment; see the migration-triage
    tool). The pattern migration below had to precede the gate becoming
    unconditional.
  - **Lift event-emit gate: DONE (always-on).** A positive
    `frameKind` (`"lift"` | `"handler"`) is now set on pattern frames at the
    single chokepoint (`runner.ts` `createPatternFrame`) and threaded through
    `pushFrameFromCause` onto the `Frame` type. The `cell.ts`
    stream-send branch throws when `getTopFrame()?.frameKind === "lift"`. Gating
    on the positive marker — rather than the absence of `inHandler` — means
    internal/renderer event delivery (no `frameKind`) and handler emits
    (`"handler"`) pass through, so delivery is never broken. Tested in
    `time-capability.test.ts` (lift throws; handler and internal pass).
  - **Pattern migration: COMPLETE** for the clock; the entropy-seeded bash
    sandbox id is handled by option-3, which has now landed (see below). A first batch of
    21 pattern files moved
    their lift/computed/pattern-body clock reads to the reactive `#now` wish
    (one-shot `#now` for stamps, ticking `#now/N` for live displays; BOTH helpers
    parameterized to take the timestamp as an argument). Each was adversarially
    verified per file: no lift/body-context clock or entropy call remains, and the
    wiring preserves behavior (a behavior-faithful change on its own). The
    migration had to be COMPLETE before the gate became unconditional.
    Tail status:
    - **Body-level date defaults — DONE.** `parking-coordinator`, `calendar`,
      `weekly-calendar`, `daily-journal`. A body-time default cannot synchronously
      read the async `#now` cell, so the Writable/Cell is seeded empty and lazily
      filled from `#now` once it resolves (a side-effecting computed); today-string
      values are `#now`-derived computeds, guarded for the load window. (This also
      fixed the prior `daily-journal` crash from seeding a Writable with a cell.)
    - **Cross-file shared-helper clusters — DONE.** `budget-tracker`
      `getTodayDate` (`schemas.tsx`) + `expense-form.tsx` — the helper takes
      `nowMs`; lift callers pass `#now`, handler callers pass `Date.now()`.
    - **Exempt (no migration needed).** `notes/schemas` `generateId` is dead (no
      caller). The other `generateId`
      helpers (`self-improving-classifier`, parking-coordinator `genId`,
      weekly-calendar/`event.tsx`) are only called from handler/action
      contexts.
    - **Bash sandbox id from entropy — DONE (option-3 landed upstream).**
      `suggestion.tsx` and `omnibox-fab.tsx` used to seed the `bash` tool's
      `sandboxId` from `Math.random()` at pattern body, which the gate forbids.
      Upstream #4217 (`da833f6d4`) makes the framework fill `sandboxId` for any
      tool that declares it, from the content-addressed entity id of the tool's
      own definition cell — unique per instance, stable for the instance's life,
      derived from identity rather than the clock/randomness, and framework-owned
      (a `FrameworkProvided<T>` brand rejects any pattern- or model-set value, and
      the field is stripped from the model-facing schema). Both patterns now just
      `patternTool(bash)` and read no entropy; the rebase superseded their interim
      `Math.random()` migration. The cross-instance sandbox-sharing collision this
      guards against (the server names sandboxes by this id at
      `/v1/sandboxes/${sandboxId}`) is closed by the content-addressed derivation.
    - **Loading-state polish — DONE.** A few migrated files passed `?? 0` to a
      formatter, flashing a bogus value (e.g. the journal and calendar relative
      labels) before `#now` resolved; each now returns a neutral/loading value
      until `nowCell.result` is non-null.
    - **Gate is unconditional — DONE.** The `enforceTimeCapability` flag and the
      per-runtime config lines that used to set it (`shell` `lib/env.ts`
      `EXPERIMENTAL`, `background-piece-service` `main.ts`, and `toolshed`
      `index.ts`) have been removed; the gate now applies in every runtime,
      including test runtimes. (The non-idempotent test fixtures that read the
      clock/entropy in a lift on purpose live under `test/non-idempotent/*` and
      correctly throw.) Behavioral verification is DONE for the
      offline-instantiable patterns (see below).
    - **Option-3 precondition — MET (landed at the upstream/main rebase).**
      The one precondition that used to block shipping — the framework-provided
      bash `sandboxId` — landed as upstream #4217 (`da833f6d4`). `suggestion.tsx`
      and `omnibox-fab.tsx` no longer read entropy at pattern body, so they and
      anything that embeds them (e.g. `daily-journal` via `Suggestion`)
      instantiate cleanly under the unconditional gate. The `KNOWN_PENDING_OPTION3`
      pin and the do-list pattern-test exclusion have been removed, and those
      patterns join the clean set.
    - **Behavioral verification — DONE (offline patterns).**
      `packages/patterns/integration/time-capability.test.ts` instantiates the
      offline-instantiable migrated patterns with the gate on, materializes their
      lifts (`start:true` + `result.sink` + `idle`), and asserts the scheduler
      reports no `TimeCapabilityError`. A negative-control fixture (calls
      `Date.now()` in a computed) proves the harness catches a violation; a
      positive control (reads `#now` in a computed) proves the sanctioned path
      passes. It surfaced a real miss the per-file static pass had not caught:
      `birthday.tsx` generated its year-dropdown options at module-evaluation time
      via a helper that read the ambient clock, so the module threw the moment it was
      compiled — breaking `birthday` itself and every pattern that embeds it
      (e.g. `record-backup` through the Record module registry). Fixed by deriving
      the year list from the reactive `#now` clock. The test also surfaced the
      transitive-embedding hazard: before option-3, `daily-journal` threw through
      `suggestion.tsx`'s body-level entropy — the bash sandbox-id case broke not
      just `suggestion` but every pattern that embeds it. Option-3 has since landed
      (above), so that whole chain is now clean.
    - **Full-suite gate verification — DONE (offline).**
      `packages/patterns/integration/time-capability-full.test.ts` discovers every
      shipped pattern that reads the gated clock/entropy intrinsics
      (`Date.now()`/no-argument `new Date()`/`Math.random()`), instantiates
      each under the gate (`start:true`), materializes its lifts, fires its result
      streams (so handler-context reads run under real dispatch too), and asserts
      no `TimeCapabilityError` escapes. Only a `TimeCapabilityError` fails a
      pattern; a pattern that cannot instantiate offline for an unrelated reason is
      reported as skipped, not a finding. The file is auto-discovered by the
      test topology (the `pattern-integration` suite reads the `integration/`
      directory), so CI runs it in the `pattern-integration` suite. Result of
      the run: **0 unexpected violations**, with the games
      battleship/card-piles/scrabble among the clean set and `suggestion`,
      `omnibox-fab` and `daily-journal` clean since option-3 landed. A pattern is
      skipped when it needs a verified-module or integration environment to
      instantiate, such as the multi-module `ModuleVerificationError` on
      weekly-calendar or a sub-pattern helper. The deliberately non-idempotent
      `test/non-idempotent/*` fixtures are excluded — they read the clock/entropy
      in a lift on purpose and correctly throw. The curated
      `time-capability.test.ts` also pins the three games as a fast check.
      - **Narrow residual.** A skipped pattern needs a verified-module or
        integration environment to instantiate fully, which a CI run with those
        integrations available would close. The lift/pattern-body surface — the
        one the gate throws on — is behaviorally clean across the shipped set.

- **W3 — Delivery shaping for input events. DONE (always-on) for the
  input-cadence channel.** Renderer-originated (user-input) stream events are
  routed through the wake shaper's event path (`scheduler/wake-shaping.ts`,
  intercepted in `Scheduler.queueEvent`) that, per pattern: strips injected clock
  fields (`timestamp`/`timeStamp` scrubbed at every depth, including
  `detail.location.timestamp`; the DOM `timeStamp` is already dropped by the
  serializer), and runs a per-pattern token bucket (`BURST_CAPACITY` tokens,
  refilling one per 1000 ms): while tokens remain each event is delivered
  immediately (realtime), and the overflow is queued — every event kept in
  arrival order, not last-wins — and released as one batch per window, so a
  sustained stream is floored to about one delivery per pattern per window
  without dropping a click. Classification is by renderer provenance
  (`isRendererTrustedEvent`) — exactly the external-input class; internal,
  builtin, and relayed sends are not shaped. The stripped copy keeps its
  renderer-trust marker so UI-contract write authorization is preserved. Held
  events sit OUTSIDE the event queue (not parked in place via `notBefore`), so
  internal/system stream deliveries are never stuck behind a held input event;
  `idle()` waits for the holding buffer to drain and `dispose()` clears its
  timers. Tested in `runner/test/delivery-shaping.test.ts`.
  - **Shaping is transitive without a mark.** There is no "already shaped"
    marker that a relayed event inherits, and none is needed: a downstream wake
    cannot fire faster than the rate-limited source that caused it, for a
    structural reason on each path. On the cell path, a reader woken by a
    renderer-input write runs in a fresh, unmarked transaction, so its own
    writes are ordinary internal commits and are never re-shaped. On the event
    path, a pattern relays through its `$event`, which the runtime materializes
    as an immutable-cell copy — a new object that does not carry the
    renderer-trust marker — so a relayed send is not renderer-trusted and
    `shouldShapeDelivery` returns false for it. In both cases the downstream
    firing happens at most once per already-shaped source firing.
  - **A shaped event keeps its causal origin.** The holding buffer carries each
    event's durable event id and origin transaction through the delay
    (`DeliverOpts` in `scheduler/wake-shaping.ts`). So speculation lineage
    can still cancel a shaped event whose origin commit fails, the durable event
    id stays derived from its origin transaction rather than being minted
    fresh, and the W4 backlog collapse keeps distinguishing origins instead of
    merging held events under a missing origin.
  - **Coalescing is per-pattern. DONE.** A pattern that drives several distinct
    streams from one gesture (e.g. `keydown`+`keypress`+`input`) shares one
    bucket and one release window across those streams, so counting the
    distinct deliveries in a window no longer recovers sub-second timing. Item 4
    under "Outstanding work" describes how handlers are tagged with their
    owning instance.
  - **Input via bidirectional `$value` bindings is shaped (plan B). DONE.** A
    pattern can substitute the event path with `<cf-input $value={cell}>`, whose
    per-keystroke writes go through the cell-write path (`CellSet`), not
    `queueEvent`, so they never reach the event shaper. That path is now covered
    by the cell-notification shaper (channels 4/5; see item 3 under "Outstanding
    work"), which defers the pattern reader's wake under the same token bucket.
    The input-cadence channel is therefore closed on both the event path and the
    cell-write path.
  - **Status of channels 4–6** is detailed in item 3 under "Outstanding work":
    server-pushed cell changes and `$value` writes are shaped (DONE),
    large-language-model `partial` is coarsened (DONE), and `#now` and
    `fetchData` `pending` are deliberately left unshaped (each with its
    rationale there). The event-path input-cadence channel (the
    held-key/tap-to-audio attack) is the one the capability gate could not
    cover and is closed unconditionally.

- **W4 — Bound the event queue. DONE (always-on).** Closes the
  block-and-count timer: while a handler is blocked, events bound to a pattern's
  handler pile up, and the size of the post-block burst is a proxy for elapsed
  time. `queueSchedulerEvent` (`scheduler/events.ts`) now caps the per-(stream,
  handler) in-queue backlog at `MAX_EVENT_BACKLOG_PER_STREAM` (256,
  `scheduler/constants.ts`): below the cap events queue normally — so ordinary
  delivery, including internal/system events, is unchanged — and at the cap a
  further enqueue collapses into the last pending entry (last-wins, `onCommit`
  chained) rather than growing the backlog, so the observable count cannot grow
  without bound. Tested in `runner/test/delivery-shaping.test.ts` (the cap
  caps and collapses; small internal bursts unaffected).
  - **Collapse is same-origin only.** The surviving entry carries an origin
    transaction for speculation lineage, and that field is fixed at enqueue.
    Coalescing an event from a different origin into it would misattribute the
    lineage (the dispatch-time release keys off the entry's origin). So the cap
    collapses only into the last pending entry with the *same* origin; events
    from other origins queue normally past the cap. Those cross-origin events are
    still rate-bounded elsewhere — each is one handler firing, and the firing rate
    during a block is set by the external input rate that W3 already coarsens — so
    the count remains bounded. The self-inflicted runaway (one handler re-sending
    to its own stream, all one origin) is the case the cap actually bounds.
  - **Note.** The cap alone bounds the count; a per-stream 1 s-cadence drain via
    `notBefore` (further coarsening the delivery *rate* of a surviving backlog) is
    a possible refinement but is not required to bound the count, and the fine
    input-rate source it would guard is already held out of the queue by W3.

- **W5 — Document and harden.** This document; the Cross-Origin-Opener-Policy and
  Cross-Origin-Embedder-Policy headers in the serving layer; cycle/iteration
  limits as a liveness backstop for non-idempotent lifts (not the security
  boundary).
  - **COOP/COEP headers — DONE (deliberately non-isolating).** The shell route
    (`packages/toolshed/routes/shell/shell.index.ts`) sets
    `Cross-Origin-Opener-Policy: same-origin-allow-popups` and
    `Cross-Origin-Embedder-Policy: unsafe-none`, neither of the isolating values.
    This keeps `crossOriginIsolated === false`, so `SharedArrayBuffer` and the
    high-resolution timers that cross-origin isolation would grant stay
    unavailable — the outcome this mitigation wants. (Landed independently in
    upstream/main.)

- **W6 — Gate the clock/entropy intrinsics directly. DONE (mechanism).** Two
  layers did overlapping work: SES tamed the raw intrinsics *to throw*, and
  separately the runtime exported `safeDateNow()`/`nonPrivateRandom()` as the
  sanctioned gated path patterns had to migrate to. W6 collapses them at the
  intrinsic.
  - **Implemented.** `packages/runner/src/sandbox/compartment-globals.ts`
    (`createCompatibilityGlobals`, which both module and callback compartments
    use) now injects a gated `Date` and `Math` into every pattern compartment,
    replacing the SES-tamed throw. `Date.now()` and the no-argument `new Date()`
    route through `sandboxDateNow()`, and `Math.random()` through
    `sandboxRandom()` (both in `builder/safe-builtins.ts`): a coarse value inside
    a handler, and a throw in every other context
    (lift/pattern-body, no frame). The deterministic
    `new Date(value)` / `new Date(y, m, …)` forms, `Date.parse`, `Date.UTC`, and
    all prototype methods pass straight through. The intrinsics never
    expose a fine clock, so the structural barrier is preserved: a lift and the
    bare compartment get no usable clock. Verified by
    `packages/patterns/integration/time-capability-intrinsics.test.ts`
    (lift-throws, handler-coarsens to 1 s, `new Date(arg)`-passes-through),
    `security-timing.test.ts` unchanged, and the widened
    full-suite (raw `Date.now`/`Math.random`/`new Date()` now in scope) still
    green with zero new violations.
  - **No escape to an ungated clock.** The gated `Date` shares the intrinsic
    `Date.prototype`, so an instance it makes is an ordinary `Date` to the host
    and to the data model. The classic escapes
    `(new Date()).constructor.now()` and `Date.prototype.constructor.now()` both
    land on the SES-tamed shared Date, which throws, and `createGatedDate()`
    asserts lockdown has run before it builds, so it fails loud rather than
    injecting a leaky clock if ever called too early. `instanceof Date` and the
    real methods still work. Pinned by
    `packages/runner/test/w6-intrinsic-escape.test.ts`, which drives every
    constructor/prototype escape and asserts none yields a number.
  - **Why it is better.** The native JS API becomes the safe API — authors write
    `new Date()` and get correct, safe behavior with no import and no lesson
    about `safeDateNow`. It kills the "raw `new Date()` throws under SES" bug
    class (a handler formatting an ambient `new Date()` works, coarsened,
    instead of throwing `Invalid time value`; a lift or pattern body still
    throws, which is the gate doing its job). Because the gate lives at the
    intrinsic it is
    unevadable (a transformer rewrite could be dodged with `const f = Date.now`),
    and because handlers already get a coarse clock it grants
    patterns no new capability — it is security-neutral, just a better delivery.
    It also shrinks the migration/audit burden: there is nothing per-site to
    migrate for handlers, and any lift clock read throws with the same guidance
    regardless of how it is spelled.
  - **What it does NOT remove.** Lifts still throw (correctly — a lift that reads
    a clock breaks reactive idempotency no matter how it is written), so a live
    or relative clock displayed from a lift still uses the reactive `#now` wish.
    W6 eliminates the `safeDateNow`-in-handlers half of the migration; the
    `#now`-in-lifts half is unchanged.
  - **Follow-on: retire the explicit helpers. DONE.** With the intrinsic gated,
    `safeDateNow()`/`nonPrivateRandom()` were redundant, and they have been
    removed. Every handler call site now uses the native
    `new Date()`/`Date.now()`/`Math.random()` (safe via W6, since the gated
    intrinsics are always-on everywhere patterns run), the builder API
    (`factory.ts`/`types.ts`) and public types (`api/index.ts`) no longer export
    the helpers, and the sandbox contract (`TRUSTED_DATA_HELPERS`) and bundle
    verifier no longer treat them as trusted names. The intrinsic gate
    `sandboxDateNow()`/`sandboxRandom()` remains.

### Outstanding work (sequenced)

**The two experimental flags (`enforceTimeCapability`, `coarsenEventDelivery`)
have been removed — every mitigation is now always-on.** W1/W6 (the clock/entropy
gate and gated intrinsics), W3 (event-delivery shaping, now with per-pattern
coalescing), W4 (the backlog cap), and channel-6 (LLM partial coarsening) all
apply unconditionally. Option-3 (item 1), the hard precondition for shipping to
real users, has now landed. The items are ordered by what unblocks what.

1. **Land option-3 (per-request sandbox id) — DONE (upstream #4217).** With the
   gate always-on, three patterns used to read entropy in a lift/body context and
   throw (`system/suggestion.tsx`, `system/omnibox-fab.tsx`, and
   `notes/daily-journal.tsx`, which embeds Suggestion transitively). Upstream
   #4217 (`da833f6d4`) made the framework provide the bash `sandboxId` from the
   tool definition's content-addressed entity id (unique per instance, derived
   from identity not entropy, framework-owned), so those patterns stop reading
   entropy and instantiate cleanly. The `KNOWN_PENDING_OPTION3` pin in
   `packages/patterns/integration/time-capability-full.test.ts` and the do-list
   pattern-test exclusion have been removed. This was the last precondition
   blocking the branch from being upstreamed.

2. **Retire `safeDateNow()`/`nonPrivateRandom()`. DONE.** The ~100 handler call
   sites now use native `new Date()`/`Date.now()`/`Math.random()` (safe via W6,
   the gated intrinsics being always-on), and the helpers have been removed from
   `builder/safe-builtins.ts`, the builder API (`factory.ts`/`types.ts`), the
   public types (`api/index.ts`), and the sandbox contract / bundle verifier. The
   intrinsic gate `sandboxDateNow()`/`sandboxRandom()` is unchanged.

3. **Close W3 channels 4–6.** The event-path input-cadence channel is closed;
   these are the remaining delivery paths a fine clock could still leak through:
   - **Channel 6 — large-language-model `partial`: DONE (always-on).** The partial
     cell streamed at ~15 Hz; the batch window is now fixed at one second
     (`PARTIAL_BATCH_MS` in `builtins/llm.ts`), flooring the partial-write rate to
     ≤1 Hz. Tested in `runner/test/llm-partial-coarsening.test.ts`.
   - **Channel 6 — `fetchData` `pending`: intentionally not coarsened.** Unlike the
     LLM partial it is a terminal `pending: true → false` transition, not a
     sustained cadence, and the interval it exposes (network latency) is already
     unmeasurable at sub-second precision because W1 denies patterns a fine clock.
     Adding ≥1 s to every fetch is not justified for a one-shot signal W1 already
     blunts.
   - **Channels 4 and 5 — cell-flip notification shaping (plan B).** Routing
     `#now` cell-flips through the shaped channel (channel 4), shaping the
     `<cf-input $value={cell}>` bidirectional-binding write bypass (channels 4/5,
     which writes via `CellSet`, never reaching the event shaper), and shaping
     server-pushed cell changes all need the same capability: a shaper on the
     cell-flip *notification* path (W3 shapes events, not cell writes). The obvious
     per-item shortcuts are unsafe — converting `#now` to a stream breaks every
     reader that reads it as a cell, and holding an input write's transaction open
     for the delay window breaks optimistic concurrency.
     - **Mechanism — DONE.** The wake shaper's cell path (`holdShapedCell` in
       `scheduler/wake-shaping.ts`) is the event path's twin:
       it holds the *notification* that a cell changed (after the write commits)
       and runs the same per-pattern token bucket — while burst tokens remain each
       flip is delivered on the next macrotask (realtime, so typing updates
       dependent UI per keystroke), and the overflow coalesces per cell (latest
       value wins, no cell dropped) and releases together at the next refill (one
       timing sample per window without losing any cell).
       The scheduler owns it, drains it in `idle()`, disposes it on teardown, and
       exposes `holdShapedCellNotification(groupKey, itemKey, chargeKey, deliver)`
       as the seam the per-source wiring calls. Fully unit-tested; the wiring
       below is what routes real sources through it.
     - **Source wiring — DONE for `$value`.** The single hook is
       in `scheduler/invalidation.ts` `processStorageNotification`: after
       a reader's plan is computed, `shapableWakeGroupKey` decides whether the
       change is a shapable real-world-timing source AND the reader is a pattern
       instance (carries a `pieceId`). If so, the wake is deferred through
       `holdShapedCellNotification` instead of scheduled immediately. The group
       key is the pattern instance plus the input class — `${ownerSpace}|${pieceId}|input`
       for renderer keystroke writes, space-qualified so instances of one pattern
       in different spaces never share a bucket; the item key is reader+cell.
       Server pushes are NOT routed here (see below). The reader
       re-reads current cell state when it runs, so nothing is lost — only the
       wake timing is coarsened; `idle()` waits for the shaper. The deferred
       thunk also re-records the reader's Contextual Flow Control trigger read at
       release, so the "this change triggered me" flow label survives the
       deferral even when an interleaved unshaped wake consumed the read recorded
       at notification time. Internal machinery (no pieceId) and ordinary local
       computation (not a shapable source) are never deferred, so normal
       reactivity is untouched. One signal lands here: `$value` renderer
       keystroke writes enter via `handleCellSet` (blind) and are stamped with a
       persistent `markRendererInputTx` mark (a WeakSet superset of the blind-write
       mark that survives to commit), recognized at the notification via
       `notification.source`. The reader `pieceId` is now set unconditionally
       at subscribe (`runner.ts` `observationIdentity`), not only under persistent
       scheduler state, mirroring how handlers are tagged for the event path. Tested
       end-to-end in `patterns/integration/cell-flip-shaping.test.ts` (a renderer
       write is held then delivered current; an internal write is unshaped); full
       runner suite green.
     - **Per-commit token charging — DONE.** A burst token counts one user
       gesture, not the fan-out of readers it wakes. Each notification (one
       source commit or one push) carries one charge key
       (`invalidation.ts` `commitChargeKey`), and every reader wake from
       that notification rides the same token
       (the wake shaper `hold`'s `chargeKey`): a keystroke that wakes N
       readers spends one token, not N. This is both better interaction quality
       (a pattern with many readers no longer burns its burst on one keystroke)
       and correct for the security cap: all readers of one commit observe the
       same instant, which is one timing sample, so charging it once matches
       what the cap is counting.
     - **Server pushes — deliberately NOT shaped (`|input` only).** Only
       renderer keystroke writes are routed through the cell shaper. Pushes
       (`pull`/`integrate`) were briefly shaped under a separate `|push`
       bucket; that was reverted while incremental observation adoption
       needed the push's readers marked dirty synchronously. Adoption was
       deleted with its observation carriage (server-execution v2 Phase 1
       stage C; the archived account is
       `docs/history/specs/scheduler-v2/incremental-observation-adoption.md`),
       so that reason is gone and whether pushes should now be shaped is an
       owed re-check (runtime-mapping.md N10); until it is decided, pushes
       stay unshaped.
       The security cost is small, and it is the assumption the `|push` bucket
       already rested on: a pattern cannot drive server pushes at sub-second
       cadence — it has no way to make the server push to it faster than real
       network traffic arrives — so the push cadence is network-bounded rather
       than pattern-controlled, and is not a reference oscillator a pattern can
       operate. Interaction quality also improves: passive background traffic (a
       synced `#now` clock, another tab writing a shared cell) never enters the
       shaper at all, so it cannot drain any burst allowance, and the standing
       worst case the `|push` bucket had — a sustained once-per-second
       background source keeping it drained, forcing other cross-tab updates
       onto the trailing flush — is gone.
     - **`#now` — deliberately not wired.** It is the low-value source (already
       ≥1 s and grid-aligned at the writer in `wish.ts`, and W1 denies the fine
       clock to read its phase), and shaping it would add up to one second of
       latency to every clock-reading pattern. Wiring it would need a per-runtime
       registry of its cell link-keys checked at the notification hook; the cost
       outweighs the marginal defense-in-depth, so it is left unshaped.
     - **Plan C** (unify the two shapers) is DONE — see item 6 below.

4. **W3 per-pattern coalescing. DONE.** Coalescing was per-stream, so a pattern
   driving several streams from one gesture got one window per stream (the
   attacker could count the distinct deliveries in a window). Now handlers are
   tagged with their owning instance (`schedulerObservationIdentity.pieceId`,
   derived from the process cell) at registration (`runner.ts`); the shaper's
   `hold` runs before the handler is resolved, so the scheduler looks the pieceId
   up from the registered handlers at the hold site (falling back to per-stream
   when none is known). The wake shaper groups held deliveries by pattern
   instance with one shared release timer and one first-in-first-out overflow
   queue per group — every held event is kept, in arrival order, regardless of
   which of the pattern's streams it targets — so a pattern's streams release at
   one instant (one timing sample per window, defeating the counting attack)
   without dropping any event. Tested in `runner/test/delivery-shaping.test.ts`
   (one window per pattern; independent buckets for ungrouped streams; repeated
   events to one stream are all delivered, in order).

5. **W4 hardening.**
   - DONE: the O(n)-per-enqueue backlog scan is now guarded by
     `eventQueue.length >= MAX_EVENT_BACKLOG_PER_STREAM` — the per-stream count
     can never reach the cap while the whole queue is below it, so ordinary
     enqueue stays O(1) and the scan runs only once a backlog has formed. This
     avoids a separate per-(stream, handler) index that would have to be kept in
     sync across the queue's mutation sites.
   - Optional: the same-origin collapse means the cap bounds the backlog at about
     256 + M rather than a hard 256, where M is the number of distinct pending
     origins fanning into one stream. That is still bounded (each origin is one
     rate-limited handler firing), so it is acceptable. If a hard
     per-(stream, handler) bound is wanted, the alternative is to re-key the
     surviving entry's `originTx` (and mint a fresh id) on collapse and release it
     from its old origin — more surface area in the speculation lineage, so it is
     not warranted yet.

6. **Plan C — fold the two shapers into one shaping choke point. DONE.** The
   event shaper and the cell-notification shaper were two instances of one
   idea — delay and thin the moment a pattern observes a change — kept separate
   only because the event-queue and reactive-notification wake paths are
   separate machinery. They are now one component:
   `scheduler/wake-shaping.ts` holds a single token-bucket engine
   (`WakeShaper`) plus a thin adapter per path (`holdShapedEvent`,
   `holdShapedCell`) that fixes the per-path semantics as `hold()` parameters —
   overflow policy (no item key ⇒ keep-all first-in-first-out for events; the
   cell identity as item key ⇒ last-wins coalescing per cell), leading-edge
   delivery (synchronous for events, whose deliver thunk only enqueues;
   deferred one macrotask for cells, whose thunk runs a reactive action), and
   charge sharing (a cell hold carries its source commit, so one gesture's
   reader fan-out rides one token). The scheduler owns ONE shaper instance:
   one quiescence drain, one dispose, one place the budgets live. Group keys
   are namespaced per path (`event:` / `cell:`), which keeps the budget split
   documented under the interactive/passive split above exactly as it was —
   merging budgets across paths is now a one-line policy choice rather than a
   refactor, deliberately not taken here. The deletion of the synchronous
   write-propagation channel in the scheduler-v2 refactor left one notification
   choke point, which is what made this fold small. Contract tests preserved
   verbatim in `runner/test/delivery-shaping.test.ts` (event path + unified
   engine) and `runner/test/cell-notification-shaping.test.ts` (cell path).

7. **Freeze the handler clock to the triggering event's time. DONE.** The
   handler clock now reads the event's frozen instant (`Frame.eventTime`),
   captured once at the event's causal origin and carried forward to emitted
   events, coarsened to one second at the read (`sandboxDateNow`), rather than
   the live wall clock. Time no longer advances during a handler's own work — a
   read before and after an `await` returns the same value — so a handler has no
   intra-run clock and no fine wall-clock edge to correlate a round trip against.
   See the W1 "handler clock is the event's time, frozen" bullet for the
   mechanism and the tests.

8. **Retire imperative handler `fetch()`. DONE.** A compartment endows no
   `fetch`, and the name is withheld from the authored surface, so the
   imperative surface no longer exists in any context — handler, lift, or
   pattern body alike. Reactive data goes through the fetch builtins, which are
   observed in reactive context where no clock exists, and whose requests the
   runtime records as CFC sink requests. The OAuth API clients that held the
   roughly two dozen imperative call sites — Google, Gmail, Google Docs, and
   Airtable — were removed along with the surface rather than rewritten. Their
   reads and fan-out would rewrite as node chains; their mutations and their
   cursor-following would not, for the reasons W2 gives, and rewriting several
   thousand lines of client and the forty patterns above it is its own piece of
   work. `docs/plans/handler-callable-egress.md` records the capability that
   would carry them, and what a design for it owes.

## Relationship to the CFC specification

Contextual Flow Control (CFC) is the information-flow-control model specified
in the `cfc/` directory of the `commonfabric/specs` repository (checked out
as a sibling of this repository, `specs/cfc`). Its threat model places this
work outside CFC's own scope: `09-threat-model.md` §9.3.2 lists cache timing
and other hardware/physical side channels as out of scope, and states that
denial of service (resource exhaustion) is handled by runtime limits, not
information-flow control; §9.6 states that a deployment claiming strong
confidentiality must add controls beyond label enforcement for operational
side channels such as timing and request patterns. This document is such an
added control: a runtime mitigation adjacent to CFC, not part of CFC label
enforcement.

Adjacent is not independent. The shapers sit on the same paths that carry
CFC's labels and integrity marks, so any future change to shaping must
preserve these invariants:

1. **No label staleness.** The shapers coalesce *wakes*, never values. A
   deferred reader runs later in a fresh transaction and re-reads the current
   committed state, with labels resolved at read time — exactly the model
   `08-09-runtime-label-propagation.md` requires: its trigger-read rule for
   dependency-scheduled reruns explicitly covers coalesced invalidations and
   requires the trigger set's labels to be resolved at their current values
   when the attempt runs (not at invalidation time), and §8.9.4 makes
   re-derivation refresh derived labels. The deferred wake also re-records its
   CFC trigger read when it releases (`scheduler/invalidation.ts`), so
   the "this change triggered me" flow label survives the deferral. Per-cell
   coalescing merges wakes for one cell and never merges values or labels
   across cells, so it preserves existence/shape confidentiality (safety
   invariant 14 in `10-safety-invariants.md`).
2. **Provenance-preserving strip.** The clock-field strip copies the event,
   and the copy keeps the renderer-trust provenance that authorizes
   UI-contract writes (`propagateRendererTrustedEvent` carries the mark to the
   stripped copy). The strip must also never touch the load-bearing top-level
   `timestamp` of a CFC trusted-event envelope (`06-events-and-intents.md`
   §6.2.1, where the event id is content-addressed over source, timestamp,
   nonce, and payload — removing that field would break the id derivation).
   Today's runner event is not that envelope shape, so the strip cannot hit
   one; the constraint is recorded here for the day the runner adopts that
   envelope.
3. **Trusted rendered text stays sound.** Safety invariant 13 (trusted
   rendered-text integrity, `10-safety-invariants.md`) binds trusted UI text
   to values with verified integrity. Shaping does not disturb it because only
   pattern-reader wakes are deferred: the `$value` write itself commits
   unshaped, and the renderer's snapshot binds committed values, so nothing a
   trusted boundary certifies is ever a held-back or un-committed value.

## What is a hard guarantee vs best-effort

- Hard: no fine clock or entropy in a lift (W1); lifts cannot emit events (W1);
  the structural barrier (W0). No clock field in any shaped (renderer-input)
  event delivered to a pattern (W3). The clock-field strip applies to the
  stream-event path only because it is the only path that carries an event
  payload; a bidirectional-binding `$value` write carries just the new cell
  value, and its delivery cadence is shaped by the cell-notification shaper.
- Best-effort tuning parameters: the coalescing window and the queue cap. These
  floor resolution to about one second as long as the hard
  guarantees hold.

## Lifts must be pure

The reactive graph quiescing is itself a defense: a quiescent graph cannot host
a free-running counter, so the cadence sources (large-language-model stream,
fetch completion) cannot be observed in a sustained loop. The two ways to break
quiescence are non-idempotent lifts and lift-triggered events. Therefore a lift
must be pure: no ambient clock, no entropy, and no event emission. W1 enforces
the clock/entropy/emit parts; the iteration cap is the liveness backstop for the
rest. A non-idempotent lift that reads a builtin progress cell is still re-woken
on each transition, but with no clock to stamp it and no event to signal out, the
re-runs are inert.
