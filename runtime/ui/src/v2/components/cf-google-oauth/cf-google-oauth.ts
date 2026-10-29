import { CFOAuth } from "../cf-oauth/index.ts";
import type { OAuthData } from "../cf-oauth/cf-oauth.ts";

/**
 * Re-export OAuthData as AuthData for backward compatibility.
 */
export type AuthData = OAuthData;

/**
 * CFGoogleOAuth - Google OAuth authentication component
 *
 * Thin wrapper around the generic cf-oauth component with Google-specific defaults.
 *
 * @element cf-google-oauth
 *
 * @attr {CellHandle<AuthData>} auth - Cell containing authentication data
 * @attr {string[]} scopes - Array of OAuth scopes to request
 *
 * @example
 * <cf-google-oauth .auth=${authCell} .scopes=${['email', 'profile']}></cf-google-oauth>
 */
export class CFGoogleOAuth extends CFOAuth {
  constructor() {
    super();
    this.provider = "google";
    this.providerLabel = "Google";
    this.brandColor = "#4285f4";
    this.loginEndpoint = "/api/integrations/google-oauth/login";
    this.tokenField = "token";
  }
}
