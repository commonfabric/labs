import { CFAccordionItem } from "./cf-accordion-item.ts";

if (!customElements.get("cf-accordion-item")) {
  customElements.define("cf-accordion-item", CFAccordionItem);
}

export type { CFAccordionItem as CFAccordionItemElement } from "./cf-accordion-item.ts";
export { CFAccordionItem };
