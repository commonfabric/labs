import { AccordionType, CFAccordion } from "./cf-accordion.ts";

if (!customElements.get("cf-accordion")) {
  customElements.define("cf-accordion", CFAccordion);
}

export type { CFAccordion as CFAccordionElement } from "./cf-accordion.ts";

export { CFAccordion };
export type { AccordionType };
