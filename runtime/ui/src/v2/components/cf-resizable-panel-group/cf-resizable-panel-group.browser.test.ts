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

Deno.test("panel sizes a renderer assigns as properties after the panels are in place reach the group", async () => {
  const group = new CFResizablePanelGroup();
  group.style.width = "400px";
  group.style.height = "400px";
  const first = new CFResizablePanel();
  const handle = new CFResizableHandle();
  const second = new CFResizablePanel();
  group.append(first, handle, second);
  document.body.append(group);
  try {
    await laidOut(group);
    expect(first.style.width).toBe("50%");

    first.defaultSize = 36;
    first.minSize = 20;
    second.defaultSize = 64;
    await laidOut(group);
    expect(first.style.width).toBe("36%");
    expect(second.style.width).toBe("64%");
    handle.focus();
    await pressKey("Home");
    expect(first.style.width).toBe("31%");
  } finally {
    group.remove();
  }
});

Deno.test("a size a person dragged to stays when the group reads its panels again", async () => {
  using page = await mounted("horizontal");
  page.handle.focus();
  await pressKey("ArrowRight");
  expect(page.first.style.width).toBe("37%");

  page.second.minSize = 25;
  await laidOut(page.group);
  expect(page.first.style.width).toBe("37%");

  page.first.defaultSize = 40;
  await laidOut(page.group);
  expect(page.first.style.width).toBe("40%");
  expect(page.second.style.width).toBe("64%");
});

Deno.test("a dragged size outside a panel's new bounds returns every panel to its default", async () => {
  using page = await mounted("horizontal");
  page.handle.focus();
  await pressKey("Home");
  expect(page.first.style.width).toBe("31%");

  page.first.minSize = 33;
  await laidOut(page.group);
  expect(page.first.style.width).toBe("36%");
  expect(page.second.style.width).toBe("64%");
});

Deno.test("a re-read of the panels during a drag ends the drag", async () => {
  using page = await mounted("horizontal");
  page.handle.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, clientX: 100, clientY: 160 }),
  );
  page.second.minSize = 25;
  await laidOut(page.group);
  expect(page.group.classList.contains("resizing")).toBe(false);
  document.dispatchEvent(
    new MouseEvent("mousemove", { clientX: 140, clientY: 160 }),
  );
  expect(page.first.style.width).toBe("36%");
});

Deno.test("the group and its handle name their orientation, the handle's for assistive technology as the line it draws", async () => {
  using page = await mounted("horizontal");
  expect(page.group.dataset.orientation).toBe("horizontal");
  expect(page.handle.getAttribute("aria-orientation")).toBe("vertical");

  page.group.direction = "vertical";
  await page.group.updateComplete;
  expect(page.group.dataset.orientation).toBe("vertical");
  expect(page.handle.getAttribute("aria-orientation")).toBe("horizontal");
});

Deno.test("a stackBelow that is not a positive width is refused, and a removed one stops stacking", async () => {
  for (const bad of [Number.NaN, 0, -10]) {
    using page = await mounted("horizontal");
    page.group.stackBelow = bad;
    await expect(page.group.updateComplete).rejects.toThrow(RangeError);
  }
  using page = built("horizontal");
  page.group.setAttribute("stack-below", "500");
  document.body.append(page.group);
  await laidOut(page.group);
  expect(page.group.orientation).toBe("vertical");
  page.group.removeAttribute("stack-below");
  await laidOut(page.group);
  expect(page.group.orientation).toBe("horizontal");
  expect(page.first.style.width).toBe("36%");
});

