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
    __cf_reserved: __cfHelpers.ReadonlyCell<number>;
}, number>(({ value, __cf_reserved }) => value.get() * __cf_reserved.get(), {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: ["readonly"]
        },
        __cf_reserved: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["value", "__cf_reserved"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-reserved-names
// Verifies: variables with __cf_ prefixed names are captured without special treatment
//   computed(() => value.get() * __cf_reserved.get()) → lift(...)({ value, __cf_reserved })
export default pattern(() => {
    const value = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("value", true);
    // A __cf_-prefixed variable name should be captured like any other
    const __cf_reserved = new Writable(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const result = __cfLift_1({
        value: value,
        __cf_reserved: __cf_reserved
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
