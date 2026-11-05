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
// FIXTURE: schema-generation-lift
// Verifies: lift() with generic type args generates input and output schemas
//   lift<LiftArgs, LiftResult>(fn) → lift(inputSchema, outputSchema, fn)
export const doubleValue = lift(({ value }) => ({
    doubled: value * 2,
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
