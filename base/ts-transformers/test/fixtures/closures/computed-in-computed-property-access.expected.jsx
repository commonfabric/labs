function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift(() => ({ bar: 1 }), false, undefined, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift(() => {
    const foo = __cfLift_1().for("foo", true);
    return foo.key("bar");
}, false, undefined, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-in-computed-property-access
// Verifies: property access on a computed() result declared INSIDE another computed()
//   gets transformed to .key() access
//   foo.bar → foo.key("bar") where foo = computed(() => ({ bar: 1 }))
// Context: Local variables holding Reactive values (from compute/lift-applied calls)
//   inside a lift-applied callback need .key() rewriting even though they are not
//   captured from an outer scope.
export default pattern(() => {
    const outer = __cfLift_2().for("outer", true);
    return outer;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2
});
