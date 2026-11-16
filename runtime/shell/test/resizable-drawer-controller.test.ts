import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ReactiveController, ReactiveControllerHost } from "lit";

import {
  type ResizableDrawerConfig,
  ResizableDrawerController,
} from "../src/lib/resizable-drawer-controller.ts";
import { installGlobals } from "./browser-globals.ts";

/** What a host renders of its drawer. */
type Rendered = { height: number; resizing: boolean };

/**
 * A host which renders, each time its controller asks it to update, what the
 * controller then says.
 */
class StandInHost implements ReactiveControllerHost {
  /** The controllers added to the host. */
  readonly controllers: ReactiveController[] = [];

  /** What the host last rendered, or `undefined` before it first updates. */
  rendered: Rendered | undefined;

  /** @inheritDoc */
  readonly updateComplete = Promise.resolve(true);

  /** @inheritDoc */
  addController(controller: ReactiveController): void {
    this.controllers.push(controller);
  }

  /** @inheritDoc */
  removeController(): void {}

  /** @inheritDoc */
  requestUpdate(): void {
    const [controller] = this.controllers;
    if (controller instanceof ResizableDrawerController) {
      this.rendered = {
        height: controller.drawerHeight,
        resizing: controller.isResizing,
      };
    }
  }
}

/** The page height, of which a drawer may take `maxHeightFactor`. */
const INNER_HEIGHT = 1000;

const CONFIG: ResizableDrawerConfig = {
  initialHeight: 300,
  minHeight: 150,
  maxHeightFactor: 0.8,
  storageKey: "testDrawerHeight",
};

/** A mouse event at `clientY`. */
function mouse(type: string, clientY: number) {
  return Object.assign(new Event(type, { cancelable: true }), { clientY });
}

/** A touch event with one finger at each of `clientYs`. */
function touch(type: string, ...clientYs: number[]) {
  return Object.assign(new Event(type, { cancelable: true }), {
    touches: clientYs.map((clientY) => ({ clientY })),
  });
}

