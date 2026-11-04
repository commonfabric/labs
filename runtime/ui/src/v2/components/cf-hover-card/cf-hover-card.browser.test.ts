import { expect } from "@std/expect";
import { CFHoverCard } from "./index.ts";

/** The card's box, as the browser laid it out. */
function cardRect(element: CFHoverCard): DOMRect {
  return element.shadowRoot!.querySelector(".card")!.getBoundingClientRect();
}

/**
 * Resolves after the browser has drawn two more frames. A `ResizeObserver`
 * reports after the first frame's animation callbacks, and a scroll the browser
 * makes for a focus is reported by then too, so a callback in the second frame
 * runs after the card has been placed again.
 */
function twoFrames(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
}

/** Mounts a card whose content is a button, placed `top` pixels down. */
async function mount(top: number): Promise<{
  element: CFHoverCard;
  button: HTMLButtonElement;
}> {
  const element = document.createElement("cf-hover-card") as CFHoverCard;
  element.style.position = "absolute";
  element.style.top = `${top}px`;
  element.style.left = "20px";
  element.innerHTML = `
    <button>😺 2</button>
    <div slot="card" style="width: 120px; height: 40px">Alice, Bob</div>
  `;
  document.body.append(element);
  expect(element).toBeInstanceOf(CFHoverCard);
  await element.updateComplete;
  return { element, button: element.querySelector("button")! };
}

Deno.test("cf-hover-card starts with its card hidden", async () => {
  const { element } = await mount(200);
  try {
    expect(element.open).toBe(false);
  } finally {
    element.remove();
  }
});

Deno.test("cf-hover-card shows its card while the pointer is on it", async () => {
  const { element } = await mount(200);
  try {
    element.dispatchEvent(new PointerEvent("pointerenter"));
    expect(element.open).toBe(true);

    element.dispatchEvent(new PointerEvent("pointerleave"));
    expect(element.open).toBe(false);
  } finally {
    element.remove();
  }
});

Deno.test("cf-hover-card shows its card while focus is inside it", async () => {
  const { element, button } = await mount(200);
  try {
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(element.open).toBe(true);

    button.blur();
    expect(element.open).toBe(false);
  } finally {
    element.remove();
  }
});

Deno.test("cf-hover-card keeps its card while focus stays after the pointer leaves", async () => {
  const { element, button } = await mount(200);
  try {
    button.focus();
    element.dispatchEvent(new PointerEvent("pointerenter"));
    element.dispatchEvent(new PointerEvent("pointerleave"));
    expect(element.open).toBe(true);
  } finally {
    element.remove();
  }
});

Deno.test("cf-hover-card places its card above its content when there is room", async () => {
  const { element } = await mount(200);
  try {
    element.dispatchEvent(new PointerEvent("pointerenter"));
    // A hidden card has an empty box at the origin, which is above anything.
    expect(element.open).toBe(true);
    expect(cardRect(element).bottom).toBeLessThanOrEqual(
      element.getBoundingClientRect().top,
    );
  } finally {
    element.remove();
  }
});

Deno.test("cf-hover-card places its card below its content at the top of the window", async () => {
  const { element } = await mount(0);
  try {
    element.dispatchEvent(new PointerEvent("pointerenter"));
    expect(element.open).toBe(true);
    expect(cardRect(element).top).toBeGreaterThanOrEqual(
      element.getBoundingClientRect().bottom,
    );
  } finally {
    element.remove();
  }
});

