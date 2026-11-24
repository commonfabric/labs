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
const __cfLift_2 = __cfHelpers.lift<{
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
// FIXTURE: pattern-call-root-containers
// Verifies: top-level ordinary call roots whole-wrap consistently across
//   non-JSX container kinds instead of lowering only their nested conditional
//   arguments.
//   { value: identity(state.done ? "Done" : "Pending") }
//   → { value: lift(({ state }) => identity(state.done ? "Done" : "Pending"))({ state }) }
//   [identity(state.done ? "Done" : "Pending")]
//   → [lift(({ state }) => identity(state.done ? "Done" : "Pending"))({ state })]
//   return identity(state.done ? "Done" : "Pending")
//   → return lift(({ state }) => identity(state.done ? "Done" : "Pending"))({ state })
export const objectAndArray = pattern((state) => {
    const view = {
        value: __cfLift_1({ state: {
                done: state.key("done")
            } }).for(["view", "value"], true),
        list: [__cfLift_2({ state: {
                    done: state.key("done")
                } }).for(["view", "list", 0], true)]
    };
    return view;
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
        value: {
            type: "string"
        },
        list: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["value", "list"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
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
export default pattern((state) => __cfLift_3({ state: {
        done: state.key("done")
    } }).for("__patternResult", true), {
    type: "object",
    properties: {
        done: {
            type: "boolean"
        }
    },
    required: ["done"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3
});
