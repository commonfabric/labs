import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import {
  GuestLoadError,
  type GuestPage,
  ManualFrames,
  MemoryCell,
  openGuestPage,
  patchProperty,
} from "../../tools/test-support/iframe-guest.ts";
import {
  type CrewTool,
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeInputData,
  type IframeOutputData,
  type SimulationAction,
} from "./contract.ts";
import {
  describeTile,
  reduceSimulation,
  type TileState,
} from "./simulation.ts";

const GUEST = new URL("./guest.ts", import.meta.url);
const HTML = new URL("./guest.html", import.meta.url);

/** The per-user instance the output cell resolves to: this player's crew. */
const CREW_ID = "crew-ada";

/** The side of a map tile, in canvas pixels. */
const TILE_SIZE = 64;

/** The default board, before anyone acts. */
const BOARD = reduceSimulation(DEFAULT_INPUT, []);

/** Returns the first tile of the default board that satisfies `test`. */
function tileWhere(test: (tile: TileState) => boolean): TileState {
  const tile = BOARD.tiles.find(test);
  if (!tile) throw new Error("The default board has no such tile.");
  return tile;
}

const BURNING = tileWhere((tile) => tile.fire > 0);
const OTHER_BURNING = tileWhere((tile) => tile.fire > 0 && tile !== BURNING);
const WATER = tileWhere((tile) => tile.terrain === "water");
const SETTLEMENT = tileWhere((tile) => tile.terrain === "settlement");
const BUILDABLE = tileWhere((tile) =>
  tile.fire === 0 && (tile.terrain === "forest" || tile.terrain === "grass")
);

/** How the log names `tile`. */
function position(tile: TileState): string {
  return `column ${tile.x + 1}, row ${tile.y + 1}`;
}

/** How the board labels `tile` when `symbol` is on it. */
function label(tile: TileState, symbol: string): string {
  return `${tile.x + 1},${tile.y + 1} ${symbol}`.trim();
}

/** Returns a crew's deployment of `type` on the tile `tileId` in turn 1. */
function deployment(
  id: string,
  actorId: string,
  type: CrewTool,
  tileId: string,
): SimulationAction {
  return { id, actorId, turn: 1, type, tileId };
}

/** Returns a crew's advance of turn 1. */
function advance(id: string, actorId: string): SimulationAction {
  return { id, actorId, turn: 1, type: "advance-turn" };
}

/** A crew someone saved before, using the evacuate tool. */
const LADDER: IframeOutputData = {
  crew: { name: "Ladder 9", color: "violet", preferredTool: "evacuate" },
};

//
// Canvas doubles
//

/** One fill or stroke on the map, in the style in effect, at its middle. */
interface Mark {
  style: string;
  alpha: number;
  width: number;
  x: number;
  y: number;
}

/**
 * Stands in for every canvas's 2D drawing context, accepting each call
 * Phaser's canvas renderer makes. It records what the map's canvas fills and
 * strokes, at the translation in effect, and the text written on any canvas,
 * since Phaser writes each label on a canvas of its own. While it has a
 * failure, it throws that instead.
 */
class Drawing {
  readonly fills: Mark[] = [];
  readonly strokes: Mark[] = [];
  readonly texts: string[] = [];
  failure: Error | undefined;
  readonly #contexts = new WeakMap<HTMLCanvasElement, object>();

  /** Forgets what was drawn so far. */
  reset(): void {
    this.fills.length = 0;
    this.strokes.length = 0;
    this.texts.length = 0;
  }

  /** Returns the drawing context of `canvas`, as `getContext("2d")` does. */
  context(canvas: HTMLCanvasElement): object {
    if (this.failure) throw this.failure;
    const known = this.#contexts.get(canvas);
    if (known) return known;
    const context = this.#create(canvas);
    this.#contexts.set(canvas, context);
    return context;
  }

