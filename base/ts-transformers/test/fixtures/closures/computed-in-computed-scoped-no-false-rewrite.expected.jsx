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
const config = __cfHelpers.__cf_data({ bar: "module-level" });
const __cfLift_1 = __cfHelpers.lift(() => ({ bar: 1 }), false, undefined, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift(() => {
    const condition = 1 > 0;
    if (condition) {
        const config = __cfLift_1().for("config", true);
        return config.key("bar");
    }
    return config.bar;
}, false, undefined, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-in-computed-scoped-no-false-rewrite
// Verifies: a block-scoped computed() result named `config` does NOT cause
//   the module-level `config.bar` to be rewritten to `config.key("bar")`.
//   The inner `config.bar` (block-scoped Reactive) should be rewritten,
//   but the outer `config.bar` (plain object) must remain untouched.
// Context: The pre-scan collects opaque roots by name; it must not leak
//   across lexical scopes and incorrectly rewrite unrelated same-named accesses.
export default pattern(() => {
    const outer = __cfLift_2().for("outer", true);
    return outer;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: ["number", "string"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2
});
