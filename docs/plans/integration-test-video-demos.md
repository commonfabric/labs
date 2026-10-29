# Integration-Test Video Demos — Implementation Plan

Status: Core implementation complete and locally verified; optional CI adoption
and extended failure/visual-fixture hardening remain deferred.

This plan turns selected browser integration tests into deterministic video
demos without creating a second interaction API or weakening the tests'
correctness semantics. Normal integration runs remain fast and event-driven.
An explicit presentation mode records the same browser instances, slows the
existing typing and clicking paths, adds optional explanatory overlays, and
composes multi-user runs into one labeled video.

The first end-to-end acceptance target is
`patterns/integration/cfc-render-policy-demo.test.ts`. The first
multi-user acceptance target is
`patterns/integration/lunch-poll-vote.test.ts`.

## Status convention

- [ ] Not started
- [x] Complete and verified

Mark a parent checkbox complete only after all child checks and the completion
gate pass. Keep this plan current in the same commits as implementation. When
the final stage is complete, archive it under `docs/history/plans/` following
`docs/README.md`.

## Implementation result (2026-07-13)

The local, opt-in implementation is shipped in this changeset:

- `deno task demo` selects one or more pattern or shell integration-test files,
  preflights FFmpeg, reuses the existing integration runner, and writes named
  videos, machine-readable manifests, and a portable HTML gallery under
  `tmp/demos/`.
- Presentation mode modifies the existing Astral click/type paths and CFC input
  helper. It adds slow real typing, a visible cursor, click pulses, captions,
  participant badges, CDP screencast capture, and bounded asynchronous frame
  writes without adding a second demo interaction API.
- A process-wide presentation session shares one monotonic clock across all
  `ShellIntegration` instances, then creates deterministic one- through
  four-participant FFmpeg layouts. Counts above four are rejected explicitly.
- The CFC render-policy and two-user lunch-poll tests are the accepted reference
  demos. Both also pass through the normal integration command with presentation
  mode disabled.
- Focused unit tests cover configuration, frame timing, recorder acknowledgment,
  task selection, and one- through four-participant filter construction. Local
  live acceptance verified H.264 output at 1280x720 and 2560x720 respectively.

The first implementation renders participant badges and captions in the page
overlay so they are captured in each raw participant stream. That is simpler
and preserves useful labeled streams if composition fails; the manifest still
records the semantic steps. Optional title/end cards, synthetic compositor
acceptance fixtures, exhaustive resource-failure injection, and CI publication
remain follow-up hardening, not prerequisites for local use. Accordingly this
plan remains live rather than being archived.

## Goals

- [ ] Record a selected browser integration-test file through the existing
  Astral and `ShellIntegration` stack.
- [ ] Preserve the exact state setup, browser identities, UI events,
  assertions, and cleanup used by the test.
- [ ] Make existing input and click paths presentation-aware instead of adding
  parallel `demo.type()` and `demo.click()` APIs.
- [ ] Keep all presentation delays, cursor animation, overlays, recording, and
  encoding disabled during normal test runs.
- [ ] Produce deterministic single-user and multi-user videos with stable
  viewport sizes, participant labels, timing, and artifact names.
- [ ] Preserve simultaneous multi-user actions and live propagation as they
  occur in the test; do not replay a synthetic event log against mock UIs.
- [ ] Retain useful partial artifacts when a recorded test fails, while still
  returning the test's failing exit status.
- [ ] Provide a scriptable command that works without an agent or editor.

## Non-goals

- Building a general nonlinear video editor.
- Adding an agent skill.
- Replacing Astral, Deno's test runner, or the existing integration runner with
  Playwright.
- Recording every browser integration test in CI by default.
- Making fixed delays part of correctness synchronization.
- Generating narration automatically from source comments.
- Capturing microphone audio, text-to-speech, or background music in the first
  implementation.
- Supporting more than four simultaneously visible participant tiles in the
  first multi-user compositor.
- Making production shell code aware of demo recording.

## Current-system facts

The implementation must start from these shipped behaviors rather than create
parallel infrastructure:

- `runtime/integration/shell-utils.ts` owns the browser and page lifecycle for
  browser integration tests. One `ShellIntegration` currently launches one
  browser and one initial page; multi-user tests create multiple
  `ShellIntegration` instances.
- `runtime/integration/page.ts` wraps Astral's page, already provides
  screenshot capture, and already uses Astral's raw protocol bindings for
  event-driven condition notifications.
