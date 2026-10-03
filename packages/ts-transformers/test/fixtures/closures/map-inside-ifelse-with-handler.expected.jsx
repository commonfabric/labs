function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, handler, ifElse, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Item {
    id: number;
    name: string;
}
// Handler that closes over both items array and individual item
const removeItem = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "unknown",
                asCell: ["comparable"]
            },
            asCell: ["cell"]
        },
        item: {
            type: "unknown",
            asCell: ["comparable"]
        }
    },
    required: ["items", "item"]
} as const satisfies __cfHelpers.JSONSchema, (_event, { items, item }) => {
    const currentItems = items.get();
    const index = currentItems.findIndex((el) => el.equals(item));
    if (index >= 0) {
        items.set(currentItems.toSpliced(index, 1));
    }
});
const __cfPattern_hc7fc4f5f7121 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    const items = __cf_pattern_input.key("params", "items");
    return (<div>
                  <span>{item.key("name")}</span>
                  <button type="button" onClick={removeItem({ items, item })}>Remove</button>
                </div>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Item"
        },
        params: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Item"
                    }
                }
            },
            required: ["items"]
        }
    },
    required: ["element", "params"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
        }
    }
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
// FIXTURE: map-inside-ifelse-with-handler
// Verifies: .map() inside an ifElse branch is still transformed to mapWithPattern
//   .map(fn) → .mapWithPattern(pattern(...), {items: ...})
//   hasItems ternary → ifElse(...)
// Context: Map nested inside ifElse; handler references both the items array and iterator variable
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    const hasItems = __cf_pattern_input.key("hasItems");
    // CT-1035: Map inside ifElse branches should transform to mapWithPattern
    // The handler closure should work correctly with the map iterator variable
    return {
        [UI]: (<div>
          {ifElse({
                type: "boolean"
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
            } as const satisfies __cfHelpers.JSONSchema, {} as const satisfies __cfHelpers.JSONSchema, hasItems, <div>
              {items.mapWithPattern(__cfPattern_hc7fc4f5f7121, {
                    items: items
                })}
            </div>, <div>No items</div>)}
        </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        },
        hasItems: {
            type: "boolean"
        }
    },
    required: ["items", "hasItems"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
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
    removeItem,
    __cfPattern_hc7fc4f5f7121,
    __cfPattern_1: __cfPattern_hc7fc4f5f7121
});
