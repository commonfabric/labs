# Phaser iframe-first pattern guide

Use this guide to build a Common Fabric pattern whose primary interface is a
2D Phaser game inside one sandboxed `cf-iframe`. The generated wrapper bundles
Phaser and the guest into one HTML string, exposes named Cell and SQLite
resources, and returns durable state and output through the normal pattern
result.

This guide is self-contained. Use Babylon.js instead when the requested scene
is fundamentally 3D. Do not load the other iframe guides unless the task is an
explicit migration or hybrid.

## Source layout and data contract

Keep the authored sources beside generated `main.tsx`:

```text
packages/patterns/phaser-shared-targets/
├── contract.ts
├── guest.ts
├── guest.html   # optional; useful for a canvas parent and status UI
└── main.tsx     # generated; do not hand-edit
```

Durable game entities need stable IDs. Persist game rules and meaningful
world state, not frame-by-frame presentation state:

```typescript
export interface Target {
  id: string;
  x: number;
  y: number;
  color: number;
}

export interface IframeInputData {
  title: string;
}

export interface IframeStateData {
  targets: Target[];
  hits: Array<{ id: string; targetId: string }>;
}

export interface IframeOutputData {
  lastTargetId: string | null;
}

export const DEFAULT_INPUT: IframeInputData = { title: "Shared targets" };
export const DEFAULT_STATE: IframeStateData = {
  targets: [{ id: "starter", x: 320, y: 180, color: 0x38bdf8 }],
  hits: [],
};
export const DEFAULT_OUTPUT: IframeOutputData = { lastTargetId: null };

export const IFRAME_PATTERN = {
  name: "PhaserSharedTargets",
  displayName: "Phaser shared targets",
  stateScope: "space",
  outputScope: "session",
  frameHeight: "100vh",
  databases: {},
} as const;
```

Use `space` for a shared world, `user` for one player's durable progress, and
`session` for state that belongs only to one browser session. Input, state,
output, and each SQLite database choose their scopes independently.

Keep camera position, pointer state, tweens, particles, interpolation, physics
contacts, and the current animation frame in Phaser. Persist them only when
they are actual application data that must survive a reload.

## Create one game and one bridge client

Pin Phaser in `guest.ts`. Create exactly one `Phaser.Game`, keep the Fabric
client outside the Scene, and destroy both on page teardown:

```typescript
// Shown at module scope.
import Phaser from "npm:phaser@4.2.1";
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

let hydrated = false;
let inputValue = DEFAULT_INPUT;
let stateValue = DEFAULT_STATE;
let outputValue = DEFAULT_OUTPUT;
let scene: Phaser.Scene | undefined;

function showError(cause: unknown): void {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  document.querySelector<HTMLElement>("[role=alert]")!.textContent =
    error.message;
}

function renderAuthoritativeState(): void {
  if (!hydrated || !scene) return;
  document.querySelector("h1")!.textContent = inputValue.title;
  document.querySelector("output")!.textContent = String(
    stateValue.hits.length,
  );

  const existing = new Map(
    scene.children.list
      .filter((child) => child.getData("fabricEntity") === true)
      .map((child) => [child.name, child]),
  );
  for (const target of stateValue.targets) {
    let object = existing.get(target.id) as Phaser.GameObjects.Arc | undefined;
    if (!object) {
      object = scene.add.circle(target.x, target.y, 18, target.color)
        .setName(target.id)
        .setData("fabricEntity", true)
        .setInteractive();
      object.on("pointerdown", () => {
        void hitTarget(target.id).catch(showError);
      });
    }
    object.setPosition(target.x, target.y).setFillStyle(target.color);
    existing.delete(target.id);
  }
  for (const stale of existing.values()) stale.destroy();
}

async function hitTarget(id: string): Promise<void> {
  await stateWrite.key("hits").push({
    id: crypto.randomUUID(),
    targetId: id,
  });
  await outputWrite.set({ lastTargetId: id });
}

async function spawnTarget(): Promise<void> {
  await stateWrite.key("targets").push({
    id: crypto.randomUUID(),
    x: 80 + Math.random() * 480,
    y: 60 + Math.random() * 240,
    color: 0x38bdf8,
  });
}

class MainScene extends Phaser.Scene {
  create(): void {
    scene = this;
    renderAuthoritativeState();
  }
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: 640,
  height: 360,
  backgroundColor: "#111827",
  scene: MainScene,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
});
const spawnButton = document.querySelector<HTMLButtonElement>("#spawn")!;
spawnButton.addEventListener("click", () => {
  void spawnTarget().catch(showError);
});

const cancelInput = input.sink((value) => {
  inputValue = value ?? DEFAULT_INPUT;
  renderAuthoritativeState();
});
const cancelState = state.sink((value) => {
  stateValue = value ?? DEFAULT_STATE;
  renderAuthoritativeState();
});
const cancelOutput = output.sink((value) => {
  outputValue = value ?? DEFAULT_OUTPUT;
});

let disposed = false;
function dispose(): void {
  if (disposed) return;
  disposed = true;
  cancelInput();
  cancelState();
  cancelOutput();
  game.destroy(true);
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
  spawnButton.disabled = false;
  renderAuthoritativeState();
} catch (cause) {
  showError(cause);
  dispose();
}
```

`sink()` calls synchronously with the guest's current sample and later with
host changes. Its first callback is not a readiness signal. Keep controls and
gameplay disabled until one joint `Promise.all` of `pull()` calls has resolved
for every resource an action reads.

