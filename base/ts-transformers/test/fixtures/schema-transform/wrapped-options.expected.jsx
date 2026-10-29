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
    count: number;
    label: string;
    offset: number;
}
const configSchema = __cfHelpers.__cf_data({
    type: "object",
    properties: {
        count: {
            type: "number"
        },
        label: {
            type: "string"
        },
        offset: {
            type: "number"
        }
    },
    required: ["count", "label", "offset"],
    description: "a description",
    "default": {
        count: 1,
        label: "text",
        offset: -1
    },
    examples: ["one", 2, 3]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: wrapped-options
// Verifies: a value wrapped in parentheses or a type-only assertion survives in
// the toSchema options object, whatever its type and however deeply the wrapper
// is nested. Each of these properties was silently dropped before -- including
// plainly non-numeric ones, which is why the unwrapping belongs in the options
// evaluator rather than in its numeric special case.
export { configSchema };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
