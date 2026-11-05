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
    threshold: __cfHelpers.ReadonlyCell<number>;
    a: __cfHelpers.ReadonlyCell<number>;
    b: __cfHelpers.ReadonlyCell<number>;
}, number>(({ value, threshold, a, b }) => value.get() > threshold.get() ? a.get() : b.get(), {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: ["readonly"]
        },
        threshold: {
            type: "number",
            asCell: ["readonly"]
        },
        a: {
            type: "number",
            asCell: ["readonly"]
        },
        b: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["value", "threshold", "a", "b"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-conditional-expression
// Verifies: computed(() => expr) with four cell captures in a ternary expression
//   computed(() => value.get() > threshold.get() ? a.get() : b.get()) → lift(({ value, threshold, a, b }) => ...)({ value, threshold, a, b })
//   All four cells are captured with asCell: true in the schema.
export default pattern(() => {
    const value = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    const threshold = new Writable(5, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("threshold", true);
    const a = new Writable(100, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("a", true);
    const b = new Writable(200, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("b", true);
    const result = __cfLift_1({
        value: value,
        threshold: threshold,
        a: a,
        b: b
    }).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
