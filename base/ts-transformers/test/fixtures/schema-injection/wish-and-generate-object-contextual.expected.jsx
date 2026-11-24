function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { generateObject, type WishState, wish, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const existingLabelSchema = __cfHelpers.__cf_data({
    type: "object",
    properties: {
        label: { type: "string" },
    },
    required: ["label"],
} as const);
// FIXTURE: wish-and-generate-object-contextual
// Verifies: wish() injects schemas from explicit and contextual result types, and generateObject() injects explicit schemas
//   wish<string>({ query }) → wish<string>({ query }, { type: "string" })
//   const state: WishState<{ title: string }> = wish({ query }) → { title: string }'s schema, the T inferred from the contextual WishState<T>
//   generateObject<T>({ ... }) injects params.schema, but preserves authored schema when already present
export default function TestWishAndGenerateObjectContextual() {
    const explicitWish = wish<string>({ query: "#greeting" }, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("explicitWish", true);
    const contextualWish: WishState<{
        title: string;
    }> = wish({
        query: "#title",
    }, {
        type: "object",
        properties: {
            title: {
                type: "string"
            }
        },
        required: ["title"]
    } as const satisfies __cfHelpers.JSONSchema).for("contextualWish", true);
    const explicitObject = generateObject<{
        title: string;
    }>({
        schema: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"]
        } as const satisfies __cfHelpers.JSONSchema,
        model: "gpt-4o-mini",
        prompt: "Return a title"
    }).for("explicitObject", true);
    const preSchemaObject = generateObject<{
        label: string;
    }>({
        model: "gpt-4o-mini",
        prompt: "Return a label",
        schema: existingLabelSchema,
    }).for("preSchemaObject", true);
    return {
        explicitWish,
        contextualWish,
        explicitObject,
        preSchemaObject,
    };
}
__cfHardenFn(TestWishAndGenerateObjectContextual);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
