function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
/// <cts-enable />
/**
 * A handler's event is not forwarded: what it hands to a pattern is charged as
 * any other callee is, and nothing in it compiles as opaque.
 */
import { handler, pattern, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface ChildInput {
    target: Writable<string>;
    label: string;
}
const Child = pattern((__cf_pattern_input) => {
    const label = __cf_pattern_input.key("label");
    return ({ label });
}, {
    type: "object",
    properties: {
        target: {
            type: "string",
            asCell: ["cell"]
        },
        label: {
            type: "string"
        }
    },
    required: ["target", "label"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __cfHelpers.JSONSchema);
export const addChild = handler({
    type: "object",
    properties: {
        target: {
            type: "string",
            asCell: ["readonly"]
        },
        label: {
            type: "string"
        }
    },
    required: ["target", "label"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        made: {
            type: "array",
            items: {
                type: "unknown"
            },
            asCell: ["writeonly"]
        }
    },
    required: ["made"]
} as const satisfies __cfHelpers.JSONSchema, ({ target, label }, { made }) => {
    made.push(Child({ target, label }));
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    Child
});