Deno.test("a panel marked hideWhenStacked steps aside while the group is stacked, with its handle, and the others take its room", async () => {
  using page = built("horizontal");
  page.group.stackBelow = 300;
  page.second.hideWhenStacked = true;
  document.body.append(page.group);
  await laidOut(page.group);
  // Side by side, it is drawn as any other panel.
  expect(page.second.style.display).toBe("");
  expect(page.handle.style.display).toBe("");
  expect(page.first.style.width).toBe("36%");

  page.group.style.width = "200px";
  await laidOut(page.group);
  expect(page.group.stacked).toBe(true);
  expect(page.second.style.display).toBe("none");
  expect(page.handle.style.display).toBe("none");
  expect(page.first.style.height).toBe("100%");
  expect(page.first.getBoundingClientRect().height).toBe(400);
  // An unmarked panel is never hidden.
  expect(page.first.style.display).toBe("");

  // Widened again, the split it had comes back.
  page.group.style.width = "400px";
  await laidOut(page.group);
  expect(page.second.style.display).toBe("");
  expect(page.handle.style.display).toBe("");
  expect(page.first.style.width).toBe("36%");
  expect(page.second.style.width).toBe("64%");
});

Deno.test("hideWhenStacked assigned or cleared while stacked takes effect at once", async () => {
  using page = built("horizontal");
  page.group.stackBelow = 500;
  document.body.append(page.group);
  await laidOut(page.group);
  expect(page.group.stacked).toBe(true);
  expect(page.second.style.display).toBe("");
  expect(page.first.style.height).toBe("36%");

  page.second.hideWhenStacked = true;
  await page.second.updateComplete;
  expect(page.second.style.display).toBe("none");
  expect(page.handle.style.display).toBe("none");
  expect(page.first.style.height).toBe("100%");

  page.second.hideWhenStacked = false;
  await page.second.updateComplete;
  expect(page.second.style.display).toBe("");
  expect(page.handle.style.display).toBe("");
  expect(page.first.style.height).toBe("36%");
});

Deno.test("a group that is vertical by its direction is not stacked, and hides nothing", async () => {
  using page = built("vertical");
  page.group.stackBelow = 500;
  page.second.hideWhenStacked = true;
  document.body.append(page.group);
  await laidOut(page.group);
  expect(page.group.stacked).toBe(false);
  expect(page.second.style.display).toBe("");
  expect(page.first.style.height).toBe("36%");
});

Deno.test("when every panel is marked hideWhenStacked, every panel is drawn", async () => {
  using page = built("horizontal");
  page.group.stackBelow = 500;
  page.first.hideWhenStacked = true;
  page.second.hideWhenStacked = true;
  document.body.append(page.group);
  await laidOut(page.group);
  expect(page.first.style.display).toBe("");
  expect(page.second.style.display).toBe("");
  expect(page.first.style.height).toBe("36%");
});

Deno.test("a display the host set on a panel is left alone", async () => {
  using page = built("horizontal");
  page.group.stackBelow = 300;
  page.first.style.display = "flex";
  page.second.hideWhenStacked = true;
  document.body.append(page.group);
  page.group.style.width = "200px";
  await laidOut(page.group);
  expect(page.first.style.display).toBe("flex");
});

Deno.test("with a panel hidden, a handle between two drawn panels moves as far as the pointer and the keys say", async () => {
  using page = built("horizontal");
  page.group.stackBelow = 500;
  for (const panel of [page.first, page.second]) {
    panel.setAttribute("default-size", "30");
    panel.setAttribute("min-size", "10");
  }
  const third = new CFResizablePanel();
  third.setAttribute("default-size", "40");
  third.hideWhenStacked = true;
  const handle2 = new CFResizableHandle();
  page.group.append(handle2, third);
  document.body.append(page.group);
  await laidOut(page.group);
  expect(third.style.display).toBe("none");
  expect(handle2.style.display).toBe("none");
  expect(page.handle.style.display).toBe("");
  expect(parseFloat(page.first.style.height)).toBeCloseTo(50);

  page.handle.focus();
  await pressKey("ArrowDown");
  expect(parseFloat(page.first.style.height)).toBeCloseTo(51);
  expect(parseFloat(page.second.style.height)).toBeCloseTo(49);

  const top = page.handle.getBoundingClientRect().top;
  page.handle.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: top }),
  );
  document.dispatchEvent(
    new MouseEvent("mousemove", { clientX: 10, clientY: top + 40 }),
  );
  document.dispatchEvent(new MouseEvent("mouseup"));
  // 40px of a 400px group is 10 points of the drawn length.
  expect(parseFloat(page.first.style.height)).toBeCloseTo(61);
});

