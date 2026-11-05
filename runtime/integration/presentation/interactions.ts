import type { ElementHandle } from "@astral/astral";
import type { InteractionObserver } from "../astral-adapter.ts";
import type { Page } from "../page.ts";
import { type ProbeApi, waitForCondition } from "../utils.ts";
import type { PresentationConfig } from "./config.ts";

const controllers = new WeakMap<Page, PresentationInteractions>();

// Settle the view, then report whether `selector` resolves to a fillable input.
// The settle drives the page rather than watching it: asking the worker whether
// it is idle queues runnable pull work that nothing else would start, so a
// control that only the page's own pending work renders arrives on a settling
// check and not on one that reads the DOM alone.
//
// Rendered, not on-screen: the fill scrolls the control into view once this
// resolves, so its viewport position here does not bear on whether it can be
// filled.
const settledCfInputIsFillable = async (
  probe: ProbeApi,
  selector: string,
): Promise<boolean> => {
  const settle = (globalThis as typeof globalThis & {
    commonfabric?: { viewSettled?: () => Promise<void> };
  }).commonfabric?.viewSettled;
  if (!settle) return false;
  await settle();
  const element = probe.collect(selector)[0];
  if (!element) return false;
  const input = element instanceof HTMLInputElement
    ? element
    : element.shadowRoot?.querySelector("input");
  return input instanceof HTMLInputElement && probe.isRendered(input) &&
    !input.disabled && !input.readOnly;
};

export class PresentationInteractions {
  readonly #page: Page;
  readonly #config: Extract<PresentationConfig, { enabled: true }>;
  readonly #participant: { label: string; color: string };

  constructor(
    page: Page,
    config: Extract<PresentationConfig, { enabled: true }>,
    participant: { label: string; color: string },
  ) {
    this.#page = page;
    this.#config = config;
    this.#participant = participant;
  }

  install(): void {
    this.#page.setDefaultTypeDelay(this.#config.typingDelayMs);
    const observer: InteractionObserver = {
      beforeClick: (_element, point) => this.#moveCursor(point.x, point.y),
      afterClick: (_element, point) => this.#pulseCursor(point.x, point.y),
      beforeType: (element) => this.#moveCursorToElement(element),
    };
    this.#page.setInteractionObserver(observer);
    controllers.set(this.#page, this);
  }

  uninstall(): void {
    this.#page.setInteractionObserver(undefined);
    this.#page.setDefaultTypeDelay(0);
    controllers.delete(this.#page);
  }

  async prepareDocument(): Promise<void> {
    await this.#ensureOverlay();
  }

  async showCaption(label: string): Promise<void> {
    await this.#ensureOverlay();
    await this.#page.evaluate((label) => {
      const host = document.getElementById("__cf_demo_presentation_overlay");
      const caption = host?.shadowRoot?.getElementById("caption") as
        | HTMLElement
        | undefined;
      if (!caption) return;
      caption.textContent = label;
      caption.style.opacity = "1";
    }, { args: [label] });
  }

