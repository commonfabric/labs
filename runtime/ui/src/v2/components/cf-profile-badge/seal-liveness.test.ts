import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createSealLiveness,
  type SealLivenessClient,
  type SealLivenessWindow,
} from "./seal-liveness.ts";

/**
 * A window whose animation frames run when the test says, whose pointer the
 * test moves, and whose reduced-motion preference the test sets.
 */
class FakeWindow implements SealLivenessWindow {
  /** The frames requested and not yet run or canceled, by handle. */
  readonly frames = new Map<number, (frameMs: number) => void>();
  readonly pointerListeners = new Set<(event: PointerEvent) => void>();
  #reducedMotion: boolean;
  #reducedMotionListeners: Array<() => void> = [];
  #nextFrame = 1;

  constructor(reducedMotion = false) {
    this.#reducedMotion = reducedMotion;
  }

  requestAnimationFrame(callback: (frameMs: number) => void): number {
    const handle = this.#nextFrame++;
    this.frames.set(handle, callback);
    return handle;
  }

  cancelAnimationFrame(handle: number): void {
    this.frames.delete(handle);
  }

  addEventListener(
    _type: "pointermove",
    listener: (event: PointerEvent) => void,
  ): void {
    this.pointerListeners.add(listener);
  }

  removeEventListener(
    _type: "pointermove",
    listener: (event: PointerEvent) => void,
  ): void {
    this.pointerListeners.delete(listener);
  }

  matchMedia(): {
    readonly matches: boolean;
    addEventListener(type: "change", listener: () => void): void;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get matches() {
        return outerThis.#reducedMotion;
      },
      addEventListener: (_type, listener) =>
        this.#reducedMotionListeners.push(listener),
    };
  }

  /** Runs the frames requested so far, at `frameMs`. */
  runFrames(frameMs: number): void {
    const due = [...this.frames.values()];
    this.frames.clear();
    for (const frame of due) frame(frameMs);
  }

  movePointer(clientX: number, clientY: number): void {
    for (const listener of this.pointerListeners) {
      listener({ clientX, clientY } as PointerEvent);
    }
  }

  setReducedMotion(on: boolean): void {
    this.#reducedMotion = on;
    for (const listener of this.#reducedMotionListeners) listener();
  }
}

/** A seal that records what the controller asks of it. */
function recordingSeal(): SealLivenessClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    updateSeal: (x, y, frameMs) => calls.push(`update ${x},${y} at ${frameMs}`),
    clearSeal: () => calls.push("clear"),
  };
}

describe("seal-liveness", () => {
  describe("createSealLiveness()", () => {
    it("starts one pointer listener and one frame for the first seal, and no more for the next", () => {
      const window = new FakeWindow();
      const liveness = createSealLiveness(window);

      liveness.register(recordingSeal());
      liveness.register(recordingSeal());

      expect(window.pointerListeners.size).toBe(1);
      expect(window.frames.size).toBe(1);
    });

    it("stops the pointer listener and the frame when the last seal unregisters, and not before", () => {
      const window = new FakeWindow();
      const liveness = createSealLiveness(window);
      const first = recordingSeal();
      const second = recordingSeal();
      liveness.register(first);
      liveness.register(second);

      liveness.unregister(first);
      expect(window.pointerListeners.size).toBe(1);
      expect(window.frames.size).toBe(1);

      liveness.unregister(second);
      expect(window.pointerListeners.size).toBe(0);
      expect(window.frames.size).toBe(0);
    });

    it("stops nothing for a seal that was never registered", () => {
      const window = new FakeWindow();
      const liveness = createSealLiveness(window);
      liveness.register(recordingSeal());

      liveness.unregister(recordingSeal());

      expect(window.pointerListeners.size).toBe(1);
      expect(window.frames.size).toBe(1);
    });

    it("hands every registered seal the cursor position each frame, and asks for the next frame", () => {
      const window = new FakeWindow();
      const liveness = createSealLiveness(window);
      const first = recordingSeal();
      const second = recordingSeal();
      liveness.register(first);
      liveness.register(second);

      window.movePointer(10, 20);
      window.runFrames(16);
      window.movePointer(30, 40);
      window.runFrames(32);

      expect(first.calls).toEqual(["update 10,20 at 16", "update 30,40 at 32"]);
      expect(second.calls).toEqual(first.calls);
      expect(window.frames.size).toBe(1);
    });

    it("places the cursor far offscreen until the pointer moves", () => {
      const window = new FakeWindow();
      const seal = recordingSeal();
      createSealLiveness(window).register(seal);

      window.runFrames(16);

      expect(seal.calls).toEqual(["update -1000000,-1000000 at 16"]);
    });

    it("asks for no further frame once the last seal unregisters during one", () => {
      const window = new FakeWindow();
      const liveness = createSealLiveness(window);
      const seal: SealLivenessClient = {
        updateSeal: () => liveness.unregister(seal),
        clearSeal: () => {},
      };
      liveness.register(seal);

      window.runFrames(16);

      expect(window.frames.size).toBe(0);
      expect(window.pointerListeners.size).toBe(0);
    });

    describe("reduced motion", () => {
      it("starts nothing while the user prefers reduced motion, and starts the loop when they stop", () => {
        const window = new FakeWindow(true);
        const liveness = createSealLiveness(window);
        const seal = recordingSeal();

        liveness.register(seal);
        expect(window.pointerListeners.size).toBe(0);
        expect(window.frames.size).toBe(0);

        window.setReducedMotion(false);
        window.runFrames(16);
        expect(window.pointerListeners.size).toBe(1);
        expect(seal.calls).toEqual(["update -1000000,-1000000 at 16"]);
      });

      it("stops the loop and clears every seal's highlight when the user turns it on", () => {
        const window = new FakeWindow();
        const liveness = createSealLiveness(window);
        const first = recordingSeal();
        const second = recordingSeal();
        liveness.register(first);
        liveness.register(second);

        window.setReducedMotion(true);

        expect(window.pointerListeners.size).toBe(0);
        expect(window.frames.size).toBe(0);
        expect(first.calls).toEqual(["clear"]);
        expect(second.calls).toEqual(["clear"]);
      });

      it("starts no loop when the user turns it off with no seal registered", () => {
        const window = new FakeWindow(true);
        createSealLiveness(window);

        window.setReducedMotion(false);

        expect(window.pointerListeners.size).toBe(0);
        expect(window.frames.size).toBe(0);
      });
    });
  });
});
