function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
// FIXTURE: factory-scheduled-materialization
// Verifies: factories delivered to scheduled lift/handler callbacks are
//   runner-materialized callables and therefore remain direct calls.
// Expected: no invokeFactory lowering inside either scheduled callback.
import { handler, lift, type ModuleFactory, type PatternFactory, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Input {
    value: number;
}
interface Output {
    result: number;
}
export const apply = lift((input: {
    operation: PatternFactory<Input, Output>;
    value: number;
}) => input.operation({ value: input.value }), {
    type: "object",
    properties: {
        operation: {
            asFactory: {
                kind: "pattern",
                argumentSchema: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number"
                        }
                    },
                    required: ["value"]
                },
                resultSchema: {
                    type: "object",
                    properties: {
                        result: {
                            type: "number"
                        }
                    },
                    required: ["result"]
                }
            }
        },
        value: {
            type: "number"
        }
    },
    required: ["operation", "value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        result: {
            type: "number"
        }
    },
    required: ["result"]
} as const satisfies __cfHelpers.JSONSchema);
export const react = handler({
    type: "object",
    properties: {
        operation: {
            asFactory: {
                kind: "pattern",
                argumentSchema: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number"
                        }
                    },
                    required: ["value"]
                },
                resultSchema: {
                    type: "object",
                    properties: {
                        result: {
                            type: "number"
                        }
                    },
                    required: ["result"]
                }
            }
        },
        value: {
            type: "number"
        }
    },
    required: ["operation", "value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        operation: {
            asFactory: {
                kind: "module",
                argumentSchema: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number"
                        }
                    },
                    required: ["value"]
                },
                resultSchema: {
                    type: "object",
                    properties: {
                        result: {
                            type: "number"
                        }
                    },
                    required: ["result"]
                }
            }
        },
        value: {
            type: "number"
        }
    },
    required: ["operation", "value"]
} as const satisfies __cfHelpers.JSONSchema, (event: {
    operation: PatternFactory<Input, Output>;
    value: number;
}, context: {
    operation: ModuleFactory<Input, Output>;
    value: number;
}) => {
    event.operation({ value: event.value });
    context.operation({ value: context.value });
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
