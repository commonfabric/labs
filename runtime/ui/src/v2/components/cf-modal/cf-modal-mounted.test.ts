/**
 * Drives a modal mounted in a document: opening and closing, dismissal, and
 * its header and footer slots. The document lays nothing out, so focus
 * movement, which turns on layout, is `cf-modal.test.ts`'s.
 */

// First, so that the document it installs is there when Lit loads.
import { mount, settle } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import {
  createMockCellHandle,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFModal } from "./index.ts";

/** A modal mounted with `properties`, and every event it emits. */
async function modalWith(properties: Partial<CFModal> = {}) {
  const modal = Object.assign(new CFModal(), properties);
  const events: { type: string; detail: unknown }[] = [];
  for (
    const type of [
      "cf-modal-open",
      "cf-modal-opened",
      "cf-modal-close",
      "cf-modal-closed",
      "cf-dismiss",
    ]
  ) {
    modal.addEventListener(type, (event) => {
      events.push({
        type,
        detail: event instanceof CustomEvent ? event.detail : undefined,
      });
    });
  }
  return { modal: await mount(modal), events };
}

/** Sets `open` and waits for the modal to render it. */
async function setOpen(modal: CFModal, open: boolean): Promise<void> {
  modal.open = open;
  await modal.updateComplete;
}

const part = (modal: CFModal, name: string) =>
  modal.shadowRoot!.querySelector<HTMLElement>(`[part="${name}"]`)!;

const typesOf = (events: { type: string }[]) =>
  events.map((event) => event.type);

const closeEvents = (reason: string) => [
  { type: "cf-modal-close", detail: { reason } },
  { type: "cf-dismiss", detail: { reason } },
];

/** Presses `key` inside the dialog, and returns the event. */
function press(modal: CFModal, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  part(modal, "dialog").dispatchEvent(event);
  return event;
}

/** Clicks the backdrop area around the dialog, or inside the dialog. */
function click(modal: CFModal, where: "backdrop" | "dialog"): void {
  part(modal, where === "backdrop" ? "container" : "dialog").dispatchEvent(
    new MouseEvent("click", { bubbles: true, composed: true }),
  );
}

