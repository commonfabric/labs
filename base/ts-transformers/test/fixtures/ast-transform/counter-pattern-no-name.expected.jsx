function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, Default, handler, NAME, pattern, str, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface CounterState {
    value: Cell<number>;
}
interface PatternState {
    value: Default<number, 0>;
}
const increment = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, (_e, state) => {
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
} as const satisfies __cfHelpers.JSONSchema, (_, state: {
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
// FIXTURE: counter-pattern-no-name
// Verifies: same transforms as counter-pattern apply even when the file has no unique name
//   handler<unknown, CounterState>(fn) → handler(true, stateSchema, fn)
//   handler((_, state: {...}) => ...)  → handler(false, stateSchema, fn)
//   pattern<PatternState>(fn)          → pattern(fn, inputSchema, outputSchema)
//   state.value ? a : b (in JSX)      → __cfHelpers.ifElse(...schemas, state.key("value"), lift(...)({...}), "unknown")
// Context: Identical to counter-pattern; verifies no-name patterns still transform correctly
export default pattern((state) => {
    return {
        [NAME]: str `Simple counter: ${state.key("value")}`,
        [UI]: (<div>
        <cf-button onClick={decrement(state)}>-</cf-button>
        <ul>
          <li>next number: {__cfHelpers.ifElse({
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["number", "string"]
        } as const satisfies __cfHelpers.JSONSchema, state.key("value"), __cfLift_1({ state: {
                value: state.key("value")
            } }), "unknown")}</li>
        </ul>
        <cf-button onClick={increment({ value: state.key("value") })}>+</cf-button>
      </div>),
        value: state.key("value"),
    };
}, {
    type: "object",
    properties: {
        value: {
            type: "number",
            "default": 0
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
    __cfLift_1
});
