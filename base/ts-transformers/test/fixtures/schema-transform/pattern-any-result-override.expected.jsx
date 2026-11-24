function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, pattern, UI, VNode, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// Simulates `any` leaking through a generic function (like generateObject)
declare function fetchAny(): any;
const __cfLift_1 = __cfHelpers.lift<{
    result: any;
    prompt: string;
}, any>(({ result, prompt }) => result?.title || prompt || "Untitled", {
    type: "object",
    properties: {
        result: true,
        prompt: {
            type: "string"
        }
    },
    required: ["result", "prompt"]
} as const satisfies __cfHelpers.JSONSchema, true as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: pattern-any-result-override
// Verifies: explicit Output type parameter overrides inferred `any` return type for schema generation
//   pattern<Input, string>() → output schema { type: "string" } instead of inferred any
//   pattern<Input, { [UI]: VNode }>() → output schema with $UI vnode $ref
// Context: simulates `any` leaking through generic functions; two named exports, no default
// Case 1: Explicit Output type overrides inferred `any` return
export const TypedFromAny = pattern((__cf_pattern_input) => {
    const prompt = __cf_pattern_input.key("prompt");
    const result = fetchAny();
    return __cfLift_1({
        result: result,
        prompt: prompt
    });
}, {
    type: "object",
    properties: {
        prompt: {
            type: "string"
        }
    },
    required: ["prompt"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// Case 2: { [UI]: VNode } Output type instead of { [UI]: any }
type Entry = {
    name: string;
};
export const TypedUIOutput = pattern((__cf_pattern_input) => {
    const name = __cf_pattern_input.key("name");
    return {
        [UI]: (<div>{name}</div>),
    };
}, {
    type: "object",
    properties: {
        name: {
            type: "string"
        }
    },
    required: ["name"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }
    },
    required: ["$UI"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
