// deno-lint-ignore-file cf-imports/no-inline-module-import -- the layout
// extends a bare HTMLElement as it loads, so it can only load once the test
// has installed one.

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { XOmniLayout } from "../src/components/OmniLayout.ts";
import { installBrowserGlobals, installGlobals } from "./browser-globals.ts";
import { templateListeners, templateMarkup } from "./lit-template-markup.ts";

/** The resize handle a render binds its drag listeners to. */
class StandInHandle extends EventTarget {
  /** The pointers the handle has captured, in order. */
  readonly captured: number[] = [];

  /** Records that the handle captured `pointerId`. */
  setPointerCapture(pointerId: number): void {
    this.captured.push(pointerId);
  }
}

/** A node assigned to the sidebar slot. */
type AssignedNode = { nodeType: number; textContent: string | null };

/** A slot, holding the nodes assigned to it. */
type StandInSlot = EventTarget & { assignedNodes(): AssignedNode[] };

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

/** Returns a pointer event at `clientX`, as a drag on the handle sends. */
function pointerEvent(type: string, clientX: number): Event {
  return Object.assign(new Event(type, { cancelable: true }), {
    clientX,
    pointerId: 7,
  });
}

/** Returns a slot holding `nodes`. */
function slotHolding(nodes: AssignedNode[]): StandInSlot {
  return Object.assign(new EventTarget(), { assignedNodes: () => nodes });
}

/**
 * Binds the listeners `layout` renders onto a stand-in handle and a stand-in
 * sidebar slot, which a test then dispatches events on.
 */
function wire(layout: XOmniLayout): {
  handle: StandInHandle;
  /**
   * Assigns `nodes` to the sidebar slot, which then sends a `slotchange`
   * from `source`, the sidebar slot itself unless another is given.
   */
  assign(nodes: AssignedNode[], source?: StandInSlot): void;
} {
  const view = layout.render();
  const handle = new StandInHandle();
  for (const type of ["pointerdown", "pointermove", "lostpointercapture"]) {
    for (const { dispatch } of templateListeners(view, type, layout)) {
      handle.addEventListener(type, dispatch);
    }
  }
  let assigned: AssignedNode[] = [];
  const slot = Object.assign(new EventTarget(), {
    assignedNodes: () => assigned,
  });
  for (const { dispatch } of templateListeners(view, "slotchange", layout)) {
    slot.addEventListener("slotchange", dispatch);
  }
  return {
    handle,
    assign(nodes, source = slot) {
      assigned = nodes;
      const event = new Event("slotchange", { bubbles: true });
      Object.defineProperty(event, "target", { value: source });
      slot.dispatchEvent(event);
    },
  };
}

/**
 * Runs the update that follows a change to `layout`, as Lit would were it
 * connected, and returns what the layout then publishes to its host: the
 * sidebar's width, and whether the sidebar's grid column is open.
 */
function published(layout: XOmniLayout): { width: string; open: boolean } {
  layout.updated();
  return {
    width: layout.style.getPropertyValue("--sidebar-width"),
    open: layout.hasAttribute("sidebar-open"),
  };
}

