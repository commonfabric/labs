import { CFTextarea } from "./cf-textarea.ts";

if (!customElements.get("cf-textarea")) {
  customElements.define("cf-textarea", CFTextarea);
}

export type { CFTextarea as CFTextareaElement } from "./cf-textarea.ts";

export { CFTextarea };
