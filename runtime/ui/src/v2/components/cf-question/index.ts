import { CFQuestion } from "./cf-question.ts";

if (!customElements.get("cf-question")) {
  customElements.define("cf-question", CFQuestion);
}

export { CFQuestion };
export type { CFQuestion as CFQuestionElement } from "./cf-question.ts";
