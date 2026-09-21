/** Exercises modal focus policy with DOM-boundary doubles; Chrome tests own layout. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { CFModal } from "./index.ts";

/** Supplies only the DOM observations consumed by the focus policy. */
class FocusNode extends EventTarget {
  children: FocusNode[] = [];
  shadowRoot: {
    children: FocusNode[];
    activeElement?: FocusNode;
  } | null = null;
  attributes = new Set<string>();
  focusable = false;
  disabled = false;
  hidden = false;
  inert = false;
  tabIndex = 0;
  isConnected = true;
  display = "block";
  visibility = "visible";
  rects = 1;
  onFocus: () => void = () => {};

  focus(): void {
    this.onFocus();
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  matches(selector: string): boolean {
    return selector === ":disabled" ? this.disabled : this.focusable;
  }

  getClientRects(): object[] {
    return Array.from({ length: this.rects }, () => ({}));
  }
}

class HtmlNode extends FocusNode {}
class SvgNode extends FocusNode {}
class SlotNode extends HtmlNode {
  assigned: FocusNode[] = [];

  assignedElements(): FocusNode[] {
    return this.assigned;
  }
}

/** Owns and restores every global supplied at the headless DOM boundary. */
function fixture() {
  const document = { activeElement: null as FocusNode | null };
  const frames: FrameRequestCallback[] = [];
  const globals: Record<string, unknown> = {
    document,
    HTMLElement: HtmlNode,
    SVGElement: SvgNode,
    HTMLSlotElement: SlotNode,
    getComputedStyle: (node: FocusNode) => ({
      display: node.display,
      visibility: node.visibility,
    }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const dialog = new HtmlNode();
  const modal = new CFModal();
  modal.preventScroll = false;
  Object.defineProperty(modal, "shadowRoot", {
    configurable: true,
    value: {
      querySelector: (selector: string) =>
        selector === ".dialog" ? dialog : null,
    },
  });
  const focusCalls: FocusNode[] = [];
  const control = <T extends FocusNode>(node: T): T => {
    node.focusable = true;
    node.onFocus = () => focusCalls.push(node);
    return node;
  };
  return {
    document,
    dialog,
    modal,
    control,
    focusCalls,
    setOpen(open: boolean) {
      const changes = new Map([["open", modal.open]]);
      modal.open = open;
      modal.willUpdate(changes);
      modal.updated(changes);
    },
    key(path: FocusNode[], shiftKey = false) {
      const template = modal.render();
      const index = template.strings.findIndex((part) =>
        part.trimEnd().endsWith('@keydown="')
      );
      expect(index).toBeGreaterThanOrEqual(0);
      const handler = template.values[index];
      if (typeof handler !== "function") {
        throw new Error("The modal did not publish a keyboard handler.");
      }
      const event = Object.assign(new Event("keydown", { cancelable: true }), {
        key: "Tab",
        shiftKey,
        composedPath: () => path,
      });
      handler(event);
      return event;
    },
    restore() {
      frames.length = 0;
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

describe("CFModal", () => {
  let view: ReturnType<typeof fixture>;
  beforeEach(() => {
    view = fixture();
  });
  afterEach(() => view.restore());
  const expectFocus = (...nodes: FocusNode[]) => {
    expect(view.focusCalls).toHaveLength(nodes.length);
    nodes.forEach((node, index) => expect(view.focusCalls[index]).toBe(node));
  };

  describe("focus lifecycle", () => {
    it("wraps in composed order and recognizes a host that delegates input focus", () => {
      const first = view.control(new HtmlNode());
      const middle = view.control(new SvgNode());
      const last = view.control(new HtmlNode());
      const innerInput = view.control(new HtmlNode());
      innerInput.tabIndex = -1;
      last.shadowRoot = { children: [innerInput] };
      const header = new SlotNode();
      header.assigned = [first];
      header.children = [view.control(new HtmlNode())];
      const body = new HtmlNode();
      body.shadowRoot = { children: [middle] };
      body.children = [view.control(new HtmlNode())];
      const footer = new SlotNode();
      footer.assigned = [last];
      view.dialog.children = [header, body, footer];
      view.setOpen(true);

      expect(view.key([middle, body, view.dialog]).defaultPrevented).toBe(
        false,
      );
      expectFocus();
      expect(view.key([innerInput, last, footer]).defaultPrevented).toBe(true);
      expectFocus(first);
      expect(view.key([first, header], true).defaultPrevented).toBe(true);
      expectFocus(first, last);
    });

    it("wraps at the last available SVG control instead of an unavailable descendant", () => {
      const first = view.control(new HtmlNode());
      const last = view.control(new SvgNode());
      const unavailable = [
        { hidden: true },
        { inert: true },
        { display: "none" },
        { disabled: true },
        { tabIndex: -1 },
        { visibility: "hidden" },
        { rects: 0 },
      ].map((properties) => {
        const node = view.control(new HtmlNode());
        Object.assign(node, properties);
        return node;
      });
      for (const node of unavailable.slice(0, 3)) {
        node.children = [view.control(new HtmlNode())];
      }
      const disabledAttribute = view.control(new HtmlNode());
      disabledAttribute.attributes.add("disabled");
      disabledAttribute.children = [view.control(new SvgNode())];
      view.dialog.children = [first, last, ...unavailable, disabledAttribute];
      view.setOpen(true);

      expect(view.key([last, view.dialog]).defaultPrevented).toBe(true);
      expectFocus(first);
      expect(view.key([first, view.dialog], true).defaultPrevented).toBe(true);
      expectFocus(first, last);
    });

    for (const connected of [true, false]) {
      it(
        connected
          ? "restores the actual opener through nested shadow roots"
          : "does not refocus a detached opener",
        () => {
          const opener = view.control(new SvgNode());
          const field = new HtmlNode();
          field.shadowRoot = { children: [opener], activeElement: opener };
          const renderer = new HtmlNode();
          renderer.shadowRoot = { children: [field], activeElement: field };
          view.document.activeElement = renderer;
          view.setOpen(true);
          opener.isConnected = connected;
          view.document.activeElement = view.dialog;
          view.setOpen(false);

          expectFocus(...(connected ? [opener] : []));
        },
      );
    }

    it("leaves empty or closed dialogs out of the keyboard focus cycle", () => {
      view.setOpen(true);
      expect(view.key([view.dialog]).defaultPrevented).toBe(false);
      view.setOpen(false);
      const control = view.control(new HtmlNode());
      view.dialog.children = [control];
      expect(view.key([control]).defaultPrevented).toBe(false);
      expectFocus();
    });
  });
});