- `runtime/integration/astral-adapter.ts` defines the local screencast frame
  shape. Astral's raw protocol bindings expose `Page.startScreencast`,
  `Page.screencastFrame`, `Page.screencastFrameAck`, and
  `Page.stopScreencast`.
- Astral's keyboard supports a per-character delay. Its mouse can move in
  steps, but CDP-generated mouse movement is not rendered as a visible system
  cursor in page screenshots or screencasts.
- `patterns/integration/cfc-browser-helpers.ts` owns the preferred
  pattern-test input and click paths. `fillCfInput()` currently performs a
  bulk DOM input/change/commit/verify sequence, and `clickCfButton()` plus the
  trusted-action helpers resolve and click the actual target once.
- Some browser tests call Astral `ElementHandle.click()`,
  `ElementHandle.type()`, or `page.keyboard.type()` directly. They must be
  audited so demo candidates do not silently bypass presentation behavior.
- Correctness waits are deliberately event-driven. The rules in
  `docs/development/UI_TESTING.md` prohibit guessed sleeps in the interaction
  path.
- `tasks/integration.ts` already starts and stops local servers, selects a
  package and file filter, passes browser environment, and preserves the
  underlying test exit status.
- `StepTimer` already wraps labeled async steps in the lunch-poll and
  multi-browser group-chat tests. Its labels are useful presentation metadata,
  but its timing function is not yet a general demo timeline.

## Fixed design decisions

### One interaction vocabulary

- [ ] Do not add `demo.click()` or `demo.type()`.
- [ ] Keep the existing helper calls at test call sites. Presentation mode may
  change how those helpers perform the same user action, but not what control
  they target or what effect the test awaits.
- [ ] Normal mode must remain behaviorally equivalent to the current fast
  implementation.
- [ ] Presentation mode must still dispatch trusted browser input and must run
  the existing post-action commit and verification logic.
- [ ] Direct Astral interactions in selected demo tests must either become
  presentation-aware at the shared Astral hook or be migrated to an existing
  presentation-aware integration helper. Do not maintain a silent bypass list.

### Correctness time versus presentation time

- [ ] Correctness waits continue to resolve on runtime, DOM, or state events.
- [ ] Presentation holds occur only before a ready action, while visibly
  typing or moving a cursor, or after an asserted result has arrived.
- [ ] A presentation hold must be implemented by a dedicated presentation
  clock and must resolve immediately when presentation mode is off.
- [ ] Presentation delays do not consume or reduce the correctness timeout
  budget. Start correctness deadlines after any before-action hold, and stop
  them before any after-result hold.
- [ ] Concurrent actions inside `Promise.all()` remain concurrent. Each page
  may animate independently, but the presentation layer must not serialize
  them through a global lock.

### Real independent browsers for multi-user tests

- [ ] Keep every `ShellIntegration` and identity independent.
- [ ] Do not place participants into iframes or one shared browser profile for
  recording.
- [ ] Record each page's CDP stream independently against a shared recorder
  clock, then compose streams after the test.
- [ ] A participant's idle stream holds its last frame while another
  participant changes.
- [ ] Two participants default to a labeled side-by-side layout; three or four
  default to a 2-by-2 labeled grid.
- [ ] More than four participants requires an explicit layout selection or a
  clear unsupported-layout error in the first release.

### Recording and encoding

- [ ] Use Chrome's CDP screencast stream through Astral's raw protocol
  bindings.
  Do not add Playwright solely for video recording.
- [ ] Acknowledge every screencast frame promptly, independently of disk and
  encoder work, so capture backpressure cannot stall the browser.
- [ ] Preserve variable frame durations from the recorder clock. Do not feed
  change-driven frames to FFmpeg as if each had an equal duration.
- [ ] Hold the final frame through the requested end hold and ensure the
  encoded stream has an explicit final duration.
- [ ] Use an external `ffmpeg` executable for encoding and composition. Detect
  it before launching servers and fail with an actionable installation
  message when absent.
- [ ] Keep raw frames and manifests only when requested or when a run fails;
  otherwise remove intermediates after successful encoding.

### Overlays

- [ ] Render cursors and in-page callouts in an injected shadow-root overlay
  with `pointer-events: none` and a maximum z-index.
- [ ] Keep participant labels and whole-video captions in the compositor so
  they remain stable across navigation and can span multiple page tiles.
