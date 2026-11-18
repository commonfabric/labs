// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { CFButton } from "../cf-button/index.ts";
import {
  AVATAR_PIXELS,
  avatarBytesFromImage,
  CFAvatarInput,
  NotAnImageError,
} from "./index.ts";

/** The bytes the stand-in canvas encodes every picture as. */
const ENCODED = new Uint8Array([1, 2, 3, 4]);

/** What the stand-in canvas was asked to do. */
interface CanvasRecord {
  /** The size of each canvas made. */
  readonly sizes: [number, number][];
  /** The arguments of each `drawImage()` call. */
  readonly draws: unknown[][];
  /** The options of each `convertToBlob()` call. */
  readonly encodings: unknown[];
}

const realOffscreenCanvas = Object.getOwnPropertyDescriptor(
  globalThis,
  "OffscreenCanvas",
)!;

/**
 * Puts a stand-in `OffscreenCanvas` in place of Deno's, which has no 2D
 * context, and returns what it records. The stand-in has a 2D context only
 * when `has2d` holds.
 */
function installCanvas(has2d = true): CanvasRecord {
  const record: CanvasRecord = { sizes: [], draws: [], encodings: [] };
  class StandInCanvas {
    constructor(width: number, height: number) {
      record.sizes.push([width, height]);
    }
    getContext(kind: string) {
      return kind === "2d" && has2d
        ? { drawImage: (...args: unknown[]) => record.draws.push(args) }
        : null;
    }
    convertToBlob(options: unknown) {
      record.encodings.push(options);
      return Promise.resolve(new Blob([ENCODED]));
    }
  }
  Object.defineProperty(globalThis, "OffscreenCanvas", {
    configurable: true,
    writable: true,
    value: StandInCanvas,
  });
  return record;
}

/** A PNG of `width` by `height` pixels, made with Deno's own canvas. */
async function png(width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("bitmaprenderer");
  return await canvas.convertToBlob({ type: "image/png" });
}

/** Resolves with the detail of the next `name` event `element` fires. */
function next(
  element: CFAvatarInput,
  name: string,
): Promise<CustomEvent["detail"]> {
  const { promise, resolve } = Promise.withResolvers<CustomEvent["detail"]>();
  element.addEventListener(name, (event) => {
    if (event instanceof CustomEvent) resolve(event.detail);
  }, { once: true });
  return promise;
}

