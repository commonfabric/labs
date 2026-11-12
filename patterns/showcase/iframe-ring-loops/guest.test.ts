import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import {
  type GuestPage,
  ManualFrames,
  MemoryCell,
  MemoryPresenceRoom,
  openGuestPage,
  patchProperty,
} from "../../tools/test-support/iframe-guest.ts";
import type { FabricValue } from "@commonfabric/data-model";
import {
  DEFAULT_OUTPUT,
  DEFAULT_SETUP,
  DEFAULT_STATE,
  type PlacedNote,
} from "./contract.ts";
import { cellShape, defaultColor, NOTE_COLORS, ringLayoutOf } from "./model.ts";

const GUEST = new URL("./guest.ts", import.meta.url);
const HTML = new URL("./guest.html", import.meta.url);

/** The per-user instance the output cell resolves to. */
const USER = "user-1";

/** The color this user's notes take until they choose one. */
const USER_COLOR = defaultColor(USER);

/** A note someone else placed in the innermost cell at the top. */
/** The color the peer Grace publishes. */
const GRACE_COLOR = NOTE_COLORS[3];

const KICK: PlacedNote = {
  ringId: "drums",
  step: 0,
  lane: 0,
  authorId: "lin",
  color: "#4dabf7",
  authorName: "Lin",
};

//
// Web Audio double
//

/** A parameter of an audio node, recording each value scheduled on it. */
class Param {
  value = 0;
  readonly scheduled: number[] = [];

  setValueAtTime(value: number): void {
    this.scheduled.push(value);
  }

  linearRampToValueAtTime(value: number): void {
    this.scheduled.push(value);
  }

  exponentialRampToValueAtTime(value: number): void {
    this.scheduled.push(value);
  }

  setTargetAtTime(value: number): void {
    this.value = value;
    this.scheduled.push(value);
  }
}

/** An audio node of any kind, recording when it was started and released. */
class AudioNodeDouble {
  readonly kind: string;
  readonly gain = new Param();
  readonly delayTime = new Param();
  readonly frequency = new Param();
  readonly threshold = new Param();
  readonly knee = new Param();
  readonly ratio = new Param();
  type = "";
  buffer: unknown = null;
  startedAt: number | undefined;
  disconnected = false;
  readonly #ended = new Set<() => void>();

  constructor(kind: string) {
    this.kind = kind;
  }

  connect(): void {}

  disconnect(): void {
    this.disconnected = true;
  }

  start(time: number): void {
    this.startedAt = time;
  }

  stop(): void {}

  addEventListener(type: string, listener: () => void): void {
    if (type === "ended") this.#ended.add(listener);
  }

  /** Ends the node, as the engine does once a source has played out. */
  end(): void {
    for (const listener of this.#ended) listener();
    this.#ended.clear();
  }
}

/** A sound the guest started: an oscillator's wave and pitch, or noise. */
interface Sound {
  voice: string;
  hertz?: number;
  at: number;
}

/**
 * Stands in for the Web Audio engine. A test moves its clock, decides whether
 * a resume starts audio, holds a resume back, and ends what is playing.
 */
class AudioEngine {
  currentTime = 0;
  state: "suspended" | "running" | "closed" = "suspended";
  contexts = 0;
  readonly nodes: AudioNodeDouble[] = [];
  resumeFailure: Error | undefined;

  /**
   * The last resume the guest asked for. Awaiting it resumes a test after
   * whatever the guest chained on it.
   */
  resuming: Promise<void> | undefined;
  #startsOnResume: boolean;
  #held: PromiseWithResolvers<void> | undefined;

  /** Constructs an engine whose resume starts audio unless told otherwise. */
  constructor(options: { startsOnResume?: boolean } = {}) {
    this.#startsOnResume = options.startsOnResume ?? true;
  }

  /** The `AudioContext` class the guest constructs. */
  readonly AudioContext = ((engine: AudioEngine) =>
    class {
      readonly sampleRate = 64;
      readonly destination = engine.#node("destination");

      constructor() {
        engine.contexts++;
      }

      get currentTime(): number {
        return engine.currentTime;
      }

      get state(): string {
        return engine.state;
      }

      resume(): Promise<void> {
        engine.resuming = (async () => {
          await engine.#held?.promise;
          if (engine.resumeFailure) throw engine.resumeFailure;
          if (engine.#startsOnResume) engine.state = "running";
        })();
        return engine.resuming;
      }

      close(): Promise<void> {
        engine.state = "closed";
        return Promise.resolve();
      }

      createDynamicsCompressor = () => engine.#node("compressor");
      createGain = () => engine.#node("gain");
      createDelay = () => engine.#node("delay");
      createOscillator = () => engine.#node("oscillator");
      createBufferSource = () => engine.#node("noise");
      createBiquadFilter = () => engine.#node("filter");

      createBuffer(_channels: number, length: number) {
        return { getChannelData: () => new Float32Array(length) };
      }
    })(this);

  /** Makes each later resume wait until {@link release}. */
  hold(): void {
    this.#held = Promise.withResolvers();
  }

  /** Lets the resumes held back go on. */
  release(): void {
    this.#held?.resolve();
    this.#held = undefined;
  }

  /** The sounds started so far, in order. */
  sounds(): Sound[] {
    return this.nodes.flatMap((node) => {
      if (node.startedAt === undefined) return [];
      return node.kind === "oscillator"
        ? [{
          voice: node.type,
          hertz: node.frequency.scheduled[0],
          at: node.startedAt,
        }]
        : [{ voice: "noise", at: node.startedAt }];
    });
  }

  /** The volume the guest last set on its master gain. */
  get volume(): number {
    // The master gain is the first gain the guest creates.
    return this.nodes.find((node) => node.kind === "gain")!.gain.value;
  }

  /** Ends every source that is playing. */
  endAll(): void {
    for (const node of this.nodes) node.end();
  }

  #node(kind: string): AudioNodeDouble {
    const node = new AudioNodeDouble(kind);
    this.nodes.push(node);
    return node;
  }
}

//
// Document doubles
//

/**
 * A 2D drawing context that records what is filled, stroked, and written, in
 * the style in effect at the time.
 */
class Drawing {
  fillStyle = "";
  strokeStyle = "";
  globalAlpha = 1;
  lineWidth = 1;
  lineCap = "butt";
  shadowColor = "";
  shadowBlur = 0;
  textAlign = "start";
  textBaseline = "alphabetic";
  font = "";
  readonly fills: { style: string; alpha: number }[] = [];
  readonly strokes: string[] = [];
  readonly texts: string[] = [];
  failure: Error | undefined;

