import { type CellHandle, isCellHandle } from "@commonfabric/runtime-client";
import { html } from "lit";
import { property } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";

export class CFRouter extends BaseElement {
  @property({ attribute: false })
  accessor path: CellHandle<string> | string = "/";

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("cf-route-change", this.onRouteChange);
  }

  onRouteChange = (e: Event) => {
    e.stopPropagation();
    const { to } = (e as CustomEvent<{ to: string }>).detail;
    if (isCellHandle(this.path)) {
      this.path.set(to);
    } else {
      this.path = to;
    }
  };

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("cf-route-change", this.onRouteChange);
  }

  override render() {
    return html`
      <slot></slot>
    `;
  }
}
