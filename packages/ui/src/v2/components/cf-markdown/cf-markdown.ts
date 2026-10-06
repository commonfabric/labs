import { CFC_POLICY_PLACEHOLDER_TEXT } from "@commonfabric/html/client";
import { type CellHandle, isCellHandle } from "@commonfabric/runtime-client";
import { consume } from "@lit/context";
import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

import { BaseElement } from "../../core/base-element.ts";
import {
  applyThemeToElement,
  type CFTheme,
  cfThemeContext,
  defaultTheme,
} from "../theme-context.ts";
import {
  type MarkdownCallbacks,
  markdownTemplate,
} from "./markdown-template.ts";

export type MarkdownVariant = "default" | "inverse";

/**
 * CFMarkdown - Renders markdown content with syntax highlighting and copy buttons
 *
 * The content is rendered as markdown only. Raw HTML written into it is not
 * rendered, and a link or an image whose URL names a scheme outside the
 * allowlist in `safe-url.ts` loses its URL, so untrusted content is safe to
 * pass in. `markdown-template.ts` describes how that holds.
 *
 * @element cf-markdown
 *
 * @attr {string} content - The markdown content to render (string or CellHandle<string>)
 * @attr {string} variant - Visual variant: "default" or "inverse" (for light text on dark bg)
 * @attr {boolean} streaming - Shows a blinking cursor at the end (for streaming content)
 * @attr {boolean} compact - Reduces paragraph spacing for more compact display
 *
 * @csspart content - The markdown content wrapper
 *
 * @fires cf-checkbox-change - Fired when a task list checkbox is toggled. Detail: { index: number, checked: boolean }
 *
 * @cssprop [--cf-markdown-inverse-border=rgba(255,255,255,0.3)] - Border color for inverse variant
 * @cssprop [--cf-markdown-inverse-surface=rgba(255,255,255,0.2)] - Surface color for inverse variant (code blocks)
 * @cssprop [--cf-markdown-inverse-surface-subtle=rgba(255,255,255,0.1)] - Subtle surface for inverse (table headers)
 * @cssprop [--cf-markdown-inverse-accent=rgba(255,255,255,0.6)] - Accent color for inverse (blockquote border)
 * @cssprop [--cf-markdown-table-col-min-width=8rem] - Minimum width per table column before the table scrolls horizontally
 *
 * @example
 * <cf-markdown content="# Hello World\n\nThis is **bold** text."></cf-markdown>
 *
 * @example
 * <cf-markdown content="```js\nconsole.log('hello');\n```"></cf-markdown>
 *
 * @example
 * <cf-markdown .content=${myCell} streaming></cf-markdown>
 *
 * @example
 * <cf-markdown .content=${myCell} compact></cf-markdown>
 */