- [ ] Never infer viewer-facing captions from arbitrary source comments.
  Captions come from explicit step labels or explicit presentation metadata.
- [ ] Overlay installation must be idempotent after navigation and must not
  modify application layout, focus order, accessible names, or hit testing.

## User-facing command and artifacts

The intended command shape is:

```sh
deno task demo patterns cfc-render-policy-demo
deno task demo patterns cfc-render-policy-demo lunch-poll-vote
deno task demo patterns lunch-poll-vote --output=tmp/demos/lunch-poll.mp4
```

The command contract is:

- [ ] Require a browser-test package and one or more file-name filters.
- [ ] Resolve exactly one test file per filter. Fail on zero or multiple
  matches rather than recording an accidental suite.
- [ ] Initially run every `it` block in that file because some suites build a
  continuous scenario across tests. Add an optional Deno test-name filter only
  after defining how setup and cross-test state are preserved.
- [ ] Run headlessly by default with deterministic viewport and device scale.
- [ ] Reuse the integration runner's server ownership, port-offset, signal,
  and cleanup semantics.
- [ ] Return nonzero if setup, the test, recording finalization, or required
  encoding fails.
- [ ] Print the absolute final-video path and the retained diagnostic directory
  when applicable.

Default successful output:

```text
tmp/demos/<package>-<test-file>-<timestamp>/
  index.html
  <test-file>.mp4
  manifest.json
```

Multiple-file successful output:

```text
tmp/demos/<package>-gallery-<timestamp>/
  index.html
  <test-file-a>/
    <test-file-a>.mp4
    manifest.json
  <test-file-b>/
    <test-file-b>.mp4
    manifest.json
```

Retained failure/debug output:

```text
tmp/demos/<package>-<test-file>-<timestamp>/
  manifest.json
  participants/
    <participant-id>/
      frames/
      frames.ffconcat
      stream.mp4
  partial.mp4
  failure.txt
```

`manifest.json` is a versioned diagnostic and composition contract, not a
`FabricValue`. Version 1 must include:

- run id, package, test file, command, start/end monotonic offsets, and status;
- viewport, device scale, requested output format, and presentation profile;
- participant ids, display labels, colors, capture start/end offsets, and
  frame counts;
- each frame's sequence, source timestamp when available, recorder timestamp,
  path, width, height, and computed duration;
- step/caption intervals and their scope;
- encoder executable/version and the exact argument arrays used;
- failure stage and diagnostic text when incomplete.

Do not place identities, private keys, auth state, raw page HTML, or arbitrary
browser console contents in the manifest.

## Proposed component boundaries

### Integration package

Expected new or expanded files:

- `runtime/integration/presentation/config.ts` — environment/config parsing,
  defaults, validation, participant metadata, and disabled fast path.
- `runtime/integration/presentation/clock.ts` — injectable monotonic clock and
  recording-only holds.
- `runtime/integration/presentation/overlay.ts` — idempotent in-page cursor
  and callout overlay.
- `runtime/integration/presentation/interactions.ts` — before/after click and
  type hooks shared by helper and direct Astral interaction paths.
- `runtime/integration/presentation/recorder.ts` — per-page screencast state,
  frame acknowledgments, ordered writes, and manifest rows.
- `runtime/integration/presentation/session.ts` — run-level participant and
  step timeline; coordinates recorders without serializing their actions.
- `runtime/integration/presentation/encode.ts` — FFmpeg discovery, per-stream
  encoding, layout composition, cleanup, and injectable command runner.
- `runtime/integration/presentation/manifest.ts` — versioned manifest types
  and validation.
- `runtime/integration/page.ts` — narrow screencast and viewport operations,
  plus presentation hook installation; do not expose raw protocol bindings
  generally.
- `runtime/integration/shell-utils.ts` — participant registration and
  lifecycle start/finalize integration.
- `runtime/integration/env.ts` and `runtime/integration/index.ts` — public
  configuration/export surface.

If implementation tests are added under `runtime/integration/test/`, replace
the package's current stub `test` task with a real `deno test` task. Keep the
package's required workspace test entry.

### Astral integration seam

The preferred seam is a generic, optional interaction observer owned by an
Astral page:

- before/after click hooks receive the resolved element, click point, and
  operation outcome;
- before/after type hooks receive the focused element when known, text length,
  and operation outcome;
