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
const identity = __cfHardenFn(<T,>(value: T) => value);
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        done: boolean;
    };
}, "Done" | "Pending">(({ state }) => identity(state.done ? "Done" : "Pending"), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                done: {
                    type: "boolean"
                }
            },
            required: ["done"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    "enum": ["Done", "Pending"]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: pattern-call-arg-conditional
// Verifies: top-level ordinary helper calls with reactive arguments are lifted
//   as whole calls rather than lowering only the inner argument expression.
//   const label = identity(state.done ? "Done" : "Pending")
//   → const label = lift(({ state }) => identity(state.done ? "Done" : "Pending"))({ state })
export default pattern((state) => {
    const label = __cfLift_1({ state: {
            done: state.key("done")
        } }).for("label", true);
    return { label };
}, {
    type: "object",
    properties: {
        done: {
            type: "boolean"
        }
    },
    required: ["done"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
