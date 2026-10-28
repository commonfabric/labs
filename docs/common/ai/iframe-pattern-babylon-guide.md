# Babylon.js iframe-first pattern guide

Use this guide to build a Common Fabric pattern whose primary interface is a
3D Babylon.js scene inside one sandboxed `cf-iframe`. The generated wrapper
bundles the guest and its selected Babylon.js modules into one HTML string,
exposes named Cell and SQLite resources, and returns durable state and output
through the normal pattern result.

This guide is self-contained. Use Phaser instead for a primarily 2D game. Do
not load another iframe guide unless the task is an explicit migration or
hybrid.

## Source layout and durable model

```text
packages/patterns/babylon-shared-scene/
├── contract.ts
├── guest.ts
├── guest.html
└── main.tsx     # generated; do not hand-edit
```

Give every durable scene entity a stable ID. Store semantic state, not renderer
objects or every animation frame:

```typescript
export interface SceneEntity {
  id: string;
  position: [number, number, number];
  color: [number, number, number];
}

export interface IframeInputData {
  title: string;
}

export interface IframeStateData {
  entities: SceneEntity[];
}

export interface IframeOutputData {
  selectedId: string | null;
}

export const DEFAULT_INPUT: IframeInputData = { title: "Shared scene" };
export const DEFAULT_STATE: IframeStateData = {
  entities: [{
    id: "starter",
    position: [0, 0.5, 0],
    color: [0.22, 0.74, 0.97],
  }],
};
export const DEFAULT_OUTPUT: IframeOutputData = { selectedId: null };

export const IFRAME_PATTERN = {
  name: "BabylonSharedScene",
  displayName: "Babylon shared scene",
  stateScope: "space",
  outputScope: "session",
  frameHeight: "100vh",
  databases: {},
} as const;
```

Use `space` for a collaborative world, `user` for one user's durable settings,
and `session` for one browser's selection or camera mode. Keep camera matrices,
hover state, interpolation, particle state, and render-loop timing in the guest
unless another component must observe or restore them.

## Import only the Babylon.js modules the scene uses

Pin package subpath imports so the guest bundle contains the required engine
features without importing the whole package namespace:

```typescript
// Shown at module scope.
import { ArcRotateCamera } from "npm:@babylonjs/core@9.23.0/Cameras/arcRotateCamera.js";
import { Engine } from "npm:@babylonjs/core@9.23.0/Engines/engine.js";
import { HemisphericLight } from "npm:@babylonjs/core@9.23.0/Lights/hemisphericLight.js";
import { Color3 } from "npm:@babylonjs/core@9.23.0/Maths/math.color.js";
import { Vector3 } from "npm:@babylonjs/core@9.23.0/Maths/math.vector.js";
import { CreateBox } from "npm:@babylonjs/core@9.23.0/Meshes/Builders/boxBuilder.js";
import { StandardMaterial } from "npm:@babylonjs/core@9.23.0/Materials/standardMaterial.js";
import { Scene } from "npm:@babylonjs/core@9.23.0/scene.js";
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

const canvas = document.querySelector<HTMLCanvasElement>("#scene")!;
const engine = new Engine(canvas, true);
const scene = new Scene(engine);
const camera = new ArcRotateCamera(
  "camera",
  Math.PI / 2,
  Math.PI / 3,
  8,
  Vector3.Zero(),
  scene,
);
camera.attachControl(canvas, true);
new HemisphericLight("light", new Vector3(0, 1, 0), scene);

let hydrated = false;
let inputValue = DEFAULT_INPUT;
let stateValue = DEFAULT_STATE;
let outputValue = DEFAULT_OUTPUT;
type Entity = {
  id: string;
  position: [number, number, number];
  color: [number, number, number];
};

function showError(cause: unknown): void {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  document.querySelector<HTMLElement>("[role=alert]")!.textContent =
    error.message;
}

function renderAuthoritativeState(): void {
  if (!hydrated) return;
  document.querySelector("h1")!.textContent = inputValue.title;
  document.querySelector("output")!.textContent =
    outputValue.selectedId ?? "None";

  const wanted = new Set(
    stateValue.entities.map((entity: Entity) => entity.id),
  );
  for (const mesh of [...scene.meshes]) {
    if (mesh.metadata?.fabricEntity && !wanted.has(mesh.name)) {
      mesh.dispose(false, true);
    }
  }
  for (const entity of stateValue.entities as Entity[]) {
    const mesh = scene.getMeshByName(entity.id) ?? CreateBox(
      entity.id,
      { size: 1 },
      scene,
    );
    mesh.metadata = { fabricEntity: true, id: entity.id };
    mesh.position.copyFrom(Vector3.FromArray(entity.position));
    let material = mesh.material as StandardMaterial | null;
    if (!material) {
      material = new StandardMaterial(`${entity.id}-material`, scene);
      mesh.material = material;
    }
    material.diffuseColor = Color3.FromArray(entity.color);
    mesh.actionManager = null;
    mesh.isPickable = true;
  }
}

async function addBox(): Promise<void> {
  await stateWrite.key("entities").push({
    id: crypto.randomUUID(),
    position: [0, 0.5, 0],
    color: [0.22, 0.74, 0.97],
  });
}

scene.onPointerPick = (_event, pick) => {
  const id = pick.pickedMesh?.metadata?.id;
  if (typeof id === "string") {
    void outputWrite.set({ selectedId: id }).catch(showError);
  }
};
const addButton = document.querySelector<HTMLButtonElement>("#add")!;
addButton.addEventListener("click", () => {
  void addBox().catch(showError);
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
  renderAuthoritativeState();
});

engine.runRenderLoop(() => scene.render());
const resize = () => engine.resize();
globalThis.addEventListener("resize", resize);
let disposed = false;
function dispose(): void {
  if (disposed) return;
  disposed = true;
  cancelInput();
  cancelState();
  cancelOutput();
  globalThis.removeEventListener("resize", resize);
  scene.dispose();
  engine.dispose();
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
  renderAuthoritativeState();
} catch (cause) {
  showError(cause);
  dispose();
}
```

