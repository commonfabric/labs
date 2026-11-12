// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { NAVIGATE_EVENT } from "@commonfabric/navigation";

import { CFSpaceLink } from "./index.ts";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

/** A space link mounted with `properties`. */
function linkWith(properties: Partial<CFSpaceLink>): Promise<CFSpaceLink> {
  return mount(Object.assign(new CFSpaceLink(), properties));
}

/** The chip a space link draws. */
const chip = (element: CFSpaceLink) =>
  element.shadowRoot!.querySelector("cf-chip")!;

/** Clicks `element`'s chip, and returns where it asked the host to go and
 * whether the click reached the page. */
function clickChip(element: CFSpaceLink) {
  const destinations: unknown[] = [];
  const onNavigate = (event: Event) => {
    if (event instanceof CustomEvent) destinations.push(event.detail);
  };
  let reachedPage = false;
  const onClick = () => reachedPage = true;
  globalThis.addEventListener(NAVIGATE_EVENT, onNavigate);
  document.body.addEventListener("click", onClick);
  chip(element).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  globalThis.removeEventListener(NAVIGATE_EVENT, onNavigate);
  document.body.removeEventListener("click", onClick);
  return { destinations, reachedPage };
}

describe("CFSpaceLink", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-space-link`", () => {
    expect(customElements.get("cf-space-link")).toBe(CFSpaceLink);
  });

  describe("render()", () => {
    it("shows the label over the space's name and DID", async () => {
      const element = await linkWith({
        label: "Ours",
        spaceName: "team",
        spaceDid: DID,
      });
      expect(chip(element).textContent!.trim()).toBe("Ours");
      expect(chip(element).getAttribute("color")).toBe("primary");
      expect(chip(element).hasAttribute("interactive")).toBe(true);
    });

    it("shows the space's name over its DID", async () => {
      const element = await linkWith({ spaceName: "team", spaceDid: DID });
      expect(chip(element).textContent!.trim()).toBe("team");
    });

    it("shows a long DID by its two ends", async () => {
      const element = await linkWith({ spaceDid: DID });
      expect(chip(element).textContent!.trim()).toBe("did:key:z6...ta2doK");
    });

    it("shows a DID of twenty characters or fewer whole", async () => {
      const element = await linkWith({ spaceDid: "did:key:z6MkShort" });
      expect(chip(element).textContent!.trim()).toBe("did:key:z6MkShort");
    });

    it("shows that the space is unknown when given neither a name nor a DID", async () => {
      const element = await linkWith({});
      expect(chip(element).textContent!.trim()).toBe("Unknown Space");
    });
  });

  describe("a click", () => {
    it("asks the host to go to the space by its DID, and goes no further", async () => {
      const element = await linkWith({ spaceName: "team", spaceDid: DID });
      expect(clickChip(element)).toEqual({
        destinations: [{ spaceDid: DID }],
        reachedPage: false,
      });
    });

    it("asks the host to go to the space by its name when it has no DID", async () => {
      const element = await linkWith({ spaceName: "team" });
      expect(clickChip(element).destinations).toEqual([{ spaceName: "team" }]);
    });

    it("asks the host to go nowhere for an unknown space", async () => {
      const element = await linkWith({ label: "Somewhere" });
      expect(clickChip(element)).toEqual({
        destinations: [],
        reachedPage: false,
      });
    });
  });
});
