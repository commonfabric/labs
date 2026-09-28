<!-- @reviewed 2025-12-10 docs-rationalization -->

# Testing Shadow DOM Components

## The Problem

When testing web components that use Shadow DOM, traditional selectors can't
reach into shadow roots. This is especially challenging when components are
nested multiple levels deep, each with their own shadow DOM.

## Preferred Solution: Accessibility Locators

Prefer semantic locators against the browser's flattened accessibility tree.
Where a `cf-*` component exposes those semantics depends on its interaction
shape:

| Component shape | Semantic anchor | Benefit | Trade-off |
| --- | --- | --- | --- |
| One logical control, such as `cf-button` or `cf-input` | Custom-element host | Visible even to shadow-blind DOM readers; one role and one set of bounds | Requires forwarding keyboard, focus, state, and accessible-name behavior that a native control would otherwise provide |
| Multiple independent actions, such as an interactive removable `cf-chip`, `cf-tags`, or a clickable `cf-tile` with nested details | Native controls inside the shadow root | Correct native keyboard and focus behavior; each action has its own role and name | Simple DOM walkers that do not consume the flattened tree cannot see the inner actions |
| Informational collections, such as message-history beads | Native structural roles with no artificial tab stops | Preserves reading structure without claiming that information-only items are buttons | Readable in the accessibility tree and may appear in filtered snapshots, but intentionally remain outside the keyboard tab order |

Use host-anchored semantics for a single logical control. Use named native
shadow controls when the component is composite and needs more than one action.
Use structural semantics for non-interactive information. Do not add a button
role or tab stop solely to make an item appear in an interactive snapshot.

Our supported automation surfaces, including agent-browser and Playwright role
locators, consume the flattened accessibility tree and can find named shadow
controls. A shadow-blind DOM walker is not a complete representation of a
composite web component; use a flattened-tree tool or the pierce fallback below.

### The Pattern

1. **Give controls stable accessible names**

   Use visible text for buttons, or use `aria-label`, an associated label, or a
   placeholder for inputs. This applies whether the semantic control is the
   custom-element host or a native element in its shadow root.

   ```typescript
   // Shown as JSX element children.
   <cf-button>Submit</cf-button>
   <cf-input aria-label="Email" type="email" />
   ```

2. **Find controls by role and accessible name**

   ```bash
   # agent-browser
   agent-browser find role button click --name "Submit"
   agent-browser snapshot -i          # → textbox "Email" [ref=e3]
   agent-browser type @e3 "user@example.com"
   ```

   ```typescript
   // Shown inside a pattern body.
   // Browser test APIs with ARIA support should use the same role/name shape.
   const submit = page.getByRole("button", { name: "Submit" });
   const email = page.getByRole("textbox", { name: "Email" });
   ```

3. **Use ShellIntegration for setup**
   ```typescript
   // Shown inside a pattern body.
   const shell = new ShellIntegration();
   shell.bindLifecycle(); // Sets up beforeAll/afterAll hooks

   // shell.goto() handles navigation, applyConsoleFormatter, and login
   await shell.goto({
     frontendUrl: FRONTEND_URL,
     view: { spaceName: SPACE_NAME, pieceId },
     identity,
   });

   // Wait for state event-drivenly — never sleep, never poll. waitForCondition
   // installs a waiter inside the page that resolves the instant the DOM
   // reflects the condition, instead of re-checking from the test process on a
   // fixed interval.
   await waitForCondition(page, (probe: ProbeApi) =>
     probe.collect("cf-input[role='textbox']").length > 0);
   ```

   Every navigation a `ShellIntegration` page performs — `shell.goto()`, and a
   bare `page.goto()` or `page.reload()` on the page it hands out — returns
   only once the shell behind it can be driven. The shell publishes
   `globalThis.app`, the handle a driver reaches it through, as the last step
   of a bootstrap module whose body runs on past the document's `load` event,
   so a navigation that settled on `load` would otherwise hand back a page
   whose shell is still booting.

   Every such page is also opened at a fixed viewport, `SHELL_VIEWPORT` in
   `packages/integration/shell-utils.ts`, wide enough for the shell's desktop
   header layout. The header switches layouts on the viewport width, and a
   browser left to its own default picks a width that varies by platform, so
   without the pin which layout a suite drives would be a property of the
   machine running it. A test that means to drive the narrow layout sets a
   viewport of its own with `page.setViewportSize()`.

   Pinning the width settles which layout is rendered; it does not settle
   whether a control in it is there to be clicked. A wait that asks only whether
   an element exists is satisfied by one laid out at no size, and the failure
   then surfaces one step later as a click that cannot land. Ask
   `probe.isRendered` in the wait, as
   [`waiting-in-tests.md`](waiting-in-tests.md) requires of a wait that
   precedes a click.