  /** Forgets what was drawn so far. */
  reset(): void {
    this.fills.length = 0;
    this.strokes.length = 0;
    this.texts.length = 0;
  }

  setTransform(): void {
    if (this.failure) throw this.failure;
  }

  clearRect(): void {
    this.reset();
  }

  translate(): void {}
  beginPath(): void {}
  arc(): void {}
  closePath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  roundRect(): void {}

  fill(): void {
    this.fills.push({ style: this.fillStyle, alpha: this.globalAlpha });
  }

  /** The styles filled with, in order. */
  get filled(): string[] {
    return this.fills.map((fill) => fill.style);
  }

  stroke(): void {
    this.strokes.push(this.strokeStyle);
  }

  fillText(text: string): void {
    this.texts.push(text);
  }

  measureText(text: string): { width: number } {
    return { width: text.length * 7 };
  }
}

/** Tells the guest's resize observers when a test resizes the stage. */
class Resizes {
  readonly #callbacks = new Set<() => void>();

  /** The `ResizeObserver` class the guest constructs. */
  readonly ResizeObserver = ((resizes: Resizes) =>
    class {
      readonly #callback: () => void;

      constructor(callback: () => void) {
        this.#callback = callback;
      }

      observe(): void {
        resizes.#callbacks.add(this.#callback);
      }

      disconnect(): void {
        resizes.#callbacks.delete(this.#callback);
      }
    })(this);

  /** Tells every observer the stage was resized. */
  resize(): void {
    for (const callback of [...this.#callbacks]) callback();
  }
}

//
// Geometry
//

/** Width of the square canvas once the stage is sized, in CSS pixels. */
const SIZE = 400;

/** Share of the canvas's half-width the outermost ring reaches. */
const RING_EXTENT = 0.97;

const LAYOUT = ringLayoutOf(DEFAULT_SETUP);

/** Where a pointer event lands on the canvas, as the browser measures it. */
type CanvasPoint = PointerEventInit & { offsetX: number; offsetY: number };

/** Returns the middle of a cell of the default rings, on the canvas. */
function cellPoint(ringIndex: number, step: number, lane: number): CanvasPoint {
  const shape = cellShape(LAYOUT, { ringIndex, step, lane });
  const distance = (shape.inner + shape.outer) / 2 * SIZE / 2 * RING_EXTENT;
  const angle = (shape.startTurn + shape.endTurn) / 2 * 2 * Math.PI -
    Math.PI / 2;
  return {
    bubbles: true,
    offsetX: SIZE / 2 + distance * Math.cos(angle),
    offsetY: SIZE / 2 + distance * Math.sin(angle),
  };
}

/** The center of the canvas, in the hub inside the rings. */
const HUB: CanvasPoint = {
  bubbles: true,
  offsetX: SIZE / 2,
  offsetY: SIZE / 2,
};

//
// Tests
//

describe("guest", () => {
  let page: GuestPage | undefined;

  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = document.querySelector<T>(`[data-testid="${id}"]`);
    if (!element) throw new Error(`No element has the test id \`${id}\`.`);
    return element;
  }

  function alertText(): string {
    return document.querySelector('[role="alert"]')?.textContent ?? "";
  }

  function canvas(): HTMLCanvasElement {
    return byTestId<HTMLCanvasElement>("ring-canvas");
  }

  function readout(): string {
    return byTestId("cell-readout").textContent ?? "";
  }

  function roomLine(): string {
    return byTestId("room-status").textContent ?? "";
  }

  function people(): string[] {
    return [...byTestId("people").querySelectorAll("li")].map((item) =>
      item.textContent ?? ""
    );
  }

  function button(id: string): HTMLButtonElement {
    return byTestId<HTMLButtonElement>(id);
  }

  function slider(id: string): HTMLInputElement {
    return byTestId<HTMLInputElement>(id);
  }

  function key(target: EventTarget, init: KeyboardEventInit): void {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, ...init }),
    );
  }

  /** Clicks the canvas at `point`. */
  function clickAt(point: CanvasPoint): void {
    canvas().dispatchEvent(new MouseEvent("click", point));
  }

  /** Builds the page's resources and doubles, with stored notes by default. */
  function resources(options: {
    setup?: unknown;
    viewerName?: string;
    state?: MemoryCell;
    output?: MemoryCell;
    jam?: MemoryPresenceRoom;
    engine?: AudioEngine;
  } = {}) {
    const input = new MemoryCell({
      setup: options.setup ?? DEFAULT_SETUP,
      viewerName: options.viewerName ?? "Ada",
    }, { readonly: true });
    const state = options.state ??
      new MemoryCell({ notes: { "drums:0:0": KICK }, tempoBpm: 96 });
    const output = options.output ??
      new MemoryCell(DEFAULT_OUTPUT, {
        identity: { id: "output", instanceId: USER },
      });
    const jam = options.jam ?? new MemoryPresenceRoom();
    const engine = options.engine ?? new AudioEngine();
    return {
      input,
      state,
      output,
      jam,
      engine,
      drawing: new Drawing(),
      frames: new ManualFrames(),
      resizes: new Resizes(),
    };
  }

  /** Loads the guest with `parts`, drawing on the recording context. */
  async function load(
    parts: ReturnType<typeof resources>,
    options: { html?: string; canvas?: boolean } = {},
  ): Promise<GuestPage> {
    page = await openGuestPage({
      guest: GUEST,
      html: options.html ?? HTML,
      resources: {
        input: parts.input.resource(),
        state: parts.state.resource(),
        output: parts.output.resource(),
        jam: parts.jam.resource(),
      },
      globals: {
        AudioContext: parts.engine.AudioContext,
        ResizeObserver: parts.resizes.ResizeObserver,
        requestAnimationFrame: parts.frames.request,
        cancelAnimationFrame: parts.frames.cancel,
        devicePixelRatio: 2,
      },
      setup: () => {
        const canvas = HTMLCanvasElement.prototype;
        patchProperty(canvas, "getContext", {
          value: () => options.canvas === false ? null : parts.drawing,
        });
        // The canvas is laid out at the width its style gives it.
        patchProperty(canvas, "clientWidth", {
          get(this: HTMLCanvasElement) {
            return parseFloat(this.style.width) || 0;
          },
        });
      },
    });
    return page;
  }

