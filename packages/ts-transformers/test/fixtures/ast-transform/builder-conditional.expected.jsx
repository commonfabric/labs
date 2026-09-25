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
    count: Default<number, 0>;
    label: Default<string, "">;
}
const __cfLift_hbb9e3a8118a5 = __cfHelpers.lift<{
    state: {
        count: number;
    };
}, boolean>(({ state }) => state.count > 0, {
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
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: builder-conditional
// Verifies: ternary in JSX is transformed to ifElse() with a lift-applied condition
//   state.count > 0 ? <p>A</p> : <p>B</p> → __cfHelpers.ifElse(...schemas, lift(...)({...}), <p>A</p>, <p>B</p>)
//   pattern<PatternState>                  → pattern(..., inputSchema, outputSchema)
//   state.label                            → state.key("label")
export default pattern((state) => {
    return {
        [NAME]: state.key("label"),
        [UI]: (<section>
        {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_hbb9e3a8118a5({ state: {
                count: state.key("count")
            } }), <p>Positive</p>, <p>Non-positive</p>)}
      </section>),
    };
}, {
    type: "object",
    properties: {
        count: {
            type: "number",
            "default": 0
        },
        label: {
            type: "string",
            "default": ""
        }
    },
    required: ["count", "label"]
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
    __cfLift_hbb9e3a8118a5,
    __cfLift_1: __cfLift_hbb9e3a8118a5
});
