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
// FIXTURE: literal-widen-bigint
// Verifies: bigint literals are widened to { type: "integer" } schema
//   cell(123n) → cell(123n, { type: "integer" })
//   cell(0n) → cell(0n, { type: "integer" })
//   cell(-456n) → cell(-456n, { type: "integer" })
export default function TestLiteralWidenBigInt() {
    const _bi1 = cell(123n, {
        type: "integer"
    } as const satisfies __cfHelpers.JSONSchema).for("_bi1", true);
    const _bi2 = cell(0n, {
        type: "integer"
    } as const satisfies __cfHelpers.JSONSchema).for("_bi2", true);
    const _bi3 = cell(-456n, {
        type: "integer"
    } as const satisfies __cfHelpers.JSONSchema).for("_bi3", true);
    return null;
}
__cfHardenFn(TestLiteralWidenBigInt);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
