import { CFGoogleOAuth } from "./cf-google-oauth.ts";

if (!customElements.get("cf-google-oauth")) {
  customElements.define("cf-google-oauth", CFGoogleOAuth);
}

export type { CFGoogleOAuth as CFGoogleOAuthElement } from "./cf-google-oauth.ts";

export * from "./cf-google-oauth.ts";
