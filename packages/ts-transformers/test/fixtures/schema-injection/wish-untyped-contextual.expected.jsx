function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, wish } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: wish-untyped-contextual
// Verifies: an untyped wish() takes the schema of the T inferred for it, never of the WishState<T> it returns
//   { profile: wish({ query }) } in a pattern's result → T is unknown → { type: "unknown" }, as wish<unknown>() gets
//   const bare = wish({ query }) → no contextual type → no schema
export default pattern(() => {
    const bare = wish({ query: "#bare" }).for("bare", true);
    return {
        profile: wish({ query: "#profile" }, {
            type: "unknown"
        } as const satisfies __cfHelpers.JSONSchema).for(["__patternResult", "profile"], true),
        bare
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        profile: {
            type: "object",
            properties: {
                result: {
                    type: "unknown"
                },
                candidates: {
                    type: "array",
                    items: {
                        type: "unknown"
                    }
                },
                error: true,
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["result", "candidates"]
        },
        bare: {
            type: "object",
            properties: {
                result: {
                    type: "unknown"
                },
                candidates: {
                    type: "array",
                    items: {
                        type: "unknown"
                    }
                },
                error: true,
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["result", "candidates"]
        }
    },
    required: ["profile", "bare"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
