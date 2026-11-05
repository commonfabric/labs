import { CFC_POLICY_PLACEHOLDER_TEXT } from "@commonfabric/html/client";
import { CellHandle, CellReadRefusedError } from "@commonfabric/runtime-client";
import { css, html } from "lit";

import { BaseElement } from "../../core/base-element.ts";

import "../cf-button/index.ts";
import "../cf-secret-viewer/index.ts";

// Design spec: docs/specs/webhook-ingress/README.md

export interface WebhookConfig {
  url: string;
  secret: string;
}

/**
 * CFWebhook - Webhook integration component
 *
 * Creates and manages a webhook endpoint. The component handles all API
 * interaction internally — patterns never call /api/webhooks directly.
 * Follows the same model as cf-google-oauth: the pattern passes a cell
 * handle, the component manages the lifecycle.
 *
 * The component creates the confidential config cell internally so the
 * pattern never needs to manage CFC labels for secrets.
 *
 * @element cf-webhook
 *
 * @attr {string} name - Human-readable label for the webhook
 * @attr {CellHandle<any>} inbox - Stream that receives webhook payloads (pass via $inbox)
 * @attr {CellHandle<WebhookConfig | null>} config - Cell for URL+secret storage (pass via $config)
 *
 * @example
 * <cf-webhook
 *   name="GitHub Push Events"
 *   $inbox={webhookInbox}
 *   $config={webhookConfig}
 * />
 */
export class CFWebhook extends BaseElement {
  static override properties = {
    name: { type: String },
    inbox: { type: Object, attribute: false },
    config: { type: Object, attribute: false },
    _isLoading: { type: Boolean, state: true },
    _error: { type: String, state: true },
    _readFailed: { type: Boolean, state: true },
  };

  declare name: string;
  declare inbox: CellHandle<unknown>;
  declare config: CellHandle<WebhookConfig | null>;

  declare _isLoading: boolean;
  declare _error: string;
  /**
   * Whether the last read of a configuration the worker had not answered
   * failed, for a reason other than a refusal: what it holds is still not
   * known, so nothing is offered in its place, and it can be read again.
   */
  declare _readFailed: boolean;

  private _configUnsub?: () => void;

