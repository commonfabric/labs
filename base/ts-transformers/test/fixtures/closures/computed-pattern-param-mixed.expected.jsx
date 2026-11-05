function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Writable, computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    value: __cfHelpers.ReadonlyCell<number>;
    config: {
        base: number;
        multiplier: number;
    };
    offset: number;
    threshold: __cfHelpers.ReadonlyCell<number>;
}, number>(({ value, config, offset, threshold }) => (value.get() + config.base + offset) * config.multiplier + threshold.get(), {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: ["readonly"]
        },
        config: {
            type: "object",
            properties: {
                base: {
                    type: "number"
                },
                multiplier: {
                    type: "number"
                }
            },
            required: ["base", "multiplier"]
        },
        offset: {
            type: "number"
        },
        threshold: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["value", "config", "offset", "threshold"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-pattern-param-mixed
// Verifies: computed() capturing a mix of cells, pattern params, and plain locals
//   computed(() => (value.get() + config.base + offset) * config.multiplier + threshold.get()) → lift(...)({ value, config: { base, multiplier }, offset, threshold })
// Context: Captures four different variable types: cell (value, threshold with
//   asCell), pattern param (config with .key() rewriting), and plain local
//   (offset as plain number). All coexist in a single capture object.
export default pattern((config: {
    base: number;
    multiplier: number;
}) => {
    const value = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    const offset = 5; // non-cell local
    const threshold = new Writable(15, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("threshold", true); // cell local
    const result = __cfLift_1({
        value: value,
        config: {
            base: config.key("base"),
            multiplier: config.key("multiplier")
        },
        offset: offset,
        threshold: threshold
    }).for("result", true);
    return result;
}, {
    type: "object",
    properties: {
        base: {
            type: "number"
        },
        multiplier: {
            type: "number"
        }
    },
    required: ["base", "multiplier"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
