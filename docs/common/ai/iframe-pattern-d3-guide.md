# D3 iframe-first pattern guide

Use this guide to build a Common Fabric pattern whose primary interface is a
D3 visualization inside one sandboxed `cf-iframe`. The generated wrapper is
mechanical: it exposes named Cell and SQLite resources, bundles the guest and
D3 into one HTML string, and returns durable state and output through the
normal pattern result.

This guide is self-contained. Do not also load the plain-DOM or React iframe
guide unless the request explicitly combines D3 with an existing guest in one
of those styles.

## Source layout

Keep the authored contract and guest beside the generated wrapper:

```text
packages/patterns/d3-shared-bars/
├── contract.ts  # input, durable state, output, scopes, optional databases
├── guest.ts     # D3 application and Fabric bridge client
├── guest.html   # optional document shell
└── main.tsx     # generated wrapper; do not hand-edit
```

The generated `main.tsx` contains D3, the guest bridge, and the application. It
does not fetch JavaScript at runtime. Keep `contract.ts` and `guest.ts` so an
agent can regenerate the wrapper.

## Describe input, state, and output

Create `contract.ts` as a side-effect-free declarative module. Every array
member that can move carries a stable application ID:

```typescript
export interface BarDatum {
  id: string;
  label: string;
  value: number;
}

export interface IframeInputData {
  heading: string;
}

export interface IframeStateData {
  points: BarDatum[];
}

export interface IframeOutputData {
  selectedId: string | null;
}

export const DEFAULT_INPUT: IframeInputData = { heading: "Shared bars" };
export const DEFAULT_STATE: IframeStateData = {
  points: [
    { id: "alpha", label: "Alpha", value: 3 },
    { id: "beta", label: "Beta", value: 5 },
  ],
};
export const DEFAULT_OUTPUT: IframeOutputData = { selectedId: null };

export const IFRAME_PATTERN = {
  name: "D3SharedBars",
  displayName: "D3 shared bars",
  stateScope: "space",
  outputScope: "session",
  frameHeight: "100vh",
  databases: {},
} as const;
```

The wrapper exposes three resources:

- `input` is read-only caller data.
- `state` is durable data the visualization may change.
- `output` is the public selection or result the wrapper returns.

Choose each writable resource's scope independently:

| Scope | Meaning |
| --- | --- |
| `space` | Shared by every user and browser session in the piece |
| `user` | Separate for each user and shared by that user's sessions |
| `session` | Separate for each browser session |

Keep hover coordinates, drag previews, zoom transforms, animation progress,
and temporary tooltips in guest memory. Persist only state that must survive a
reload or be observed elsewhere.

## Connect the bridge and pass one readiness barrier

Pin D3 in `guest.ts`, connect once, and keep resource handles at module scope:

```typescript
// Shown at module scope.
import {
  max,
  scaleBand,
  scaleLinear,
  select,
} from "npm:d3@7.9.0";
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import {
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeInputData,
  type IframeOutputData,
  type IframeStateData,
} from "./contract.ts";

const fabric = connectFabric();
const input = fabric.cell<IframeInputData | undefined>("input");
const state = fabric.cell<IframeStateData | undefined>("state");
const output = fabric.cell<IframeOutputData | undefined>("output");
const stateWrite = fabric.cell<IframeStateData>("state");
const outputWrite = fabric.cell<IframeOutputData>("output");
const svg = select<SVGSVGElement, unknown>("#chart");
type Point = { id: string; label: string; value: number };

let hydrated = false;
let inputValue = DEFAULT_INPUT;
let stateValue = DEFAULT_STATE;
let outputValue = DEFAULT_OUTPUT;

function render(): void {
  if (!hydrated) return;
  const width = 640;
  const height = 360;
  const x = scaleBand<string>()
    .domain(stateValue.points.map((point: Point) => point.id))
    .range([0, width])
    .padding(0.15);
  const y = scaleLinear()
    .domain([0, max(stateValue.points, (point: Point) => point.value) ?? 1])
    .nice()
    .range([height, 0]);

  svg.attr("viewBox", `0 0 ${width} ${height}`)
    .selectAll<SVGRectElement, Point>("rect")
    .data(stateValue.points, (point: Point) => point.id)
    .join("rect")
    .attr("x", (point: Point) => x(point.id) ?? 0)
    .attr("y", (point: Point) => y(point.value))
    .attr("width", x.bandwidth())
    .attr("height", (point: Point) => height - y(point.value))
    .attr("aria-label", (point: Point) => `${point.label}: ${point.value}`)
    .attr(
      "data-selected",
      (point: Point) => point.id === outputValue.selectedId,
    )
    .on("click", (_event: PointerEvent, point: Point) => {
      void outputWrite.set({ selectedId: point.id }).catch(showError);
    });

  document.querySelector("h1")!.textContent = inputValue.heading;
}

function showError(cause: unknown): void {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  document.querySelector<HTMLElement>("[role=alert]")!.textContent =
    error.message;
}

async function addPoint(): Promise<void> {
  await stateWrite.key("points").push({
    id: crypto.randomUUID(),
    label: "New",
    value: 1,
  });
}

const addButton = document.querySelector<HTMLButtonElement>("#add")!;
addButton.addEventListener("click", () => {
  void addPoint().catch(showError);
});

const cancelInput = input.sink((value) => {
  inputValue = value ?? DEFAULT_INPUT;
  render();
});
const cancelState = state.sink((value) => {
  stateValue = value ?? DEFAULT_STATE;
  render();
});
const cancelOutput = output.sink((value) => {
  outputValue = value ?? DEFAULT_OUTPUT;
  render();
});

let disposed = false;
function dispose(): void {
  if (disposed) return;
  disposed = true;
  cancelInput();
  cancelState();
  cancelOutput();
  fabric.disconnect();
}
globalThis.addEventListener("pagehide", dispose, { once: true });

try {
  await Promise.all([
    input.pull(),
    state.pull(),
    output.pull(),
  ]);
  await stateWrite.initialize(DEFAULT_STATE);
  await outputWrite.initialize(DEFAULT_OUTPUT);
  inputValue = input.get() ?? DEFAULT_INPUT;
  stateValue = state.get() ?? DEFAULT_STATE;
  outputValue = output.get() ?? DEFAULT_OUTPUT;
  hydrated = true;
  addButton.disabled = false;
  render();
} catch (cause) {
  showError(cause);
  dispose();
}
```

