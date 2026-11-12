// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CFDraggable } from "./index.ts";
import { boundHandler } from "../../test-utils/template.ts";

/**
 * Mounts a draggable at (`x`, `y`) holding `content`, and returns it with the
 * `detail` of every `positionchange` it dispatches.
 */
async function mountDraggable(
  content = "<span>Note</span>",
  x = 10,
  y = 20,
): Promise<{
  draggable: CFDraggable;
  changes: { x: number; y: number }[];
}> {
  const draggable = Object.assign(new CFDraggable(), { x, y });
  draggable.innerHTML = content;
  const changes: { x: number; y: number }[] = [];
  draggable.addEventListener("positionchange", (event) => {
    changes.push((event as CustomEvent).detail);
  });
  await mount(draggable);
  return { draggable, changes };
}

/** Dispatches a mouse event of `type` at (`x`, `y`) on `target`. */
function mouse(target: EventTarget, type: string, x: number, y: number): void {
  target.dispatchEvent(
    new MouseEvent(type, {
      clientX: x,
      clientY: y,
      bubbles: true,
      composed: true,
    }),
  );
}

/**
 * Presses the mouse at (`x`, `y`) on `target`, content slotted into
 * `draggable`. happy-dom does not route an event from slotted content through
 * the slot into the shadow tree, so this hands the shadow tree's `mousedown`
 * listener the event a browser would deliver to it.
 */
function press(
  draggable: CFDraggable,
  target: Element,
  x: number,
  y: number,
): void {
  boundHandler<
    Pick<MouseEvent, "target" | "clientX" | "clientY" | "preventDefault">
  >(draggable.render(), "@mousedown", draggable)({
    target,
    clientX: x,
    clientY: y,
    preventDefault() {},
  });
}

/** Where `draggable` is placed, as its inline `left` and `top`. */
function placement(draggable: CFDraggable): [string, string] {
  return [draggable.style.left, draggable.style.top];
}

describe("CFDraggable", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-draggable`", () => {
    expect(customElements.get("cf-draggable")).toBe(CFDraggable);
  });

  it("places itself at its `x` and `y` when connected", async () => {
    const { draggable } = await mountDraggable();
    expect(placement(draggable)).toEqual(["10px", "20px"]);
  });

  it("moves with the mouse while dragged", async () => {
    const { draggable, changes } = await mountDraggable();

    press(draggable, draggable.querySelector("span")!, 100, 100);
    expect(draggable.classList.contains("dragging")).toBe(true);
    mouse(document, "mousemove", 130, 90);

    expect(placement(draggable)).toEqual(["40px", "10px"]);
    // Moving reports no new position until the drag ends.
    expect(changes).toEqual([]);
  });

  it("dispatches `positionchange` with where it was dropped when the mouse is released", async () => {
    const { draggable, changes } = await mountDraggable();
    press(draggable, draggable.querySelector("span")!, 100, 100);

    mouse(document, "mouseup", 105, 140);

    expect(changes).toEqual([{ x: 15, y: 60 }]);
    expect(draggable.classList.contains("dragging")).toBe(false);

    // Released, it follows the mouse no further.
    mouse(document, "mousemove", 300, 300);
    expect(placement(draggable)).toEqual(["10px", "20px"]);
  });

  it("does not move or dispatch `positionchange` for the mouse when not dragged", async () => {
    const { draggable, changes } = await mountDraggable();

    mouse(document, "mousemove", 300, 300);
    mouse(document, "mouseup", 300, 300);

    expect(placement(draggable)).toEqual(["10px", "20px"]);
    expect(changes).toEqual([]);
  });

  describe("does not start a drag from a press on", () => {
    // Each of these is content the press is meant for rather than a handle to
    // drag the note by.

    for (
      const [name, content] of [
        ["an `<input>`", "<input>"],
        ["a `<button>`", "<button>Go</button>"],
        ["a `<cf-input>`", "<cf-input></cf-input>"],
        ["a `<cf-textarea>`", "<cf-textarea></cf-textarea>"],
        ["a `<cf-select>`", "<cf-select></cf-select>"],
        ["a `<cf-button>`", "<cf-button></cf-button>"],
        [
          "content inside a `<common-send-message>`",
          "<common-send-message><span>Send</span></common-send-message>",
        ],
      ]
    ) {
      it(name, async () => {
        const { draggable } = await mountDraggable(content);
        const target = draggable.querySelector("span") ??
          draggable.firstElementChild!;

        press(draggable, target, 100, 100);
        mouse(document, "mousemove", 200, 200);

        expect(draggable.classList.contains("dragging")).toBe(false);
        expect(placement(draggable)).toEqual(["10px", "20px"]);
      });
    }
  });

  it("follows changes to `x` and `y` when not dragged", async () => {
    const { draggable } = await mountDraggable();

    draggable.x = 50;
    draggable.y = 60;
    await draggable.updateComplete;

    expect(placement(draggable)).toEqual(["50px", "60px"]);
  });

  it("keeps following the mouse rather than `x` and `y` while dragged", async () => {
    const { draggable } = await mountDraggable();
    press(draggable, draggable.querySelector("span")!, 100, 100);
    mouse(document, "mousemove", 110, 110);

    draggable.x = 50;
    await draggable.updateComplete;

    expect(placement(draggable)).toEqual(["20px", "30px"]);
  });

  it("follows the mouse no further once removed from the document", async () => {
    const { draggable, changes } = await mountDraggable();
    press(draggable, draggable.querySelector("span")!, 100, 100);

    draggable.remove();
    mouse(document, "mousemove", 200, 200);
    mouse(document, "mouseup", 200, 200);

    expect(placement(draggable)).toEqual(["10px", "20px"]);
    expect(changes).toEqual([]);
  });
});
