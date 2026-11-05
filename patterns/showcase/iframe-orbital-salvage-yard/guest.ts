// deno-lint-ignore-file no-external-import -- pinned Babylon subpaths are bundled into the iframe
import { ArcRotateCamera } from "npm:@babylonjs/core@9.23.0/Cameras/arcRotateCamera.js";
import { Engine } from "npm:@babylonjs/core@9.23.0/Engines/engine.js";
import { PointerEventTypes } from "npm:@babylonjs/core@9.23.0/Events/pointerEvents.js";
import { HemisphericLight } from "npm:@babylonjs/core@9.23.0/Lights/hemisphericLight.js";
import { StandardMaterial } from "npm:@babylonjs/core@9.23.0/Materials/standardMaterial.js";
import { Color3, Color4 } from "npm:@babylonjs/core@9.23.0/Maths/math.color.js";
import { Vector3 } from "npm:@babylonjs/core@9.23.0/Maths/math.vector.js";
import { CreateBox } from "npm:@babylonjs/core@9.23.0/Meshes/Builders/boxBuilder.js";
import { CreateCylinder } from "npm:@babylonjs/core@9.23.0/Meshes/Builders/cylinderBuilder.js";
import { CreateGround } from "npm:@babylonjs/core@9.23.0/Meshes/Builders/groundBuilder.js";
import { CreateSphere } from "npm:@babylonjs/core@9.23.0/Meshes/Builders/sphereBuilder.js";
import type { AbstractMesh } from "npm:@babylonjs/core@9.23.0/Meshes/abstractMesh.js";
import { TransformNode } from "npm:@babylonjs/core@9.23.0/Meshes/transformNode.js";
import { Scene } from "npm:@babylonjs/core@9.23.0/scene.js";
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";

import {
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeInputData,
  type IframeOutputData,
  type IframeStateData,
  type ModuleKind,
  type ModuleSnapClaim,
  type StationModule,
  type Vector3Tuple,
  type YardTool,
} from "./contract.ts";
import {
  findBestSnap,
  findConnections,
  normalizeQuarterTurns,
} from "./geometry.ts";
import {
  activeSnapClaims,
  applyModuleTransforms,
  canBeginDrag,
  createSalvageModule,
  dragDisposition,
  initializeGraphics,
  isBookmarked,
  markPointerCancelled,
  moduleTransformId,
  ownsDrag,
  pointerWasCancelled,
  resolveSnapClaims,
  setBookmark,
  writeModuleTransformField,
} from "./model.ts";

type ModuleVisual = {
  kind: ModuleKind;
  root: TransformNode;
  bodyMaterial: StandardMaterial;
  connectorMaterial: StandardMaterial;
};

type DragState = {
  moduleId: string;
  pointerId: number;
  position: Vector3Tuple;
  moved: boolean;
};

const fabric = connectFabric();
const input = fabric.cell<IframeInputData | undefined>("input");
const state = fabric.cell<IframeStateData | undefined>("state");
const output = fabric.cell<IframeOutputData | undefined>("output");
const stateWrite = fabric.cell<IframeStateData>("state");
const outputWrite = fabric.cell<IframeOutputData>("output");
const modulesCell = stateWrite.key("modules");
const moduleTransformsCell = stateWrite.key("moduleTransforms");
const moduleTransformIdsCell = stateWrite.key("moduleTransformIds");
const snapClaimsCell = stateWrite.key("snapClaims");
const releasedSnapClaimsCell = stateWrite.key("releasedSnapClaims");

