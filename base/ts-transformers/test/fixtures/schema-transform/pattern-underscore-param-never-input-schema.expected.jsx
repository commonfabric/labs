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
// FIXTURE: pattern-underscore-param-never-input-schema
// Verifies: underscore-prefixed authored pattern params still emit the `false`
// / never input schema while preserving the result schema.
export default pattern((_state: {
    name: string;
    count: number;
}) => {
    return { ok: true as const };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        ok: {
            type: "boolean",
            "enum": [true]
        }
    },
    required: ["ok"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
