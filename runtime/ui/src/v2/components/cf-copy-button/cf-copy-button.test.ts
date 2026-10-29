/**
 * Tests for CFCopyButton component
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CFCopyButton } from "./index.ts";

describe("CFCopyButton", () => {
  it("should be defined", () => {
    expect(CFCopyButton).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(customElements.get("cf-copy-button")).toBe(CFCopyButton);
  });

  it("should create element instance", () => {
    const element = new CFCopyButton();
    expect(element).toBeInstanceOf(CFCopyButton);
  });

  it("should have default properties", () => {
    const element = new CFCopyButton();
    expect(element.text).toBe("");
    expect(element.variant).toBe("secondary");
    expect(element.size).toBe("md");
    expect(element.disabled).toBe(false);
    expect(element.feedbackDuration).toBe(2000);
    expect(element.iconOnly).toBe(false);
  });

  it("should accept string text property", () => {
    const element = new CFCopyButton();
    element.text = "Hello World";
    expect(element.text).toBe("Hello World");
  });

  it("should accept object text property for multi-MIME support", () => {
    const element = new CFCopyButton();
    element.text = {
      "text/plain": "Hello World",
      "text/html": "<b>Hello World</b>",
    };
    expect(element.text).toEqual({
      "text/plain": "Hello World",
      "text/html": "<b>Hello World</b>",
    });
  });

  it("should accept object with multiple MIME types", () => {
    const element = new CFCopyButton();
    element.text = {
      "text/plain": "Plain text",
      "text/html": "<p>HTML text</p>",
      "text/rtf": "{\\rtf1 RTF text}",
    };
    expect(Object.keys(element.text)).toEqual([
      "text/plain",
      "text/html",
      "text/rtf",
    ]);
  });
});