## Why This Works

- **Host roles** give single-control `cf-*` components one stable semantic
  anchor
- **Native shadow controls** preserve distinct actions in composite components
  and appear in the flattened accessibility tree
- **Structural roles** expose information without creating false actions or
  excessive tab stops
- **Accessible names** let agents find the intended control by user-facing text
- **Shadow DOM remains intact** for style isolation in either interaction shape

## Fallback: Data Attributes + Pierce Strategy

For older components without semantics, or tools that cannot consume the
flattened accessibility tree, use unique data attributes on the actual HTML
elements combined with Astral's pierce strategy.

```typescript
// Shown inside a pattern body.
const input = await page.$("[data-cf-input]", {
  strategy: "pierce",
});

const button = await page.$("[data-cf-button]", {
  strategy: "pierce",
});
```

## `fill()` Does Not Work on cf-\* Hosts

Playwright's `fill()` requires a native `<input>` or `<textarea>`. Since
`cf-input` and `cf-textarea` are custom elements, use
`pressSequentially()` on the locator instead. The custom element host is the
semantic tab stop and forwards focus to the inner native input automatically:

```typescript
// Shown inside a pattern body.
const input = page.getByRole("textbox", { name: "Email" });
await input.pressSequentially("user@example.com");
```

For `agent-browser`, use `type @ref` (not bare `type` after `click`):

```bash
agent-browser snapshot -i            # → textbox "Email" [ref=e3]
agent-browser type @e3 "user@example.com"
```

## What Doesn't Work

❌ **Don't** rely on unlabeled controls:

```html
<cf-input></cf-input>
```

❌ **Don't** try to navigate shadow paths manually:

```typescript
// This is fragile and breaks easily
const path = ["x-root", "#shadow-root", "cf-input", "#shadow-root", "input"];
```

## Example Test

```typescript
// Shown at module scope.
import {
  env,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  clickCfButton,
  fillCfInput,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("shadow DOM component test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let pieceId: string;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await PiecesController.initialize({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    const piece = await cc.create(yourPatternCode, { start: true });
    pieceId = piece.id;
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should interact with shadow DOM components", async () => {
    const page = shell.page();

    // Setup: shell.goto() handles navigation, applyConsoleFormatter, and login
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE_NAME, pieceId },
      identity,
    });

    await fillCfInput(page, "cf-input[role='textbox']", "Hello World");
    await clickCfButton(page, "cf-button[role='button']");

    // Verify the effect event-drivenly: waitForCondition resolves the instant
    // the result text appears, with no test-side poll.
    await waitForCondition(page, (probe) =>
      probe.collect("#result").some((el) =>
        probe.deepText(el).includes("Hello World")
      ));
  });
});
```

## Waiting Until the UI Is Interactive

Finding an element is one problem; knowing *when* it is ready to be clicked or
typed into is a separate one. The reactive scheduler runs in a worker while the
DOM lives on the main thread, so after a state change there are three stages
before a control is interactive:

1. the worker settles reactively — `rt.idle()` covers this;
2. the resulting vdom batch crosses to the main thread and is applied — this is
   where the click listener is attached;
3. the Lit elements finish their update cycle — `cf-modal`, for example, only
   binds handlers and removes `pointer-events: none` in its `updated()`
   callback, one cycle after its `open` property is set.

Only stage 1 is visible through the runtime idle signal, so an element can exist
in the DOM, be found by a selector, and still drop a click because its handler
is not bound yet.

