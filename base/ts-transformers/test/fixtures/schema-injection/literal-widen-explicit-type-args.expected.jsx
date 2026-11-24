function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: literal-widen-explicit-type-args
// Verifies: new Cell with explicit type arguments injects schema matching the type arg
//   new Cell<number>(10) → new Cell<number>(10, { type: "number" })
//   new Cell<string>("hello") → new Cell<string>("hello", { type: "string" })
//   new Cell<boolean>(true) → new Cell<boolean>(true, { type: "boolean" })
//   new Cell<boolean | null>(null)
//     → new Cell<boolean | null>(null, { anyOf: [{ type: "boolean" }, { type: "null" }] })
export default function TestLiteralWidenExplicitTypeArgs() {
    const _c1 = new Cell<number>(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_c1", true);
    const _c2 = new Cell<string>("hello", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("_c2", true);
    const _c3 = new Cell<boolean>(true, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema).for("_c3", true);
    const _c4 = new Cell<boolean | null>(null, {
        anyOf: [{
                type: "boolean"
            }, {
                type: "null"
            }]
    } as const satisfies __cfHelpers.JSONSchema).for("_c4", true);
    return null;
}
__cfHardenFn(TestLiteralWidenExplicitTypeArgs);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
