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
    value: number;
}
const configSchema = __cfHelpers.__cf_data({
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"],
    "default": {
        value: 42
    },
    description: "Configuration schema"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: with-options
// Verifies: toSchema options object (default, description) is merged into generated schema
//   toSchema<Config>({default: ..., description: ...}) → schema with "default" and "description" alongside generated properties
export { configSchema };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
