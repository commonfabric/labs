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

function mutateAndWait(target: Node, mutate: () => void): Promise<void> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      observer.disconnect();
      resolve();
    });
    // The renderer's earlier observer handles this mutation before this
    // observer announces it, including mutations that retain the same boxes.
    observer.observe(target, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    mutate();
  });
}

Deno.test("pending fragments dim bare text without moving it or treating boxed text twice", async () => {
  const { host, container } = await mountRender();
  const peer = await mountRender();
  try {
    const fragment = pending(document.createElement("cf-fragment"));
    host.style.setProperty("--cf-theme-color-text", "red");
    host.style.setProperty("--cf-render-pending-opacity", "0.4");
    const bare = document.createTextNode("retained");
    const box = document.createElement("span");
    box.textContent = "boxed";
    fragment.append(bare, box);
    const other = pending(document.createElement("cf-fragment"));
    other.textContent = "other renderer";
    await mutateAndWait(container, () => container.append(fragment));
    await mutateAndWait(peer.container, () => peer.container.append(other));
    const ranges = () =>
      [...CSS.highlights.get("cf-render-pending-text") ?? []]
        .map((range) => range.toString()).sort();
    expect(ranges()).toEqual(["other renderer", "retained"]);
    expect(bare.parentNode).toBe(fragment);
    expect(
      getComputedStyle(fragment, "::highlight(cf-render-pending-text)").color,
    )
      .toBe("color(srgb 1 0 0 / 0.4)");
    expectTreatment(box, "0.4", "grayscale(0.8)");
    await mutateAndWait(container, () => bare.data = "updated");
    expect(ranges()).toEqual(["other renderer", "updated"]);
    await mutateAndWait(
      container,
      () => fragment.removeAttribute("data-cf-pending"),
    );
    expect(ranges()).toEqual(["other renderer"]);
    peer.host.remove();
    expect(ranges()).toEqual([]);
  } finally {
    host.remove();
    peer.host.remove();
  }
});

Deno.test("nested pending boxes receive one treatment and transfer it on recovery", async () => {
  const { host, container } = await mountRender();
  try {
    const outer = pending(document.createElement("div"));
    const inner = pending(document.createElement("button"));
    const label = document.createElement("span");
    label.textContent = "Retained action";
    inner.append(label);
    outer.append(inner);
    await mutateAndWait(container, () => container.append(outer));
    expectTreatment(outer, "0.55", "grayscale(0.8)");
    expectTreatment(inner, "1", "none");
    expectTreatment(label, "1", "none");
    await mutateAndWait(
      container,
      () => outer.removeAttribute("data-cf-pending"),
    );
    expectTreatment(outer, "1", "none");
    expectTreatment(inner, "0.55", "grayscale(0.8)");
    await mutateAndWait(
      container,
      () => inner.removeAttribute("data-cf-pending"),
    );
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
    await mutateAndWait(container, () => container.append(outer));
    expect(getComputedStyle(outer).display).toBe("contents");
    expectTreatment(outer, "1", "none");
    expectTreatment(transparent, "1", "none");
    expectTreatment(inner, "1", "none");
    expectTreatment(first, "0.55", "grayscale(0.8)");
    expectTreatment(descendant, "1", "none");
    expectTreatment(second, "0.55", "grayscale(0.8)");
    await mutateAndWait(
      container,
      () => outer.removeAttribute("data-cf-pending"),
    );
    expectTreatment(first, "0.55", "grayscale(0.8)");
    expectTreatment(second, "1", "none");
    await mutateAndWait(
      container,
      () => inner.removeAttribute("data-cf-pending"),
    );
    expectTreatment(first, "0.55", "grayscale(0.8)");
    await mutateAndWait(
      container,
      () => first.removeAttribute("data-cf-pending"),
    );
    expectTreatment(descendant, "0.55", "grayscale(0.8)");
    await mutateAndWait(
      container,
      () => descendant.removeAttribute("data-cf-pending"),
    );
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
    await mutateAndWait(container, () => container.append(outer));
    expectTreatment(outer, "1", "none");
    expectTreatment(first, "0.4", "blur(1px)");
    expectTreatment(child, "1", "none");
  } finally {
    host.remove();
  }
});

for (const tag of ["div", "span"]) {
  Deno.test(`class-styled ${tag} contents roots follow box changes and recover`, async () => {
    const { host, container } = await mountRender();
    try {
      const style = document.createElement("style");
      style.textContent =
        ".transparent { display: contents; } .box { display: block; }";
      host.shadowRoot!.append(style);
      const outer = pending(document.createElement(tag));
      outer.className = "transparent";
      const first = document.createElement("button");
      const label = document.createElement("span");
      label.textContent = "Retained control";
      first.append(label);
      outer.append(first);
      const fresh = document.createElement("button");
      await mutateAndWait(container, () => container.append(outer, fresh));
      expect(getComputedStyle(outer).display).toBe("contents");
      expectTreatment(outer, "1", "none");
      expectTreatment(first, "0.55", "grayscale(0.8)");
      expectTreatment(label, "1", "none");
      expectTreatment(fresh, "1", "none");

      await mutateAndWait(container, () => outer.className = "box");
      expectTreatment(outer, "0.55", "grayscale(0.8)");
      expectTreatment(first, "1", "none");
      await mutateAndWait(container, () => outer.className = "transparent");
      expectTreatment(outer, "1", "none");
      expectTreatment(first, "0.55", "grayscale(0.8)");

      await mutateAndWait(
        container,
        () => outer.removeAttribute("data-cf-pending"),
      );
      expectTreatment(first, "1", "none");
      await mutateAndWait(
        container,
        () => outer.setAttribute("data-cf-pending", "true"),
      );
      expectTreatment(first, "0.55", "grayscale(0.8)");

      host.remove();
      expect(first.hasAttribute("data-cf-pending-box")).toBe(false);
      expect(outer.getAttribute("data-cf-pending")).toBe("true");
      document.body.append(host);
      await host.updateComplete;
      expectTreatment(first, "0.55", "grayscale(0.8)");
    } finally {
      host.remove();
    }
  });
}

Deno.test("pending boxes follow sibling stylesheet media changes", async () => {
  const { host, container } = await mountRender();
  try {
    const style = document.createElement("style");
    style.textContent = ".media-root { display: contents; }";
    host.shadowRoot!.append(style);
    const root = pending(document.createElement("div"));
    root.className = "media-root";
    const child = document.createElement("button");
    root.append(child);
    await mutateAndWait(container, () => container.append(root));
    expectTreatment(root, "1", "none");
    expectTreatment(child, "0.55", "grayscale(0.8)");
    await mutateAndWait(host.shadowRoot!, () => style.media = "not all");
    expect(getComputedStyle(root).display).toBe("block");
    expectTreatment(root, "0.55", "grayscale(0.8)");
    expectTreatment(child, "1", "none");
    await mutateAndWait(host.shadowRoot!, () => style.media = "all");
    expectTreatment(root, "1", "none");
    expectTreatment(child, "0.55", "grayscale(0.8)");
  } finally {
    host.remove();
  }
});
