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
        value: number;
    }>;
    multiplier: number;
}
const __cfHandler_1 = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            value: {
                                type: "number"
                            }
                        },
                        required: ["value"]
                    }
                },
                multiplier: {
                    type: "number"
                }
            },
            required: ["items", "multiplier"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, (__cf_handler_event, { state }) => {
    const scaled = state.items.map((item) => item.value * state.multiplier);
    console.log(scaled);
});
// FIXTURE: handler-nested-map
// Verifies: .map() inside a handler body is NOT transformed to .mapWithPattern()
//   onClick={() => { state.items.map(...) }) → handler(..., (_, { state }) => { state.items.map(...) })
// Context: .map() on a plain array inside a handler remains a normal JS .map(), not a reactive transform
export default pattern((state) => {
    return {
        [UI]: (<button type="button" onClick={__cfHandler_1({
            state: {
                items: state.key("items"),
                multiplier: state.key("multiplier")
            }
        })}>
        Compute
      </button>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    value: {
                        type: "number"
                    }
                },
                required: ["value"]
            }
        },
        multiplier: {
            type: "number"
        }
    },
    required: ["items", "multiplier"]
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
    __cfHandler_1
});
