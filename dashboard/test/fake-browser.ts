/**
 * Test utility: the browser the runners page's board draws in, under plain
 * `deno test`.
 *
 * `installBrowser()` puts a happy-dom document on the global object, with
 * the rest of what runner-view.ts and runner-gl.ts read from a browser
 * replaced by fakes a test controls: animation frames that run only when the
 * test says, on a clock that moves only then; the device's pixel ratio and
 * the media queries that watch it; the reader's wish for less motion and
 * whether the page is hidden; resize observers; and `open()` and
 * `location.reload()`, which only count their calls.
 *
 * happy-dom draws nothing, so every canvas gives a context that records what
 * is drawn on it instead: a 2D context that keeps the marks made since it was
 * last cleared, and a WebGL 2 context that keeps the circles of the last
 * frame drawn, read back from the data and the attribute layout it was given.
 * A canvas keeps the kind of context it first gave, as in a browser, and
 * gives none of another kind. {@link context2dOf} and {@link webglOf} read a
 * canvas's context back, giving it one of that kind if it has none yet.
 *
 * `uninstall()` puts back every global the install replaced, and removes
 * the listeners added to the global object since, as a page's listeners on
 * its window go with the page.
 */

import {
  type Event as HappyEvent,
  type HTMLCanvasElement as HappyCanvas,
  Window,
} from "happy-dom";
import type { Clip } from "../runner-gl.ts";

/** A shape on a 2D context's path. */
export type Shape =
  | { readonly kind: "circle"; readonly x: number; readonly y: number; readonly r: number }
  | {
    readonly kind: "box";
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly radius: number;
  }
  | { readonly kind: "line"; readonly from: readonly number[]; readonly to: readonly number[] };

/** A mark made on a 2D context: a path filled or stroked, or a line of text. */
export type Mark =
  | {
    readonly kind: "fill" | "stroke";
    readonly shapes: readonly Shape[];
    readonly color: string;
    readonly alpha: number;
    readonly lineWidth: number;
    /** The path the mark was clipped to, or `null`. */
    readonly clip: readonly Shape[] | null;
  }
  | {
    readonly kind: "text";
    readonly text: string;
    readonly x: number;
    readonly y: number;
    readonly color: string;
    readonly alpha: number;
    readonly font: string;
  };

/** A circle a WebGL context drew. */
export interface Circle {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  /** As `#rrggbb`. */
  readonly color: string;
  readonly clip: Clip | null;
}

/** What a recording 2D context has been given. */
export interface Recorded2D {
  /** The marks made since the canvas was last cleared. */
  readonly marks: readonly Mark[];
  /** How many times the canvas has been cleared. */
  readonly clears: number;
  /** The scale of the transform last set. */
  readonly scale: number;
}

/** What a recording WebGL 2 context has been given, and how to lose it. */
export interface RecordedGL {
  /** The circles of the frame last drawn. */
  readonly shown: readonly Circle[];
  /** How many frames have been drawn, each starting with a clear. */
  readonly frames: number;
  /** The size of the viewport last set. */
  readonly viewportSize: readonly number[];
  /** What the context does with the shaders it is given. */
  refuses: "nothing" | "compiling" | "linking";
  /**
   * Loses the context, telling the canvas, and returns whether a listener
   * asked for it back.
   */
  lose(): boolean;
  /** Restores the context lost, telling the canvas. */
  restore(): void;
}

// Contexts by canvas. The canvases of one test's document are never another
// test's, so one map serves every install.
const contexts = new WeakMap<object, Fake2D | FakeGL>();

/** The 2D context of `canvas`, which it gives if it has given none. */
export function context2dOf(canvas: object): Recorded2D {
  const context = contexts.get(canvas) ?? new Fake2D();
  if (context.kind !== "2d") throw new Error("the canvas has a WebGL context");
  contexts.set(canvas, context);
  return context;
}

/** The WebGL 2 context `canvas` gave. */
export function webglOf(canvas: object): RecordedGL {
  const context = contexts.get(canvas);
  if (context?.kind !== "webgl2") throw new Error("the canvas gave no WebGL context");
  return context;
}

// What the WebGL context a canvas gives does with its shaders, where that is
// not to take them.
const refusals = new WeakMap<object, RecordedGL["refuses"]>();

/** Makes the WebGL context `canvas` gives, when it gives one, do `refuses` with its shaders. */
export function refuseShaders(canvas: object, refuses: RecordedGL["refuses"]): void {
  refusals.set(canvas, refuses);
}