  constructor() {
    super();
    this.name = "";
    this._isLoading = false;
    this._error = "";
    this._readFailed = false;
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);
    if (changedProperties.has("config")) {
      this._subscribeToConfig();
    }
  }

  private _subscribeToConfig() {
    this._configUnsub?.();
    this._configUnsub = undefined;
    const config = this.config;
    if (config?.subscribe) {
      const update = () => this.requestUpdate();
      this._configUnsub = config.subscribe(update, { onRefused: update });
      this._readConfig();
    }
  }

  /**
   * Reads a configuration the worker has not answered for. A subscription
   * delivers nothing for one that holds nothing, so it is read, and the
   * answer reaches the subscription, a refusal as much as a value. A read
   * that fails otherwise is shown as such, with a way to read again.
   */
  private _readConfig = () => {
    const config = this.config;
    this._readFailed = false;
    if (!config || !("unread" in config.lastRead())) return;
    config.pull({ awaitDurability: false }).catch((error) => {
      if (error instanceof CellReadRefusedError) return;
      console.error("[cf-webhook] Reading the configuration failed:", error);
      if (this.config === config) this._readFailed = true;
    });
  };

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._configUnsub?.();
    this._configUnsub = undefined;
  }

  private _getConfig(): WebhookConfig | null {
    try {
      return this.config?.get() ?? null;
    } catch {
      return null;
    }
  }

  private async _handleCreate() {
    if (this._isLoading) return;

    if (!this.inbox || !this.config || !this.name) {
      this._error = "Missing required properties: name, inbox, config";
      return;
    }

    this._isLoading = true;
    this._error = "";

    try {
      if (!this.inbox) {
        throw new Error("inbox is not a valid cell link");
      }
      const cellLink = this.inbox.toWireString();

      if (!this.config) {
        throw new Error("config is not a valid cell link");
      }
      const confidentialCellLink = this.config.toWireString();

      const response = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: this.name,
          cellLink,
          confidentialCellLink,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      await response.json();
      this._isLoading = false;
      this.requestUpdate();
    } catch (error) {
      this._error = error instanceof Error
        ? error.message
        : "Failed to create webhook";
      this._isLoading = false;
    }
  }

  private async _handleDelete() {
    if (this._isLoading) return;

    const configData = this._getConfig();
    if (!configData?.url) return;

    // Extract webhook ID from the config URL (format: .../api/webhooks/{id})
    let webhookId: string | undefined;
    try {
      webhookId = new URL(configData.url).pathname.split("/").pop();
    } catch {
      webhookId = configData.url.split("/").pop();
    }
    if (!webhookId) return;

    this._isLoading = true;
    this._error = "";

    try {
      // Space DID from the inbox handle, for ownership verification.
      const space = this.inbox?.space() ?? "";
      const params = new URLSearchParams({ space });

      const response = await fetch(
        `/api/webhooks/${webhookId}?${params}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      // Clear the config cell. The inbox stream reference remains on the
      // pattern side but will simply stop receiving new events.
      await this.config.set(null);
      this._isLoading = false;
    } catch (error) {
      this._error = error instanceof Error
        ? error.message
        : "Failed to delete webhook";
      this._isLoading = false;
    }
  }

  override render() {
    // A configuration the worker will not show is not one that is absent:
    // offering to create a webhook in its place would replace one that may
    // exist.
    if (this.config?.refusal !== undefined) {
      return html`
        <div class="webhook-setup">${CFC_POLICY_PLACEHOLDER_TEXT}</div>
      `;
    }
    // Nor is one the worker has not answered for yet, or that could not be
    // read.
    if (this.config !== undefined && "unread" in this.config.lastRead()) {
      if (this._readFailed) {
        return html`
          <div class="webhook-setup">
            <div class="error" role="alert">
              The webhook configuration could not be read.
            </div>
            <cf-button
              color="neutral"
              variant="outline"
              @click="${this._readConfig}"
            >
              Retry
            </cf-button>
          </div>
        `;
      }
      return html`
        <div class="webhook-setup">Loading…</div>
      `;
    }
    const configData = this._getConfig();
    const hasWebhook = configData?.url && configData?.secret;

    if (!hasWebhook) {
      return html`
        <div class="webhook-setup">
          <cf-button
            color="neutral"
            variant="outline"
            @click="${this._handleCreate}"
            ?disabled="${this._isLoading}"
          >
            ${this._isLoading ? "Creating..." : `Create Webhook`}
          </cf-button>
          ${this._error
            ? html`
              <div class="error" role="alert">${this._error}</div>
            `
            : ""}
        </div>
      `;
    }

    return html`
      <div class="webhook-card">
        <div class="header">
          <span class="name">${this.name}</span>
          <cf-button
            variant="ghost"
            size="sm"
            @click="${this._handleDelete}"
            ?disabled="${this._isLoading}"
          >
            ${this._isLoading ? "..." : "Delete"}
          </cf-button>
        </div>
        <cf-secret-viewer
          label="Webhook URL"
          .value="${configData.url}"
          trailing-chars="8"
        ></cf-secret-viewer>
        <cf-secret-viewer
          label="Bearer Token"
          .value="${configData.secret}"
          trailing-chars="4"
        ></cf-secret-viewer>
        ${this._error
          ? html`
            <div class="error" role="alert">${this._error}</div>
          `
          : ""}
      </div>
    `;
  }

  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
      }

      .webhook-setup {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-2, 0.5rem);
      }

      .webhook-card {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-3, 0.75rem);
        padding: var(--spacing-4, 1rem);
        border: 1px solid var(--color-border, #e5e7eb);
        border-radius: var(--radius-md, 0.375rem);
        background: var(--color-bg-subtle, #f9fafb);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .name {
        font-weight: 600;
        font-size: var(--font-size-sm, 0.875rem);
        color: var(--color-text-primary, #111827);
      }

      .error {
        font-size: var(--font-size-sm, 0.875rem);
        color: var(--color-error, #dc2626);
        padding: var(--spacing-2, 0.5rem);
        background: var(--color-error-bg, #fef2f2);
        border-radius: var(--radius-sm, 0.25rem);
      }
    `,
  ];
}
