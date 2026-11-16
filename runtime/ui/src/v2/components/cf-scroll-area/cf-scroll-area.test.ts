// First, so that the document it installs is there when Lit loads.
import { mount, settle } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import { CFScrollArea, type ScrollOrientation } from "./index.ts";

/** The extents a browser would lay out, which happy-dom leaves at zero. */
interface Extents {
  scrollHeight?: number;
  clientHeight?: number;
  scrollWidth?: number;
  clientWidth?: number;
}

/** A scroll area mounted with `orientation`, its viewport sized by `extents`. */
async function scrollAreaWith(
  orientation: ScrollOrientation = "vertical",
  extents: Extents = {},
) {
  const element = Object.assign(new CFScrollArea(), { orientation });
  await mount(element);
  const viewport = part(element, "viewport")!;
  for (const [name, value] of Object.entries(extents)) {
    Object.defineProperty(viewport, name, { value, configurable: true });
  }
  return { element, viewport };
}

const part = (element: CFScrollArea, name: string) =>
  element.shadowRoot!.querySelector<HTMLElement>(`[part="${name}"]`);

/** Scrolls `viewport` to `top` and `left`, and lets the frame it asks for run. */
async function scrollTo(viewport: HTMLElement, top: number, left = 0) {
  viewport.scrollTop = top;
  viewport.scrollLeft = left;
  viewport.dispatchEvent(new Event("scroll"));
  await settle();
}

const mouse = (type: string, init: MouseEventInit = {}) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, ...init });

/** A 100px-square viewport over 400px of content in both directions. */
const overflowing: Extents = {
  scrollHeight: 400,
  clientHeight: 100,
  scrollWidth: 400,
  clientWidth: 100,
};

