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
    counter: __cfHelpers.ReadonlyCell<{ count: number; }>;
}, number>(({ counter }) => {
    const current = counter.get();
    return current.count * 2;
}, {
    type: "object",
    properties: {
        counter: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"],
            asCell: ["readonly"]
        }
    },
    required: ["counter"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-nested-property
// Verifies: computed() capturing a cell with an object value and accessing a nested property
//   computed(() => { const current = counter.get(); return current.count * 2 }) → lift(({ counter }) => { ... })({ counter })
//   The cell schema preserves the nested object shape { count: number } with asCell: true.
export default pattern(() => {
    const counter = new Writable({ count: 0 }, {
        type: "object",
        properties: {
            count: {
                type: "number"
            }
        },
        required: ["count"]
    } as const satisfies __cfHelpers.JSONSchema).for("counter", true);
    const doubled = __cfLift_1({ counter: counter }).for("doubled", true);
    return doubled;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