const canvas = required<HTMLCanvasElement>("#scene");
const heading = required<HTMLHeadingElement>("h1");
const subtitle = required<HTMLParagraphElement>(".subtitle");
const moduleCount = required<HTMLElement>("#module-count");
const jointCount = required<HTMLElement>("#joint-count");
const cameraReadout = required<HTMLElement>("#camera-readout");
const toolSelect = required<HTMLSelectElement>("#tool");
const accentInput = required<HTMLInputElement>("#accent");
const resetCameraButton = required<HTMLButtonElement>("#reset-camera");
const selectedLabel = required<HTMLElement>("#selected-label");
const selectedTransform = required<HTMLOutputElement>("#selected-transform");
const rotateLeftButton = required<HTMLButtonElement>("#rotate-left");
const rotateRightButton = required<HTMLButtonElement>("#rotate-right");
const snapButton = required<HTMLButtonElement>("#snap");
const bookmarkButton = required<HTMLButtonElement>("#bookmark");
const moduleMirror = required<HTMLUListElement>("#module-mirror");
const connectionMirror = required<HTMLUListElement>("#connection-mirror");
const status = required<HTMLElement>("#yard-status");
const alert = required<HTMLElement>("[role=alert]");

const { engine, scene } = initializeGraphics(
  () => {
    const engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: true,
    });
    try {
      return { engine, scene: new Scene(engine) };
    } catch (cause) {
      engine.dispose();
      throw cause;
    }
  },
  (cause) => {
    showError(cause);
    status.textContent = "The salvage yard could not start its 3D renderer.";
    status.dataset.ready = "false";
    fabric.disconnect();
  },
);
scene.clearColor = new Color4(0.012, 0.025, 0.04, 1);
const camera = new ArcRotateCamera(
  "salvage-orbit-camera",
  -Math.PI / 3,
  Math.PI / 3,
  23,
  new Vector3(0, 1.2, 0),
  scene,
);
camera.lowerRadiusLimit = 7;
camera.upperRadiusLimit = 45;
camera.lowerBetaLimit = 0.18;
camera.upperBetaLimit = Math.PI / 2.02;
camera.wheelPrecision = 35;
camera.panningSensibility = 0;
camera.attachControl(canvas, true);

const keyLight = new HemisphericLight(
  "yard-key-light",
  new Vector3(0.3, 1, -0.2),
  scene,
);
keyLight.intensity = 1.3;
keyLight.diffuse = new Color3(0.72, 0.84, 1);
keyLight.groundColor = new Color3(0.09, 0.12, 0.18);

const planeMaterial = new StandardMaterial("orbital-plane-material", scene);
planeMaterial.diffuseColor = new Color3(0.08, 0.18, 0.25);
planeMaterial.emissiveColor = new Color3(0.018, 0.055, 0.08);
planeMaterial.alpha = 0.3;
const orbitalPlane = CreateGround(
  "orbital-plane",
  { width: 80, height: 80, subdivisions: 20 },
  scene,
);
orbitalPlane.position.y = 0;
orbitalPlane.material = planeMaterial;
orbitalPlane.metadata = { yardSurface: true };
orbitalPlane.isPickable = true;

const starMaterial = new StandardMaterial("star-material", scene);
starMaterial.disableLighting = true;
starMaterial.emissiveColor = new Color3(0.62, 0.76, 0.91);
let starSeed = 0x51a1_9e;
for (let index = 0; index < 54; index++) {
  const star = CreateSphere(
    `procedural-star-${index}`,
    { diameter: 0.035 + randomUnit() * 0.06, segments: 4 },
    scene,
  );
  const angle = randomUnit() * Math.PI * 2;
  const radius = 24 + randomUnit() * 22;
  star.position.set(
    Math.cos(angle) * radius,
    3 + randomUnit() * 22,
    Math.sin(angle) * radius,
  );
  star.material = starMaterial;
  star.isPickable = false;
}

const moduleVisuals = new Map<string, ModuleVisual>();
const jointVisuals = new Map<string, AbstractMesh>();
const jointMaterial = new StandardMaterial("locked-interface-material", scene);
jointMaterial.disableLighting = true;
jointMaterial.emissiveColor = new Color3(0.44, 0.96, 0.72);

