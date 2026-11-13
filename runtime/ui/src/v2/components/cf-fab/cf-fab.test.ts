// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import type { CellHandle } from "@commonfabric/runtime-client";

import {
  createMockCellHandle,
  pushRefusal,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";
import { CFFab } from "./index.ts";

/** The element in `fab`'s shadow root that `selector` names, if rendered. */
function part(fab: CFFab, selector: string): HTMLElement | null {
  return fab.shadowRoot!.querySelector<HTMLElement>(selector);
}

/** What the preview notification shows, or `undefined` while it is hidden. */
function previewShown(fab: CFFab): string | undefined {
  const message = fab.shadowRoot!.querySelector<
    HTMLElement & { content?: string }
  >(".preview-notification cf-chat-message");
  return message === null ? undefined : message.content;
}

/**
 * A mock cell holding `value`, whose `asSchema()` returns the cell itself, so
 * that what the test pushes to it reaches the fab's subscription.
 */
function previewCell(value: string): CellHandle<string> {
  const cell = createMockCellHandle(value);
  Object.defineProperty(cell, "asSchema", { value: () => cell });
  return cell;
}

/** A fab with `props` set. */
function fabWith(
  props: Partial<
    Pick<
      CFFab,
      | "expanded"
      | "previewMessage"
      | "messages"
      | "pinCount"
      | "placeholderText"
    >
  >,
): CFFab {
  return Object.assign(new CFFab(), props);
}

/** Every `name` event `fab` dispatches, counted. */
function count(fab: CFFab, name: string): { count: number } {
  const seen = { count: 0 };
  fab.addEventListener(name, () => seen.count++);
  return seen;
}

describe("CFFab", () => {
  let time: FakeTime;

  beforeEach(() => {
    time = new FakeTime();
  });

  afterEach(() => {
    document.body.replaceChildren();
    time.restore();
  });

  it("registers the custom element", () => {
    expect(customElements.get("cf-fab")).toBe(CFFab);
  });

  describe("rendering", () => {
    it("labels the collapsed fab as a focusable control that opens", async () => {
      const fab = await mount(new CFFab());
      const control = part(fab, ".fab")!;
      expect(control.getAttribute("aria-expanded")).toBe("false");
      expect(control.getAttribute("aria-label")).toBe("Open");
      expect(control.getAttribute("tabindex")).toBe("0");
      expect(part(fab, ".backdrop")!.classList.contains("active")).toBe(false);
    });

    it("labels the expanded fab as one that closes, out of the tab order", async () => {
      const fab = await mount(fabWith({ expanded: true }));
      const control = part(fab, ".fab")!;
      expect(control.getAttribute("aria-expanded")).toBe("true");
      expect(control.getAttribute("aria-label")).toBe("Close");
      expect(control.getAttribute("tabindex")).toBe("-1");
      expect(part(fab, ".backdrop")!.classList.contains("active")).toBe(true);
    });

    it("shows the placeholder text when it has no messages", async () => {
      const fab = await mount(
        fabWith({ placeholderText: "Say something" }),
      );
      expect(part(fab, ".fab-placeholder")!.textContent).toBe("Say something");
      expect(part(fab, "cf-message-beads")).toBeNull();
    });

    it("shows its messages as beads in place of the placeholder", async () => {
      const messages = createMockCellHandle<unknown>([]);
      const fab = await mount(fabWith({ messages }));
      const beads = part(fab, "cf-message-beads") as
        | (HTMLElement & { messages?: unknown })
        | null;
      expect(beads?.messages).toBe(messages);
      expect(part(fab, ".fab-placeholder")).toBeNull();
    });

    it("shows a dot per pinned item, up to eight", async () => {
      const fab = await mount(fabWith({ pinCount: 3 }));
      const dots = () => fab.shadowRoot!.querySelectorAll(".pin-dot").length;
      expect(dots()).toBe(3);

      fab.pinCount = 20;
      await fab.updateComplete;
      expect(dots()).toBe(8);

      fab.pinCount = 0;
      await fab.updateComplete;
      expect(part(fab, ".pin-dots")).toBeNull();
    });
  });

  describe("expanding and collapsing", () => {
    it("marks itself collapsing for the length of the collapse animation", async () => {
      const fab = await mount(fabWith({ expanded: true }));
      expect(fab.hasAttribute("collapsing")).toBe(false);

      fab.expanded = false;
      await fab.updateComplete;
      expect(fab.hasAttribute("collapsing")).toBe(true);

      time.tick(399);
      expect(fab.hasAttribute("collapsing")).toBe(true);
      time.tick(1);
      expect(fab.hasAttribute("collapsing")).toBe(false);
    });

    it("does not let an earlier collapse end a later one early", async () => {
      const fab = await mount(fabWith({ expanded: true }));
      fab.expanded = false;
      await fab.updateComplete;
      time.tick(300);

      // Reopened and closed again: the first timer would end it at 400ms.
      fab.expanded = true;
      await fab.updateComplete;
      fab.expanded = false;
      await fab.updateComplete;
      time.tick(300);
      expect(fab.hasAttribute("collapsing")).toBe(true);
      time.tick(100);
      expect(fab.hasAttribute("collapsing")).toBe(false);
    });

    it("stops collapsing at once when it expands", async () => {
      const fab = await mount(fabWith({ expanded: true }));
      fab.expanded = false;
      await fab.updateComplete;

      fab.expanded = true;
      await fab.updateComplete;
      expect(fab.hasAttribute("collapsing")).toBe(false);
    });

    it("does not mark a fab that starts collapsed as collapsing", async () => {
      const fab = await mount(new CFFab());
      expect(fab.hasAttribute("collapsing")).toBe(false);
    });
  });

  describe("clicks", () => {
    it("keeps a click on the expanded fab from reaching the page", async () => {
      const fab = await mount(fabWith({ expanded: true }));
      let reached = false;
      const reach = () => reached = true;
      document.body.addEventListener("click", reach);
      part(fab, ".fab-panel")!.click();
      document.body.removeEventListener("click", reach);
      expect(reached).toBe(false);
    });

    it("lets a click on the collapsed fab reach the page", async () => {
      const fab = await mount(new CFFab());
      let reached = false;
      const reach = () => reached = true;
      document.body.addEventListener("click", reach);
      part(fab, ".fab")!.click();
      document.body.removeEventListener("click", reach);
      expect(reached).toBe(true);
    });

    describe("anywhere in the window", () => {
      // Each click lands on the page's body and bubbles to the window, where
      // the fab listens. The fab is given a box, since happy-dom lays nothing
      // out.

      /** A mounted fab whose `.fab` box spans (100, 100) to (300, 200). */
      async function mountBoxedFab(expanded: boolean): Promise<CFFab> {
        const fab = await mount(fabWith({ expanded }));
        Object.defineProperty(part(fab, ".fab")!, "getBoundingClientRect", {
          value: () => ({ left: 100, right: 300, top: 100, bottom: 200 }),
        });
        return fab;
      }

      /** Clicks the page at (`clientX`, `clientY`). */
      function clickAt(clientX: number, clientY: number): void {
        document.body.dispatchEvent(
          new MouseEvent("click", { bubbles: true, clientX, clientY }),
        );
      }

      it("dispatches `cf-fab-backdrop-click` for a click outside the expanded fab", async () => {
        const fab = await mountBoxedFab(true);
        const backdropClicks = count(fab, "cf-fab-backdrop-click");
        clickAt(50, 150);
        clickAt(350, 150);
        clickAt(200, 50);
        clickAt(200, 250);
        expect(backdropClicks.count).toBe(4);
      });

      it("does not dispatch `cf-fab-backdrop-click` for a click inside the expanded fab", async () => {
        const fab = await mountBoxedFab(true);
        const backdropClicks = count(fab, "cf-fab-backdrop-click");
        clickAt(100, 100);
        clickAt(300, 200);
        expect(backdropClicks.count).toBe(0);
      });

      it("does not dispatch `cf-fab-backdrop-click` while collapsed", async () => {
        const fab = await mountBoxedFab(false);
        const backdropClicks = count(fab, "cf-fab-backdrop-click");
        clickAt(50, 150);
        expect(backdropClicks.count).toBe(0);
      });

      it("does not dispatch `cf-fab-backdrop-click` before it has rendered", async () => {
        // Connected, so listening, but its first render has not run yet.
        const fab = fabWith({ expanded: true });
        const backdropClicks = count(fab, "cf-fab-backdrop-click");
        document.body.append(fab);
        clickAt(50, 150);
        await fab.updateComplete;
        expect(backdropClicks.count).toBe(0);
      });

      it("does not dispatch `cf-fab-backdrop-click` once removed from the document", async () => {
        const fab = await mountBoxedFab(true);
        const backdropClicks = count(fab, "cf-fab-backdrop-click");
        fab.remove();
        clickAt(50, 150);
        expect(backdropClicks.count).toBe(0);
      });
    });
  });

  describe("Escape", () => {
    /** Presses `key` with focus on the document. */
    function press(key: string): void {
      document.dispatchEvent(new KeyboardEvent("keydown", { key }));
    }

    it("dispatches `cf-fab-escape` while expanded", async () => {
      const fab = await mount(fabWith({ expanded: true }));
      const escapes = count(fab, "cf-fab-escape");
      press("Escape");
      expect(escapes.count).toBe(1);
    });

    it("does not dispatch `cf-fab-escape` for another key", async () => {
      const fab = await mount(fabWith({ expanded: true }));
      const escapes = count(fab, "cf-fab-escape");
      press("Enter");
      expect(escapes.count).toBe(0);
    });

    it("does not dispatch `cf-fab-escape` while collapsed", async () => {
      const fab = await mount(new CFFab());
      const escapes = count(fab, "cf-fab-escape");
      press("Escape");
      expect(escapes.count).toBe(0);
    });

    it("does not dispatch `cf-fab-escape` once removed from the document", async () => {
      const fab = await mount(fabWith({ expanded: true }));
      const escapes = count(fab, "cf-fab-escape");
      fab.remove();
      press("Escape");
      expect(escapes.count).toBe(0);
    });
  });

  describe("preview notification", () => {
    it("shows a string preview message for five seconds while collapsed", async () => {
      const fab = await mount(
        fabWith({ previewMessage: "Done!" }),
      );
      // The message arrives in `updated()`, so it shows on the next render.
      await fab.updateComplete;
      expect(previewShown(fab)).toBe("Done!");

      time.tick(4999);
      await fab.updateComplete;
      expect(previewShown(fab)).toBe("Done!");
      time.tick(1);
      await fab.updateComplete;
      expect(previewShown(fab)).toBeUndefined();
    });

    it("does not show a preview message while expanded", async () => {
      const fab = await mount(
        fabWith({ expanded: true, previewMessage: "Done!" }),
      );
      await fab.updateComplete;
      expect(previewShown(fab)).toBeUndefined();

      fab.expanded = false;
      await fab.updateComplete;
      expect(previewShown(fab)).toBeUndefined();
    });

    it("shows the preview message a cell holds, and each one it is pushed", async () => {
      const cell = previewCell("First");
      const fab = await mount(
        fabWith({ previewMessage: cell }),
      );
      await fab.updateComplete;
      expect(previewShown(fab)).toBe("First");

      time.tick(4000);
      pushUpdate(cell, "Second");
      await fab.updateComplete;
      expect(previewShown(fab)).toBe("Second");

      // The second message restarted the five seconds.
      time.tick(4000);
      await fab.updateComplete;
      expect(previewShown(fab)).toBe("Second");
      time.tick(1000);
      await fab.updateComplete;
      expect(previewShown(fab)).toBeUndefined();
    });

    it("does not show an empty message a cell is pushed", async () => {
      const cell = previewCell("First");
      const fab = await mount(
        fabWith({ previewMessage: cell }),
      );
      time.tick(5000);
      pushUpdate(cell, "");
      await fab.updateComplete;
      expect(previewShown(fab)).toBeUndefined();
    });

    it("hides the preview message once the worker refuses the cell", async () => {
      const cell = previewCell("Secret");
      const fab = await mount(
        fabWith({ previewMessage: cell }),
      );
      await fab.updateComplete;
      expect(previewShown(fab)).toBe("Secret");

      pushRefusal(cell);
      await fab.updateComplete;
      expect(previewShown(fab)).toBeUndefined();
    });

    it("stops following a cell it no longer shows", async () => {
      const cell = previewCell("First");
      const fab = await mount(
        fabWith({ previewMessage: cell }),
      );
      fab.previewMessage = undefined;
      await fab.updateComplete;
      time.tick(5000);
      await fab.updateComplete;

      pushUpdate(cell, "Second");
      await fab.updateComplete;
      expect(previewShown(fab)).toBeUndefined();
    });

    it("follows its cell again once removed and added back", async () => {
      const cell = previewCell("First");
      const fab = await mount(
        fabWith({ previewMessage: cell }),
      );
      time.tick(5000);
      await fab.updateComplete;

      fab.remove();
      document.body.append(fab);
      await fab.updateComplete;
      // The message it already showed is not shown again.
      expect(previewShown(fab)).toBeUndefined();

      pushUpdate(cell, "Second");
      await fab.updateComplete;
      expect(previewShown(fab)).toBe("Second");
    });

    it("shows, once added back, the message its cell came to hold while it was removed", async () => {
      const cell = previewCell("First");
      const fab = await mount(
        fabWith({ previewMessage: cell }),
      );
      time.tick(5000);
      await fab.updateComplete;

      fab.remove();
      pushUpdate(cell, "Second");
      await fab.updateComplete;
      expect(previewShown(fab)).toBeUndefined();

      document.body.append(fab);
      await fab.updateComplete;
      expect(previewShown(fab)).toBe("Second");
    });

    it("follows a cell it is given while removed only once added back", async () => {
      const fab = await mount(new CFFab());
      fab.remove();
      const cell = previewCell("First");
      fab.previewMessage = cell;
      // Following the cell would show its message in a second update.
      await fab.updateComplete;
      await fab.updateComplete;
      expect(previewShown(fab)).toBeUndefined();

      document.body.append(fab);
      await fab.updateComplete;
      expect(previewShown(fab)).toBe("First");
    });
  });

  it("ends its collapse and hides its preview once removed mid-collapse", async () => {
    const fab = await mount(
      fabWith({ expanded: true }),
    );
    fab.expanded = false;
    await fab.updateComplete;
    fab.previewMessage = "Done!";
    await fab.updateComplete;
    await fab.updateComplete;
    expect(previewShown(fab)).toBe("Done!");
    expect(fab.hasAttribute("collapsing")).toBe(true);

    fab.remove();
    document.body.append(fab);
    await fab.updateComplete;
    expect(fab.hasAttribute("collapsing")).toBe(false);
    expect(previewShown(fab)).toBeUndefined();

    // The next collapse runs its full length, ended by no timer left over
    // from the first.
    time.tick(200);
    fab.expanded = true;
    await fab.updateComplete;
    fab.expanded = false;
    await fab.updateComplete;
    time.tick(399);
    expect(fab.hasAttribute("collapsing")).toBe(true);
    time.tick(1);
    expect(fab.hasAttribute("collapsing")).toBe(false);
  });
});
