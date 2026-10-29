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
// FIXTURE: computed-reassigned-alias-no-rewrite
// Verifies: mutable aliases to `computed()` are not treated as stable builder aliases.
// Context: the alias lives in a function, where `let` is ordinary code; module scope allows only `const`
export default function run() {
    let alias = computed;
    alias = ((fn: () => number) => fn()) as typeof alias;
    return alias(() => 1);
}
__cfHardenFn(run);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
