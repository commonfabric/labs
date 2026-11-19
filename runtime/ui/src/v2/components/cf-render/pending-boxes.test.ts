import "../../test-utils/dom.ts";
import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { watchPendingBoxes } from "./pending-boxes.ts";

function mutateAndWait(target: Node, mutate: () => void): Promise<void> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      observer.disconnect();
      resolve();
    });
    observer.observe(target, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    mutate();
  });
}

describe("pending paint boxes", () => {
  const disposers: (() => void)[] = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    document.body.replaceChildren();
  });

  it("refuses a document without a rendering window before annotating it", () => {
    const detached = document.implementation.createHTMLDocument("Detached");
    const container = detached.createElement("div");
    container.setAttribute("data-cf-pending", "true");
    expect(() => watchPendingBoxes(container)).toThrow(
      "Pending presentation requires a document window",
    );
    expect(container.hasAttribute("data-cf-pending-box")).toBe(false);
    expect(container.getAttribute("data-cf-pending")).toBe("true");
  });

  it("walks transparent wrappers, stops at first boxes, and transfers treatment on recovery", async () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<div data-cf-pending="true" style="display:contents" inert aria-busy="true"><span style="display:contents"><button data-cf-pending="true"><b>Retained</b></button></span><i>Second branch</i></div><p>Fresh</p>';
    document.body.append(container);
    const watch = watchPendingBoxes(container);
    disposers.push(watch.dispose);
    const root = container.firstElementChild!;
    const button = container.querySelector("button")!;
    const label = container.querySelector("b")!;
    const second = container.querySelector("i")!;
    expect(root.hasAttribute("data-cf-pending-box")).toBe(false);
    expect(button.hasAttribute("data-cf-pending-box")).toBe(true);
    expect(second.hasAttribute("data-cf-pending-box")).toBe(true);
    expect(label.hasAttribute("data-cf-pending-box")).toBe(false);
    expect(container.querySelector("p")!.hasAttribute("data-cf-pending-box"))
      .toBe(false);

    await mutateAndWait(
      container,
      () => root.removeAttribute("data-cf-pending"),
    );
    expect(button.hasAttribute("data-cf-pending-box")).toBe(true);
    expect(second.hasAttribute("data-cf-pending-box")).toBe(false);
    expect(root.hasAttribute("inert")).toBe(true);
    expect(root.getAttribute("aria-busy")).toBe("true");
    await mutateAndWait(
      container,
      () => button.removeAttribute("data-cf-pending"),
    );
    expect(container.querySelector("[data-cf-pending-box]")).toBeNull();
  });

  it("tracks hidden roots, newly pending branches, and boxes on the container itself", async () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<section style="display:none" data-cf-pending="true"><button>Hidden</button></section>';
    document.body.append(container);
    const watch = watchPendingBoxes(container);
    disposers.push(watch.dispose);
    const root = container.firstElementChild as HTMLElement;
    const button = container.querySelector("button")!;
    expect(container.querySelector("[data-cf-pending-box]")).toBeNull();
    await mutateAndWait(container, () => root.style.display = "contents");
    expect(button.hasAttribute("data-cf-pending-box")).toBe(true);
    await mutateAndWait(
      container,
      () => container.setAttribute("data-cf-pending", "true"),
    );
    expect(container.hasAttribute("data-cf-pending-box")).toBe(true);
    expect(button.hasAttribute("data-cf-pending-box")).toBe(false);
    await mutateAndWait(container, () => {
      container.removeAttribute("data-cf-pending");
      root.remove();
    });
    const fresh = document.createElement("button");
    await mutateAndWait(container, () => container.append(fresh));
    expect(fresh.hasAttribute("data-cf-pending-box")).toBe(false);
    await mutateAndWait(
      container,
      () => fresh.setAttribute("data-cf-pending", "true"),
    );
    expect(fresh.hasAttribute("data-cf-pending-box")).toBe(true);
    watch.dispose();
    watch.dispose();
    watch.refresh();
    expect(fresh.hasAttribute("data-cf-pending-box")).toBe(false);
    expect(fresh.getAttribute("data-cf-pending")).toBe("true");
  });

  it("refreshes class-based boxes after stylesheet events and disconnects its resources", async () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ".pending-root { display: block; }";
    const container = document.createElement("div");
    container.innerHTML =
      '<div class="pending-root" data-cf-pending="true"><button>Retained</button></div>';
    shadow.append(style, container);
    document.body.append(host);
    const watch = watchPendingBoxes(container);
    disposers.push(watch.dispose);
    const root = container.firstElementChild!;
    const button = container.querySelector("button")!;
    expect(root.hasAttribute("data-cf-pending-box")).toBe(true);
    await mutateAndWait(
      shadow,
      () => style.textContent = ".pending-root { display: contents; }",
    );
    expect(root.hasAttribute("data-cf-pending-box")).toBe(false);
    expect(button.hasAttribute("data-cf-pending-box")).toBe(true);
    await mutateAndWait(container, () => {
      style.textContent = ".pending-root { display: block; }";
      globalThis.dispatchEvent(new Event("resize"));
      expect(root.hasAttribute("data-cf-pending-box")).toBe(true);
    });
    expect(root.hasAttribute("data-cf-pending-box")).toBe(true);
    await mutateAndWait(container, () => {
      style.textContent = ".pending-root { display: contents; }";
      style.dispatchEvent(new Event("load"));
      expect(button.hasAttribute("data-cf-pending-box")).toBe(true);
    });
    expect(button.hasAttribute("data-cf-pending-box")).toBe(true);
    watch.dispose();
    expect(button.hasAttribute("data-cf-pending-box")).toBe(false);
    await mutateAndWait(
      shadow,
      () => style.textContent = ".pending-root { display: block; }",
    );
    globalThis.dispatchEvent(new Event("resize"));
    watch.refresh();
    expect(root.hasAttribute("data-cf-pending-box")).toBe(false);
    expect(button.hasAttribute("data-cf-pending-box")).toBe(false);
  });
});