  /**
   * Opens the rings, resolves once they are ready and the room is joined, and
   * lays the stage out so that the canvas is {@link SIZE} pixels square.
   */
  async function open(options: Parameters<typeof resources>[0] = {}) {
    const parts = resources(options);
    const opened = await load(parts);
    await opened.until(() =>
      byTestId("ring-status").dataset.ready === "true" &&
      roomLine() !== "Joining the room…"
    );
    const stage = document.querySelector(".stage")!;
    // The stage's padding is 1rem around and 2.4rem below.
    Object.defineProperty(stage, "clientWidth", { value: SIZE + 32 });
    Object.defineProperty(stage, "clientHeight", { value: SIZE + 54.4 });
    parts.resizes.resize();
    parts.frames.run();
    return { page: opened, ...parts };
  }

  /**
   * Resolves once the frames the guest asks for draw a note in `color` at full
   * strength, as they do once its write has settled.
   */
  async function storedNoteDrawn(
    rings: { page: GuestPage; drawing: Drawing; frames: ManualFrames },
    color: string,
  ): Promise<void> {
    await rings.page.until(() => {
      rings.frames.run();
      return rings.drawing.fills.some((fill) =>
        fill.style === color && fill.alpha === 0.92
      );
    });
  }

  function tempoReadout(): string {
    return slider("tempo").parentElement?.querySelector("output")
      ?.textContent ?? "";
  }

  function volumeReadout(): string {
    return slider("volume").parentElement?.querySelector("output")
      ?.textContent ?? "";
  }

  function pointerDown(id: string): void {
    byTestId(id).dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
  }

  /** Describes each sound `engine` started after the first `from`. */
  function soundsSince(engine: AudioEngine, from: number): string[] {
    return engine.sounds().slice(from).map(({ voice, hertz }) =>
      hertz === undefined ? voice : `${voice} ${hertz}`
    );
  }

  /** A peer record as the room delivers it. */
  function peer(
    participantId: string,
    name: string,
    facets: Record<string, FabricValue> = {},
  ) {
    return {
      participantId,
      name,
      facets: { look: { color: GRACE_COLOR }, ...facets },
    };
  }

  /** Waits for the guest's answer to a pressed Play to show. */
  async function play(opened: GuestPage): Promise<void> {
    button("play-toggle").click();
    await opened.until(() => button("play-toggle").textContent === "Stop");
  }

  describe("startup", () => {
    it("shows the stored notes and enables its controls once loaded", async () => {
      const { drawing } = await open();

      expect(byTestId("ring-status").textContent).toBe("1 note on the rings");
      expect(canvas().dataset.ready).toBe("true");
      expect(button("play-toggle").disabled).toBe(false);
      expect(slider("tempo").value).toBe("96");
      expect(byTestId("viewer-name").textContent).toBe(
        "Notes you place carry the name Ada.",
      );
      expect(
        [...byTestId("note-authors").querySelectorAll("li")].map((row) =>
          row.textContent
        ),
      ).toEqual(["Lin1"]);
      expect(drawing.filled).toContain(KICK.color);
      expect(drawing.texts).toEqual(["96", "BPM"]);
      expect(canvas().width).toBe(SIZE * 2);
    });

    it("stores the starter groove and default settings on first use", async () => {
      const state = new MemoryCell();
      const output = new MemoryCell(undefined, {
        identity: { id: "output", instanceId: USER },
      });
      await open({ state, output });

      expect(state.value).toEqual(DEFAULT_STATE);
      expect(output.value).toEqual(DEFAULT_OUTPUT);
      expect(byTestId("ring-status").textContent).toBe("13 notes on the rings");
    });

    it("says notes carry no name for a viewer without one", async () => {
      await open({ viewerName: "  " });

      expect(byTestId("viewer-name").textContent).toBe(
        "No profile name is known, so notes you place carry none.",
      );
      expect(people()[0]).toBe("Guest (you)");
    });

    it("shows why it could not load for settings with no identity", async () => {
      const parts = resources({ output: new MemoryCell(DEFAULT_OUTPUT) });
      const opened = await load(parts);
      await opened.until(() => alertText() !== "");

      expect(alertText()).toContain(
        "The per-user settings have no resolved identity.",
      );
      expect(byTestId("ring-status").textContent).toBe(
        "Could not join the rings",
      );
      expect(button("play-toggle").disabled).toBe(true);
    });

    it("shows why rings that cannot be drawn are refused, until they are fixed", async () => {
      const parts = resources({ setup: { ...DEFAULT_SETUP, rings: [] } });
      const opened = await load(parts);
      await opened.until(() => alertText() !== "");

      expect(alertText()).toContain("The setup needs 1 to 6 rings and has 0.");
      expect(byTestId("ring-status").textContent).toBe(
        "These rings cannot be drawn",
      );
      expect(button("play-toggle").disabled).toBe(true);
      expect(byTestId("jam-pads").children.length).toBe(0);

      parts.input.value = { setup: DEFAULT_SETUP, viewerName: "Ada" };
      await opened.until(() => alertText() === "");
      expect(button("play-toggle").disabled).toBe(false);
      expect(byTestId("jam-pads").querySelectorAll("button").length).toBe(20);
    });

    it("throws for a document with no #root element", async () => {
      await expect(
        load(resources(), {
          html: "<!doctype html><html><body></body></html>",
        }),
      ).rejects.toThrow("Ring Loops needs a `#root` element.");
    });

    it("throws for a browser with no 2D canvas", async () => {
      await expect(load(resources(), { canvas: false })).rejects.toThrow(
        "Ring Loops needs a 2D canvas.",
      );
    });
  });

