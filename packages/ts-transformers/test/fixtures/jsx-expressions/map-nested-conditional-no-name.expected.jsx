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
const __cfPattern_h72e9809a4df5 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return (<div>
                {__cfHelpers.when({
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{}, {
                type: "object",
                properties: {}
            }]
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "string"
            }, {}, {
                type: "object",
                properties: {}
            }]
    } as const satisfies __cfHelpers.JSONSchema, item.key("name"), <span>{item.key("name")}</span>)}
              </div>);
}, {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
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
// FIXTURE: map-nested-conditional-no-name
// Verifies: same nested conditional map transforms work when pattern param is typed as any
//   showList && <div>{items.map(...)}</div> → when(showList, <div>{items.mapWithPattern(...)}</div>)
// Context: Variant of map-nested-conditional with _state: any instead of named pattern
export default pattern((_state: any) => {
    const items = cell([{ name: "apple" }, { name: "banana" }], {
        type: "array",
        items: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    } as const satisfies __cfHelpers.JSONSchema).for("items", true);
    const showList = cell(true, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema).for("showList", true);
    return {
        [UI]: (<div>
        {__cfHelpers.when({
            type: "boolean",
            asCell: ["cell"]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, showList, <div>
            {items.mapWithPattern(__cfPattern_h72e9809a4df5, {})}
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
    __cfPattern_h72e9809a4df5,
    __cfPattern_1: __cfPattern_h72e9809a4df5
});
