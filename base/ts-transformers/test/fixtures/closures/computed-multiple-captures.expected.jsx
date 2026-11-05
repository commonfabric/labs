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
    a: __cfHelpers.ReadonlyCell<number>;
    b: __cfHelpers.ReadonlyCell<number>;
    c: __cfHelpers.ReadonlyCell<number>;
}, number>(({ a, b, c }) => {
    const sum = a.get() + b.get();
    return sum * c.get();
}, {
    type: "object",
    properties: {
        a: {
            type: "number",
            asCell: ["readonly"]
        },
        b: {
            type: "number",
            asCell: ["readonly"]
        },
        c: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["a", "b", "c"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-multiple-captures
// Verifies: computed() with a multi-statement body capturing three cells is closure-extracted
//   computed(() => { const sum = a.get() + b.get(); return sum * c.get() }) → lift(({ a, b, c }) => { ... })({ a, b, c })
//   All three cells (a, b, c) are captured with asCell: true in the schema.
export default pattern(() => {
    const a = new Writable(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("a", true);
    const b = new Writable(20, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("b", true);
    const c = new Writable(30, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("c", true);
    const result = __cfLift_1({
        a: a,
        b: b,
        c: c
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
