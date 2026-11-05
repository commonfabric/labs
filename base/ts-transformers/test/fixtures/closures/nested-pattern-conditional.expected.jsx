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
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input: never, { label }) => ({ label }), {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __cfHelpers.JSONSchema), false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_1 = __cfHelpers.lift<{
    label: string;
}, __cfHelpers.PatternFactory<unknown, { label: string; }>>(({ label }) => __cfPattern_1.curry({ label: label }), {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __cfHelpers.JSONSchema, {
    asFactory: {
        kind: "pattern",
        argumentSchema: {
            type: "unknown"
        },
        resultSchema: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                }
            },
            required: ["label"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_2 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input: never, { label }) => ({ fallback: label }), {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __cfHelpers.JSONSchema), false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        fallback: {
            type: "string"
        }
    },
    required: ["fallback"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    label: string;
}, __cfHelpers.PatternFactory<unknown, { fallback: string; }>>(({ label }) => __cfPattern_2.curry({ label: label }), {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __cfHelpers.JSONSchema, {
    asFactory: {
        kind: "pattern",
        argumentSchema: {
            type: "unknown"
        },
        resultSchema: {
            type: "object",
            properties: {
                fallback: {
                    type: "string"
                }
            },
            required: ["fallback"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: nested-pattern-conditional
// Verifies: nested factories in JSX conditional branches carry only authored
// captures through each branch-local bound factory.
export default pattern((__cf_pattern_input) => {
    const enabled = __cf_pattern_input.key("enabled");
    const label = __cf_pattern_input.key("label");
    return ({
        [UI]: (<div>
        {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            asFactory: {
                kind: "pattern",
                argumentSchema: {
                    type: "unknown"
                },
                resultSchema: {
                    type: "object",
                    properties: {
                        label: {
                            type: "string"
                        }
                    },
                    required: ["label"]
                }
            }
        } as const satisfies __cfHelpers.JSONSchema, {
            asFactory: {
                kind: "pattern",
                argumentSchema: {
                    type: "unknown"
                },
                resultSchema: {
                    type: "object",
                    properties: {
                        fallback: {
                            type: "string"
                        }
                    },
                    required: ["fallback"]
                }
            }
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{
                    asFactory: {
                        kind: "pattern",
                        argumentSchema: {
                            type: "unknown"
                        },
                        resultSchema: {
                            type: "object",
                            properties: {
                                label: {
                                    type: "string"
                                }
                            },
                            required: ["label"]
                        }
                    }
                }, {
                    asFactory: {
                        kind: "pattern",
                        argumentSchema: {
                            type: "unknown"
                        },
                        resultSchema: {
                            type: "object",
                            properties: {
                                fallback: {
                                    type: "string"
                                }
                            },
                            required: ["fallback"]
                        }
                    }
                }]
        } as const satisfies __cfHelpers.JSONSchema, enabled, __cfLift_1({ label: label }), __cfLift_2({ label: label }))}
      </div>),
    });
}, {
    type: "object",
    properties: {
        enabled: {
            type: "boolean"
        },
        label: {
            type: "string"
        }
    },
    required: ["enabled", "label"]
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
    __cfPattern_1,
    __cfLift_1,
    __cfPattern_2,
    __cfLift_2
});
