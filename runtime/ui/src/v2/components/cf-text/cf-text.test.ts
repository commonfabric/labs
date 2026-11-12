/**
 * Tests for CFText component
 */

// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFText } from "./index.ts";

function stylesText(): string {
  return (CFText.styles as Array<{ cssText: string }>)
    .map((style) => style.cssText)
    .join("\n");
}

describe("CFText", () => {
  afterEach(() => document.body.replaceChildren());

  it("should be defined", () => {
    expect(CFText).toBeDefined();
  });

  it("registers the custom element", () => {
    expect(customElements.get("cf-text")).toBe(CFText);
  });

  it("should create element instance", () => {
    const element = new CFText();
    expect(element).toBeInstanceOf(CFText);
  });

  it("should have default properties", () => {
    const element = new CFText();
    expect(element.variant).toBe("body");
    expect(element.tone).toBe("default");
    expect(element.block).toBe(false);
    expect(element.truncate).toBe(false);
  });

  it("renders its content through a single default slot", async () => {
    const element = await mount(new CFText());
    const slots = element.shadowRoot!.querySelectorAll("slot");
    expect(slots.length).toBe(1);
    expect(slots[0].hasAttribute("name")).toBe(false);
  });

  it("reflects its properties as the attributes its styles select on", async () => {
    const element = await mount(
      Object.assign(new CFText(), {
        variant: "heading-lg",
        tone: "muted",
        block: true,
        truncate: true,
      }),
    );
    expect(element.getAttribute("variant")).toBe("heading-lg");
    expect(element.getAttribute("tone")).toBe("muted");
    expect(element.hasAttribute("block")).toBe(true);
    expect(element.hasAttribute("truncate")).toBe(true);
  });

  it("reflects its defaults, and no flags, once connected", async () => {
    const element = await mount(new CFText());
    expect(element.getAttribute("variant")).toBe("body");
    expect(element.getAttribute("tone")).toBe("default");
    expect(element.hasAttribute("block")).toBe(false);
    expect(element.hasAttribute("truncate")).toBe(false);
  });

  it("should accept the truncate property", () => {
    const element = new CFText();
    element.truncate = true;
    expect(element.truncate).toBe(true);
  });

  it("reflects truncate as an attribute selector in styles", () => {
    const truncateRule = stylesText()
      .split(":host([truncate])")[1];
    expect(truncateRule).toBeDefined();
    const block = truncateRule.slice(0, truncateRule.indexOf("}"));
    expect(block).toContain("display: block");
    expect(block).toContain("overflow: hidden");
    expect(block).toContain("text-overflow: ellipsis");
    expect(block).toContain("white-space: nowrap");
    // min-width: 0 is required for truncation inside flex rows (cf-hstack).
    expect(block).toContain("min-width: 0");
    expect(block).toContain("max-width: 100%");
  });

  it("keeps the block attribute styles intact alongside truncate", () => {
    const text = stylesText();
    expect(text).toContain(":host([block])");
  });
});
