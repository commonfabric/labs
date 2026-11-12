import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { CellHandle } from "@commonfabric/runtime-client";
import { css, html } from "lit";

import { BaseElement } from "../../core/base-element.ts";

declare global {
  var Plaid: PlaidLink | undefined;
}

/** Plaid's Link SDK, which its script installs as `globalThis.Plaid`. */
export interface PlaidLink {
  create(config: PlaidLinkConfig): PlaidLinkHandler;
}

/** What `Plaid.create()` takes: the link token and Link's callbacks. */
export interface PlaidLinkConfig {
  token: string;
  onSuccess(publicToken: string, metadata: unknown): void;
  onExit(error: PlaidLinkError | null, metadata: unknown): void;
  onEvent(
    eventName: string,
    metadata: { institution_name?: string | null },
  ): void;
}

/** The error Link hands `onExit` when the user did not finish. */
export interface PlaidLinkError {
  error_message?: string | null;
  display_message?: string | null;
}

/** An open-able Link flow, as `Plaid.create()` returns it. */
export interface PlaidLinkHandler {
  open(): void;
  destroy(): void;
}

/** What the element reaches outside itself for. */
export interface PlaidLinkEnvironment {
  fetch(input: string, init: RequestInit): Promise<Response>;
  loadPlaid(): Promise<PlaidLink>;
}

const PLAID_LINK_SCRIPT =
  "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

/** The part of a document that `loadPlaidLink()` finds or adds a script in. */
export interface ScriptDocument {
  querySelector(selectors: string): Element | null;
  createElement(tagName: "script"): HTMLScriptElement;
  readonly head: { appendChild(node: Node): unknown };
}

/**
 * Loads Plaid's Link script into `document`, unless it is there already, and
 * resolves with the SDK it installs on `scope`. Rejects when the script fails
 * to load or installs nothing.
 */
export function loadPlaidLink(
  document: ScriptDocument,
  scope: { readonly Plaid?: PlaidLink } = globalThis,
): Promise<PlaidLink> {
  if (scope.Plaid) return Promise.resolve(scope.Plaid);

  let script = document.querySelector(
    'script[src*="plaid.com/link/v2/stable/link-initialize.js"]',
  );
  if (!script) {
    const created = document.createElement("script");
    created.src = PLAID_LINK_SCRIPT;
    created.async = true;
    document.head.appendChild(created);
    script = created;
  }
  return new Promise((resolve, reject) => {
    const settle = () =>
      scope.Plaid
        ? resolve(scope.Plaid)
        : reject(new Error("Failed to load Plaid Link script"));
    script.addEventListener("load", settle);
    script.addEventListener("error", settle);
  });
}

export interface PlaidAuthData {
  items: Array<{
    accessToken: string;
    itemId: string;
    institutionId: string;
    institutionName: string;
    accounts: Array<{
      accountId: string;
      name: string;
      mask: string;
      type: string;
      subtype: string;
      balances: {
        available: number | null;
        current: number | null;
        limit: number | null;
        isoCurrencyCode: string | null;
        unofficialCurrencyCode: string | null;
      };
    }>;
    products: string[];
    consentExpirationTime: string | null;
    lastUpdated: string;
    lastSyncCursor: string | null;
  }>;
}

/**
 * CFPlaidLink - Plaid banking integration component
 *
 * @element cf-plaid-link
 *
 * @attr {CellHandle<PlaidAuthData>} auth - Cell containing Plaid authentication data
 * @attr {string[]} products - Array of Plaid products to use (default: ['transactions'])
 *
 * @example
 * <cf-plaid-link .auth=${authCell} .products=${['transactions', 'auth']}></cf-plaid-link>
 */
export class CFPlaidLink extends BaseElement {
  static override properties = {
    auth: { type: Object },
    products: { type: Array },
    isLoading: { type: Boolean },
    authStatus: { type: String },
    plaidScriptLoaded: { type: Boolean },
  };

  declare auth: CellHandle<PlaidAuthData> | undefined;
  declare products: string[];
  declare isLoading: boolean;
  declare authStatus: string;
  declare plaidScriptLoaded: boolean;

  #environment: PlaidLinkEnvironment;
  #plaid: PlaidLink | undefined;
  #plaidHandler: PlaidLinkHandler | null = null;