Deno.test("a hidden panel gets back the display the host gave it", async () => {
  using page = built("horizontal");
  page.group.stackBelow = 300;
  page.second.style.display = "flex";
  page.second.hideWhenStacked = true;
  document.body.append(page.group);
  await laidOut(page.group);
  page.group.style.width = "200px";
  await laidOut(page.group);
  expect(page.second.style.display).toBe("none");
  page.group.style.width = "400px";
  await laidOut(page.group);
  expect(page.second.style.display).toBe("flex");
});

Deno.test("marking a panel while the group is side by side hides nothing", async () => {
  using page = await mounted("horizontal");
  page.group.stackBelow = 300;
  await laidOut(page.group);
  page.second.hideWhenStacked = true;
  await page.second.updateComplete;
  expect(page.second.style.display).toBe("");
  expect(page.handle.style.display).toBe("");
  expect(page.first.style.width).toBe("36%");
});

Deno.test("marking a panel leaves a drag in progress alone", async () => {
  using page = await mounted("horizontal");
  page.handle.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, clientX: 144, clientY: 10 }),
  );
  page.second.hideWhenStacked = true;
  await page.second.updateComplete;
  expect(page.group.classList.contains("resizing")).toBe(true);
  document.dispatchEvent(new MouseEvent("mouseup"));
});

Deno.test("a panel taken out of the group while hidden is drawn again", async () => {
  using page = built("horizontal");
  page.group.stackBelow = 500;
  page.second.hideWhenStacked = true;
  document.body.append(page.group);
  await laidOut(page.group);
  expect(page.second.style.display).toBe("none");
  page.second.remove();
  page.handle.remove();
  await laidOut(page.group);
  expect(page.second.style.display).toBe("");
  expect(page.handle.style.display).toBe("");
});

Deno.test("a stacked group taken out of the page draws its hidden panel and handle again", async () => {
  const page = built("horizontal");
  page.group.stackBelow = 500;
  page.second.hideWhenStacked = true;
  document.body.append(page.group);
  await laidOut(page.group);
  expect(page.second.style.display).toBe("none");
  page.group.remove();
  expect(page.second.style.display).toBe("");
  expect(page.handle.style.display).toBe("");
});

Deno.test("a panel marked in the same turn the group starts stacking still turns the handles", async () => {
  using page = await mounted("horizontal");
  await laidOut(page.group);
  // The panel updates before the group does.
  page.first.hideWhenStacked = true;
  page.group.stackBelow = 500;
  await page.first.updateComplete;
  await page.group.updateComplete;
  expect(page.group.stacked).toBe(true);
  expect(page.handle.dataset.orientation).toBe("vertical");
  expect(page.first.style.display).toBe("none");
});