  describe("drawing", () => {
    it("draws nothing and takes no pointer before the stage has a size", async () => {
      const parts = resources();
      const opened = await load(parts);
      await opened.until(() =>
        byTestId("ring-status").dataset.ready === "true" &&
        roomLine() !== "Joining the room…"
      );
      parts.frames.run();

      canvas().dispatchEvent(
        new PointerEvent("pointermove", cellPoint(0, 0, 0)),
      );
      await opened.settled();

      expect(parts.drawing.filled).toEqual([]);
      expect(readout()).toContain("Click a cell");
      expect(parts.jam.facets.has("pointer")).toBe(false);
    });

    it("highlights the ring whose row the pointer is over", async () => {
      const { drawing, frames } = await open();
      const row = document.querySelectorAll(".ring-row")[1];
      expect(drawing.filled.filter((fill) => fill === "#ffffff1c")).toEqual([]);

      row.dispatchEvent(new PointerEvent("pointerenter"));
      frames.run();
      expect(drawing.filled.filter((fill) => fill === "#ffffff1c")).toEqual([
        "#ffffff1c",
      ]);

      row.dispatchEvent(new PointerEvent("pointerleave"));
      frames.run();
      expect(drawing.filled.filter((fill) => fill === "#ffffff1c")).toEqual([]);
    });
  });

  describe("editing notes", () => {
    it("places a note in the clicked cell, by the viewer and in their color", async () => {
      const rings = await open();
      const { state, drawing, frames } = rings;
      const write = state.nextWrite();

      clickAt(cellPoint(1, 3, 2));
      expect(readout()).toBe("Bells · step 3 · lane 2 · D5 · placed by Ada");
      expect(byTestId("ring-status").textContent).toBe("2 notes on the rings");
      frames.run();
      expect(drawing.fills).toContainEqual({ style: USER_COLOR, alpha: 0.6 });
      const note = {
        ringId: "bells",
        step: 3,
        lane: 2,
        authorId: USER,
        color: USER_COLOR,
        authorName: "Ada",
      };
      expect(await write).toEqual({
        operation: "set",
        path: ["notes", "bells:3:2"],
        value: note,
      });
      await storedNoteDrawn(rings, USER_COLOR);

      expect(state.value).toMatchObject({ notes: { "bells:3:2": note } });
      expect(byTestId("note-authors").textContent).toContain("Ada1");
    });

    it("removes the note in a clicked cell, then shows the cell as stored", async () => {
      const { page, state } = await open();
      const write = state.nextWrite();

      clickAt(cellPoint(0, 0, 0));
      expect(readout()).toBe("Drums · step 0 · lane 0 · kick");
      expect(await write).toMatchObject({
        path: ["notes", "drums:0:0"],
        value: null,
      });
      expect(byTestId("ring-status").textContent).toBe("0 notes on the rings");

      state.value = { notes: { "drums:0:0": KICK }, tempoBpm: 96 };
      await page.until(() =>
        byTestId("ring-status").textContent === "1 note on the rings"
      );
    });

    it("takes no second toggle of a cell while its write is on its way", async () => {
      const rings = await open();

      clickAt(cellPoint(1, 3, 2));
      clickAt(cellPoint(1, 3, 2));
      await storedNoteDrawn(rings, USER_COLOR);
      await rings.page.settled();

      expect(rings.state.writes.map((write) => write.path)).toEqual([
        ["notes", "bells:3:2"],
      ]);
    });

    it("shows why a note could not be stored, and shows the cell as stored", async () => {
      const { page, state } = await open();
      state.failWrites(new Error("The notes are read-only."));

      clickAt(cellPoint(1, 3, 2));
      await page.until(() => alertText() !== "");

      expect(alertText()).toContain("The notes are read-only.");
      expect(byTestId("ring-status").textContent).toBe("1 note on the rings");
    });

    it("toggles nothing for a click in the hub", async () => {
      const { page, state } = await open();

      clickAt(HUB);
      await page.settled();

      expect(readout()).toContain("Click a cell");
      expect(state.writes).toEqual([]);
    });

    it("describes the cell under the pointer and tells the room where it is", async () => {
      const { page, jam } = await open();
      const point: CanvasPoint = { offsetX: SIZE / 2 + 97, offsetY: SIZE / 2 };

      canvas().dispatchEvent(new PointerEvent("pointermove", point));
      expect(readout()).toBe("Bells · step 5 · lane 3 · E5");
      expect(
        document.querySelectorAll<HTMLElement>(".ring-row")[1].dataset.hover,
      ).toBe("true");
      await page.until(() => jam.facets.has("pointer"));
      expect(jam.facets.get("pointer")).toEqual({ x: 0.5, y: 0 });

      canvas().dispatchEvent(new PointerEvent("pointerleave"));
      expect(readout()).toContain("Click a cell");
      await page.until(() => !jam.facets.has("pointer"));
    });
  });

  describe("keyboard", () => {
    it("selects the first cell on keyboard focus, and moves it with the arrow keys", async () => {
      await open();

      canvas().focus();
      expect(readout()).toBe("Drums · step 0 · lane 0 · kick · placed by Lin");
      key(canvas(), { key: "ArrowRight" });
      key(canvas(), { key: "ArrowUp" });
      expect(readout()).toBe("Drums · step 1 · lane 1 · snare");
      key(canvas(), { key: "ArrowDown" });
      key(canvas(), { key: "ArrowLeft" });
      expect(readout()).toBe("Drums · step 0 · lane 0 · kick · placed by Lin");
      key(canvas(), { key: "ArrowRight", ctrlKey: true });
      key(canvas(), { key: "Escape" });
      expect(readout()).toBe("Drums · step 0 · lane 0 · kick · placed by Lin");
    });

    it("keeps the selection while focused when the pointer leaves, and drops it on blur", async () => {
      await open();
      canvas().focus();

      canvas().dispatchEvent(new PointerEvent("pointerleave"));
      expect(readout()).toContain("Drums · step 0");

      canvas().blur();
      expect(readout()).toContain("Click a cell");
    });

    it("places a note in the selected cell on Space, once per press", async () => {
      const rings = await open();
      canvas().focus();
      key(canvas(), { key: "ArrowRight" });

      key(canvas(), { key: " " });
      key(canvas(), { key: " ", repeat: true });
      await storedNoteDrawn(rings, USER_COLOR);
      await rings.page.settled();

      expect(rings.state.writes.map((write) => write.path)).toEqual([
        ["notes", "drums:1:0"],
      ]);
    });

    it("toggles the first cell on Enter with none selected", async () => {
      const { page, state } = await open();
      const write = state.nextWrite();

      key(canvas(), { key: "Enter" });

      expect(await write).toMatchObject({
        path: ["notes", "drums:0:0"],
        value: null,
      });
      expect(readout()).toBe("Drums · step 0 · lane 0 · kick");
      state.value = { notes: { "drums:0:0": KICK }, tempoBpm: 96 };
      await page.until(() =>
        byTestId("ring-status").textContent === "1 note on the rings"
      );
    });
  });