- the observer is unset by default and adds no delays or DOM changes;
- product-specific presentation behavior remains in
  `runtime/integration/presentation/`, not in the Astral package;
- `ElementHandle.click()` and `ElementHandle.type()` invoke the observer so
  direct element operations cannot bypass presentation mode;
- direct `page.keyboard.type()` receives the presentation default character
  delay through an optional keyboard default, but tests needing a cursor move
  to an input should prefer element-based typing.

Keep this behavior in the integration wrapper. The observer hook is small,
generic, and independently tested.

### Task runner

Expected files:

- `tasks/demo.ts` — argument parsing, FFmpeg preflight, exact test selection,
  output directory creation, presentation environment, server/test execution,
  and final status.
- `tasks/demo.test.ts` — argument, selection, environment, command, cleanup,
  and failure-artifact tests.
- `tasks/integration.ts` — extract/reuse server lifecycle and filtered-run
  helpers as needed; do not copy a second server manager.
- root `deno.jsonc` — add the `demo` task.

Tests that spawn child processes or temporary Deno configs must use isolated
temporary directories and must not update the repository lockfile or leave
build artifacts in the workspace.

## Presentation defaults

Version 1 should centralize conservative defaults rather than annotate every
action:

| Setting | Initial default | Purpose |
| --- | ---: | --- |
| viewport | 1280 by 720 | Stable single-user source frame |
| device scale | 1 | Reproducible pixel dimensions |
| typing delay | 55 ms per character | Readable but not theatrical typing |
| cursor travel | 350 ms | Make target changes legible |
| cursor settle before click | 150 ms | Let the eye reach the target |
| click pulse | 180 ms | Show which control was activated |
| post-result hold | 800 ms | Make asserted results readable |
| caption fade | 180 ms | Avoid abrupt overlays |
| JPEG quality | 85 | Balance capture size and UI text quality |

Defaults are presentation policy, not correctness constants. They may be
overridden at command or participant level, but normal test code should not
accumulate millisecond literals.

## Stage 0 — Prove capture fidelity and freeze the contract

### WP0.1 — Implement a focused CDP screencast spike

- [ ] Add a temporary or focused test-only recorder around one integration
  page using Astral's existing raw protocol bindings.
- [ ] Capture navigation, a stable initial state, one trusted click, its
  asserted result, and a final hold from the CFC render-policy demo.
- [ ] Verify frame events are acknowledged immediately and continue across UI
  activity.
- [ ] Measure whether Chrome's frame metadata timestamp is monotonic and usable
  on the supported Chrome version; otherwise use receipt time from one
  recorder-side monotonic clock.
- [ ] Verify the last visual state receives a nonzero duration.
- [ ] Encode the frames with FFmpeg and inspect text sharpness, transition
  timing, viewport size, and final duration.
- [ ] Record any CDP or FFmpeg deviations in this live plan before building the
  reusable abstraction.

### WP0.2 — Freeze manifest and failure semantics

- [ ] Define and unit-test the version-1 manifest schema.
- [ ] Decide the canonical timestamp origin and document conversions from CDP
  timestamps.
- [ ] Define behavior for zero frames, one frame, duplicate timestamps,
  out-of-order callbacks, navigation, hidden pages, and abrupt browser close.
- [ ] Define separate statuses for test failure, capture failure, encode
  failure, and cleanup warning.
- [ ] Ensure a test failure remains the primary outcome even when partial-video
  finalization also reports a secondary failure.

### Stage 0 completion gate

- [ ] One manually invoked CFC render-policy run produces a readable video.
- [ ] The test still fails when its assertion is deliberately broken.
- [ ] No fixed sleep was added to the normal correctness path.
- [ ] Manifest and failure behavior are explicit enough to test without a live
  browser.

## Stage 1 — Build the single-page recording core

### WP1.1 — Add narrow Page screencast primitives

- [ ] Add typed methods to start and stop screencast capture, subscribe and
  unsubscribe frame events, acknowledge frames, and set viewport size.
- [ ] Keep raw protocol bindings private to `Page` and
  `astral-adapter.ts`.
- [ ] Make start/stop idempotence and invalid lifecycle transitions explicit.
- [ ] Ensure listeners are removed on stop, failure, navigation teardown, and
  page close.
- [ ] Unit-test the wrapper with fake bindings, including acknowledgments
  after consumer failure.

### WP1.2 — Implement an ordered per-page recorder