Deno.test("a group nested in a panel sizes its own panels, and the outer group sizes only its own", async () => {
  using outer = built("horizontal");
  const inner = new CFResizablePanelGroup();
  inner.direction = "vertical";
  const top = new CFResizablePanel();
  top.setAttribute("default-size", "30");
  const innerHandle = new CFResizableHandle();
  const bottom = new CFResizablePanel();
  bottom.setAttribute("default-size", "70");
  inner.append(top, innerHandle, bottom);
  outer.first.append(inner);
  document.body.append(outer.group);
  await laidOut(outer.group);
  await inner.updateComplete;

  expect(outer.first.style.width).toBe("36%");
  expect(outer.second.style.width).toBe("64%");
  expect(top.style.height).toBe("30%");
  expect(bottom.style.height).toBe("70%");
  expect(top.style.width).toBe("");
  expect(bottom.style.width).toBe("");
  expect(innerHandle.dataset.orientation).toBe("vertical");
  expect(top.getBoundingClientRect().width).toBe(
    outer.first.getBoundingClientRect().width,
  );

  // A size change in the inner group is the inner group's alone.
  top.defaultSize = 40;
  await laidOut(outer.group);
  expect(top.style.height).toBe("40%");
  expect(top.style.width).toBe("");
  expect(outer.first.style.width).toBe("36%");

  // The outer handle moves the outer panels and leaves the inner ones be.
  outer.handle.focus();
  await pressKey("ArrowRight");
  expect(outer.first.style.width).toBe("37%");
  expect(top.style.height).toBe("40%");
  expect(top.style.width).toBe("");
});

/** A `display: contents` span holding `children`, as the renderer wraps the
 * items of an array. */
function wrapped(...children: HTMLElement[]): HTMLSpanElement {
  const span = document.createElement("span");
  span.style.display = "contents";
  span.append(...children);
  return span;
}

Deno.test("panels and a handle wrapped in an element, as an array's items are, belong to the group and lay out as direct children do", async () => {
  const group = new CFResizablePanelGroup();
  group.style.width = "400px";
  group.style.height = "400px";
  const first = new CFResizablePanel();
  first.defaultSize = 25;
  const handle = new CFResizableHandle();
  const second = new CFResizablePanel();
  second.defaultSize = 75;
  group.append(wrapped(first, handle), wrapped(second));
  document.body.append(group);
  try {
    await laidOut(group);
    expect(first.style.width).toBe("25%");
    expect(first.getBoundingClientRect().height).toBe(400);
    expect(handle.getBoundingClientRect().width).toBe(6);
    handle.focus();
    await pressKey("ArrowRight");
    expect(first.style.width).toBe("26%");
  } finally {
    group.remove();
  }
});

Deno.test("a wrapped panel removed with its wrapper leaves the group, and the rest return to their defaults", async () => {
  using page = built("horizontal");
  const third = new CFResizablePanel();
  third.defaultSize = 20;
  const handle2 = new CFResizableHandle();
  const wrapper = wrapped(handle2, third);
  page.group.append(wrapper);
  document.body.append(page.group);
  await laidOut(page.group);
  expect(third.style.width).toBe("20%");

  wrapper.remove();
  await laidOut(page.group);
  expect(third.style.width).toBe("");
  expect(third.dataset.orientation).toBe(undefined);
  page.handle.focus();
  await pressKey("ArrowRight");
  expect(page.first.style.width).toBe("37%");
  expect(page.second.style.width).toBe("63%");
});

Deno.test("a size change in a nested group leaves a drag in the outer group going", async () => {
  using outer = built("horizontal");
  const inner = new CFResizablePanelGroup();
  inner.direction = "vertical";
  const top = new CFResizablePanel();
  const bottom = new CFResizablePanel();
  inner.append(top, new CFResizableHandle(), bottom);
  outer.first.append(inner);
  document.body.append(outer.group);
  await laidOut(outer.group);

  outer.handle.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, clientX: 144, clientY: 10 }),
  );
  top.defaultSize = 40;
  await laidOut(outer.group);
  expect(outer.group.classList.contains("resizing")).toBe(true);
  document.dispatchEvent(
    new MouseEvent("mousemove", { clientX: 184, clientY: 10 }),
  );
  document.dispatchEvent(new MouseEvent("mouseup"));
  expect(outer.first.style.width).toBe("46%");
  expect(top.style.height).toBe("40%");
});

