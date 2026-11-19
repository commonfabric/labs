import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { MockDoc } from "../src/mock-doc.ts";
import {
  applyPendingRenderAuthoredAttributeUpdate,
  setPendingRenderState,
} from "../src/pending-render.ts";

describe("applyPendingRenderAuthoredAttributeUpdate()", () => {
  it("keeps retained content inert and busy while restoring the latest authored values on recovery", () => {
    const element = new MockDoc("").document.createElement("section");
    element.setAttribute("inert", "original");
    element.setAttribute("aria-busy", "false");
    setPendingRenderState(element, true);

    applyPendingRenderAuthoredAttributeUpdate(element, "inert", () => {
      expect(element.getAttribute("inert")).toBe("original");
      expect(element.getAttribute("aria-busy")).toBe("false");
      element.removeAttribute("inert");
    });
    expect(element.getAttribute("inert")).toBe("");
    expect(element.getAttribute("aria-busy")).toBe("true");

    applyPendingRenderAuthoredAttributeUpdate(element, "aria-busy", () => {
      expect(element.hasAttribute("inert")).toBe(false);
      expect(element.getAttribute("aria-busy")).toBe("false");
      element.setAttribute("aria-busy", "application-busy");
    });
    setPendingRenderState(element, true);
    expect(element.getAttribute("inert")).toBe("");
    expect(element.getAttribute("aria-busy")).toBe("true");

    setPendingRenderState(element, false);
    expect(element.hasAttribute("inert")).toBe(false);
    expect(element.getAttribute("aria-busy")).toBe("application-busy");
    expect(element.hasAttribute("data-cf-pending")).toBe(false);

    applyPendingRenderAuthoredAttributeUpdate(element, "inert", () => {
      element.setAttribute("inert", "recovered");
    });
    expect(element.getAttribute("inert")).toBe("recovered");
  });

  it("reapplies pending safety after an authored update throws and preserves its completed writes for recovery", () => {
    const element = new MockDoc("").document.createElement("section");
    element.setAttribute("aria-busy", "false");
    setPendingRenderState(element, true);
    const failure = new Error("Authored update failed");
    let thrown: unknown;

    try {
      applyPendingRenderAuthoredAttributeUpdate(element, "aria-busy", () => {
        element.removeAttribute("aria-busy");
        element.setAttribute("inert", "authored");
        throw failure;
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(element.getAttribute("inert")).toBe("");
    expect(element.getAttribute("aria-busy")).toBe("true");

    setPendingRenderState(element, false);
    expect(element.getAttribute("inert")).toBe("authored");
    expect(element.hasAttribute("aria-busy")).toBe(false);
  });

  it("passes through unrelated updates without exposing retained content to interaction", () => {
    const element = new MockDoc("").document.createElement("section");
    setPendingRenderState(element, true);
    let calls = 0;
    applyPendingRenderAuthoredAttributeUpdate(element, "title", () => {
      calls++;
      expect(element.getAttribute("inert")).toBe("");
      expect(element.getAttribute("aria-busy")).toBe("true");
      element.setAttribute("title", "Updated title");
    });
    expect(calls).toBe(1);
    setPendingRenderState(element, false);
    expect(element.getAttribute("title")).toBe("Updated title");
    expect(element.hasAttribute("inert")).toBe(false);
    expect(element.hasAttribute("aria-busy")).toBe(false);
  });

  it("runs updates once for a missing node or a text node", () => {
    const text = new MockDoc("").document.createTextNode("Retained text");
    let calls = 0;
    applyPendingRenderAuthoredAttributeUpdate(null, "inert", () => calls++);
    applyPendingRenderAuthoredAttributeUpdate(text, "aria-busy", () => {
      calls++;
      text.textContent = "Updated text";
    });
    expect(calls).toBe(2);
    expect(text.textContent).toBe("Updated text");
  });
});
