// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFEmptyState } from "./index.ts";

describe("CFEmptyState", () => {
  afterEach(() => document.body.replaceChildren());

  it("should be defined", () => {
    expect(CFEmptyState).toBeDefined();
  });

  it("registers the custom element", () => {
    expect(customElements.get("cf-empty-state")).toBe(CFEmptyState);
  });

  it("should create element instance", () => {
    const element = new CFEmptyState();
    expect(element).toBeInstanceOf(CFEmptyState);
  });

  it("should have default properties", () => {
    const element = new CFEmptyState();
    expect(element.message).toBe("");
  });

  it("should accept a message property", () => {
    const element = new CFEmptyState();
    element.message = "No items yet. Add one below!";
    expect(element.message).toBe("No items yet. Add one below!");
  });

  describe("render()", () => {
    /** The rendered part named `name`. */
    function part(element: CFEmptyState, name: string): Element {
      return element.shadowRoot!.querySelector(`[part=${name}]`)!;
    }

    /** Runs `change` and waits for the slot change and update it causes. */
    async function afterSlotChange(
      element: CFEmptyState,
      change: () => void,
    ): Promise<void> {
      const changed = Promise.withResolvers<void>();
      element.shadowRoot!.addEventListener(
        "slotchange",
        () => changed.resolve(),
        { once: true },
      );
      change();
      await changed.promise;
      await element.updateComplete;
    }

    it("renders the message as the default slot's fallback", async () => {
      const element = await mount(
        Object.assign(new CFEmptyState(), { message: "No items yet." }),
      );

      expect(
        part(element, "message").querySelector("slot:not([name])")
          ?.textContent,
      ).toBe("No items yet.");
    });

    it("hides the icon and action containers while they are empty", async () => {
      const element = await mount(new CFEmptyState());

      expect(part(element, "icon").classList.contains("empty")).toBe(true);
      expect(part(element, "action").classList.contains("empty")).toBe(true);
    });

    it("shows the icon container once an icon is slotted", async () => {
      const element = await mount(new CFEmptyState());
      const icon = document.createElement("span");
      icon.slot = "icon";

      await afterSlotChange(element, () => element.append(icon));

      expect(part(element, "icon").classList.contains("empty")).toBe(false);
      expect(part(element, "action").classList.contains("empty")).toBe(true);
    });

    it("shows the action container once an action is slotted", async () => {
      const element = await mount(new CFEmptyState());
      const action = document.createElement("button");
      action.slot = "action";

      await afterSlotChange(element, () => element.append(action));

      expect(part(element, "action").classList.contains("empty")).toBe(false);
      expect(part(element, "icon").classList.contains("empty")).toBe(true);
    });

    it("hides the icon and action containers again once emptied", async () => {
      const element = await mount(new CFEmptyState());
      const icon = document.createElement("span");
      icon.slot = "icon";
      const action = document.createElement("button");
      action.slot = "action";
      await afterSlotChange(element, () => element.append(icon));
      await afterSlotChange(element, () => element.append(action));

      await afterSlotChange(element, () => icon.remove());
      expect(part(element, "icon").classList.contains("empty")).toBe(true);
      expect(part(element, "action").classList.contains("empty")).toBe(false);

      await afterSlotChange(element, () => action.remove());
      expect(part(element, "action").classList.contains("empty")).toBe(true);
    });
  });
});