describe("cf-avatar-input", () => {
  let image: Blob;

  beforeEach(async () => {
    image = await png(300, 200);
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "OffscreenCanvas", realOffscreenCanvas);
    document.body.replaceChildren();
  });

  describe("avatarBytesFromImage()", () => {
    it("draws the image's centered square at avatar size and returns it encoded as WebP", async () => {
      const canvas = installCanvas();

      const bytes = await avatarBytesFromImage(image);

      expect(bytes).toEqual(ENCODED);
      expect(canvas.sizes).toEqual([[AVATAR_PIXELS, AVATAR_PIXELS]]);
      expect(canvas.draws.map(([, ...rest]) => rest)).toEqual([
        [50, 0, 200, 200, 0, 0, AVATAR_PIXELS, AVATAR_PIXELS],
      ]);
      expect(canvas.encodings).toEqual([{ type: "image/webp", quality: 0.85 }]);
    });

    it("crops a tall image to its vertically centered square", async () => {
      const tall = await png(100, 160);
      const canvas = installCanvas();

      await avatarBytesFromImage(tall);

      expect(canvas.draws.map(([, ...rest]) => rest)).toEqual([
        [0, 30, 100, 100, 0, 0, AVATAR_PIXELS, AVATAR_PIXELS],
      ]);
    });

    it("closes the image it decoded once it has drawn it", async () => {
      const canvas = installCanvas();

      await avatarBytesFromImage(image);

      const [[bitmap]] = canvas.draws;
      expect(bitmap).toBeInstanceOf(ImageBitmap);
      expect(bitmap).toHaveProperty("width", 0);
    });

    it("throws `NotAnImageError` for bytes that are not an image", async () => {
      installCanvas();

      await expect(avatarBytesFromImage(new Blob(["not an image"])))
        .rejects.toThrow(NotAnImageError);
    });

    it("throws a plain error where no 2D canvas context is available", async () => {
      installCanvas(false);

      const error = await avatarBytesFromImage(image).catch((e) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(NotAnImageError);
      expect(error.message).toBe("No 2D canvas context is available");
    });
  });

  describe("CFAvatarInput", () => {
    /** The element's file input, reporting `files` as its picked files. */
    const pick = (element: CFAvatarInput, files: File[]) => {
      const input = element.shadowRoot!.querySelector("input")!;
      const values: string[] = [];
      Object.defineProperty(input, "files", { value: files });
      Object.defineProperty(input, "value", {
        get: () => values.at(-1) ?? "C:\\fakepath\\picked",
        set: (value: string) => values.push(value),
      });
      input.dispatchEvent(new Event("change"));
      return { values };
    };

    const buttonOf = (element: CFAvatarInput): CFButton =>
      element.shadowRoot!.querySelector<CFButton>("cf-button")!;

    it("registers the custom element", () => {
      expect(customElements.get("cf-avatar-input")).toBe(CFAvatarInput);
    });

    it("opens its file chooser, which accepts images, when its button is clicked", async () => {
      const element = await mount(new CFAvatarInput());
      const input = element.shadowRoot!.querySelector("input")!;
      const opened: Event[] = [];
      input.addEventListener("click", (event) => opened.push(event));

      buttonOf(element).click();

      expect(opened).toHaveLength(1);
      expect(input.type).toBe("file");
      expect(input.accept).toBe("image/*");
    });

    it("disables its button when it is disabled", async () => {
      const element = await mount(new CFAvatarInput());
      expect(buttonOf(element).disabled).toBe(false);

      element.disabled = true;
      await element.updateComplete;

      expect(element.hasAttribute("disabled")).toBe(true);
      expect(buttonOf(element).disabled).toBe(true);
    });

    it("emits `cf-change` with the avatar bytes of a picked image, disabling its button meanwhile", async () => {
      installCanvas();
      const element = await mount(new CFAvatarInput());
      const changed = next(element, "cf-change");

      const { values } = pick(element, [new File([image], "wide.png")]);
      await element.updateComplete;
      expect(buttonOf(element).disabled).toBe(true);

      const { bytes } = await changed;
      expect(bytes).toBeInstanceOf(FabricBytes);
      expect(bytes.slice()).toEqual(ENCODED);
      expect(values).toEqual([""]);
      await element.updateComplete;
      expect(buttonOf(element).disabled).toBe(false);
    });

    it("emits `cf-error` naming a picked file that is not an image", async () => {
      installCanvas();
      const element = await mount(new CFAvatarInput());
      const failed = next(element, "cf-error");
      let changes = 0;
      element.addEventListener("cf-change", () => changes++);

      pick(element, [new File(["not an image"], "notes.txt")]);

      expect(await failed).toEqual({ message: "notes.txt is not an image" });
      expect(changes).toBe(0);
    });

    it("emits `cf-error` saying an image could not be made into a picture where it cannot be drawn", async () => {
      installCanvas(false);
      const element = await mount(new CFAvatarInput());
      const failed = next(element, "cf-error");

      pick(element, [new File([image], "wide.png")]);

      expect(await failed).toEqual({
        message: "wide.png could not be made into a picture",
      });
    });

    it("leaves its input and button alone when the chooser is dismissed with no file", async () => {
      const element = await mount(new CFAvatarInput());

      const { values } = pick(element, []);
      await element.updateComplete;

      expect(values).toEqual([]);
      expect(buttonOf(element).disabled).toBe(false);
    });
  });
});
