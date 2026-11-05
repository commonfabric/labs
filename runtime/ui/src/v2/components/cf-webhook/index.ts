import { CFWebhook } from "./cf-webhook.ts";

if (!customElements.get("cf-webhook")) {
  customElements.define("cf-webhook", CFWebhook);
}

export type { CFWebhook as CFWebhookElement } from "./cf-webhook.ts";

export * from "./cf-webhook.ts";
