import { expect } from "@std/expect";
import type { AssetRecord } from "@commonfabric/iframe-sandbox";
import { afterEach, describe, it } from "@commonfabric/test-support/test";

import {
  announceChange,
  GuestLoadError,
  type GuestPage,
  MemoryCell,
  openGuestPage,
  patchProperty,
  readAssets,
} from "../../tools/test-support/iframe-guest.ts";

const GUEST = new URL("./guest.ts", import.meta.url);
const HTML = new URL("./guest.html", import.meta.url);

/** Every picture in `assets/`, as the pattern hands them to the guest. */
const ASSETS: AssetRecord = await readAssets(
  new URL("./assets/", import.meta.url),
);

/**
 * Stands in for the favorite canvas's 2D drawing context, which the simulated
 * document lacks. It records the source of each image drawn, and forgets them
 * when the canvas is cleared, so `shown` is what the canvas shows.
 */
class Drawing {
  readonly shown = new Set<string>();

  /** Clears the canvas, which then shows nothing. */
  clearRect(): void {
    this.shown.clear();
  }

  /** Draws `image` over whatever the canvas shows. */
  drawImage(image: HTMLImageElement): void {
    this.shown.add(image.src);
  }
}

/**
 * Holds back each image's `decode()` until the test lets go of every image
 * showing a given URL, so a test chooses which picture finishes decoding
 * first, and whether it decodes or fails.
 */
class HeldDecodes {
  readonly #held = new Map<string, PromiseWithResolvers<void>[]>();

  /** Stands for `HTMLImageElement.prototype.decode()`. */
  decode(image: HTMLImageElement): Promise<void> {
    const decoding = Promise.withResolvers<void>();
    const held = this.#held.get(image.src) ?? [];
    held.push(decoding);
    this.#held.set(image.src, held);
    announceChange();
    return decoding.promise;
  }

  /** Whether an image showing `url` is waiting to decode. */
  holds(url: string): boolean {
    return this.#held.has(url);
  }

