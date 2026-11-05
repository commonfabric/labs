function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { lift, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: cfreg-export-forms
// Verifies which top-level builder artifacts are routed through `__cfReg`:
// - a NON-exported top-level builder const IS registered (by its binding name);
// - artifacts that leave via ANY export form are NOT (they are addressable
//   through the module namespace by their export name): inline `export const`,
//   a separate `export { ... }`, and a default export.
// The trailing `__cfReg({ ... })` should therefore contain only `internalHelper`
// and the synthetic `__cfPattern_1` (the `.map` op) — never `exportedLift`,
// `reexportedLift`, or the default pattern.
const internalHelper = lift((x: number) => x + 1, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
export const exportedLift = lift((x: number) => x * 2, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const reexportedLift = lift((x: number) => x - 1, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
export { reexportedLift };
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const x = __cf_pattern_input.key("element");
    return internalHelper(x).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        element: {
            type: "number"
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    return ({
        vs: items.mapWithPattern(__cfPattern_1).for(["__patternResult", "vs"], true)
    });
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "number"
            }
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        vs: {
            type: "array",
            items: {
                type: "number"
            }
        }
    },
    required: ["vs"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    internalHelper,
    __cfPattern_1
});
