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
    count: number;
    price: number;
    discount: number;
    quantity: number;
}
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        count: number;
    };
}, number>(({ state }) => state.count + 1, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    state: {
        count: number;
    };
}, number>(({ state }) => state.count - 1, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    state: {
        count: number;
    };
}, number>(({ state }) => state.count * 2, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_4 = __cfHelpers.lift<{
    state: {
        price: number;
    };
}, number>(({ state }) => state.price / 2, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                }
            },
            required: ["price"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_5 = __cfHelpers.lift<{
    state: {
        count: number;
    };
}, number>(({ state }) => state.count % 3, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_6 = __cfHelpers.lift<{
    state: {
        price: number;
        discount: number;
    };
}, number>(({ state }) => state.price - (state.price * state.discount), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                },
                discount: {
                    type: "number"
                }
            },
            required: ["price", "discount"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_7 = __cfHelpers.lift<{
    state: {
        price: number;
        quantity: number;
    };
}, number>(({ state }) => state.price * state.quantity, {
    type: "object",
    properties: {
        state: {
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
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_8 = __cfHelpers.lift<{
    state: {
        price: number;
        quantity: number;
    };
}, number>(({ state }) => (state.price * state.quantity) * 1.08, {
    type: "object",
    properties: {
        state: {
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
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_9 = __cfHelpers.lift<{
    state: {
        count: number;
        quantity: number;
        price: number;
        discount: number;
    };
}, number>(({ state }) => (state.count + state.quantity) * state.price -
    (state.price * state.discount), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                },
                quantity: {
                    type: "number"
                },
                price: {
                    type: "number"
                },
                discount: {
                    type: "number"
                }
            },
            required: ["count", "quantity", "price", "discount"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_10 = __cfHelpers.lift<{
    state: {
        count: number;
    };
}, number>(({ state }) => state.count * state.count * state.count, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_11 = __cfHelpers.lift<{
    state: {
        price: number;
    };
}, number>(({ state }) => state.price - 10, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                }
            },
            required: ["price"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_12 = __cfHelpers.lift<{
    state: {
        price: number;
    };
}, number>(({ state }) => state.price + 10, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                }
            },
            required: ["price"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: jsx-arithmetic-operations
// Verifies: arithmetic expressions with reactive refs in JSX are wrapped in a lift-applied computation
//   {state.count + 1}                      → lift(({state}) => state.count + 1)({ count })
//   {state.price * state.quantity * 1.08}   → lift(...)({ price, quantity })
//   {state.count * state.count * state.count} → lift(...)({ count })
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Basic Arithmetic</h3>
        <p>Count + 1: {__cfLift_1({ state: {
                count: state.key("count")
            } })}</p>
        <p>Count - 1: {__cfLift_2({ state: {
                count: state.key("count")
            } })}</p>
        <p>Count * 2: {__cfLift_3({ state: {
                count: state.key("count")
            } })}</p>
        <p>Price / 2: {__cfLift_4({ state: {
                price: state.key("price")
            } })}</p>
        <p>Count % 3: {__cfLift_5({ state: {
                count: state.key("count")
            } })}</p>

        <h3>Complex Expressions</h3>
        <p>Discounted Price: {__cfLift_6({ state: {
                price: state.key("price"),
                discount: state.key("discount")
            } })}</p>
        <p>Total: {__cfLift_7({ state: {
                price: state.key("price"),
                quantity: state.key("quantity")
            } })}</p>
        <p>With Tax (8%): {__cfLift_8({ state: {
                price: state.key("price"),
                quantity: state.key("quantity")
            } })}</p>
        <p>
          Complex: {__cfLift_9({ state: {
                count: state.key("count"),
                quantity: state.key("quantity"),
                price: state.key("price"),
                discount: state.key("discount")
            } })}
        </p>

        <h3>Multiple Same Ref</h3>
        <p>Count³: {__cfLift_10({ state: {
                count: state.key("count")
            } })}</p>
        <p>Price Range: ${__cfLift_11({ state: {
                price: state.key("price")
            } })} - ${__cfLift_12({ state: {
                price: state.key("price")
            } })}</p>
      </div>),
    };
}, {
    type: "object",
    properties: {
        count: {
            type: "number"
        },
        price: {
            type: "number"
        },
        discount: {
            type: "number"
        },
        quantity: {
            type: "number"
        }
    },
    required: ["count", "price", "discount", "quantity"]
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
    __cfLift_3,
    __cfLift_4,
    __cfLift_5,
    __cfLift_6,
    __cfLift_7,
    __cfLift_8,
    __cfLift_9,
    __cfLift_10,
    __cfLift_11,
    __cfLift_12
});