Deno.test("a nested group's resize is heard on that group alone", async () => {
  using outer = built("horizontal");
  const inner = new CFResizablePanelGroup();
  inner.direction = "vertical";
  const innerHandle = new CFResizableHandle();
  inner.append(new CFResizablePanel(), innerHandle, new CFResizablePanel());
  outer.first.append(inner);
  document.body.append(outer.group);
  await laidOut(outer.group);

  const heard: EventTarget[] = [];
  outer.group.addEventListener("cf-resize", (e) => heard.push(e.target!));
  inner.addEventListener("cf-resize", (e) => heard.push(e.target!));
  innerHandle.focus();
  await pressKey("ArrowDown");
  expect(heard).toEqual([inner]);
});

Deno.test("a press on a nested group's handle starts no drag in the outer group", async () => {
  using outer = built("horizontal");
  const inner = new CFResizablePanelGroup();
  inner.direction = "vertical";
  const innerHandle = new CFResizableHandle();
  inner.append(new CFResizablePanel(), innerHandle, new CFResizablePanel());
  outer.first.append(inner);
  document.body.append(outer.group);
  await laidOut(outer.group);

  innerHandle.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: 200 }),
  );
  expect(inner.classList.contains("resizing")).toBe(true);
  expect(outer.group.classList.contains("resizing")).toBe(false);
  document.dispatchEvent(new MouseEvent("mouseup"));
});

Deno.test("a handle taken out of the group no longer starts a drag in it", async () => {
  using page = await mounted("horizontal");
  page.handle.remove();
  document.body.append(page.handle);
  try {
    page.handle.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, clientX: 144, clientY: 10 }),
    );
    expect(page.group.classList.contains("resizing")).toBe(false);
  } finally {
    page.handle.remove();
  }
});

Deno.test("a handle moves the nearest panel on each side of it, and one at an end moves nothing", async () => {
  using page = built("horizontal");
  const leading = new CFResizableHandle();
  page.group.prepend(leading);
  document.body.append(page.group);
  await laidOut(page.group);
  leading.focus();
  await pressKey("ArrowRight");
  expect(page.first.style.width).toBe("36%");
  page.handle.focus();
  await pressKey("ArrowRight");
  expect(page.first.style.width).toBe("37%");
  expect(page.second.style.width).toBe("63%");
});

Deno.test("a handle that leaves takes none of the group's orientation with it", async () => {
  using page = await mounted("horizontal");
  page.handle.remove();
  expect(page.handle.dataset.orientation).toBe(undefined);
  expect(page.handle.hasAttribute("aria-orientation")).toBe(false);
});

Deno.test("a member moved to another group belongs to that group alone", async () => {
  using a = await mounted("horizontal");
  using b = await mounted("vertical");
  b.group.append(a.second);
  await laidOut(b.group);
  expect(a.second.style.width).toBe("");
  expect(a.second.dataset.orientation).toBe("vertical");
  expect(a.second.style.height).not.toBe("");
  a.handle.focus();
  await pressKey("ArrowRight");
  expect(a.first.style.width).toBe("36%");
});

Deno.test("a group taken out and put back with its panels lays them out again", async () => {
  using page = await mounted("horizontal");
  page.group.remove();
  document.body.append(page.group);
  await laidOut(page.group);
  expect(page.first.style.width).toBe("36%");
  page.handle.focus();
  await pressKey("ArrowRight");
  expect(page.first.style.width).toBe("37%");
});

Deno.test("a handle at an end steps aside with the hidden panel beside it", async () => {
  using page = built("horizontal");
  page.group.stackBelow = 500;
  const trailing = new CFResizableHandle();
  page.group.append(trailing);
  page.second.hideWhenStacked = true;
  document.body.append(page.group);
  await laidOut(page.group);
  expect(page.second.style.display).toBe("none");
  expect(trailing.style.display).toBe("none");
});

Deno.test("a handle leaving keeps the size its author gave it", async () => {
  using page = await mounted("vertical");
  page.handle.style.height = "12px";
  page.handle.remove();
  expect(page.handle.style.height).toBe("12px");
});
