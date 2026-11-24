function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, handler, NAME, pattern, str, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface PatternState {
    value: number;
}
const increment = handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, (_e, state: {
    value: Cell<number>;
}) => {
    state.value.set(state.value.get() + 1);
});
const decrement = handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, (_e, state: {
    value: Cell<number>;
}) => {
    state.value.set(state.value.get() - 1);
});
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        value: number;
    };
}, number>(({ state }) => state.value + 1, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    state: {
        value: number;
    };
}, number>(({ state }) => state.value - 1, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    state: {
        value: number;
    };
}, number>(({ state }) => state.value * 2, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_4 = __cfHelpers.lift<{
    state: {
        value: number;
    };
}, boolean>(({ state }) => state.value > 10, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: pattern-statements-vs-jsx
// Verifies: only JSX-context expressions are transformed; statement-context expressions are left alone
//   const next = state.value + 1    → NOT transformed (statement context)
//   <p>{state.value + 1}</p>        → lift(({state}) => state.value + 1)({ value }) (JSX context)
//   state.value > 10 ? "High":"Low" → ifElse(lift(...)(...), "High", "Low") (JSX context)
// Context: Ensures the transformer distinguishes between statement and JSX expression contexts
export default pattern((state) => {
    return {
        // This template literal SHOULD be transformed (builder function context)
        [NAME]: str `Simple counter: ${state.key("value")}`,
        [UI]: (<div>
        <cf-button onClick={decrement(state)}>-</cf-button>
        <p>
          {/* These SHOULD be transformed (JSX expression context) */}
          Current: {state.key("value")}
          <br />
          Next number: {__cfLift_1({ state: {
                value: state.key("value")
            } })}
          <br />
          Previous: {__cfLift_2({ state: {
                value: state.key("value")
            } })}
          <br />
          Doubled: {__cfLift_3({ state: {
                value: state.key("value")
            } })}
          <br />
          Status: {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["High", "Low"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_4({ state: {
                value: state.key("value")
            } }), "High", "Low")}
        </p>
        <cf-button onClick={increment({ value: state.key("value") })}>+</cf-button>
      </div>),
        // Direct property access - no transformation needed
        value: state.key("value"),
    };
}, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        value: {
            type: "number"
        }
    },
    required: ["$NAME", "$UI", "value"],
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
    increment,
    decrement,
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfLift_4
});
