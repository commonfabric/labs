function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, cell, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    values: number[];
    multiplier: number;
}
const __cfLift_1 = __cfHelpers.lift<{
    value: number;
    state: {
        multiplier: number;
    };
}, number>(({ value, state }) => value * state.multiplier, {
    type: "object",
    properties: {
        value: {
            type: "number"
        },
        state: {
            type: "object",
            properties: {
                multiplier: {
                    type: "number"
                }
            },
            required: ["multiplier"]
        }
    },
    required: ["value", "state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { state }) => {
    const value = __cf_pattern_input.key("element");
    return (<span>{__cfLift_1({
        value: value,
        state: {
            multiplier: state.multiplier
        }
    })}</span>);
}, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                multiplier: {
                    type: "number"
                }
            },
            required: ["multiplier"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema), {
    type: "object",
    properties: {
        element: {
            type: "number"
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
// FIXTURE: cell-map-with-captures
// Verifies: Cell.map() with outer-scope captures is transformed to mapWithPattern with params
//   typedValues.map((value) => <span>{value * state.multiplier}</span>)
//     → typedValues.mapWithPattern(pattern(...).curry({ state: { multiplier: state.key("multiplier") } }))
//   value * state.multiplier → lift(...)({ value, state: { multiplier } })
// Context: The map callback captures `state.multiplier` from the outer scope,
//   which must be threaded through as a mapWithPattern param and re-derived inside.
export default pattern((state) => {
    // Explicitly type as Cell to ensure closure transformation
    const typedValues: Cell<number[]> = cell(state.key("values"), {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("typedValues", true);
    return {
        [UI]: (<div>
        {typedValues.mapWithPattern(__cfPattern_1.curry({
                state: {
                    multiplier: state.key("multiplier")
                }
            }))}
      </div>),
    };
}, {
    type: "object",
    properties: {
        values: {
            type: "array",
            items: {
                type: "number"
            }
        },
        multiplier: {
            type: "number"
        }
    },
    required: ["values", "multiplier"]
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
