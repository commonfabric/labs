// First, so that the document it installs is there when Lit loads.
import { mount, settle } from "../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CFHScroll } from "./index.ts";

/**
 * Mounts a scroller with `properties` whose content is 500 pixels wide in a
 * 100-pixel viewport, and returns it with its scroll container and the
 * `detail` of every `cf-scroll` it dispatches.
 */
async function mountScroller(properties: Partial<CFHScroll> = {}): Promise<{
  scroller: CFHScroll;
  container: HTMLElement;
  scrolls: Record<string, number>[];
}> {
  const scroller = await mount(Object.assign(new CFHScroll(), properties));
  const container = scroller.scrollContainer!;
  // happy-dom lays nothing out, so the container states its extent.
  Object.defineProperty(container, "scrollWidth", { value: 500 });
  Object.defineProperty(container, "clientWidth", { value: 100 });
  const scrolls: Record<string, number>[] = [];
  scroller.addEventListener("cf-scroll", (event) => {
    scrolls.push((event as CustomEvent).detail);
  });
  return { scroller, container, scrolls };
}

/** Scrolls `container` to `left` as a user would, and lets it re-render. */
async function scrollTo(
  scroller: CFHScroll,
  container: HTMLElement,
  left: number,
): Promise<void> {
  container.scrollLeft = left;
  container.dispatchEvent(new Event("scroll"));
  await scroller.updateComplete;
}

/** The classes on the wrapper that marks which edges are in view. */
function edges(scroller: CFHScroll): string[] {
  const wrapper = scroller.shadowRoot!.querySelector(".scroll-wrapper")!;
  return ["at-start", "at-end"].filter((name) =>
    wrapper.classList.contains(name)
  );
}

describe("CFHScroll", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-hscroll`", () => {
    expect(customElements.get("cf-hscroll")).toBe(CFHScroll);
  });

  it("renders its `padding` as a spacing class on the scroll container", async () => {
    const { container } = await mountScroller({ padding: "4" });
    expect(container.classList.contains("scroll-container")).toBe(true);
    expect(container.classList.contains("p-4")).toBe(true);
    expect(container.classList.contains("p-0")).toBe(false);
  });

  it("reflects `showScrollbar` and `fadeEdges` as attributes", async () => {
    const { scroller } = await mountScroller({
      showScrollbar: true,
      fadeEdges: true,
    });
    expect(scroller.hasAttribute("show-scrollbar")).toBe(true);
    expect(scroller.hasAttribute("fade-edges")).toBe(true);
  });

  describe("scrollContainer", () => {
    it("returns `null` before the scroller has rendered", () => {
      expect(new CFHScroll().scrollContainer).toBeNull();
    });

    it("returns the element that scrolls once rendered", async () => {
      const { scroller } = await mountScroller();
      expect(scroller.scrollContainer).toBe(
        scroller.shadowRoot!.querySelector(".scroll-container"),
      );
    });
  });

  describe("when scrolled", () => {
    it("dispatches `cf-scroll` with the scroll position and extent", async () => {
      const { scroller, container, scrolls } = await mountScroller();

      await scrollTo(scroller, container, 120);

      expect(scrolls).toEqual([
        { scrollLeft: 120, scrollWidth: 500, clientWidth: 100 },
      ]);
    });

    it("marks which edges are in view with `fadeEdges` set", async () => {
      const { scroller, container } = await mountScroller({ fadeEdges: true });

      await scrollTo(scroller, container, 0);
      expect(edges(scroller)).toEqual(["at-start"]);

      await scrollTo(scroller, container, 200);
      expect(edges(scroller)).toEqual([]);

      // Within a pixel of the end counts as at the end.
      await scrollTo(scroller, container, 399);
      expect(edges(scroller)).toEqual(["at-end"]);
    });

    it("leaves both edges marked without `fadeEdges`", async () => {
      const { scroller, container } = await mountScroller();

      await scrollTo(scroller, container, 200);

      expect(edges(scroller)).toEqual(["at-start", "at-end"]);
    });

    it("dispatches nothing once removed from the document", async () => {
      const { scroller, container, scrolls } = await mountScroller();

      scroller.remove();
      container.dispatchEvent(new Event("scroll"));

      expect(scrolls).toEqual([]);
    });
  });

  describe("scrollToX()", () => {
    it("scrolls to the position at once when not smooth", async () => {
      const { scroller, container } = await mountScroller();
      scroller.scrollToX(150, false);
      expect(container.scrollLeft).toBe(150);
    });

    it("scrolls to the position smoothly by default", async () => {
      const { scroller, container } = await mountScroller();

      scroller.scrollToX(150);
      expect(container.scrollLeft).toBe(0);

      await settle();
      expect(container.scrollLeft).toBe(150);
    });

    it("does nothing before the scroller has rendered", () => {
      const scroller = new CFHScroll();
      expect(() => scroller.scrollToX(150)).not.toThrow();
    });
  });

  describe("scrollByX()", () => {
    it("scrolls by the amount at once when not smooth", async () => {
      const { scroller, container } = await mountScroller();
      container.scrollLeft = 100;

      scroller.scrollByX(50, false);

      expect(container.scrollLeft).toBe(150);
    });

    it("scrolls by the amount smoothly by default", async () => {
      const { scroller, container } = await mountScroller();
      container.scrollLeft = 100;

      scroller.scrollByX(-40);
      expect(container.scrollLeft).toBe(100);

      await settle();
      expect(container.scrollLeft).toBe(60);
    });

    it("does nothing before the scroller has rendered", () => {
      const scroller = new CFHScroll();
      expect(() => scroller.scrollByX(50)).not.toThrow();
    });
  });
});
