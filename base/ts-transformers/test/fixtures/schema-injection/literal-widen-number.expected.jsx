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
// FIXTURE: literal-widen-number
// Verifies: numeric literals (int, negative, float, scientific, zero) are all widened to { type: "number" }
//   cell(10) → cell(10, { type: "number" })
//   cell(-5) → cell(-5, { type: "number" })
//   cell(3.14) → cell(3.14, { type: "number" })
//   cell(1e10) → cell(1e10, { type: "number" })
//   cell(0) → cell(0, { type: "number" })
export default function TestLiteralWidenNumber() {
    const _n1 = cell(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_n1", true);
    const _n2 = cell(-5, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_n2", true);
    const _n3 = cell(3.14, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_n3", true);
    const _n4 = cell(1e10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_n4", true);
    const _n5 = cell(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_n5", true);
    return null;
}
__cfHardenFn(TestLiteralWidenNumber);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
