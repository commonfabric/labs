function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
// FIXTURE: factory-live-modifier-routing
// Verifies: directly derived live factories remain callable factory values.
// Expected: asScope()/inSpace() chains stay direct and are never wrapped in
//   __cf_data as plain module-scope values.
import { lift, pattern } from "commonfabric";
import "commonfabric/schema";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const basePattern = pattern((__cf_pattern_input) => {
    const value = __cf_pattern_input.key("value");
    return ({ result: value });
}, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        result: {
            type: "number"
        }
    },
    required: ["result"]
} as const satisfies __cfHelpers.JSONSchema);
const baseModule = lift((input: {
    value: number;
}) => ({
    result: input.value,
}), {
    type: "object",
    properties: { value: { type: "number" } },
    required: ["value"],
}, {
    type: "object",
    properties: { result: { type: "number" } },
    required: ["result"],
});
export const scopedModule = baseModule.asScope("session");
export default basePattern.asScope("space").inSpace();
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    basePattern,
    baseModule
});