let inputValue: Readonly<IframeInputData> = DEFAULT_INPUT;
let stateValue: Readonly<IframeStateData> = DEFAULT_STATE;
let outputValue: Readonly<IframeOutputData> = DEFAULT_OUTPUT;
let hydrated = false;
let pendingAction: string | undefined;
let selectedModuleId: string | null = null;
let selectionAwaitingModuleId: string | undefined;
let drag: DragState | undefined;
const cancelledPointers = new Set<number>();
let disposed = false;
let actionTail = Promise.resolve();
const abort = new AbortController();
const { signal } = abort;

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element ${selector}.`);
  return element;
}

function randomUnit(): number {
  starSeed = (Math.imul(starSeed, 1_664_525) + 1_013_904_223) >>> 0;
  return starSeed / 0x1_0000_0000;
}

function showError(cause: unknown): void {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  alert.textContent = error.message;
}

function clearError(): void {
  alert.textContent = "";
}

function selectedModule(): StationModule | undefined {
  if (!selectedModuleId) return undefined;
  return effectiveModules().find((module) => module.id === selectedModuleId);
}

function effectiveModules(
  value: Readonly<IframeStateData> = stateValue,
): StationModule[] {
  return resolveSnapClaims(
    applyModuleTransforms(
      value.modules,
      value.moduleTransforms,
      value.moduleTransformIds,
      value.snapClaims ?? {},
      value.releasedSnapClaims ?? {},
    ),
    activeSnapClaims(
      value.snapClaims ?? {},
      value.releasedSnapClaims ?? {},
    ),
  );
}

function updateControlState(): void {
  const blocked = !hydrated || Boolean(pendingAction);
  for (
    const control of document.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLSelectElement
    >(".requires-ready")
  ) {
    control.disabled = blocked;
  }
  const selectionBlocked = blocked || !selectedModule();
  for (
    const control of document.querySelectorAll<HTMLButtonElement>(
      ".selection-action",
    )
  ) {
    control.disabled = selectionBlocked;
  }
  if (pendingAction) {
    status.textContent = `Committing ${pendingAction}…`;
    status.dataset.ready = "false";
  } else if (hydrated) {
    status.textContent =
      "Ready · Fabric is authoritative; Babylon is synchronized.";
    status.dataset.ready = "true";
  }
}

function resetCamera(): void {
  camera.alpha = -Math.PI / 3;
  camera.beta = Math.PI / 3;
  camera.radius = 23;
  camera.target.copyFromFloats(0, 1.2, 0);
}

function cameraDescription(): string {
  return `Orbit ${camera.radius.toFixed(1)} m · azimuth ${
    Math.round(camera.alpha * 180 / Math.PI)
  }°`;
}

function colorFromHex(value: string): Color3 {
  return /^#[0-9a-f]{6}$/i.test(value)
    ? Color3.FromHexString(value)
    : Color3.FromHexString(DEFAULT_OUTPUT.accentColor);
}

function addBody(
  visual: ModuleVisual,
  mesh: AbstractMesh,
  moduleId: string,
): void {
  mesh.parent = visual.root;
  mesh.material = visual.bodyMaterial;
  mesh.metadata = { yardModuleId: moduleId };
  mesh.isPickable = true;
}

function createVisual(module: StationModule): ModuleVisual {
  const root = new TransformNode(`module-root:${module.id}`, scene);
  const bodyMaterial = new StandardMaterial(
    `module-body-material:${module.id}`,
    scene,
  );
  bodyMaterial.specularColor = new Color3(0.28, 0.34, 0.38);
  const connectorMaterial = new StandardMaterial(
    `module-connector-material:${module.id}`,
    scene,
  );
  connectorMaterial.specularColor = new Color3(0.78, 0.86, 0.92);
  connectorMaterial.specularPower = 96;
  const visual: ModuleVisual = {
    kind: module.kind,
    root,
    bodyMaterial,
    connectorMaterial,
  };

  if (module.kind === "hub") {
    const body = CreateCylinder(
      `module-body:${module.id}`,
      { height: 1.65, diameter: 4.2, tessellation: 12 },
      scene,
    );
    addBody(visual, body, module.id);
    const crown = CreateCylinder(
      `module-crown:${module.id}`,
      { height: 0.35, diameter: 2.2, tessellation: 12 },
      scene,
    );
    crown.position.y = 1;
    addBody(visual, crown, module.id);
  } else if (module.kind === "habitat") {
    const body = CreateCylinder(
      `module-body:${module.id}`,
      { height: 4.3, diameter: 2.35, tessellation: 16 },
      scene,
    );
    body.rotation.x = Math.PI / 2;
    addBody(visual, body, module.id);
    for (const z of [-1.45, 0, 1.45]) {
      const band = CreateCylinder(
        `module-band:${module.id}:${z}`,
        { height: 0.14, diameter: 2.5, tessellation: 16 },
        scene,
      );
      band.rotation.x = Math.PI / 2;
      band.position.z = z;
      addBody(visual, band, module.id);
    }
  } else if (module.kind === "cargo") {
    const body = CreateBox(
      `module-body:${module.id}`,
      { width: 4.4, height: 1.6, depth: 1.85 },
      scene,
    );
    addBody(visual, body, module.id);
    for (const x of [-1.45, 0, 1.45]) {
      const rib = CreateBox(
        `module-rib:${module.id}:${x}`,
        { width: 0.12, height: 1.82, depth: 2.05 },
        scene,
      );
      rib.position.x = x;
      addBody(visual, rib, module.id);
    }
  } else if (module.kind === "solar") {
    const truss = CreateBox(
      `module-truss:${module.id}`,
      { width: 4.35, height: 0.38, depth: 0.42 },
      scene,
    );
    addBody(visual, truss, module.id);
    for (const z of [-1.25, 1.25]) {
      const panel = CreateBox(
        `module-panel:${module.id}:${z}`,
        { width: 3.6, height: 0.12, depth: 1.95 },
        scene,
      );
      panel.position.z = z;
      addBody(visual, panel, module.id);
    }
  } else {
    const mast = CreateCylinder(
      `module-mast:${module.id}`,
      { height: 3.2, diameter: 0.65, tessellation: 10 },
      scene,
    );
    mast.rotation.x = Math.PI / 2;
    addBody(visual, mast, module.id);
    const dish = CreateSphere(
      `module-dish:${module.id}`,
      { diameter: 2.25, segments: 10, slice: 0.42 },
      scene,
    );
    dish.position.z = 1.25;
    addBody(visual, dish, module.id);
  }

  for (const connector of module.connectors) {
    const lock = CreateSphere(
      `module-connector:${module.id}:${connector.id}`,
      { diameter: 0.48, segments: 8 },
      scene,
    );
    lock.parent = root;
    lock.position.copyFrom(Vector3.FromArray(connector.offset));
    lock.material = connectorMaterial;
    lock.metadata = { yardModuleId: module.id, connectorId: connector.id };
    lock.isPickable = true;
  }
  return visual;
}

function reconcileModules(): void {
  const modules = effectiveModules();
  const wanted = new Set(modules.map((module) => module.id));
  for (const [id, visual] of moduleVisuals) {
    if (wanted.has(id)) continue;
    visual.root.dispose(false, true);
    moduleVisuals.delete(id);
  }

  const accent = colorFromHex(outputValue.accentColor);
  for (const module of modules) {
    let visual = moduleVisuals.get(module.id);
    if (visual && visual.kind !== module.kind) {
      visual.root.dispose(false, true);
      moduleVisuals.delete(module.id);
      visual = undefined;
    }
    visual ??= createVisual(module);
    moduleVisuals.set(module.id, visual);
    if (drag?.moduleId !== module.id) {
      visual.root.position.copyFrom(
        Vector3.FromArray(module.transform.position),
      );
    }
    visual.root.rotation.y = normalizeQuarterTurns(
      module.transform.rotationQuarterTurns,
    ) * Math.PI / 2;
    const base = Color3.FromArray(module.color);
    const selected = module.id === selectedModuleId;
    visual.bodyMaterial.diffuseColor = base;
    visual.bodyMaterial.emissiveColor = selected
      ? accent.scale(0.38)
      : Color3.Black();
    visual.connectorMaterial.diffuseColor = selected
      ? accent
      : base.scale(1.18);
    visual.connectorMaterial.emissiveColor = selected
      ? accent.scale(0.3)
      : Color3.Black();
  }
}

function reconcileConnections(): void {
  const modules = effectiveModules();
  const connections = findConnections(modules);
  const wanted = new Set(connections.map((connection) => connection.id));
  for (const [id, visual] of jointVisuals) {
    if (wanted.has(id)) continue;
    visual.dispose();
    jointVisuals.delete(id);
  }
  for (const connection of connections) {
    let visual = jointVisuals.get(connection.id);
    if (!visual) {
      visual = CreateSphere(
        `locked-interface:${connection.id}`,
        { diameter: 0.68, segments: 10 },
        scene,
      );
      visual.material = jointMaterial;
      visual.isPickable = false;
      jointVisuals.set(connection.id, visual);
    }
    visual.position.copyFrom(Vector3.FromArray(connection.first.position));
  }
  jointCount.textContent = String(connections.length);
  connectionMirror.replaceChildren(
    ...(connections.length
      ? connections.map((connection) => {
        const item = document.createElement("li");
        const first = modules.find((module) =>
          module.id === connection.first.moduleId
        );
        const second = modules.find((module) =>
          module.id === connection.second.moduleId
        );
        item.textContent = `${first?.label ?? connection.first.moduleId} ↔ ${
          second?.label ?? connection.second.moduleId
        }`;
        return item;
      })
      : [Object.assign(document.createElement("li"), {
        textContent: "No interfaces locked.",
      })]),
  );
}

function renderManifest(): void {
  moduleMirror.replaceChildren(
    ...effectiveModules().map((module) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      const label = document.createElement("strong");
      const kind = document.createElement("span");
      button.type = "button";
      button.dataset.moduleId = module.id;
      button.ariaPressed = String(module.id === selectedModuleId);
      button.disabled = !hydrated || Boolean(pendingAction);
      label.textContent = `${
        isBookmarked(outputValue.bookmarks, module.id) ? "★ " : ""
      }${module.label}`;
      kind.className = "module-kind";
      kind.textContent = module.kind;
      button.append(label, kind);
      item.append(button);
      return item;
    }),
  );
}

function renderSelection(): void {
  const module = selectedModule();
  if (!module) {
    selectedLabel.textContent = "No module selected";
    selectedTransform.textContent = "Pick a module in the scene or manifest.";
    bookmarkButton.textContent = "Bookmark";
  } else {
    const [x, y, z] = module.transform.position;
    selectedLabel.textContent = module.label;
    selectedTransform.textContent = `${module.kind} · position ${
      x.toFixed(1)
    }, ${y.toFixed(1)}, ${z.toFixed(1)} · rotation ${
      normalizeQuarterTurns(module.transform.rotationQuarterTurns) * 90
    }° · ${module.connectors.length} connector${
      module.connectors.length === 1 ? "" : "s"
    }`;
    bookmarkButton.textContent = isBookmarked(outputValue.bookmarks, module.id)
      ? "Remove bookmark"
      : "Bookmark";
  }
  updateControlState();
}

function renderAuthoritativeState(): void {
  if (!hydrated) return;
  if (
    selectionAwaitingModuleId &&
    stateValue.modules.some((module) => module.id === selectionAwaitingModuleId)
  ) {
    selectedModuleId = selectionAwaitingModuleId;
    selectionAwaitingModuleId = undefined;
  }
  if (
    selectedModuleId &&
    !stateValue.modules.some((module) => module.id === selectedModuleId)
  ) selectedModuleId = null;
  heading.textContent = inputValue.title;
  subtitle.textContent = inputValue.subtitle;
  toolSelect.value = outputValue.preferredTool;
  accentInput.value = /^#[0-9a-f]{6}$/i.test(outputValue.accentColor)
    ? outputValue.accentColor
    : DEFAULT_OUTPUT.accentColor;
  moduleCount.textContent = String(stateValue.modules.length);
  reconcileModules();
  reconcileConnections();
  renderManifest();
  renderSelection();
}

function renderSafely(): void {
  try {
    renderAuthoritativeState();
  } catch (cause) {
    showError(cause);
  }
}

function selectModule(moduleId: string | null): void {
  selectedModuleId = moduleId;
  renderAuthoritativeState();
}

function runAction(label: string, action: () => Promise<void>): Promise<void> {
  const next = actionTail.then(async () => {
    if (!hydrated) return;
    pendingAction = label;
    clearError();
    updateControlState();
    renderManifest();
    try {
      await action();
    } catch (cause) {
      showError(cause);
    } finally {
      pendingAction = undefined;
      updateControlState();
      renderAuthoritativeState();
    }
  });
  actionTail = next.then(() => {}, () => {});
  return next;
}

async function writeTransformField<
  Key extends keyof StationModule["transform"],
>(
  latestState: IframeStateData,
  module: StationModule,
  key: Key,
  value: StationModule["transform"][Key],
): Promise<void> {
  const claim = latestState.snapClaims[module.id];
  const transformId = claim
    ? moduleTransformId(module.id, claim.id)
    : latestState.moduleTransformIds[module.id] ?? moduleTransformId(module.id);
  await writeModuleTransformField(
    transformId,
    moduleTransformsCell.key(transformId),
    claim ? undefined : moduleTransformIdsCell.key(module.id),
    module.transform,
    key,
    value,
    claim ? releasedSnapClaimsCell.key(claim.id) : undefined,
  );
}

async function moveSelected(delta: Vector3Tuple): Promise<void> {
  const moduleId = selectedModuleId;
  if (!moduleId) return;
  await state.pull();
  const latestState = state.get() ?? DEFAULT_STATE;
  const module = effectiveModules(latestState).find(({ id }) =>
    id === moduleId
  );
  if (!module) throw new Error("That salvage module is no longer available.");
  const [x, y, z] = module.transform.position;
  const position: Vector3Tuple = [
    roundHalf(x + delta[0]),
    Math.max(0.6, roundHalf(y + delta[1])),
    roundHalf(z + delta[2]),
  ];
  await writeTransformField(latestState, module, "position", position);
}

async function rotateSelected(delta: number): Promise<void> {
  const moduleId = selectedModuleId;
  if (!moduleId) return;
  await state.pull();
  const latestState = state.get() ?? DEFAULT_STATE;
  const module = effectiveModules(latestState).find(({ id }) =>
    id === moduleId
  );
  if (!module) throw new Error("That salvage module is no longer available.");
  const rotationQuarterTurns = normalizeQuarterTurns(
    module.transform.rotationQuarterTurns + delta,
  );
  await writeTransformField(
    latestState,
    module,
    "rotationQuarterTurns",
    rotationQuarterTurns,
  );
}

async function snapSelected(): Promise<void> {
  const moduleId = selectedModuleId;
  if (!moduleId) return;
  await state.pull();
  const latestState = state.get() ?? DEFAULT_STATE;
  const modules = effectiveModules(latestState);
  const moving = modules.find((module) => module.id === moduleId);
  if (!moving) throw new Error("That salvage module is no longer available.");
  const result = findBestSnap(
    moving,
    modules.filter((module) => module.id !== moduleId),
    4.5,
  );
  if (!result) {
    throw new Error("Move this module within 4.5 meters of a compatible lock.");
  }
  const claim: ModuleSnapClaim = {
    id: crypto.randomUUID(),
    movingConnectorId: result.movingConnectorId,
    targetModuleId: result.targetModuleId,
    targetConnectorId: result.targetConnectorId,
    rotationQuarterTurns: result.transform.rotationQuarterTurns,
  };
  await snapClaimsCell.key(moduleId).set(claim);
}

async function addModule(kind: ModuleKind): Promise<void> {
  const module = createSalvageModule(kind, crypto.randomUUID());
  selectionAwaitingModuleId = module.id;
  try {
    await modulesCell.push(module);
  } catch (cause) {
    selectionAwaitingModuleId = undefined;
    throw cause;
  }
}

async function toggleBookmark(): Promise<void> {
  const moduleId = selectedModuleId;
  if (!moduleId) return;
  const current = output.get() ?? outputValue;
  await setBookmark(
    outputWrite.key("bookmarks"),
    moduleId,
    !isBookmarked(current.bookmarks, moduleId),
  );
}

function roundHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

function beginDrag(moduleId: string, pointerId: number): void {
  if (
    !hydrated || pendingAction || outputValue.preferredTool !== "move" ||
    !canBeginDrag(drag)
  ) {
    return;
  }
  const module = effectiveModules().find((candidate) =>
    candidate.id === moduleId
  );
  if (!module) return;
  selectModule(moduleId);
  camera.detachControl();
  canvas.setPointerCapture(pointerId);
  canvas.style.cursor = "grabbing";
  cancelledPointers.delete(pointerId);
  drag = {
    moduleId,
    pointerId,
    position: [...module.transform.position],
    moved: false,
  };
}

function updateDrag(pointerId: number): void {
  if (!ownsDrag(drag, pointerId)) return;
  const pick = scene.pick(
    scene.pointerX,
    scene.pointerY,
    (mesh) => mesh.metadata?.yardSurface === true,
  );
  if (!pick?.hit || !pick.pickedPoint) return;
  drag.position = [
    roundHalf(pick.pickedPoint.x),
    drag.position[1],
    roundHalf(pick.pickedPoint.z),
  ];
  drag.moved = true;
  const visual = moduleVisuals.get(drag.moduleId);
  visual?.root.position.copyFrom(Vector3.FromArray(drag.position));
  selectedTransform.textContent = `Dragging preview · position ${
    drag.position.map((value) => value.toFixed(1)).join(", ")
  } · release to commit once`;
}

function endDrag(pointerId: number, cancelled: boolean): void {
  const disposition = dragDisposition(drag, pointerId, cancelled);
  if (disposition === "ignore") return;
  const completed = drag;
  if (!completed) return;
  drag = undefined;
  if (canvas.hasPointerCapture(completed.pointerId)) {
    canvas.releasePointerCapture(completed.pointerId);
  }
  canvas.style.cursor = "grab";
  camera.attachControl(canvas, true);
  if (disposition === "restore") {
    renderAuthoritativeState();
    return;
  }
  void runAction("drag position", async () => {
    await state.pull();
    const latestState = state.get() ?? DEFAULT_STATE;
    const module = effectiveModules(latestState).find(({ id }) =>
      id === completed.moduleId
    );
    if (!module) {
      throw new Error("That salvage module is no longer available.");
    }
    await writeTransformField(
      latestState,
      module,
      "position",
      completed.position,
    );
  });
}

const pointerObserver = scene.onPointerObservable.add((pointerInfo) => {
  const event = pointerInfo.event as PointerEvent;
  if (pointerInfo.type === PointerEventTypes.POINTERDOWN) {
    if (event.button !== 0) return;
    const moduleId = pointerInfo.pickInfo?.pickedMesh?.metadata?.yardModuleId;
    if (typeof moduleId === "string" && canBeginDrag(drag)) {
      selectModule(moduleId);
      beginDrag(moduleId, event.pointerId);
    }
  } else if (pointerInfo.type === PointerEventTypes.POINTERMOVE) {
    updateDrag(event.pointerId);
  } else if (pointerInfo.type === PointerEventTypes.POINTERUP) {
    endDrag(
      event.pointerId,
      pointerWasCancelled(cancelledPointers, event.pointerId),
    );
  }
});

const cameraObserver = camera.onViewMatrixChangedObservable.add(() => {
  cameraReadout.textContent = cameraDescription();
});

for (
  const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-move]",
  )
) {
  button.addEventListener("click", () => {
    const delta = button.dataset.move?.split(",").map(Number) as
      | Vector3Tuple
      | undefined;
    if (!delta || delta.some((value) => !Number.isFinite(value))) return;
    void runAction("module position", () => moveSelected(delta));
  }, { signal });
}

for (
  const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-add-kind]",
  )
) {
  button.addEventListener("click", () => {
    const kind = button.dataset.addKind as ModuleKind;
    void runAction("new salvage", () => addModule(kind));
  }, { signal });
}

moduleMirror.addEventListener("click", (event) => {
  const target = event.target as Element;
  const button = target.closest<HTMLButtonElement>("button[data-module-id]");
  if (button) selectModule(button.dataset.moduleId ?? null);
}, { signal });
rotateLeftButton.addEventListener("click", () => {
  void runAction("module rotation", () => rotateSelected(-1));
}, { signal });
rotateRightButton.addEventListener("click", () => {
  void runAction("module rotation", () => rotateSelected(1));
}, { signal });
snapButton.addEventListener("click", () => {
  void runAction("connector snap", snapSelected);
}, { signal });
bookmarkButton.addEventListener("click", () => {
  void runAction("personal bookmark", toggleBookmark);
}, { signal });
toolSelect.addEventListener("change", () => {
  const tool = toolSelect.value as YardTool;
  void runAction(
    "preferred tool",
    () => outputWrite.key("preferredTool").set(tool),
  );
}, { signal });
accentInput.addEventListener("change", () => {
  const value = accentInput.value;
  void runAction(
    "selection accent",
    () => outputWrite.key("accentColor").set(value),
  );
}, { signal });
resetCameraButton.addEventListener("click", resetCamera, { signal });
globalThis.addEventListener("pointercancel", (event) => {
  markPointerCancelled(cancelledPointers, event.pointerId);
}, { capture: true, signal });
globalThis.addEventListener("pointerup", (event) => {
  endDrag(event.pointerId, false);
}, { signal });
globalThis.addEventListener("pointercancel", (event) => {
  endDrag(event.pointerId, true);
  cancelledPointers.delete(event.pointerId);
}, { signal });
globalThis.addEventListener("resize", () => engine.resize(), { signal });
canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  status.textContent =
    "Graphics context paused; Babylon is restoring the view…";
  status.dataset.ready = "false";
}, { signal });
canvas.addEventListener("webglcontextrestored", updateControlState, { signal });

const stops = [
  input.sink((value) => {
    inputValue = value ?? DEFAULT_INPUT;
    renderSafely();
  }),
  state.sink((value) => {
    stateValue = value ?? DEFAULT_STATE;
    renderSafely();
  }),
  output.sink((value) => {
    outputValue = value ?? DEFAULT_OUTPUT;
    renderSafely();
  }),
];

engine.runRenderLoop(() => scene.render());
cameraReadout.textContent = cameraDescription();
canvas.style.cursor = "grab";

function dispose(): void {
  if (disposed) return;
  disposed = true;
  abort.abort();
  if (drag && canvas.hasPointerCapture(drag.pointerId)) {
    canvas.releasePointerCapture(drag.pointerId);
  }
  drag = undefined;
  stops.forEach((stop) => stop());
  if (pointerObserver) scene.onPointerObservable.remove(pointerObserver);
  if (cameraObserver) {
    camera.onViewMatrixChangedObservable.remove(cameraObserver);
  }
  engine.stopRenderLoop();
  scene.dispose();
  engine.dispose();
  fabric.disconnect();
}

globalThis.addEventListener("pagehide", dispose, { once: true, signal });

try {
  await Promise.all([input.pull(), state.pull(), output.pull()]);
  await Promise.all([
    stateWrite.initialize(DEFAULT_STATE),
    outputWrite.initialize(DEFAULT_OUTPUT),
  ]);
  inputValue = input.get() ?? DEFAULT_INPUT;
  stateValue = state.get() ?? DEFAULT_STATE;
  outputValue = output.get() ?? DEFAULT_OUTPUT;
  hydrated = true;
  renderAuthoritativeState();
} catch (cause) {
  showError(cause);
  status.textContent = "The salvage yard could not connect to Fabric.";
  status.dataset.ready = "false";
  dispose();
}