  describe("playback", () => {
    it("plays the notes coming due on Play, lights them, and tells the room", async () => {
      const { page, jam, engine, drawing, frames } = await open();

      await play(page);
      expect(engine.contexts).toBe(1);
      expect(button("play-toggle").getAttribute("aria-pressed")).toBe("true");
      await page.until(() => jam.facets.has("hand"));
      expect(jam.facets.get("hand")).toMatchObject({ bpm: 96 });
      expect(people()[0]).toBe("Ada (you)playing");

      engine.currentTime = 0.06;
      frames.run();
      expect(soundsSince(engine, 0)).toEqual(["sine 150"]);
      engine.currentTime = 0.1;
      frames.run();
      expect(drawing.filled).toContain("#ffffff");
      engine.currentTime = 0.5;
      frames.run();
      expect(drawing.filled).not.toContain("#ffffff");

      engine.endAll();
      expect(
        engine.nodes.filter((node) => node.kind === "oscillator")
          .every((node) => node.disconnected),
      ).toBe(true);

      button("play-toggle").click();
      expect(button("play-toggle").textContent).toBe("Play");
      await page.until(() => !jam.facets.has("hand"));
      frames.run();
      expect(frames.pending).toBe(false);
    });

    it("shows why audio did not start, and stays stopped", async () => {
      const { page } = await open({
        engine: new AudioEngine({ startsOnResume: false }),
      });

      button("play-toggle").click();
      await page.until(() => alertText() !== "");

      expect(alertText()).toContain(
        "The browser has not started audio. Press Play again.",
      );
      expect(button("play-toggle").textContent).toBe("Play");
    });

    it("starts one audio engine and clock for a double press of Play", async () => {
      const { page, engine } = await open();
      engine.hold();

      button("play-toggle").click();
      button("play-toggle").click();
      engine.release();
      await play(page).catch(() => {});
      await engine.resuming;

      expect(engine.contexts).toBe(1);
      expect(button("play-toggle").textContent).toBe("Stop");
    });

    it("leaves the notes of a ring this user muted unplayed", async () => {
      const { page, engine, frames } = await open({
        output: new MemoryCell({ ...DEFAULT_OUTPUT, mutedRingIds: ["drums"] }, {
          identity: { id: "output", instanceId: USER },
        }),
      });

      await play(page);
      engine.currentTime = 0.06;
      frames.run();

      expect(engine.sounds()).toEqual([]);
      expect(
        document.querySelectorAll<HTMLElement>(".ring-row")[0].dataset.muted,
      ).toBe("true");
    });

    it("sounds a note placed while audio is running, unless its ring is muted", async () => {
      const rings = await open({
        output: new MemoryCell({ ...DEFAULT_OUTPUT, mutedRingIds: ["bass"] }, {
          identity: { id: "output", instanceId: USER },
        }),
      });
      const { page, state, engine } = rings;
      await play(page);

      clickAt(cellPoint(1, 3, 0));
      expect(soundsSince(engine, 0)).toEqual(["sine 440", "sine 1540"]);
      await storedNoteDrawn(rings, USER_COLOR);

      const write = state.nextWrite();
      const before = engine.sounds().length;
      clickAt(cellPoint(2, 3, 0));
      expect(soundsSince(engine, before)).toEqual([]);
      await write;
      // Someone else then clears both new notes, which shows once this
      // browser's write has settled.
      state.value = { notes: { "drums:0:0": KICK }, tempoBpm: 96 };
      await page.until(() =>
        byTestId("ring-status").textContent === "1 note on the rings"
      );
    });

    it("stops playback and shows why when a frame fails", async () => {
      const { page, jam, drawing, frames } = await open();
      await play(page);
      await page.until(() => jam.facets.has("hand"));

      drawing.failure = new Error("The canvas was lost.");
      frames.run();

      expect(alertText()).toContain("The canvas was lost.");
      expect(button("play-toggle").textContent).toBe("Play");
      await page.until(() => !jam.facets.has("hand"));
    });

    it("tells the room again where a playing hand is after a few seconds", async () => {
      const { page, jam, frames } = await open();
      await play(page);
      await page.until(() => jam.facets.has("hand"));
      const first = jam.facets.get("hand");

      const time = new FakeTime(Date.now());
      try {
        time.tick(5000);
        frames.run();
      } finally {
        time.restore();
      }
      await page.until(() => jam.facets.get("hand") !== first);

      expect(jam.facets.get("hand")).toMatchObject({ bpm: 96 });
    });
  });

