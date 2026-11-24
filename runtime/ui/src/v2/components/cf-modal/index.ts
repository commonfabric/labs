import { CFModal } from "./cf-modal.ts";

if (!customElements.get("cf-modal")) {
  customElements.define("cf-modal", CFModal);
}

export type { CFModal as CFModalElement } from "./cf-modal.ts";

export { CFModal };
export { modalStyles } from "./styles.ts";