Settling first also keeps a trusted click from missing its target. A trusted
click resolves the element's layout box and then dispatches the mouse events at
that point. On a cold load the page keeps reflowing for a few frames as content
above the control fills in. A topic's markdown body may render, or a form or
card below it may appear. A control that has just become rendered can therefore
still be moving. If the box moves between measurement and dispatch, the click
lands on whatever shifted into the old spot instead of the control. Nothing
happens.

`clickCfButton` waits for the marked control's box to remain unchanged across
two consecutive rendering frames. It measures the marked control again just
before dispatch. If that final measurement finds that the control moved or was
replaced, the helper settles and marks the current control before dispatching
one trusted click. It aims at the middle of the part of the control's box that
lies inside the page, so a control the edge of the page cuts off is clicked
inside the page rather than at a point past the edge, and a control with no part
of it inside the page is reported rather than clicked. A page that moves the
control after even that last measurement is caught as well: the helper stops an
interaction that misses before the page sees it, and aims again.
`docs/development/waiting-in-tests.md` describes how.

It also holds until the control is enabled. A disabled control has a layout box
and passes every rendered-ness check, and it still takes no click: the browser
raises none on it, and a `cf-button` additionally gives it
`pointer-events: none`, which sends the press to the host that wraps it.
Where the state that enables a control is also the state that drops a surface
above it, waiting covers the move as well as the enable, because the aim is
taken once the page has settled into the layout it keeps.

**Use `awaitViewSettled(page)`** from `@commonfabric/integration` as the
lower-level wait after navigation or a state change. When the next step
clicks a control, use `clickCfButton` instead. It resolves, settles, and marks
the exact click target in one page-side predicate:

```typescript
// Shown at module scope.
import { waitForCondition } from "@commonfabric/integration";
import { clickCfButton } from "./cfc-browser-helpers.ts";

await clickCfButton(page, "cf-button[role='button']");

// Wait for the click's specific effect. The modal opening is a DOM mutation, so
// the in-page waiter resolves when it appears.
await waitForCondition(page, (probe) =>
  probe.collect("cf-modal[open]").length > 0);
```

Pattern integration tests can use the higher-level wrappers in
`packages/patterns/integration/cfc-browser-helpers.ts` — `waitForText`,
`fillCfInput`, `clickCfButton`, `clickCfButtonAndWaitForText` — which bundle
the common waiting and interaction sequences. Every one of them that clicks
proceeds only when the same target remains rendered before and after a settle,
and marks that target inside the successful predicate — the helpers that reach a
control by index, by `data-ui-action`, or by its button text included. See
`docs/development/waiting-in-tests.md` for why that ordering is the load-bearing
part.

### Do not reach for these instead

Each of the following is what `awaitViewSettled` replaces. They are either racy
(they do not cover all three stages) or wasteful (a CDP round trip every poll):

- **`await sleep(ms)`, `page.waitForTimeout(ms)`, or any fixed delay** — guesses
  at timing; too short flakes, too long wastes wall-clock.
- **`await rt.idle()` or `waitForRuntimeIdle(page)` alone, then interact** —
  covers stage 1 only. The element may be in the DOM with no handler bound, or
  be a `cf-modal` whose `pointer-events` are still off.
- **`await waitFor(() => findButtonWithText(page, "X"))` then click** — presence
  is not interactivity, and every poll is a CDP `evaluate` round trip. The
  `waitFor` helper re-runs its predicate from the test process on a fixed
  interval; prefer `waitForCondition`, whose in-page waiter resolves on the DOM
  mutation itself (see `packages/integration/utils.ts`).
- **`await waitFor(() => clickButtonWithText(page, "X"))`, re-clicking until it
  "takes"** — fires the stimulus speculatively. It can double-fire (creating
  duplicate state) and, against a `dismissable` overlay such as `cf-modal`,
  repeated clicks behind the open modal dismiss it and leave the test stuck.
- **`page.waitForSelector(...)` in a retry loop to "wait it out"** — Astral's
  `waitForSelector` is itself a tight CDP poll, and a present element is not a
  ready one.

The shape is always: resolve the target, prove that exact rendered element
survives a settle, and mark it. Then click once and wait for the effect.

