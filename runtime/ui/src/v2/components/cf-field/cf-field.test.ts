/**
 * Tests for CFField component
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CFField } from "./index.ts";

describe("CFField", () => {
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

  if (typeof document !== "undefined") {
    it("should be creatable via document.createElement", async () => {
      const element = document.createElement("cf-field") as CFField;
      document.body.append(element);
      await element.updateComplete;

      expect(element).toBeInstanceOf(CFField);

      element.remove();
    });

    it("should render label text with required indicator", async () => {
      const element = document.createElement("cf-field") as CFField;
      element.label = "Email";
      element.required = true;
      document.body.append(element);
      await element.updateComplete;

      const label = element.shadowRoot?.querySelector(".label");
      expect(label?.textContent).toContain("Email");
      const indicator = element.shadowRoot?.querySelector(
        ".required-indicator",
      );
      expect(indicator?.textContent).toBe("*");

      element.remove();
    });

    it("should not render a label element when label is empty", async () => {
      const element = document.createElement("cf-field") as CFField;
      document.body.append(element);
      await element.updateComplete;

      expect(element.shadowRoot?.querySelector(".label")).toBeNull();

      element.remove();
    });

    it("should render help text when set", async () => {
      const element = document.createElement("cf-field") as CFField;
      element.label = "Name";
      element.help = "Shown on your profile";
      document.body.append(element);
      await element.updateComplete;

      const help = element.shadowRoot?.querySelector(".help");
      expect(help?.textContent).toBe("Shown on your profile");
      expect(element.shadowRoot?.querySelector(".error")).toBeNull();

      element.remove();
    });

    it("should render error text instead of help when both are set", async () => {
      const element = document.createElement("cf-field") as CFField;
      element.label = "Name";
      element.help = "Shown on your profile";
      element.error = "Name is required";
      document.body.append(element);
      await element.updateComplete;

      const error = element.shadowRoot?.querySelector(".error");
      expect(error?.textContent).toBe("Name is required");
      expect(error?.getAttribute("role")).toBe("alert");
      expect(element.shadowRoot?.querySelector(".help")).toBeNull();

      element.remove();
    });

    it("should return the slotted control via getControl()", async () => {
      const element = document.createElement("cf-field") as CFField;
      element.label = "Email";
      const input = document.createElement("input");
      element.append(input);
      document.body.append(element);
      await element.updateComplete;

      expect(element.getControl()).toBe(input);

      element.remove();
    });

    it("should focus the slotted control when the label is clicked", async () => {
      const element = document.createElement("cf-field") as CFField;
      element.label = "Email";
      const input = document.createElement("input");
      element.append(input);
      document.body.append(element);
      await element.updateComplete;

      const label = element.shadowRoot?.querySelector(
        ".label",
      ) as HTMLElement;
      label.click();

      expect(document.activeElement).toBe(input);

      element.remove();
    });
  }
});
