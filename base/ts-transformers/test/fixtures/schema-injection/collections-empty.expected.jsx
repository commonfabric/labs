function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Writable, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: collections-empty
// Verifies: empty arrays and objects produce valid degenerate schemas
//   cell([]) → cell([], { type: "array", items: false })
//   cell({}) → cell({}, { type: "object", properties: {} })
export default pattern(() => {
    // Empty array
    const _emptyArray = new Writable<string[]>([], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("_emptyArray", true);
    // Empty object
    const _emptyObject = new Writable({}, {
        type: "object",
        properties: {}
    } as const satisfies __cfHelpers.JSONSchema).for("_emptyObject", true);
    return {
        emptyArray: _emptyArray.for(["__patternResult", "emptyArray"], true),
        emptyObject: _emptyObject.for(["__patternResult", "emptyObject"], true)
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        emptyArray: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["cell"]
        },
        emptyObject: {
            type: "object",
            properties: {},
            asCell: ["cell"]
        }
    },
    required: ["emptyArray", "emptyObject"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