  describe("settings", () => {
    it("shows a tempo being dragged, and stores and plays at it once let go", async () => {
      const { page, state, jam, drawing, frames } = await open();
      await play(page);
      const tempo = slider("tempo");

      tempo.value = "120";
      tempo.dispatchEvent(new Event("input"));
      frames.run();
      expect(drawing.texts).toContain("120");
      expect(tempoReadout()).toBe("120 BPM");
      await page.until(() => jam.facets.get("hand")?.bpm === 120);

      const write = state.nextWrite();
      tempo.dispatchEvent(new Event("change"));
      expect(await write).toEqual({
        operation: "set",
        path: ["tempoBpm"],
        value: 120,
      });

      state.value = { notes: {}, tempoBpm: 100 };
      await page.until(() => tempoReadout() === "100 BPM");
      expect(tempo.value).toBe("100");
    });

    it("shows why a tempo could not be stored, and returns to the shared one", async () => {
      const { page, state } = await open();
      state.failWrites(new Error("Tempo refused."));
      const tempo = slider("tempo");

      tempo.value = "150";
      tempo.dispatchEvent(new Event("change"));
      await page.until(() => alertText() !== "");

      expect(alertText()).toContain("Tempo refused.");
      expect(tempo.value).toBe("96");
      expect(tempoReadout()).toBe("96 BPM");
    });

    it("sets this user's volume as it is dragged, and stores it once let go", async () => {
      const { page, output, engine } = await open();
      await play(page);
      const volume = slider("volume");
      expect(volumeReadout()).toBe("70%");

      volume.value = "0.25";
      volume.dispatchEvent(new Event("input"));
      expect(volumeReadout()).toBe("25%");
      expect(engine.volume).toBe(0.25);

      const write = output.nextWrite();
      volume.dispatchEvent(new Event("change"));
      expect(await write).toMatchObject({ path: ["volume"], value: 0.25 });

      output.value = { ...DEFAULT_OUTPUT, volume: 0.3 };
      await page.until(() => volumeReadout() === "30%");
    });

    it("shows why a volume could not be stored", async () => {
      const { page, output } = await open();
      output.failWrites(new Error("Volume refused."));
      const volume = slider("volume");

      volume.value = "0.2";
      volume.dispatchEvent(new Event("change"));
      await page.until(() => alertText() !== "");

      expect(alertText()).toContain("Volume refused.");
      expect(volume.value).toBe("0.7");
    });

    it("plays silently at a stored volume that is not a number", async () => {
      await open({
        output: new MemoryCell({ ...DEFAULT_OUTPUT, volume: "loud" }, {
          identity: { id: "output", instanceId: USER },
        }),
      });

      expect(volumeReadout()).toBe("0%");
    });

    it("stores the note color picked, and tells the room", async () => {
      const { page, output, jam } = await open();
      await page.until(() => jam.facets.has("look"));
      expect(jam.facets.get("look")).toEqual({ color: USER_COLOR });
      const swatch = document.querySelectorAll<HTMLButtonElement>(".swatch")[2];
      expect(swatch.getAttribute("aria-pressed")).toBe("false");

      swatch.click();
      await page.until(() =>
        swatch.getAttribute("aria-pressed") === "true" &&
        jam.facets.get("look")?.color === NOTE_COLORS[2]
      );
      await page.settled();

      expect(output.value).toMatchObject({ color: NOTE_COLORS[2] });
    });

    it("shows why a note color could not be stored", async () => {
      const { page, output } = await open();
      output.failWrites(new Error("Color refused."));

      document.querySelector<HTMLButtonElement>(".swatch")!.click();
      await page.until(() => alertText() !== "");

      expect(alertText()).toContain("Color refused.");
    });

    it("mutes a ring for this user, building each click on the last", async () => {
      const { page, output } = await open();
      const mute = button("mute-0");
      expect(mute.textContent).toBe("Mute");

      mute.click();
      expect(mute.textContent).toBe("Muted");
      expect(mute.getAttribute("aria-label")).toBe("Unmute Drums for yourself");
      mute.click();
      expect(mute.textContent).toBe("Mute");
      await page.until(() => output.writes.length === 2);
      await page.settled();

      expect(output.writes.map((write) => write.value)).toEqual([
        ["drums"],
        [],
      ]);
      output.value = { ...DEFAULT_OUTPUT, mutedRingIds: ["bells"] };
      await page.until(() => button("mute-1").textContent === "Muted");
      expect(mute.textContent).toBe("Mute");
    });

    it("shows why a mute could not be stored, and unmutes the ring", async () => {
      const { page, output } = await open();
      output.failWrites(new Error("Mute refused."));

      button("mute-0").click();
      await page.until(() => button("mute-0").textContent === "Mute");

      expect(alertText()).toContain("Mute refused.");
    });

    it("clears everyone's notes only on a second click", async () => {
      const rings = await open();
      const { page, state } = rings;
      const clear = button("clear-notes");
      expect(clear.textContent).toBe("Clear all notes");

      clear.click();
      expect(clear.textContent).toBe("Click again to clear everyone's notes");
      clear.dispatchEvent(new Event("blur"));
      expect(clear.textContent).toBe("Clear all notes");
      clear.click();
      clear.dispatchEvent(new PointerEvent("pointerleave"));
      expect(clear.dataset.armed).toBe("false");
      clear.dispatchEvent(new PointerEvent("pointerleave"));
      await page.settled();
      expect(state.writes).toEqual([]);

      clear.click();
      clear.click();
      await page.until(() =>
        byTestId("ring-status").textContent === "0 notes on the rings"
      );
      await page.settled();
      expect(state.value).toMatchObject({ notes: {} });

      // A note placed now settles after the clear does.
      clickAt(cellPoint(1, 3, 2));
      await storedNoteDrawn(rings, USER_COLOR);
    });

    it("shows why the notes could not be cleared", async () => {
      const { page, state } = await open();
      state.failWrites(new Error("Clearing refused."));

      button("clear-notes").click();
      button("clear-notes").click();
      await page.until(() => alertText() !== "");

      expect(alertText()).toContain("Clearing refused.");
      expect(byTestId("ring-status").textContent).toBe("1 note on the rings");
    });
  });

