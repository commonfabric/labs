import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import {
  type GuestPage,
  ManualFrames,
  MemoryCell,
  openGuestPage,
  patchProperty,
} from "../../tools/test-support/iframe-guest.ts";
import {
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeStateData,
  moduleConnectors,
  type StationModule,
  type Vector3Tuple,
} from "./contract.ts";
import { moduleTransformId } from "./model.ts";

const GUEST = new URL("./guest.ts", import.meta.url);
const HTML = new URL("./guest.html", import.meta.url);

const HUB = "module-junction-nine";
const CARGO = "module-cargo-kestrel";
const SOLAR = "module-solar-rig-amber";

//
// WebGL double
//

/**
 * Stands in for a WebGL 1 context, which the simulated document lacks. It
 * accepts every shader and program, ignores the state the renderer sets, and
 * counts the draws, so that a test sees the yard drawn without a GPU.
 */
class WebGLDouble {
  readonly canvas: HTMLCanvasElement;
  draws = 0;
  readonly #linked = Promise.withResolvers<void>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  get drawingBufferWidth(): number {
    return this.canvas.width;
  }

  get drawingBufferHeight(): number {
    return this.canvas.height;
  }

  /** Resolves once the renderer has linked its first shader program. */
  get linked(): Promise<void> {
    return this.#linked.promise;
  }

  drawElements(): void {
    this.draws++;
  }

  linkProgram(): void {
    this.#linked.resolve();
  }

  getParameter(): number {
    return 4096;
  }

  getExtension(): null {
    return null;
  }

  getShaderPrecisionFormat() {
    return { precision: 23, rangeMin: 127, rangeMax: 127 };
  }

  getProgramParameter(): boolean {
    return true;
  }

  getAttribLocation(): number {
    return 0;
  }

  getUniformLocation(): object {
    return {};
  }

  createBuffer(): object {
    return {};
  }

  createProgram(): object {
    return {};
  }

  createShader(): object {
    return {};
  }

  // The state the renderer sets, which nothing reads back.
  attachShader(): void {}
  bindBuffer(): void {}
  blendEquationSeparate(): void {}
  blendFuncSeparate(): void {}
  bufferData(): void {}
  clear(): void {}
  clearColor(): void {}
  clearDepth(): void {}
  clearStencil(): void {}
  colorMask(): void {}
  compileShader(): void {}
  cullFace(): void {}
  deleteBuffer(): void {}
  deleteProgram(): void {}
  deleteShader(): void {}
  depthFunc(): void {}
  depthMask(): void {}
  disable(): void {}
  disableVertexAttribArray(): void {}
  enable(): void {}
  enableVertexAttribArray(): void {}
  frontFace(): void {}
  pixelStorei(): void {}
  shaderSource(): void {}
  stencilFuncSeparate(): void {}
  stencilMask(): void {}
  stencilOpSeparate(): void {}
  uniform1f(): void {}
  uniform2f(): void {}
  uniform3f(): void {}
  uniform4f(): void {}
  uniformMatrix4fv(): void {}
  useProgram(): void {}
  vertexAttribPointer(): void {}
  viewport(): void {}
}

//
// The default orbit camera
//

/** Width and height of the canvas, which the document leaves at its default. */
const WIDTH = 300;
const HEIGHT = 150;

/** The middle of the canvas, where the camera looks at the hub. */
const MIDDLE = { x: WIDTH / 2, y: HEIGHT / 2 };

/** What a move while the primary button is held reports. */
const HELD: PointerEventInit = { buttons: 1 };

/** A point on the canvas over open orbital plane. */
const OPEN_PLANE = { x: 250, y: 75 };

/**
 * Returns the half-meter spot on the orbital plane under the canvas point
 * `x`, `y`, as the default camera sees it: orbiting the point 1.2 m above the
 * origin at 23 m, at an azimuth of −60° and a polar angle of 60°, with a
 * vertical field of view of 0.8 radians.
 */
