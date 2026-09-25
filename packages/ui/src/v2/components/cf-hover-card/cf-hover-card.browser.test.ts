import { expect } from "@std/expect";
import { CFHoverCard } from "./index.ts";

/** The card's box, as the browser laid it out. */
function cardRect(element: CFHoverCard): DOMRect {
  return element.shadowRoot!.querySelector(".card")!.getBoundingClientRect();
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
    // A hidden card has an empty box at the origin, which is above anything.
    expect(element.open).toBe(true);
    expect(cardRect(element).top).toBeGreaterThanOrEqual(
      element.getBoundingClientRect().bottom,
    );
  } finally {
    element.remove();
  }
});

Deno.test("cf-hover-card hides its card when the page scrolls", async () => {
  const { element } = await mount(200);
  try {
    element.dispatchEvent(new PointerEvent("pointerenter"));
    expect(element.open).toBe(true);

    document.dispatchEvent(new Event("scroll"));
    expect(element.open).toBe(false);
  } finally {
    element.remove();
  }
});
