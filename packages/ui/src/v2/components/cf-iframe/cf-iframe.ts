import {
  CommonIframeSandboxElement as _,
  type FabricBridge,
  IPC,
} from "@commonfabric/iframe-sandbox";
import { isCellHandle, type RuntimeClient } from "@commonfabric/runtime-client";
import { ContextConsumer } from "@lit/context";
import { css, html } from "lit";
import type { PropertyValues } from "lit";

import { BaseElement } from "../../core/base-element.ts";
import { runtimeContext } from "../../runtime-context.ts";
import {
  type CellContextResourceKind,
  createCellContextBridge,
  resolveCellContextBridge,
} from "./cell-bridge.ts";

/**
 * CFIframe - An iframe to execute arbitrary scripts
 *
 * See `@commonfabric/iframe-sandbox` for security details.
 *
 * @element cf-iframe
 *
 * @attr {string} src - String representation of HTML content to load within an iframe
 * @prop {object} bridge - Explicit capability bridge
 * @prop {object} context - Convenience cell context
 * @prop {object} resourceKinds - Explicit kinds for opaque context resources
 *
 * @event {CustomEvent} load - The iframe was successfully loaded
 * @event {CustomEvent} fix - Dispatched when user clicks "Fix" on an error modal
 *
 * @example
 * <cf-iframe src="<html>...</html>" .bridge=${bridge}></cf-iframe>
 */
export class CFIframe extends BaseElement {
  static override properties = {
    src: { type: String },
    context: { type: Object },
    bridge: { type: Object },
    resourceKinds: { attribute: false },
    _errorDetails: { state: true },
  };

  declare src: string;
  declare context: object | null;
  declare bridge: FabricBridge | null;
  declare resourceKinds:
    | Readonly<Record<string, CellContextResourceKind>>
    | null;
  declare _errorDetails: IPC.GuestError | null;
  private _contextBridge: FabricBridge = { resources: {} };
  private _contextReady = true;
  private _contextGeneration = 0;

  /**
   * Where the host serves the sandbox's outer frame, as the runtime it
   * provided says, or `undefined` to have the sandbox inline it.
   *
   * It comes from the host's runtime and from nowhere else. It is private to
   * the class rather than a property of the element, so nothing that renders
   * one -- a pattern's markup included -- can name the frame that stands
   * between its guest and the page.
   */
  #outerFrameUrl: string | undefined = undefined;

  /** Holds the subscription to the host's runtime. */
  private _runtimeConsumer = new ContextConsumer(this, {
    context: runtimeContext,
    subscribe: true,
    callback: (runtime) => this.onRuntime(runtime),
  });