  #create(canvas: HTMLCanvasElement): object {
    const fields: Record<PropertyKey, unknown> = {
      canvas,
      fillStyle: "#000000",
      strokeStyle: "#000000",
      globalAlpha: 1,
      lineWidth: 1,
    };
    let x = 0;
    let y = 0;
    const onMap = () => canvas.parentElement?.id === "game";
    const mark = (style: unknown, width: unknown): Mark => ({
      style: String(style),
      alpha: Number(fields.globalAlpha),
      width: Number(width),
      x,
      y,
    });
    const pixels = (width: number, height: number) => ({
      data: new Uint8ClampedArray(Math.max(1, width * height) * 4),
      width,
      height,
    });
    const gradient = () => ({ addColorStop: () => {} });
    const methods = {
      setTransform: (
        _a: number,
        _b: number,
        _c: number,
        _d: number,
        e: number,
        f: number,
      ) => {
        x = e;
        y = f;
      },
      fillRect: () => {
        if (onMap()) this.fills.push(mark(fields.fillStyle, 0));
      },
      stroke: () => {
        if (onMap()) {
          this.strokes.push(mark(fields.strokeStyle, fields.lineWidth));
        }
      },
      fillText: (text: string) => {
        this.texts.push(text);
      },
      measureText: (text: string) => ({
        width: text.length * 7,
        actualBoundingBoxAscent: 9,
        actualBoundingBoxDescent: 3,
      }),
      getImageData: (_x: number, _y: number, width: number, height: number) =>
        pixels(width, height),
      createImageData: pixels,
      createLinearGradient: gradient,
      createRadialGradient: gradient,
      createPattern: () => ({}),
    };
    return new Proxy(fields, {
      get: (target, name) => {
        if (name in target) return target[name];
        const method = Reflect.get(methods, name);
        return (...args: unknown[]) => {
          if (this.failure) throw this.failure;
          return method ? Reflect.apply(method, undefined, args) : undefined;
        };
      },
      set: (target, name, value) => {
        target[name] = value;
        return true;
      },
    });
  }
}

//
// Tests
//

