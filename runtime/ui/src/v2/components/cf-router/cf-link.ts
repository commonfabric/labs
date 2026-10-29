import { html } from "lit";
import { property } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

export class CFLink extends BaseElement {
  @property({ type: String })
  accessor to = "";

  private onClick = (e: Event) => {
    e.preventDefault();
    this.emit("cf-route-change", { to: this.to });
  };

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener("click", this.onClick);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("click", this.onClick);
  }

  override render() {
    return html`
      <slot></slot>
    `;
  }
}
