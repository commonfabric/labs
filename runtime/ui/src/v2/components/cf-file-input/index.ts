import { CFFileInput } from "./cf-file-input.ts";

if (!customElements.get("cf-file-input")) {
  customElements.define("cf-file-input", CFFileInput);
}

export type { CFFileInput as CFFileInputElement } from "./cf-file-input.ts";

export { CFFileInput, type FileData } from "./cf-file-input.ts";
