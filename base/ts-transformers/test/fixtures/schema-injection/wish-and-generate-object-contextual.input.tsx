import {
  generateObject,
  type WishState,
  wish,
} from "commonfabric";

const existingLabelSchema = {
  type: "object",
  properties: {
    label: { type: "string" },
  },
  required: ["label"],
} as const;

// FIXTURE: wish-and-generate-object-contextual
// Verifies: wish() injects schemas from explicit and contextual result types, and generateObject() injects explicit schemas
//   wish<string>({ query }) → wish<string>({ query }, { type: "string" })
//   const state: WishState<{ title: string }> = wish({ query }) → { title: string }'s schema, the T inferred from the contextual WishState<T>
//   generateObject<T>({ ... }) injects params.schema, but preserves authored schema when already present
export default function TestWishAndGenerateObjectContextual() {
  const explicitWish = wish<string>({ query: "#greeting" });
  const contextualWish: WishState<{ title: string }> = wish({
    query: "#title",
  });

  const explicitObject = generateObject<{ title: string }>({
    model: "gpt-4o-mini",
    prompt: "Return a title",
  });
  const preSchemaObject = generateObject<{ label: string }>({
    model: "gpt-4o-mini",
    prompt: "Return a label",
    schema: existingLabelSchema,
  });

  return {
    explicitWish,
    contextualWish,
    explicitObject,
    preSchemaObject,
  };
}