  async clearCaption(): Promise<void> {
    await this.#page.evaluate(() => {
      const host = document.getElementById("__cf_demo_presentation_overlay");
      const caption = host?.shadowRoot?.getElementById("caption") as
        | HTMLElement
        | undefined;
      if (!caption) return;
      caption.style.opacity = "0";
    });
  }

  async typeIntoCfInput(
    selector: string,
    value: string,
  ): Promise<void> {
    // Settle before resolving the handle. A pierce-strategy wait is driven by
    // DOM events and carries no bound of its own, so it would sit forever on a
    // control that only the page's pending work renders.
    await waitForCondition(this.#page, settledCfInputIsFillable, {
      args: [selector],
    });
    const host = await this.#page.waitForSelector(selector, {
      strategy: "pierce",
    });
    await host.evaluate((element: Element) => {
      const input = element instanceof HTMLInputElement
        ? element
        : element.shadowRoot?.querySelector("input");
      input?.scrollIntoView({ block: "center", inline: "center" });
    });
    await this.#moveCursorToElement(host);
    const focused = await host.evaluate((element: Element) => {
      const input = element instanceof HTMLInputElement
        ? element
        : element.shadowRoot?.querySelector("input");
      if (
        !(input instanceof HTMLInputElement) || input.disabled || input.readOnly
      ) {
        return false;
      }
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      if (setter) setter.call(input, "");
      else input.value = "";
      input.dispatchEvent(
        new Event("input", { bubbles: true, composed: true }),
      );
      input.focus();
      return true;
    });
    if (!focused) {
      throw new Error(`"${selector}" did not resolve to a fillable input`);
    }
    await this.#page.keyboard.type(value);
    const outcome = await host.evaluate(
      async (element: Element, value: string) => {
        const input = element instanceof HTMLInputElement
          ? element
          : element.shadowRoot?.querySelector("input");
        if (!(input instanceof HTMLInputElement)) return "replaced";
        input.dispatchEvent(
          new Event("change", { bubbles: true, composed: true }),
        );
        input.blur();
        const root = input.getRootNode();
        const owner = (root instanceof ShadowRoot ? root.host : element) as
          & Element
          & {
            commit?: () => Promise<void>;
            requestUpdate?: () => void | Promise<void>;
          };
        await owner.commit?.();
        await owner.requestUpdate?.();
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
        // A commit that re-renders the host replaces the control. The input this
        // fill typed into is then detached and still holds the typed text, so
        // resolve it again and require the same node before reading the value
        // off it.
        const liveInput = element instanceof HTMLInputElement
          ? element
          : element.shadowRoot?.querySelector("input");
        if (!element.isConnected || liveInput !== input) return "replaced";
        return input.value === value ? "committed" : "value-mismatch";
      },
      { args: [value] },
    );
    if (outcome === "replaced") {
      throw new Error(
        `the control behind "${selector}" was replaced while committing ` +
          `"${value}"`,
      );
    }
    if (outcome !== "committed") {
      throw new Error(
        `presentation typing did not commit "${value}" to "${selector}"`,
      );
    }
  }

  async hold(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async #moveCursorToElement(element: ElementHandle): Promise<void> {
    const box = await element.boundingBox();
    if (!box) return;
    await this.#moveCursor(box.x + box.width / 2, box.y + box.height / 2);
  }

  async #moveCursor(x: number, y: number): Promise<void> {
    await this.#ensureOverlay();
    await this.#page.evaluate(async (x, y, duration) => {
      const rootId = "__cf_demo_presentation_overlay";
      const host = document.getElementById(rootId)!;
      const cursor = host.shadowRoot!.getElementById("cursor") as HTMLElement;
      cursor.style.transitionDuration = `${duration}ms`;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );
      cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      await new Promise((resolve) => setTimeout(resolve, duration));
    }, { args: [x, y, this.#config.cursorTravelMs] });
    await this.hold(this.#config.cursorSettleMs);
  }

  async #ensureOverlay(): Promise<void> {
    await this.#page.evaluate((label, color) => {
      const rootId = "__cf_demo_presentation_overlay";
      if (document.getElementById(rootId)) return;
      const host = document.createElement("div");
      host.id = rootId;
      host.setAttribute("aria-hidden", "true");
      Object.assign(host.style, {
        position: "fixed",
        inset: "0",
        pointerEvents: "none",
        zIndex: "2147483647",
      });
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `<style>
        #cursor {
          position: fixed; left: 0; top: 0; width: 18px; height: 24px;
          transform: translate3d(24px, 24px, 0);
          transition-property: transform;
          transition-timing-function: cubic-bezier(.2,.8,.2,1);
          filter: drop-shadow(0 1px 2px rgba(0,0,0,.7));
        }
        #cursor::before {
          content: ""; display: block; width: 0; height: 0;
          border-top: 20px solid white; border-right: 13px solid transparent;
          transform: rotate(-20deg);
        }
        #cursor.pulse { filter: drop-shadow(0 0 7px #60a5fa); }
        #label {
          position: fixed; top: 16px; left: 16px; padding: 7px 12px;
          border-radius: 999px; color: white; background: var(--accent);
          font: 600 15px/1.2 system-ui, sans-serif;
          box-shadow: 0 2px 8px rgba(0,0,0,.3);
        }
        #caption {
          position: fixed; left: 50%; bottom: 22px; max-width: min(760px, 80vw);
          transform: translateX(-50%); padding: 10px 16px; border-radius: 10px;
          color: white; background: rgba(15,23,42,.88);
          font: 600 17px/1.35 system-ui, sans-serif; text-align: center;
          box-shadow: 0 3px 14px rgba(0,0,0,.35); opacity: 0;
          transition: opacity 180ms ease;
        }
      </style><div id="label"></div><div id="caption"></div><div id="cursor"></div>`;
      const labelElement = shadow.getElementById("label") as HTMLElement;
      labelElement.textContent = label;
      labelElement.style.setProperty("--accent", color);
      document.documentElement.append(host);
    }, { args: [this.#participant.label, this.#participant.color] });
  }

  async #pulseCursor(x: number, y: number): Promise<void> {
    await this.#page.evaluate(async (x, y, duration) => {
      const host = document.getElementById("__cf_demo_presentation_overlay");
      const cursor = host?.shadowRoot?.getElementById("cursor") as
        | HTMLElement
        | undefined;
      if (!cursor) return;
      cursor.style.transitionDuration = "0ms";
      cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      cursor.classList.add("pulse");
      await new Promise((resolve) => setTimeout(resolve, duration));
      cursor.classList.remove("pulse");
    }, { args: [x, y, this.#config.clickPulseMs] });
  }
}

export function installPresentationInteractions(
  page: Page,
  config: Extract<PresentationConfig, { enabled: true }>,
  participant: { label: string; color: string },
): PresentationInteractions {
  const existing = controllers.get(page);
  if (existing) return existing;
  const controller = new PresentationInteractions(page, config, participant);
  controller.install();
  return controller;
}

export function presentationInteractions(
  page: Page,
): PresentationInteractions | undefined {
  return controllers.get(page);
}
