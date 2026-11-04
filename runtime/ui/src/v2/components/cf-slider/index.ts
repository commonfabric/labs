import { CFSlider, SliderOrientation } from "./cf-slider.ts";

if (!customElements.get("cf-slider")) {
  customElements.define("cf-slider", CFSlider);
}

export type { CFSlider as CFSliderElement } from "./cf-slider.ts";

export { CFSlider };
export type { SliderOrientation };
