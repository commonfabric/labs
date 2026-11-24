function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
declare const total: number;
const __cfLift_1 = __cfHelpers.lift(() => total * 2, false, undefined, { completeSchedulerScopeSummary: true });
// FIXTURE: schema-generation-computed-untyped
// Verifies: a reactive builder with no generic type args infers schemas from captured values
//   computed(() => total * 2) → captures `total` ({ type: "number" }) and infers output from the body
// Context: Input type comes from `declare const total: number`; output inferred from arrow body
export const doubled = __cfHelpers.__cf_data(__cfLift_1().for("doubled", true));
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
