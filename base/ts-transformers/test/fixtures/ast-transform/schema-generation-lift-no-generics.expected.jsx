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
type LiftArgs = {
    value: number;
};
type LiftResult = {
    doubled: number;
};
// FIXTURE: schema-generation-lift-no-generics
// Verifies: lift() with no generic type args infers schemas from inline param and return type
//   lift((args: LiftArgs): LiftResult => ...) → lift(inputSchema, outputSchema, fn)
// Context: Types come from function parameter and return type annotations, not generic args
export const doubleValue = lift((args: LiftArgs): LiftResult => ({
    doubled: args.value * 2,
}), {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        doubled: {
            type: "number"
        }
    },
    required: ["doubled"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
