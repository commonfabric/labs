// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { figmaMapping } from "./cf-tab-bar.figma.ts";
import { CFTabBar, CFTabBarItem } from "./index.ts";

/** Mounts the markup in `html` and resolves with its first `selector`. */
async function mountMarkup(html: string, selector: string) {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  const element = host.querySelector(selector);
  if (!(element instanceof CFTabBar || element instanceof CFTabBarItem)) {
    throw new Error(`no ${selector} in ${html}`);
  }
  await element.updateComplete;
  return element;
}

const items = figmaMapping.items.props;

describe("figmaMapping", () => {
  afterEach(() => document.body.replaceChildren());

  it("names the registered bar and item elements", () => {
    expect(customElements.get(figmaMapping.element)).toBe(CFTabBar);
    expect(customElements.get(figmaMapping.items.element)).toBe(CFTabBarItem);
  });

  it("maps each Style to the bar's default variant or one its styles name", () => {
    const styles = CFTabBar.elementStyles.map((style) => String(style)).join();
    const defaultVariant = new CFTabBar().variant;
    const variants = Object.values(figmaMapping.props.Style.values);
    expect(variants).toContain(defaultVariant);
    expect(
      variants.filter((variant) =>
        variant !== defaultVariant && !styles.includes(`[variant="${variant}"]`)
      ),
    ).toEqual([]);
  });

  it("maps the bar's action button to a slot the bar renders", async () => {
    const bar = await mount(new CFTabBar());
    const slots = Array.from(
      bar.shadowRoot!.querySelectorAll("slot"),
      (slot) => `slot="${slot.name}"`,
    );
    expect(slots).toContain(figmaMapping.slots.Button.split(" ")[0]);
  });

  it("maps Label to the attribute the item shows", async () => {
    const item = await mountMarkup(
      `<cf-tab-bar-item ${items.Label.codeProp}="Home"></cf-tab-bar-item>`,
      "cf-tab-bar-item",
    );
    expect(item.shadowRoot!.querySelector("[part=label]")!.textContent!.trim())
      .toBe("Home");
  });

  it("maps a hidden label to the attribute that hides it", async () => {
    const item = await mountMarkup(
      `<cf-tab-bar-item label="Home" ${
        items["Show Label"].codeProp
      }></cf-tab-bar-item>`,
      "cf-tab-bar-item",
    );
    expect(item.shadowRoot!.querySelector("[part=label]")).toBeNull();
  });

  it("maps symbol to the item's icon slot", async () => {
    const item = await mountMarkup(
      `<cf-tab-bar-item><span ${items.symbol.codeProp}>*</span></cf-tab-bar-item>`,
      "cf-tab-bar-item",
    );
    const slot = item.shadowRoot!.querySelector<HTMLSlotElement>(
      "[part=icon] slot",
    )!;
    expect(slot.assignedElements().map((icon) => icon.textContent))
      .toEqual(["*"]);
  });

  it("gives an example whose bars use mapped variants", () => {
    const host = document.createElement("div");
    host.innerHTML = figmaMapping.example;
    const variants = Array.from(
      host.querySelectorAll("cf-tab-bar"),
      (bar) => bar.getAttribute("variant"),
    );
    expect(variants).toEqual(Object.values(figmaMapping.props.Style.values));
  });
});
