/**
 * Tests for CFHStack component
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CFHStack } from "./index.ts";

/**
 * Extracts the class info object passed to classMap in render().
 */
function renderedClasses(element: CFHStack): Record<string, boolean> {
  const result = element.render() as unknown as {
    values: Array<{ values: unknown[] }>;
  };
  return result.values[0].values[0] as Record<string, boolean>;
}

describe("CFHStack", () => {
  it("should be defined", () => {
    expect(CFHStack).toBeDefined();
  });

  it("registers the custom element", () => {
    expect(customElements.get("cf-hstack")).toBe(CFHStack);
  });

  it("should have default properties", () => {
    const element = new CFHStack();
    expect(element.gap).toBe("0");
    expect(element.align).toBe("stretch");
    expect(element.justify).toBe("start");
    expect(element.wrap).toBe(false);
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
    const classes = renderedClasses(new CFHStack());
    expect(classes["p-0"]).toBe(true);
    expect(classes["px-"]).toBe(false);
    expect(classes["py-"]).toBe(false);
    expect(classes["pt-"]).toBe(false);
    expect(classes["pr-"]).toBe(false);
    expect(classes["pb-"]).toBe(false);
    expect(classes["pl-"]).toBe(false);
  });

  it("applies directional padding classes when set", () => {
    const element = new CFHStack();
    element.py = "2";
    element.pl = "4";
    const classes = renderedClasses(element);
    expect(classes["p-0"]).toBe(true);
    expect(classes["py-2"]).toBe(true);
    expect(classes["pl-4"]).toBe(true);
  });
});
