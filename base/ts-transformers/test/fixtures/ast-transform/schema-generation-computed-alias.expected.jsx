function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed as computedAlias } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
type AliasInput = {
    text: string;
};
type AliasResult = {
    length: number;
};
declare const state: AliasInput;
const __cfLift_1 = __cfHelpers.lift((): AliasResult => ({
    length: state.text.length,
}), false, undefined, { completeSchedulerScopeSummary: true });
// FIXTURE: schema-generation-computed-alias
// Verifies: a reactive builder imported under an alias still gets schema injection
//   computedAlias((): AliasResult => ...) → captures `state` and lowers to lift(inputSchema, outputSchema, ...)
// Context: Uses `import { computed as computedAlias }` to test aliased import tracking
export const textLength = __cfHelpers.__cf_data(__cfLift_1().for("textLength", true));
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
