function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, fetchText, ifElse, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    pending: boolean;
    result: string;
}, boolean>(({ pending, result }) => pending || !result, {
    type: "object",
    properties: {
        pending: {
            type: "boolean"
        },
        result: {
            type: "string"
        }
    },
    required: ["pending", "result"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    result: string;
}, boolean>(({ result }) => !!result, {
    type: "object",
    properties: {
        result: {
            type: "string"
        }
    },
    required: ["result"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// Tests ifElse where ifTrue is explicitly undefined
// This pattern is common: ifElse(pending, undefined, { result })
// The transformer must handle this correctly - the undefined is a VALUE, not a missing argument
// FIXTURE: ifelse-undefined-value
// Verifies: ifElse with explicit undefined as ifTrue or ifFalse branch is handled correctly
//   ifElse(cond, undefined, {result}) → ifElse(schema, schema, schema, schema, lift(...)(...), undefined, {result})
//   ifElse(cond, {data}, undefined)   → ifElse(schema, schema, schema, schema, lift(...)(...), {data}, undefined)
// Context: undefined is a VALUE argument, not a missing argument
export default pattern(() => {
    const __cf_destructure_1 = fetchText({
        url: "/api/data",
    }), pending = __cf_destructure_1.key("pending").for("pending", true), result = __cf_destructure_1.key("result").for("result", true);
    // Pattern 1: undefined as ifTrue (waiting state returns nothing)
    const output1 = ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "undefined"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {
            result: {
                type: "string"
            }
        },
        required: ["result"]
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "undefined"
            }, {
                type: "object",
                properties: {
                    result: {
                        type: "string"
                    }
                },
                required: ["result"]
            }]
    } as const satisfies __cfHelpers.JSONSchema, __cfLift_1({
        pending: pending,
        result: result
    }).for(["output1", 4], true), undefined, { result }).for("output1", true);
    // Pattern 2: undefined as ifFalse (error state returns nothing)
    const output2 = ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {
            data: {
                type: "string"
            }
        },
        required: ["data"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "undefined"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "undefined"
            }, {
                type: "object",
                properties: {
                    data: {
                        type: "string"
                    }
                },
                required: ["data"]
            }]
    } as const satisfies __cfHelpers.JSONSchema, __cfLift_2({ result: result }).for(["output2", 4], true), { data: result }, undefined).for("output2", true);
    return {
        [UI]: (<div>
        <span>{output1}</span>
        <span>{output2}</span>
      </div>),
    };
}, {
    type: "object",
    properties: {},
    additionalProperties: false
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
    __cfLift_2
});
