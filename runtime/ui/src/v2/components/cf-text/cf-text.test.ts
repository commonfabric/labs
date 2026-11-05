/**
 * Tests for CFText component
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CFText } from "./index.ts";

function stylesText(): string {
  return (CFText.styles as Array<{ cssText: string }>)
    .map((style) => style.cssText)
    .join("\n");
}

describe("CFText", () => {
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