  constructor() {
    super();
    this.src = "";
    this.context = null;
    this.bridge = null;
    this.resourceKinds = null;
    this._errorDetails = null;
  }

  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        width: 100%;
        height: 100%;
      }

      .error-modal {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-color: rgba(0, 0, 0, 0.5);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 9999;
      }

      .error-content {
        background-color: var(
          --cf-theme-color-surface,
          var(--cf-colors-white, #ffffff)
        );
        padding: var(--cf-theme-spacing-loose, 1.25rem);
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-md, 0.375rem)
        );
        max-width: 80%;
        max-height: 80%;
        overflow: auto;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      }

      .error-content h2 {
        margin: 0 0 1rem;
        color: var(--cf-theme-color-text, #111827);
      }

      .error-content p {
        margin: 0.5rem 0;
        color: var(--cf-theme-color-text, #111827);
      }

      .error-content pre {
        background-color: var(
          --cf-theme-color-surface-hover,
          #f3f4f6
        );
        padding: 1rem;
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-sm, 0.25rem)
        );
        overflow: auto;
        font-family: monospace;
      }

      .error-actions {
        margin-top: 1.25rem;
        display: flex;
        justify-content: flex-end;
        gap: 0.75rem;
      }

      .error-actions button {
        padding: 0.5rem 1rem;
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-md, 0.375rem)
        );
        border: 1px solid var(--cf-theme-color-border, #d1d5db);
        background-color: var(
          --cf-theme-color-surface,
          var(--cf-colors-white, #ffffff)
        );
        color: var(--cf-theme-color-text, #111827);
        cursor: pointer;
        font-size: 0.875rem;
        font-weight: 500;
        transition: all 0.2s ease;
      }

      .error-actions button:hover {
        background-color: var(
          --cf-theme-color-surface-hover,
          #f3f4f6
        );
      }

      .error-actions button:first-child {
        background-color: var(
          --cf-theme-color-primary,
          #3b82f6
        );
        color: var(
          --cf-theme-color-primary-foreground,
          var(--cf-colors-white, #ffffff)
        );
        border-color: var(
          --cf-theme-color-primary,
          #3b82f6
        );
      }

      .error-actions button:first-child:hover {
        opacity: 0.9;
      }
    `,
  ];

  /** Takes the outer frame's URL from the runtime the host provided. */
  private onRuntime(runtime: RuntimeClient | undefined) {
    const url = runtime?.iframeOuterFrameUrl();
    if (url === this.#outerFrameUrl) return;
    this.#outerFrameUrl = url;
    this.requestUpdate();
  }

  private onLoad() {
    this.emit("load");
  }

  private onError(e: CustomEvent) {
    this._errorDetails = e.detail;
  }

  private dismissError() {
    const retryContext = this._errorDetails?.source === "cf-iframe context";
    this._errorDetails = null;
    if (retryContext) this.prepareContextBridge();
  }

  private fixError() {
    this.emit("fix", this._errorDetails);
    const retryContext = this._errorDetails?.source === "cf-iframe context";
    this._errorDetails = null;
    if (retryContext) this.prepareContextBridge();
  }

  private prepareContextBridge() {
    const generation = ++this._contextGeneration;
    if (this._errorDetails?.source === "cf-iframe context") {
      this._errorDetails = null;
    }
    if (this.bridge || !this.context) {
      this._contextBridge = { resources: {} };
      this._contextReady = true;
    } else if (!isCellHandle<Record<string, unknown>>(this.context)) {
      this._contextBridge = createCellContextBridge(this.context);
      this._contextReady = true;
    } else {
      const context = this.context;
      this._contextBridge = { resources: {} };
      this._contextReady = false;
      void resolveCellContextBridge(
        context,
        this.resourceKinds ?? {},
      ).then((bridge) => {
        if (generation !== this._contextGeneration) return;
        this._contextBridge = bridge;
        this._contextReady = true;
        this.requestUpdate();
      }).catch((error) => {
        if (generation !== this._contextGeneration) return;
        const description = error instanceof Error
          ? error.message
          : String(error);
        this._errorDetails = {
          description,
          source: "cf-iframe context",
          lineno: 0,
          colno: 0,
          stacktrace: error instanceof Error
            ? error.stack ?? description
            : description,
        };
        this.requestUpdate();
      });
    }
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    if (
      changed.has("bridge") || changed.has("context") ||
      changed.has("resourceKinds") ||
      (changed.has("src") &&
        this._errorDetails?.source === "cf-iframe context")
    ) {
      this.prepareContextBridge();
    }
  }

  override render() {
    const bridge = this.bridge ?? this._contextBridge;
    const source = this.bridge || this._contextReady ? this.src : "";
    return html`
      <common-iframe-sandbox
        .bridge="${bridge}"
        .src="${source}"
        .outerFrameUrl="${this.#outerFrameUrl}"
        height="100%"
        width="100%"
        style="border: none;"
        @load="${this.onLoad}"
        @common-iframe-error="${this.onError}"
      ></common-iframe-sandbox>
      ${this._errorDetails
        ? html`
          <div class="error-modal">
            <div class="error-content">
              <h2>Error</h2>
              <p><strong>Description:</strong> ${this._errorDetails
                .description}</p>
              <p><strong>Source:</strong> ${this._errorDetails.source}</p>
              <p><strong>Line:</strong> ${this._errorDetails.lineno}</p>
              <p><strong>Column:</strong> ${this._errorDetails.colno}</p>
              <pre><code>${this._errorDetails.stacktrace}</code></pre>
              <div class="error-actions">
                <button @click="${this.fixError}">Fix</button>
                <button @click="${this.dismissError}">Dismiss</button>
              </div>
            </div>
          </div>
        `
        : ""}
    `;
  }
}
