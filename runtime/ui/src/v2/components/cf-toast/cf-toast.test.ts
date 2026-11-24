// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import { CFToast } from "./index.ts";

/** A toast mounted with `properties`, and every dismissal it announces. */
async function toastWith(properties: Partial<CFToast> = {}) {
  const element = Object.assign(new CFToast(), properties);
  const dismissals: unknown[] = [];
  const legacyDismissals: unknown[] = [];
  const actions: unknown[] = [];
  element.addEventListener("cf-dismiss", (event) => {
    if (event instanceof CustomEvent) dismissals.push(event.detail);
  });
  element.addEventListener("cf-toast-dismiss", (event) => {
    if (event instanceof CustomEvent) legacyDismissals.push(event.detail);
  });
  element.addEventListener("cf-toast-action", (event) => {
    if (event instanceof CustomEvent) actions.push(event.detail);
  });
  return {
    element: await mount(element),
    dismissals,
    legacyDismissals,
    actions,
  };
}

const part = (element: CFToast, name: string) =>
  element.shadowRoot!.querySelector<HTMLElement>(`[part="${name}"]`);

describe("CFToast", () => {
  let time: FakeTime;
  beforeEach(() => {
    time = new FakeTime();
  });
  afterEach(() => {
    document.body.replaceChildren();
    time.restore();
  });

  it("is registered as `cf-toast`", () => {
    expect(customElements.get("cf-toast")).toBe(CFToast);
  });

  describe("connected", () => {
    it("announces itself politely as a status", async () => {
      const { element } = await toastWith();
      expect(element.getAttribute("role")).toBe("status");
      expect(element.getAttribute("aria-live")).toBe("polite");
      expect(element.getAttribute("aria-atomic")).toBe("true");
      expect(element.getAttribute("status")).toBe("info");
    });

    it("announces an error assertively as an alert", async () => {
      const { element } = await toastWith({ status: "error" });
      expect(element.getAttribute("role")).toBe("alert");
      expect(element.getAttribute("aria-live")).toBe("assertive");
    });

    it("changes its announcement with its status", async () => {
      const { element } = await toastWith({ status: "error" });
      element.status = "success";
      await element.updateComplete;
      expect(element.getAttribute("role")).toBe("status");
      expect(element.getAttribute("aria-live")).toBe("polite");
    });
  });

  describe("render()", () => {
    it("has no dismiss button unless dismissible", async () => {
      const { element } = await toastWith();
      expect(part(element, "dismiss")).toBeNull();
    });

    for (
      const [name, other] of [
        ["dismissible", "dismissable"],
        ["dismissable", "dismissible"],
      ] as const
    ) {
      it(`reads \`${other}\` as matching a later change of \`${name}\``, async () => {
        const { element } = await toastWith();
        element[name] = true;
        await element.updateComplete;
        expect(element[other]).toBe(true);
        expect(element.hasAttribute("dismissible")).toBe(true);
        expect(part(element, "dismiss")).not.toBeNull();

        element[name] = false;
        await element.updateComplete;
        expect(element[other]).toBe(false);
        expect(element.hasAttribute("dismissible")).toBe(false);
        expect(part(element, "dismiss")).toBeNull();
      });

      it(`has a dismiss button when the \`${name}\` property is set before the first render`, async () => {
        const { element } = await toastWith({ [name]: true });
        expect(part(element, "dismiss")?.getAttribute("aria-label")).toBe(
          "Dismiss",
        );
        expect(element[name]).toBe(true);
        expect(element[other]).toBe(true);
        expect(element.hasAttribute("dismissible")).toBe(true);
      });

      it(`has a dismiss button when the \`${name}\` attribute is set before the first render`, async () => {
        const element = new CFToast();
        element.setAttribute(name, "");
        await mount(element);
        expect(part(element, "dismiss")).not.toBeNull();
        expect(element[name]).toBe(true);
        expect(element[other]).toBe(true);
        expect(element.hasAttribute("dismissible")).toBe(true);
      });
    }

    it("hides the icon and action areas while their slots are empty", async () => {
      const { element } = await toastWith();
      expect(part(element, "icon")!.classList.contains("empty")).toBe(true);
      expect(part(element, "action")!.classList.contains("empty")).toBe(true);
    });

    it("shows the icon and action areas once something is slotted into them", async () => {
      const { element } = await toastWith();
      const icon = document.createElement("span");
      icon.slot = "icon";
      const action = document.createElement("button");
      action.slot = "action";
      element.append(icon, action);
      await element.updateComplete;
      expect(part(element, "icon")!.classList.contains("empty")).toBe(false);
      expect(part(element, "action")!.classList.contains("empty")).toBe(false);
    });
  });

  describe("opening", () => {
    it("closes itself after its duration and announces a timeout", async () => {
      const { element, dismissals, legacyDismissals } = await toastWith({
        duration: 1000,
      });
      element.open = true;
      await element.updateComplete;

      time.tick(999);
      expect(element.open).toBe(true);
      expect(dismissals).toEqual([]);

      time.tick(1);
      await element.updateComplete;
      expect(element.open).toBe(false);
      expect(element.hasAttribute("open")).toBe(false);
      expect(dismissals).toEqual([{ reason: "timeout" }]);
      expect(legacyDismissals).toEqual([{ reason: "timeout" }]);
    });

    it("stays open with a duration of zero", async () => {
      const { element, dismissals } = await toastWith({
        duration: 0,
        open: true,
      });
      time.tick(60_000);
      expect(element.open).toBe(true);
      expect(dismissals).toEqual([]);
    });

    it("starts its countdown again when its duration changes while open", async () => {
      const { element, dismissals } = await toastWith({
        duration: 1000,
        open: true,
      });
      time.tick(800);
      element.duration = 500;
      await element.updateComplete;

      time.tick(499);
      expect(element.open).toBe(true);
      time.tick(1);
      expect(element.open).toBe(false);
      expect(dismissals).toEqual([{ reason: "timeout" }]);
    });

    it("stops its countdown when closed by the page", async () => {
      const { element, dismissals } = await toastWith({
        duration: 1000,
        open: true,
      });
      element.open = false;
      await element.updateComplete;
      time.tick(1000);
      expect(dismissals).toEqual([]);
    });

    it("stops its countdown when disconnected", async () => {
      const { element, dismissals } = await toastWith({
        duration: 1000,
        open: true,
      });
      element.remove();
      time.tick(1000);
      expect(element.open).toBe(true);
      expect(dismissals).toEqual([]);
    });
  });

  describe("the dismiss button", () => {
    it("closes the toast and announces a dismissal by the user, once", async () => {
      const { element, dismissals, legacyDismissals } = await toastWith({
        dismissible: true,
        duration: 1000,
        open: true,
      });
      part(element, "dismiss")!.click();
      await element.updateComplete;
      expect(element.open).toBe(false);
      expect(dismissals).toEqual([{ reason: "user" }]);
      expect(legacyDismissals).toEqual([{ reason: "user" }]);

      time.tick(1000);
      expect(dismissals).toEqual([{ reason: "user" }]);
    });
  });

  describe("dismiss()", () => {
    it("closes an open toast and announces the dismissal with its reason", async () => {
      const { element, dismissals, legacyDismissals } = await toastWith({
        open: true,
      });
      element.dismiss("user");
      await element.updateComplete;
      expect(element.hasAttribute("open")).toBe(false);
      expect(dismissals).toEqual([{ reason: "user" }]);
      expect(legacyDismissals).toEqual([{ reason: "user" }]);
    });

    it("announces nothing for a toast already closed", async () => {
      const { element, dismissals, legacyDismissals } = await toastWith({
        open: true,
      });
      element.dismiss("user");
      element.dismiss("timeout");
      const closed = await toastWith();
      closed.element.dismiss("user");
      expect(dismissals).toEqual([{ reason: "user" }]);
      expect(legacyDismissals).toEqual([{ reason: "user" }]);
      expect(closed.dismissals).toEqual([]);
      expect(closed.legacyDismissals).toEqual([]);
    });
  });

  describe("the action area", () => {
    it("fires `cf-toast-action` when clicked", async () => {
      const { element, actions } = await toastWith({ open: true });
      part(element, "action")!.click();
      expect(actions).toEqual([{}]);
    });

    it("leaves a click on the message alone", async () => {
      const { element, actions } = await toastWith({ open: true });
      part(element, "message")!.click();
      expect(actions).toEqual([]);
    });
  });
});