Use the pulls only as a joint readiness barrier. Read values with `get()` after
every pull and initialization has settled, so a newer sink event that arrives
during the barrier cannot be replaced by an older individual pull result.
Install idempotent teardown before starting the barrier, and catch bootstrap
failures so they remain visible while subscriptions and the game are released.

`initialize()` is the atomic first-use operation. It stores a default only
while the Cell has no backing value and returns the transaction's winner. Call
it even when `get()` exposes a compiled schema fallback, so the fallback is
materialized before a path write. Never blind-set the whole world merely to
ensure it exists.

## Separate the simulation from durable state

Treat Cell state as an authoritative model and Phaser as its renderer:

1. A sink replaces the guest's authoritative snapshot.
2. Reconcile Phaser objects by stable entity ID.
3. Pointer, keyboard, or collision events issue explicit intent writes.
4. The next sink update reconciles the accepted shared result.

Do not write a Cell from `update()` on every frame. A 60 Hz write loop creates
contention, unnecessary commits, and feedback between the simulation and its
authoritative model. Interpolate locally between accepted states and persist
only meaningful actions such as spawning, claiming, scoring, or ending a turn.

State that other players should see while it happens and that nobody needs
afterwards, such as where each player is right now, travels through a presence
room instead of a Cell. A room holds each player's latest record and stores
nothing, so publishing a position from the game loop is what it is for. It
orders nothing between players and keeps no history: a score, a claim, or
anything two players must agree on stays a Cell write.
[Optional presence](./iframe-pattern-guide.md#optional-presence) in the
iframe pattern guide is the contract.

An action the pattern exposes as a verb, or work only the pattern can start,
such as a request to `agent()` or another LLM built-in, goes through a verb the
pattern passes in as a stream where it can; the guest sends it an event with
`fabric.stream(name).send(event)`.
[Optional streams](./iframe-pattern-guide.md#optional-streams) in the iframe
pattern guide is the contract.

Generate textures and simple audio locally when practical. The iframe CSP does
not allow arbitrary network fetches, so do not load assets from a CDN. For
larger assets, include data files through the supported pattern program rather
than inventing a side channel.

## Use operations that match player intent

Append independently created entities with mergeable `push()`, as the complete
guest above does. The same principle makes `hits` an append-only intent log and
derives the displayed score from `hits.length`; concurrent hits compose instead
of racing two last-writer-wins numeric replacements.

When an input starts from an array position, resolve it immediately to a stable
Cell and then write paths on that handle:

```typescript
// Shown at module scope.
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
const fabric = connectFabric();
const stateWrite = fabric.cell<{
  targets: Array<{ id: string; x: number; y: number; color: number }>;
}>("state");
async function moveTarget(index: number, x: number, y: number): Promise<void> {
  const target = await stateWrite.key("targets").key(index).resolve();
  await target.key("x").set(x);
  await target.key("y").set(y);
}
```

The resolved handle follows the same durable member if concurrent changes move
it in the array. Do not retain a numeric index across frames and resolve it
later. Multiple writes are ordered but not atomic; store one canonical fact
when a derived score, receipt, and animation must agree.

Serialize guest actions, disable the relevant control while one is pending,
and surface failures in visible status text. Redundant authoritative writes are
deduplicated by the Cell layer.

## Accessible shell and lifecycle

Canvas content alone is not enough for browser automation or assistive
technology. Mirror important state and controls in ordinary HTML:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Shared targets</title>
  </head>
  <body>
    <main>
      <h1>Loading</h1>
      <p>Score: <output aria-live="polite">0</output></p>
      <button id="spawn" type="button" disabled>Spawn target</button>
      <p role="alert"></p>
      <div id="game" aria-label="Shared targets game"></div>
    </main>
    <!-- PATTERN_IFRAME_SCRIPT -->
  </body>
</html>
```

Use `type="button"`; game controls must never rely on form submission. Style
the HTML around the game with the ambient theme the iframe receives — its
elements, `cf-*` classes, and `--cf-theme-*` variables — and spell no color or
font; see
[Style with the ambient theme](./iframe-pattern-guide.md#style-with-the-ambient-theme). Pause or
mute on `visibilitychange` when appropriate. On `pagehide`, cancel every sink,
destroy the game, remove global listeners, and disconnect the bridge.

## Generate and validate

```bash
deno run -A tools/write-iframe-wrapper.ts \
  --contract packages/patterns/phaser-shared-targets/contract.ts \
  --guest packages/patterns/phaser-shared-targets/guest.ts \
  --html packages/patterns/phaser-shared-targets/guest.html \
  --out packages/patterns/phaser-shared-targets/main.tsx

deno fmt packages/patterns/phaser-shared-targets
deno check packages/patterns/phaser-shared-targets/guest.ts
deno task cf check packages/patterns/phaser-shared-targets/main.tsx --no-run
```

Launch the pattern with the steps under
[Verify](./iframe-pattern-guide.md#verify) in the plain DOM guide, substituting
this pattern's path, a space label, and a slug. Those steps start local
servers, create the space, and sign the browser in as its owner.

Verify in a real browser that the canvas renders, pointer and keyboard controls
work, shared changes reconcile without recreating the game, concurrent spawns
compose, stable entities survive reordering, declared user/session scopes stay
isolated, reload restores durable progress, errors are visible, and teardown
leaves no render loop or bridge subscription running.