Use one `Engine` and one `Scene` per guest. Dispose both on teardown. Handle
resize explicitly, and test context loss/recovery for scenes that matter in
long-lived tabs.

`sink()` invokes its listener synchronously with the guest's current sample;
that callback does not prove the worker has delivered current state. Keep scene
actions disabled until a joint `Promise.all` of `pull()` calls resolves for all
resources they read. Use `initialize()` for atomic first materialization of a
writable Cell with no backing value. Call it even when `get()` exposes a
compiled schema fallback, so a later path write starts from durable state.

Use the pulls only as a joint readiness barrier. Read values with `get()` after
every pull and initialization has settled, so a newer sink event that arrives
during the barrier cannot be replaced by an older individual pull result.
Install idempotent teardown before starting the barrier, and catch bootstrap
failures so they remain visible while subscriptions and the scene are released.

## Reconcile entities by stable ID

Cell state is the authoritative scene model. Reuse Babylon objects with names
or metadata derived from stable durable IDs, update their properties from each
snapshot, and dispose objects whose IDs disappeared. Never use the current
array index as a mesh identity.

Keep render-loop work local. Do not write transforms to Cells every frame.
Persist meaningful intent at interaction boundaries: place an object, finish a
drag, claim an entity, change a durable material, or end a turn. Interpolate
between accepted snapshots inside Babylon.js.

A transform that other people should see while it changes and that nobody
needs afterwards, such as each visitor's camera or an object held mid-drag,
travels through a presence room instead of a Cell. A room holds each member's
latest record and stores nothing, so publishing from the render loop is what
it is for. It orders nothing between members and keeps no history: whatever
must be agreed on or must survive stays a Cell write.
[Optional presence](./iframe-pattern-guide.md#optional-presence) in the
iframe pattern guide is the contract.

An action the pattern exposes as a verb, or work only the pattern can start,
such as a request to `agent()` or another LLM built-in, goes through a verb the
pattern passes in as a stream where it can; the guest sends it an event with
`fabric.stream(name).send(event)`.
[Optional streams](./iframe-pattern-guide.md#optional-streams) in the iframe
pattern guide is the contract.

The iframe CSP does not grant arbitrary network access. Prefer procedural
geometry and materials in a self-contained guest. If a scene needs external
models or textures, include them as supported pattern data rather than fetching
from a CDN at runtime.

## Use narrow and mergeable operations

Independent entity creation is a mergeable `push()`, as the complete guest
above demonstrates.

Resolve a moving array member before a drag or edit and write through the
stable handle:

```typescript
// Shown at module scope.
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
const fabric = connectFabric();
const stateWrite = fabric.cell<{
  entities: Array<{
    id: string;
    position: [number, number, number];
    color: [number, number, number];
  }>;
}>("state");
async function placeEntity(
  index: number,
  position: [number, number, number],
): Promise<void> {
  const entity = await stateWrite.key("entities").key(index).resolve();
  await entity.key("position").set(position);
}
```

Resolve at interaction start, not after retaining an index across frames.
Redundant sets are deduplicated by the Cell system. A multi-write sequence is
ordered but not atomic, so choose one canonical durable fact when selections,
receipts, and scene state must agree.

Serialize guest actions, expose pending state in ordinary HTML, and show
rejections. A failed durable write must not be hidden behind a successful local
animation.

## Accessible shell

Keep important state and actions outside the canvas as accessible HTML:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Shared scene</title>
  </head>
  <body>
    <main>
      <h1>Loading</h1>
      <p>Selected: <output aria-live="polite">None</output></p>
      <button id="add" type="button" disabled>Add box</button>
      <p role="alert"></p>
      <canvas id="scene" aria-label="Collaborative 3D scene"></canvas>
    </main>
    <!-- PATTERN_IFRAME_SCRIPT -->
  </body>
</html>
```

Use `type="button"`; a scene action must never submit a form or navigate the
frame. Style the HTML around the canvas with the ambient theme the iframe
receives — its elements, `cf-*` classes, and `--cf-theme-*` variables — and
spell no color or font; see
[Style with the ambient theme](./iframe-pattern-guide.md#style-with-the-ambient-theme).
Read a scene's clear color from those variables too when it should match the
page. The custom shell must contain `<!-- PATTERN_IFRAME_SCRIPT -->` exactly
once.

## Generate and validate

```bash
deno run -A tools/write-iframe-wrapper.ts \
  --contract packages/patterns/babylon-shared-scene/contract.ts \
  --guest packages/patterns/babylon-shared-scene/guest.ts \
  --html packages/patterns/babylon-shared-scene/guest.html \
  --out packages/patterns/babylon-shared-scene/main.tsx

deno fmt packages/patterns/babylon-shared-scene
deno check packages/patterns/babylon-shared-scene/guest.ts
deno task cf check packages/patterns/babylon-shared-scene/main.tsx --no-run
```

Launch the pattern with the steps under
[Verify](./iframe-pattern-guide.md#verify) in the plain DOM guide, substituting
this pattern's path, a space label, and a slug. Those steps start local
servers, create the space, and sign the browser in as its owner.

Verify in a real browser that WebGL renders, picking and camera controls work,
shared updates reconcile without recreating the Engine, concurrent additions
compose, a stable entity survives reordering, declared user/session scopes stay
isolated, reload restores durable scene state, errors are visible, resizing
works, and teardown stops the render loop and bridge subscriptions.