function groundSpotUnder(x: number, y: number): [number, number] {
  const alpha = -Math.PI / 3;
  const beta = Math.PI / 3;
  const radius = 23;
  const target: Vector3Tuple = [0, 1.2, 0];
  const eye: Vector3Tuple = [
    target[0] + radius * Math.cos(alpha) * Math.sin(beta),
    target[1] + radius * Math.cos(beta),
    target[2] + radius * Math.sin(alpha) * Math.sin(beta),
  ];
  const forward = unit([
    target[0] - eye[0],
    target[1] - eye[1],
    target[2] - eye[2],
  ]);
  const right = unit(cross([0, 1, 0], forward));
  const up = cross(forward, right);
  const halfHeight = Math.tan(0.4);
  const across = (2 * x / WIDTH - 1) * halfHeight * WIDTH / HEIGHT;
  const down = (1 - 2 * y / HEIGHT) * halfHeight;
  const ray = [0, 1, 2].map((axis) =>
    forward[axis] + right[axis] * across + up[axis] * down
  );
  const distance = -eye[1] / ray[1];
  const half = (value: number) => Math.round(value * 2) / 2;
  return [half(eye[0] + ray[0] * distance), half(eye[2] + ray[2] * distance)];
}

function cross(a: Vector3Tuple, b: Vector3Tuple): Vector3Tuple {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function unit(vector: Vector3Tuple): Vector3Tuple {
  const length = Math.hypot(...vector);
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

/** A module of `kind` standing alone at `position`. */
function module(
  id: string,
  kind: StationModule["kind"],
  position: Vector3Tuple,
): StationModule {
  return {
    id,
    label: `Lone ${kind}`,
    kind,
    color: [0.5, 0.5, 0.5],
    transform: { position, rotationQuarterTurns: 0 },
    connectors: moduleConnectors(kind),
  };
}

/** The default assembly holding `modules` instead of its own. */
function stateWith(modules: StationModule[]): IframeStateData {
  return { ...DEFAULT_STATE, modules };
}

/** The default assembly without the module `id`. */
function stateWithout(id: string): IframeStateData {
  return stateWith(DEFAULT_STATE.modules.filter((entry) => entry.id !== id));
}

//
// Tests
//

describe("iframe-orbital-salvage-yard/guest", () => {
  let page: GuestPage | undefined;

  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  /** Builds the yard's resources, holding the default assembly by default. */
  function resources(options: {
    input?: MemoryCell;
    state?: MemoryCell;
    output?: MemoryCell;
  } = {}) {
    const graphics: { context?: WebGLDouble } = {};
    return {
      input: options.input ?? new MemoryCell(
        { title: "Yard C-19", subtitle: "Bring it home." },
        { readonly: true },
      ),
      state: options.state ?? new MemoryCell(DEFAULT_STATE),
      output: options.output ?? new MemoryCell(DEFAULT_OUTPUT),
      frames: new ManualFrames(),
      graphics,
    };
  }

  /**
   * Loads the guest with `parts` into its own document, or into `html`. Its
   * canvas draws on a WebGL double unless `webgl` is false, and its frames
   * run when the test runs them. `watch` runs just before the guest loads.
   */
  function load(
    parts: ReturnType<typeof resources>,
    options: { html?: string; webgl?: boolean; watch?: () => void } = {},
  ): Promise<GuestPage> {
    return openGuestPage({
      guest: GUEST,
      html: options.html ?? HTML,
      resources: {
        input: parts.input.resource(),
        state: parts.state.resource(),
        output: parts.output.resource(),
      },
      setup: () => {
        patchProperty(HTMLCanvasElement.prototype, "getContext", {
          value(this: HTMLCanvasElement, kind: string) {
            if (kind !== "webgl" || options.webgl === false) return null;
            parts.graphics.context ??= new WebGLDouble(this);
            return parts.graphics.context;
          },
        });
        // Babylon asks the canvas's own window for its frames.
        const view = document.defaultView;
        if (!view) throw new Error("The document has no window.");
        Object.defineProperties(view, {
          requestAnimationFrame: { value: parts.frames.request },
          cancelAnimationFrame: { value: parts.frames.cancel },
        });
        options.watch?.();
      },
    });
  }

  /** Opens the yard, in `html` if given, and resolves once it is ready. */
  async function open(
    options: Parameters<typeof resources>[0] & { html?: string } = {},
  ) {
    const parts = resources(options);
    page = await load(parts, { html: options.html });
    const opened = page;
    await opened.until(ready);
    return { page: opened, ...parts };
  }

  function element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const found = document.querySelector<T>(selector);
    if (!found) throw new Error(`Nothing matches \`${selector}\`.`);
    return found;
  }

  function textOf(selector: string): string {
    return element(selector).textContent?.trim() ?? "";
  }

  function status(): HTMLElement {
    return element("#yard-status");
  }

  /** Whether the yard is ready and committing nothing. */
  function ready(): boolean {
    return status().dataset.ready === "true";
  }

  function alertText(): string {
    return textOf("[role=alert]");
  }

  function canvas(): HTMLCanvasElement {
    return element<HTMLCanvasElement>("#scene");
  }

  function button(selector: string): HTMLButtonElement {
    return element<HTMLButtonElement>(selector);
  }

  function manifestButton(moduleId: string): HTMLButtonElement {
    return button(`#module-mirror button[data-module-id="${moduleId}"]`);
  }

  function selectedLabel(): string {
    return textOf("#selected-label");
  }

  function selectedTransform(): string {
    return textOf("#selected-transform");
  }

  function manifest(): string[] {
    return [...document.querySelectorAll("#module-mirror button")].map(
      (item) => item.textContent ?? "",
    );
  }

  function connections(): string[] {
    return [...document.querySelectorAll("#connection-mirror li")].map(
      (item) => item.textContent ?? "",
    );
  }

  /** Changes the value of `control` as a person would. */
  function change(
    control: HTMLInputElement | HTMLSelectElement,
    value: string,
  ): void {
    control.value = value;
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * Sends a mouse's pointer event of `type` to the canvas at `point`. As in a
   * browser, a move changes no button, and a press holds the primary one.
   */
  function pointer(
    type: string,
    point: { x: number; y: number },
    init: PointerEventInit = {},
  ): void {
    canvas().dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        clientX: point.x,
        clientY: point.y,
        pointerId: 1,
        pointerType: "mouse",
        button: type === "pointermove" ? -1 : 0,
        buttons: type === "pointerdown" ? 1 : 0,
        ...init,
      }),
    );
  }

  /**
   * Presses the mouse at `point` on the canvas, having moved it there first
   * as a person does.
   */
  function press(
    point: { x: number; y: number },
    init: PointerEventInit = {},
  ): void {
    pointer("pointermove", point, { ...init, button: -1, buttons: 0 });
    pointer("pointerdown", point, init);
  }

  /** The transform the yard stores for `moduleId` once it is moved by hand. */
  function storedTransform(state: MemoryCell, moduleId: string): unknown {
    const transforms = Reflect.get(Object(state.value), "moduleTransforms");
    return Reflect.get(Object(transforms), moduleTransformId(moduleId));
  }

  describe("startup", () => {
    it("stores the default assembly and preferences on first use", async () => {
      const { state, output } = await open({
        state: new MemoryCell(),
        output: new MemoryCell(),
      });

      expect(state.value).toEqual(DEFAULT_STATE);
      expect(output.value).toEqual(DEFAULT_OUTPUT);
    });

    it("leaves a stored assembly as it is", async () => {
      const { page, state, output } = await open();
      await page.settled();

      expect(state.writes).toEqual([]);
      expect(output.writes).toEqual([]);
    });

    it("shows the title and subtitle the piece was created with", async () => {
      await open();

      expect(textOf("h1")).toBe("Yard C-19");
      expect(textOf(".subtitle")).toBe("Bring it home.");
    });

    it("shows the default title for a piece created without one", async () => {
      await open({ input: new MemoryCell(undefined, { readonly: true }) });

      expect(textOf("h1")).toBe("Orbital Salvage Yard");
    });

    it("lists every module and the interfaces locked between them", async () => {
      await open();

      expect(manifest()).toEqual([
        "Junction Ninehub",
        "Kestrel Cargo Spinecargo",
        "Morrow Habitathabitat",
        "Amber Solar Rigsolar",
      ]);
      expect(textOf("#module-count")).toBe("4");
      expect(textOf("#joint-count")).toBe("3");
      expect(connections()).toEqual([
        "Kestrel Cargo Spine ↔ Junction Nine",
        "Morrow Habitat ↔ Junction Nine",
        "Junction Nine ↔ Amber Solar Rig",
      ]);
    });

    it("says so when no interfaces are locked", async () => {
      await open({
        state: new MemoryCell(stateWith([module("lone", "relay", [0, 1, 0])])),
      });

      expect(textOf("#joint-count")).toBe("0");
      expect(connections()).toEqual(["No interfaces locked."]);
    });

    it("enables the operator kit once it is ready, and not the selection actions", async () => {
      await open();

      expect(status().textContent).toBe(
        "Ready · Fabric is authoritative; Babylon is synchronized.",
      );
      expect(element<HTMLSelectElement>("#tool").disabled).toBe(false);
      expect(button("#reset-camera").disabled).toBe(false);
      expect(button("#rotate-left").disabled).toBe(true);
      expect(button("#bookmark").disabled).toBe(true);
    });

    it("shows the tool and accent the operator chose", async () => {
      await open({
        output: new MemoryCell({
          ...DEFAULT_OUTPUT,
          preferredTool: "inspect",
          accentColor: "#12ab34",
        }),
      });

      expect(element<HTMLSelectElement>("#tool").value).toBe("inspect");
      expect(element<HTMLInputElement>("#accent").value).toBe("#12ab34");
    });

    it("shows the default accent for a stored accent that is not a hex color", async () => {
      await open({
        output: new MemoryCell({ ...DEFAULT_OUTPUT, accentColor: "red" }),
      });

      expect(element<HTMLInputElement>("#accent").value).toBe("#f4b860");
    });

    it("draws the yard on each frame it is given once its shaders are ready", async () => {
      const { frames, graphics } = await open();
      const context = graphics.context;
      if (!context) throw new Error("The yard took no WebGL context.");

      // The first frame asks for the shaders, which Babylon loads on its own.
      frames.run();
      await context.linked;
      const before = context.draws;
      frames.run();
      const once = context.draws;
      frames.run();

      expect(once).toBeGreaterThan(before);
      expect(context.draws - once).toBe(once - before);
      expect(frames.pending).toBe(true);
    });

    it("shows why its renderer could not start, and throws", async () => {
      // The page is gone once loading throws, so this keeps what it showed.
      const shown: string[] = [];
      const watch = () =>
        new MutationObserver(() =>
          shown.push(`${alertText()} | ${status().textContent}`)
        ).observe(document, { childList: true, subtree: true });

      await expect(load(resources(), { webgl: false, watch })).rejects
        .toThrow("WebGL not supported");
      expect(shown.at(-1)).toBe(
        "WebGL not supported | The salvage yard could not start its 3D renderer.",
      );
    });

    it("throws for a document without one of its controls", async () => {
      const html = (await Deno.readTextFile(HTML)).replace(
        '<button id="snap"',
        "<button",
      );

      await expect(load(resources(), { html })).rejects.toThrow(
        "Missing required element #snap.",
      );
    });

    it("shows why it could not load the assembly, keeps its controls off, and stops drawing", async () => {
      const state = new MemoryCell(DEFAULT_STATE);
      state.failReads(new Error("The assembly is unreadable."));
      const parts = resources({ state });
      page = await load(parts);

      expect(alertText()).toBe("The assembly is unreadable.");
      expect(status().textContent).toBe(
        "The salvage yard could not connect to Fabric.",
      );
      expect(button("#reset-camera").disabled).toBe(true);
      expect(manifest()).toEqual([]);
      expect(parts.frames.pending).toBe(false);
    });
  });

  describe("selection", () => {
    it("selects a module picked in the manifest and enables its actions", async () => {
      await open();

      manifestButton(CARGO).click();

      expect(selectedLabel()).toBe("Kestrel Cargo Spine");
      expect(selectedTransform()).toBe(
        "cargo · position 5.0, 1.2, 0.0 · rotation 0° · 2 connectors",
      );
      expect(button("#rotate-left").disabled).toBe(false);
      expect(manifestButton(CARGO).ariaPressed).toBe("true");
      expect(manifestButton(HUB).ariaPressed).toBe("false");
    });

    it("counts a module's single connector without a plural", async () => {
      await open();

      manifestButton(SOLAR).click();

      expect(selectedTransform()).toBe(
        "solar · position -5.0, 1.2, 0.0 · rotation 0° · 1 connector",
      );
    });

    it("selects the module under the pointer in the scene", async () => {
      await open();

      press(MIDDLE);
      pointer("pointerup", MIDDLE);

      expect(selectedLabel()).toBe("Junction Nine");
    });

    it("selects nothing for a press on empty space or with another button", async () => {
      await open();

      press({ x: 2, y: 2 });
      pointer("pointerup", { x: 2, y: 2 });
      press(MIDDLE, { button: 2, buttons: 2 });
      pointer("pointerup", MIDDLE, { button: 2 });

      expect(selectedLabel()).toBe("No module selected");
      expect(selectedTransform()).toBe(
        "Pick a module in the scene or manifest.",
      );
    });

    it("drops the selection when another operator removes the module", async () => {
      const { state, page } = await open();
      manifestButton(CARGO).click();

      state.value = stateWithout(CARGO);
      await page.until(() => selectedLabel() === "No module selected");

      expect(manifest()).not.toContain("Kestrel Cargo Spinecargo");
      expect(textOf("#module-count")).toBe("3");
    });

    it("shows a module another operator rebuilt as another kind", async () => {
      const { state, page } = await open();

      state.value = stateWith(
        DEFAULT_STATE.modules.map((entry) =>
          entry.id === CARGO
            ? { ...entry, kind: "relay", connectors: [] }
            : entry
        ),
      );
      await page.until(() => manifest().includes("Kestrel Cargo Spinerelay"));

      expect(textOf("#joint-count")).toBe("2");
    });

    it("shows an error for a stored assembly it cannot read", async () => {
      const { state, page } = await open();

      state.value = { ...DEFAULT_STATE, modules: "scrap" };
      await page.until(() => alertText() !== "");

      expect(alertText()).toContain("modules");
    });
  });

  describe("moving", () => {
    it("stores the half-meter position a move button gives the selected module", async () => {
      const { state, page } = await open();
      manifestButton(HUB).click();

      button('[data-move="1,0,0"]').click();
      await page.until(() =>
        ready() && selectedTransform().includes("1.0, 1.0")
      );

      expect(storedTransform(state, HUB)).toEqual({
        position: [1, 1, 0],
        rotationQuarterTurns: 0,
      });
      expect(textOf("#joint-count")).toBe("0");
    });

    it("keeps a module at least 0.6 m above the orbital plane", async () => {
      const { state, page } = await open();
      manifestButton(HUB).click();

      button('[data-move="0,-1,0"]').click();
      await page.until(() => selectedTransform().includes("0.0, 0.6, 0.0"));

      expect(storedTransform(state, HUB)).toEqual({
        position: [0, 0.6, 0],
        rotationQuarterTurns: 0,
      });
    });

    it("shows that it is committing a move until the write settles", async () => {
      const { page } = await open();
      manifestButton(HUB).click();

      button('[data-move="1,0,0"]').click();
      await page.until(() => status().dataset.ready === "false");

      expect(status().textContent).toBe("Committing module position…");
      expect(button('[data-move="1,0,0"]').disabled).toBe(true);
      await page.until(() => status().dataset.ready === "true");
      expect(button('[data-move="1,0,0"]').disabled).toBe(false);
    });

    it("stores a quarter turn either way", async () => {
      const { state, page } = await open();
      manifestButton(CARGO).click();

      button("#rotate-left").click();
      await page.until(() =>
        ready() && selectedTransform().includes("rotation 270°")
      );
      button("#rotate-right").click();
      await page.until(() =>
        ready() && selectedTransform().includes("rotation 0°")
      );
      await page.settled();

      expect(storedTransform(state, CARGO)).toEqual({
        position: [5, 1.2, 0],
        rotationQuarterTurns: 0,
      });
      expect(state.writes.map(({ path }) => path.at(-1))).toEqual([
        moduleTransformId(CARGO),
        "rotationQuarterTurns",
        CARGO,
        "rotationQuarterTurns",
        CARGO,
      ]);
    });

    describe("an action queued for a module another operator then removes", () => {
      for (
        const [action, control] of [
          ["move", '[data-move="1,0,0"]'],
          ["turn", "#rotate-right"],
          ["snap", "#snap"],
          ["bookmark", "#bookmark"],
        ]
      ) {
        it(`stores no ${action}, and shows no error`, async () => {
          const opened = await open();
          manifestButton(HUB).click();

          // The tool is stored first, so the removal reaches the yard before
          // the action it queued behind that store runs.
          change(element<HTMLSelectElement>("#tool"), "inspect");
          button(control).click();
          opened.state.value = stateWithout(HUB);
          await opened.page.settled();

          expect(opened.state.writes).toEqual([]);
          expect(opened.output.value).toMatchObject({ bookmarks: {} });
          expect(alertText()).toBe("");
          expect(selectedLabel()).toBe("No module selected");
        });
      }
    });

    it("shows why a move could not be stored", async () => {
      const { state, page } = await open();
      manifestButton(HUB).click();
      state.failWrites(new Error("The yard is read-only."));

      button('[data-move="1,0,0"]').click();
      await page.until(() => alertText() !== "");

      expect(alertText()).toBe("The yard is read-only.");
      expect(selectedTransform()).toContain("position 0.0, 1.2, 0.0");
    });

    it("says so when the selected module is removed before its move is stored", async () => {
      const { state, page } = await open();
      manifestButton(HUB).click();

      button('[data-move="1,0,0"]').click();
      state.value = stateWithout(HUB);
      await page.until(() => alertText() !== "");

      expect(alertText()).toBe("That salvage module is no longer available.");
      await page.settled();
      expect(storedTransform(state, HUB)).toBeUndefined();
    });

    it("says so when the selected module is removed before its turn is stored", async () => {
      const { state, page } = await open();
      manifestButton(HUB).click();

      button("#rotate-right").click();
      state.value = stateWithout(HUB);
      await page.until(() => alertText() !== "");

      expect(alertText()).toBe("That salvage module is no longer available.");
      await page.settled();
      expect(storedTransform(state, HUB)).toBeUndefined();
    });
  });

  describe("dragging", () => {
    it("previews a dragged module under the pointer and stores where it is let go", async () => {
      const { state, page } = await open();
      const [x, z] = groundSpotUnder(OPEN_PLANE.x, OPEN_PLANE.y);

      press(MIDDLE);
      expect(canvas().style.cursor).toBe("grabbing");
      pointer("pointermove", OPEN_PLANE, HELD);
      expect(selectedTransform()).toBe(
        `Dragging preview · position ${x.toFixed(1)}, 1.2, ${
          z.toFixed(1)
        } · release to commit once`,
      );
      expect(canvas().style.cursor).toBe("grabbing");
      await page.settled();
      expect(state.writes).toEqual([]);
      pointer("pointerup", OPEN_PLANE);
      await page.until(() =>
        ready() && storedTransform(state, HUB) !== undefined
      );

      expect(storedTransform(state, HUB)).toEqual({
        position: [x, 1.2, z],
        rotationQuarterTurns: 0,
      });
      expect(selectedTransform()).toContain(
        `position ${x.toFixed(1)}, 1.2, ${z.toFixed(1)}`,
      );
      expect(canvas().style.cursor).toBe("grab");
    });

    it("keeps the preview where it was while the pointer is off the orbital plane", async () => {
      const opened = await open();
      const [x, z] = groundSpotUnder(OPEN_PLANE.x, OPEN_PLANE.y);

      press(MIDDLE);
      pointer("pointermove", OPEN_PLANE, HELD);
      pointer("pointermove", { x: MIDDLE.x, y: 1 }, HELD);
      expect(selectedTransform()).toContain(
        `position ${x.toFixed(1)}, 1.2, ${z.toFixed(1)}`,
      );
      pointer("pointerup", { x: MIDDLE.x, y: 1 });
      await opened.page.until(() =>
        ready() && storedTransform(opened.state, HUB) !== undefined
      );

      expect(storedTransform(opened.state, HUB)).toEqual({
        position: [x, 1.2, z],
        rotationQuarterTurns: 0,
      });
    });

    it("stores nothing for a press let go without moving", async () => {
      const opened = await open();

      press(MIDDLE);
      pointer("pointerup", MIDDLE);
      await opened.page.settled();

      expect(selectedLabel()).toBe("Junction Nine");
      expect(opened.state.writes).toEqual([]);
      expect(canvas().style.cursor).toBe("grab");
    });

    it("puts a module back and stores nothing when its drag is cancelled", async () => {
      const opened = await open();

      press(MIDDLE);
      pointer("pointermove", OPEN_PLANE, HELD);
      pointer("pointercancel", OPEN_PLANE);
      await opened.page.settled();

      expect(opened.state.writes).toEqual([]);
      expect(selectedTransform()).toBe(
        "hub · position 0.0, 1.2, 0.0 · rotation 0° · 4 connectors",
      );
      expect(canvas().style.cursor).toBe("grab");
    });

    it("ignores another finger while a drag is under way", async () => {
      const opened = await open();
      const finger = { pointerId: 2, pointerType: "touch" };

      press(MIDDLE);
      pointer("pointerdown", MIDDLE, finger);
      pointer("pointermove", OPEN_PLANE, { ...finger, buttons: 1 });
      pointer("pointerup", OPEN_PLANE, finger);
      await opened.page.settled();

      expect(selectedTransform()).toBe(
        "hub · position 0.0, 1.2, 0.0 · rotation 0° · 4 connectors",
      );
      expect(canvas().style.cursor).toBe("grabbing");
      expect(opened.state.writes).toEqual([]);
    });

    it("selects without dragging for an operator who prefers to inspect", async () => {
      const opened = await open({
        output: new MemoryCell({ ...DEFAULT_OUTPUT, preferredTool: "inspect" }),
      });

      press(MIDDLE);
      pointer("pointermove", OPEN_PLANE, HELD);
      pointer("pointerup", OPEN_PLANE);
      await opened.page.settled();

      expect(selectedLabel()).toBe("Junction Nine");
      expect(selectedTransform()).toContain("position 0.0, 1.2, 0.0");
      expect(opened.state.writes).toEqual([]);
    });

    it("says so when the dragged module is removed before it is stored", async () => {
      const { state, page } = await open();

      press(MIDDLE);
      pointer("pointermove", OPEN_PLANE, HELD);
      pointer("pointerup", OPEN_PLANE);
      state.value = stateWithout(HUB);
      await page.until(() => alertText() !== "");

      expect(alertText()).toBe("That salvage module is no longer available.");
      await page.settled();
      expect(storedTransform(state, HUB)).toBeUndefined();
    });

    it("lets go of the pointer it captured, and stops drawing, when the page hides", async () => {
      const opened = await open();
      const scene = canvas();

      press(MIDDLE);
      expect(scene.hasPointerCapture(1)).toBe(true);
      page = undefined;
      await opened.page.close();

      expect(scene.hasPointerCapture(1)).toBe(false);
      expect(opened.frames.pending).toBe(false);
    });
  });

  describe("snapping", () => {
    /** Moves the cargo spine 1 m off its lock and snaps it back. */
    async function snapCargo(opened: { state: MemoryCell; page: GuestPage }) {
      manifestButton(CARGO).click();
      button('[data-move="1,0,0"]').click();
      await opened.page.until(() => ready() && textOf("#joint-count") === "2");
      button("#snap").click();
      await opened.page.until(() => ready() && textOf("#joint-count") === "3");
      return opened.state.writes.at(-1);
    }

    it("stores a claim on the nearest free lock and shows the module locked to it", async () => {
      const opened = await open();

      const claim = await snapCargo(opened);

      expect(claim?.path).toEqual(["snapClaims", CARGO]);
      expect(claim?.value).toMatchObject({
        movingConnectorId: "port-lock",
        targetModuleId: HUB,
        targetConnectorId: "east-lock",
      });
      expect(selectedTransform()).toContain("position 5.0, 1.2, 0.0");
    });

    it("moves a snapped module by releasing its claim into a transform of its own", async () => {
      const opened = await open();
      const claim = await snapCargo(opened);
      const claimId = String(Reflect.get(Object(claim?.value), "id"));

      button('[data-move="0,0,1"]').click();
      await opened.page.until(() =>
        ready() && selectedTransform().includes("5.0, 1.0, 1.0")
      );

      expect(opened.state.writes.at(-1)?.path).toEqual([
        "releasedSnapClaims",
        claimId,
      ]);
      expect(textOf("#joint-count")).toBe("2");
    });

    it("says so when no compatible lock is near enough", async () => {
      const { state, page } = await open({
        state: new MemoryCell(stateWith([
          module("near", "hub", [0, 1.2, 0]),
          module("far", "relay", [30, 1.2, 30]),
        ])),
      });
      manifestButton("far").click();

      button("#snap").click();
      await page.until(() => alertText() !== "");

      expect(alertText()).toBe(
        "Move this module within 4.5 meters of a compatible lock.",
      );
      await page.settled();
      expect(state.writes).toEqual([]);
    });

    it("says so when the selected module is removed before its snap is stored", async () => {
      const { state, page } = await open();
      manifestButton(CARGO).click();

      button("#snap").click();
      state.value = stateWithout(CARGO);
      await page.until(() => alertText() !== "");

      expect(alertText()).toBe("That salvage module is no longer available.");
      await page.settled();
      expect(state.writes).toEqual([]);
    });
  });

  describe("recovering modules", () => {
    for (
      const [kind, name] of [
        ["cargo", "Cargo spine"],
        ["habitat", "Habitat canister"],
        ["solar", "Solar rig"],
        ["relay", "Relay mast"],
        ["hub", "Junction hub"],
      ]
    ) {
      it(`adds a ${kind} module and selects it`, async () => {
        const { state, page } = await open();

        button(`[data-add-kind="${kind}"]`).click();
        await page.until(() => selectedLabel() !== "No module selected");
        await page.settled();

        expect(state.writes.map(({ operation, path }) => [operation, path]))
          .toEqual([["push", ["modules"]]]);
        expect(textOf("#module-count")).toBe("5");
        expect(selectedLabel().startsWith(`${name} · `)).toBe(true);
        expect(manifest().at(-1)?.endsWith(kind)).toBe(true);
      });
    }

    it("shows why a module could not be added, and selects nothing", async () => {
      const { state, page } = await open();
      state.failWrites(new Error("The yard is full."));

      button('[data-add-kind="cargo"]').click();
      await page.until(() => alertText() !== "");

      expect(alertText()).toBe("The yard is full.");
      expect(textOf("#module-count")).toBe("4");
      state.value = stateWith([
        ...DEFAULT_STATE.modules,
        module("late", "relay", [20, 1.2, 20]),
      ]);
      await page.until(() => textOf("#module-count") === "5");
      expect(selectedLabel()).toBe("No module selected");
    });
  });

  describe("preferences", () => {
    it("bookmarks the selected module for this operator, and removes the bookmark", async () => {
      const { output, page } = await open();
      manifestButton(CARGO).click();

      button("#bookmark").click();
      await page.until(() =>
        ready() && button("#bookmark").textContent === "Remove bookmark"
      );

      expect(output.value).toMatchObject({ bookmarks: { [CARGO]: true } });
      expect(manifest()).toContain("★ Kestrel Cargo Spinecargo");

      button("#bookmark").click();
      await page.until(() => button("#bookmark").textContent === "Bookmark");

      expect(output.value).toMatchObject({ bookmarks: { [CARGO]: false } });
      expect(manifest()).toContain("Kestrel Cargo Spinecargo");
    });

    it("stores the tool the operator prefers", async () => {
      const { output, page } = await open();

      change(element<HTMLSelectElement>("#tool"), "inspect");
      await page.until(() => output.writes.length > 0);
      await page.settled();

      expect(output.writes).toEqual([
        { operation: "set", path: ["preferredTool"], value: "inspect" },
      ]);
    });

    it("stores the accent the operator chooses", async () => {
      const { output, page } = await open();

      change(element<HTMLInputElement>("#accent"), "#00ff88");
      await page.until(() => output.writes.length > 0);
      await page.settled();

      expect(output.writes).toEqual([
        { operation: "set", path: ["accentColor"], value: "#00ff88" },
      ]);
    });
  });

  describe("camera", () => {
    it("describes the camera after the wheel zooms it, and puts it back on reset", async () => {
      const { frames, page } = await open();

      canvas().dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaY: 1000 }),
      );
      frames.run();
      await page.until(() =>
        textOf("#camera-readout") !== "Orbit 23.0 m · azimuth -60°"
      );
      expect(textOf("#camera-readout")).toMatch(/^Orbit \d+\.\d m/);

      button("#reset-camera").click();
      frames.run();
      await page.until(() =>
        textOf("#camera-readout") === "Orbit 23.0 m · azimuth -60°"
      );
    });

    it("sizes its drawing buffer to the canvas when the window resizes", async () => {
      await open();
      Object.defineProperties(canvas(), {
        clientWidth: { value: 640 },
        clientHeight: { value: 480 },
      });

      dispatchEvent(new Event("resize"));

      expect([canvas().width, canvas().height]).toEqual([640, 480]);
    });

    it("says it is restoring the view while the graphics context is lost", async () => {
      await open();
      const lost = new Event("webglcontextlost", { cancelable: true });

      canvas().dispatchEvent(lost);

      expect(lost.defaultPrevented).toBe(true);
      expect(status().textContent).toBe(
        "Graphics context paused; Babylon is restoring the view…",
      );
      expect(status().dataset.ready).toBe("false");
    });
  });
});
