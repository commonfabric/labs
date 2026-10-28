/**
 * Real-browser checks for `cf-avatar-input`: a picked image becomes the bytes
 * of a small square avatar, and a picked file that is not an image becomes an
 * error.
 */

import { expect } from "@std/expect";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { AVATAR_PIXELS, avatarBytesFromImage, CFAvatarInput } from "./index.ts";

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];

/**
 * A 300×200 PNG: green in the 50 pixels at each side, red in the 200×200
 * square between them.
 */
async function wideImage(): Promise<Blob> {
  const canvas = new OffscreenCanvas(300, 200);
  const context = canvas.getContext("2d")!;
  context.fillStyle = "rgb(0, 255, 0)";
  context.fillRect(0, 0, 300, 200);
  context.fillStyle = "rgb(255, 0, 0)";
  context.fillRect(50, 0, 200, 200);
  return await canvas.convertToBlob({ type: "image/png" });
}

/** The size of the image `bytes` hold, and the color of each of its corners. */
async function decode(bytes: Uint8Array<ArrayBuffer>) {
  // No type: an image's type is sniffed from its bytes.
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0);
  const last = bitmap.width - 1;
  const corners = [[1, 1], [last - 1, 1], [1, last - 1], [last - 1, last - 1]]
    .map(([x, y]) => [...context.getImageData(x, y, 1, 1).data.slice(0, 3)]);
  return { width: bitmap.width, height: bitmap.height, corners };
}

/** Whether `actual` is `expected`, within what lossy encoding changes. */
function near(actual: number[], expected: number[]): boolean {
  return actual.every((value, i) => Math.abs(value - expected[i]) <= 24);
}

/** Picks `file` in `element`'s file chooser. */
function pick(element: CFAvatarInput, file: File): void {
  const input = element.shadowRoot!.querySelector("input")!;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change"));
}

/** Resolves with the next `name` event `element` fires. */
function next(element: CFAvatarInput, name: string): Promise<CustomEvent> {
  const { promise, resolve } = Promise.withResolvers<CustomEvent>();
  element.addEventListener(name, (event) => resolve(event as CustomEvent), {
    once: true,
  });
  return promise;
}

Deno.test("avatarBytesFromImage returns the image's centered square, scaled to avatar size", async () => {
  const bytes = await avatarBytesFromImage(await wideImage());
  const { width, height, corners } = await decode(new Uint8Array(bytes));
  expect([width, height]).toEqual([AVATAR_PIXELS, AVATAR_PIXELS]);
  for (const corner of corners) {
    expect(near(corner, RED), `corner ${corner} is red`).toBe(true);
    expect(near(corner, GREEN), `corner ${corner} is green`).toBe(false);
  }
});

Deno.test("cf-avatar-input fires cf-change with avatar bytes for a picked image, and cf-error for a picked file that is not one", async () => {
  const element = new CFAvatarInput();
  document.body.append(element);
  try {
    await element.updateComplete;

    const changed = next(element, "cf-change");
    pick(element, new File([await wideImage()], "wide.png"));
    const { bytes } = (await changed).detail;
    expect(bytes).toBeInstanceOf(FabricBytes);
    const { width, corners } = await decode(bytes.slice());
    expect(width).toBe(AVATAR_PIXELS);
    expect(near(corners[0], RED)).toBe(true);

    let changedAgain = false;
    element.addEventListener("cf-change", () => changedAgain = true);
    const failed = next(element, "cf-error");
    pick(element, new File(["not an image"], "notes.txt"));
    expect((await failed).detail).toEqual({
      message: "notes.txt is not an image",
    });
    expect(changedAgain).toBe(false);
  } finally {
    element.remove();
  }
});
