function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { lift } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: schema-generation-lift-typed-param
// Verifies: lift() with a primitive typed parameter generates scalar input and output schemas
//   lift((value: number) => value * 2) → lift({ type: "number" }, { type: "number" }, fn)
// Context: Single primitive param; output type inferred from expression body
// Lift requires explicit type annotation for proper schema generation
export const doubleValue = lift((value: number) => value * 2, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
