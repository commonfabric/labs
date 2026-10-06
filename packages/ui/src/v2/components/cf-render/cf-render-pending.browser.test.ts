/**
 * Pending presentation applies once per visible branch in the real shadow DOM.
 * The browser harness registers Deno tests without the BDD step API.
 */

import { expect } from "@std/expect";
import "../cf-fragment/index.ts";
import "./index.ts";
import type { CFRender } from "./index.ts";

async function mountRender() {
  const host = document.createElement("cf-render") as CFRender;
  document.body.append(host);
  await host.updateComplete;
  const container = host.shadowRoot?.querySelector(".render-container");
  if (!(container instanceof HTMLElement)) {
    host.remove();
    throw new Error("Expected the real render container");
  }
  return { host, container };
}

function pending(element: HTMLElement): HTMLElement {
  element.setAttribute("data-cf-pending", "true");
  return element;
}

function expectTreatment(
  element: HTMLElement,
  opacity: string,
  filter: string,
) {
  const style = getComputedStyle(element);
  expect(style.opacity).toBe(opacity);
  expect(style.filter).toBe(filter);
}

Deno.test("nested pending boxes receive one treatment and transfer it on recovery", async () => {
  const { host, container } = await mountRender();
  try {
    const outer = pending(document.createElement("div"));
    const inner = pending(document.createElement("button"));
    const label = document.createElement("span");
    label.textContent = "Retained action";
    inner.append(label);
    outer.append(inner);
    container.append(outer);
    expectTreatment(outer, "0.55", "grayscale(0.8)");
    expectTreatment(inner, "1", "none");
    expectTreatment(label, "1", "none");
    outer.removeAttribute("data-cf-pending");
    expectTreatment(outer, "1", "none");
    expectTreatment(inner, "0.55", "grayscale(0.8)");
    inner.removeAttribute("data-cf-pending");
    expectTreatment(inner, "1", "none");
  } finally {
    host.remove();
  }
});

Deno.test("nested transparent pending roots treat the first box on every branch once", async () => {
  const { host, container } = await mountRender();
  try {
    const outer = pending(document.createElement("cf-fragment"));
    const transparent = document.createElement("span");
    transparent.style.display = "contents";
    const inner = pending(document.createElement("cf-fragment"));
    const first = pending(document.createElement("div"));
    const descendant = pending(document.createElement("button"));
    first.append(descendant);
    inner.append(first);
    transparent.append(inner);
    const second = document.createElement("div");
    outer.append(transparent, second);
    container.append(outer);
    expect(getComputedStyle(outer).display).toBe("contents");
    expectTreatment(outer, "1", "none");
    expectTreatment(transparent, "1", "none");
    expectTreatment(inner, "1", "none");
    expectTreatment(first, "0.55", "grayscale(0.8)");
    expectTreatment(descendant, "1", "none");
    expectTreatment(second, "0.55", "grayscale(0.8)");
    outer.removeAttribute("data-cf-pending");
    expectTreatment(first, "0.55", "grayscale(0.8)");
    expectTreatment(second, "1", "none");
    inner.removeAttribute("data-cf-pending");
    expectTreatment(first, "0.55", "grayscale(0.8)");
    first.removeAttribute("data-cf-pending");
    expectTreatment(descendant, "0.55", "grayscale(0.8)");
    descendant.removeAttribute("data-cf-pending");
    expectTreatment(descendant, "1", "none");
  } finally {
    host.remove();
  }
});

Deno.test("pending first-box treatment uses ambient theme overrides without compounding", async () => {
  const { host, container } = await mountRender();
  try {
    host.style.setProperty("--cf-render-pending-opacity", "0.4");
    host.style.setProperty("--cf-render-pending-filter", "blur(1px)");
    const outer = pending(document.createElement("span"));
    outer.style.display = "contents";
    const first = pending(document.createElement("div"));
    const child = pending(document.createElement("div"));
    first.append(child);
    outer.append(first);
    container.append(outer);
    expectTreatment(outer, "1", "none");
    expectTreatment(first, "0.4", "blur(1px)");
    expectTreatment(child, "1", "none");
  } finally {
    host.remove();
  }
});
