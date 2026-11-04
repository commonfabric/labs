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
// FIXTURE: literal-widen-null-undefined
// Verifies: null and undefined literals produce their respective type schemas
//   cell(null) → cell(null, { type: "null" })
//   cell(undefined) → cell(undefined, { type: "undefined" })
export default function TestLiteralWidenNullUndefined() {
    const _c1 = cell(null, {
        type: "null"
    } as const satisfies __cfHelpers.JSONSchema).for("_c1", true);
    const _c2 = cell(undefined, {
        type: "undefined"
    } as const satisfies __cfHelpers.JSONSchema).for("_c2", true);
    return null;
}
__cfHardenFn(TestLiteralWidenNullUndefined);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
