import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

export class CFDraggable extends BaseElement {
  @property({ type: Number })
  accessor x = 0;

  @property({ type: Number })
  accessor y = 0;

  @property({ type: Boolean, reflect: true })
  override accessor hidden = false;

  @state()
  private accessor isDragging = false;

  private dragStartX = 0;
  private dragStartY = 0;
  private initialMouseX = 0;
  private initialMouseY = 0;

  static override styles = css`
    :host {
      position: absolute;
      padding: 10px;
      background-color: #ffffcc;
      border: 1px solid #ddd;
      border-radius: 4px;
      max-width: 200px;
      cursor: move;
      user-select: none;
    }

    :host(.dragging) {
      opacity: 0.8;
      z-index: 1000;
      cursor: grabbing;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    // Set initial position from props
    this.style.left = `${this.x}px`;
    this.style.top = `${this.y}px`;

    // Add document-level listeners for mouse move and up
    document.addEventListener("mousemove", this.handleMouseMove);
    document.addEventListener("mouseup", this.handleMouseUp);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("mousemove", this.handleMouseMove);
    document.removeEventListener("mouseup", this.handleMouseUp);
  }

  private handleMouseDown = (event: MouseEvent) => {
    // Don't start drag if clicking on an input or button
    const target = event.target as HTMLElement;
    if (
      target.tagName === "INPUT" || target.tagName === "BUTTON" ||
      target.tagName === "CF-INPUT" || target.tagName === "CF-TEXTAREA" ||
      target.tagName === "CF-SELECT" || target.tagName === "CF-BUTTON" ||
      target.closest("common-send-message")
    ) {
      return;
    }

    event.preventDefault();
    this.isDragging = true;
    this.dragStartX = this.x;
    this.dragStartY = this.y;
    this.initialMouseX = event.clientX;
    this.initialMouseY = event.clientY;
    this.classList.add("dragging");
  };

  private handleMouseMove = (event: MouseEvent) => {
    if (!this.isDragging) return;

    const deltaX = event.clientX - this.initialMouseX;
    const deltaY = event.clientY - this.initialMouseY;
    const newX = this.dragStartX + deltaX;
    const newY = this.dragStartY + deltaY;

    // Update position immediately for smooth dragging
    this.style.left = `${newX}px`;
    this.style.top = `${newY}px`;
  };

  private handleMouseUp = (event: MouseEvent) => {
    if (!this.isDragging) return;

    // Stop the event from bubbling up to the canvas
    event.stopPropagation();

    this.isDragging = false;
    this.classList.remove("dragging");

    const deltaX = event.clientX - this.initialMouseX;
    const deltaY = event.clientY - this.initialMouseY;
    const newX = this.dragStartX + deltaX;
    const newY = this.dragStartY + deltaY;

    // Emit position change event with new coordinates
    this.emit("positionchange", { x: newX, y: newY });
  };

  override updated(changedProperties: Map<string, any>) {
    // Update position from props only when not dragging
    if (
      !this.isDragging &&
      (changedProperties.has("x") || changedProperties.has("y"))
    ) {
      this.style.left = `${this.x}px`;
      this.style.top = `${this.y}px`;
    }
  }

  override render() {
    return html`
      <div @mousedown="${this.handleMouseDown}">
        <slot></slot>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-draggable": CFDraggable;
  }
}
