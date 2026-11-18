import { CFC_POLICY_PLACEHOLDER_TEXT } from "@commonfabric/html/client";
import { type CellHandle, isCellHandle } from "@commonfabric/runtime-client";
import { css, html } from "lit";
import { property } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { sanitizeSvg } from "./sanitize-svg.ts";

// TODO(v2-token-migration): Migrate this component to component-level tokens,
// matching the prior phase-1 token migration pattern.

/**
 * CFSvg - Renders SVG content from a string
 *
 * The source is sanitized before it is drawn, so untrusted content is safe to
 * pass in. `sanitize-svg.ts` describes what survives and what does not.
 *
 * @element cf-svg
 *
 * @attr {string} content - The SVG markup to render (string or CellHandle<string>)
 *
 * @csspart content - The SVG content wrapper
 *
 * @example
 * <cf-svg content="<svg viewBox='0 0 100 100'><circle cx='50' cy='50' r='40' fill='blue'/></svg>"></cf-svg>
 *
 * @example
 * <cf-svg .content=${mySvgCell}></cf-svg>
 */
export class CFSvg extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        --cf-svg-width: 100%;
        --cf-svg-height: auto;

        display: block;
        box-sizing: border-box;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .svg-content {
        width: var(--cf-svg-width, 100%);
        height: var(--cf-svg-height, auto);
      }

      .svg-content svg {
        width: var(--cf-svg-width, 100%);
        height: var(--cf-svg-height, auto);
        display: block;
      }
    `,
  ];

  @property({ attribute: false })
  accessor content: CellHandle<string> | string = "";

  /** The cell whose changes redraw the element, while it is connected. */
  #followed: { cell: CellHandle<string>; cancel: () => void } | undefined;

  override connectedCallback() {
    super.connectedCallback();
    this.#follow();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#follow();
  }

  override willUpdate(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.willUpdate(changedProperties);
    // Before render, so that the first render reads the cell it follows.
    this.#follow();
  }

  override render() {
    // Markup the worker will not show is replaced by the placeholder a render
    // shows in its place, as text rather than as an empty drawing.
    if (
      isCellHandle<string>(this.content) && this.content.refusal !== undefined
    ) {
      return html`
        <div class="svg-content" part="content">${CFC_POLICY_PLACEHOLDER_TEXT}</div>
      `;
    }
    const contentValue = this.#getContentValue();

    return html`
      <div class="svg-content" part="content">
        ${sanitizeSvg(contentValue)}
      </div>
    `;
  }

  /**
   * Subscribes to the cell `content` holds while the element is connected,
   * and to nothing otherwise, cancelling the subscription it held before.
   */
  #follow(): void {
    const cell = this.isConnected && isCellHandle<string>(this.content)
      ? this.content
      : undefined;
    if (cell === this.#followed?.cell) return;
    this.#followed?.cancel();
    const update = () => this.requestUpdate();
    this.#followed = cell && {
      cell,
      cancel: cell.subscribe(update, { onRefused: update }),
    };
  }

  #getContentValue(): string {
    if (isCellHandle<string>(this.content)) {
      const read = this.content.lastRead();
      return "value" in read ? read.value ?? "" : "";
    }
    return this.content ?? "";
  }
}
