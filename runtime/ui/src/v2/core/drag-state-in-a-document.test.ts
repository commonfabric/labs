// First, so that the document it installs is there when Lit loads.
import { settle } from "../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  type CellHandle,
  NotificationType,
} from "@commonfabric/runtime-client";

import { createRenderableCellHandle } from "../test-utils/mock-vdom-connection.ts";
import { createDragPreview, suppressClickAfterDrag } from "./drag-state.ts";

/** An element in the document, and what reaches its parent of each click. */
function draggedElement() {
  const parent = document.createElement("div");
  const element = document.createElement("button");
  parent.append(element);
  document.body.append(parent);
  const clicksReachingParent: string[] = [];
  parent.addEventListener("click", () => clicksReachingParent.push("click"));
  return { element, clicksReachingParent };
}

/** Clicks `element` as a released pointer does; returns the event. */
function click(element: HTMLElement): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

describe("drag-state", () => {
  afterEach(() => document.body.replaceChildren());

  describe("suppressClickAfterDrag()", () => {
    it("swallows the next click on the element, and only that one", () => {
      const { element, clicksReachingParent } = draggedElement();
      let reachedElement = false;
      element.addEventListener("click", () => reachedElement = true);
      suppressClickAfterDrag(element);

      const swallowed = click(element);
      expect(swallowed.defaultPrevented).toBe(true);
      expect(reachedElement).toBe(false);
      expect(clicksReachingParent).toEqual([]);

      const next = click(element);
      expect(next.defaultPrevented).toBe(false);
      expect(reachedElement).toBe(true);
      expect(clicksReachingParent).toEqual(["click"]);
    });

    it("lets a click through once a new press on the element begins", () => {
      const { element, clicksReachingParent } = draggedElement();
      suppressClickAfterDrag(element);

      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      const event = click(element);
      expect(event.defaultPrevented).toBe(false);
      expect(clicksReachingParent).toEqual(["click"]);
    });
  });

  describe("createDragPreview()", () => {
    it("warns when a batch of the `[UI]` preview's render fails to apply", async () => {
      const { cell, deliver } = createRenderableCellHandle({
        $UI: { type: "vnode", name: "div", props: {}, children: [] },
      });
      const { cleanup } = createDragPreview(cell as CellHandle);
      await settle();
      using warn = stub(console, "warn");
      try {
        deliver({
          type: NotificationType.VDomBatch,
          batchId: 1,
          // An element made its own child, which the document refuses.
          ops: [
            { op: "create-element", nodeId: 1, tagName: "div" },
            { op: "insert-child", parentId: 1, childId: 1, beforeId: null },
          ],
        });
      } finally {
        cleanup!();
      }
      expect(warn.calls.map((call) => call.args[0])).toEqual([
        "[drag-state] Failed to render [UI] preview:",
      ]);
    });
  });
});
