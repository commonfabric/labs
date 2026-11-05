import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

export class CFCanvas extends BaseElement {
  @property({ type: Number })
  accessor width = 800;
  @property({ type: Number })
  accessor height = 600;

  static override styles = css`
    :host {
      display: block;
    }

    .canvas-container {
      position: relative;
      width: var(--canvas-width, 800px);
      height: var(--canvas-height, 600px);
      border: 1px solid #ddd;
      background: #f9f9f9;
      overflow: auto;
    }

    .canvas-container ::slotted(*) {
      position: absolute !important;
    }
  `;

  private handleCanvasClick(event: MouseEvent) {
    // Check if the click is on the canvas itself, not a child element
    const target = event.target as HTMLElement;
    const container = event.currentTarget as HTMLElement;

    // If clicking on a child element (not the canvas background), ignore it
    if (target !== container) {
      return;
    }

    const rect = container.getBoundingClientRect();

    // Calculate relative position within the canvas
    const x = Math.round(event.clientX - rect.left);
    const y = Math.round(event.clientY - rect.top);

    // Emit event using BaseElement's emit method
    this.emit("cf-canvas-click", { x, y });
  }

  override render() {
    return html`
      <div
        class="canvas-container"
        style="--canvas-width: ${this.width}px; --canvas-height: ${this
          .height}px"
        @click="${this.handleCanvasClick}"
      >
        <slot></slot>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-canvas": CFCanvas;
  }
}
