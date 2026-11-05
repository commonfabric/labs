function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, type Cell, type HandlerFactory, type ModuleFactory, type PatternFactory, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface OperationInput {
    value: number;
}
interface OperationOutput {
    result: number;
}
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { cell, config, patternOperation, moduleOperation, handlerOperation, __cf_pattern_input: __cf_pattern_input_1 }) => {
    const value = __cf_pattern_input.key("value");
    return ({
        value,
        cell: cell.for(["__patternResult", "cell"], true),
        label: config.label,
        patternOperation,
        moduleOperation,
        handlerOperation,
        reserved: __cf_pattern_input_1
    });
}, {
    type: "object",
    properties: {
        cell: {
            type: "string",
            asCell: ["cell"]
        },
        config: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                }
            },
            required: ["label"]
        },
        patternOperation: {
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
        moduleOperation: {
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
        handlerOperation: {
            asFactory: {
                kind: "handler",
                contextSchema: {
                    type: "object",
                    properties: {
                        result: {
                            type: "number"
                        }
                    },
                    required: ["result"]
                },
                eventSchema: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number"
                        }
                    },
                    required: ["value"]
                }
            }
        },
        __cf_pattern_input: {
            type: "string"
        }
    },
    required: ["cell", "config", "patternOperation", "moduleOperation", "handlerOperation", "__cf_pattern_input"]
} as const satisfies __cfHelpers.JSONSchema), {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number"
        },
        cell: {
            type: "string",
            asCell: ["cell"]
        },
        label: {
            type: "string"
        },
        patternOperation: {
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
        moduleOperation: {
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
        handlerOperation: {
            asFactory: {
                kind: "handler",
                contextSchema: {
                    type: "object",
                    properties: {
                        result: {
                            type: "number"
                        }
                    },
                    required: ["result"]
                },
                eventSchema: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number"
                        }
                    },
                    required: ["value"]
                }
            }
        },
        reserved: {
            type: "string"
        }
    },
    required: ["value", "cell", "label", "patternOperation", "moduleOperation", "handlerOperation", "reserved"]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: nested-pattern-capture-matrix
// Verifies: property paths, Cells, every factory kind, deterministic capture
// order, and a compiler-reserved capture-name collision all remain symbolic.
export default pattern((__cf_pattern_input_1) => {
    const cell = __cf_pattern_input_1.key("cell");
    const config = __cf_pattern_input_1.key("config");
    const patternOperation = __cf_pattern_input_1.key("patternOperation");
    const moduleOperation = __cf_pattern_input_1.key("moduleOperation");
    const handlerOperation = __cf_pattern_input_1.key("handlerOperation");
    const __cf_pattern_input = __cf_pattern_input_1.key("__cf_pattern_input");
    return ({
        child: __cfPattern_1.curry({
            cell: cell.for(["__patternResult", "child", "cell"], true),
            config: {
                label: config.key("label")
            },
            patternOperation: patternOperation,
            moduleOperation: moduleOperation,
            handlerOperation: handlerOperation,
            __cf_pattern_input: __cf_pattern_input
        })
    });
}, {
    type: "object",
    properties: {
        cell: {
            type: "string",
            asCell: ["cell"]
        },
        config: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                }
            },
            required: ["label"]
        },
        patternOperation: {
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
        moduleOperation: {
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
        handlerOperation: {
            asFactory: {
                kind: "handler",
                contextSchema: {
                    type: "object",
                    properties: {
                        result: {
                            type: "number"
                        }
                    },
                    required: ["result"]
                },
                eventSchema: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number"
                        }
                    },
                    required: ["value"]
                }
            }
        },
        __cf_pattern_input: {
            type: "string"
        }
    },
    required: ["cell", "config", "patternOperation", "moduleOperation", "handlerOperation", "__cf_pattern_input"]
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
                            type: "number"
                        }
                    },
                    required: ["value"]
                },
                resultSchema: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number"
                        },
                        cell: {
                            type: "string",
                            asCell: ["cell"]
                        },
                        label: {
                            type: "string"
                        },
                        patternOperation: {
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
                        moduleOperation: {
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
                        handlerOperation: {
                            asFactory: {
                                kind: "handler",
                                contextSchema: {
                                    type: "object",
                                    properties: {
                                        result: {
                                            type: "number"
                                        }
                                    },
                                    required: ["result"]
                                },
                                eventSchema: {
                                    type: "object",
                                    properties: {
                                        value: {
                                            type: "number"
                                        }
                                    },
                                    required: ["value"]
                                }
                            }
                        },
                        reserved: {
                            type: "string"
                        }
                    },
                    required: ["value", "cell", "label", "patternOperation", "moduleOperation", "handlerOperation", "reserved"]
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
    __cfPattern_1
});
