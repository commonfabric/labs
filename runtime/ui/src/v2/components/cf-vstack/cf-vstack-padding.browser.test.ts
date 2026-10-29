import { assertEquals } from "@std/assert";
import "./index.ts";

type UpdatingElement = HTMLElement & {
  updateComplete: Promise<unknown>;
};

async function mountVStack(
  attributes: Record<string, string>,
): Promise<{ host: UpdatingElement; stack: HTMLElement }> {
  const host = document.createElement("cf-vstack") as UpdatingElement;
  for (const [name, value] of Object.entries(attributes)) {
    host.setAttribute(name, value);
  }
  document.body.append(host);
  await host.updateComplete;
  const stack = host.shadowRoot!.querySelector(".stack") as HTMLElement;
  return { host, stack };
}

Deno.test("directional padding overrides uniform padding on its side", async () => {
  const { host, stack } = await mountVStack({ padding: "4", pt: "2" });
  try {
    const style = getComputedStyle(stack);
    assertEquals(style.paddingTop, "8px"); // pt=2 -> 0.5rem
    assertEquals(style.paddingRight, "16px"); // padding=4 -> 1rem
    assertEquals(style.paddingBottom, "16px");
    assertEquals(style.paddingLeft, "16px");
  } finally {
    host.remove();
  }
});

Deno.test("single-side padding overrides the axis padding on its side", async () => {
  const { host, stack } = await mountVStack({ px: "4", pl: "1" });
  try {
    const style = getComputedStyle(stack);
    assertEquals(style.paddingLeft, "4px"); // pl=1 -> 0.25rem
    assertEquals(style.paddingRight, "16px"); // px=4 -> 1rem
    assertEquals(style.paddingTop, "0px"); // padding defaults to 0
    assertEquals(style.paddingBottom, "0px");
  } finally {
    host.remove();
  }
});

Deno.test("t-shirt scale values work for directional padding", async () => {
  const { host, stack } = await mountVStack({ py: "md" });
  try {
    const style = getComputedStyle(stack);
    assertEquals(style.paddingTop, "8px"); // md -> 0.5rem
    assertEquals(style.paddingBottom, "8px");
    assertEquals(style.paddingLeft, "0px");
    assertEquals(style.paddingRight, "0px");
  } finally {
    host.remove();
  }
});
