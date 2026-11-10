import { assertEquals } from "@std/assert";
import * as pendingRender from "../src/pending-render.ts";

function attributeElement(
  attributes = new Map<string, string>(),
  options?: { missingAttribute: null | undefined },
): {
  attributes: Map<string, string>;
  element: Node;
} {
  const missingAttribute = options ? options.missingAttribute : null;
  return {
    attributes,
    element: {
      getAttribute: (name: string) => attributes.get(name) ?? missingAttribute,
      hasAttribute: (name: string) => attributes.has(name),
      setAttribute: (name: string, value: string) =>
        attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    } as unknown as Node,
  };
}

Deno.test("pending render state marks retained content inert and busy", () => {
  const { attributes, element } = attributeElement();

  pendingRender.setPendingRenderState(element, true);
  assertEquals(attributes.get("data-cf-pending"), "true");
  assertEquals(attributes.get("inert"), "");
  assertEquals(attributes.get("aria-busy"), "true");

  pendingRender.setPendingRenderState(element, false);
  assertEquals(attributes.size, 0);
});

Deno.test("pending render state restores application-owned attributes", () => {
  const { attributes, element } = attributeElement(
    new Map([
      ["inert", "application-value"],
      ["aria-busy", "false"],
    ]),
  );

  pendingRender.setPendingRenderState(element, true);
  pendingRender.setPendingRenderState(element, true);
  pendingRender.setPendingRenderState(element, false);

  assertEquals(attributes.get("inert"), "application-value");
  assertEquals(attributes.get("aria-busy"), "false");
  assertEquals(attributes.has("data-cf-pending"), false);
});

Deno.test("pending cleanup removes attributes missing in DOM-compatible mocks", () => {
  const { attributes, element } = attributeElement(new Map(), {
    missingAttribute: undefined,
  });

  pendingRender.setPendingRenderState(element, true);
  pendingRender.setPendingRenderState(element, false);

  assertEquals(attributes.size, 0);
});

Deno.test("pending cleanup leaves unrelated application attributes alone", () => {
  const { attributes, element } = attributeElement(
    new Map([
      ["inert", ""],
      ["aria-busy", "false"],
    ]),
  );

  pendingRender.setPendingRenderState(element, false);

  assertEquals(attributes.get("inert"), "");
  assertEquals(attributes.get("aria-busy"), "false");
});

Deno.test("pending render helper owns semantics, not presentation", () => {
  assertEquals("ensurePendingRenderStyles" in pendingRender, false);
  assertEquals("PENDING_RENDER_STYLES" in pendingRender, false);
});
