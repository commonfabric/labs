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
const __cfLift_h66c4b91b886a = __cfHelpers.lift<{
    list: __cfHelpers.Cell<string[]>;
}, boolean>(({ list }) => list.get().length > 0, {
    type: "object",
    properties: {
        list: {
            type: "array",
            items: {
                type: "unknown"
            },
            asCell: ["readonly"]
        }
    },
    required: ["list"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_hd2753091aa55 = __cfHelpers.pattern(__cf_pattern_input => {
    const name = __cf_pattern_input.key("element");
    return (<span>{name}</span>);
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }, {
            $ref: "#/$defs/UIRenderable"
        }, {
            type: "object",
            properties: {}
        }],
    $defs: {
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
// FIXTURE: map-array-length-conditional
// Verifies: length-guard && map pattern is transformed to when() wrapping mapWithPattern()
//   list.get().length > 0 && (<div>{list.map(...)}</div>) → when(lift(...)(...length), <div>{list.mapWithPattern(...)}</div>)
export default pattern((_state) => {
    const list = cell(["apple", "banana", "cherry"], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("list", true);
    return {
        [UI]: (<div>
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
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_h66c4b91b886a({ list: list }), <div>
            {list.mapWithPattern(__cfPattern_hd2753091aa55, {})}
          </div>)}
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
    __cfLift_h66c4b91b886a,
    __cfPattern_hd2753091aa55,
    __cfLift_1: __cfLift_h66c4b91b886a,
    __cfPattern_1: __cfPattern_hd2753091aa55
});
