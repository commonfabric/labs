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
type PizzaEntry = [
    date: string,
    pizza: string
];
interface State {
    pizzas: PizzaEntry[];
    scale: number;
}
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const date = __cf_pattern_input.key("element", "0");
    const pizza = __cf_pattern_input.key("element", "1");
    return (<div>
            {date}: {pizza}
          </div>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/PizzaEntry"
        }
    },
    required: ["element"],
    $defs: {
        PizzaEntry: {
            type: "array",
            items: {
                type: "string"
            }
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
const __cfPattern_2 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { state }) => {
    const date = __cf_pattern_input.key("element", "0");
    const pizza = __cf_pattern_input.key("element", "1");
    return (<div>
            {date}: {pizza} (scale: {state.scale})
          </div>);
}, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                scale: {
                    type: "number"
                }
            },
            required: ["scale"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema), {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/PizzaEntry"
        }
    },
    required: ["element"],
    $defs: {
        PizzaEntry: {
            type: "array",
            items: {
                type: "string"
            }
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
// FIXTURE: map-array-destructured
// Verifies: array destructuring in .map() is lowered, with and without captured outer state
//   .map(([date, pizza]) => ...) → .mapWithPattern(pattern(...)) with index-based keys
//   Closing over state.scale → captures { state: { scale: state.key("scale") } }
// Context: Two map calls — one without captures (empty {}), one with a captured outer variable
export default pattern((state) => {
    return {
        [UI]: (<div>
        {/* Map with array destructured parameter */}
        {state.key("pizzas").mapWithPattern(__cfPattern_1)}

        {/* Map with array destructured parameter and capture */}
        {state.key("pizzas").mapWithPattern(__cfPattern_2.curry({
                state: {
                    scale: state.key("scale")
                }
            }))}
      </div>),
    };
}, {
    type: "object",
    properties: {
        pizzas: {
            type: "array",
            items: {
                $ref: "#/$defs/PizzaEntry"
            }
        },
        scale: {
            type: "number"
        }
    },
    required: ["pizzas", "scale"],
    $defs: {
        PizzaEntry: {
            type: "array",
            items: {
                type: "string"
            }
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
    __cfPattern_1,
    __cfPattern_2
});
