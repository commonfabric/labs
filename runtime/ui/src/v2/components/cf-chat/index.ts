import { CFChat } from "./cf-chat.ts";

if (!customElements.get("cf-chat")) {
  customElements.define("cf-chat", CFChat);
}

export type { CFChat as CFChatElement } from "./cf-chat.ts";

export { CFChat } from "./cf-chat.ts";
