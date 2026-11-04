import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFLinkPreview - Renders a rich link preview card for a given URL
 *
 * Fetches metadata and a screenshot via the /api/link-preview endpoint
 * (which proxies through Jina to avoid SSRF concerns).
 *
 * @element cf-link-preview
 * @attr {string} url - The URL to generate a preview for
 *
 * @example
 * <cf-link-preview url="https://github.com"></cf-link-preview>
 */
export class CFLinkPreview extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        box-sizing: border-box;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .preview-card {
        display: block;
        border-radius: var(--cf-theme-border-radius, 0.5rem);
        border: 1px solid var(--border, hsl(0, 0%, 89%));
        background-color: var(--card, hsl(0, 0%, 100%));
        color: var(--card-foreground, hsl(0, 0%, 9%));
        overflow: hidden;
        text-decoration: none;
        transition: all var(--cf-theme-animation-duration, 150ms)
          cubic-bezier(0.4, 0, 0.2, 1);
      }

      .preview-card:hover {
        transform: translateY(-1px);
        box-shadow:
          0 4px 6px -1px rgba(0, 0, 0, 0.1),
          0 2px 4px -1px rgba(0, 0, 0, 0.06);
      }

      .preview-card:active {
        transform: translateY(0);
      }

      /* Loading state */
      .preview-card.loading {
        padding: var(--cf-theme-spacing-loose, 1rem);
      }

      .skeleton-image {
        width: 100%;
        height: 200px;
        background: linear-gradient(
          90deg,
          hsl(0, 0%, 92%) 0%,
          hsl(0, 0%, 96%) 50%,
          hsl(0, 0%, 92%) 100%
        );
        background-size: 200% 100%;
        animation: shimmer 1.5s infinite;
        border-radius: calc(var(--cf-theme-border-radius, 0.5rem) * 0.5);
        margin-bottom: var(--cf-theme-spacing-loose, 1rem);
      }

      .skeleton-text {
        height: 1rem;
        background: linear-gradient(
          90deg,
          hsl(0, 0%, 92%) 0%,
          hsl(0, 0%, 96%) 50%,
          hsl(0, 0%, 92%) 100%
        );
        background-size: 200% 100%;
        animation: shimmer 1.5s infinite;
        border-radius: calc(var(--cf-theme-border-radius, 0.5rem) * 0.25);
        margin-bottom: 0.5rem;
      }

      .skeleton-text.short {
        width: 60%;
      }

      @keyframes shimmer {
        0% {
          background-position: 200% 0;
        }
        100% {
          background-position: -200% 0;
        }
      }

      /* Fallback state */
      .preview-card.fallback {
        padding: var(--cf-theme-spacing-loose, 1rem);
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .fallback-url {
        color: var(--card-foreground, hsl(0, 0%, 9%));
        font-size: 0.875rem;
        word-break: break-all;
      }

      /* Loaded state */
      .preview-image {
        width: 100%;
        max-height: 200px;
        overflow: hidden;
      }

      .preview-image img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }

      .preview-body {
        padding: var(--cf-theme-spacing-loose, 1rem);
      }

      .preview-title {
        font-size: 1rem;
        font-weight: 600;
        line-height: 1.5;
        color: var(--card-foreground, hsl(0, 0%, 9%));
        margin: 0 0 0.5rem 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .preview-description {
        font-size: 0.875rem;
        line-height: 1.4;
        color: var(--muted-foreground, hsl(0, 0%, 45%));
        margin: 0 0 0.75rem 0;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      .preview-footer {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.75rem;
        color: var(--muted-foreground, hsl(0, 0%, 45%));
      }

      .preview-domain {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ];

  @property({ type: String, reflect: true })
  accessor url = "";

  @state()
  private accessor _loading = false;

  @state()
  private accessor _error = false;

  @state()
  private accessor _title = "";

  @state()
  private accessor _description = "";

  @state()
  private accessor _image = "";

  private _abortController: AbortController | null = null;

  constructor() {
    super();
    this.url = "";
  }

  override willUpdate(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.willUpdate(changedProperties);

    if (changedProperties.has("url") && this.url) {
      this._fetchPreview();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  private async _fetchPreview() {
    // Abort any in-flight fetch
    if (this._abortController) {
      this._abortController.abort();
    }

    // Reset state
    this._loading = true;
    this._error = false;
    this._title = "";
    this._description = "";
    this._image = "";

    // Create new abort controller
    const controller = new AbortController();
    this._abortController = controller;

    try {
      const apiUrl = `/api/link-preview/${encodeURIComponent(this.url)}`;
      const response = await fetch(apiUrl, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      this._title = data.title || "";
      this._description = data.description || "";
      this._image = data.image || "";
      this._loading = false;
    } catch (error) {
      // Only update state if this controller is still the active one;
      // otherwise a newer fetch has already taken over.
      if (this._abortController !== controller) return;

      if (error instanceof Error && error.name !== "AbortError") {
        this._error = true;
      }
      this._loading = false;
    }
  }

  private _getDomain(): string {
    try {
      const urlObj = new URL(this.url);
      return urlObj.hostname;
    } catch {
      return this.url;
    }
  }

  /** Only allow http/https hrefs to prevent javascript:/data: injection. */
  private _getSafeHref(): string {
    try {
      const parsed = new URL(this.url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return this.url;
      }
    } catch {
      // invalid URL
    }
    return "#";
  }

  override render() {
    if (!this.url) {
      return nothing;
    }

    const domain = this._getDomain();

    // Loading state
    if (this._loading) {
      return html`
        <div class="preview-card loading">
          <div class="skeleton-image"></div>
          <div class="skeleton-text"></div>
          <div class="skeleton-text short"></div>
        </div>
      `;
    }

    // Error/fallback state
    if (this._error || (!this._title && !this._image)) {
      return html`
        <a
          class="preview-card fallback"
          href="${this._getSafeHref()}"
          target="_blank"
          rel="noopener noreferrer"
        >
          <span class="fallback-url">${domain}</span>
        </a>
      `;
    }

    // Loaded state
    return html`
      <a
        class="preview-card"
        href="${this._getSafeHref()}"
        target="_blank"
        rel="noopener noreferrer"
      >
        ${this._image
          ? html`
            <div class="preview-image">
              <img src="${this._image}" alt="" loading="lazy" />
            </div>
          `
          : nothing}
        <div class="preview-body">
          <div class="preview-title">${this._title || domain}</div>
          ${this._description
            ? html`
              <div class="preview-description">${this._description}</div>
            `
            : nothing}
          <div class="preview-footer">
            <span class="preview-domain">${domain}</span>
          </div>
        </div>
      </a>
    `;
  }
}