export class CFMarkdown extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        box-sizing: border-box;
        /* Keep the host within its container so a wide table scrolls inside
        * the .table-scroll wrapper instead of blowing the host out. Two
        * cases: as a normal block, max-width:100% is a no-op; as a
        * non-stretched flex child (e.g. inside a cf-vstack with
        * align-items:flex-start), max-width caps the host at the column width
        * — otherwise the host grows to the table's content width and gets
        * clipped by an ancestor (cf-screen sets overflow-x:hidden) with no
        * scroll. min-width:0 lets it shrink below content in the flex main
        * axis for the same reason. */
        min-width: 0;
        max-width: 100%;
        font-family: var(
          --cf-theme-font-family,
          system-ui,
          -apple-system,
          sans-serif
        );
        line-height: 1.6;
        color: var(--cf-theme-color-text, #111827);
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .markdown-content {
        word-wrap: break-word;
      }

      /* Streaming cursor */
      .markdown-content.streaming::after {
        content: "▊";
        animation: blink 1s infinite;
        margin-left: 2px;
        color: currentColor;
      }

      @keyframes blink {
        0%,
        50% {
          opacity: 1;
        }
        51%,
        100% {
          opacity: 0;
        }
      }

      /* Headings */
      .markdown-content h1,
      .markdown-content h2,
      .markdown-content h3,
      .markdown-content h4,
      .markdown-content h5,
      .markdown-content h6 {
        margin-top: 1.5em;
        margin-bottom: 0.5em;
        font-weight: 600;
        line-height: 1.25;
      }

      .markdown-content h1:first-child,
      .markdown-content h2:first-child,
      .markdown-content h3:first-child,
      .markdown-content h4:first-child,
      .markdown-content h5:first-child,
      .markdown-content h6:first-child {
        margin-top: 0;
      }

      .markdown-content h1 {
        font-size: 2em;
        border-bottom: 1px solid var(--cf-theme-color-border, #e5e7eb);
        padding-bottom: 0.3em;
      }

      .markdown-content h2 {
        font-size: 1.5em;
        border-bottom: 1px solid var(--cf-theme-color-border, #e5e7eb);
        padding-bottom: 0.3em;
      }

      .markdown-content h3 {
        font-size: 1.25em;
      }

      .markdown-content h4 {
        font-size: 1em;
      }

      .markdown-content h5 {
        font-size: 0.875em;
      }

      .markdown-content h6 {
        font-size: 0.85em;
        color: var(--cf-theme-color-text-muted, #6b7280);
      }

      /* Inverse variant heading adjustments */
      .markdown-content.inverse h1,
      .markdown-content.inverse h2 {
        border-bottom-color: var(
          --cf-markdown-inverse-border,
          rgba(255, 255, 255, 0.3)
        );
      }

      .markdown-content.inverse h6 {
        color: inherit;
        opacity: 0.8;
      }

      /* Paragraphs */
      .markdown-content p {
        margin: 0;
      }

      .markdown-content p:not(:last-child) {
        margin-bottom: var(--cf-theme-spacing-normal, var(--cf-spacing-3, 0.75rem));
      }

      /* Compact mode paragraph spacing */
      .markdown-content.compact p:not(:last-child) {
        margin-bottom: var(
          --cf-theme-spacing-tight,
          var(--cf-spacing-1, 0.25rem)
        );
      }

      /* Links */
      .markdown-content a {
        color: var(
          --cf-theme-color-accent,
          var(--cf-colors-blue-500, #3b82f6)
        );
        text-decoration: none;
      }

      .markdown-content a:hover {
        text-decoration: underline;
      }

      /* Inverse variant links */
      .markdown-content.inverse a {
        color: inherit;
        text-decoration: underline;
        opacity: 0.9;
      }

      /* Lists */
      .markdown-content ul,
      .markdown-content ol {
        margin: var(--cf-theme-spacing-normal, var(--cf-spacing-3, 0.75rem)) 0;
        padding-left: 2em;
      }

      .markdown-content li {
        margin-bottom: 0.25em;
      }

      .markdown-content li > ul,
      .markdown-content li > ol {
        margin: 0.25em 0;
      }

      /* Inline code */
      .markdown-content code {
        background-color: var(--cf-theme-color-surface, #f9fafb);
        padding: 0.2em 0.4em;
        border-radius: var(--cf-theme-border-radius, 0.375rem);
        font-family: var(--cf-theme-mono-font-family, ui-monospace, monospace);
        font-size: 0.875em;
      }

      /* Inverse variant inline code */
      .markdown-content.inverse code {
        background-color: var(
          --cf-markdown-inverse-surface,
          rgba(255, 255, 255, 0.2)
        );
        color: inherit;
      }

      /* Code blocks */
      .markdown-content pre {
        background-color: var(--cf-theme-color-surface, #f9fafb);
        padding: var(
          --cf-theme-spacing-padding-block,
          var(--cf-spacing-3, 0.75rem)
        );
        border-radius: var(--cf-theme-border-radius, 0.5rem);
        border: 1px solid var(--cf-theme-color-border, #e5e7eb);
        overflow-x: auto;
        margin: var(--cf-theme-spacing-normal, var(--cf-spacing-3, 0.75rem)) 0;
      }

      .markdown-content pre code {
        background-color: transparent;
        padding: 0;
        font-size: 0.875em;
      }

      /* Inverse variant code blocks */
      .markdown-content.inverse pre {
        background-color: var(
          --cf-markdown-inverse-surface,
          rgba(255, 255, 255, 0.2)
        );
        border: none;
      }

      .markdown-content.inverse pre code {
        color: inherit;
      }

      /* Code block container with copy button */
      .code-block-container {
        position: relative;
      }

      .code-copy-button {
        position: absolute;
        top: var(--cf-theme-spacing-normal, var(--cf-spacing-2, 0.5rem));
        right: var(--cf-theme-spacing-normal, var(--cf-spacing-2, 0.5rem));
        opacity: 0;
        transition: opacity var(--cf-theme-animation-duration, 0.2s) ease;
        z-index: 1;
      }

      .code-block-container:hover .code-copy-button {
        opacity: 1;
      }

      /* Blockquotes */
      .markdown-content blockquote {
        border-left: 4px solid var(--cf-theme-color-border, #e5e7eb);
        margin: var(--cf-theme-spacing-normal, var(--cf-spacing-3, 0.75rem)) 0;
        padding-left: var(--cf-theme-spacing-normal, var(--cf-spacing-3, 0.75rem));
        font-style: italic;
        color: var(--cf-theme-color-text-muted, #6b7280);
      }

      .markdown-content blockquote p:last-child {
        margin-bottom: 0;
      }

      /* Inverse variant blockquotes */
      .markdown-content.inverse blockquote {
        border-left-color: var(
          --cf-markdown-inverse-accent,
          rgba(255, 255, 255, 0.6)
        );
        color: inherit;
        opacity: 0.9;
      }

      /* Horizontal rules */
      .markdown-content hr {
        border: none;
        border-top: 1px solid var(--cf-theme-color-border, #e5e7eb);
        margin: 1.5em 0;
      }

      .markdown-content.inverse hr {
        border-top-color: var(
          --cf-markdown-inverse-border,
          rgba(255, 255, 255, 0.3)
        );
      }

      /* Tables */
      /* Scroll container so a wide table scrolls horizontally instead of
      * cramming its columns on narrow (mobile) screens. Wrapped around every
      * <table> by markdown-template.ts. */
      .markdown-content .table-scroll {
        overflow-x: auto;
        max-width: 100%;
        margin: var(--cf-theme-spacing-normal, var(--cf-spacing-3, 0.75rem)) 0;
        -webkit-overflow-scrolling: touch;
      }

      .markdown-content table {
        border-collapse: collapse;
        /* Fill the available width, but grow past it when the per-column
        * minimum widths demand more room — at which point .table-scroll
        * scrolls rather than the columns collapsing. */
        width: auto;
        min-width: 100%;
        margin: 0;
      }

      .markdown-content th,
      .markdown-content td {
        border: 1px solid var(--cf-theme-color-border, #e5e7eb);
        padding: 0.5em 1em;
        text-align: left;
        /* Keep columns readable; below this they'd collapse into the cramped
        * grid this fix exists to prevent. Content still wraps within a
        * column. Tunable per context via --cf-markdown-table-col-min-width. */
        min-width: var(--cf-markdown-table-col-min-width, 8rem);
      }

      .markdown-content th {
        background-color: var(--cf-theme-color-surface, #f9fafb);
        font-weight: 600;
      }

      /* Inverse variant tables */
      .markdown-content.inverse th,
      .markdown-content.inverse td {
        border-color: var(
          --cf-markdown-inverse-border,
          rgba(255, 255, 255, 0.3)
        );
      }

      .markdown-content.inverse th {
        background-color: var(
          --cf-markdown-inverse-surface-subtle,
          rgba(255, 255, 255, 0.1)
        );
      }

      /* Images */
      .markdown-content img {
        max-width: 100%;
        height: auto;
        border-radius: var(--cf-theme-border-radius, 0.5rem);
      }

      /* Strong and emphasis */
      .markdown-content strong {
        font-weight: 600;
      }

      .markdown-content em {
        font-style: italic;
      }

      /* Task lists */
      .markdown-content input[type="checkbox"] {
        margin-right: 0.5em;
        cursor: pointer;
      }
    `,
  ];

  @property({ attribute: false })
  accessor content: CellHandle<string> | string = "";

  @property({ type: String, reflect: true })
  accessor variant: MarkdownVariant = "default";

  @property({ type: Boolean, reflect: true })
  accessor streaming = false;

  @property({ type: Boolean, reflect: true })
  accessor compact = false;

  @consume({ context: cfThemeContext, subscribe: true })
  @property({ attribute: false })
  accessor theme: CFTheme = defaultTheme;

  private _unsubscribe: (() => void) | null = null;

  constructor() {
    super();
    this.content = "";
    this.variant = "default";
    this.streaming = false;
    this.compact = false;
  }

  private _getContentValue(): string {
    if (isCellHandle<string>(this.content)) {
      // Content the worker will not show reads as the placeholder a render
      // shows in its place, not as an empty document.
      const read = this.content.lastRead();
      if ("refused" in read) return CFC_POLICY_PLACEHOLDER_TEXT;
      return "value" in read ? read.value ?? "" : "";
    }
    return this.content ?? "";
  }

  override willUpdate(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.willUpdate(changedProperties);

    // Handle Cell subscription before render so first render has correct value
    if (changedProperties.has("content")) {
      // Clean up previous subscription
      if (this._unsubscribe) {
        this._unsubscribe();
        this._unsubscribe = null;
      }

      // Subscribe to new Cell if it's a Cell
      if (this.content && isCellHandle(this.content)) {
        const contentCell = this.content;
        const update = () => this.requestUpdate();
        this._unsubscribe = contentCell.subscribe(update, {
          onRefused: update,
        });
        const read = contentCell.lastRead();
        if ("unread" in read || ("value" in read && read.value === undefined)) {
          void contentCell.sync().then(() => {
            if (this.content === contentCell) {
              this.requestUpdate();
            }
          }).catch(() => {});
        }
      }
    }
  }

  override firstUpdated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.firstUpdated(changedProperties);
    if (this.theme) {
      this._updateThemeProperties();
    }
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    if (changedProperties.has("theme") && this.theme) {
      this._updateThemeProperties();
    }
  }

  private _markdownCallbacks: MarkdownCallbacks = {
    checkboxToggled: (index: number, checked: boolean) => {
      this.emit("cf-checkbox-change", { index, checked });
    },
  };

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  private _updateThemeProperties() {
    if (!this.theme) return;
    applyThemeToElement(this, this.theme);
  }

  override render() {
    const classes = {
      "markdown-content": true,
      inverse: this.variant === "inverse",
      streaming: this.streaming,
      compact: this.compact,
    };

    return html`
      <div class="${classMap(classes)}" part="content">
        ${markdownTemplate(this._getContentValue(), this._markdownCallbacks)}
      </div>
    `;
  }
}
