// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { RuntimeClient } from "@commonfabric/runtime-client";
import { CFImageInput, type ImageData } from "./index.ts";

/** A 1x1 PNG, which `createImageBitmap()` decodes. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

/**
 * The `Image` the component reads dimensions with. Neither Deno nor happy-dom
 * decodes one, so this stand-in loads whatever `src` it is given at the size
 * in `loads`, or fails when that is `"error"`.
 */
class LoadingImage {
  static loads: { width: number; height: number } | "error" = {
    width: 640,
    height: 480,
  };
  static sources: string[] = [];

  width = 0;
  height = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(url: string) {
    LoadingImage.sources.push(url);
    queueMicrotask(() => {
      const loads = LoadingImage.loads;
      if (loads === "error") {
        this.onerror?.();
      } else {
        Object.assign(this, loads);
        this.onload?.();
      }
    });
  }
}

/**
 * The canvas `compressImage()` draws on. Deno's has no 2D context, so this
 * stand-in encodes every drawing as `encoded`.
 */
class EncodingCanvas {
  static encoded = new Blob(["tiny"]);

  getContext() {
    return { drawImage() {} };
  }

  convertToBlob(): Promise<Blob> {
    return Promise.resolve(EncodingCanvas.encoded);
  }
}

/** Replaces the global `name` with `value` until the returned restore. */
function replaceGlobal(name: string, value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  };
}

/** A runtime that records each uploaded blob's bytes. */
function fakeRuntime() {
  const uploads: Uint8Array[] = [];
  const fake = {
    uploads,
    hold: undefined as Promise<void> | undefined,
    runtime: {
      uploadBlob: async (options) => {
        await fake.hold;
        uploads.push(
          options.body instanceof Uint8Array
            ? options.body.slice()
            : new Uint8Array(options.body),
        );
        return { id: `blob-${uploads.length}`, url: `blobs/${options.name}` };
      },
    } as Pick<RuntimeClient, "uploadBlob"> as RuntimeClient,
  };
  return fake;
}

/**
 * A `CFImageInput` that keeps the work each change of its file input starts,
 * so that a test can wait for it to finish.
 */
class WatchedImageInput extends CFImageInput {
  readonly changes: Promise<void>[] = [];

  protected override _handleFileChange(event: Event): Promise<void> {
    const change = super._handleFileChange(event);
    this.changes.push(change);
    return change;
  }
}
customElements.define("watched-image-input", WatchedImageInput);

