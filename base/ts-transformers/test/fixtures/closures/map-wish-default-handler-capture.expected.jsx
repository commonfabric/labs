function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Default, handler, NAME, pattern, UI, wish, Writable, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
type Item = {
    name: string;
    value: number;
};
const removeItem = handler({
    type: "object",
    properties: {},
    additionalProperties: false
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            "default": [],
            asCell: ["writeonly"]
        },
        item: {
            $ref: "#/$defs/Item"
        }
    },
    required: ["items", "item"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                value: {
                    type: "number"
                }
            },
            required: ["name", "value"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (_, { items, item }) => {
    items.remove(item);
});
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { items }) => {
    const item = __cf_pattern_input.key("element");
    return (<li>
            {item.key("name")}
            <button type="button" onClick={removeItem({ items, item })}>
              Remove
            </button>
          </li>);
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            "default": []
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                value: {
                    type: "number"
                }
            },
            required: ["name", "value"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema), {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Item"
        }
    },
    required: ["element"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                value: {
                    type: "number"
                }
            },
            required: ["name", "value"]
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
// FIXTURE: map-wish-default-handler-capture
// Verifies: wish<Default<Array<T>, []>>().result maps still lower to mapWithPattern with handler captures
//   wish<Default<Item[], []>>(...).result!.map(fn) -> mapWithPattern(pattern(...).curry({ items: items }))
//   removeItem({ items, item })                    -> captures both the reactive array and the current element
// Context: The array comes from wish().result rather than a pattern param or a local cell
export default pattern((_) => {
    const __cf_destructure_1 = wish<Default<Item[], [
    ]>>({ query: "#items" }, {
        type: "array",
        items: {
            $ref: "#/$defs/Item"
        },
        "default": [],
        $defs: {
            Item: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    value: {
                        type: "number"
                    }
                },
                required: ["name", "value"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema), items = __cf_destructure_1.key("result").for("items", true);
    return {
        [NAME]: "Test",
        [UI]: (<ul>
        {items.mapWithPattern(__cfPattern_1.curry({
                items: items
            }))}
      </ul>),
    };
}, {
    type: "object",
    properties: {},
    additionalProperties: false
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$NAME", "$UI"],
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
    __cfPattern_1
});
