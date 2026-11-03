/**
 * A panel group's `direction` is a property: the renderer assigns it, and
 * nothing copies it to an attribute. The handle's arrow keys and the panels'
 * sized dimension both follow that property, including when it changes after
 * the panels are in place.
 */

import { expect } from "@std/expect";
import { pressKey } from "@commonfabric/deno-web-test/commands";

import { CFResizableHandle } from "../cf-resizable-handle/index.ts";
import { CFResizablePanel } from "../cf-resizable-panel/index.ts";
import type { PanelGroupDirection } from "./cf-resizable-panel-group.ts";
import { CFResizablePanelGroup } from "./index.ts";

interface Mounted extends Disposable {
  group: CFResizablePanelGroup;
  first: CFResizablePanel;
  second: CFResizablePanel;
  handle: CFResizableHandle;
}

/** Two panels and a handle in a 400px square group, not yet attached. The
 * direction is assigned as a property, as the renderer assigns it. */
function built(direction?: PanelGroupDirection): Mounted {
  const group = new CFResizablePanelGroup();
  if (direction) group.direction = direction;
  group.style.width = "400px";
  group.style.height = "400px";
  const first = new CFResizablePanel();
  first.setAttribute("default-size", "36");
  first.setAttribute("min-size", "20");
  const handle = new CFResizableHandle();
  const second = new CFResizablePanel();
  second.setAttribute("default-size", "64");
  second.setAttribute("min-size", "30");
  group.append(first, handle, second);
  return {
    group,
    first,
    second,
    handle,
    [Symbol.dispose]: () => group.remove(),
  };
}

/** The group from `built`, attached last and rendered. */
async function mounted(direction?: PanelGroupDirection): Promise<Mounted> {
  const page = built(direction);
  document.body.append(page.group);
  await page.group.updateComplete;
  return page;
}

Deno.test("a vertical group's handle resizes with Up and Down, not Left and Right", async () => {
  using page = await mounted("vertical");
  expect(page.group.hasAttribute("direction")).toBe(false);
  page.handle.focus();
  await pressKey("ArrowDown");
  expect(page.first.style.height).toBe("37%");
  expect(page.second.style.height).toBe("63%");
  await pressKey("ArrowRight");
  await pressKey("ArrowLeft");
  expect(page.first.style.height).toBe("37%");
  await pressKey("ArrowUp");
  expect(page.first.style.height).toBe("36%");
});

Deno.test("a horizontal group's handle resizes with Left and Right, not Up and Down", async () => {
  using page = await mounted();
  page.handle.focus();
  await pressKey("ArrowRight");
  expect(page.first.style.width).toBe("37%");
  expect(page.second.style.width).toBe("63%");
  await pressKey("ArrowDown");
  await pressKey("ArrowUp");
  expect(page.first.style.width).toBe("37%");
  await pressKey("ArrowLeft");
  expect(page.first.style.width).toBe("36%");
});

Deno.test("a direction changed after the panels are in place carries to the handle and the panels", async () => {
  using page = await mounted("horizontal");
  expect(page.handle.dataset.orientation).toBe("horizontal");
  expect(page.first.style.width).toBe("36%");

  page.group.direction = "vertical";
  await page.group.updateComplete;
  expect(page.handle.dataset.orientation).toBe("vertical");
  expect(page.first.style.height).toBe("36%");
  expect(page.first.style.width).toBe("");

  page.handle.focus();
  await pressKey("ArrowDown");
  expect(page.first.style.height).toBe("37%");
});

Deno.test("a direction assigned after the group is attached, before its first render, carries to the handle and the panels", async () => {
  using page = built();
  document.body.append(page.group);
  page.group.direction = "vertical";
  await page.group.updateComplete;
  expect(page.handle.dataset.orientation).toBe("vertical");
  expect(page.first.style.height).toBe("36%");
  expect(page.first.style.width).toBe("");
});

Deno.test("a direction change during a drag ends the drag, and a stationary pointer leaves the split alone", async () => {
  using page = await mounted("horizontal");
  page.handle.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, clientX: 100, clientY: 160 }),
  );

  page.group.direction = "vertical";
  await page.group.updateComplete;
  expect(page.group.classList.contains("resizing")).toBe(false);
  document.dispatchEvent(
    new MouseEvent("mousemove", { clientX: 100, clientY: 160 }),
  );
  expect(page.first.style.height).toBe("36%");
  expect(page.second.style.height).toBe("64%");
});

/**
 * Resolves after the browser has drawn two more frames, by which time a
 * `ResizeObserver` has reported the group's width and the group has updated.
 */
async function laidOut(group: CFResizablePanelGroup): Promise<void> {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
  await group.updateComplete;
}

Deno.test("a group narrower than its stackBelow stacks its panels, and one as wide or wider keeps its direction", async () => {
  using narrow = built("horizontal");
  narrow.group.stackBelow = 401;
  document.body.append(narrow.group);
  await laidOut(narrow.group);
  expect(narrow.group.orientation).toBe("vertical");
  expect(narrow.handle.dataset.orientation).toBe("vertical");
  expect(narrow.first.style.height).toBe("36%");
  expect(narrow.first.style.width).toBe("");
  expect(narrow.first.getBoundingClientRect().width).toBe(400);

  using wide = built("horizontal");
  wide.group.stackBelow = 400;
  document.body.append(wide.group);
  await laidOut(wide.group);
  expect(wide.group.orientation).toBe("horizontal");
  expect(wide.handle.dataset.orientation).toBe("horizontal");
  expect(wide.first.style.width).toBe("36%");
  expect(wide.first.getBoundingClientRect().height).toBe(400);
});

Deno.test("a group with no stackBelow keeps its direction however narrow it is", async () => {
  using page = built("horizontal");
  page.group.style.width = "100px";
  document.body.append(page.group);
  await laidOut(page.group);
  expect(page.group.orientation).toBe("horizontal");
  expect(page.first.style.width).toBe("36%");
});

Deno.test("a group that narrows past its stackBelow stacks its panels, keeping their split, and turns back when it widens", async () => {
  using page = await mounted("horizontal");
  page.group.stackBelow = 300;
  await laidOut(page.group);
  page.handle.focus();
  await pressKey("ArrowRight");
  expect(page.first.style.width).toBe("37%");

  page.group.style.width = "200px";
  await laidOut(page.group);
  expect(page.handle.dataset.orientation).toBe("vertical");
  expect(page.first.style.height).toBe("37%");
  expect(page.first.style.width).toBe("");
  // The handle's arrow keys turn with it.
  page.handle.focus();
  await pressKey("ArrowRight");
  expect(page.first.style.height).toBe("37%");
  await pressKey("ArrowDown");
  expect(page.first.style.height).toBe("38%");

  page.group.style.width = "400px";
  await laidOut(page.group);
  expect(page.handle.dataset.orientation).toBe("horizontal");
  expect(page.first.style.width).toBe("38%");
  expect(page.first.style.height).toBe("");
});

Deno.test("a width change that crosses no stackBelow leaves a drag in progress alone", async () => {
  using page = await mounted("horizontal");
  page.group.stackBelow = 300;
  await laidOut(page.group);
  page.handle.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, clientX: 100, clientY: 160 }),
  );

  page.group.style.width = "350px";
  await laidOut(page.group);
  expect(page.group.classList.contains("resizing")).toBe(true);
  document.dispatchEvent(
    new MouseEvent("mousemove", { clientX: 135, clientY: 160 }),
  );
  expect(page.first.style.width).toBe("46%");
  document.dispatchEvent(new MouseEvent("mouseup"));
});
