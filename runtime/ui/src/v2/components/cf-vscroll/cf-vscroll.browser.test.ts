import { expect } from "@std/expect";
import { CFVScroll } from "./index.ts";

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function rows(count: number): HTMLElement[] {
  return Array.from({ length: count }, (_, i) => {
    const row = document.createElement("div");
    row.style.height = "50px";
    row.textContent = `Row ${i}`;
    return row;
  });
}

function container(element: CFVScroll): HTMLElement {
  return element.shadowRoot!.querySelector(".scroll-container")!;
}

function distanceFromBottom(element: CFVScroll): number {
  const { scrollTop, scrollHeight, clientHeight } = container(element);
  return scrollHeight - clientHeight - scrollTop;
}

/**
 * The frames a change takes to reach the scroller: a resize observer reports
 * after layout, in the rendering step that ends the next frame, and an
 * instant snap it makes has landed by the frame after.
 */
async function framesForSnap(): Promise<void> {
  await nextFrame();
  await nextFrame();
}

/**
 * Waits for a smooth snap that has started to finish. A snap that never
 * started fails here, rather than leaving the test waiting for its end.
 */
async function smoothSnapSettled(element: CFVScroll): Promise<void> {
  const before = container(element).scrollTop;
  const settled = new Promise((resolve) =>
    container(element).addEventListener("scrollend", resolve, { once: true })
  );
  await framesForSnap();
  expect(container(element).scrollTop).toBeGreaterThan(before);
  await settled;
}

/** A 100px-tall snapping scroller, holding `children` when it connects. */
async function mount(children: HTMLElement[]): Promise<CFVScroll> {
  const element = document.createElement("cf-vscroll") as CFVScroll;
  element.snapToBottom = true;
  element.height = "100px";
  element.append(...children);
  document.body.append(element);
  expect(element).toBeInstanceOf(CFVScroll);
  await element.updateComplete;
  await framesForSnap();
  return element;
}

Deno.test("cf-vscroll snap-to-bottom opens at the bottom when its content is there at connect", async () => {
  const element = await mount(rows(20));
  try {
    expect(container(element).scrollHeight).toBeGreaterThan(100);
    expect(distanceFromBottom(element)).toBe(0);
  } finally {
    element.remove();
  }
});

Deno.test("cf-vscroll without snap-to-bottom opens at the top", async () => {
  const element = document.createElement("cf-vscroll") as CFVScroll;
  element.height = "100px";
  element.append(...rows(20));
  document.body.append(element);
  try {
    await element.updateComplete;
    await nextFrame();
    expect(container(element).scrollTop).toBe(0);
  } finally {
    element.remove();
  }
});

Deno.test("cf-vscroll snap-to-bottom jumps, rather than animates, to content that arrives after connect", async () => {
  const element = await mount([]);
  try {
    element.append(...rows(20));
    await framesForSnap();
    expect(distanceFromBottom(element)).toBe(0);
  } finally {
    element.remove();
  }
});

Deno.test("cf-vscroll snap-to-bottom follows content appended while the reader is at the bottom", async () => {
  const element = await mount(rows(20));
  try {
    element.append(...rows(3));
    expect(distanceFromBottom(element)).toBeGreaterThan(0);
    await smoothSnapSettled(element);
    expect(distanceFromBottom(element)).toBe(0);
  } finally {
    element.remove();
  }
});

Deno.test("cf-vscroll snap-to-bottom holds position when content is appended while the reader has scrolled up", async () => {
  const element = await mount(rows(20));
  try {
    const scrolled = new Promise((resolve) =>
      container(element).addEventListener("scroll", resolve, { once: true })
    );
    container(element).scrollTop = 200;
    await scrolled;
    element.append(...rows(3));
    await framesForSnap();
    expect(container(element).scrollTop).toBe(200);
  } finally {
    element.remove();
  }
});

Deno.test("cf-vscroll snap-to-bottom keeps following content that streams in frame by frame", async () => {
  const element = await mount(rows(20));
  try {
    for (let i = 0; i < 30; i++) {
      element.append(...rows(1));
      await nextFrame();
    }
    element.append(...rows(1));
    await smoothSnapSettled(element);
    expect(distanceFromBottom(element)).toBe(0);
  } finally {
    element.remove();
  }
});

Deno.test("cf-vscroll snap-to-bottom follows content that grows inside a slotted element's shadow root", async () => {
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  const element = await mount([host]);
  try {
    shadow.append(...rows(20));
    await framesForSnap();
    expect(distanceFromBottom(element)).toBe(0);
  } finally {
    element.remove();
  }
});

Deno.test("cf-vscroll snap-to-bottom opens at the bottom when shown after connecting hidden", async () => {
  const panel = document.createElement("div");
  panel.hidden = true;
  document.body.append(panel);
  const element = document.createElement("cf-vscroll") as CFVScroll;
  element.snapToBottom = true;
  element.height = "100px";
  element.append(...rows(20));
  panel.append(element);
  try {
    await element.updateComplete;
    await framesForSnap();
    panel.hidden = false;
    await framesForSnap();
    expect(distanceFromBottom(element)).toBe(0);
  } finally {
    panel.remove();
  }
});

Deno.test("cf-vscroll snap-to-bottom follows items added inside a display: contents wrapper", async () => {
  // The renderer slots an array of children inside such a wrapper.
  const wrapper = document.createElement("span");
  wrapper.style.display = "contents";
  const element = await mount([wrapper]);
  try {
    wrapper.append(...rows(20));
    await framesForSnap();
    expect(distanceFromBottom(element)).toBe(0);
  } finally {
    element.remove();
  }
});

Deno.test("cf-vscroll snap-to-bottom follows text streaming into a slotted text node", async () => {
  const text = document.createTextNode("");
  const element = document.createElement("cf-vscroll") as CFVScroll;
  element.snapToBottom = true;
  element.height = "100px";
  element.append(text);
  document.body.append(element);
  await element.updateComplete;
  await framesForSnap();
  try {
    text.data = "word ".repeat(2000);
    await framesForSnap();
    expect(container(element).scrollHeight).toBeGreaterThan(100);
    expect(distanceFromBottom(element)).toBe(0);
  } finally {
    element.remove();
  }
});

Deno.test("cf-vscroll snap-to-bottom follows an item that grows inside a display: contents wrapper", async () => {
  // As an image in a message does when it loads.
  const wrapper = document.createElement("span");
  wrapper.style.display = "contents";
  const [item] = rows(1);
  wrapper.append(item);
  const element = await mount([wrapper]);
  try {
    item.style.height = "1000px";
    await framesForSnap();
    expect(distanceFromBottom(element)).toBe(0);
  } finally {
    element.remove();
  }
});