`sink()` calls its listener synchronously with the guest's current sample, then
again after host updates. That first call does not prove the host has supplied
the latest value. Keep all actions disabled until one joint `Promise.all` of
`pull()` calls resolves for every resource the action reads.

Use the pulls only as a joint readiness barrier. Read values with `get()` after
every pull and initialization has settled, so a newer sink event that arrives
during the barrier cannot be replaced by an older individual pull result.
Install idempotent teardown before starting the barrier, and catch bootstrap
failures so they remain visible while subscriptions are released.

`initialize()` atomically supplies a default only while the Cell has no backing
value. Call it even when `get()` exposes a compiled schema fallback: the
idempotent operation materializes that fallback before a path write. Never
issue a whole-state `set()` merely to ensure a value exists.

## Render D3 from authoritative state

Use one render function and keyed joins. The D3 key must be the durable member
ID, never the array index. An index follows a position; it does not identify the
same member after sorting or concurrent inserts.

Keep rendering one-way:

1. A Cell sink replaces the guest's authoritative snapshot.
2. `render()` derives scales, axes, marks, and accessible text from that
   snapshot.
3. A user event performs one narrow Cell operation.
4. The resulting sink update renders the confirmed shared state.

Do not write from `render()` or from a sink callback. That forms a feedback
loop. D3 transitions may interpolate the DOM, but they do not become durable
state.

## Prefer mergeable and path-scoped writes

Append new members with `push()` as the complete guest above does, so
concurrent additions compose.

When an interaction starts from an array position, resolve that position to a
stable Cell before subscribing or writing. The returned handle remains attached
to the same item even when it moves:

```typescript
// Shown at module scope.
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
const fabric = connectFabric();
const stateWrite = fabric.cell<{
  points: Array<{ id: string; label: string; value: number }>;
}>("state");
async function incrementPoint(index: number): Promise<void> {
  const point = await stateWrite.key("points").key(index).resolve();
  const current = await point.pull();
  if (current === undefined) return;
  await point.key("value").set(current.value + 1);
}
```

Resolve before a drag or edit begins. Do not remember an index and resolve it
later. Redundant writes are deduplicated by the underlying Cell machinery, so a
simple authoritative set is preferable to a guest-side equality protocol.

Serialize multi-step actions in the guest, expose a pending state, and show
rejections in an element with `role="alert"`. A sequence of writes is ordered,
not atomic; choose one Cell as the canonical source when multiple views must
agree.

## Document shell and CSP

The default generated shell supplies `<div id="root"></div>`. A D3 chart
normally benefits from explicit accessible HTML:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Shared bars</title>
  </head>
  <body>
    <main>
      <h1>Loading</h1>
      <button id="add" type="button" disabled>Add point</button>
      <p role="alert"></p>
      <svg id="chart" role="img" aria-label="Shared bar chart"></svg>
    </main>
    <!-- PATTERN_IFRAME_SCRIPT -->
  </body>
</html>
```

The sandbox does not grant arbitrary network access. Bundle modules, generate
small assets locally, or pass data through `input`; do not depend on a CDN,
`fetch()`, or remote fonts. A custom shell must contain
`<!-- PATTERN_IFRAME_SCRIPT -->` exactly once. Buttons must use `type="button"`
so an accidental form ancestor cannot trigger navigation.

## Generate and validate

Generate the wrapper without the React flag:

```bash
deno run -A tools/write-iframe-wrapper.ts \
  --contract packages/patterns/d3-shared-bars/contract.ts \
  --guest packages/patterns/d3-shared-bars/guest.ts \
  --html packages/patterns/d3-shared-bars/guest.html \
  --out packages/patterns/d3-shared-bars/main.tsx
```

Then validate the authored guest and generated pattern:

```bash
deno fmt packages/patterns/d3-shared-bars
deno check packages/patterns/d3-shared-bars/guest.ts
deno task cf check packages/patterns/d3-shared-bars/main.tsx --no-run
```

In a real browser, verify all of the following:

- loading controls remain disabled until all initial pulls complete;
- every mark has accessible text and a stable D3 key;
- a shared update rerenders without a reload;
- concurrent appends preserve every new member;
- an item resolved before a reorder still edits the same durable ID;
- PerUser and PerSession resources remain isolated as declared;
- reload restores durable state but not hover, zoom, or animation state;
- errors are visible, and page teardown cancels sinks and disconnects.
