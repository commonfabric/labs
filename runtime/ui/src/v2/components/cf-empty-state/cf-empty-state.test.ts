/**
 * Tests for CFEmptyState component
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CFEmptyState } from "./index.ts";

describe("CFEmptyState", () => {
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
});
