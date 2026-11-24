function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { toSchema } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Config {
    sentinel: number;
    ratio: number;
    nan: number;
    inf: number;
    negInf: number;
    negZero: number;
    parenthesized: number;
}
const configSchema = __cfHelpers.__cf_data({
    type: "object",
    properties: {
        sentinel: {
            type: "number"
        },
        ratio: {
            type: "number"
        },
        nan: {
            type: "number"
        },
        inf: {
            type: "number"
        },
        negInf: {
            type: "number"
        },
        negZero: {
            type: "number"
        },
        parenthesized: {
            type: "number"
        }
    },
    required: ["sentinel", "ratio", "nan", "inf", "negInf", "negZero", "parenthesized"],
    "default": {
        sentinel: -1,
        ratio: -0.5,
        nan: NaN,
        inf: Infinity,
        negInf: -Infinity,
        negZero: -0,
        parenthesized: -1
    }
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: numeric-option-defaults
// Verifies: the toSchema options object carries signed and non-finite numbers
// through to the emitted schema. Recognizing only bare NumericLiteral drops
// each of these properties silently — a `-1` sentinel default just vanishes.
// (Wrappers across all option types: see `wrapped-options`.)
export { configSchema };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