  /** Finishes decoding every image showing `url`. */
  release(url: string): void {
    for (const { resolve } of this.#held.get(url) ?? []) resolve();
    this.#held.delete(url);
  }

  /** Fails decoding every image showing `url`, with `failure`. */
  fail(url: string, failure: Error): void {
    for (const { reject } of this.#held.get(url) ?? []) reject(failure);
    this.#held.delete(url);
  }
}

describe("iframe-donut-menu/guest", () => {
  let page: GuestPage | undefined;

  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  /**
   * Opens the menu with no favorite stored, by default, and resolves once its
   * buttons are enabled. `decodes` holds back each picture's decoding.
   */
  async function open(options: {
    state?: MemoryCell;
    decodes?: HeldDecodes;
  } = {}) {
    const state = options.state ?? new MemoryCell();
    const drawing = new Drawing();
    page = await openGuestPage({
      guest: GUEST,
      html: HTML,
      assets: ASSETS,
      resources: { state: state.resource() },
      setup: () => {
        patchProperty(HTMLCanvasElement.prototype, "getContext", {
          value: (kind: string) => kind === "2d" ? drawing : null,
        });
        const decodes = options.decodes;
        if (decodes) {
          patchProperty(HTMLImageElement.prototype, "decode", {
            value(this: HTMLImageElement) {
              return decodes.decode(this);
            },
          });
        }
      },
    });
    const opened = page;
    await opened.until(() => !button("glazed").disabled);
    return { page: opened, state, drawing };
  }

  function one<T extends Element = HTMLElement>(selector: string): T {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`Nothing matches \`${selector}\`.`);
    return element;
  }

  function button(donut: string): HTMLButtonElement {
    return one<HTMLButtonElement>(`button[data-donut="${donut}"]`);
  }

  function canvas(): HTMLCanvasElement {
    return one<HTMLCanvasElement>("#favorite");
  }

  describe("the menu", () => {
    it("shows the logo the document refers to as `cf-asset:logo`", async () => {
      await open();

      expect(one<HTMLImageElement>("#logo").getAttribute("src")).toBe(
        ASSETS.logo,
      );
    });

    it("shows each donut, in menu order, with its picture's URL", async () => {
      await open();

      expect(
        [...document.querySelectorAll("#menu li")].map((item) => [
          item.querySelector("img")?.getAttribute("src"),
          item.querySelector("img")?.alt,
          item.querySelector("button")?.textContent,
        ]),
      ).toEqual([
        [ASSETS.glazed, "Glazed", "Glazed"],
        [ASSETS.chocolate, "Chocolate", "Chocolate"],
      ]);
    });

    it("asks for a favorite when none is stored, and draws nothing", async () => {
      const { page, state, drawing } = await open();
      await page.settled();

      expect(one("#status").textContent).toBe("Choose a favorite.");
      expect(
        [button("glazed"), button("chocolate")].map((donut) =>
          donut.getAttribute("aria-pressed")
        ),
      ).toEqual(["false", "false"]);
      expect([...drawing.shown]).toEqual([]);
      expect(state.writes).toEqual([]);
    });

    it("throws for a document given no picture of a donut", async () => {
      const opening = openGuestPage({
        guest: GUEST,
        html: HTML,
        assets: { logo: ASSETS.logo },
        resources: { state: new MemoryCell().resource() },
      });

      await expect(opening).rejects.toThrow(GuestLoadError);
      await expect(opening).rejects.toThrow(
        'no asset named `"glazed"`; it carries `logo`.',
      );
    });
  });

  describe("choosing a favorite", () => {
    it("stores the donut chosen, and shows and draws it", async () => {
      const { page, state, drawing } = await open();

      button("glazed").click();
      await page.until(() => canvas().dataset.drawn === "glazed");
      await page.settled();

      expect(state.value).toEqual({ favorite: "glazed" });
      expect(one("#status").textContent).toBe("The favorite is Glazed.");
      expect(button("glazed").getAttribute("aria-pressed")).toBe("true");
      expect(button("chocolate").getAttribute("aria-pressed")).toBe("false");
      expect([...drawing.shown]).toEqual([ASSETS.glazed]);
    });

    it("replaces the favorite with the donut chosen next", async () => {
      const { page, state, drawing } = await open({
        state: new MemoryCell({ favorite: "glazed" }),
      });

      button("chocolate").click();
      await page.until(() => canvas().dataset.drawn === "chocolate");
      await page.settled();

      expect(state.value).toEqual({ favorite: "chocolate" });
      expect(one("#status").textContent).toBe("The favorite is Chocolate.");
      expect([...drawing.shown]).toEqual([ASSETS.chocolate]);
    });

    it("shows and draws a stored favorite, and writes nothing", async () => {
      const { page, state, drawing } = await open({
        state: new MemoryCell({ favorite: "chocolate" }),
      });
      await page.until(() => canvas().dataset.drawn === "chocolate");
      await page.settled();

      expect(one("#status").textContent).toBe("The favorite is Chocolate.");
      expect(button("chocolate").getAttribute("aria-pressed")).toBe("true");
      expect([...drawing.shown]).toEqual([ASSETS.chocolate]);
      expect(state.writes).toEqual([]);
    });

    it("shows and draws a favorite another session chose", async () => {
      const { page, state, drawing } = await open();

      state.value = { favorite: "glazed" };
      await page.until(() => canvas().dataset.drawn === "glazed");

      expect(one("#status").textContent).toBe("The favorite is Glazed.");
      expect([...drawing.shown]).toEqual([ASSETS.glazed]);
    });

    it("draws the latest favorite when an earlier choice's picture decodes last", async () => {
      const decodes = new HeldDecodes();
      const { page, drawing } = await open({ decodes });

      button("glazed").click();
      await page.until(() => decodes.holds(ASSETS.glazed));
      button("chocolate").click();
      await page.until(() => decodes.holds(ASSETS.chocolate));
      decodes.release(ASSETS.chocolate);
      await page.until(() => canvas().dataset.drawn === "chocolate");
      decodes.release(ASSETS.glazed);
      await page.settled();

      expect([...drawing.shown]).toEqual([ASSETS.chocolate]);
      expect(canvas().dataset.drawn).toBe("chocolate");
    });

    it("shows why a favorite's picture could not be drawn", async () => {
      const decodes = new HeldDecodes();
      const { page, drawing } = await open({ decodes });

      button("glazed").click();
      await page.until(() => decodes.holds(ASSETS.glazed));
      decodes.fail(ASSETS.glazed, new Error("The picture is corrupt."));
      const alert = one('[role="alert"]');
      await page.until(() => alert.textContent !== "");

      expect(alert.textContent).toContain("The picture is corrupt.");
      expect(one("#status").textContent).toBe("The favorite is Glazed.");
      expect([...drawing.shown]).toEqual([]);
      expect(canvas().dataset.drawn).toBe("");
    });

    it("does not show why a replaced favorite's picture could not be drawn", async () => {
      const decodes = new HeldDecodes();
      const { page, drawing } = await open({ decodes });

      button("glazed").click();
      await page.until(() => decodes.holds(ASSETS.glazed));
      button("chocolate").click();
      await page.until(() => decodes.holds(ASSETS.chocolate));
      decodes.release(ASSETS.chocolate);
      await page.until(() => canvas().dataset.drawn === "chocolate");
      decodes.fail(ASSETS.glazed, new Error("The picture is corrupt."));
      await page.settled();

      expect(one('[role="alert"]').textContent).toBe("");
      expect([...drawing.shown]).toEqual([ASSETS.chocolate]);
    });

    it("shows why a favorite could not be stored", async () => {
      const { page, state } = await open();
      state.failWrites(new Error("The menu is read-only."));

      button("glazed").click();
      const alert = one('[role="alert"]');
      await page.until(() => alert.textContent !== "");

      expect(alert.textContent).toContain("The menu is read-only.");
      expect(state.value).toBeUndefined();
    });

    it("clears why a favorite could not be stored once a favorite is drawn", async () => {
      const { page, state } = await open();
      state.failWrites(new Error("The menu is read-only."));
      button("glazed").click();
      const alert = one('[role="alert"]');
      await page.until(() => alert.textContent !== "");

      state.value = { favorite: "chocolate" };
      await page.until(() => canvas().dataset.drawn === "chocolate");

      expect(alert.textContent).toBe("");
    });
  });
});
