function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Input {
    flag: boolean | null;
}
interface Output {
    flag: boolean | null;
}
// FIXTURE: nullable-boolean
// Verifies: pattern input and output schemas retain null in boolean unions.
//   boolean | null → { anyOf: [{ type: "boolean" }, { type: "null" }] }
export default pattern((__cf_pattern_input) => {
    const flag = __cf_pattern_input.key("flag");
    return ({ flag });
}, {
    type: "object",
    properties: {
        flag: {
            anyOf: [{
                    type: "boolean"
                }, {
                    type: "null"
                }]
        }
    },
    required: ["flag"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        flag: {
            anyOf: [{
                    type: "boolean"
                }, {
                    type: "null"
                }]
        }
    },
    required: ["flag"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
