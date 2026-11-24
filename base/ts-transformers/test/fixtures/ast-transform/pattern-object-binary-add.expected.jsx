function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        count: number;
    };
}, number>(({ state }) => state.count + 1, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: pattern-object-binary-add
// Verifies: top-level non-JSX arithmetic in an object property is lowered after
//   closure normalization into a direct lift-applied computation rather than left
//   as raw arithmetic over opaque values.
//   return { next: state.count + 1 }
//   → return { next: lift(({ state }) => state.count + 1)({ state }) }
export default pattern((state) => ({
    next: __cfLift_1({ state: {
            count: state.key("count")
        } }).for(["__patternResult", "next"], true)
}), {
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        next: {
            type: "number"
        }
    },
    required: ["next"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
