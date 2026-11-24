function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
/**
 * computed() result property access in lift-applied captures should use
 * .key("length"). The computed() return is a Reactive, so
 * rewritePatternBody correctly rewrites summary.length to
 * summary.key("length").
 */
import { computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    items: string[];
}
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        items: string[];
    };
}, string>(({ state }) => state.items.join(", "), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["items"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    summary: {
        length: number;
    };
}, number>(({ summary }) => summary.length, {
    type: "object",
    properties: {
        summary: {
            type: "object",
            properties: {
                length: {
                    type: "number"
                }
            },
            required: ["length"]
        }
    },
    required: ["summary"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-result-property-in-return
// Verifies: .length on a computed() string result is captured via .key("length") in a subsequent lift-applied computation
//   computed(() => summary.length) → lift(({ summary }) => summary.length)({ summary: { length: summary.key("length") } })
// Context: The first computed() returns a string Reactive (from .join()).
//   When the second computed() accesses summary.length, the capture is rewritten
//   to summary.key("length") because summary is a Reactive, not a plain value.
export default pattern((state) => {
    const summary = __cfLift_1({ state: {
            items: state.key("items")
        } }).for("summary", true);
    return {
        summary,
        charCount: __cfLift_2({ summary: {
                length: summary.key("length")
            } }).for(["__patternResult", "charCount"], true)
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        summary: {
            type: "string"
        },
        charCount: {
            type: "number"
        }
    },
    required: ["summary", "charCount"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2
});
