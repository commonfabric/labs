import { CFIframe } from "./cf-iframe.ts";

if (!customElements.get("cf-iframe")) {
  customElements.define("cf-iframe", CFIframe);
}

export type { CFIframe as CFIframeElement } from "./cf-iframe.ts";

export * from "./cf-iframe.ts";
export * from "./cell-bridge.ts";
