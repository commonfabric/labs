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
    checkout: {
        discount: number;
    };
    upsell: {
        discount: number;
    };
}
const __cfLift_1 = __cfHelpers.lift<{
    item: {
        price: number;
    };
    state: {
        checkout: {
            discount: number;
        };
        upsell: {
            discount: number;
        };
    };
}, number>(({ item, state }) => item.price * state.checkout.discount * state.upsell.discount, {
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
                checkout: {
                    type: "object",
                    properties: {
                        discount: {
                            type: "number"
                        }
                    },
                    required: ["discount"]
                },
                upsell: {
                    type: "object",
                    properties: {
                        discount: {
                            type: "number"
                        }
                    },
                    required: ["discount"]
                }
            },
            required: ["checkout", "upsell"]
        }
    },
    required: ["item", "state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { state }) => {
    const item = __cf_pattern_input.key("element");
    return (<span>
            {__cfLift_1({
        item: {
            price: item.key("price")
        },
        state: {
            checkout: {
                discount: state.checkout.discount
            },
            upsell: {
                discount: state.upsell.discount
            }
        }
    })}
          </span>);
}, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                checkout: {
                    type: "object",
                    properties: {
                        discount: {
                            type: "number"
                        }
                    },
                    required: ["discount"]
                },
                upsell: {
                    type: "object",
                    properties: {
                        discount: {
                            type: "number"
                        }
                    },
                    required: ["discount"]
                }
            },
            required: ["checkout", "upsell"]
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
// FIXTURE: map-multiple-similar-captures
// Verifies: .map() correctly captures multiple state properties with the same leaf name
//   .map(fn) → .mapWithPattern(pattern(...).curry({state: {checkout: {discount}, upsell: {discount}}}))
//   expression → lift(...)(...) with both discount paths distinguished
// Context: state.checkout.discount and state.upsell.discount share the name "discount" but are separate captures
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__cfPattern_1.curry({
                state: {
                    checkout: {
                        discount: state.key("checkout", "discount")
                    },
                    upsell: {
                        discount: state.key("upsell", "discount")
                    }
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
        checkout: {
            type: "object",
            properties: {
                discount: {
                    type: "number"
                }
            },
            required: ["discount"]
        },
        upsell: {
            type: "object",
            properties: {
                discount: {
                    type: "number"
                }
            },
            required: ["discount"]
        }
    },
    required: ["items", "checkout", "upsell"]
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
