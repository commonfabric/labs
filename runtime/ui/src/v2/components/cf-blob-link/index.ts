import { CFBlobLink } from "./cf-blob-link.ts";

if (!customElements.get("cf-blob-link")) {
  customElements.define("cf-blob-link", CFBlobLink);
}

export { CFBlobLink };
export type { CFBlobLink as CFBlobLinkElement } from "./cf-blob-link.ts";
