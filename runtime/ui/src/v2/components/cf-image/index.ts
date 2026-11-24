import { CFImage } from "./cf-image.ts";

if (!customElements.get("cf-image")) {
  customElements.define("cf-image", CFImage);
}

export { CFImage };
export type { CFImage as CFImageElement } from "./cf-image.ts";
