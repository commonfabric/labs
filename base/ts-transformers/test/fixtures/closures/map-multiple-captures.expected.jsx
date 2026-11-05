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
interface Item {
    price: number;
    quantity: number;
}
interface State {
    items: Item[];
    discount: number;
    taxRate: number;
}
const shippingCost = 5.99;
const __cfLift_1 = __cfHelpers.lift<{
    item: {
        price: number;
        quantity: number;
    };
    state: {
        discount: number;
        taxRate: number;
    };
    multiplier: number;
}, number>(({ item, state, multiplier }) => item.price * item.quantity * state.discount * state.taxRate * multiplier + shippingCost, {
    type: "object",
    properties: {
        item: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                },
                quantity: {
                    type: "number"
                }
            },
            required: ["price", "quantity"]
        },
        state: {
            type: "object",
            properties: {
                discount: {
                    type: "number"
                },
                taxRate: {
                    type: "number"
                }
            },
            required: ["discount", "taxRate"]
        },
        multiplier: {
            type: "number"
        }
    },
    required: ["item", "state", "multiplier"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { state, multiplier }) => {
    const item = __cf_pattern_input.key("element");
    return (<span>
            Total: {__cfLift_1({
        item: {
            price: item.key("price"),
            quantity: item.key("quantity")
        },
        state: {
            discount: state.discount,
            taxRate: state.taxRate
        },
        multiplier: multiplier
    })}
          </span>);
}, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                discount: {
                    type: "number"
                },
                taxRate: {
                    type: "number"
                }
            },
            required: ["discount", "taxRate"]
        },
        multiplier: {
            type: "number"
        }
    },
    required: ["state", "multiplier"]
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
                price: {
                    type: "number"
                },
                quantity: {
                    type: "number"
                }
            },
            required: ["price", "quantity"]
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
// FIXTURE: map-multiple-captures
// Verifies: .map() on reactive array captures multiple outer variables (state + local)
//   .map(fn) → .mapWithPattern(pattern(...).curry({state: {discount, taxRate}, multiplier}))
//   expression → lift(...)(...) combining item + state reactively with `multiplier`
//     wired in as an explicit input (not via lexical closure)
// Context: state.discount and state.taxRate are explicit lift-applied inputs;
//   `multiplier` (a plain-JS value declared in the enclosing pattern callback)
//   is also wired in as an explicit lift-applied input so the callback stays
//   self-contained; module-level `shippingCost` is left lexical (module-scope
//   bindings are stable across hoist boundaries).
export default pattern((state) => {
    const multiplier = 2;
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__cfPattern_1.curry({
                state: {
                    discount: state.key("discount"),
                    taxRate: state.key("taxRate")
                },
                multiplier: multiplier
            }))}
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
        discount: {
            type: "number"
        },
        taxRate: {
            type: "number"
        }
    },
    required: ["items", "discount", "taxRate"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                },
                quantity: {
                    type: "number"
                }
            },
            required: ["price", "quantity"]
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
    __cfLift_1,
    __cfPattern_1
});
