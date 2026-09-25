import { expect } from "@std/expect";
import { CFHoverReveal } from "./index.ts";

/** The opacity the actions container is drawn at. */
function actionsOpacity(element: CFHoverReveal): string {
  const actions = element.shadowRoot!.querySelector(".actions")!;
  return getComputedStyle(actions).opacity;
}

async function mountWithAction(): Promise<{
  element: CFHoverReveal;
  action: HTMLButtonElement;
}> {
  // A device that cannot hover shows the actions always, so the hidden state
  // exists only on one that can. `deno-web-test.config.ts` says it can.
  expect(matchMedia("(hover: hover)").matches).toBe(true);
  const element = document.createElement("cf-hover-reveal") as CFHoverReveal;
  element.innerHTML = `
    <span>A message</span>
    <button slot="actions">React</button>
  `;
  document.body.append(element);
  expect(element).toBeInstanceOf(CFHoverReveal);
  await element.updateComplete;
  return { element, action: element.querySelector("button")! };
}

Deno.test("cf-hover-reveal hides its actions while nothing reveals them", async () => {
  const { element } = await mountWithAction();
  try {
    expect(actionsOpacity(element)).toBe("0");
  } finally {
    element.remove();
  }
});

Deno.test("cf-hover-reveal shows its actions while `revealed` is set", async () => {
  const { element } = await mountWithAction();
  try {
    element.revealed = true;
    await element.updateComplete;
    expect(element.hasAttribute("revealed")).toBe(true);
    expect(actionsOpacity(element)).toBe("1");

    element.revealed = false;
    await element.updateComplete;
    expect(element.hasAttribute("revealed")).toBe(false);
    expect(actionsOpacity(element)).toBe("0");
  } finally {
    element.remove();
  }
});

Deno.test("cf-hover-reveal shows its actions while focus is inside it", async () => {
  const { element, action } = await mountWithAction();
  try {
    action.focus();
    expect(document.activeElement).toBe(action);
    expect(actionsOpacity(element)).toBe("1");
  } finally {
    element.remove();
  }
});
