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
    multiplier: number;
}, number>(({ value, multiplier }) => value.get() * multiplier, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: ["readonly"]
        },
        multiplier: {
            type: "number"
        }
    },
    required: ["value", "multiplier"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-pattern-typed
// Verifies: computed() inside a typed pattern with destructured params is closure-extracted
//   computed(() => value.get() * multiplier) → lift(({ value, multiplier }) => value.get() * multiplier)({ value, multiplier })
// Context: The pattern uses generic type params <{ multiplier: number }, number>.
//   Destructured `multiplier` is captured with asOpaque: true (it is a Reactive
//   from the pattern input), while `value` is captured with asCell: true.
export default pattern((__cf_pattern_input) => {
    const multiplier = __cf_pattern_input.key("multiplier");
    const value = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    const result = __cfLift_1({
        value: value,
        multiplier: multiplier
    }).for("result", true);
    return result;
}, {
    type: "object",
    properties: {
        multiplier: {
            type: "number"
        }
    },
    required: ["multiplier"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