- [ ] Copy frame payloads out of the event handler and acknowledge before any
  awaited filesystem operation.
- [ ] Use a bounded asynchronous write queue. Define whether a full queue
  drops frames with diagnostics or fails capture; never block acknowledgment.
- [ ] Generate stable, zero-padded frame names.
- [ ] Record receipt order and source timestamps, normalize durations, and
  enforce a minimum positive duration.
- [ ] On stop, drain accepted writes, append the requested final hold, and
  atomically finalize the participant manifest section.
- [ ] Reject a successful recording with no frames; allow a one-frame video by
  applying the final duration.
- [ ] Test out-of-order write completion, duplicate timestamps, stop during a
  pending write, frame decode errors, and disk-write errors.

### WP1.3 — Encode one variable-duration stream

- [ ] Generate an FFconcat input with explicit duration lines and a repeated
  final file entry.
- [ ] Invoke FFmpeg with arguments passed as an array, never through a shell.
- [ ] Produce broadly playable H.264 MP4 with `yuv420p` in version 1; keep the
  encoder abstraction open to WebM later.
- [ ] Normalize source dimensions before encoding and reject unexpected
  mid-stream size changes unless explicitly supported.
- [ ] Capture a bounded FFmpeg diagnostic tail on failure without leaking
  unrelated environment values.
- [ ] Unit-test command construction and manifest updates with an injected
  command runner; add a small FFmpeg acceptance test that skips with an
  explicit reason when FFmpeg is unavailable.

### Stage 1 completion gate

- [ ] Recorder and encoder unit tests pass in `runtime/integration`.
- [ ] A single-page synthetic frame fixture proves wall-clock-equivalent
  variable durations.
- [ ] The CFC render-policy test can be recorded through the reusable recorder.
- [ ] Normal integration runs do not create artifact directories or invoke
  FFmpeg.

## Stage 2 — Add the deterministic demo task and lifecycle

### WP2.1 — Extract reusable integration-runner lifecycle

- [ ] Refactor `tasks/integration.ts` only as needed to expose server start,
  stop, port selection, exact file selection, and child-test execution without
  duplicating them.
- [ ] Preserve current integration CLI behavior and tests byte-for-byte where
  practical.
- [ ] Add regression tests for generated and explicit port offsets, signal
  cleanup, child exit propagation, and exact file matching.

### WP2.2 — Implement `deno task demo`

- [ ] Add package/file parsing and the exact-one-file gate.
- [ ] Preflight FFmpeg and output-path writability before starting servers.
- [ ] Create a unique run directory under `tmp/demos/` unless `--output` is
  supplied.
- [ ] Set presentation mode, output directory, deterministic viewport, and
  headless defaults only for the child test process.
- [ ] Force the selected browser test file to run non-parallel.
- [ ] Preserve inherited API/frontend URLs and the integration runner's server
  ownership rules.
- [ ] Finalize capture and encoding before server cleanup, but make cleanup run
  even if finalization fails.
- [ ] Print a concise outcome containing test status, video path, duration,
  participant count, and retained intermediates.

### WP2.3 — Integrate Shell lifecycle

- [ ] Parse presentation configuration once per test process.
- [ ] Register each `ShellIntegration` with a run-level presentation session
  when presentation mode is enabled.
- [ ] Set viewport before first navigation.
- [ ] Start capture only after explicit recording start or the first settled
  demo navigation, so setup blank screens and login churn do not dominate the
  result.
- [ ] Define a reliable explicit start point for demo tests; normal tests must
  not need it.
- [ ] Stop capture before runtime/page/browser disposal while leaving enough
  time for the asserted final state.
- [ ] Finalize once after all registered shells close, regardless of hook
  registration order.

### Stage 2 completion gate

- [ ] The documented command records the CFC render-policy demo end to end.
- [ ] Zero and ambiguous file matches fail before launching servers.
- [ ] SIGINT, test failure, capture failure, and encoder failure all clean up
  owned servers and retain the documented diagnostics.
- [ ] `deno task integration patterns cfc-render-policy-demo` remains fast and
  produces no video artifacts.

## Stage 3 — Make existing interactions presentation-aware

### WP3.1 — Add a disabled-by-default interaction observer

- [ ] Define generic before/after click and type notifications with operation
  ids, page/participant ids, target geometry when available, and success/error
  outcomes.
