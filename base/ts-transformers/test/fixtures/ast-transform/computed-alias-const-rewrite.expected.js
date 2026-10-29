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
// FIXTURE: computed-alias-const-rewrite
// Verifies: stable const aliases to `computed()` still lower to `derive()`.
const alias = computed;
const __cfLift_1 = __cfHelpers.lift(() => 1, false, undefined, { completeSchedulerScopeSummary: true });
export default __cfLift_1();
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
