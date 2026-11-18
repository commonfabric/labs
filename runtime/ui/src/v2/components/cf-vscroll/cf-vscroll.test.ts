// First, so that the document it installs is there when Lit loads.
import { mount, settle } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFVScroll } from "./index.ts";

/**
 * A resize observer the test reports through, since happy-dom's never
 * reports. It keeps the elements it is observing.
 */
class RecordingResizeObserver implements ResizeObserver {
  static latest: RecordingResizeObserver | undefined;
  readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    RecordingResizeObserver.latest = this;
  }

  observe(target: Element) {
    this.observed.add(target);
  }

  unobserve(target: Element) {
    this.observed.delete(target);
  }

  disconnect() {
    this.observed.clear();
  }

  /** Reports a change of size, as a browser does after layout. */
  report() {
    this.callback([], this);
  }
}

globalThis.ResizeObserver = RecordingResizeObserver;

/** The extents a browser would lay out, which happy-dom leaves at zero. */
function layOut(
  container: HTMLElement,
  extents: { scrollHeight: number; clientHeight: number },
) {
  for (const [name, value] of Object.entries(extents)) {
    Object.defineProperty(container, name, { value, configurable: true });
  }
}

/**
 * A scroller mounted with `properties` and `children`, its container laid out
 * as 100px tall over 400px of content, with the resize observer it made and
 * every `cf-scroll` it fires.
 */
async function vscrollWith(
  properties: Partial<CFVScroll> = {},
  children: Element[] = [],
) {
  const element = Object.assign(new CFVScroll(), properties);
  const observer = RecordingResizeObserver.latest!;
  element.append(...children);
  await mount(element);
  const scrolls: unknown[] = [];
  element.addEventListener("cf-scroll", (event) => {
    if (event instanceof CustomEvent) scrolls.push(event.detail);
  });
  const container = containerOf(element);
  layOut(container, { scrollHeight: 400, clientHeight: 100 });
  return { element, observer, container, scrolls };
}

const containerOf = (element: CFVScroll) =>
  element.shadowRoot!.querySelector<HTMLElement>('[part="container"]')!;

const wrapperOf = (element: CFVScroll) =>
  element.shadowRoot!.querySelector<HTMLElement>('[part="wrapper"]')!;

/** Puts the container at `scrollTop` the way a reader's scroll does. */
async function scrollTo(element: CFVScroll, scrollTop: number) {
  const container = containerOf(element);
  container.scrollTop = scrollTop;
  container.dispatchEvent(new Event("scroll"));
  await element.updateComplete;
}

const div = () => document.createElement("div");

