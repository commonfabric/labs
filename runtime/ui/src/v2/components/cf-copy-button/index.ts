import { CFCopyButton } from "./cf-copy-button.ts";

if (!customElements.get("cf-copy-button")) {
  customElements.define("cf-copy-button", CFCopyButton);
}

export type { CFCopyButton as CFCopyButtonElement } from "./cf-copy-button.ts";

export { CFCopyButton };
