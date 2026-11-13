import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { compressImage, formatFileSize } from "./image-compression.ts";

/**
 * An image `createImageBitmap()` decodes to, standing in for a real one, which
 * records whether it was closed.
 */
class Bitmap {
  closed = false;
  constructor(readonly width: number, readonly height: number) {}
  close() {
    this.closed = true;
  }
}

/** What `drawImage()` was given. */
interface Drawing {
  readonly bitmap: Bitmap;
  /** Where it was drawn: its left, top, width, and height. */
  readonly at: readonly number[];
  /** Whether `bitmap` was already closed when it was drawn. */
  readonly closed: boolean;
}

/** A drawing that the stand-in canvas encoded. */
interface Encoding {
  readonly drawing: Drawing | undefined;
  readonly width: number;
  readonly height: number;
  readonly type: string | undefined;
  readonly quality: number | undefined;
}

/**
 * Every encoding the stand-in canvas made, and whether its `getContext()`
 * finds a context.
 */
const canvas: { encodings: Encoding[]; hasContext: boolean } = {
  encodings: [],
  hasContext: true,
};

/**
 * Stands in for `OffscreenCanvas`: it encodes what is drawn on it to a JPEG
 * of one byte per pixel at full quality, scaled by the quality asked for, so
 * a test can work out the size any setting produces.
 */
class StandInCanvas {
  #drawing?: Drawing;
  constructor(readonly width: number, readonly height: number) {}

  getContext(_kind: "2d") {
    if (!canvas.hasContext) return null;
    return {
      drawImage: (bitmap: Bitmap, ...at: number[]) => {
        this.#drawing = { bitmap, at, closed: bitmap.closed };
      },
    };
  }

  convertToBlob(options: { type?: string; quality?: number }): Promise<Blob> {
    const { type, quality } = options;
    canvas.encodings.push({
      drawing: this.#drawing,
      width: this.width,
      height: this.height,
      type,
      quality,
    });
    const size = Math.round(this.width * this.height * (quality ?? 1));
    return Promise.resolve(new Blob([new Uint8Array(size)], { type }));
  }
}

/**
 * The bitmap the next `createImageBitmap()` decodes, the files it got, and
 * whether it fails to decode them.
 */
const decoder: { bitmap: Bitmap; files: Blob[]; fails: boolean } = {
  bitmap: new Bitmap(0, 0),
  files: [],
  fails: false,
};

/** A file of `size` bytes holding an image of `width` by `height` pixels. */
function imageFile(size: number, width: number, height: number): File {
  decoder.bitmap = new Bitmap(width, height);
  return new File([new Uint8Array(size)], "photo.png", { type: "image/png" });
}

