import { CFHScroll } from "./cf-hscroll.ts";

if (!customElements.get("cf-hscroll")) {
  customElements.define("cf-hscroll", CFHScroll);
}

export type { CFHScroll as CFHScrollElement } from "./cf-hscroll.ts";

export { CFHScroll };
