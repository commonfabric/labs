import type { CellHandle } from "@commonfabric/runtime-client";
import { css, html } from "lit";

import { BaseElement } from "../../core/base-element.ts";

export interface OAuthData {
  accessToken?: string;
  token?: string; // backward compat for Google
  tokenType?: string;
  scope?: string[];
  expiresIn?: number;
  refreshToken?: string;
  expiresAt?: number;
  user?: {
    email: string;
    name: string;
    picture: string;
  };
}

/**
 * CFOAuth - Generic OAuth authentication component
 *
 * Parameterized by provider name, brand color, and login endpoint.
 * Works with any OAuth2 provider that follows the shared oauth2-common pattern.
 *
 * @element cf-oauth
 *
 * @attr {CellHandle<OAuthData>} auth - Cell containing authentication data
 * @attr {string[]} scopes - Array of OAuth scopes to request
 * @attr {string} provider - Provider identifier (e.g. "google", "airtable")
 * @attr {string} providerLabel - Display name (e.g. "Google", "Airtable")
 * @attr {string} brandColor - CSS color for the auth button
 * @attr {string} loginEndpoint - API endpoint for login (e.g. "/api/integrations/airtable-oauth/login")
 * @attr {string} tokenField - Field name for access token in auth data ("accessToken" or "token")
 */
export class CFOAuth extends BaseElement {
  static override properties = {
    auth: { type: Object },
    authStatus: { type: String },
    isLoading: { type: Boolean },
    authResult: { type: Object },
    scopes: { type: Array },
    provider: { type: String },
    providerLabel: { type: String },
    brandColor: { type: String },
    loginEndpoint: { type: String },
    tokenField: { type: String },
  };

  declare auth: CellHandle<OAuthData>;
  declare authStatus: string;
  declare isLoading: boolean;
  declare authResult: Record<string, unknown> | null;
  declare scopes: string[] | undefined;
  declare provider: string;
  declare providerLabel: string;
  declare brandColor: string;
  declare loginEndpoint: string;
  declare tokenField: string;

  private _pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private _boundMessageListener: ((event: MessageEvent) => void) | null = null;

  constructor() {
    super();
    this.authStatus = "";
    this.isLoading = false;
    this.authResult = null;
    this.provider = "oauth";
    this.providerLabel = "OAuth";
    this.brandColor = "#4285f4";
    this.loginEndpoint = "";
    this.tokenField = "accessToken";
  }

