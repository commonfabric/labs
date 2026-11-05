import { CFImageInput } from "./cf-image-input.ts";

if (!customElements.get("cf-image-input")) {
  customElements.define("cf-image-input", CFImageInput);
}

export type { CFImageInput as CFImageInputElement } from "./cf-image-input.ts";

export { CFImageInput };
export type { ExifData, ImageData } from "./cf-image-input.ts";
