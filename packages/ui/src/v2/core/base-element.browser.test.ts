import { expect } from "@std/expect";

import { CFVStack } from "../components/cf-vstack/index.ts";

/**
 * A `cf-vstack`, whose own styles give its host `display: block`, set up by
 * `setUp` and then attached to the document.
 */
const attachedStack = async (
  setUp: (element: CFVStack) => void,
): Promise<CFVStack> => {
  const element = document.createElement("cf-vstack") as CFVStack;
  setUp(element);
  document.body.append(element);
  expect(element).toBeInstanceOf(CFVStack);
  await element.updateComplete;
  return element;
};

Deno.test("BaseElement leaves a host without `hidden` displayed as its own styles say", async () => {
  const element = await attachedStack(() => {});
  try {
    expect(getComputedStyle(element).display).toBe("block");
  } finally {
    element.remove();
  }
});

Deno.test("BaseElement gives a host carrying `hidden` a display of `none`", async () => {
  const element = await attachedStack((stack) => {
    stack.hidden = true;
  });
  try {
    expect(getComputedStyle(element).display).toBe("none");
  } finally {
    element.remove();
  }
});

Deno.test("BaseElement gives a host carrying `hidden` the display its inline style names", async () => {
  const element = await attachedStack((stack) => {
    stack.hidden = true;
    stack.style.display = "flex";
  });
  try {
    expect(getComputedStyle(element).display).toBe("flex");
  } finally {
    element.remove();
  }
});

Deno.test('BaseElement leaves a host carrying `hidden="until-found"` displayed as its own styles say', async () => {
  const element = await attachedStack((stack) => {
    stack.setAttribute("hidden", "until-found");
  });
  try {
    expect(getComputedStyle(element).display).toBe("block");
  } finally {
    element.remove();
  }
});
