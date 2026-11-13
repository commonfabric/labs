// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFLink } from "./index.ts";

/** A link to `to`, mounted, and the `to` of every `cf-route-change` it
 * fires. */
async function linkTo(to: string) {
  const element = Object.assign(new CFLink(), { to });
  const routes: string[] = [];
  element.addEventListener("cf-route-change", (event) => {
    if (event instanceof CustomEvent) routes.push(event.detail.to);
  });
  return { element: await mount(element), routes };
}

/** Clicks `element`, and returns whether the click's default was
 * prevented. */
function click(element: Element): boolean {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("CFLink", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-link`", () => {
    expect(customElements.get("cf-link")).toBe(CFLink);
  });

  it("renders its content through a slot", async () => {
    const { element } = await linkTo("/a");
    expect(element.shadowRoot!.querySelector("slot")).not.toBe(null);
  });

  it("fires `cf-route-change` with its `to` on a click, in place of the click's default", async () => {
    const { element, routes } = await linkTo("/settings");
    expect(click(element)).toBe(true);
    expect(routes).toEqual(["/settings"]);
  });

  it("fires nothing once disconnected", async () => {
    const { element, routes } = await linkTo("/settings");
    element.remove();
    expect(click(element)).toBe(false);
    expect(routes).toEqual([]);
  });
});
