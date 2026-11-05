function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    prefix: string;
    value: string;
}, string>(({ prefix, value }) => `${prefix}:${value}`, {
    type: "object",
    properties: {
        prefix: {
            type: "string"
        },
        value: {
            type: "string"
        }
    },
    required: ["prefix", "value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { prefix }) => {
    const value = __cf_pattern_input.key("value");
    return ({
        text: __cfLift_1({
            prefix: prefix,
            value: value
        }).for(["__patternResult", "text"], true)
    });
}, {
    type: "object",
    properties: {
        prefix: {
            type: "string"
        }
    },
    required: ["prefix"]
} as const satisfies __cfHelpers.JSONSchema), {
    type: "object",
    properties: {
        value: {
            type: "string"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        text: {
            type: "string"
        }
    },
    required: ["text"]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: nested-pattern-capture
// Verifies: a nested pattern closes over an outer public input through the
// compiler-private params root without merging it into the child's input.
export default pattern((__cf_pattern_input) => {
    const prefix = __cf_pattern_input.key("prefix");
    return ({
        child: __cfPattern_1.curry({ prefix: prefix }),
    });
}, {
    type: "object",
    properties: {
        prefix: {
            type: "string"
        }
    },
    required: ["prefix"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        child: {
            asFactory: {
                kind: "pattern",
                argumentSchema: {
                    type: "object",
                    properties: {
                        value: {
                            type: "string"
                        }
                    },
                    required: ["value"]
                },
                resultSchema: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string"
                        }
                    },
                    required: ["text"]
                }
            }
        }
    },
    required: ["child"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfPattern_1
});
