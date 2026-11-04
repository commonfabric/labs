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
const existingSchema = __cfHelpers.__cf_data({ type: "number" } as const);
// FIXTURE: double-inject-already-has-schema
// Verifies: cell() calls that already have a schema argument are NOT double-injected
//   cell(10, existingSchema) → cell(10, existingSchema)  (unchanged)
//   cell("hello", { type: "string" }) → cell("hello", { type: "string" })  (unchanged)
// Context: negative test -- transformer must skip calls that already have two arguments
export default function TestDoubleInjectAlreadyHasSchema() {
    // Should NOT transform - already has 2 arguments
    const _c1 = cell(10, existingSchema).for("_c1", true);
    const _c2 = cell("hello", { type: "string" }).for("_c2", true);
    const _c3 = cell(true, { type: "boolean" } as const).for("_c3", true);
    return null;
}
__cfHardenFn(TestDoubleInjectAlreadyHasSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
