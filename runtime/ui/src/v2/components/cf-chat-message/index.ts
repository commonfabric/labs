import { CFChatMessage } from "./cf-chat-message.ts";

if (!customElements.get("cf-chat-message")) {
  customElements.define("cf-chat-message", CFChatMessage);
}

export type { CFChatMessage as CFChatMessageElement } from "./cf-chat-message.ts";

export { CFChatMessage };
