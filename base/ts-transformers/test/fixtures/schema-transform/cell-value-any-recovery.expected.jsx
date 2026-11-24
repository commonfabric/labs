function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
declare function fetchAny(): any;
// FIXTURE: cell-value-any-recovery
// Verifies: direct `any` cell values emit a permissive `true` schema.
export const value = __cfHelpers.__cf_data(cell(fetchAny(), true as const satisfies __cfHelpers.JSONSchema).for("value", true));
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
