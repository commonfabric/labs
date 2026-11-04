import { CFToolCall } from "./cf-tool-call.ts";

if (!customElements.get("cf-tool-call")) {
  customElements.define("cf-tool-call", CFToolCall);
}

export type { CFToolCall as CFToolCallElement } from "./cf-tool-call.ts";

export { CFToolCall } from "./cf-tool-call.ts";
