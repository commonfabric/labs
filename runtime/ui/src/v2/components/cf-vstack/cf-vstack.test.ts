/**
 * Tests for CFVStack component
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { layoutSpacingUtilityStyles } from "../../styles/layout-spacing.ts";
import { CFVStack } from "./index.ts";

/**
 * Extracts the class info object passed to classMap in render().
 * The first template value is the classMap directive result; its
 * `values[0]` is the class info record.
 */
function renderedClasses(element: CFVStack): Record<string, boolean> {
  const result = element.render() as unknown as {
    values: Array<{ values: unknown[] }>;
  };
  return result.values[0].values[0] as Record<string, boolean>;
}

describe("CFVStack", () => {
  it("should be defined", () => {
    expect(CFVStack).toBeDefined();
  });

  it("registers the custom element", () => {
    expect(customElements.get("cf-vstack")).toBe(CFVStack);
  });

  it("should have default properties", () => {
    const element = new CFVStack();
    expect(element.gap).toBe("0");
    expect(element.align).toBe("stretch");
    expect(element.justify).toBe("start");
    expect(element.reverse).toBe(false);
    expect(element.padding).toBe("0");
    expect(element.px).toBe("");
    expect(element.py).toBe("");
    expect(element.pt).toBe("");
    expect(element.pr).toBe("");
    expect(element.pb).toBe("");
    expect(element.pl).toBe("");
  });

  it("does not apply directional padding classes by default", () => {
    const classes = renderedClasses(new CFVStack());
    expect(classes["p-0"]).toBe(true);
    expect(classes["px-"]).toBe(false);
    expect(classes["py-"]).toBe(false);
    expect(classes["pt-"]).toBe(false);
    expect(classes["pr-"]).toBe(false);
    expect(classes["pb-"]).toBe(false);
    expect(classes["pl-"]).toBe(false);
  });

  it("applies directional padding classes when set", () => {
    const element = new CFVStack();
    element.padding = "4";
    element.pt = "2";
    element.px = "md";
    const classes = renderedClasses(element);
    expect(classes["p-4"]).toBe(true);
    expect(classes["pt-2"]).toBe(true);
    expect(classes["px-md"]).toBe(true);
  });

  it("orders utilities so directional padding overrides uniform padding", () => {
    const cssText = layoutSpacingUtilityStyles.cssText;
    // With equal specificity, later rules win: .p-* < .px-*/.py-* < sides.
    expect(cssText.indexOf(".p-4 ")).toBeLessThan(cssText.indexOf(".px-4 "));
    expect(cssText.indexOf(".px-4 ")).toBeLessThan(cssText.indexOf(".pt-4 "));
    expect(cssText.indexOf(".py-4 ")).toBeLessThan(cssText.indexOf(".pt-4 "));
  });

  it("defines directional utilities for the full padding scale", () => {
    const cssText = layoutSpacingUtilityStyles.cssText;
    const scale = [
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "8",
      "10",
      "12",
      "16",
      "20",
      "24",
      "xs",
      "sm",
      "md",
      "lg",
      "xl",
    ];
    for (const value of scale) {
      for (const prefix of ["px", "py", "pt", "pr", "pb", "pl"]) {
        expect(cssText).toContain(`.${prefix}-${value} `);
      }
    }
    expect(cssText).toContain("padding-top: var(--cf-spacing-2, 0.5rem)");
    expect(cssText).toContain("padding-left: var(--cf-spacing-md, 0.5rem)");
  });
});
