function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Default, NAME, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface PatternState {
    value: Default<number, 0>;
}
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
}, number>(({ state }) => state.value + 2, {
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
// FIXTURE: ternary_computed
// Verifies: ternary with expressions on both sides produces ifElse() with a lift-applied computation for each branch
//   state.value + 1 ? state.value + 2 : "undefined" → ifElse(...schemas, lift(...)({...}), lift(...)({...}), "undefined")
//   pattern<PatternState>(fn)                        → pattern(fn, inputSchema, outputSchema)
// Context: Both condition and consequent contain state expressions that must be individually lift-applied
export default pattern((state) => {
    return {
        [NAME]: "test ternary with computed",
        [UI]: (<div>
        {__cfHelpers.ifElse({
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["number", "string"]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_1({ state: {
                value: state.key("value")
            } }), __cfLift_2({ state: {
                value: state.key("value")
            } }), "undefined")}
      </div>),
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
    __cfLift_1,
    __cfLift_2
});
