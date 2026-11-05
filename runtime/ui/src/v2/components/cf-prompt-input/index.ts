import { CFPromptInput } from "./cf-prompt-input.ts";

if (!customElements.get("cf-prompt-input")) {
  customElements.define("cf-prompt-input", CFPromptInput);
}

export type { CFPromptInput as CFPromptInputElement } from "./cf-prompt-input.ts";

export * from "./cf-prompt-input.ts";
