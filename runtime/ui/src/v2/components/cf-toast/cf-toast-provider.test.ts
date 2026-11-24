// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFToast, CFToastProvider } from "./index.ts";

/** A toast, open or not, as a page would add it to the provider. */
function toast(open: boolean): CFToast {
  const element = new CFToast();
  element.duration = 0;
  element.open = open;
  return element;
}

/** Resolves once the provider's mutation observer has had its say. */
const observed = () => new Promise<void>((resolve) => queueMicrotask(resolve));

/** Which of `toasts` carry `open`. */
const openness = (toasts: CFToast[]) =>
  toasts.map((element) => element.hasAttribute("open"));

/** Mounts a provider holding `toasts` and records the dismissals it causes. */
async function providerWith(
  toasts: CFToast[],
  properties: Partial<CFToastProvider> = {},
) {
  const provider = Object.assign(new CFToastProvider(), properties);
  provider.append(...toasts);
  const dismissed: CFToast[] = [];
  provider.addEventListener("cf-toast-dismiss", (event) => {
    if (event instanceof CustomEvent && event.target instanceof CFToast) {
      expect(event.detail).toEqual({ reason: "timeout" });
      dismissed.push(event.target);
    }
  });
  await mount(provider);
  await Promise.all(toasts.map((element) => element.updateComplete));
  return { provider, dismissed };
}

describe("CFToastProvider", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-toast-provider`", () => {
    expect(customElements.get("cf-toast-provider")).toBe(CFToastProvider);
  });

  it("reflects its position, at the bottom unless told otherwise", async () => {
    const { provider } = await providerWith([]);
    expect(provider.getAttribute("position")).toBe("bottom");
    provider.position = "top-left";
    await provider.updateComplete;
    expect(provider.getAttribute("position")).toBe("top-left");
  });

  it("slots its toasts into its container", async () => {
    const { provider } = await providerWith([toast(true)]);
    const container = provider.shadowRoot!.querySelector('[part="container"]');
    expect(container?.querySelector("slot")).not.toBeNull();
  });

  describe("on connecting", () => {
    it("closes the oldest open toasts beyond its maximum", async () => {
      const toasts = [toast(true), toast(false), toast(true), toast(true)];
      const { dismissed } = await providerWith(toasts, { max: 2 });
      expect(openness(toasts)).toEqual([false, false, true, true]);
      expect(dismissed).toHaveLength(1);
      expect(dismissed[0]).toBe(toasts[0]);
    });

    it("leaves open toasts within its maximum alone", async () => {
      const toasts = [toast(true), toast(true), toast(true)];
      const { dismissed } = await providerWith(toasts);
      expect(openness(toasts)).toEqual([true, true, true]);
      expect(dismissed).toEqual([]);
    });
  });

  describe("while connected", () => {
    it("closes the oldest open toast when another is added beyond its maximum", async () => {
      const toasts = [toast(true), toast(true)];
      const { provider, dismissed } = await providerWith(toasts, { max: 2 });
      const added = toast(true);
      provider.append(added);
      await observed();
      expect(openness([...toasts, added])).toEqual([false, true, true]);
      expect(dismissed).toHaveLength(1);
      expect(dismissed[0]).toBe(toasts[0]);
    });

    it("announces a closed toast as a dismissed toast does, with `cf-dismiss` and `cf-toast-dismiss`", async () => {
      const toasts = [toast(true)];
      const { provider } = await providerWith(toasts, { max: 1 });
      const announced: [string, unknown][] = [];
      for (const type of ["cf-toast-dismiss", "cf-dismiss"]) {
        toasts[0].addEventListener(type, (event) => {
          if (event instanceof CustomEvent) {
            announced.push([event.type, event.detail]);
          }
        });
      }
      provider.append(toast(true));
      await observed();
      expect(announced).toEqual([
        ["cf-toast-dismiss", { reason: "timeout" }],
        ["cf-dismiss", { reason: "timeout" }],
      ]);
    });

    it("closes the oldest open toast when another opens beyond its maximum", async () => {
      const toasts = [toast(true), toast(false)];
      const { dismissed } = await providerWith(toasts, { max: 1 });
      toasts[1].setAttribute("open", "");
      await observed();
      expect(openness(toasts)).toEqual([false, true]);
      expect(dismissed).toHaveLength(1);
      expect(dismissed[0]).toBe(toasts[0]);
    });

    it("ignores changes to other attributes", async () => {
      const toasts = [toast(true), toast(true)];
      const { provider, dismissed } = await providerWith(toasts, { max: 2 });
      provider.max = 1;
      toasts[1].setAttribute("status", "error");
      await observed();
      expect(openness(toasts)).toEqual([true, true]);
      expect(dismissed).toEqual([]);
    });
  });

  describe("disconnected", () => {
    it("stops watching its toasts", async () => {
      const toasts = [toast(true)];
      const { provider, dismissed } = await providerWith(toasts, { max: 1 });
      provider.remove();
      provider.append(toast(true));
      await observed();
      expect(openness(toasts)).toEqual([true]);
      expect(dismissed).toEqual([]);
    });
  });
});
