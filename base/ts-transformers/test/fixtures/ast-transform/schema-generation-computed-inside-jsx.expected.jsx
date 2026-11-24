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
declare const value: number;
const __cfLift_1 = __cfHelpers.lift(() => value * 2, false, undefined, { completeSchedulerScopeSummary: true });
// FIXTURE: schema-generation-computed-inside-jsx
// Verifies: a reactive builder inside a JSX expression still gets schemas injected
//   computed(() => value * 2) → captures `value` and lowers to lift(inputSchema, outputSchema, ...)
// Context: computed() appears as a JSX child expression, not a standalone statement
export const result = (<div>
    {__cfLift_1()}
  </div>);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