- [ ] Install no observer in normal mode.
- [ ] Invoke the observer from `ElementHandle.click()` and
  `ElementHandle.type()` through the narrowest viable wrapper or vendored
  Astral seam.
- [ ] Ensure observer failure fails presentation capture with useful context
  rather than silently clicking an unintended control.
- [ ] Avoid retaining element handles after the operation completes.

### WP3.2 — Slow existing typing without changing its contract

- [ ] In presentation mode, have `fillCfInput()` resolve the same inner native
  input and use trusted keyboard typing with the configured delay.
- [ ] Clear or select existing content deterministically before typing a
  replacement value.
- [ ] Preserve the host's commit, update, and final value-verification steps
  after keyboard input.
- [ ] Preserve timeout diagnostics and the current bulk fill fast path in
  normal mode.
- [ ] Apply a default typing delay to direct `ElementHandle.type()` and focused
  `page.keyboard.type()` calls in presentation mode.
- [ ] Add cases for empty values, replacing existing values, punctuation,
  Unicode, readonly/disabled inputs, missing inner input, commit failure, and
  reactive rerender during typing.

### WP3.3 — Animate existing clicks

- [ ] Resolve and scroll the same target the helper already intends to click.
- [ ] Read its final bounding box after scrolling and view settlement.
- [ ] Animate a fake cursor from its previous per-page position to the target
  center while moving the CDP mouse along the same path when supported.
- [ ] Add a short target settle and click pulse, then execute the existing
  single trusted click.
- [ ] Keep marker cleanup and trusted-action provenance checks unchanged.
- [ ] Remove cursor state after navigation or page close and reinstall the
  overlay idempotently in the new document.
- [ ] Test offscreen controls, controls moved during scroll, disappeared
  targets, nested shadow roots, concurrent clicks on separate pages, and click
  failure.

### WP3.4 — Audit direct interaction bypasses

- [ ] Inventory direct `.click()`, `.type()`, and `page.keyboard.type()` calls
  in browser integration tests.
- [ ] Prove shared hooks cover each form used by selected demos.
- [ ] Migrate calls only where the shared hook cannot retain target context or
  correctness behavior; use existing integration helpers rather than adding a
  demo-only interaction API.
- [ ] Add a lint/check or focused test that prevents selected demo fixtures
  from adding an uncovered interaction form.

### Stage 3 completion gate

- [ ] The same CFC render-policy test source runs in fast normal mode and
  visibly presented recording mode.
- [ ] A focused input demo visibly types character by character and ends with
  the same committed value assertion.
- [ ] A focused click demo shows cursor travel and exactly one trusted click.
- [ ] Existing browser integration suites pass with presentation mode off.

## Stage 4 — Add explicit scenario timing and captions

### WP4.1 — Generalize labeled steps

- [ ] Extend `StepTimer` or replace it with a compatible scenario timeline that
  still records wall-clock timings for existing callers.
- [ ] Emit step start/end events only when a presentation session exists.
- [ ] Keep `run(label, fn)` semantics, including recording elapsed time when
  `fn` throws.
- [ ] Support an optional presentation label distinct from a diagnostic timing
  label when the latter is too technical for viewers.
- [ ] Support run-wide, participant-scoped, and silent steps without changing
  the wrapped test action.
- [ ] Keep before/after holds centralized and overridable without millisecond
  literals throughout tests.

### WP4.2 — Render captions and title/end cards

- [ ] Record caption intervals in the manifest rather than baking run-wide
  captions independently into each participant stream.
- [ ] Add compositor-rendered participant labels with deterministic colors and
  sufficient contrast.
- [ ] Add optional title and end cards driven by explicit configuration.
- [ ] Render step captions in a safe lower-third region, wrapping and truncating
  deterministically.
- [ ] Ensure captions do not cover participant labels or known shell controls
  in the reference layouts.
- [ ] Add visual fixtures for long labels, Unicode, overlapping steps,
  participant-scoped captions, and failed steps.

### WP4.3 — Annotate the single-user reference demo

- [ ] Give the CFC render-policy test a small number of viewer-facing steps:
  initial policy-hidden state, trusted reveal action, and final bounded result.
- [ ] Start recording after navigation/login/view settlement.
- [ ] End only after both the positive reveal and negative raw-surface
  assertions pass.
- [ ] Avoid captions that expose confidential test values before the trusted
  reveal is visible.

### Stage 4 completion gate