/** Installs the fake browser; see the module's description. */
export function installBrowser(): Browser {
  return new Browser();
}

/** The fake browser a test drives. */
class Browser {
  readonly window = new Window({
    url: "http://localhost/",
    settings: {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
        disableFallbackToSetURL: true,
      },
    },
  });
  /** The page's own seconds, which move only with `frame()`. */
  time = 1000;
  /** Whether the reader asks for less motion. */
  reducedMotion = false;
  /** Each call of `open()`, with its arguments. */
  readonly opened: unknown[][] = [];
  /** How many times `location.reload()` was called. */
  reloads = 0;
  #frames = new Map<number, FrameRequestCallback>();
  #lastFrame = 0;
  #queries: { media: string; target: EventTarget }[] = [];
  #observers: { target: unknown; resized: () => void }[] = [];
  #replaced: [object, string, PropertyDescriptor | undefined][] = [];
  #listeners: [string, EventListenerOrEventListenerObject][] = [];

  constructor() {
    const { document } = this.window;
    const style = document.createElement("style");
    style.textContent =
      ":root{--text:#202020;--text-muted:#606060;--text-faint:#909090;--divider:#d0d0d0}";
    document.head.append(style);
    const replace = (target: object, name: string, value: unknown) => {
      this.#replaced.push([target, name, Object.getOwnPropertyDescriptor(target, name)]);
      Object.defineProperty(target, name, { configurable: true, writable: true, value });
    };
    const page = this.window;
    replace(page.HTMLCanvasElement.prototype, "getContext", function (this: HappyCanvas, kind: string) {
      const context = contexts.get(this) ??
        (kind === "2d" ? new Fake2D() : kind === "webgl2" ? new FakeGL(this, page) : undefined);
      if (context === undefined || context.kind !== kind) return null;
      contexts.set(this, context);
      return context;
    });
    replace(globalThis, "document", document);
    replace(globalThis, "MouseEvent", this.window.MouseEvent);
    replace(globalThis, "PointerEvent", this.window.PointerEvent);
    replace(globalThis, "MutationObserver", this.window.MutationObserver);
    replace(globalThis, "getComputedStyle", this.window.getComputedStyle.bind(this.window));
    replace(globalThis, "devicePixelRatio", 1);
    replace(globalThis, "Path2D", FakePath2D);
    replace(globalThis, "requestAnimationFrame", (callback: FrameRequestCallback) => {
      this.#frames.set(++this.#lastFrame, callback);
      return this.#lastFrame;
    });
    replace(globalThis, "cancelAnimationFrame", (id: number) => this.#frames.delete(id));
    replace(performance, "now", () => this.time * 1000);
    replace(globalThis, "matchMedia", (media: string) => {
      const target = new EventTarget();
      this.#queries.push({ media, target });
      return Object.assign(target, {
        media,
        matches: media === "(prefers-reduced-motion: reduce)" && this.reducedMotion,
      });
    });
    const observers = this.#observers;
    replace(
      globalThis,
      "ResizeObserver",
      class {
        #resized: () => void;
        constructor(resized: () => void) {
          this.#resized = resized;
        }
        observe(target: unknown): void {
          observers.push({ target, resized: this.#resized });
        }
      },
    );
    replace(globalThis, "open", (...args: unknown[]) => this.opened.push(args));
    replace(globalThis, "location", { reload: () => this.reloads++ });
    const listen = globalThis.addEventListener.bind(globalThis);
    replace(globalThis, "addEventListener", (type: string, listener: EventListenerOrEventListenerObject) => {
      this.#listeners.push([type, listener]);
      listen(type, listener);
    });
  }

  /** How many frames have been asked for and not yet drawn. */
  get framesAsked(): number {
    return this.#frames.size;
  }

  /** Sets whether the page is hidden, telling the document. */
  setHidden(hidden: boolean): void {
    const { document } = this.window;
    Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
    document.dispatchEvent(new this.window.Event("visibilitychange"));
  }

  /**
   * Moves the clock on by `seconds` and draws the frames asked for until
   * then, as a browser draws each frame.
   */
  frame(seconds = 1 / 60): void {
    this.time += seconds;
    const due = [...this.#frames.values()];
    this.#frames.clear();
    for (const callback of due) callback(this.time * 1000);
  }

  /**
   * Draws frames, `seconds` apart, until `done` returns true, or throws once
   * `limit` frames have been drawn without it.
   */
  frameUntil(done: () => boolean, limit = 1000, seconds = 1 / 30): void {
    for (let count = 0; !done(); count++) {
      if (count === limit) throw new Error(`still waiting after ${limit} frames`);
      this.frame(seconds);
    }
  }

  /**
   * Changes how many device pixels make a pixel, telling each media query
   * that watches the resolution.
   */
  rescreen(ratio: number): void {
    Object.defineProperty(globalThis, "devicePixelRatio", { value: ratio });
    for (const { media, target } of [...this.#queries]) {
      if (media.startsWith("(resolution:")) target.dispatchEvent(new Event("change"));
    }
  }

  /** Tells each observer of `target`'s size that it changed. */
  resize(target: unknown): void {
    for (const observer of this.#observers) {
      if (observer.target === target) observer.resized();
    }
  }

  /**
   * Puts back the globals the install replaced, removes the listeners added
   * to the global object, and closes the window.
   */
  uninstall(): void {
    for (const [target, name, descriptor] of this.#replaced.reverse()) {
      if (descriptor === undefined) Reflect.deleteProperty(target, name);
      else Object.defineProperty(target, name, descriptor);
    }
    for (const [type, listener] of this.#listeners) removeEventListener(type, listener);
    void this.window.happyDOM.close();
  }
}

/** A `Path2D` that keeps its circles. */
class FakePath2D {
  readonly shapes: Shape[] = [];

  moveTo(_x: number, _y: number): void {}

  arc(x: number, y: number, r: number): void {
    this.shapes.push({ kind: "circle", x, y, r });
  }
}

/** A 2D context that records the marks made on it; see the module's description. */
class Fake2D implements Recorded2D {
  readonly kind = "2d";
  fillStyle = "#000000";
  strokeStyle = "#000000";
  globalAlpha = 1;
  lineWidth = 1;
  font = "10px sans-serif";
  textAlign = "start";
  textBaseline = "alphabetic";
  marks: Mark[] = [];
  clears = 0;
  scale = 1;
  #path: Shape[] = [];
  #at: readonly number[] = [0, 0];
  #clip: readonly Shape[] | null = null;
  #saved: (readonly Shape[] | null)[] = [];

  setTransform(scale: number): void {
    this.scale = scale;
  }

  clearRect(): void {
    this.marks = [];
    this.clears++;
  }

  save(): void {
    this.#saved.push(this.#clip);
  }

  restore(): void {
    this.#clip = this.#saved.pop() ?? null;
  }

  clip(): void {
    this.#clip = this.#path;
  }

  beginPath(): void {
    this.#path = [];
  }

  arc(x: number, y: number, r: number): void {
    this.#path.push({ kind: "circle", x, y, r });
  }

  roundRect(x: number, y: number, width: number, height: number, radius: number): void {
    this.#path.push({ kind: "box", x, y, width, height, radius });
  }

  moveTo(x: number, y: number): void {
    this.#at = [x, y];
  }

  lineTo(x: number, y: number): void {
    this.#path.push({ kind: "line", from: this.#at, to: [x, y] });
    this.#at = [x, y];
  }

  fill(path?: FakePath2D): void {
    this.#mark("fill", this.fillStyle, path?.shapes ?? this.#path);
  }

  stroke(): void {
    this.#mark("stroke", this.strokeStyle, this.#path);
  }

  fillText(text: string, x: number, y: number): void {
    this.marks.push({
      kind: "text",
      text,
      x,
      y,
      color: this.fillStyle,
      alpha: this.globalAlpha,
      font: this.font,
    });
  }

  /** Measures each character as three fifths as wide as the font is high. */
  measureText(text: string): { width: number } {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10);
    return { width: text.length * size * 0.6 };
  }

  #mark(kind: "fill" | "stroke", color: string, shapes: readonly Shape[]): void {
    this.marks.push({
      kind,
      shapes: [...shapes],
      color,
      alpha: this.globalAlpha,
      lineWidth: this.lineWidth,
      clip: this.#clip,
    });
  }
}

/** A WebGL object of one life of its context. */
interface Made {
  readonly life: number;
}

/** A WebGL 2 context that records the circles drawn; see the module's description. */
class FakeGL implements RecordedGL {
  readonly kind = "webgl2";
  readonly COLOR_BUFFER_BIT = 0x4000;
  readonly ARRAY_BUFFER = 0x8892;
  readonly STREAM_DRAW = 0x88e0;
  readonly TRIANGLE_STRIP = 5;
  readonly VERTEX_SHADER = 0x8b31;
  readonly FRAGMENT_SHADER = 0x8b30;
  readonly COMPILE_STATUS = 0x8b81;
  readonly LINK_STATUS = 0x8b82;
  readonly FLOAT = 0x1406;
  readonly BLEND = 0x0be2;
  readonly ONE = 1;
  readonly ONE_MINUS_SRC_ALPHA = 0x0303;
  refuses: RecordedGL["refuses"];
  shown: Circle[] = [];
  frames = 0;
  viewportSize: number[] = [];
  #canvas: HappyCanvas;
  #window: Window;
  #lost = false;
  // Each loss ends a life of the context, and everything made in it.
  #life = 0;
  #program: Made | null = null;
  #data = new Float32Array();
  #attributes = new Map<number, { size: number; stride: number; offset: number }>();

  constructor(canvas: HappyCanvas, window: Window) {
    this.#canvas = canvas;
    this.#window = window;
    this.refuses = refusals.get(canvas) ?? "nothing";
  }

  lose(): boolean {
    this.#lost = true;
    this.#life++;
    const event = this.#dispatch("webglcontextlost", true);
    return event.defaultPrevented;
  }

  restore(): void {
    this.#lost = false;
    this.#dispatch("webglcontextrestored", false);
  }

  isContextLost(): boolean {
    return this.#lost;
  }

  createShader(type: number): Made & { type: number } {
    return { life: this.#life, type };
  }

  shaderSource(): void {}

  compileShader(): void {}

  getShaderParameter(_shader: Made, name: number): boolean {
    return name === this.COMPILE_STATUS && this.refuses !== "compiling";
  }

  getShaderInfoLog(): string {
    return "the driver refused it";
  }

  createProgram(): Made {
    return { life: this.#life };
  }

  attachShader(): void {}

  linkProgram(): void {}

  getProgramParameter(_program: Made, name: number): boolean {
    return name === this.LINK_STATUS && this.refuses !== "linking";
  }

  getProgramInfoLog(): string {
    return "the driver would not link it";
  }

  getUniformLocation(_program: Made, name: string): { name: string } {
    return { name };
  }

  createBuffer(): Made {
    return { life: this.#life };
  }

  createVertexArray(): Made {
    return { life: this.#life };
  }

  bindVertexArray(): void {}

  bindBuffer(): void {}

  enableVertexAttribArray(): void {}

  vertexAttribPointer(
    location: number,
    size: number,
    _type: number,
    _normalized: boolean,
    stride: number,
    offset: number,
  ): void {
    this.#attributes.set(location, { size, stride: stride / 4, offset: offset / 4 });
  }

  vertexAttribDivisor(): void {}

  enable(): void {}

  blendFunc(): void {}

  viewport(_x: number, _y: number, width: number, height: number): void {
    this.viewportSize = [width, height];
  }

  clearColor(): void {}

  clear(): void {
    if (this.#lost) return;
    this.shown = [];
    this.frames++;
  }

  useProgram(program: Made): void {
    this.#program = program;
  }

  uniform2f(): void {}

  uniform1f(): void {}

  bufferData(_target: number, data: Float32Array): void {
    this.#data = Float32Array.from(data);
  }

  /**
   * Draws `instances` circles from the data last given, read through the
   * attributes as they were described, unless the context is lost or the
   * program is of a life of the context before this one.
   */
  drawArraysInstanced(_mode: number, _first: number, _count: number, instances: number): void {
    if (this.#lost || this.#program?.life !== this.#life) return;
    const read = (location: number, instance: number): number[] => {
      const attribute = this.#attributes.get(location);
      if (attribute === undefined) throw new Error(`attribute ${location} was never described`);
      const at = instance * attribute.stride + attribute.offset;
      return [...this.#data.subarray(at, at + attribute.size)];
    };
    for (let instance = 0; instance < instances; instance++) {
      const [x, y, r] = read(0, instance);
      const color = `#${read(1, instance).map((part) => Math.round(part * 255).toString(16).padStart(2, "0")).join("")}`;
      const [left, top, right, bottom] = read(2, instance);
      const [radius] = read(3, instance);
      const clip = left < -1e5 ? null : { x: left, y: top, width: right - left, height: bottom - top, radius };
      this.shown.push({ x, y, r, color, clip });
    }
  }

  #dispatch(type: string, cancelable: boolean): HappyEvent {
    const event = new this.#window.Event(type, { cancelable });
    this.#canvas.dispatchEvent(event);
    return event;
  }
}
