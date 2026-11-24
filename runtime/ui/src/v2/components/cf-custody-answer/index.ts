/** Registers and exports the custody-answer publication component. */

import { CFCustodyAnswer } from "./cf-custody-answer.ts";

if (!customElements.get("cf-custody-answer")) {
  customElements.define("cf-custody-answer", CFCustodyAnswer);
}

export { CFCustodyAnswer };
export type { CFCustodyAnswer as CFCustodyAnswerElement } from "./cf-custody-answer.ts";
