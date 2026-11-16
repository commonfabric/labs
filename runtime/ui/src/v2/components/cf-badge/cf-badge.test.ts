// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFBadge } from "./index.ts";

/** A badge holding `text`, with `properties` set, mounted in the document. */
function badge(
  text: string,
  properties: Record<string, unknown> = {},
): Promise<CFBadge> {
  const element = Object.assign(new CFBadge(), properties);
  element.append(text);
  return mount(element);
}

/** The element `element` draws its badge with. */
function body(element: CFBadge): HTMLElement {
  const found = element.shadowRoot!.querySelector<HTMLElement>(".badge");
  if (!found) throw new Error("cf-badge rendered no badge");
  return found;
}

/** The remove button `element` renders, if any. */
function removeButton(element: CFBadge): HTMLButtonElement | null {
  return element.shadowRoot!.querySelector("button.close-button");
}

describe("CFBadge", () => {
  afterEach(() => document.body.replaceChildren());

  it("draws a small neutral solid badge by default", async () => {
    const element = await badge("New");
    expect([...body(element).classList]).toEqual(["badge", "solid", "neutral"]);
    expect(element.getAttribute("size")).toBe("sm");
  });

  it("draws the variant, color, and size it is given", async () => {
    const element = await badge("New", {
      variant: "outline",
      color: "danger",
      size: "lg",
    });
    expect([...body(element).classList]).toEqual([
      "badge",
      "outline",
      "danger",
    ]);
    expect(element.getAttribute("size")).toBe("lg");
  });

  it("replaces an unknown variant, color, or size with the default", async () => {
    const element = await badge("New", {
      variant: "ghost",
      color: "secondary",
      size: "huge",
    });
    expect(element.variant).toBe("solid");
    expect(element.color).toBe("neutral");
    expect(element.size).toBe("sm");
    expect([...body(element).classList]).toEqual(["badge", "solid", "neutral"]);
  });

  it("renders no remove button unless it is removable", async () => {
    expect(removeButton(await badge("New"))).toBeNull();
  });

  it("emits cf-remove with its color and variant when its remove button is clicked", async () => {
    const element = await badge("New", { removable: true, color: "accent" });
    const removals: unknown[] = [];
    element.addEventListener(
      "cf-remove",
      (event) => removals.push((event as CustomEvent).detail),
    );
    let clicksOutside = 0;
    document.body.addEventListener("click", () => clicksOutside++);

    const button = removeButton(element);
    expect(button?.getAttribute("aria-label")).toBe("Remove");
    button!.click();

    expect(removals).toEqual([{ color: "accent", variant: "solid" }]);
    expect(clicksOutside).toBe(0);
  });
});