A CI check enforces this for the polling `waitFor`: `deno task check-no-waitfor`
fails when an integration test imports `waitFor` as a value from
`@commonfabric/integration`, whether through the bare specifier or a relative
path to the package. See [`waiting-in-tests.md`](./waiting-in-tests.md) for the
rationale, the full event-driven toolkit, and the allowlist of intentional
exceptions.

## Best Practices

1. **Use roles first**: `button`, `textbox`, `checkbox`, etc.
2. **Give controls accessible names**: visible text, labels, `aria-label`, or
   placeholders
3. **Always wait for components to load**: Shadow DOM components may render
   asynchronously
4. **Use pierce strategy as fallback**: It remains useful for components that
   have not been updated with host semantics

## Running the Tests Locally

`deno task integration` starts the servers for you. These are browser tests, so
the toolshed must serve the shell frontend, not just the API: a bare `deno task
dev` toolshed returns `404` for the UI and the test times out. To run a single
file by hand, point it at the compiled binary (`deno task build-binaries`, then
`./dist/toolshed`) or a source toolshed with `SHELL_URL` set.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `HEADLESS` | Set to `true` or `1` to run browser headlessly (default: visible) |
| `PIPE_CONSOLE` | Set to `true` or `1` to forward browser console output to the test runner |
| `API_URL` | Server URL (default: `http://localhost:8000`) |
| `FRONTEND_URL` | Frontend URL (default: `API_URL`) |
| `SPACE_NAME` | Target a specific space (default: random UUID) |

Example: `PIPE_CONSOLE=1 deno task integration`

## Presentation mode and video demos

`deno task demo` enables an opt-in presentation layer around the existing
browser integration stack. It does not define `demo.click()` or `demo.type()`:
the same `fillCfInput`, `clickCfButton`, trusted-action, and Astral element
operations used by the test remain responsible for the interaction.

The command accepts one or more test-file filters. Multiple files are recorded
sequentially into isolated artifact subdirectories, with a top-level
`index.html` gallery linking every completed, test-named MP4.

In presentation mode, those paths may add human-readable typing delay, cursor
travel, a click pulse, participant labels, and captions. With presentation mode
off they retain their normal fast behavior. Direct interaction forms used by a
new demo should be checked against the shared presentation hooks; prefer the
existing higher-level helpers where they already encode the correct settle,
single-action, commit, and effect-wait behavior.

Presentation timing is not correctness timing. Continue to settle the view and
wait for the specific state or DOM effect event-drivenly. A caption hold may
begin only after that effect has arrived, and it resolves immediately outside
presentation mode. Never add `sleep`, `waitForTimeout`, or a longer correctness
timeout merely to pace a video.

Use `StepTimer.run(label, action)` for a viewer-readable scenario boundary when
the test already benefits from step timing. During a demo it records the step
on the shared timeline and shows the label on every active participant; during
a normal test it only records the existing timing row. Labels should tell the
viewer what changed, not expose implementation diagnostics or protected values
before the UI legitimately reveals them.

For multi-user demos, attach stable participant metadata without changing the
identity or browser topology:

```text
const alice = new ShellIntegration({
  presentation: { id: "alice", label: "Alice", color: "#7c3aed" },
});
const bob = new ShellIntegration({
  presentation: { id: "bob", label: "Bob", color: "#0891b2" },
});
```

Each shell still launches its own browser. Recording and composition happen
around the test; participants are never collapsed into iframes or a shared
browser profile.

## Debugging Tips

If semantic locators are not finding your element:

1. **Check the host role**: `cf-button` should have `role="button"`;
   `cf-input` should have `role="textbox"`
2. **Check the accessible name**: ensure visible text, `aria-label`, a label, or
   placeholder matches the locator
3. **Ensure components are loaded**: wait for the host element before querying
4. **Fallback to pierce selectors**: use `[data-cf-input]` or
   `[data-cf-button]` with `strategy: "pierce"` for older components

## Related documentation

- [TESTING.md](TESTING.md) — running the suites and the general unit and
  integration test structure.
- [COVERAGE.md](COVERAGE.md) — how CI measures coverage. A member's measured set
  counts the V8 coverage of the member's Deno-only half, its `deno-test` task,
  so its browser tests never feed it. The authored-pattern coverage the browser
  worker collects feeds the repository-wide trend, not a measured set.