Deno.test("cf-hover-card keeps its card above its content as its container scrolls", async () => {
  // A page scrolls inside a container of its own, which moves the content and
  // leaves a card the top layer holds where it was placed.
  const scroller = document.createElement("div");
  scroller.style.cssText =
    "position: absolute; top: 100px; left: 0; width: 400px; height: 300px; overflow: auto";
  const inner = document.createElement("div");
  inner.style.cssText = "position: relative; height: 2000px";
  scroller.append(inner);
  document.body.append(scroller);
  const element = document.createElement("cf-hover-card") as CFHoverCard;
  element.style.cssText = "position: absolute; top: 400px; left: 20px";
  element.innerHTML = `
    <button>😺 2</button>
    <div slot="card" style="width: 120px; height: 40px">Alice, Bob</div>
  `;
  inner.append(element);
  expect(element).toBeInstanceOf(CFHoverCard);
  await element.updateComplete;
  try {
    scroller.scrollTop = 200;
    await twoFrames();
    element.dispatchEvent(new PointerEvent("pointerenter"));
    expect(element.open).toBe(true);
    // The card's `ResizeObserver` reports once when it starts observing,
    // placing the card again; that report comes first, so the placement after
    // the scroll is the scroll's own.
    await twoFrames();

    const scrolled = new Promise((resolve) =>
      scroller.addEventListener("scroll", resolve, { once: true })
    );
    scroller.scrollTop = 250;
    await scrolled;
    expect(element.open).toBe(true);
    const anchorTop = element.getBoundingClientRect().top;
    expect(cardRect(element).bottom).toBeLessThanOrEqual(anchorTop);
    expect(cardRect(element).bottom).toBeGreaterThan(anchorTop - 10);
  } finally {
    scroller.remove();
  }
});

Deno.test("cf-hover-card shows its card when focus reaches content below the fold", async () => {
  const { element, button } = await mount(4000);
  try {
    // Focus scrolls the content into view, and the card must survive that.
    button.focus();
    await twoFrames();
    expect(globalThis.scrollY).toBeGreaterThan(0);
    expect(element.open).toBe(true);
    expect(cardRect(element).bottom).toBeLessThanOrEqual(
      element.getBoundingClientRect().top,
    );
  } finally {
    element.remove();
    globalThis.scrollTo(0, 0);
  }
});

Deno.test("cf-hover-card keeps its card above its content as the card grows", async () => {
  const { element } = await mount(300);
  try {
    element.dispatchEvent(new PointerEvent("pointerenter"));
    expect(element.open).toBe(true);

    // What a card shows can arrive after it opens, as a profile badge's
    // avatar and name do.
    const extra = document.createElement("div");
    extra.style.height = "120px";
    element.querySelector('[slot="card"]')!.after(extra);
    extra.slot = "card";
    await twoFrames();
    expect(cardRect(element).height).toBeGreaterThan(120);
    expect(cardRect(element).bottom).toBeLessThanOrEqual(
      element.getBoundingClientRect().top,
    );
  } finally {
    element.remove();
  }
});

Deno.test("cf-hover-card shows its card for a pointer that arrives before it renders", async () => {
  const element = document.createElement("cf-hover-card") as CFHoverCard;
  element.innerHTML = `
    <button>😺 2</button>
    <div slot="card">Alice, Bob</div>
  `;
  document.body.append(element);
  expect(element).toBeInstanceOf(CFHoverCard);
  try {
    element.dispatchEvent(new PointerEvent("pointerenter"));
    await element.updateComplete;
    expect(element.open).toBe(true);
  } finally {
    element.remove();
  }
});

Deno.test("cf-hover-card keeps its card in the window when it goes below", async () => {
  const { element } = await mount(20);
  const tall = element.querySelector<HTMLElement>('[slot="card"]')!;
  // Too tall to fit above content this near the top, or below it either.
  tall.style.height = `${globalThis.innerHeight - 40}px`;
  try {
    element.dispatchEvent(new PointerEvent("pointerenter"));
    expect(element.open).toBe(true);
    await twoFrames();
    expect(cardRect(element).bottom).toBeLessThanOrEqual(
      globalThis.innerHeight,
    );
  } finally {
    element.remove();
  }
});

Deno.test("cf-hover-card follows its content when the window resizes", async () => {
  const { element } = await mount(300);
  try {
    element.dispatchEvent(new PointerEvent("pointerenter"));
    expect(element.open).toBe(true);
    await twoFrames();

    // Content that moves as the window changes size, as a centered layout's
    // does.
    element.style.top = "200px";
    globalThis.dispatchEvent(new Event("resize"));
    const anchorTop = element.getBoundingClientRect().top;
    expect(cardRect(element).bottom).toBeLessThanOrEqual(anchorTop);
    expect(cardRect(element).bottom).toBeGreaterThan(anchorTop - 10);
  } finally {
    element.remove();
  }
});