  private _cleanup() {
    if (this._pollIntervalId !== null) {
      clearInterval(this._pollIntervalId);
      this._pollIntervalId = null;
    }
    if (this._boundMessageListener) {
      globalThis.removeEventListener("message", this._boundMessageListener);
      this._boundMessageListener = null;
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanup();
  }

  private getAccessToken(): string | undefined {
    const data = this.auth.get();
    if (!data) return undefined;
    return (data as Record<string, unknown>)[this.tokenField] as
      | string
      | undefined;
  }

  async handleClick() {
    if (this.isLoading) return;
    this.isLoading = true;
    this.authStatus = "Initiating OAuth flow...";
    this.authResult = null;

    const authCellId = JSON.stringify(this.auth.ref());

    const payload = {
      authCellId,
      scopes: this.scopes,
    };

    try {
      const response = await fetch(this.loginEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const resp = await response.json();
      this.authStatus = "Opening OAuth window...";

      // Clean up any previous listener/interval before creating new ones
      this._cleanup();

      const messageListener = (event: MessageEvent) => {
        if (event.origin !== globalThis.location.origin) return;

        if (event.data && event.data.type === "oauth-callback") {
          this.authResult = event.data.result;
          this.authStatus = event.data.result.success
            ? "Authentication successful!"
            : `Authentication failed: ${
              event.data.result.error || "Unknown error"
            }`;
          this.isLoading = false;
          this._cleanup();
        }
      };

      this._boundMessageListener = messageListener;
      globalThis.addEventListener("message", messageListener);

      const authWindow = globalThis.open(
        resp.url,
        "_blank",
        "width=800,height=800,left=200,top=200",
      );

      if (!authWindow) {
        this.authStatus =
          "Popup blocked by browser. Please allow popups and try again.";
        this.isLoading = false;
        this._cleanup();
        return;
      }

      this._pollIntervalId = setInterval(() => {
        if (authWindow.closed) {
          if (!this.authResult) {
            this.authStatus =
              "OAuth window closed. Authentication may not have completed.";
            this.isLoading = false;
          }
          this._cleanup();
        }
      }, 500);
    } catch (error: unknown) {
      console.error("OAuth error:", error);
      this.authStatus = `Error: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.isLoading = false;
    }
  }

  async handleLogout() {
    const emptyData: Record<string, unknown> = {
      [this.tokenField]: "",
      tokenType: "",
      scope: [],
      expiresIn: 0,
      expiresAt: 0,
      refreshToken: "",
      user: { email: "", name: "", picture: "" },
    };
    await this.auth.set(emptyData as OAuthData);
    this.requestUpdate();
  }

  override render() {
    const authData = this.auth.get();
    const hasToken = !!this.getAccessToken();
    const userEmail = authData?.user?.email;

    return html`
      <div class="oauth-wrapper">
        <div class="profile-section">
          ${userEmail && hasToken
            ? html`
              ${authData?.user?.picture
                ? html`
                  <img
                    class="profile-picture"
                    src="${authData.user.picture}"
                    alt="User profile picture"
                  />
                `
                : ""}
              <div class="user-info">
                <h2 class="user-name">
                  ${authData?.user?.name || userEmail}
                </h2>
                <p class="user-email">${userEmail}</p>
              </div>
            `
            : ""}
        </div>

        <div class="action-section">
          ${hasToken
            ? html`
              <button
                @click="${this.handleLogout}"
                class="oauth-button logout"
              >
                Logout
              </button>
            `
            : html`
              <button
                @click="${this.handleClick}"
                ?disabled="${this.isLoading}"
                class="oauth-button"
                style="background-color: ${this.brandColor}"
              >
                ${this.isLoading
                  ? "Processing..."
                  : `Authenticate with ${this.providerLabel}`}
              </button>
            `} ${this.authStatus
            ? html`
              <div class="status-message">${this.authStatus}</div>
            `
            : ""}
        </div>

        ${"" /* Auth result is persisted to the auth cell; no need to display raw JSON */}
      </div>
    `;
  }

  static override styles = [
    BaseElement.baseStyles,
    css`
      .oauth-wrapper {
        padding: var(--cf-theme-spacing-loose, 1.5rem);
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-lg, 0.5rem)
        );
        background-color: var(
          --cf-theme-color-surface,
          var(--cf-colors-white, #ffffff)
        );
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        max-width: 600px;
      }

      .profile-section {
        display: flex;
        align-items: center;
        gap: var(--cf-theme-spacing-loose, 1.25rem);
        margin-bottom: var(--cf-theme-spacing-loose, 1.5rem);
      }

      .profile-picture {
        width: 80px;
        height: 80px;
        border-radius: 50%;
        object-fit: cover;
      }

      .user-info {
        flex: 1;
      }

      .user-name {
        margin: 0;
        font-size: 1.5rem;
        color: var(--cf-theme-color-text, #111827);
        font-weight: 600;
      }

      .user-email {
        margin: 0.25rem 0 0;
        color: var(
          --cf-theme-color-text-muted,
          #6b7280
        );
      }

      .action-section {
        display: flex;
        flex-direction: column;
        gap: var(--cf-theme-spacing-normal, 1rem);
        margin-bottom: var(--cf-theme-spacing-loose, 1.5rem);
      }

      .oauth-button {
        color: white;
        border: none;
        padding: var(--cf-theme-spacing-normal, 0.75rem)
          var(--cf-theme-spacing-loose, 1.5rem);
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-md, 0.375rem)
        );
        cursor: pointer;
        font-weight: 500;
        font-size: 1rem;
        font-family: var(--cf-theme-font-family, inherit);
        transition: background-color var(--cf-theme-animation-duration, 0.2s) ease;
      }

      .oauth-button:hover {
        filter: brightness(0.9);
      }

      .oauth-button:disabled {
        background-color: var(
          --cf-theme-color-border,
          #d1d5db
        ) !important;
        cursor: not-allowed;
      }

      .status-message {
        padding: var(--cf-theme-spacing-normal, 0.75rem);
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-md, 0.375rem)
        );
        background-color: var(--cf-oauth-status-bg, #f0f4f8);
        color: var(--cf-oauth-status-color, #333);
        font-size: 0.9rem;
      }

      .oauth-button.logout {
        background-color: var(
          --cf-theme-color-error,
          var(--cf-colors-red-600, #dc2626)
        ) !important;
      }

      .oauth-button.logout:hover {
        background-color: var(
          --cf-theme-color-error,
          var(--cf-colors-red-700, #b91c1c)
        ) !important;
      }
    `,
  ];
}