  describe("jam pads", () => {
    it("sounds each pad's instrument, and tells the room the latest presses", async () => {
      const { page, jam, engine } = await open();

      pointerDown("pad-0-0");
      await engine.resuming;
      expect(soundsSince(engine, 0)).toEqual(["sine 150"]);
      const heard = (id: string) => {
        const from = engine.sounds().length;
        pointerDown(id);
        return soundsSince(engine, from);
      };
      expect(heard("pad-0-1")).toEqual(["noise", "triangle 190"]);
      expect(heard("pad-0-2")).toEqual(["noise"]);
      expect(heard("pad-0-3")).toEqual(["noise", "noise", "noise"]);
      expect(heard("pad-0-4")).toEqual(["sine 220"]);
      expect(heard("pad-1-0")).toEqual(["sine 440", "sine 1540"]);
      expect(heard("pad-2-0")).toEqual(["sawtooth 55"]);
      expect(heard("pad-3-0")).toEqual(["square 220"]);
      expect(heard("pad-0-1")).toEqual(["noise", "triangle 190"]);
      engine.endAll();

      // The room hears the newest eight presses.
      await page.until(() => {
        const list = jam.facets.get("presses")?.list;
        return Array.isArray(list) && list.length === 8 &&
          list[7] !== null && list[7].id === 8;
      });
      expect(jam.facets.get("presses")).toEqual({
        list: [
          { id: 1, ring: "drums", lane: 1 },
          { id: 2, ring: "drums", lane: 2 },
          { id: 3, ring: "drums", lane: 3 },
          { id: 4, ring: "drums", lane: 4 },
          { id: 5, ring: "bells", lane: 0 },
          { id: 6, ring: "bass", lane: 0 },
          { id: 7, ring: "pluck", lane: 0 },
          { id: 8, ring: "drums", lane: 1 },
        ],
      });
      expect(people()[0]).toBe("Ada (you)jammed snare");
      expect(byTestId("pad-3-0").getAttribute("aria-label")).toBe(
        "Play Pluck A3",
      );
    });

    it("plays the pad of a key pressed outside a text field", async () => {
      const { engine } = await open();

      key(document.body, { key: "q" });
      await engine.resuming;
      expect(soundsSince(engine, 0)).toEqual(["sine 440", "sine 1540"]);

      key(document.body, { key: "q", repeat: true });
      key(document.body, { key: "q", metaKey: true });
      key(document.body, { key: "p" });
      key(slider("tempo"), { key: "q" });
      expect(engine.sounds().length).toBe(2);

      key(byTestId("pad-0-4"), { key: "Enter" });
      key(byTestId("pad-0-4"), { key: "Enter", repeat: true });
      key(byTestId("pad-0-4"), { key: "Tab" });
      expect(soundsSince(engine, 2)).toEqual(["sine 220"]);
    });

    it("lights a muted ring's pad without sounding it", async () => {
      const { engine } = await open({
        output: new MemoryCell({ ...DEFAULT_OUTPUT, mutedRingIds: ["drums"] }, {
          identity: { id: "output", instanceId: USER },
        }),
      });

      pointerDown("pad-0-1");

      expect(engine.contexts).toBe(0);
      expect(people()[0]).toBe("Ada (you)jammed snare");
    });

    it("shows why a pad could not start audio", async () => {
      const { page, engine } = await open();
      engine.resumeFailure = new Error("Audio refused.");

      pointerDown("pad-0-0");
      await page.until(() => alertText() !== "");

      expect(alertText()).toContain("Audio refused.");
      expect(engine.sounds()).toEqual([]);
    });
  });