describe("XOmniLayout", () => {
  let restore: () => void;
  let OmniLayout: typeof XOmniLayout;

  beforeAll(async () => {
    const restoreBrowser = installBrowserGlobals("http://localhost:8000/");
    const restoreNode = installGlobals({
      Node: { ELEMENT_NODE, TEXT_NODE },
    });
    restore = () => {
      restoreNode();
      restoreBrowser();
    };
    ({ XOmniLayout: OmniLayout } = await import(
      "../src/components/OmniLayout.ts"
    ));
  });

  afterAll(() => restore());

  it("is defined as `x-omni-layout`", () => {
    expect(customElements.get("x-omni-layout")).toBe(OmniLayout);
  });

  describe("sidebar visibility", () => {
    it("shows the sidebar when it is open and has an element in it", () => {
      const layout = new OmniLayout();
      layout.sidebarOpen = true;
      wire(layout).assign([{ nodeType: ELEMENT_NODE, textContent: "" }]);

      expect(templateMarkup(layout.render())).toContain(
        'class="sidebar-container visible"',
      );
      expect(published(layout).open).toBe(true);
    });

    it("hides the sidebar when it is closed, whatever it holds", () => {
      const layout = new OmniLayout();
      wire(layout).assign([{ nodeType: ELEMENT_NODE, textContent: "" }]);

      expect(templateMarkup(layout.render())).not.toContain("visible");
      expect(published(layout).open).toBe(false);
    });

    it("hides an open sidebar until something is assigned to it", () => {
      const layout = new OmniLayout();
      layout.sidebarOpen = true;

      expect(templateMarkup(layout.render())).not.toContain("visible");
      expect(published(layout).open).toBe(false);
    });

    it("counts text as content only when it is not blank", () => {
      const layout = new OmniLayout();
      layout.sidebarOpen = true;
      const { assign } = wire(layout);

      assign([
        { nodeType: TEXT_NODE, textContent: " \n " },
        { nodeType: TEXT_NODE, textContent: null },
        { nodeType: COMMENT_NODE, textContent: "a comment" },
      ]);
      expect(templateMarkup(layout.render())).not.toContain("visible");

      assign([{ nodeType: TEXT_NODE, textContent: " Notes " }]);
      expect(templateMarkup(layout.render())).toContain("visible");
    });

    it("hides the sidebar again when its content is removed", () => {
      const layout = new OmniLayout();
      layout.sidebarOpen = true;
      const { assign } = wire(layout);
      assign([{ nodeType: ELEMENT_NODE, textContent: "" }]);
      expect(published(layout).open).toBe(true);

      assign([]);

      expect(templateMarkup(layout.render())).not.toContain("visible");
      expect(published(layout).open).toBe(false);
    });

    it("closes the sidebar's column when the sidebar is closed", () => {
      const layout = new OmniLayout();
      layout.sidebarOpen = true;
      wire(layout).assign([{ nodeType: ELEMENT_NODE, textContent: "" }]);
      expect(published(layout).open).toBe(true);

      layout.sidebarOpen = false;

      expect(published(layout).open).toBe(false);
    });

    it("measures its own slot when a slot forwarded into it changes", () => {
      const layout = new OmniLayout();
      layout.sidebarOpen = true;
      const { assign } = wire(layout);
      const element = { nodeType: ELEMENT_NODE, textContent: "" };

      // The forwarded slot has emptied, but the sidebar still holds an element.
      assign([element], slotHolding([]));

      expect(templateMarkup(layout.render())).toContain("visible");
      expect(published(layout).open).toBe(true);
    });
  });

  describe("resizing", () => {
    it("publishes the default width of 320 pixels", () => {
      expect(published(new OmniLayout()).width).toBe("320px");
    });

    it("captures the pointer and marks the handle as dragging", () => {
      const layout = new OmniLayout();
      const { handle } = wire(layout);
      const down = pointerEvent("pointerdown", 1000);

      handle.dispatchEvent(down);

      expect(down.defaultPrevented).toBe(true);
      expect(handle.captured).toEqual([7]);
      expect(templateMarkup(layout.render())).toContain(
        'class="resize-handle dragging"',
      );
    });

    it("widens the sidebar by how far a drag moves left", () => {
      const layout = new OmniLayout();
      const { handle } = wire(layout);

      handle.dispatchEvent(pointerEvent("pointerdown", 1000));
      handle.dispatchEvent(pointerEvent("pointermove", 900));
      expect(published(layout).width).toBe("420px");

      handle.dispatchEvent(pointerEvent("pointermove", 1050));
      expect(published(layout).width).toBe("270px");
    });

    it("holds the width between 200 and 600 pixels", () => {
      const layout = new OmniLayout();
      const { handle } = wire(layout);

      handle.dispatchEvent(pointerEvent("pointerdown", 1000));
      handle.dispatchEvent(pointerEvent("pointermove", 0));
      expect(published(layout).width).toBe("600px");

      handle.dispatchEvent(pointerEvent("pointermove", 2000));
      expect(published(layout).width).toBe("200px");
    });

    it("measures a second drag from the width the first one left", () => {
      const layout = new OmniLayout();
      const { handle } = wire(layout);
      handle.dispatchEvent(pointerEvent("pointerdown", 1000));
      handle.dispatchEvent(pointerEvent("pointermove", 900));
      handle.dispatchEvent(new Event("lostpointercapture"));

      handle.dispatchEvent(pointerEvent("pointerdown", 500));
      handle.dispatchEvent(pointerEvent("pointermove", 450));

      expect(published(layout).width).toBe("470px");
    });

    it("leaves the width alone once the handle loses the pointer", () => {
      const layout = new OmniLayout();
      const { handle } = wire(layout);
      handle.dispatchEvent(pointerEvent("pointerdown", 1000));
      handle.dispatchEvent(pointerEvent("pointermove", 900));

      handle.dispatchEvent(new Event("lostpointercapture"));
      handle.dispatchEvent(pointerEvent("pointermove", 800));

      expect(published(layout).width).toBe("420px");
      expect(templateMarkup(layout.render())).toContain(
        'class="resize-handle "',
      );
    });

    it("ignores a pointer moving over the handle without a drag", () => {
      const layout = new OmniLayout();
      const { handle } = wire(layout);

      handle.dispatchEvent(pointerEvent("pointermove", 100));

      expect(published(layout).width).toBe("320px");
    });
  });
});