describe("CFImageInput", () => {
  let restores: (() => void)[];

  beforeEach(() => {
    LoadingImage.loads = { width: 640, height: 480 };
    LoadingImage.sources = [];
    EncodingCanvas.encoded = new Blob(["tiny"]);
    restores = [
      replaceGlobal("Image", LoadingImage),
      replaceGlobal("OffscreenCanvas", EncodingCanvas),
    ];
  });

  afterEach(() => {
    document.body.replaceChildren();
    for (const restore of restores) restore();
  });

  function mountInput(
    properties: Partial<
      Pick<
        CFImageInput,
        "runtime" | "multiple" | "maxImages" | "maxSizeBytes" | "capture"
      >
    > = {},
  ): Promise<WatchedImageInput> {
    return mount(
      Object.assign(new WatchedImageInput(), {
        space: "did:key:z6Mk-image-input-test",
        ...properties,
      }),
    );
  }

  function fileInput(element: CFImageInput): HTMLInputElement {
    return element.shadowRoot!.querySelector('input[type="file"]')!;
  }

  /**
   * Picks `files` in the element's file input, as the file picker does, and
   * resolves once the element has handled them.
   */
  function pick(element: WatchedImageInput, files: File[]): Promise<void> {
    const input = fileInput(element);
    const before = element.changes.length;
    input.files = Object.assign(new FileList(), files);
    input.dispatchEvent(new Event("change"));
    expect(element.changes).toHaveLength(before + 1);
    return element.changes[before];
  }

  /** The details of every `type` event the element dispatches from now on. */
  function record<T>(element: CFImageInput, type: string): T[] {
    const details: T[] = [];
    element.addEventListener(
      type,
      (event) => details.push((event as CustomEvent<T>).detail),
    );
    return details;
  }

  type Change = {
    files: ImageData[];
    allFiles: ImageData[];
    images: ImageData[];
    allImages: ImageData[];
  };

  const png = (name = "cat.png") =>
    new File([PNG], name, { type: "image/png" });

  describe("rendering", () => {
    it("renders the image defaults on the button and the input", async () => {
      const element = await mountInput();

      expect(
        element.shadowRoot!.querySelector("cf-button")!.textContent!.trim(),
      ).toBe("📷 Add Photo");
      expect(fileInput(element).getAttribute("accept")).toBe("image/*");
      expect(element.maxSizeBytes).toBe(5 * 1024 * 1024);
    });

    it("renders `capture` on the input when it names a camera", async () => {
      const element = await mountInput({ capture: "environment" });

      expect(fileInput(element).getAttribute("capture")).toBe("environment");
    });

    it("renders no `capture` when it is `false` or unset", async () => {
      const off = await mountInput({ capture: false });
      const unset = await mountInput();

      expect(fileInput(off).hasAttribute("capture")).toBe(false);
      expect(fileInput(unset).hasAttribute("capture")).toBe(false);
    });

    it("renders `Processing images...` while images upload", async () => {
      const fake = fakeRuntime();
      const element = await mountInput({ runtime: fake.runtime });
      const upload = Promise.withResolvers<void>();
      fake.hold = upload.promise;

      const picked = pick(element, [png()]);
      await element.updateComplete;

      expect(element.shadowRoot!.querySelector(".loading")!.textContent)
        .toBe("Processing images...");
      upload.resolve();
      await picked;
      await element.updateComplete;
      expect(element.shadowRoot!.querySelector(".loading")).toBeNull();
    });

    it("renders every preview as an `<img>`, whatever its type", async () => {
      const element = await mountInput({ runtime: fakeRuntime().runtime });

      await pick(element, [new File([PNG], "scan.bin")]);
      await element.updateComplete;

      const img = element.shadowRoot!.querySelector(".preview-item img")!;
      expect(img.getAttribute("src")).toBe("blobs/scan.bin");
      expect(element.shadowRoot!.querySelector(".file-preview")).toBeNull();
    });
  });

  describe("maxImages", () => {
    it("reads and writes `maxFiles`", () => {
      const element = new CFImageInput();

      element.maxImages = 3;

      expect(element.maxFiles).toBe(3);
      element.maxFiles = 4;
      expect(element.maxImages).toBe(4);
    });

    it("dispatches `cf-error` for a pick that would pass it", async () => {
      const fake = fakeRuntime();
      const element = await mountInput({
        runtime: fake.runtime,
        multiple: true,
        maxImages: 1,
      });
      const failures = record<{ message: string }>(element, "cf-error");

      await pick(element, [png("a.png"), png("b.png")]);

      expect(failures.map(({ message }) => message)).toEqual([
        "Maximum 1 files allowed",
      ]);
      expect(fake.uploads).toEqual([]);
    });
  });

  describe("processing an image", () => {
    it("stores the image with the dimensions it loads at", async () => {
      const fake = fakeRuntime();
      const element = await mountInput({ runtime: fake.runtime });
      const changes = record<Change>(element, "cf-change");

      await pick(element, [png()]);

      const [image] = changes[0].files;
      expect(image).toMatchObject({ name: "cat.png", width: 640, height: 480 });
      // The object URL the image loaded from is released once it has.
      expect(LoadingImage.sources).toHaveLength(1);
      await expect(fetch(LoadingImage.sources[0])).rejects.toThrow();
    });

    it("dispatches `cf-error`, and stores nothing, when the image fails to load", async () => {
      LoadingImage.loads = "error";
      const fake = fakeRuntime();
      const element = await mountInput({ runtime: fake.runtime });
      const failures = record<{ error: Error; message: string }>(
        element,
        "cf-error",
      );

      await pick(element, [png()]);

      expect(failures).toHaveLength(1);
      const detail = failures[0];
      expect(detail.error.message).toBe("Failed to load image");
      expect(detail.message).toBe("Failed to process cat.png");
      expect(Object.keys(detail)).toEqual(["error", "message"]);
      expect(fake.uploads).toEqual([]);
      await expect(fetch(LoadingImage.sources[0])).rejects.toThrow();
    });
  });

  describe("compression", () => {
    it("uploads an image within `maxSizeBytes` as it is", async () => {
      using log = stub(console, "log");
      const fake = fakeRuntime();
      const element = await mountInput({
        runtime: fake.runtime,
        maxSizeBytes: PNG.length,
      });

      await pick(element, [png()]);

      expect(fake.uploads).toEqual([PNG]);
      expect(log.calls).toEqual([]);
    });

    it("uploads the compressed bytes of an image over `maxSizeBytes`", async () => {
      using log = stub(console, "log");
      using warn = stub(console, "warn");
      const fake = fakeRuntime();
      const element = await mountInput({
        runtime: fake.runtime,
        maxSizeBytes: 10,
      });
      const changes = record<Change>(element, "cf-change");

      await pick(element, [png()]);

      const [image] = changes[0].files;
      expect(fake.uploads).toEqual([new TextEncoder().encode("tiny")]);
      expect(image.size).toBe(4);
      expect(log.calls.map((call) => call.args[0])).toEqual([
        `Compressed cat.png: ${PNG.length} B → 4 B (1x1, q0.92)`,
      ]);
      expect(warn.calls).toEqual([]);
    });

    it("warns, and uploads the smallest attempt, when compression cannot reach `maxSizeBytes`", async () => {
      using _log = stub(console, "log");
      using warn = stub(console, "warn");
      EncodingCanvas.encoded = new Blob(["x".repeat(20)]);
      const fake = fakeRuntime();
      const element = await mountInput({
        runtime: fake.runtime,
        maxSizeBytes: 10,
      });

      await pick(element, [png()]);

      expect(fake.uploads).toEqual([new TextEncoder().encode("x".repeat(20))]);
      expect(warn.calls.map((call) => call.args[0])).toEqual([
        "Could not compress cat.png below 10 B. Final size: 20 B",
        "File cat.png (20 B) exceeds maxSizeBytes (10 B) even after compression",
      ]);
    });
  });

  describe("events", () => {
    it("adds `images` and `allImages` to `cf-change`", async () => {
      const element = await mountInput({
        runtime: fakeRuntime().runtime,
        multiple: true,
      });
      const changes = record<Change>(element, "cf-change");

      await pick(element, [png("a.png"), png("b.png")]);

      expect(changes).toHaveLength(1);
      const detail = changes[0];
      expect(detail.images).toEqual(detail.files);
      expect(detail.allImages).toEqual(detail.allFiles);
      expect(detail.images.map((image) => image.name)).toEqual([
        "a.png",
        "b.png",
      ]);
    });

    it("adds `images` and `allImages` to `cf-remove`", async () => {
      const element = await mountInput({
        runtime: fakeRuntime().runtime,
        multiple: true,
      });
      await pick(element, [png("a.png"), png("b.png")]);
      await element.updateComplete;
      const removals = record<Change>(element, "cf-remove");

      element.shadowRoot!.querySelector<HTMLElement>(".remove-button")!
        .click();

      expect(removals).toHaveLength(1);
      const detail = removals[0];
      expect(detail.images.map((image) => image.name)).toEqual(["b.png"]);
      expect(detail.allImages).toEqual(detail.images);
    });
  });
});
