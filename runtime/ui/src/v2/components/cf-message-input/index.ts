import { CFMessageInput } from "./cf-message-input.ts";

if (!customElements.get("cf-message-input")) {
  customElements.define("cf-message-input", CFMessageInput);
}

export type { CFMessageInput as CFMessageInputElement } from "./cf-message-input.ts";

export { CFMessageInput };
