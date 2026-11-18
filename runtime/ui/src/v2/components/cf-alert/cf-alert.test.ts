// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFAlert } from "./index.ts";

/** An alert with `properties` set, mounted in the document. */
function alert(
  properties: Partial<Pick<CFAlert, "status" | "dismissible" | "dismissable">> =
    {},
): Promise<CFAlert> {
  return mount(Object.assign(new CFAlert(), properties));
}

/** The element carrying `element`'s alert role. */
function body(element: CFAlert): HTMLElement {
  const found = element.shadowRoot!.querySelector<HTMLElement>(
    "[role=alert]",
  );
  if (!found) throw new Error("cf-alert rendered no alert");
  return found;
}

/** The dismiss button `element` renders, if any. */
function dismissButton(element: CFAlert): HTMLButtonElement | null {
  return element.shadowRoot!.querySelector("button.dismiss-button");
}

/** Each event of the `types` `element` emits while `act()` runs. */
function emitted(
  element: CFAlert,
  types: readonly string[],
  act: () => void,
): { type: string; detail: unknown }[] {
  const seen: { type: string; detail: unknown }[] = [];
  const listener = (event: Event) =>
    seen.push({ type: event.type, detail: (event as CustomEvent).detail });
  for (const type of types) element.addEventListener(type, listener);
  try {
    act();
  } finally {
    for (const type of types) element.removeEventListener(type, listener);
  }
  return seen;
}

describe("CFAlert", () => {
  afterEach(() => document.body.replaceChildren());

  it("draws an info alert by default", async () => {
    expect([...body(await alert()).classList]).toEqual([
      "alert",
      "status-info",
    ]);
  });

  it("draws the status it is given", async () => {
    const element = await alert({ status: "warning" });
    expect([...body(element).classList]).toEqual([
      "alert",
      "status-warning",
    ]);
  });

  it("renders no dismiss button unless it is dismissible", async () => {
    expect(dismissButton(await alert())).toBeNull();
  });

  for (const spelling of ["dismissible", "dismissable"] as const) {
    it(`renders a dismiss button when ${spelling} is set`, async () => {
      const element = await alert({ [spelling]: true });

      expect(dismissButton(element)?.getAttribute("aria-label")).toBe(
        "Dismiss alert",
      );
      expect(element.dismissible).toBe(true);
      expect(element.dismissable).toBe(true);
      expect(element.hasAttribute("dismissible")).toBe(true);
    });

    it(`renders a dismiss button while it carries the ${spelling} attribute`, async () => {
      const element = new CFAlert();
      element.setAttribute(spelling, "");
      await mount(element);
      expect(dismissButton(element)).not.toBeNull();

      element.removeAttribute(spelling);
      await element.updateComplete;
      expect(dismissButton(element)).toBeNull();
      expect(element.dismissible).toBe(false);
    });
  }

  it("emits cf-dismiss and cf-alert-dismiss when its dismiss button is clicked", async () => {
    const element = await alert({ status: "error", dismissible: true });
    let clicksOutside = 0;
    document.body.addEventListener("click", () => clicksOutside++);

    const detail = { status: "error", reason: "user" };
    expect(
      emitted(
        element,
        ["cf-dismiss", "cf-alert-dismiss"],
        () => dismissButton(element)!.click(),
      ),
    ).toEqual([
      { type: "cf-dismiss", detail },
      { type: "cf-alert-dismiss", detail },
    ]);
    expect(clicksOutside).toBe(0);
  });
});
