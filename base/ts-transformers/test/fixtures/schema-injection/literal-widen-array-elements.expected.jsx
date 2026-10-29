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
// FIXTURE: literal-widen-array-elements
// Verifies: array literals produce { type: "array", items: { type: T } } with widened element types
//   cell([1, 2, 3]) → cell([...], { type: "array", items: { type: "number" } })
//   cell(["a", "b"]) → cell([...], { type: "array", items: { type: "string" } })
//   cell([true, false]) → cell([...], { type: "array", items: { type: "boolean" } })
export default function TestLiteralWidenArrayElements() {
    const _arr1 = cell([1, 2, 3], {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("_arr1", true);
    const _arr2 = cell(["a", "b", "c"], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("_arr2", true);
    const _arr3 = cell([true, false], {
        type: "array",
        items: {
            type: "boolean"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("_arr3", true);
    return null;
}
__cfHardenFn(TestLiteralWidenArrayElements);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
