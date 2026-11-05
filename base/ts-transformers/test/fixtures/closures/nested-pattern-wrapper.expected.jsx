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
    suffix: string;
    value: string;
}, string>(({ prefix, suffix, value }) => `${prefix}:${suffix}:${value}`, {
    type: "object",
    properties: {
        prefix: {
            type: "string"
        },
        suffix: {
            type: "string"
        },
        value: {
            type: "string"
        }
    },
    required: ["prefix", "suffix", "value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { prefix, suffix }) => {
    const value = __cf_pattern_input.key("value");
    return ({
        text: __cfLift_1({
            prefix: prefix,
            suffix: suffix,
            value: value
        }).for(["__patternResult", "text"], true)
    });
}, {
    type: "object",
    properties: {
        prefix: {
            type: "string"
        },
        suffix: {
            type: "string"
        }
    },
    required: ["prefix", "suffix"]
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
const __cfPattern_2 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { prefix }) => {
    const suffix = __cf_pattern_input.key("suffix");
    return ({
        inner: __cfPattern_1.curry({
            prefix: prefix,
            suffix: suffix
        }),
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
        suffix: {
            type: "string"
        }
    },
    required: ["suffix"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        inner: {
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
    required: ["inner"]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: nested-pattern-wrapper
// Verifies: each nested wrapper receives its own base factory and exactly one
// curry rather than rebinding an already-bound inner factory.
export default pattern((__cf_pattern_input) => {
    const prefix = __cf_pattern_input.key("prefix");
    return ({
        outer: __cfPattern_2.curry({ prefix: prefix }),
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
        outer: {
            asFactory: {
                kind: "pattern",
                argumentSchema: {
                    type: "object",
                    properties: {
                        suffix: {
                            type: "string"
                        }
                    },
                    required: ["suffix"]
                },
                resultSchema: {
                    type: "object",
                    properties: {
                        inner: {
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
                    required: ["inner"]
                }
            }
        }
    },
    required: ["outer"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfPattern_1,
    __cfPattern_2
});
