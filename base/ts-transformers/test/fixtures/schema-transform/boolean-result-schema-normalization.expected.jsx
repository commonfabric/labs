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
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        score: number;
    };
}, boolean>(({ state }) => state.score > 100, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                score: {
                    type: "number"
                }
            },
            required: ["score"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: boolean-result-schema-normalization
// Verifies: boolean result schemas stay normalized as `type: "boolean"` instead
// of expanding into literal `true` / `false` enums.
export default pattern((state: {
    isPremium: boolean;
    score: number;
}) => {
    return {
        [UI]: <div>{__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Premium", "Regular"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.unless({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, state.key("isPremium"), __cfLift_1({ state: {
                score: state.key("score")
            } })), "Premium", "Regular")}</div>,
    };
}, {
    type: "object",
    properties: {
        isPremium: {
            type: "boolean"
        },
        score: {
            type: "number"
        }
    },
    required: ["isPremium", "score"]
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
    __cfLift_1
});