describe("guest", () => {
  let page: GuestPage | undefined;

  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  /** Returns the prototype in the chain of `prototype` that defines `src`. */
  function sourceOwner(prototype: object): object {
    if (Object.hasOwn(prototype, "src")) return prototype;
    const parent = Object.getPrototypeOf(prototype);
    if (!parent) throw new Error("No prototype defines `src`.");
    return sourceOwner(parent);
  }

  /**
   * Opens the drill, by default on the default board with an empty log and
   * the default crew, drawing on `drawing`.
   */
  async function open(options: {
    input?: IframeInputData;
    state?: MemoryCell;
    output?: MemoryCell;
    html?: string;
    drawing?: Drawing;
  } = {}) {
    const input = new MemoryCell(options.input ?? DEFAULT_INPUT, {
      readonly: true,
    });
    const state = options.state ?? new MemoryCell(DEFAULT_STATE);
    const output = options.output ??
      new MemoryCell(DEFAULT_OUTPUT, {
        identity: { id: "output", instanceId: CREW_ID },
      });
    const drawing = options.drawing ?? new Drawing();
    const frames = new ManualFrames();
    page = await openGuestPage({
      guest: GUEST,
      html: options.html ?? HTML,
      resources: {
        input: input.resource(),
        state: state.resource(),
        output: output.resource(),
      },
      globals: {
        // Phaser draws on a canvas only where it finds the class of a 2D
        // drawing context.
        CanvasRenderingContext2D: Drawing,
        requestAnimationFrame: frames.request,
        cancelAnimationFrame: frames.cancel,
      },
      setup: () => {
        patchProperty(HTMLCanvasElement.prototype, "getContext", {
          value(this: HTMLCanvasElement, kind: string) {
            return kind === "2d" ? drawing.context(this) : null;
          },
        });
        // Every element is laid out at the default map's size, so the map's
        // canvas is shown at its own size and a click lands on the pixel it
        // names.
        const width = DEFAULT_INPUT.columns * TILE_SIZE;
        const height = DEFAULT_INPUT.rows * TILE_SIZE;
        patchProperty(HTMLElement.prototype, "getBoundingClientRect", {
          value: () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: width,
            bottom: height,
            width,
            height,
          }),
        });
        // An image loads from its source after the script that set it runs
        // on, as it does in a browser, rather than at once.
        const image = sourceOwner(Image.prototype);
        const source = Object.getOwnPropertyDescriptor(image, "src");
        const setSource = source?.set;
        if (!setSource) throw new Error("An image's `src` cannot be set.");
        patchProperty(image, "src", {
          get: source?.get,
          set(this: HTMLImageElement, value: string) {
            queueMicrotask(() => Reflect.apply(setSource, this, [value]));
          },
        });
      },
    });
    return { page, input, state, output, drawing, frames };
  }

  /** Opens the drill as {@link open} does, and resolves once it is ready. */
  async function load(options: Parameters<typeof open>[0] = {}) {
    const opened = await open(options);
    await opened.page.until(() => app().dataset.ready === "true");
    return opened;
  }

  function one<T extends Element = HTMLElement>(selector: string): T {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`Nothing matches \`${selector}\`.`);
    return element;
  }

  function byId<T extends Element = HTMLElement>(id: string): T {
    return one<T>(`#${id}`);
  }

  function app(): HTMLElement {
    return byId("firebreak-app");
  }

  function text(id: string): string {
    return byId(id).textContent?.trim() ?? "";
  }

  function button(id: string): HTMLButtonElement {
    return byId<HTMLButtonElement>(id);
  }

  function field(id: string): HTMLInputElement | HTMLSelectElement {
    return byId<HTMLInputElement | HTMLSelectElement>(id);
  }

  function pressed(element: Element): string | null {
    return element.getAttribute("aria-pressed");
  }

  function toolButton(tool: string): HTMLButtonElement {
    return one<HTMLButtonElement>(`[data-tool="${tool}"]`);
  }

  function viewButton(view: string): HTMLButtonElement {
    return one<HTMLButtonElement>(`[data-view="${view}"]`);
  }

  function mirrorTiles(): HTMLButtonElement[] {
    return [...document.querySelectorAll<HTMLButtonElement>(".mirror-tile")];
  }

  function mirrorTile(tile: TileState): HTMLButtonElement {
    return one<HTMLButtonElement>(`.mirror-tile[data-tile-id="${tile.id}"]`);
  }

  function log(): string[] {
    return [...byId("action-log").querySelectorAll("li")].map((item) =>
      item.textContent ?? ""
    );
  }

  /** Changes a crew profile field as a player typing or choosing would. */
  function edit(id: string, value: string): void {
    const control = field(id);
    control.value = value;
    control.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function mapCanvas(): HTMLCanvasElement | null {
    return byId("game").querySelector("canvas");
  }

  /** Where the middle of `tile` is on the map's canvas. */
  function middle(tile: Pick<TileState, "x" | "y">) {
    return {
      x: tile.x * TILE_SIZE + TILE_SIZE / 2,
      y: tile.y * TILE_SIZE + TILE_SIZE / 2,
    };
  }

  /** Clicks the map's canvas at `point`. */
  function clickMap(point: { x: number; y: number }): void {
    for (const type of ["mousedown", "mouseup"]) {
      const event = new MouseEvent(type, {
        bubbles: true,
        clientX: point.x,
        clientY: point.y,
      });
      // The simulated document leaves out where on the page a click lands.
      Object.defineProperties(event, {
        pageX: { value: point.x },
        pageY: { value: point.y },
      });
      mapCanvas()?.dispatchEvent(event);
    }
  }

  /** The marks in `marks` made at the middle of `tile`. */
  function marksAt(marks: Mark[], tile: TileState): Mark[] {
    const { x, y } = middle(tile);
    return marks.filter((mark) => mark.x === x && mark.y === y);
  }

  /** Runs one frame, keeping only what it drew. */
  function drawFrame(
    parts: { drawing: Drawing; frames: ManualFrames },
  ): void {
    parts.drawing.reset();
    parts.frames.run();
  }

  describe("loading", () => {
    it("shows the drill, its counts, and the crew once it is ready", async () => {
      await load();

      expect(text("title")).toBe(DEFAULT_INPUT.title);
      expect(text("briefing")).toBe(DEFAULT_INPUT.briefing);
      expect(text("sync-status")).toBe("Ready · Commons crew");
      expect(text("turn")).toBe("1 / 12");
      expect(text("active-fire")).toBe("3");
      expect(text("evacuated")).toBe("0");
      expect(text("lost")).toBe("0");
      expect(text("outcome")).toBe("Responding");
      expect(field("crew-name").value).toBe("Commons crew");
      expect(field("crew-color").value).toBe("amber");
      expect(field("preferred-tool").value).toBe("water");
      expect(pressed(toolButton("water"))).toBe("true");
      expect(pressed(toolButton("firebreak"))).toBe("false");
      expect(pressed(viewButton("response"))).toBe("true");
      expect(log()).toEqual(["No deployments yet."]);
      expect(text("selected-tile")).toBe("Select a map tile.");
      expect(button("advance").disabled).toBe(false);
      expect(button("save-profile").disabled).toBe(false);
      expect(button("deploy").disabled).toBe(true);
      expect(text("deploy")).toBe("Deploy water");
    });

    it("lays out a button for every tile of the board", async () => {
      await load();

      expect(mirrorTiles()).toHaveLength(63);
      expect(mirrorTiles().every((tile) => !tile.disabled)).toBe(true);
      expect(byId("board-mirror").style.gridTemplateColumns).toBe(
        "repeat(9, minmax(0, 1fr))",
      );
      expect(mirrorTile(BURNING).getAttribute("aria-label")).toBe(
        describeTile(BURNING, 1),
      );
      expect(mirrorTile(BURNING).dataset.fire).toBe("true");
      expect(mirrorTile(BUILDABLE).dataset.fire).toBe("false");
    });

    it("stores an empty log and the default crew when the cells hold none", async () => {
      const state = new MemoryCell();
      const output = new MemoryCell(undefined, {
        identity: { id: "output", instanceId: CREW_ID },
      });

      const { page } = await load({ state, output });
      await page.settled();

      expect(state.writes).toEqual([
        { operation: "initialize", path: [], value: DEFAULT_STATE },
      ]);
      expect(output.writes).toEqual([
        { operation: "initialize", path: [], value: DEFAULT_OUTPUT },
      ]);
    });

    it("keeps the stored crew and selects its preferred tool", async () => {
      const state = new MemoryCell(DEFAULT_STATE);
      const output = new MemoryCell(LADDER, {
        identity: { id: "output", instanceId: CREW_ID },
      });

      const { page } = await load({ state, output });
      await page.settled();

      expect(state.writes).toEqual([]);
      expect(output.writes).toEqual([]);
      expect(text("sync-status")).toBe("Ready · Ladder 9");
      expect(app().dataset.crewColor).toBe("violet");
      expect(text("deploy")).toBe("Deploy evacuate");
      expect(pressed(toolButton("evacuate"))).toBe("true");
      expect(pressed(toolButton("water"))).toBe("false");
    });

    it("stops with an error when the crew has no per-user identity", async () => {
      const { page, frames } = await open({
        output: new MemoryCell(DEFAULT_OUTPUT),
      });
      await page.until(() => text("error") !== "");

      expect(text("error")).toBe(
        "Firebreak Commons needs a stable PerUser crew identity.",
      );
      expect(app().dataset.ready).toBe("false");
      expect(text("sync-status")).toBe("Synchronizing commons");
      expect(button("advance").disabled).toBe(true);
      expect(mirrorTiles().every((tile) => tile.disabled)).toBe(true);
      expect(mapCanvas()).not.toBeNull();

      // The map goes at the next frame.
      frames.run();

      expect(mapCanvas()).toBeNull();
    });

    it("fails to load a document that lacks part of the drill", async () => {
      const html = (await Deno.readTextFile(HTML)).replace(
        'id="action-log"',
        'id="history"',
      );

      await expect(open({ html })).rejects.toThrow(
        "Firebreak Commons is missing #action-log.",
      );
    });

    it("says the map could not start when the canvas cannot draw", async () => {
      // Phaser checks once, as it loads, that a canvas can draw, so a page
      // that draws loads it first.
      await load();
      await page?.close();
      page = undefined;
      const drawing = new Drawing();
      drawing.failure = new Error("The canvas has no drawing context.");

      const failure = await open({ drawing }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(GuestLoadError);
      if (!(failure instanceof GuestLoadError)) return;
      expect(failure.message).toBe("The canvas has no drawing context.");
      expect(failure.text).toContain("The wildfire map could not start.");
      expect(failure.alarms).toMatchObject([{
        description: "The canvas has no drawing context.",
        source: "iframe-firebreak-commons",
      }]);
    });
  });

  describe("the board", () => {
    it("labels each tile with its coordinates and what is on it", async () => {
      await load();

      expect(mirrorTile(BURNING).textContent).toBe(label(BURNING, "F2"));
      expect(mirrorTile(WATER).textContent).toBe(label(WATER, "WATER"));
      expect(mirrorTile(SETTLEMENT).textContent).toBe(
        label(SETTLEMENT, `P${SETTLEMENT.residents}`),
      );
      expect(mirrorTile(BUILDABLE).textContent).toBe(label(BUILDABLE, ""));
      expect(mirrorTile(SETTLEMENT).dataset.residents).toBe(
        String(SETTLEMENT.residents),
      );
    });

    it("marks watered tiles, firebreaks, and cleared settlements", async () => {
      await load({
        state: new MemoryCell({
          actions: [
            deployment("a", "crew-10001", "water", BURNING.id),
            deployment("b", "crew-10002", "firebreak", BUILDABLE.id),
            deployment("c", "crew-10003", "evacuate", SETTLEMENT.id),
          ],
        }),
      });

      expect(mirrorTile(BURNING).textContent).toBe(label(BURNING, "WET"));
      expect(mirrorTile(BUILDABLE).textContent).toBe(label(BUILDABLE, "BREAK"));
      expect(mirrorTile(SETTLEMENT).textContent).toBe(
        label(SETTLEMENT, "CLEAR"),
      );
      expect(mirrorTile(SETTLEMENT).dataset.residents).toBe("0");
      expect(text("active-fire")).toBe("2");
      expect(text("evacuated")).toBe(String(SETTLEMENT.residents));
    });

    it("rebuilds the board when the drill's size changes", async () => {
      const { input, page } = await load();
      const corner = tileWhere((tile) => tile.x === 8 && tile.y === 6);
      mirrorTile(corner).click();
      expect(text("selected-tile")).toBe(describeTile(corner, 1));

      input.value = { ...DEFAULT_INPUT, title: "Ridge drill", columns: 5 };
      await page.until(() => text("title") === "Ridge drill");

      expect(mirrorTiles()).toHaveLength(35);
      expect(document.querySelector(`[data-tile-id="${corner.id}"]`))
        .toBeNull();
      expect(byId("board-mirror").style.gridTemplateColumns).toBe(
        "repeat(5, minmax(0, 1fr))",
      );
      expect(text("selected-tile")).toBe("Select a map tile.");
      expect(mapCanvas()?.width).toBe(5 * TILE_SIZE);
    });

    it("declares the drill contained once every fire is out", async () => {
      const input = { ...DEFAULT_INPUT, initialFireCount: 1 };
      const fire = tileWhere((tile) =>
        reduceSimulation(input, []).tiles.some((burning) =>
          burning.fire > 0 && burning.id === tile.id
        )
      );
      await load({
        input,
        state: new MemoryCell({
          actions: [deployment("a", "crew-10001", "water", fire.id)],
        }),
      });
      mirrorTile(BUILDABLE).click();

      expect(text("outcome")).toBe("Contained");
      expect(app().dataset.status).toBe("contained");
      expect(button("advance").disabled).toBe(true);
      expect(button("deploy").disabled).toBe(true);
    });

    it("declares the drill overrun once its turns run out", async () => {
      await load({
        input: { ...DEFAULT_INPUT, maximumTurns: 1 },
        state: new MemoryCell({ actions: [advance("a", "crew-10001")] }),
      });

      expect(text("outcome")).toBe("Overrun");
      expect(text("turn")).toBe("2 / 1");
      expect(button("advance").disabled).toBe(true);
    });
  });

  describe("the log", () => {
    it("names each crew's latest eight intents, newest first", async () => {
      await load({
        state: new MemoryCell({
          actions: [
            deployment("a1", "crew-10001", "water", BURNING.id),
            deployment("a2", "crew-10002", "firebreak", BUILDABLE.id),
            deployment("a3", "crew-10003", "evacuate", SETTLEMENT.id),
            deployment("a4", "crew-10004", "water", WATER.id),
            deployment("a5", "crew-10005", "firebreak", OTHER_BURNING.id),
            deployment("a6", "crew-10006", "evacuate", BUILDABLE.id),
            advance("a7", "crew-10007"),
            advance("a8", "crew-10008"),
            deployment("a9", "crew-10009", "water", "tile-99-99"),
          ],
        }),
      });

      expect(log()).toEqual([
        "Rejected · Crew 10008 tried to advance turn 1.",
        "Crew 10007 advanced turn 1.",
        `Rejected · Crew 10006 tried to evacuate ${position(BUILDABLE)}.`,
        `Crew 10003 evacuated ${position(SETTLEMENT)}.`,
        `Rejected · Crew 10005 tried to cut a firebreak at ${
          position(OTHER_BURNING)
        }.`,
        `Crew 10002 cut a firebreak at ${position(BUILDABLE)}.`,
        "Rejected · Crew 10009 tried to send water to tile-99-99.",
        `Rejected · Crew 10004 tried to send water to ${position(WATER)}.`,
      ]);
    });
  });

  describe("deploying a crew", () => {
    it("enables deployment once the player selects a tile", async () => {
      await load();

      mirrorTile(BURNING).click();

      expect(pressed(mirrorTile(BURNING))).toBe("true");
      expect(pressed(mirrorTile(BUILDABLE))).toBe("false");
      expect(text("selected-tile")).toBe(describeTile(BURNING, 1));
      expect(button("deploy").disabled).toBe(false);
    });

    const deployments = [
      { tool: "water", tile: BURNING, verb: "sent water to", symbol: "WET" },
      {
        tool: "firebreak",
        tile: BUILDABLE,
        verb: "cut a firebreak at",
        symbol: "BREAK",
      },
      {
        tool: "evacuate",
        tile: SETTLEMENT,
        verb: "evacuated",
        symbol: "CLEAR",
      },
    ] satisfies {
      tool: CrewTool;
      tile: TileState;
      verb: string;
      symbol: string;
    }[];
    for (const { tool, tile, verb, symbol } of deployments) {
      it(`commits a ${tool} deployment to the shared log`, async () => {
        const { page, state } = await load();
        toolButton(tool).click();
        expect(text("deploy")).toBe(`Deploy ${tool}`);
        mirrorTile(tile).click();
        const write = state.nextWrite();

        button("deploy").click();

        expect(text("sync-status")).toBe(`Committing ${tool} deployment`);
        expect(button("advance").disabled).toBe(true);
        expect(mirrorTile(tile).disabled).toBe(true);
        expect(await write).toEqual({
          operation: "push",
          path: ["actions"],
          value: [{
            id: expect.any(String),
            actorId: CREW_ID,
            turn: 1,
            type: tool,
            tileId: tile.id,
          }],
        });
        await page.until(() => text("sync-status") === "Ready · Commons crew");
        expect(log()).toEqual([`Commons crew ${verb} ${position(tile)}.`]);
        expect(mirrorTile(tile).textContent).toBe(label(tile, symbol));
        expect(text("deploy")).toBe("Crew deployed this turn");
        expect(button("deploy").disabled).toBe(true);
        expect(button("advance").disabled).toBe(false);
        expect(text("error")).toBe("");
      });
    }

    it("tells the player when the board rejects the deployment", async () => {
      const { page, state } = await load();
      toolButton("firebreak").click();
      mirrorTile(BURNING).click();

      button("deploy").click();
      await page.until(() => text("error") !== "");
      await page.settled();

      expect(text("error")).toBe(
        "That deployment is no longer valid on the shared board. Choose another action.",
      );
      expect(text("sync-status")).toBe("Action needs attention");
      expect(state.writes).toHaveLength(1);
      expect(log()).toEqual([
        `Rejected · Commons crew tried to cut a firebreak at ${
          position(BURNING)
        }.`,
      ]);
      expect(text("deploy")).toBe("Deploy firebreak");
      expect(button("deploy").disabled).toBe(false);
    });

    it("tells the player when the shared log loses the deployment", async () => {
      const { page, state } = await load();
      mirrorTile(BURNING).click();
      const write = state.nextWrite();

      button("deploy").click();
      await write;
      // Another writer empties the log before the guest reads it back.
      state.value = DEFAULT_STATE;
      await page.until(() => text("error") !== "");

      expect(text("error")).toBe(
        "The shared simulation has not accepted that action yet.",
      );
      expect(log()).toEqual(["No deployments yet."]);
    });

    it("shows the log's refusal until the player picks another tile", async () => {
      const { page, state } = await load();
      state.failWrites(new Error("The commons log is read-only."));
      mirrorTile(BURNING).click();

      button("deploy").click();
      await page.until(() => text("error") !== "");

      expect(text("error")).toContain("The commons log is read-only.");
      expect(text("sync-status")).toBe("Action needs attention");
      expect(log()).toEqual(["No deployments yet."]);

      mirrorTile(OTHER_BURNING).click();

      expect(text("error")).toBe("");
      expect(text("sync-status")).toBe("Ready · Commons crew");
    });
  });

  describe("advancing the wildfire", () => {
    it("advances the shared turn and spreads the fire", async () => {
      const { page, state } = await load();
      const write = state.nextWrite();

      button("advance").click();

      expect(text("sync-status")).toBe("Advancing the shared wildfire");
      expect(button("deploy").disabled).toBe(true);
      expect(await write).toEqual({
        operation: "push",
        path: ["actions"],
        value: [{
          id: expect.any(String),
          actorId: CREW_ID,
          turn: 1,
          type: "advance-turn",
        }],
      });
      await page.until(() => text("sync-status") === "Ready · Commons crew");
      const advanced = reduceSimulation(DEFAULT_INPUT, [advance("a", CREW_ID)]);
      expect(text("turn")).toBe("2 / 12");
      expect(text("active-fire")).toBe(String(advanced.activeFireCount));
      expect(text("lost")).toBe(String(advanced.lostResidentCount));
      expect(log()).toEqual(["Commons crew advanced turn 1."]);
    });

    it("tells the player when another crew advanced the turn first", async () => {
      const { page, state } = await load();

      button("advance").click();
      // Another crew's advance lands first, under an ID that sorts first.
      state.value = { actions: [advance("0", "crew-10007")] };
      await page.until(() => text("error") !== "");

      expect(text("error")).toBe(
        "Another crew advanced this turn first. Review the shared board and try again.",
      );
      expect(text("turn")).toBe("2 / 12");
      expect(log()).toEqual([
        "Rejected · Commons crew tried to advance turn 1.",
        "Crew 10007 advanced turn 1.",
      ]);
    });
  });

  describe("the crew profile", () => {
    it("saves the crew's name, color, and tool for this player", async () => {
      const { page, output } = await load();
      edit("crew-name", "  Ladder 9  ");
      edit("crew-color", "violet");
      edit("preferred-tool", "evacuate");
      const write = output.nextWrite();

      button("save-profile").click();

      expect(text("sync-status")).toBe("Saving crew profile");
      expect(await write).toEqual({
        operation: "set",
        path: ["crew"],
        value: LADDER.crew,
      });
      await page.until(() => text("sync-status") === "Ready · Ladder 9");
      expect(app().dataset.crewColor).toBe("violet");
      expect(field("crew-name").value).toBe("Ladder 9");
    });

    it("refuses a crew without a name until the player edits it", async () => {
      const { page, output } = await load();
      edit("crew-name", "   ");

      button("save-profile").click();
      await page.settled();

      expect(text("error")).toBe("Give your crew a name.");
      expect(text("sync-status")).toBe("Action needs attention");
      expect(output.writes).toEqual([]);

      edit("crew-name", "Ladder 9");

      expect(text("error")).toBe("");
      expect(text("sync-status")).toBe("Ready · Commons crew");
    });

    it("shows a crew changed elsewhere", async () => {
      const { page, output } = await load();

      output.value = LADDER;
      await page.until(() => text("sync-status") === "Ready · Ladder 9");

      expect(field("crew-name").value).toBe("Ladder 9");
      expect(field("crew-color").value).toBe("violet");
      expect(field("preferred-tool").value).toBe("evacuate");
    });

    it("keeps the player's unsaved edits when the crew changes elsewhere", async () => {
      const { page, output } = await load();
      edit("crew-name", "Hotshots");

      output.value = LADDER;
      await page.until(() => text("sync-status") === "Ready · Ladder 9");

      expect(field("crew-name").value).toBe("Hotshots");
      expect(field("crew-color").value).toBe("amber");
    });

    it("shows the profile's refusal to save", async () => {
      const { page, output } = await load();
      output.failWrites(new Error("The crew profile is read-only."));

      button("save-profile").click();
      await page.until(() => text("error") !== "");

      expect(text("error")).toContain("The crew profile is read-only.");
      expect(text("sync-status")).toBe("Action needs attention");
    });
  });

  describe("the map", () => {
    it("labels itself with the turn and the fires burning", async () => {
      const { page, state } = await load();

      expect(byId("game").getAttribute("aria-label")).toBe(
        "Wildfire map, turn 1, 3 active fire tiles",
      );

      state.value = { actions: [advance("a", "crew-10001")] };
      await page.until(() => text("turn") === "2 / 12");

      expect(byId("game").getAttribute("aria-label")).toBe(
        `Wildfire map, turn 2, ${text("active-fire")} active fire tiles`,
      );
    });

    it("writes each tile's state and coordinates on it", async () => {
      const { drawing } = await load();

      expect(drawing.texts).toContain("F2");
      expect(drawing.texts).toContain("WATER");
      expect(drawing.texts).toContain(`P${SETTLEMENT.residents}`);
      expect(drawing.texts).toContain("1,1");
      expect(drawing.texts).toContain("9,7");
      expect(drawing.texts).not.toContain("BREAK");
    });

    it("selects the tile the player clicks", async () => {
      const parts = await load();
      drawFrame(parts);

      clickMap(middle(BURNING));

      expect(text("selected-tile")).toBe(describeTile(BURNING, 1));
      expect(pressed(mirrorTile(BURNING))).toBe("true");
    });

    it("selects nothing when the player clicks between tiles", async () => {
      const parts = await load();
      drawFrame(parts);

      clickMap({ x: TILE_SIZE, y: TILE_SIZE });

      expect(text("selected-tile")).toBe("Select a map tile.");
    });

    it("outlines the selected tile in the crew's color", async () => {
      const parts = await load();
      drawFrame(parts);
      expect(parts.drawing.strokes.filter((mark) => mark.width === 4))
        .toEqual([]);

      mirrorTile(BURNING).click();
      drawFrame(parts);

      expect(marksAt(parts.drawing.strokes, BURNING)).toEqual([
        {
          ...middle(BURNING),
          style: "rgba(255,208,113,1)",
          alpha: 1,
          width: 4,
        },
      ]);
      expect(marksAt(parts.drawing.strokes, BUILDABLE)).toEqual([
        { ...middle(BUILDABLE), style: "rgba(26,39,29,1)", alpha: 1, width: 1 },
      ]);

      parts.output.value = { crew: { ...DEFAULT_OUTPUT.crew, color: "blue" } };
      await parts.page.until(() => app().dataset.crewColor === "blue");
      drawFrame(parts);

      expect(marksAt(parts.drawing.strokes, BURNING)[0].style).toBe(
        "rgba(114,183,255,1)",
      );
    });

    it("tints each burning tile with fire", async () => {
      const parts = await load();

      drawFrame(parts);

      const fire = parts.drawing.fills.filter((mark) =>
        mark.style === "rgba(255,91,50,1)"
      );
      expect(fire.map(({ x, y }) => ({ x, y }))).toEqual(
        expect.arrayContaining(
          BOARD.tiles.filter((tile) => tile.fire > 0).map(middle),
        ),
      );
      expect(fire).toHaveLength(3);
      expect(fire[0].alpha).toBeCloseTo(0.58);
    });

    it("fades burned-out tiles", async () => {
      const parts = await load({
        state: new MemoryCell({ actions: [advance("a", "crew-10001")] }),
      });

      drawFrame(parts);

      expect(marksAt(parts.drawing.fills, BURNING)[0].style).toMatch(
        /,0\.58\)$/,
      );
      expect(marksAt(parts.drawing.fills, WATER)[0].style).toMatch(/,1\)$/);
    });

    it("colors tiles by terrain in the terrain view", async () => {
      const parts = await load({
        state: new MemoryCell({
          actions: [deployment("a", "crew-10001", "water", BURNING.id)],
        }),
      });
      drawFrame(parts);
      expect(marksAt(parts.drawing.fills, WATER)[0].style).toBe(
        "rgba(54,94,104,1)",
      );
      // A recently watered tile shows its dampness in the response view.
      expect(marksAt(parts.drawing.fills, BURNING)[0].style).toBe(
        "rgba(72,127,143,1)",
      );

      viewButton("terrain").click();
      drawFrame(parts);

      expect(pressed(viewButton("terrain"))).toBe("true");
      expect(pressed(viewButton("response"))).toBe("false");
      expect(marksAt(parts.drawing.fills, WATER)[0].style).toBe(
        "rgba(63,113,128,1)",
      );
      expect(marksAt(parts.drawing.fills, BURNING)[0].style).not.toBe(
        "rgba(72,127,143,1)",
      );
    });

    it("stops asking for frames while the page is hidden", async () => {
      const { frames } = await load();
      expect(frames.pending).toBe(true);

      Object.defineProperties(document, {
        visibilityState: { configurable: true, value: "hidden" },
        hidden: { configurable: true, value: true },
      });
      document.dispatchEvent(new Event("visibilitychange"));

      expect(frames.pending).toBe(false);

      Object.defineProperties(document, {
        visibilityState: { configurable: true, value: "visible" },
        hidden: { configurable: true, value: false },
      });
      document.dispatchEvent(new Event("visibilitychange"));

      expect(frames.pending).toBe(true);
    });

    it("shows the error when the map fails to draw", async () => {
      const { page, input, drawing } = await load();
      drawing.failure = new Error("The canvas context was lost.");

      input.value = { ...DEFAULT_INPUT, seed: 7 };
      await page.until(() => text("error") !== "");

      expect(text("error")).toBe("The canvas context was lost.");
    });
  });

  describe("unloading", () => {
    it("tears down the map and ignores the player once the page hides", async () => {
      const parts = await load();
      drawFrame(parts);

      dispatchEvent(new Event("pagehide"));
      clickMap(middle(BURNING));
      mirrorTile(BURNING).click();

      expect(text("selected-tile")).toBe("Select a map tile.");
      expect(pressed(mirrorTile(BURNING))).toBe("false");
      expect(mapCanvas()).not.toBeNull();

      // The map goes at the next frame.
      parts.frames.run();

      expect(mapCanvas()).toBeNull();
    });

    it("sends nothing to the shared log once the page hides", async () => {
      const { page, state } = await load();
      mirrorTile(BURNING).click();

      button("deploy").click();
      dispatchEvent(new Event("pagehide"));
      await page.until(() => text("error") !== "");
      await page.settled();

      expect(text("error")).toBe("The Fabric bridge is disconnected.");
      expect(state.writes).toEqual([]);
      expect(text("sync-status")).toBe("Committing water deployment");
    });
  });
});
