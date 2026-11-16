// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import { CFLoader } from "./index.ts";

/**
 * Animation frames the loader asks for, run when the test says. The
 * document's own frames run on real timers, which the fake clock cannot
 * reach, and the loader asks for a frame from every frame, so this replaces
 * them and restores the document's afterwards.
 */
function installFrames() {
  const pending = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  const globals: Record<string, unknown> = {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      pending.set(nextId, callback);
      return nextId++;
    },
    cancelAnimationFrame: (id: number) => pending.delete(id),
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  return {
    /** How many frames are waiting to run. */
    get pending(): number {
      return pending.size;
    },
    /** Runs the frames requested so far, as the browser's next frame does. */
    run(): void {
      const due = [...pending.values()];
      pending.clear();
      for (const callback of due) callback(0);
    },
    restore(): void {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

/** A loader mounted with `properties`. */
function loaderWith(
  properties: Partial<Pick<CFLoader, "showElapsed" | "showStop">> = {},
): Promise<CFLoader> {
  return mount(Object.assign(new CFLoader(), properties));
}

const part = (loader: CFLoader, name: string) =>
  loader.shadowRoot!.querySelector<HTMLElement>(`[part="${name}"]`);

describe("CFLoader", () => {
  let frames: ReturnType<typeof installFrames>;
  let time: FakeTime;
  beforeEach(() => {
    frames = installFrames();
    time = new FakeTime(1_000_000);
  });
  afterEach(() => {
    document.body.replaceChildren();
    time.restore();
    frames.restore();
  });

  /** Lets `ms` pass, runs the frame due, and waits for what it renders. */
  const after = async (loader: CFLoader, ms: number) => {
    time.tick(ms);
    frames.run();
    await loader.updateComplete;
  };

  describe("render()", () => {
    it("shows a spinner labelled for assistive technology and nothing else by default", async () => {
      const loader = await loaderWith();

      expect(part(loader, "spinner")?.getAttribute("role")).toBe("status");
      expect(loader.shadowRoot!.querySelector(".sr-only")?.textContent).toBe(
        "Loading",
      );
      expect(part(loader, "elapsed") === null).toBe(true);
      expect(part(loader, "stop") === null).toBe(true);
    });

    it("reflects its size", async () => {
      const loader = await loaderWith();
      expect(loader.getAttribute("size")).toBe("md");

      loader.size = "lg";
      await loader.updateComplete;

      expect(loader.getAttribute("size")).toBe("lg");
    });
  });

  describe("stop button", () => {
    it("emits `cf-stop` and keeps the click from going further", async () => {
      const loader = await loaderWith({ showStop: true });
      let stops = 0;
      let clicksOnHost = 0;
      loader.addEventListener("cf-stop", () => stops++);
      loader.addEventListener("click", () => clicksOnHost++);
      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
      });

      part(loader, "stop")!.dispatchEvent(click);

      expect(stops).toBe(1);
      expect(click.defaultPrevented).toBe(true);
      expect(clicksOnHost).toBe(0);
    });
  });

  describe("elapsed time", () => {
    it("counts whole seconds from when the loader appeared while under a minute", async () => {
      const loader = await loaderWith({ showElapsed: true });
      expect(part(loader, "elapsed")?.textContent).toBe("0s");

      await after(loader, 5_999);

      expect(part(loader, "elapsed")?.textContent).toBe("5s");
    });

    it("counts minutes and seconds from a minute on", async () => {
      const loader = await loaderWith({ showElapsed: true });

      await after(loader, 125_000);

      expect(part(loader, "elapsed")?.textContent).toBe("2m 5s");
    });

    it("asks for a frame after each frame, and for only one at a time", async () => {
      const loader = await loaderWith({ showElapsed: true });
      expect(frames.pending).toBe(1);

      await after(loader, 1_000);

      expect(frames.pending).toBe(1);
    });

    it("starts counting when `showElapsed` is set, and stops when it is cleared", async () => {
      const loader = await loaderWith();
      expect(frames.pending).toBe(0);

      loader.showElapsed = true;
      await loader.updateComplete;
      expect(frames.pending).toBe(1);

      loader.showElapsed = false;
      await loader.updateComplete;
      expect(frames.pending).toBe(0);
      expect(part(loader, "elapsed") === null).toBe(true);
    });

    it("stops counting when the loader leaves the document", async () => {
      const loader = await loaderWith({ showElapsed: true });

      loader.remove();

      expect(frames.pending).toBe(0);
    });

    it("leaves the timer alone for a change to anything else", async () => {
      const loader = await loaderWith({ showElapsed: true });

      loader.showStop = true;
      await loader.updateComplete;

      expect(frames.pending).toBe(1);
    });

    it("counts from zero again after `resetTimer()`", async () => {
      const loader = await loaderWith({ showElapsed: true });
      await after(loader, 7_000);
      expect(part(loader, "elapsed")?.textContent).toBe("7s");

      loader.resetTimer();
      loader.requestUpdate();
      await loader.updateComplete;
      expect(part(loader, "elapsed")?.textContent).toBe("0s");

      await after(loader, 2_000);
      expect(part(loader, "elapsed")?.textContent).toBe("2s");
    });
  });
});
