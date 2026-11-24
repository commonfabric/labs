// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFField } from "./index.ts";

describe("CFField", () => {
  afterEach(() => document.body.replaceChildren());

  it("should be defined", () => {
    expect(CFField).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(customElements.get("cf-field")).toBe(CFField);
  });

  it("should create element instance", () => {
    const element = new CFField();
    expect(element).toBeInstanceOf(CFField);
  });

  it("should have default properties", () => {
    const element = new CFField();
    expect(element.label).toBe("");
    expect(element.required).toBe(false);
    expect(element.error).toBe("");
    expect(element.help).toBe("");
  });

  it("should not set attributes in constructor (custom element spec)", () => {
    // The custom element spec forbids setAttribute during construction.
    const element = new CFField();
    expect(element.getAttribute("label")).toBeNull();
    expect(element.getAttribute("required")).toBeNull();
  });

  describe("render()", () => {
    it("renders the label text with a required indicator", async () => {
      const element = await mount(
        Object.assign(new CFField(), { label: "Email", required: true }),
      );

      const label = element.shadowRoot!.querySelector(".label");
      expect(label?.textContent).toContain("Email");
      expect(
        element.shadowRoot!.querySelector(".required-indicator")
          ?.textContent,
      ).toBe("*");
    });

    it("renders no required indicator when not required", async () => {
      const element = await mount(
        Object.assign(new CFField(), { label: "Email" }),
      );

      expect(element.shadowRoot!.querySelector(".label")).not.toBeNull();
      expect(element.shadowRoot!.querySelector(".required-indicator"))
        .toBeNull();
    });

    it("renders no label element when label is empty", async () => {
      const element = await mount(new CFField());

      expect(element.shadowRoot!.querySelector(".label")).toBeNull();
    });

    it("renders help text when set", async () => {
      const element = await mount(
        Object.assign(new CFField(), {
          label: "Name",
          help: "Shown on your profile",
        }),
      );

      const help = element.shadowRoot!.querySelector(".help");
      expect(help?.textContent).toBe("Shown on your profile");
      expect(element.shadowRoot!.querySelector(".error")).toBeNull();
    });

    it("renders error text instead of help when both are set", async () => {
      const element = await mount(
        Object.assign(new CFField(), {
          label: "Name",
          help: "Shown on your profile",
          error: "Name is required",
        }),
      );

      const error = element.shadowRoot!.querySelector(".error");
      expect(error?.textContent).toBe("Name is required");
      expect(error?.getAttribute("role")).toBe("alert");
      expect(element.shadowRoot!.querySelector(".help")).toBeNull();
    });

    it("renders neither help nor error when both are empty", async () => {
      const element = await mount(new CFField());

      expect(element.shadowRoot!.querySelector(".help")).toBeNull();
      expect(element.shadowRoot!.querySelector(".error")).toBeNull();
    });
  });

  describe("getControl()", () => {
    it("returns the first element in the default slot", async () => {
      const element = new CFField();
      const named = document.createElement("span");
      named.slot = "other";
      const input = document.createElement("input");
      input.title = "first";
      element.append(named, input, document.createElement("input"));
      await mount(element);

      expect(element.getControl()?.title).toBe("first");
    });

    it("returns null when nothing is slotted", async () => {
      const element = await mount(new CFField());

      expect(element.getControl()?.localName).toBeUndefined();
    });
  });

  describe("label click", () => {
    /** A mounted field labeled "Email" around `control`, and its label. */
    async function fieldAround(
      control?: HTMLElement,
    ): Promise<HTMLElement> {
      const element = new CFField();
      element.label = "Email";
      if (control) element.append(control);
      await mount(element);
      return element.shadowRoot!.querySelector<HTMLElement>(".label")!;
    }

    it("focuses the slotted control without clicking a native one", async () => {
      const input = document.createElement("input");
      let clicks = 0;
      input.addEventListener("click", () => clicks++);

      (await fieldAround(input)).click();

      expect(document.activeElement?.localName).toBe("input");
      expect(clicks).toBe(0);
    });

    it("focuses and clicks a slotted custom element", async () => {
      const control = document.createElement("x-control");
      control.tabIndex = 0;
      let clicks = 0;
      control.addEventListener("click", () => clicks++);

      (await fieldAround(control)).click();

      expect(document.activeElement?.localName).toBe("x-control");
      expect(clicks).toBe(1);
    });

    it("focuses nothing when no control is slotted", async () => {
      (await fieldAround()).click();

      expect(document.activeElement?.localName).toBe("body");
    });
  });
});
