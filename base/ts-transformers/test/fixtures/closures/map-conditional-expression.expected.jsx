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
    id: number;
    price: number;
}
interface State {
    items: Item[];
    discount: number;
    threshold: number;
}
const __cfLift_1 = __cfHelpers.lift<{
    item: {
        price: number;
    };
    state: {
        threshold: number;
    };
}, boolean>(({ item, state }) => item.price > state.threshold, {
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
                threshold: {
                    type: "number"
                }
            },
            required: ["threshold"]
        }
    },
    required: ["item", "state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    item: {
        price: number;
    };
    state: {
        discount: number;
    };
}, number>(({ item, state }) => item.price * (1 - state.discount), {
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
    return (<div>
            Price: ${__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, __cfLift_1({
        item: {
            price: item.key("price")
        },
        state: {
            threshold: state.threshold
        }
    }), __cfLift_2({
        item: {
            price: item.key("price")
        },
        state: {
            discount: state.discount
        }
    }), item.key("price"))}
          </div>);
}, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                threshold: {
                    type: "number"
                },
                discount: {
                    type: "number"
                }
            },
            required: ["threshold", "discount"]
        }
    },
    required: ["state"]
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
                id: {
                    type: "number"
                },
                price: {
                    type: "number"
                }
            },
            required: ["id", "price"]
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
// FIXTURE: map-conditional-expression
// Verifies: ternary expression in .map() callback is transformed to ifElse() with lift-applied branches
//   item.price > state.threshold ? ... : ... → ifElse(lift(...)(condition), lift(...)(trueBranch), falseBranch)
//   .map(fn) → .mapWithPattern(pattern(...).curry({ state: { threshold, discount } }))
// Context: Captures state.threshold (for condition) and state.discount (for true branch) from outer scope
export default pattern((state) => {
    return {
        [UI]: (<div>
        {/* Ternary with captures in map callback */}
        {state.key("items").mapWithPattern(__cfPattern_1.curry({
                state: {
                    threshold: state.key("threshold"),
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
                $ref: "#/$defs/Item"
            }
        },
        discount: {
            type: "number"
        },
        threshold: {
            type: "number"
        }
    },
    required: ["items", "discount", "threshold"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                price: {
                    type: "number"
                }
            },
            required: ["id", "price"]
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
    __cfLift_2,
    __cfPattern_1
});
