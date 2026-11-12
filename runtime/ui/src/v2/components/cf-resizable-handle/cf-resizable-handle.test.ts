// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFResizablePanelGroup } from "../cf-resizable-panel-group/index.ts";
import { CFResizableHandle } from "./index.ts";

/** A handle inside a group lying in `direction`, with no panels, and the
 * deltas of every `cf-handle-adjust` it fires. */
async function handleIn(direction: "horizontal" | "vertical") {
  const group = new CFResizablePanelGroup();
  group.direction = direction;
  const handle = new CFResizableHandle();
  group.append(handle);
  await mount(group);
  await handle.updateComplete;
  return { handle, deltas: adjustments(handle) };
}

/** The deltas of every `cf-handle-adjust` `handle` fires from now on. */
function adjustments(handle: CFResizableHandle): number[] {
  const deltas: number[] = [];
  handle.addEventListener("cf-handle-adjust", (event) => {
    if (event instanceof CustomEvent) deltas.push(event.detail.delta);
  });
  return deltas;
}

/** Presses `key` on `handle`, and returns whether the press was taken and
 * went no further. */
function press(handle: CFResizableHandle, key: string): boolean {
  let escaped = false;
  const listener = () => escaped = true;
  document.addEventListener("keydown", listener);
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  handle.dispatchEvent(event);
  document.removeEventListener("keydown", listener);
  expect(escaped).toBe(!event.defaultPrevented);
  return event.defaultPrevented;
}

describe("CFResizableHandle", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-resizable-handle`", () => {
    expect(customElements.get("cf-resizable-handle")).toBe(CFResizableHandle);
  });

  describe("connected", () => {
    it("exposes itself as a focusable separator at the midpoint", async () => {
      const handle = await mount(new CFResizableHandle());
      expect(handle.getAttribute("role")).toBe("separator");
      expect(handle.getAttribute("aria-valuenow")).toBe("50");
      expect(handle.getAttribute("aria-valuemin")).toBe("0");
      expect(handle.getAttribute("aria-valuemax")).toBe("100");
      expect(handle.tabIndex).toBe(0);
    });
  });

  describe("render()", () => {
    it("draws a grip by default", async () => {
      const handle = await mount(new CFResizableHandle());
      const grip = handle.shadowRoot!.querySelector(".handle .grip-icon");
      expect(grip?.getAttribute("part")).toBe("grip");
    });

    it("draws no grip without `withHandle`", async () => {
      const handle = new CFResizableHandle();
      handle.withHandle = false;
      await mount(handle);
      expect(handle.shadowRoot!.querySelector(".handle")).not.toBe(null);
      expect(handle.shadowRoot!.querySelector(".grip-icon")).toBe(null);
    });
  });

  describe("keys", () => {
    it("fire `cf-handle-adjust` by one with Left and Right in a horizontal group, and not with Up and Down", async () => {
      const { handle, deltas } = await handleIn("horizontal");
      expect(press(handle, "ArrowLeft")).toBe(true);
      expect(press(handle, "ArrowRight")).toBe(true);
      expect(press(handle, "ArrowUp")).toBe(false);
      expect(press(handle, "ArrowDown")).toBe(false);
      expect(deltas).toEqual([-1, 1]);
    });

    it("fire `cf-handle-adjust` by one with Up and Down in a vertical group, and not with Left and Right", async () => {
      const { handle, deltas } = await handleIn("vertical");
      expect(press(handle, "ArrowUp")).toBe(true);
      expect(press(handle, "ArrowDown")).toBe(true);
      expect(press(handle, "ArrowLeft")).toBe(false);
      expect(press(handle, "ArrowRight")).toBe(false);
      expect(deltas).toEqual([-1, 1]);
    });

    it("fire `cf-handle-adjust` toward either end with Home and End", async () => {
      const { handle, deltas } = await handleIn("vertical");
      expect(press(handle, "Home")).toBe(true);
      expect(press(handle, "End")).toBe(true);
      expect(deltas).toEqual([-100, 100]);
    });

    it("leave other keys alone", async () => {
      const { handle, deltas } = await handleIn("horizontal");
      expect(press(handle, "a")).toBe(false);
      expect(deltas).toEqual([]);
    });

    it("do nothing outside a group", async () => {
      const handle = await mount(new CFResizableHandle());
      const deltas = adjustments(handle);
      expect(press(handle, "ArrowRight")).toBe(false);
      expect(deltas).toEqual([]);
    });

    it("do nothing once the handle is disconnected", async () => {
      const { handle, deltas } = await handleIn("horizontal");
      const group = handle.parentElement!;
      group.remove();
      handle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
      expect(deltas).toEqual([]);
    });
  });
});
