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
declare const flag: boolean;
const __cfLift_1 = __cfHelpers.lift(() => {
    if (flag) {
        return "hello";
    }
    return 42;
}, false, undefined, { completeSchedulerScopeSummary: true });
// FIXTURE: schema-generation-computed-multiple-returns
// Verifies: a reactive builder with multiple return paths infers a union output schema
//   computed(() => { ... }) → output schema is an enum union of the returned literals
// Context: Callback has two return statements (string and number); output schema is an enum union
// Function with multiple return statements - should infer string | number
export const multiReturn = __cfHelpers.__cf_data(__cfLift_1().for("multiReturn", true));
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
