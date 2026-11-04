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
// FIXTURE: literal-widen-string
// Verifies: string literals (normal, empty, multiline, with spaces) are all widened to { type: "string" }
//   cell("hello") → cell("hello", { type: "string" })
//   cell("") → cell("", { type: "string" })
//   cell("hello\nworld") → cell("hello\nworld", { type: "string" })
export default function TestLiteralWidenString() {
    const _s1 = cell("hello", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("_s1", true);
    const _s2 = cell("", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("_s2", true);
    const _s3 = cell("hello\nworld", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("_s3", true);
    const _s4 = cell("with spaces", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("_s4", true);
    return null;
}
__cfHardenFn(TestLiteralWidenString);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
