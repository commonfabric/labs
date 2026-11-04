import { CFAttachmentsBar } from "./cf-attachments-bar.ts";

if (!customElements.get("cf-attachments-bar")) {
  customElements.define("cf-attachments-bar", CFAttachmentsBar);
}

export { CFAttachmentsBar };
export type { CFAttachmentsBar as CFAttachmentsBarElement } from "./cf-attachments-bar.ts";
