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
type DeriveInput = {
    count: number;
};
type DeriveResult = {
    doubled: number;
};
declare const source: DeriveInput;
const __cfLift_1 = __cfHelpers.lift((): DeriveResult => ({
    doubled: source.count * 2,
}), false, undefined, { completeSchedulerScopeSummary: true });
// FIXTURE: schema-generation-computed
// Verifies: computed() closure-extracts a captured value into a lift() with input
// (capture) and output schemas generated from type info
//   computed(() => ({ doubled: source.count * 2 })) → lift(captureSchema, outputSchema, { source }, fn)
export const doubledValue = __cfHelpers.__cf_data(__cfLift_1().for("doubledValue", true));
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