describe("CFVScroll", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-vscroll`", () => {
    expect(customElements.get("cf-vscroll")).toBe(CFVScroll);
  });

  describe("render()", () => {
    it("fills its host and pads nothing by default", async () => {
      const { element, container } = await vscrollWith();
      expect(container.style.height).toBe("100%");
      expect(container.style.maxHeight).toBe("none");
      expect(container.classList.contains("p-0")).toBe(true);
      expect(container.querySelector("slot")).not.toBeNull();
      expect(element.hasAttribute("show-scrollbar")).toBe(false);
    });

    it("applies the height, maximum height, and padding it is given", async () => {
      const { container } = await vscrollWith({
        height: "400px",
        maxHeight: "50vh",
        padding: "4",
      });
      expect(container.style.height).toBe("400px");
      expect(container.style.maxHeight).toBe("50vh");
      expect(container.classList.contains("p-4")).toBe(true);
    });

    it("reflects its flags as attributes", async () => {
      const { element } = await vscrollWith({
        showScrollbar: true,
        fadeEdges: true,
        snapToBottom: true,
        flex: true,
      });
      for (
        const name of ["show-scrollbar", "fade-edges", "snap-to-bottom", "flex"]
      ) {
        expect(element.hasAttribute(name)).toBe(true);
      }
    });
  });

  describe("a scroll", () => {
    it("fires `cf-scroll` with the container's position and extents", async () => {
      const { element, scrolls } = await vscrollWith();
      await scrollTo(element, 120);
      expect(scrolls).toEqual([
        { scrollTop: 120, scrollHeight: 400, clientHeight: 100 },
      ]);
    });

    it("marks the wrapper by whether the content is at its start or end", async () => {
      const { element } = await vscrollWith();
      const classes = () =>
        [...wrapperOf(element).classList].filter((name) =>
          name.startsWith("at-")
        );
      expect(classes()).toEqual(["at-start", "at-end"]);
      await scrollTo(element, 150);
      expect(classes()).toEqual([]);
      await scrollTo(element, 300);
      expect(classes()).toEqual(["at-end"]);
      await scrollTo(element, 0);
      expect(classes()).toEqual(["at-start"]);
    });
  });

  describe("snap-to-bottom", () => {
    it("jumps to the bottom of content more than a screen away", async () => {
      const { observer, container } = await vscrollWith({ snapToBottom: true });
      observer.report();
      expect(container.scrollTop).toBe(400);
    });

    it("scrolls smoothly to the bottom of content within a screen", async () => {
      const { observer, container } = await vscrollWith({ snapToBottom: true });
      layOut(container, { scrollHeight: 150, clientHeight: 100 });
      observer.report();
      expect(container.scrollTop).toBe(0);
      await settle();
      expect(container.scrollTop).toBe(150);
    });

    it("leaves content that is already at the bottom where it is", async () => {
      const { element, observer, container } = await vscrollWith({
        snapToBottom: true,
      });
      await scrollTo(element, 300);
      observer.report();
      await settle();
      expect(container.scrollTop).toBe(300);
    });

    it("leaves the content where it is without `snap-to-bottom`", async () => {
      const { observer, container } = await vscrollWith();
      observer.report();
      await settle();
      expect(container.scrollTop).toBe(0);
    });

    it("stops following once the reader scrolls up", async () => {
      const { element, observer, container } = await vscrollWith({
        snapToBottom: true,
      });
      await scrollTo(element, 300);
      await scrollTo(element, 200);
      observer.report();
      await settle();
      expect(container.scrollTop).toBe(200);
    });

    it("keeps following while the reader scrolls down short of the bottom", async () => {
      const { element, observer, container } = await vscrollWith({
        snapToBottom: true,
      });
      await scrollTo(element, 100);
      observer.report();
      expect(container.scrollTop).toBe(400);
    });

    it("follows again once the reader returns to the bottom", async () => {
      const { element, observer, container } = await vscrollWith({
        snapToBottom: true,
      });
      await scrollTo(element, 300);
      await scrollTo(element, 100);
      await scrollTo(element, 300);
      layOut(container, { scrollHeight: 600, clientHeight: 100 });
      observer.report();
      expect(container.scrollTop).toBe(600);
    });

    it("follows content added to it", async () => {
      const { element, container } = await vscrollWith({ snapToBottom: true });
      element.append(div());
      await settle();
      expect(container.scrollTop).toBe(400);
    });

    it("follows a chat that announces an update", async () => {
      const { element, container } = await vscrollWith({ snapToBottom: true });
      element.dispatchEvent(new CustomEvent("cf-chat-updated"));
      expect(container.scrollTop).toBe(0);
      await settle();
      expect(container.scrollTop).toBe(400);
    });

    it("opens afresh, following, when it connects again", async () => {
      const { element, observer, container } = await vscrollWith({
        snapToBottom: true,
      });
      await scrollTo(element, 300);
      await scrollTo(element, 200);
      element.remove();
      // A browser drops the scroll position of a disconnected element.
      container.scrollTop = 0;
      document.body.append(element);
      observer.report();
      expect(container.scrollTop).toBe(400);
    });
  });

  describe("observing content", () => {
    it("watches the container and each slotted element", async () => {
      const [first, second] = [div(), div()];
      const { observer, container } = await vscrollWith({}, [first, second]);
      expect([...observer.observed]).toEqual([container, first, second]);
    });

    it("watches the children of a `display: contents` wrapper in its place", async () => {
      const wrapper = div();
      wrapper.style.display = "contents";
      const [first, second] = [div(), div()];
      wrapper.append(first, second);
      const { observer, container } = await vscrollWith({}, [wrapper]);
      expect([...observer.observed]).toEqual([container, first, second]);
    });

    it("starts watching an element added inside a wrapper", async () => {
      const wrapper = div();
      wrapper.style.display = "contents";
      const { observer } = await vscrollWith({}, [wrapper]);
      const added = div();
      wrapper.append(added);
      await settle();
      expect(observer.observed.has(added)).toBe(true);
    });

    it("stops watching once disconnected, and resumes when connected again", async () => {
      const child = div();
      const { element, observer } = await vscrollWith({ snapToBottom: true }, [
        child,
      ]);
      element.remove();
      expect(observer.observed.size).toBe(0);
      document.body.append(element);
      expect(observer.observed.has(child)).toBe(true);
    });

    it("ignores content and chat updates while disconnected", async () => {
      const { element, container } = await vscrollWith({ snapToBottom: true });
      element.remove();
      element.append(div());
      element.dispatchEvent(new CustomEvent("cf-chat-updated"));
      await settle();
      expect(container.scrollTop).toBe(0);
    });
  });

  describe("scrollToY()", () => {
    it("jumps to the position when asked not to animate", async () => {
      const { element, container } = await vscrollWith();
      element.scrollToY(120, false);
      expect(container.scrollTop).toBe(120);
    });

    it("scrolls smoothly to the position by default", async () => {
      const { element, container } = await vscrollWith();
      element.scrollToY(120);
      expect(container.scrollTop).toBe(0);
      await settle();
      expect(container.scrollTop).toBe(120);
    });

    it("does nothing before the element renders", () => {
      expect(() => new CFVScroll().scrollToY(120)).not.toThrow();
    });
  });

  describe("scrollToBottom()", () => {
    it("scrolls to the end of the content", async () => {
      const { element, container } = await vscrollWith();
      element.scrollToBottom(false);
      expect(container.scrollTop).toBe(400);
    });

    it("does nothing before the element renders", () => {
      expect(() => new CFVScroll().scrollToBottom()).not.toThrow();
    });
  });
});