  /**
   * Constructs an element that reaches the network and Plaid's Link SDK
   * through `environment`.
   */
  constructor(environment: PlaidLinkEnvironment = {
    fetch: (input, init) => fetch(input, init),
    loadPlaid: () => loadPlaidLink(document),
  }) {
    super();
    this.#environment = environment;
    this.products = ["transactions"];
    this.isLoading = false;
    this.authStatus = "";
    this.plaidScriptLoaded = false;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.#environment.loadPlaid().then(
      (plaid) => {
        this.#plaid = plaid;
        this.plaidScriptLoaded = true;
      },
      (error) => {
        console.error("Failed to load Plaid Link script", error);
        this.authStatus =
          "Failed to load Plaid Link. Please refresh and try again.";
      },
    );
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#plaidHandler?.destroy();
    this.#plaidHandler = null;
  }

  async handleConnectClick() {
    const plaid = this.#plaid;
    if (!plaid) {
      this.authStatus = "Plaid Link is still loading, please wait...";
      return;
    }

    this.isLoading = true;
    this.authStatus = "Creating link session...";

    const authCellId = JSON.stringify(this.auth?.ref());

    try {
      const response = await this.#post("create-link-token", {
        authCellId,
        products: this.products,
      });
      const data = await response.json();

      if (!data.linkToken) {
        throw new Error("No link token received from server");
      }

      this.#openLink(plaid, data.linkToken, authCellId);
    } catch (error) {
      console.error("Error creating link session:", error);
      this.authStatus = `Error: ${describeFailure(error)}`;
      this.isLoading = false;
    }
  }

  async handleRemoveAccount(itemId: string) {
    this.isLoading = true;
    this.authStatus = "Removing bank connection...";

    const authCellId = JSON.stringify(this.auth?.ref());

    try {
      await this.#post("remove-item", { authCellId, itemId });

      this.authStatus = "Bank connection removed successfully";
      this.isLoading = false;

      this.requestUpdate();
    } catch (error) {
      console.error("Error removing account:", error);
      this.authStatus = `Error: ${describeFailure(error)}`;
      this.isLoading = false;
    }
  }

  formatCurrency(amount: number | null, currencyCode: string | null): string {
    if (amount === null) return "N/A";
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode || "USD",
    });
    return formatter.format(amount);
  }

  override render() {
    const authData = this.auth?.get();
    const items = authData?.items || [];

    return html`
      <div class="plaid-wrapper">
        ${items.length > 0
          ? html`
            <div class="connected-accounts">
              <h3>Connected Bank Accounts</h3>
              ${items.map((item) =>
                html`
                  <div class="bank-item">
                    <div class="bank-header">
                      <h4>${item.institutionName}</h4>
                      <button
                        @click="${() => this.handleRemoveAccount(item.itemId)}"
                        class="remove-button"
                        ?disabled="${this.isLoading}"
                      >
                        Remove
                      </button>
                    </div>
                    <div class="accounts-list">
                      ${item.accounts.map((account) =>
                        html`
                          <div class="account">
                            <div class="account-info">
                              <span class="account-name">${account.name}</span>
                              <span class="account-mask">****${account
                                .mask}</span>
                              <span class="account-type">${account.subtype ||
                                account.type}</span>
                            </div>
                            <div class="account-balance">
                              <span class="balance-label">Available:</span>
                              <span class="balance-amount">
                                ${this.formatCurrency(
                                  account.balances.available,
                                  account.balances.isoCurrencyCode,
                                )}
                              </span>
                              <span class="balance-label">Current:</span>
                              <span class="balance-amount">
                                ${this.formatCurrency(
                                  account.balances.current,
                                  account.balances.isoCurrencyCode,
                                )}
                              </span>
                            </div>
                          </div>
                        `
                      )}
                    </div>
                    <div class="bank-footer">
                      <span class="last-updated">
                        Last updated: ${new Date(item.lastUpdated)
                          .toLocaleString()}
                      </span>
                    </div>
                  </div>
                `
              )}
            </div>
          `
          : ""}

        <div class="action-section">
          <button
            @click="${this.handleConnectClick}"
            ?disabled="${this.isLoading || !this.plaidScriptLoaded}"
            class="connect-button"
          >
            ${this.isLoading
              ? "Processing..."
              : !this.plaidScriptLoaded
              ? "Loading Plaid..."
              : "Connect Bank Account"}
          </button>

          ${this.authStatus
            ? html`
              <div class="status-message">${this.authStatus}</div>
            `
            : ""}
        </div>
      </div>
    `;
  }

  /** Posts `body` as JSON to the Plaid integration's `path`. */
  async #post(path: string, body: unknown): Promise<Response> {
    const response = await this.#environment.fetch(
      `/api/integrations/plaid-oauth/${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response;
  }

  #openLink(plaid: PlaidLink, linkToken: string, authCellId: string) {
    this.#plaidHandler?.destroy();

    this.#plaidHandler = plaid.create({
      token: linkToken,
      onSuccess: async (publicToken) => {
        this.authStatus = "Processing authentication...";
        await this.#handlePublicToken(publicToken, authCellId);
      },
      onExit: (error) => {
        if (error) {
          this.authStatus = `Authentication failed: ${
            error.error_message || error.display_message || "Unknown error"
          }`;
        } else {
          this.authStatus = "Authentication cancelled";
        }
        this.isLoading = false;
      },
      onEvent: (eventName, metadata) => {
        if (eventName === "OPEN") {
          this.authStatus = "Link opened...";
        } else if (eventName === "SELECT_INSTITUTION") {
          this.authStatus = `Connecting to ${
            metadata.institution_name || "bank"
          }...`;
        } else if (eventName === "SUBMIT_CREDENTIALS") {
          this.authStatus = "Verifying credentials...";
        }
      },
    });
    this.#plaidHandler.open();
  }

  async #handlePublicToken(publicToken: string, authCellId: string) {
    this.isLoading = true;
    this.authStatus = "Exchanging token...";

    try {
      await this.#post("exchange-token", { publicToken, authCellId });
      this.authStatus = "Bank account connected successfully!";
      this.isLoading = false;

      this.requestUpdate();
    } catch (error) {
      console.error("Error exchanging token:", error);
      this.authStatus = `Error: ${describeFailure(error)}`;
      this.isLoading = false;
    }
  }

  static override styles = [
    BaseElement.baseStyles,
    css`
      .plaid-wrapper {
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
        max-width: 800px;
      }

      .connected-accounts {
        margin-bottom: var(--cf-theme-spacing-loose, 1.5rem);
      }

      .connected-accounts h3 {
        margin: 0 0 var(--cf-theme-spacing-normal, 1rem);
        color: var(--cf-theme-color-text, #111827);
        font-size: 1.25rem;
        font-weight: 600;
      }

      .bank-item {
        border: 1px solid var(--cf-theme-color-border, #d1d5db);
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-md, 0.375rem)
        );
        padding: var(--cf-theme-spacing-normal, 1rem);
        margin-bottom: var(--cf-theme-spacing-normal, 1rem);
        background-color: var(
          --cf-theme-color-surface-hover,
          #f9fafb
        );
      }

      .bank-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--cf-theme-spacing-normal, 0.75rem);
      }

      .bank-header h4 {
        margin: 0;
        color: var(--cf-theme-color-text, #111827);
        font-size: 1.1rem;
        font-weight: 600;
      }

      .remove-button {
        background-color: var(
          --cf-theme-color-error,
          var(--cf-colors-red-600, #dc2626)
        );
        color: var(
          --cf-theme-color-primary-foreground,
          var(--cf-colors-white, #ffffff)
        );
        border: none;
        padding: var(--cf-theme-spacing-tight, 0.375rem)
          var(--cf-theme-spacing-normal, 0.75rem);
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-sm, 0.25rem)
        );
        cursor: pointer;
        font-size: 0.9rem;
        font-family: var(--cf-theme-font-family, inherit);
        transition: background-color var(--cf-theme-animation-duration, 0.2s) ease;
      }

      .remove-button:hover {
        background-color: var(
          --cf-theme-color-error,
          var(--cf-colors-red-700, #b91c1c)
        );
      }

      .remove-button:disabled {
        background-color: var(
          --cf-theme-color-border,
          #d1d5db
        );
        cursor: not-allowed;
      }

      .accounts-list {
        display: flex;
        flex-direction: column;
        gap: var(--cf-theme-spacing-normal, 0.75rem);
      }

      .account {
        background-color: var(
          --cf-theme-color-surface,
          var(--cf-colors-white, #ffffff)
        );
        border: 1px solid var(--cf-theme-color-border, #e5e7eb);
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-md, 0.375rem)
        );
        padding: var(--cf-theme-spacing-normal, 0.75rem);
      }

      .account-info {
        display: flex;
        gap: var(--cf-theme-spacing-normal, 0.75rem);
        margin-bottom: var(--cf-theme-spacing-tight, 0.5rem);
        align-items: center;
      }

      .account-name {
        font-weight: 500;
        color: var(--cf-theme-color-text, #111827);
      }

      .account-mask {
        color: var(
          --cf-theme-color-text-muted,
          #6b7280
        );
        font-size: 0.9rem;
      }

      .account-type {
        background-color: #e8f0fe;
        color: #1a73e8;
        padding: 0.125rem var(--cf-theme-spacing-tight, 0.5rem);
        border-radius: var(
          --cf-theme-border-radius-full,
          var(--cf-border-radius-full, 9999px)
        );
        font-size: 0.8rem;
        text-transform: capitalize;
      }

      .account-balance {
        display: flex;
        gap: var(--cf-theme-spacing-normal, 1rem);
        align-items: center;
        font-size: 0.95rem;
      }

      .balance-label {
        color: var(
          --cf-theme-color-text-muted,
          #6b7280
        );
      }

      .balance-amount {
        font-weight: 500;
        color: var(--cf-theme-color-text, #111827);
      }

      .bank-footer {
        margin-top: var(--cf-theme-spacing-normal, 0.75rem);
        padding-top: var(--cf-theme-spacing-normal, 0.75rem);
        border-top: 1px solid var(--cf-theme-color-border, #e5e7eb);
      }

      .last-updated {
        color: var(
          --cf-theme-color-text-muted,
          #6b7280
        );
        font-size: 0.85rem;
      }

      .action-section {
        display: flex;
        flex-direction: column;
        gap: var(--cf-theme-spacing-normal, 1rem);
      }

      .connect-button {
        background-color: #1db954;
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

      .connect-button:hover {
        background-color: #1aa34a;
      }

      .connect-button:disabled {
        background-color: var(
          --cf-theme-color-border,
          #d1d5db
        );
        cursor: not-allowed;
      }

      .status-message {
        padding: var(--cf-theme-spacing-normal, 0.75rem);
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-md, 0.375rem)
        );
        background-color: #e8f5e9;
        color: #2e7d32;
        font-size: 0.9rem;
        text-align: center;
      }
    `,
  ];
}