describe("ResizableDrawerController", () => {
  let restore: () => void;
  let stored: Map<string, string>;
  let overlays: { style: { cssText: string } }[];

  // The controller listens on `document`, covers the page with an overlay in
  // `document.body` while a drag lasts, and keeps its height in
  // `localStorage`, so each of those is a stand-in the test can read back.
  beforeEach(() => {
    stored = new Map();
    overlays = [];
    restore = installGlobals({
      innerHeight: INNER_HEIGHT,
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
      document: Object.assign(new EventTarget(), {
        createElement: () => ({ style: { cssText: "" } }),
        body: {
          appendChild(overlay: { style: { cssText: string } }) {
            overlays.push(overlay);
          },
          removeChild(overlay: { style: { cssText: string } }) {
            overlays.splice(overlays.indexOf(overlay), 1);
          },
        },
      }),
    });
  });

  afterEach(() => restore());

  describe("constructor()", () => {
    it("adds itself to its host", () => {
      const host = new StandInHost();
      const controller = new ResizableDrawerController(host);

      expect(host.controllers).toEqual([controller]);
    });

    it("starts at the configured height", () => {
      const controller = new ResizableDrawerController(
        new StandInHost(),
        CONFIG,
      );

      expect(controller.drawerHeight).toBe(300);
      expect(controller.isResizing).toBe(false);
    });

    it("starts at 240 pixels without a configured height", () => {
      const controller = new ResizableDrawerController(new StandInHost());

      expect(controller.drawerHeight).toBe(240);
    });
  });

  describe("instance members", () => {
    describe("hostConnected()", () => {
      it("restores the height a previous drag saved", () => {
        stored.set("testDrawerHeight", "420");
        const controller = new ResizableDrawerController(
          new StandInHost(),
          CONFIG,
        );

        controller.hostConnected();

        expect(controller.drawerHeight).toBe(420);
      });

      it("keeps the configured height when the saved one is under the minimum", () => {
        stored.set("testDrawerHeight", "100");
        const controller = new ResizableDrawerController(
          new StandInHost(),
          CONFIG,
        );

        controller.hostConnected();

        expect(controller.drawerHeight).toBe(300);
      });

      it("keeps the configured height when the saved one is not a number", () => {
        stored.set("testDrawerHeight", "tall");
        const controller = new ResizableDrawerController(
          new StandInHost(),
          CONFIG,
        );

        controller.hostConnected();

        expect(controller.drawerHeight).toBe(300);
      });

      it("reads the height saved under its own key and no other", () => {
        stored.set("drawerHeight", "420");
        const controller = new ResizableDrawerController(
          new StandInHost(),
          CONFIG,
        );

        controller.hostConnected();

        expect(controller.drawerHeight).toBe(300);
      });
    });

    describe("handleResizeStart()", () => {
      it("starts a drag covered by an overlay, and asks the host to update", () => {
        const host = new StandInHost();
        const controller = new ResizableDrawerController(host, CONFIG);
        const down = mouse("mousedown", 500);

        controller.handleResizeStart(down);

        expect(down.defaultPrevented).toBe(true);
        expect(controller.isResizing).toBe(true);
        expect(overlays.length).toBe(1);
        expect(overlays[0].style.cssText).toContain("cursor: ns-resize");
        expect(host.rendered).toEqual({ height: 300, resizing: true });
      });

      it("grows the drawer by how far the mouse moves up, and saves it", () => {
        const host = new StandInHost();
        const controller = new ResizableDrawerController(host, CONFIG);
        controller.handleResizeStart(mouse("mousedown", 500));

        document.dispatchEvent(mouse("mousemove", 400));

        expect(controller.drawerHeight).toBe(400);
        expect(stored.get("testDrawerHeight")).toBe("400");
        expect(host.rendered).toEqual({ height: 400, resizing: true });

        document.dispatchEvent(mouse("mousemove", 550));

        expect(controller.drawerHeight).toBe(250);
        expect(stored.get("testDrawerHeight")).toBe("250");
        expect(host.rendered).toEqual({ height: 250, resizing: true });
      });

      it("grows the drawer by how far the mouse moves down when it opens downward", () => {
        const controller = new ResizableDrawerController(new StandInHost(), {
          ...CONFIG,
          resizeDirection: "down",
        });
        controller.handleResizeStart(mouse("mousedown", 500));

        document.dispatchEvent(mouse("mousemove", 600));

        expect(controller.drawerHeight).toBe(400);
      });

      it("holds the height between the minimum and the page's share", () => {
        const controller = new ResizableDrawerController(
          new StandInHost(),
          CONFIG,
        );
        controller.handleResizeStart(mouse("mousedown", 500));

        document.dispatchEvent(mouse("mousemove", -1000));
        expect(controller.drawerHeight).toBe(INNER_HEIGHT * 0.8);

        document.dispatchEvent(mouse("mousemove", 2000));
        expect(controller.drawerHeight).toBe(150);
      });

      it("ends the drag on release, after which moves change nothing", () => {
        const host = new StandInHost();
        const controller = new ResizableDrawerController(host, CONFIG);
        controller.handleResizeStart(mouse("mousedown", 500));
        document.dispatchEvent(mouse("mousemove", 400));

        document.dispatchEvent(mouse("mouseup", 400));
        document.dispatchEvent(mouse("mousemove", 300));

        expect(controller.isResizing).toBe(false);
        expect(controller.drawerHeight).toBe(400);
        expect(overlays).toEqual([]);
        expect(host.rendered).toEqual({ height: 400, resizing: false });
      });

      it("ends the drag a second press interrupts, keeping one overlay", () => {
        const controller = new ResizableDrawerController(
          new StandInHost(),
          CONFIG,
        );
        controller.handleResizeStart(mouse("mousedown", 500));
        document.dispatchEvent(mouse("mousemove", 400));

        controller.handleResizeStart(mouse("mousedown", 600));
        document.dispatchEvent(mouse("mousemove", 550));

        expect(controller.drawerHeight).toBe(450);
        expect(overlays.length).toBe(1);

        document.dispatchEvent(mouse("mouseup", 550));

        expect(controller.isResizing).toBe(false);
        expect(overlays).toEqual([]);
      });
    });

    describe("handleTouchResizeStart()", () => {
      it("grows the drawer by how far one finger moves up, until it lifts", () => {
        const controller = new ResizableDrawerController(
          new StandInHost(),
          CONFIG,
        );
        const start = touch("touchstart", 500);

        controller.handleTouchResizeStart(start);
        document.dispatchEvent(touch("touchmove", 450));

        expect(start.defaultPrevented).toBe(true);
        expect(controller.drawerHeight).toBe(350);
        expect(overlays.length).toBe(1);

        document.dispatchEvent(touch("touchend"));
        document.dispatchEvent(touch("touchmove", 300));

        expect(controller.isResizing).toBe(false);
        expect(controller.drawerHeight).toBe(350);
        expect(overlays).toEqual([]);
      });

      it("ends the drag when the browser cancels the touch", () => {
        const host = new StandInHost();
        const controller = new ResizableDrawerController(host, CONFIG);
        controller.handleTouchResizeStart(touch("touchstart", 500));
        document.dispatchEvent(touch("touchmove", 450));

        document.dispatchEvent(touch("touchcancel"));
        document.dispatchEvent(touch("touchmove", 300));

        expect(controller.isResizing).toBe(false);
        expect(controller.drawerHeight).toBe(350);
        expect(overlays).toEqual([]);
        expect(host.rendered).toEqual({ height: 350, resizing: false });
      });

      it("ends a touch drag a second touch interrupts, keeping one overlay", () => {
        const controller = new ResizableDrawerController(
          new StandInHost(),
          CONFIG,
        );
        controller.handleTouchResizeStart(touch("touchstart", 500));

        controller.handleTouchResizeStart(touch("touchstart", 600));
        document.dispatchEvent(touch("touchmove", 500));

        expect(controller.drawerHeight).toBe(400);
        expect(overlays.length).toBe(1);

        document.dispatchEvent(touch("touchend"));

        expect(overlays).toEqual([]);
      });

      it("starts no drag for a touch of two fingers", () => {
        const controller = new ResizableDrawerController(
          new StandInHost(),
          CONFIG,
        );
        const start = touch("touchstart", 500, 520);

        controller.handleTouchResizeStart(start);
        document.dispatchEvent(touch("touchmove", 400));

        expect(start.defaultPrevented).toBe(true);
        expect(controller.isResizing).toBe(false);
        expect(controller.drawerHeight).toBe(300);
        expect(overlays).toEqual([]);
      });

      it("ignores a move made with a second finger down", () => {
        const controller = new ResizableDrawerController(
          new StandInHost(),
          CONFIG,
        );
        controller.handleTouchResizeStart(touch("touchstart", 500));

        document.dispatchEvent(touch("touchmove", 400, 420));

        expect(controller.isResizing).toBe(true);
        expect(controller.drawerHeight).toBe(300);
      });
    });

    describe("hostDisconnected()", () => {
      it("ends a drag in progress", () => {
        const host = new StandInHost();
        const controller = new ResizableDrawerController(host, CONFIG);
        controller.handleResizeStart(mouse("mousedown", 500));

        controller.hostDisconnected();
        document.dispatchEvent(mouse("mousemove", 400));

        expect(controller.isResizing).toBe(false);
        expect(controller.drawerHeight).toBe(300);
        expect(overlays).toEqual([]);
        expect(host.rendered).toEqual({ height: 300, resizing: false });
      });

      it("removes nothing from the page when no drag is in progress", () => {
        const controller = new ResizableDrawerController(
          new StandInHost(),
          CONFIG,
        );
        overlays.push({ style: { cssText: "someone else's" } });

        controller.hostDisconnected();

        expect(overlays.length).toBe(1);
      });
    });
  });
});