  describe("presence", () => {
    it("tells the room the viewer's name and color, and says they are alone", async () => {
      const { page, jam } = await open();
      await page.until(() => jam.name !== undefined && jam.facets.has("look"));

      expect(jam.name).toBe("Ada");
      expect(jam.facets.get("look")).toEqual({ color: USER_COLOR });
      expect(people()).toEqual(["Ada (you)"]);
      expect(roomLine()).toBe("Nobody else is here right now.");
    });

    it("lists everyone in the room, with who is playing", async () => {
      const jam = new MemoryPresenceRoom();
      jam.upsert(peer("p1", "Grace", {
        hand: { step: 0, at: Date.now(), bpm: 120 },
        pointer: { x: 0.5, y: 0 },
      }));
      const { page, drawing, frames } = await open({ jam });

      expect(people()).toEqual(["Ada (you)", "GraceplayingFollow"]);
      expect(roomLine()).toBe("1 other here.");
      frames.run();
      expect(drawing.strokes).toContain(GRACE_COLOR);
      expect(drawing.texts).toContain("Grace");
      expect(frames.pending).toBe(true);

      jam.upsert(peer("p2", "  "));
      await page.until(() => roomLine() === "2 others here.");
      expect(people()[2]).toBe("SomeoneFollow");

      jam.remove("p1");
      jam.remove("p2");
      await page.until(() => roomLine() === "Nobody else is here right now.");
      frames.run();
      expect(frames.pending).toBe(false);
    });

    it("plays a peer's new pad presses once its audio has started", async () => {
      const jam = new MemoryPresenceRoom();
      const presses = (lanes: number[]) => ({
        presses: {
          list: lanes.map((lane, id) => ({ id, ring: "drums", lane })),
        },
      });
      jam.upsert(peer("p1", "Grace", presses([1])));
      const { page, engine } = await open({ jam });
      const hint = () => byTestId("jam-pads").nextElementSibling?.textContent;
      expect(people()[1]).toBe("GraceFollow");

      jam.upsert(peer("p1", "Grace", presses([1, 1])));
      await page.until(() => people()[1] === "Gracejammed snareFollow");
      expect(hint()).toBe(
        "Someone is playing the pads. Press Play or a pad to hear them.",
      );
      expect(engine.sounds()).toEqual([]);

      await play(page);
      expect(hint()).toBe(
        "Press a pad, or its key, to play it over the loop. Everyone here hears it.",
      );
      jam.upsert(peer("p1", "Grace", presses([1, 1, 2])));
      await page.until(() => people()[1] === "Gracejammed hatFollow");
      expect(soundsSince(engine, 0)).toEqual(["noise"]);

      jam.upsert(peer("p1", "Grace", {
        presses: {
          list: [
            { id: 3, ring: "gongs", lane: 0 },
            { id: 4, ring: "drums", lane: 9 },
            { id: 5, ring: "drums", lane: 0 },
          ],
        },
      }));
      await page.until(() => people()[1] === "Gracejammed kickFollow");
      expect(soundsSince(engine, 0)).toEqual(["noise", "sine 150"]);
    });

    it("plays in step with a followed peer, stopping and starting as they do", async () => {
      // The guest extrapolates a followed hand from the time it was stamped,
      // so the clock stands still from the first stamp on: whether a new hand
      // is a jump or jitter turns on its step alone.

      const jam = new MemoryPresenceRoom();
      jam.upsert(peer("p1", "Grace"));
      const { page } = await open({ jam });
      using _time = new FakeTime();
      jam.upsert(peer("p1", "Grace", {
        hand: { step: 8, at: Date.now(), bpm: 120 },
      }));
      await page.until(() => people()[1] === "GraceplayingFollow");

      button("follow").click();
      await page.until(() => roomLine() === "Playing in step with Grace.");
      expect(button("follow").textContent).toBe("Following");
      expect(button("play-toggle").textContent).toBe("Stop");
      await page.until(() => jam.facets.get("hand")?.bpm === 120);
      const first = jam.facets.get("hand");

      jam.upsert(peer("p1", "Grace", {
        hand: { step: 40, at: Date.now(), bpm: 120 },
      }));
      await page.until(() => jam.facets.get("hand") !== first);

      jam.upsert(peer("p1", "Grace"));
      await page.until(() =>
        button("play-toggle").textContent === "Play" && !jam.facets.has("hand")
      );

      jam.upsert(peer("p1", "Grace", {
        hand: { step: 0, at: Date.now(), bpm: 90 },
      }));
      await page.until(() => button("play-toggle").textContent === "Stop");

      button("follow").click();
      expect(roomLine()).toBe("1 other here.");
      expect(button("follow").textContent).toBe("Follow");
      expect(button("play-toggle").textContent).toBe("Stop");
    });

    it("stops following a peer who leaves", async () => {
      const jam = new MemoryPresenceRoom();
      jam.upsert(peer("p1", "Grace", {
        hand: { step: 0, at: Date.now(), bpm: 120 },
      }));
      const { page } = await open({ jam });
      button("follow").click();
      await page.until(() => roomLine() === "Playing in step with Grace.");

      jam.remove("p1");
      await page.until(() => roomLine() === "Nobody else is here right now.");

      expect(button("play-toggle").textContent).toBe("Stop");
    });

    it("follows nobody when the peer leaves before audio starts", async () => {
      const jam = new MemoryPresenceRoom();
      jam.upsert(peer("p1", "Grace", {
        hand: { step: 0, at: Date.now(), bpm: 120 },
      }));
      const { page, engine } = await open({ jam });
      engine.hold();

      button("follow").click();
      jam.remove("p1");
      await page.until(() => roomLine() === "Nobody else is here right now.");
      engine.release();
      await engine.resuming;

      expect(button("play-toggle").textContent).toBe("Play");
      expect(roomLine()).toBe("Nobody else is here right now.");
    });

    it("shows why following could not start audio", async () => {
      const jam = new MemoryPresenceRoom();
      jam.upsert(peer("p1", "Grace"));
      const { page } = await open({
        jam,
        engine: new AudioEngine({ startsOnResume: false }),
      });

      button("follow").click();
      await page.until(() => alertText() !== "");

      expect(alertText()).toContain(
        "The browser has not started audio. Try again.",
      );
      expect(button("follow").textContent).toBe("Follow");
    });

    it("pauses when the room is lost, and rejoins when the rings are pressed", async () => {
      const jam = new MemoryPresenceRoom();
      jam.upsert(peer("p1", "Grace", {
        hand: { step: 0, at: Date.now(), bpm: 120 },
      }));
      const { page } = await open({ jam });
      button("follow").click();
      await page.until(() => roomLine() === "Playing in step with Grace.");

      jam.fail("presence-disconnected");
      await page.until(() =>
        roomLine() ===
          "Lost the room. Press Play, a pad, or the rings to rejoin."
      );
      expect(people()).toEqual(["Ada (you)playing"]);
      canvas().dispatchEvent(
        new PointerEvent("pointermove", cellPoint(0, 0, 0)),
      );
      await page.settled();
      expect(jam.facets.has("pointer")).toBe(false);

      canvas().dispatchEvent(new PointerEvent("pointerdown"));
      await page.until(() => roomLine() === "1 other here.");
      expect(jam.joins).toBe(2);
    });

    it("says the server has no room, and does not try to join again", async () => {
      const jam = new MemoryPresenceRoom({ refusal: "presence-unsupported" });
      const { page } = await open({ jam });
      await page.until(() =>
        roomLine().startsWith("This server has no live room")
      );

      canvas().dispatchEvent(new PointerEvent("pointerdown"));
      pointerDown("pad-0-0");
      await play(page);
      await page.settled();

      expect(jam.joins).toBe(1);
      expect(jam.facets.has("hand")).toBe(false);
    });

    it("plays no peer's press while the rings cannot be drawn", async () => {
      const jam = new MemoryPresenceRoom();
      const press = (id: number) => ({
        presses: { list: [{ id, ring: "drums", lane: 0 }] },
      });
      jam.upsert(peer("p1", "Grace", press(0)));
      const parts = resources({
        setup: { ...DEFAULT_SETUP, rings: [] },
        jam,
      });
      const opened = await load(parts);
      await opened.until(() => roomLine() === "1 other here.");

      jam.upsert(peer("p1", "Grace Hopper", press(1)));
      await opened.until(() => people()[1]?.startsWith("Grace Hopper"));

      expect(people()[1]).toBe("Grace HopperFollow");
      expect(parts.engine.contexts).toBe(0);
    });
  });

  describe("teardown", () => {
    it("closes its audio and stops asking for frames when the page is hidden", async () => {
      const { page: opened, engine, frames } = await open();
      await play(opened);
      expect(frames.pending).toBe(true);

      page = undefined;
      await opened.close();

      expect(engine.state).toBe("closed");
      expect(frames.pending).toBe(false);
    });

    it("follows nobody when the page closes before audio starts", async () => {
      const jam = new MemoryPresenceRoom();
      jam.upsert(peer("p1", "Grace", {
        hand: { step: 0, at: Date.now(), bpm: 120 },
      }));
      const { page: opened, engine } = await open({ jam });
      engine.hold();
      button("follow").click();

      dispatchEvent(new Event("pagehide"));
      engine.release();
      await engine.resuming;
      await opened.settled();

      expect(soundsSince(engine, 0)).toEqual([]);
      expect(jam.facets.has("hand")).toBe(false);
    });
  });
});