- [ ] Normal `StepTimer` consumers retain their existing timing output.
- [ ] The reference demo has readable pacing without correctness sleeps.
- [ ] Captions and participant labels are reproducible from the manifest.
- [ ] A failed scenario shows a bounded failure card or partial final state and
  retains the failing exit code.

## Stage 5 — Synchronize and compose multi-user recordings

### WP5.1 — Establish a shared multi-recorder timeline

- [ ] Allocate one presentation session and monotonic origin per test process.
- [ ] Give every registered shell a stable participant id independent of array
  order, plus an explicit display label and color when supplied.
- [ ] Record each participant's capture offsets relative to the shared origin.
- [ ] Normalize streams to a common start and end; synthesize a neutral tile
  before a participant's first frame and hold its last frame afterward.
- [ ] Preserve simultaneous operations as overlapping intervals.
- [ ] Handle a participant page navigating, closing early, or failing while
  other participants continue.

### WP5.2 — Implement deterministic layouts

- [ ] Define exact source viewport and output dimensions for one-, two-, three-,
  and four-participant layouts.
- [ ] Use aspect-preserving scale and pad; never silently crop controls.
- [ ] Place labels outside or over a reserved edge of each tile.
- [ ] Default two participants to side by side and three/four to a 2-by-2 grid.
- [ ] Allow a named layout override in the manifest/command configuration.
- [ ] Reject unsupported participant counts before encoding while retaining
  individual participant streams.
- [ ] Unit-test FFmpeg filter-graph construction independently of FFmpeg.

### WP5.3 — Annotate and record the lunch-poll demo

- [ ] Assign stable host and guest display labels and colors.
- [ ] Start both recorders only after both users are navigated, logged in, and
  ready.
- [ ] Use existing labeled steps, refined where necessary for viewer language,
  to show both users joining, an option propagating, both voting concurrently,
  and both views reaching the merged tally.
- [ ] Ensure both cursors remain independently visible and concurrent clicks
  are not serialized.
- [ ] Hold the final merged tally on both tiles.
- [ ] Verify participant-local drafts remain visually isolated before shared
  state propagates.

### WP5.4 — Cover dynamic participant counts

- [ ] Register generated group-chat shells with generated display labels.
- [ ] Verify two, three, and four streams align and compose.
- [ ] Define the version-1 behavior for `CFC_BROWSER_PROFILE_COUNT` greater than
  four: explicit rejection or explicitly selected participants.
- [ ] Preserve all raw participant streams even when a selected-participant
  composition omits some tiles.

### Stage 5 completion gate

- [ ] The lunch-poll test produces a readable, synchronized two-user video.
- [ ] The concurrent vote appears concurrent and the merged state is visible
  on both tiles.
- [ ] Two-, three-, and four-participant composition fixtures pass.
- [ ] Multi-user recording does not alter identities, storage isolation,
  runtime count, or propagation assertions.

## Stage 6 — Harden, document, and adopt

### WP6.1 — Failure and resource hardening

- [ ] Bound in-memory frame data and outstanding disk writes.
- [ ] Measure CPU, disk, and wall-clock overhead on the two reference demos.
- [ ] Ensure recording does not trigger the browser-test timeout solely because
  presentation delays were added; separate correctness timeouts from command
  watchdogs.
- [ ] Handle full disk, unwritable output, FFmpeg termination, browser crash,
  test timeout, and signal interruption.
- [ ] Prevent secrets and unrelated environment values from entering command
  logs or manifests.
- [ ] Delete successful intermediates by default and provide a documented
  `--keep-frames` diagnostic option.

### WP6.2 — Determinism and visual regression fixtures

- [ ] Make participant ordering, colors, frame names, layout, and filter graphs
  deterministic for identical configuration.
- [ ] Add golden manifests and FFmpeg argument arrays; avoid committing large
  generated videos.
- [ ] Use a tiny synthetic frame fixture for compositor acceptance tests.
- [ ] Verify output duration, dimensions, stream count, codec/pixel format, and
  final-frame presence with `ffprobe` when available.
- [ ] Run each reference demo repeatedly and record acceptable duration and
  frame-count variation bounds.

### WP6.3 — Developer documentation

- [ ] Update `docs/development/UI_TESTING.md` with presentation-mode semantics,
  the ban on correctness sleeps, supported interaction paths, and how to mark
  a test as a demo.