describe("image-compression", () => {
  beforeEach(() => {
    canvas.encodings = [];
    canvas.hasContext = true;
    decoder.files = [];
    decoder.fails = false;
    Object.defineProperty(globalThis, "OffscreenCanvas", {
      configurable: true,
      value: StandInCanvas,
    });
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: (file: Blob) => {
        decoder.files.push(file);
        return decoder.fails
          ? Promise.reject(new DOMException("Bad image", "InvalidStateError"))
          : Promise.resolve(decoder.bitmap);
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "OffscreenCanvas");
    Reflect.deleteProperty(globalThis, "createImageBitmap");
  });

  describe("compressImage()", () => {
    it("returns a file already within the limit as is, without encoding it", async () => {
      const file = imageFile(1000, 640, 480);
      const result = await compressImage(file, { maxSizeBytes: 1000 });
      expect(result).toEqual({
        blob: file,
        width: 640,
        height: 480,
        quality: 1,
        originalSize: 1000,
        compressedSize: 1000,
      });
      expect(result.blob).toBe(file);
      expect(canvas.encodings).toEqual([]);
      expect(decoder.bitmap.closed).toBe(true);
    });

    it("returns the highest quality within the tolerance that fits at the largest dimension", async () => {
      // At 2048 by 1024, full quality is 2,097,152 bytes, so a limit of
      // 1,600,000 bytes fits up to a quality of about 0.763.
      const file = imageFile(5_000_000, 4096, 2048);
      const result = await compressImage(file, { maxSizeBytes: 1_600_000 });
      expect(result.width).toBe(2048);
      expect(result.height).toBe(1024);
      expect(result.quality).toBeLessThanOrEqual(1_600_000 / 2048 / 1024);
      expect(result.quality).toBeGreaterThan(1_600_000 / 2048 / 1024 - 0.05);
      expect(result.compressedSize).toBe(result.blob.size);
      expect(result.compressedSize).toBeLessThanOrEqual(1_600_000);
      expect(result.originalSize).toBe(5_000_000);
      expect(result.blob.type).toBe("image/jpeg");
      for (const { drawing, width, height } of canvas.encodings) {
        expect(drawing).toEqual({
          bitmap: decoder.bitmap,
          at: [0, 0, width, height],
          closed: false,
        });
      }
      expect(canvas.encodings.every((e) => e.type === "image/jpeg")).toBe(true);
      expect(decoder.files).toEqual([file]);
      expect(decoder.bitmap.closed).toBe(true);
    });

    it("returns the maximum quality, searching no further, where it fits", async () => {
      // At 100 by 100, the maximum quality of 0.95 is 9,500 bytes.
      const file = imageFile(5_000_000, 100, 100);
      const result = await compressImage(file, { maxSizeBytes: 9500 });
      expect(result.quality).toBe(0.95);
      expect(result.compressedSize).toBe(9500);
      expect(canvas.encodings.map((e) => e.quality)).toEqual([0.5, 0.95]);
    });

    it("returns a smaller dimension where the minimum quality does not fit a larger one", async () => {
      // 1600 by 800 at quality 0.5 is 640,000 bytes; 1200 by 600 is 360,000.
      const file = imageFile(5_000_000, 4000, 2000);
      const result = await compressImage(file, { maxSizeBytes: 500_000 });
      expect([result.width, result.height]).toEqual([1200, 600]);
      expect(result.compressedSize).toBeLessThanOrEqual(500_000);
      expect(canvas.encodings.map((e) => [e.width, e.quality]).slice(0, 2))
        .toEqual([[2048, 0.5], [1600, 0.5]]);
    });

    it("never draws an image larger than it is", async () => {
      const file = imageFile(5_000_000, 1000, 500);
      const result = await compressImage(file, { maxSizeBytes: 400_000 });
      expect([result.width, result.height]).toEqual([1000, 500]);
      expect(result.quality).toBeLessThanOrEqual(0.8);
      expect(result.quality).toBeGreaterThan(0.75);
    });

    it("returns the smallest dimension at the minimum quality where nothing fits", async () => {
      const file = imageFile(5_000_000, 4000, 3000);
      const result = await compressImage(file, {
        maxSizeBytes: 1000,
        dimensions: [400, 200],
        minQuality: 0.4,
      });
      expect(result.width).toBe(200);
      expect(result.height).toBe(150);
      expect(result.quality).toBe(0.4);
      expect(result.compressedSize).toBe(200 * 150 * 0.4);
      expect(result.compressedSize).toBeGreaterThan(1000);
      expect(canvas.encodings.map((e) => [e.width, e.quality])).toEqual([
        [400, 0.4],
        [200, 0.4],
      ]);
      expect(decoder.bitmap.closed).toBe(true);
    });

    it("returns the minimum quality, encoding no quality twice, where nothing above it fits", async () => {
      const file = imageFile(5_000_000, 100, 100);
      const result = await compressImage(file, { maxSizeBytes: 5000 });
      expect(result.quality).toBe(0.5);
      expect(result.compressedSize).toBe(5000);
      const qualities = canvas.encodings.map((e) => e.quality);
      expect(qualities[0]).toBe(0.5);
      expect(new Set(qualities).size).toBe(qualities.length);
    });

    it("returns the original file, without encoding it, where no dimensions are given", async () => {
      const file = imageFile(5_000_000, 100, 100);
      const result = await compressImage(file, {
        maxSizeBytes: 1000,
        dimensions: [],
      });
      expect(result.blob).toBe(file);
      expect(canvas.encodings).toEqual([]);
      expect(decoder.bitmap.closed).toBe(true);
    });

    describe("with a tolerance as wide as the quality range", () => {
      it("returns the maximum quality where it fits", async () => {
        const file = imageFile(5_000_000, 100, 100);
        const result = await compressImage(file, {
          maxSizeBytes: 9000,
          minQuality: 0.5,
          maxQuality: 0.9,
          qualityTolerance: 0.5,
        });
        expect(result.quality).toBe(0.9);
        expect(result.compressedSize).toBe(9000);
        expect(canvas.encodings.map((e) => e.quality)).toEqual([0.5, 0.9]);
      });

      it("returns the minimum quality where the maximum does not fit", async () => {
        const file = imageFile(5_000_000, 100, 100);
        const result = await compressImage(file, {
          maxSizeBytes: 8000,
          minQuality: 0.5,
          maxQuality: 0.9,
          qualityTolerance: 0.5,
        });
        expect(result.quality).toBe(0.5);
        expect(result.compressedSize).toBe(5000);
        expect(canvas.encodings.map((e) => e.quality)).toEqual([0.5, 0.9]);
      });
    });

    it("returns the original file when the canvas has no 2D context", async () => {
      using error = stub(console, "error");
      canvas.hasContext = false;
      const file = imageFile(5_000_000, 4000, 3000);
      const result = await compressImage(file, { maxSizeBytes: 1000 });
      expect(result.blob).toBe(file);
      expect(result).toMatchObject({
        width: 4000,
        height: 3000,
        quality: 1,
        compressedSize: 5_000_000,
      });
      expect(error.calls.length).toBe(1);
      expect(error.calls[0].args.some((arg) => arg instanceof Error)).toBe(
        true,
      );
      expect(decoder.files).toEqual([file]);
      expect(decoder.bitmap.closed).toBe(true);
    });

    it("rejects with the decoder's error, having decoded once, for a file that is not an image it can decode", async () => {
      using error = stub(console, "error");
      decoder.fails = true;
      const file = imageFile(5_000_000, 4000, 3000);
      const failure = await compressImage(file, { maxSizeBytes: 1000 }).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(failure).toBeInstanceOf(DOMException);
      expect(failure).toMatchObject({ message: "Bad image" });
      expect(decoder.files).toEqual([file]);
      expect(canvas.encodings).toEqual([]);
      expect(error.calls).toEqual([]);
    });
  });

  describe("formatFileSize()", () => {
    it("returns bytes below a kilobyte", () => {
      expect(formatFileSize(0)).toBe("0 B");
      expect(formatFileSize(1023)).toBe("1023 B");
    });

    it("returns kilobytes to one decimal below a megabyte", () => {
      expect(formatFileSize(1024)).toBe("1.0 KB");
      expect(formatFileSize(1536)).toBe("1.5 KB");
      expect(formatFileSize(1024 * 1024 - 1)).toBe("1024.0 KB");
    });

    it("returns megabytes to one decimal from a megabyte up", () => {
      expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
      expect(formatFileSize(5.25 * 1024 * 1024)).toBe("5.3 MB");
    });
  });
});
