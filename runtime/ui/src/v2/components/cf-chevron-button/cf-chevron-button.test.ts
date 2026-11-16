// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFChevronButton } from "./index.ts";

/** A chevron button with `properties` set, mounted in the document. */
function chevron(
  properties: Partial<Pick<CFChevronButton, "expanded" | "loading">> = {},
): Promise<CFChevronButton> {
  return mount(Object.assign(new CFChevronButton(), properties));
}

/** The `<button>` that `element` renders. */
function inner(element: CFChevronButton): HTMLButtonElement {
  const found = element.shadowRoot!.querySelector("button");
  if (!found) throw new Error("cf-chevron-button rendered no button");
  return found;
}

/** What `element`'s button tells a user, and which icon it shows. */
function presentation(element: CFChevronButton) {
  const button = inner(element);
  return {
    label: button.getAttribute("aria-label"),
    expanded: button.getAttribute("aria-expanded"),
    title: button.title,
    chevron: button.querySelector(".chevron-icon") !== null,
    wave: button.querySelector(".loading-wave") !== null,
  };
}

describe("CFChevronButton", () => {
  afterEach(() => document.body.replaceChildren());

  it("offers to expand while collapsed", async () => {
    expect(presentation(await chevron())).toEqual({
      label: "Expand",
      expanded: "false",
      title: "Show",
      chevron: true,
      wave: false,
    });
  });

  it("offers to collapse while expanded, and reflects the state to its host", async () => {
    const element = await chevron({ expanded: true });
    expect(presentation(element)).toEqual({
      label: "Collapse",
      expanded: "true",
      title: "Hide",
      chevron: true,
      wave: false,
    });
    expect(element.hasAttribute("expanded")).toBe(true);
  });

  it("shows a loading wave in place of the chevron while loading", async () => {
    const element = await chevron({ expanded: true, loading: true });
    expect(presentation(element)).toEqual({
      label: "Loading",
      expanded: "true",
      title: "Loading...",
      chevron: false,
      wave: true,
    });
    expect(element.hasAttribute("loading")).toBe(true);
  });

  it("emits cf-toggle when its button is clicked", async () => {
    const element = await chevron();
    let toggles = 0;
    element.addEventListener("cf-toggle", () => toggles++);

    inner(element).click();

    expect(toggles).toBe(1);
  });

  it("emits no cf-toggle until its button is clicked", async () => {
    const element = await chevron();
    let toggles = 0;
    element.addEventListener("cf-toggle", () => toggles++);

    element.expanded = true;
    await element.updateComplete;

    expect(toggles).toBe(0);
  });
});
