function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    items: Array<{
        price: number;
    }>;
    discount: number;
}
const __cfLift_1 = __cfHelpers.lift<{
    item: {
        price: number;
    };
    state: {
        discount: number;
    };
}, number>(({ item, state }) => item.price * state.discount, {
    type: "object",
    properties: {
        item: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                }
            },
            required: ["price"]
        },
        state: {
            type: "object",
            properties: {
                discount: {
                    type: "number"
                }
            },
            required: ["discount"]
        }
    },
    required: ["item", "state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { state }) => {
    const item = __cf_pattern_input.key("element");
    return (<span>{__cfLift_1({
        item: {
            price: item.key("price")
        },
        state: {
            discount: state.discount
        }
    })}</span>);
}, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                discount: {
                    type: "number"
                }
            },
            required: ["discount"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema), {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                }
            },
            required: ["price"]
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
// FIXTURE: map-single-capture
// Verifies: .map() on reactive array captures a single outer state property
//   .map(fn) → .mapWithPattern(pattern(...).curry({state: {discount: ...}}))
//   item.price * state.discount → lift(...)(...) combining element and captured state
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__cfPattern_1.curry({
                state: {
                    discount: state.key("discount")
                }
            }))}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    price: {
                        type: "number"
                    }
                },
                required: ["price"]
            }
        },
        discount: {
            type: "number"
        }
    },
    required: ["items", "discount"]
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
    __cfLift_1,
    __cfPattern_1
});
