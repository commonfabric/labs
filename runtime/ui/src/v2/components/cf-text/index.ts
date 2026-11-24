import { CFText } from "./cf-text.ts";

if (!customElements.get("cf-text")) {
  customElements.define("cf-text", CFText);
}

export type { CFText as CFTextElement } from "./cf-text.ts";

export { CFText };
export type { TextTone, TextVariant } from "./cf-text.ts";
