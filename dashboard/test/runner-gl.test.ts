import { expect } from "@std/expect";
import { BallRenderer, type Clip } from "../runner-gl.ts";
import { context2dOf, installBrowser, type Mark, refuseShaders, webglOf } from "./fake-browser.ts";
import { afterEach, beforeEach, describe, it } from "@commonfabric/test-support/test";

const RED = "#ff0000";
const BLUE = "#0000ff";
const CLIP: Clip = { x: 20, y: 20, width: 60, height: 40, radius: 15 };

// The circles filled on a 2D context, each with its color and the path it
// was clipped to.
function filled(marks: readonly Mark[]): unknown[] {
  return marks.flatMap((mark) => mark.kind === "fill" ? mark.shapes.map((shape) => ({ shape, color: mark.color, clip: mark.clip })) : []);
}

// A canvas in a holder of its own, with an ID, a class, and a style, and what
// holds it.
function heldCanvas(): { canvas: HTMLCanvasElement; holder: HTMLElement } {
  const holder = document.createElement("div");
  const canvas = document.createElement("canvas");
  canvas.id = "balls";
  canvas.className = "layer";
  canvas.style.opacity = "0.9";
  holder.append(canvas);
  document.body.append(holder);
  return { canvas, holder };
}

// The canvas that has taken `canvas`'s place in `holder`.
function successor(holder: HTMLElement, canvas: HTMLCanvasElement): HTMLCanvasElement {
  const fresh = holder.querySelector("canvas");
  if (fresh === null || fresh === canvas) throw new Error("no canvas took the first's place");
  expect(holder.children).toHaveLength(1);
  expect([fresh.id, fresh.className, fresh.getAttribute("style")]).toEqual(["balls", "layer", "opacity: 0.9;"]);
  return fresh;
}

// Runs `body` with `console.error` recording what it is given, and returns
// each message.
function errorsDuring(body: () => void): string[] {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    body();
  } finally {
    console.error = original;
  }
  return errors;
}

