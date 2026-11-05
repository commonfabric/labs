import { CFPlaidLink } from "./cf-plaid-link.ts";

if (!customElements.get("cf-plaid-link")) {
  customElements.define("cf-plaid-link", CFPlaidLink);
}

export type { CFPlaidLink as CFPlaidLinkElement } from "./cf-plaid-link.ts";

export * from "./cf-plaid-link.ts";
