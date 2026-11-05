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
declare function fetchUnknown(): unknown;
// FIXTURE: cell-value-unknown-recovery
// Verifies: direct `unknown` cell values emit an explicit `{ type: "unknown" }` schema.
export const value = __cfHelpers.__cf_data(cell(fetchUnknown(), {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema).for("value", true));
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