describe("BallRenderer", () => {
  let browser: ReturnType<typeof installBrowser>;
  beforeEach(() => {
    browser = installBrowser();
  });
  afterEach(() => browser.uninstall());

  describe("constructor()", () => {
    it("draws with WebGL on a canvas that gives a WebGL 2 context", () => {
      expect(new BallRenderer(document.createElement("canvas")).accelerated).toBe(true);
    });

    it("draws with the 2D context on a canvas that gives no WebGL 2 context", () => {
      const canvas = document.createElement("canvas");
      context2dOf(canvas);
      expect(new BallRenderer(canvas).accelerated).toBe(false);
    });

    it("asks for a WebGL context back when it is lost", () => {
      const canvas = document.createElement("canvas");
      new BallRenderer(canvas);
      expect(webglOf(canvas).lose()).toBe(true);
    });

    for (const [refuses, complaint] of [["compiling", "did not compile"], ["linking", "did not link"]] as const) {
      it(`draws with the 2D context, on a canvas that takes the first's place, when WebGL refuses ${refuses} its shaders`, () => {
        const { canvas, holder } = heldCanvas();
        refuseShaders(canvas, refuses);
        let balls: BallRenderer | undefined;
        const errors = errorsDuring(() => {
          balls = new BallRenderer(canvas);
        });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain("runners page: drawing with WebGL failed:");
        expect(errors[0]).toContain(complaint);
        expect(balls?.accelerated).toBe(false);
        const fresh = successor(holder, canvas);
        balls?.add(30, 40, 15, RED, null);
        balls?.draw(100, 80, 1);
        expect([fresh.width, fresh.height]).toEqual([100, 80]);
        expect(filled(context2dOf(fresh).marks)).toEqual([
          { shape: { kind: "circle", x: 30, y: 40, r: 15 }, color: RED, clip: null },
        ]);
        expect(webglOf(canvas).shown).toEqual([]);
      });
    }
  });

  describe("instance members", () => {
    describe("draw()", () => {
      describe("with WebGL", () => {
        it("draws each circle added, in its color, cut to its clip", () => {
          const canvas = document.createElement("canvas");
          const balls = new BallRenderer(canvas);
          balls.add(30, 40, 15, RED, null);
          balls.add(70, 40, 10, BLUE, CLIP);
          balls.add(50, 20, 5, RED, CLIP);
          balls.draw(100, 80, 1);
          expect(webglOf(canvas).shown).toEqual([
            { x: 30, y: 40, r: 15, color: RED, clip: null },
            { x: 70, y: 40, r: 10, color: BLUE, clip: CLIP },
            { x: 50, y: 20, r: 5, color: RED, clip: CLIP },
          ]);
        });

        it("clears what it drew before, drawing only what was added since", () => {
          const canvas = document.createElement("canvas");
          const balls = new BallRenderer(canvas);
          balls.add(30, 40, 15, RED, null);
          balls.draw(100, 80, 1);
          balls.add(70, 40, 10, BLUE, null);
          balls.draw(100, 80, 1);
          const gl = webglOf(canvas);
          expect(gl.shown).toEqual([{ x: 70, y: 40, r: 10, color: BLUE, clip: null }]);
          balls.draw(100, 80, 1);
          expect(gl.shown).toEqual([]);
          expect(gl.frames).toBe(3);
        });

        it("draws on a canvas, and in a viewport, sized to the scale it is given", () => {
          const canvas = document.createElement("canvas");
          const balls = new BallRenderer(canvas);
          balls.add(30, 20, 5, RED, null);
          balls.draw(50, 40.2, 2);
          expect([canvas.width, canvas.height]).toEqual([100, 80]);
          expect(webglOf(canvas).viewportSize).toEqual([100, 80]);
          balls.draw(50, 40, 1);
          expect([canvas.width, canvas.height]).toEqual([50, 40]);
        });

        it("draws every circle of a frame with more than a few hundred", () => {
          const canvas = document.createElement("canvas");
          const balls = new BallRenderer(canvas);
          const circles = Array.from({ length: 600 }, (_, i) => ({
            x: 5 + (i % 30) * 10,
            y: 5 + Math.floor(i / 30) * 10,
            r: 3,
            color: i % 2 === 0 ? RED : BLUE,
            clip: null,
          }));
          for (const { x, y, r, color } of circles) balls.add(x, y, r, color, null);
          balls.draw(300, 200, 1);
          expect(webglOf(canvas).shown).toEqual(circles);
        });

        it("draws nothing while its context is lost, and draws again once it is restored", () => {
          const canvas = document.createElement("canvas");
          const balls = new BallRenderer(canvas);
          const gl = webglOf(canvas);
          gl.lose();
          balls.add(30, 40, 15, RED, null);
          balls.draw(100, 80, 1);
          expect(gl.frames).toBe(0);
          gl.restore();
          balls.add(30, 40, 15, RED, null);
          balls.draw(100, 80, 1);
          expect(gl.shown).toEqual([{ x: 30, y: 40, r: 15, color: RED, clip: null }]);
        });

        it("draws nothing on a context lost before it was made until the context is restored", () => {
          const canvas = document.createElement("canvas");
          canvas.getContext("webgl2");
          const gl = webglOf(canvas);
          gl.lose();
          const balls = new BallRenderer(canvas);
          expect(balls.accelerated).toBe(true);
          gl.restore();
          balls.add(30, 40, 15, RED, null);
          balls.draw(100, 80, 1);
          expect(gl.shown).toEqual([{ x: 30, y: 40, r: 15, color: RED, clip: null }]);
        });

        it("draws nothing on a context lost before it was made while the context stays lost", () => {
          const canvas = document.createElement("canvas");
          canvas.getContext("webgl2");
          const gl = webglOf(canvas);
          gl.lose();
          const balls = new BallRenderer(canvas);
          balls.add(30, 40, 15, RED, null);
          balls.draw(100, 80, 1);
          expect(gl.shown).toEqual([]);
          expect(gl.frames).toBe(0);
        });

        it("draws with the 2D context, on a canvas that takes the first's place, when WebGL refuses its shaders once restored", () => {
          const { canvas, holder } = heldCanvas();
          const balls = new BallRenderer(canvas);
          const gl = webglOf(canvas);
          gl.lose();
          gl.refuses = "compiling";
          const errors = errorsDuring(() => gl.restore());
          expect(errors).toHaveLength(1);
          expect(balls.accelerated).toBe(false);
          const fresh = successor(holder, canvas);
          balls.add(30, 40, 15, RED, null);
          balls.draw(100, 80, 1);
          expect(filled(context2dOf(fresh).marks)).toEqual([
            { shape: { kind: "circle", x: 30, y: 40, r: 15 }, color: RED, clip: null },
          ]);
        });
      });

      describe("with the 2D context", () => {
        // A canvas whose 2D context is already taken gives no WebGL context.

        function renderer(): { canvas: HTMLCanvasElement; balls: BallRenderer } {
          const canvas = document.createElement("canvas");
          context2dOf(canvas);
          return { canvas, balls: new BallRenderer(canvas) };
        }

        it("fills each circle added in its color, those with a clip within it", () => {
          const { canvas, balls } = renderer();
          balls.add(30, 40, 15, RED, null);
          balls.add(70, 40, 10, BLUE, CLIP);
          balls.add(50, 20, 5, BLUE, CLIP);
          balls.add(10, 10, 2, RED, null);
          balls.draw(100, 80, 1);
          const box = { kind: "box", ...CLIP };
          expect(filled(context2dOf(canvas).marks)).toEqual([
            { shape: { kind: "circle", x: 30, y: 40, r: 15 }, color: RED, clip: null },
            { shape: { kind: "circle", x: 10, y: 10, r: 2 }, color: RED, clip: null },
            { shape: { kind: "circle", x: 70, y: 40, r: 10 }, color: BLUE, clip: [box] },
            { shape: { kind: "circle", x: 50, y: 20, r: 5 }, color: BLUE, clip: [box] },
          ]);
        });

        it("clears what it drew before, drawing only what was added since, at the scale it is given", () => {
          const { canvas, balls } = renderer();
          balls.add(30, 40, 15, RED, null);
          balls.draw(100, 80, 1);
          balls.add(70, 40, 10, BLUE, null);
          balls.draw(50, 40, 2);
          const context = context2dOf(canvas);
          expect(filled(context.marks)).toEqual([
            { shape: { kind: "circle", x: 70, y: 40, r: 10 }, color: BLUE, clip: null },
          ]);
          expect([canvas.width, canvas.height, context.scale]).toEqual([100, 80, 2]);
          balls.draw(50, 40, 2);
          expect(context.marks).toEqual([]);
          expect(context.clears).toBe(3);
        });
      });
    });
  });
});
