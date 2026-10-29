import { BaseElement } from "../../core/base-element.ts";

/**
 * A zero-UI component that emits a "start" event once when connected to the DOM.
 * Use with `onstart={handler}` to auto-trigger an action on mount.
 */
export class CFAutostart extends BaseElement {
  private _started = false;

  override connectedCallback() {
    super.connectedCallback();
    if (!this._started) {
      this._started = true;
      this.emit("start");
    }
  }
}
