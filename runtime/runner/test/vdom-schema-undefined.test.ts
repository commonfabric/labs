import { assert, assertEquals } from "@std/assert";
import {
  debugVDOMSchema,
  rendererVDOMSchema,
  vnodeSchema,
} from "../src/schemas.ts";

const hasUndefinedType = (schema: unknown): boolean => {
  return !!(
    schema &&
    typeof schema === "object" &&
    "type" in schema &&
    (schema as { type: unknown }).type === "undefined"
  );
};

const anyOfIncludesUndefined = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object" || !("anyOf" in schema)) {
    return false;
  }
  const anyOf = (schema as { anyOf: unknown[] }).anyOf;
  return Array.isArray(anyOf) && anyOf.some((entry) => hasUndefinedType(entry));
};

const getArrayVariant = (
  schema: unknown,
): Record<string, unknown> | undefined => {
  if (!schema || typeof schema !== "object" || !("anyOf" in schema)) {
    return undefined;
  }
  const anyOf = (schema as { anyOf: unknown[] }).anyOf;
  if (!Array.isArray(anyOf)) {
    return undefined;
  }
  return anyOf.find((entry) =>
    !!entry &&
    typeof entry === "object" &&
    "type" in entry &&
    (entry as { type: unknown }).type === "array"
  ) as Record<string, unknown> | undefined;
};

Deno.test("rendererVDOMSchema allows undefined child entries", () => {
  const vdomRenderNode = (rendererVDOMSchema.$defs as Record<string, unknown>)
    .vdomRenderNode;
  assert(
    anyOfIncludesUndefined(vdomRenderNode),
    "rendererVDOMSchema vdomRenderNode should include type=undefined",
  );
});

Deno.test("debugVDOMSchema allows undefined child entries", () => {
  const vdomRenderNode = (debugVDOMSchema.$defs as Record<string, unknown>)
    .vdomRenderNode;
  assert(
    anyOfIncludesUndefined(vdomRenderNode),
    "debugVDOMSchema vdomRenderNode should include type=undefined",
  );
});

Deno.test("rendererVDOMSchema child arrays recurse through vdomRenderNode", () => {
  const defs = rendererVDOMSchema.$defs as Record<string, unknown>;
  const vdomNode = defs.vdomNode as {
    properties: Record<string, unknown>;
  };
  const vdomRenderNode = defs.vdomRenderNode;
  const childrenSchema = vdomNode.properties.children as {
    items: unknown;
  };
  const nestedArrayVariant = getArrayVariant(vdomRenderNode) as {
    items: { $ref: string; asCell?: readonly string[] };
  };

  assert(
    nestedArrayVariant,
    "rendererVDOMSchema vdomRenderNode should include an array variant",
  );
  assertEquals(
    nestedArrayVariant.items.$ref,
    "#/$defs/vdomRenderNode",
    "nested array items should recurse to vdomRenderNode",
  );
  assertEquals(
    nestedArrayVariant.items.asCell,
    ["cell"],
    "renderer nested array items should preserve asCell",
  );

  const childItems = childrenSchema.items as {
    $ref: string;
    asCell?: readonly string[];
  };
  assertEquals(
    childItems.$ref,
    "#/$defs/vdomRenderNode",
    "children items should point to recursive vdomRenderNode",
  );
  assertEquals(
    childItems.asCell,
    ["cell"],
    "renderer children items should preserve asCell",
  );
});

Deno.test("debugVDOMSchema child arrays recurse through vdomRenderNode", () => {
  const defs = debugVDOMSchema.$defs as Record<string, unknown>;
  const vdomNode = defs.vdomNode as {
    properties: Record<string, unknown>;
  };
  const vdomRenderNode = defs.vdomRenderNode;
  const childrenSchema = vdomNode.properties.children as {
    items: unknown;
  };
  const nestedArrayVariant = getArrayVariant(vdomRenderNode) as {
    items: { $ref: string; asCell?: unknown };
  };

  assert(
    nestedArrayVariant,
    "debugVDOMSchema vdomRenderNode should include an array variant",
  );
  assertEquals(
    nestedArrayVariant.items.$ref,
    "#/$defs/vdomRenderNode",
    "nested array items should recurse to vdomRenderNode",
  );
  assertEquals(
    nestedArrayVariant.items.asCell,
    undefined,
    "debug nested array items should not include asCell",
  );

  const childItems = childrenSchema.items as { $ref: string; asCell?: boolean };
  assertEquals(
    childItems.$ref,
    "#/$defs/vdomRenderNode",
    "children items should point to recursive vdomRenderNode",
  );
  assertEquals(
    childItems.asCell,
    undefined,
    "debug children items should not include asCell",
  );
});

Deno.test("vnodeSchema allows undefined in render-node and prop-value unions", () => {
  const defs = vnodeSchema.$defs as Record<string, unknown>;
  const renderNodeSchema = defs.RenderNode;
  const propsSchema = defs.Props as {
    additionalProperties: unknown;
  };

  assert(
    anyOfIncludesUndefined(renderNodeSchema),
    "vnodeSchema RenderNode should include type=undefined",
  );
  assert(
    anyOfIncludesUndefined(propsSchema.additionalProperties),
    "vnodeSchema Props additionalProperties should include type=undefined",
  );
});