- [ ] Update `docs/development/TESTING.md` with the `deno task demo` command,
  prerequisites, outputs, failure behavior, and multi-user layouts.
- [ ] Document FFmpeg installation expectations without making normal test
  execution depend on FFmpeg.
- [ ] Document how to choose viewer-facing step labels and participant labels.
- [ ] Document the direct-interaction audit requirement for new demo tests.
- [ ] Add the final reference commands and expected artifact locations.

### WP6.4 — Optional CI artifact path

- [ ] Keep demo recording opt-in until local reliability and cost are measured.
- [ ] If CI recording is desired, add a manually triggered or explicitly
  labeled job before any per-PR default.
- [ ] Pin/verify the FFmpeg environment and upload only final videos plus
  manifests on success.
- [ ] Upload retained intermediates only on failure and set an explicit
  retention period.
- [ ] Do not make demo rendering a required merge gate without a separate
  performance and maintenance decision.

### Final completion gate

- [ ] `deno task demo patterns cfc-render-policy-demo` produces the accepted
  single-user video.
- [ ] `deno task demo patterns lunch-poll-vote` produces the accepted
  synchronized two-user video.
- [ ] Both underlying tests still pass normally without recording artifacts or
  presentation delay.
- [ ] Integration-package, task-runner, manifest, interaction, and compositor
  tests pass.
- [ ] The full affected package test tasks and documentation checks pass.
- [ ] No correctness synchronization uses presentation sleeps.
- [ ] No demo-only click/type API exists.
- [ ] Live testing documentation describes the shipped command and extension
  points.
- [ ] This completed plan is archived under `docs/history/plans/`.

## Cross-stage validation matrix

Run focused tests during red/green development, then the complete affected
package tasks at each stage gate.

| Concern | Required validation |
| --- | --- |
| CDP lifecycle | Fake-binding unit tests plus one live Chrome acceptance |
| Frame timing | Synthetic variable-duration fixture and output duration probe |
| FFmpeg invocation | Pure argument tests plus a small local encode acceptance |
| Normal-mode neutrality | Existing pattern and shell browser integrations |
| Input semantics | DOM value, input/change events, host commit, final assertion |
| Click semantics | One trusted click, marker cleanup, asserted effect |
| Overlay isolation | Focus, hit testing, accessibility, navigation reinstall |
| Runner behavior | Task parser, exact file match, port ownership, signals |
| Multi-user timing | Shared-origin fixtures and lunch-poll live acceptance |
| Composition | One/two/three/four layouts, dimensions, labels, final frame |
| Failure behavior | Test, capture, encode, disk, browser, signal failures |
| Documentation | `deno task check-docs` and link validation |

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| CDP emits frames only on visual change | Preserve variable durations and explicitly hold/repeat the final frame. |
| Frame acknowledgment blocks on I/O | Copy payload, acknowledge immediately, and use a bounded write queue. |
| Presentation delays create test flakes | Keep event-driven correctness waits unchanged and outside presentation timing. |
| Bulk fill and slow typing commit differently | Reuse the same host commit and verification tail and test both modes against the same assertions. |
| Synthetic cursor disagrees with the real click | Derive both from the same final bounding box and animate the CDP mouse along the same route. |
| Direct element calls bypass presentation | Add a generic Astral observer seam and audit selected demo tests. |
| Multi-user recording changes runtime behavior | Preserve separate browser instances and compose only after execution. |
| Small tiles make UI unreadable | Fix source/output dimensions, scale without cropping, and inspect reference layouts before accepting them. |
| FFmpeg is absent or varies by machine | Preflight/version-record it, use conservative codecs, and fail before server startup. |
| Video artifacts bloat the repository | Write under ignored `tmp/`, commit only small fixtures/manifests, and clean successful intermediates. |
| A failed test loses its evidence | Best-effort finalize partial streams and retain frames/manifests while preserving the test failure. |
| Captions leak sensitive values | Require explicit viewer-facing labels and keep confidential-value reveals aligned with asserted trusted UI state. |

## Deferred extensions

These are intentionally outside the completion gate:

- active-speaker or picture-in-picture layouts for more than four users;
- per-step camera crops or zooms;
- external subtitle files;
- voice-over manifests or text-to-speech;
- audio mixing;
- automatic cursor-path smoothing based on semantic control groups;
- automatic demo selection or an agent skill;
- hosted video galleries or publishing workflows;
- browser-native WebM recording as an alternative capture backend.
