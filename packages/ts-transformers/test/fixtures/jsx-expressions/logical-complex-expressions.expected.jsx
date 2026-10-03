function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_h284e66f4c6e0 = __cfHelpers.lift<{
    items: __cfHelpers.Cell<string[]>;
    isEnabled: __cfHelpers.Cell<boolean>;
}, Readonly<boolean>>(({ items, isEnabled }) => items.get().length > 0 && isEnabled.get(), {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "unknown"
            },
            asCell: ["readonly"]
        },
        isEnabled: {
            type: "boolean",
            asCell: ["readonly"]
        }
    },
    required: ["items", "isEnabled"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hcafc955c989d = __cfHelpers.lift<{
    count: __cfHelpers.Cell<number>;
    items: __cfHelpers.Cell<string[]>;
}, boolean>(({ count, items }) => (count.get() > 10 || items.get().length > 5), {
    type: "object",
    properties: {
        count: {
            type: "number",
            asCell: ["readonly"]
        },
        items: {
            type: "array",
            items: {
                type: "unknown"
            },
            asCell: ["readonly"]
        }
    },
    required: ["count", "items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: logical-complex-expressions
// Verifies: nested && and mixed || && with JSX are transformed to when() with lift-applied predicates
//   a && b && <JSX>     → when(lift(...)({ a, b }), <JSX>)
//   (a || b) && <JSX>   → when(lift(...)({ a, b }), <JSX>)
export default pattern((_state) => {
    const items = cell<string[]>([], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("items", true);
    const isEnabled = cell(false, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema).for("isEnabled", true);
    const count = cell(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("count", true);
    return {
        [UI]: (<div>
        {/* Nested && - both conditions reference opaque refs */}
        {__cfHelpers.when({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{
                    type: "boolean"
                }, {}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_h284e66f4c6e0({
            items: items,
            isEnabled: isEnabled
        }), <div>Enabled with items</div>)}

        {/* Mixed || and && */}
        {__cfHelpers.when({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{
                    type: "boolean"
                }, {}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_hcafc955c989d({
            count: count,
            items: items
        }), <div>Threshold met</div>)}
      </div>),
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
                }]
        },
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_h284e66f4c6e0,
    __cfLift_hcafc955c989d,
    __cfLift_1: __cfLift_h284e66f4c6e0,
    __cfLift_2: __cfLift_hcafc955c989d
});