describe("CFModal", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.body.style.overflow = "";
  });

  describe("opening and closing", () => {
    it("reflects the open state in the `open` attribute", async () => {
      const { modal } = await modalWith({ open: true });
      expect(modal.hasAttribute("open")).toBe(true);

      await setOpen(modal, false);

      expect(modal.hasAttribute("open")).toBe(false);
    });

    it("raises the backdrop and the container to the overlay layer when it opens", async () => {
      const { modal } = await modalWith();
      expect(part(modal, "backdrop").style.zIndex).toBe("");

      await setOpen(modal, true);

      expect(part(modal, "backdrop").style.zIndex).toBe("1000");
      expect(part(modal, "container").style.zIndex).toBe("1001");
    });

    it("emits `cf-modal-open`, then `cf-modal-opened` once the dialog's opening transition ends", async () => {
      const { modal, events } = await modalWith();
      await setOpen(modal, true);
      expect(typesOf(events)).toEqual(["cf-modal-open"]);

      await settle();
      part(modal, "dialog").dispatchEvent(new Event("transitionend"));
      part(modal, "dialog").dispatchEvent(new Event("transitionend"));

      expect(typesOf(events)).toEqual(["cf-modal-open", "cf-modal-opened"]);
    });

    it("emits `cf-modal-closed` once the dialog's closing transition ends", async () => {
      const { modal, events } = await modalWith({ open: true });
      await setOpen(modal, false);
      expect(typesOf(events)).toEqual(["cf-modal-open"]);

      part(modal, "dialog").dispatchEvent(new Event("transitionend"));
      part(modal, "dialog").dispatchEvent(new Event("transitionend"));

      expect(typesOf(events)).toEqual(["cf-modal-open", "cf-modal-closed"]);
    });

    it("hides the page's scrolling while open and restores it on close", async () => {
      document.body.style.overflow = "auto";
      const { modal } = await modalWith({ open: true });
      expect(document.body.style.overflow).toBe("hidden");

      await setOpen(modal, false);

      expect(document.body.style.overflow).toBe("auto");
    });

    it("leaves the page's scrolling alone when `preventScroll` is off", async () => {
      document.body.style.overflow = "auto";

      await modalWith({ open: true, preventScroll: false });

      expect(document.body.style.overflow).toBe("auto");
    });

    it("restores the page's scrolling on close after `preventScroll` is turned off while open", async () => {
      document.body.style.overflow = "auto";
      const { modal } = await modalWith({ open: true });
      modal.preventScroll = false;
      await modal.updateComplete;

      await setOpen(modal, false);

      expect(document.body.style.overflow).toBe("auto");
    });

    it("takes no scrolling on opening after `preventScroll` is turned off, and restores none on close", async () => {
      const { modal } = await modalWith({ preventScroll: false });
      document.body.style.overflow = "auto";

      await setOpen(modal, true);
      expect(document.body.style.overflow).toBe("auto");
      document.body.style.overflow = "clip";
      await setOpen(modal, false);

      expect(document.body.style.overflow).toBe("clip");
    });

    it("keeps the page's scrolling hidden until the last of two open modals closes, in either order", async () => {
      for (const firstToClose of [0, 1]) {
        document.body.style.overflow = "auto";
        const modals = [
          (await modalWith({ open: true })).modal,
          (await modalWith({ open: true })).modal,
        ];

        await setOpen(modals[firstToClose], false);
        expect(document.body.style.overflow).toBe("hidden");
        await setOpen(modals[1 - firstToClose], false);
        expect(document.body.style.overflow).toBe("auto");

        document.body.replaceChildren();
      }
    });

    it("restores the page's scrolling when it leaves the document while open", async () => {
      document.body.style.overflow = "auto";
      const { modal } = await modalWith({ open: true });

      modal.remove();

      expect(document.body.style.overflow).toBe("auto");
    });

    it("hides the page's scrolling again when put back in the page while open", async () => {
      document.body.style.overflow = "auto";
      const { modal, events } = await modalWith({ open: true });

      modal.remove();
      document.body.append(modal);
      await modal.updateComplete;
      expect(document.body.style.overflow).toBe("hidden");
      expect(typesOf(events)).toEqual(["cf-modal-open"]);

      await setOpen(modal, false);
      expect(document.body.style.overflow).toBe("auto");
    });

    it("leaves a scrolling style it did not set when it leaves the document", async () => {
      const { modal } = await modalWith();
      document.body.style.overflow = "hidden";

      modal.remove();

      expect(document.body.style.overflow).toBe("hidden");
    });
  });

  describe("dismissal", () => {
    it("writes `false` to a bound cell and emits the close events when the close button is clicked", async () => {
      const open = createMockCellHandle(true);
      const { modal, events } = await modalWith({ open });
      events.length = 0;

      part(modal, "close-button").click();

      expect(writesSent(open)).toEqual([
        expect.objectContaining({ type: "cell:set", value: false }),
      ]);
      expect(events).toEqual(closeEvents("button"));
    });

    it("emits the close events and leaves a plain `open` to its owner on `close()`", async () => {
      const { modal, events } = await modalWith({ open: true });
      events.length = 0;

      modal.close();

      expect(events).toEqual(closeEvents("api"));
      expect(modal.open).toBe(true);
    });

    it("closes on a click on the backdrop area and not on one inside the dialog", async () => {
      const { modal, events } = await modalWith({ open: true });
      events.length = 0;

      click(modal, "dialog");
      expect(events).toEqual([]);

      click(modal, "backdrop");
      expect(events).toEqual(closeEvents("backdrop"));
    });

    it("closes on Escape while open, and claims the key", async () => {
      const { modal, events } = await modalWith({ open: true });
      events.length = 0;

      expect(press(modal, "Escape").defaultPrevented).toBe(true);
      expect(events).toEqual(closeEvents("escape"));
    });

    it("ignores Escape while closed", async () => {
      const { modal, events } = await modalWith();

      expect(press(modal, "Escape").defaultPrevented).toBe(false);
      expect(events).toEqual([]);
    });

    for (const property of ["dismissible", "dismissable"] as const) {
      it(`cannot be dismissed when \`${property}\` is off before it first renders`, async () => {
        const { modal, events } = await modalWith({
          open: true,
          [property]: false,
        });
        events.length = 0;

        expect(modal.dismissible).toBe(false);
        expect(modal.dismissable).toBe(false);
        expect(modal.hasAttribute("dismissible")).toBe(false);
        expect(modal.hasAttribute("dismissable")).toBe(false);
        expect(press(modal, "Escape").defaultPrevented).toBe(false);
        click(modal, "backdrop");
        expect(events).toEqual([]);
      });

      it(`follows \`${property}\` as it changes after the first render`, async () => {
        const { modal, events } = await modalWith({ open: true });

        modal[property] = false;
        await modal.updateComplete;
        expect(modal.dismissible).toBe(false);
        expect(modal.dismissable).toBe(false);
        expect(press(modal, "Escape").defaultPrevented).toBe(false);

        modal[property] = true;
        await modal.updateComplete;
        expect(modal.dismissible).toBe(true);
        expect(modal.dismissable).toBe(true);
        events.length = 0;
        expect(press(modal, "Escape").defaultPrevented).toBe(true);
        expect(events).toEqual(closeEvents("escape"));
      });
    }
  });

  describe("header and footer", () => {
    for (const name of ["header", "footer"]) {
      it(`marks the ${name} empty until its slot holds content`, async () => {
        const { modal } = await modalWith();
        expect(part(modal, name).classList.contains("empty")).toBe(true);

        const content = document.createElement("span");
        content.slot = name;
        modal.append(content);
        await settle();
        await modal.updateComplete;
        expect(part(modal, name).classList.contains("empty")).toBe(false);

        content.remove();
        await settle();
        await modal.updateComplete;
        expect(part(modal, name).classList.contains("empty")).toBe(true);
      });
    }
  });
});