describe("CFScrollArea", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-scroll-area`", () => {
    expect(customElements.get("cf-scroll-area")).toBe(CFScrollArea);
  });

  describe("render()", () => {
    const cases: [ScrollOrientation, boolean, boolean][] = [
      ["vertical", true, false],
      ["horizontal", false, true],
      ["both", true, true],
    ];
    for (const [orientation, vertical, horizontal] of cases) {
      it(`renders the scrollbars a ${orientation} area scrolls along`, async () => {
        const { element } = await scrollAreaWith(orientation);
        expect(part(element, "viewport")).not.toBeNull();
        expect(part(element, "content")!.querySelector("slot")).not.toBeNull();
        expect(part(element, "scrollbar-vertical") !== null).toBe(vertical);
        expect(part(element, "thumb-vertical") !== null).toBe(vertical);
        expect(part(element, "scrollbar-horizontal") !== null).toBe(horizontal);
        expect(part(element, "thumb-horizontal") !== null).toBe(horizontal);
      });
    }

    it("defaults to a vertical area", () => {
      expect(new CFScrollArea().orientation).toBe("vertical");
    });
  });

  describe("a scroll", () => {
    it("sizes and places the vertical thumb in proportion to the content", async () => {
      const { element, viewport } = await scrollAreaWith("vertical", {
        scrollHeight: 200,
        clientHeight: 100,
      });
      await scrollTo(viewport, 50);
      const thumb = part(element, "thumb-vertical")!;
      // Half the content is visible, so the thumb is half the track, and
      // halfway down the 50px it can travel.
      expect(thumb.style.height).toBe("50px");
      expect(thumb.style.transform).toBe("translateY(25px)");
    });

    it("keeps the vertical thumb at least 30px tall", async () => {
      const { element, viewport } = await scrollAreaWith(
        "vertical",
        overflowing,
      );
      await scrollTo(viewport, 150);
      const thumb = part(element, "thumb-vertical")!;
      expect(thumb.style.height).toBe("30px");
      expect(thumb.style.transform).toBe("translateY(35px)");
    });

    it("sizes and places the horizontal thumb in proportion to the content", async () => {
      const { element, viewport } = await scrollAreaWith("horizontal", {
        scrollWidth: 200,
        clientWidth: 100,
      });
      await scrollTo(viewport, 0, 100);
      const thumb = part(element, "thumb-horizontal")!;
      expect(thumb.style.width).toBe("50px");
      expect(thumb.style.transform).toBe("translateX(50px)");
    });

    it("makes a scrollbar interactive only while its content overflows", async () => {
      const { element, viewport } = await scrollAreaWith("both", overflowing);
      await scrollTo(viewport, 0);
      const vertical = part(element, "scrollbar-vertical")!;
      const horizontal = part(element, "scrollbar-horizontal")!;
      expect(vertical.classList.contains("scrollbar-visible")).toBe(true);
      expect(horizontal.classList.contains("scrollbar-visible")).toBe(true);

      Object.defineProperty(viewport, "scrollHeight", { value: 100 });
      Object.defineProperty(viewport, "scrollWidth", { value: 100 });
      await scrollTo(viewport, 0);
      expect(vertical.classList.contains("scrollbar-visible")).toBe(false);
      expect(horizontal.classList.contains("scrollbar-visible")).toBe(false);
    });

    it("moves the thumb on the frame after a scroll", async () => {
      const { element, viewport } = await scrollAreaWith(
        "vertical",
        overflowing,
      );
      viewport.scrollTop = 300;
      viewport.dispatchEvent(new Event("scroll"));
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
      const thumb = part(element, "thumb-vertical")!;
      expect(thumb.style.transform).not.toBe("translateY(0px)");
      await settle();
      expect(thumb.style.transform).toBe("translateY(0px)");
    });
  });

  describe("an update", () => {
    it("sizes a scrollbar that a change of orientation adds", async () => {
      const { element } = await scrollAreaWith("vertical", overflowing);
      element.orientation = "horizontal";
      await element.updateComplete;
      expect(part(element, "scrollbar-vertical")).toBeNull();
      expect(part(element, "thumb-horizontal")!.style.width).toBe("30px");
    });
  });

  describe("hovering", () => {
    it("shows the scrollbars while the pointer is over the viewport", async () => {
      const { element, viewport } = await scrollAreaWith("both");
      viewport.dispatchEvent(mouse("mouseenter"));
      for (const name of ["scrollbar-vertical", "scrollbar-horizontal"]) {
        expect(part(element, name)!.classList.contains("scrollbar-hover"))
          .toBe(true);
      }
    });

    it("hides the scrollbars a second after the pointer leaves", async () => {
      const { element, viewport } = await scrollAreaWith("both");
      using time = new FakeTime();
      viewport.dispatchEvent(mouse("mouseenter"));
      viewport.dispatchEvent(mouse("mouseleave"));
      const vertical = part(element, "scrollbar-vertical")!;
      const horizontal = part(element, "scrollbar-horizontal")!;
      time.tick(999);
      expect(vertical.classList.contains("scrollbar-hover")).toBe(true);
      time.tick(1);
      expect(vertical.classList.contains("scrollbar-hover")).toBe(false);
      expect(horizontal.classList.contains("scrollbar-hover")).toBe(false);
    });

    it("keeps the scrollbars when the pointer returns within the second", async () => {
      const { element, viewport } = await scrollAreaWith();
      using time = new FakeTime();
      viewport.dispatchEvent(mouse("mouseenter"));
      viewport.dispatchEvent(mouse("mouseleave"));
      time.tick(500);
      viewport.dispatchEvent(mouse("mouseenter"));
      time.tick(1000);
      expect(
        part(element, "scrollbar-vertical")!.classList.contains(
          "scrollbar-hover",
        ),
      ).toBe(true);
    });

    it("counts the second from the pointer's last departure", async () => {
      const { element, viewport } = await scrollAreaWith();
      using time = new FakeTime();
      viewport.dispatchEvent(mouse("mouseenter"));
      viewport.dispatchEvent(mouse("mouseleave"));
      time.tick(500);
      viewport.dispatchEvent(mouse("mouseleave"));
      time.tick(999);
      const scrollbar = part(element, "scrollbar-vertical")!;
      expect(scrollbar.classList.contains("scrollbar-hover")).toBe(true);
      time.tick(1);
      expect(scrollbar.classList.contains("scrollbar-hover")).toBe(false);
    });
  });

  for (
    const axis of [
      {
        orientation: "vertical",
        position: "scrollTop",
        pointer: "clientY",
      },
      {
        orientation: "horizontal",
        position: "scrollLeft",
        pointer: "clientX",
      },
    ] as const
  ) {
    const { orientation, position, pointer } = axis;

    describe(`dragging the ${orientation} thumb`, () => {
      /** An overflowing area with its thumb sized, ready to drag. */
      async function draggable() {
        const area = await scrollAreaWith(orientation, overflowing);
        await scrollTo(area.viewport, 0);
        return {
          ...area,
          scrollbar: part(area.element, `scrollbar-${orientation}`)!,
          thumb: part(area.element, `thumb-${orientation}`)!,
        };
      }

      it("scrolls the content in proportion to the pointer's travel", async () => {
        const { viewport, scrollbar, thumb } = await draggable();
        const press = mouse("mousedown", { [pointer]: 10 });
        thumb.dispatchEvent(press);
        expect(press.defaultPrevented).toBe(true);
        expect(scrollbar.classList.contains("scrollbar-dragging")).toBe(true);

        // The 30px thumb travels 70px along the track to cover 300px.
        document.dispatchEvent(mouse("mousemove", { [pointer]: 45 }));
        expect(viewport[position]).toBe(150);
        document.dispatchEvent(mouse("mousemove", { [pointer]: 80 }));
        expect(viewport[position]).toBe(300);
      });

      it("leaves the content where it is once the thumb is no longer rendered", async () => {
        const { element, viewport, thumb } = await draggable();
        thumb.dispatchEvent(mouse("mousedown", { [pointer]: 10 }));
        element.orientation = orientation === "vertical"
          ? "horizontal"
          : "vertical";
        await element.updateComplete;
        document.dispatchEvent(mouse("mousemove", { [pointer]: 45 }));
        document.dispatchEvent(mouse("mouseup"));
        expect(viewport[position]).toBe(0);
      });

      it("keeps the scrollbars while the pointer leaves mid-drag", async () => {
        const { viewport, scrollbar, thumb } = await draggable();
        using time = new FakeTime();
        viewport.dispatchEvent(mouse("mouseenter"));
        thumb.dispatchEvent(mouse("mousedown", { [pointer]: 10 }));
        viewport.dispatchEvent(mouse("mouseleave"));
        time.tick(1000);
        expect(scrollbar.classList.contains("scrollbar-hover")).toBe(true);
      });

      it("ends on release, and hides the scrollbars a second later", async () => {
        const { viewport, scrollbar, thumb } = await draggable();
        using time = new FakeTime();
        viewport.dispatchEvent(mouse("mouseenter"));
        thumb.dispatchEvent(mouse("mousedown", { [pointer]: 10 }));
        document.dispatchEvent(mouse("mouseup"));
        expect(scrollbar.classList.contains("scrollbar-dragging")).toBe(false);

        document.dispatchEvent(mouse("mousemove", { [pointer]: 45 }));
        expect(viewport[position]).toBe(0);
        time.tick(1000);
        expect(scrollbar.classList.contains("scrollbar-hover")).toBe(false);
      });

      it("ends when the area is removed mid-drag", async () => {
        const { element, viewport, scrollbar, thumb } = await draggable();
        thumb.dispatchEvent(mouse("mousedown", { [pointer]: 10 }));
        element.remove();
        expect(scrollbar.classList.contains("scrollbar-dragging")).toBe(false);

        document.dispatchEvent(mouse("mousemove", { [pointer]: 45 }));
        expect(viewport[position]).toBe(0);
      });
    });

    describe(`a click on the ${orientation} track`, () => {
      /** An overflowing area whose track runs 100px from 200px in. */
      async function clickable() {
        const area = await scrollAreaWith(orientation, overflowing);
        await scrollTo(area.viewport, 0);
        const scrollbar = part(area.element, `scrollbar-${orientation}`)!;
        scrollbar.getBoundingClientRect = () =>
          orientation === "vertical"
            ? new DOMRect(0, 200, 8, 100)
            : new DOMRect(200, 0, 100, 8);
        return {
          ...area,
          scrollbar,
          thumb: part(area.element, `thumb-${orientation}`)!,
        };
      }

      it("scrolls so the thumb centers on the click", async () => {
        const { viewport, scrollbar } = await clickable();
        scrollbar.dispatchEvent(mouse("click", { [pointer]: 250 }));
        // 35px of the 70px the thumb's center can travel is half of 300px.
        expect(viewport[position]).toBe(150);
      });

      it("stops at either end of the content", async () => {
        const { viewport, scrollbar } = await clickable();
        scrollbar.dispatchEvent(mouse("click", { [pointer]: 299 }));
        expect(viewport[position]).toBe(300);
        scrollbar.dispatchEvent(mouse("click", { [pointer]: 201 }));
        expect(viewport[position]).toBe(0);
      });

      it("leaves the content where it is for a click on the thumb", async () => {
        const { viewport, thumb } = await clickable();
        thumb.dispatchEvent(mouse("click", { [pointer]: 250 }));
        expect(viewport[position]).toBe(0);
      });
    });
  }

  describe("disconnected", () => {
    it("abandons a pending hide", async () => {
      const { element, viewport } = await scrollAreaWith();
      using time = new FakeTime();
      viewport.dispatchEvent(mouse("mouseenter"));
      viewport.dispatchEvent(mouse("mouseleave"));
      element.remove();
      time.tick(1000);
      expect(
        part(element, "scrollbar-vertical")!.classList.contains(
          "scrollbar-hover",
        ),
      ).toBe(true);
    });

    it("abandons a pending thumb update", async () => {
      const { element, viewport } = await scrollAreaWith(
        "vertical",
        overflowing,
      );
      await scrollTo(viewport, 0);
      viewport.scrollTop = 300;
      viewport.dispatchEvent(new Event("scroll"));
      element.remove();
      await settle();
      expect(part(element, "thumb-vertical")!.style.transform).toBe(
        "translateY(0px)",
      );
    });
  });
});
