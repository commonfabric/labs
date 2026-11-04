import { CFOAuth } from "./cf-oauth.ts";

if (!customElements.get("cf-oauth")) {
  customElements.define("cf-oauth", CFOAuth);
}

export type { CFOAuth as CFOAuthElement } from "./cf-oauth.ts";
export type { OAuthData } from "./cf-oauth.ts";

export * from "./cf-oauth.ts";
