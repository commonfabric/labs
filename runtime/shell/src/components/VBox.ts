import { css, html, LitElement } from "lit";

export class VBoxElement extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }

    div {
      display: flex;
      flex-direction: column;
    }
  `;

  override render() {
    return html`
      <div><slot></slot></div>
    `;
  }
}

globalThis.customElements.define("v-box", VBoxElement);
