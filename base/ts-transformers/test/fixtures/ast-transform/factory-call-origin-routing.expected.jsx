function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
// FIXTURE: factory-call-origin-routing
// Verifies: live module-scope factories stay direct while eager pattern input
//   factories lower through invokeFactory with an exact public contract.
// Context: Covers property access, const aliases, typed element access, and a
//   schema-compatible same-kind union for pattern, module, and handler kinds.
import { byRef, handler, lift, pattern, type HandlerFactory, type ModuleFactory, type PatternFactory, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Input {
    value: number;
}
interface Output {
    result: number;
}
interface EquivalentInput {
    value: number;
}
interface EquivalentOutput {
    result: number;
}
type PatternOperation = PatternFactory<Input, Output>;
type ModuleOperation = ModuleFactory<Input, Output>;
type HandlerOperation = HandlerFactory<Output, Input>;
type CompatiblePatternChoice = PatternOperation | PatternFactory<EquivalentInput, EquivalentOutput>;
const __cfLift_1 = __cfHelpers.lift<{
    value: number;
}, number>(({ value }) => value * 2, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const livePattern = pattern((__cf_pattern_input) => {
    const value = __cf_pattern_input.key("value");
    return ({
        result: __cfLift_1({ value: value }),
    });
}, {
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
        result: {
            type: "number"
        }
    },
    required: ["result"]
} as const satisfies __cfHelpers.JSONSchema);
const liveModule = lift((input: Input): Output => ({
    result: input.value + 1,
}), {
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
        result: {
            type: "number"
        }
    },
    required: ["result"]
} as const satisfies __cfHelpers.JSONSchema);
const liveHandler = handler({
    type: "object",
    properties: {
        result: {
            type: "number"
        }
    },
    required: ["result"]
} as const satisfies __cfHelpers.JSONSchema, false as const satisfies __cfHelpers.JSONSchema, (event: Output, _context: Input) => event.result);
const schemaLightRef = byRef<Input, Output>("fixture:schema-light-module");
export default pattern((input) => {
    const patternAlias = input.key("pattern");
    const moduleAlias = input.key("module");
    const handlerAlias = input.key("handler");
    return {
        livePattern: livePattern({ value: input.key("value") }),
        liveModule: liveModule({ value: input.key("value") }).for(["__patternResult", "liveModule"], true),
        liveHandler: liveHandler({ value: input.key("value") }).for({ stream: ["__patternResult", "liveHandler"] }, true),
        patternProperty: __cfHelpers.invokeFactory(input.key("pattern"), { value: input.key("value") }, {
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
            },
            frameworkProvidedPaths: []
        }),
        patternAlias: __cfHelpers.invokeFactory(patternAlias, { value: input.key("value") }, {
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
            },
            frameworkProvidedPaths: []
        }),
        patternElement: __cfHelpers.invokeFactory(input.key("patterns", "primary")!, { value: input.key("value") }, {
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
            },
            frameworkProvidedPaths: []
        }),
        moduleProperty: __cfHelpers.invokeFactory(input.key("module"), { value: input.key("value") }, {
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
            },
            frameworkProvidedPaths: []
        }),
        moduleAlias: __cfHelpers.invokeFactory(moduleAlias, { value: input.key("value") }, {
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
            },
            frameworkProvidedPaths: []
        }),
        moduleElement: __cfHelpers.invokeFactory(input.key("modules", "primary")!, { value: input.key("value") }, {
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
            },
            frameworkProvidedPaths: []
        }),
        handlerProperty: __cfHelpers.invokeFactory(input.key("handler"), { value: input.key("value") }, {
            kind: "handler",
            contextSchema: {
                type: "object",
                properties: {
                    value: {
                        type: "number"
                    }
                },
                required: ["value"]
            },
            eventSchema: {
                type: "object",
                properties: {
                    result: {
                        type: "number"
                    }
                },
                required: ["result"]
            },
            frameworkProvidedPaths: []
        }),
        handlerAlias: __cfHelpers.invokeFactory(handlerAlias, { value: input.key("value") }, {
            kind: "handler",
            contextSchema: {
                type: "object",
                properties: {
                    value: {
                        type: "number"
                    }
                },
                required: ["value"]
            },
            eventSchema: {
                type: "object",
                properties: {
                    result: {
                        type: "number"
                    }
                },
                required: ["result"]
            },
            frameworkProvidedPaths: []
        }),
        handlerElement: __cfHelpers.invokeFactory(input.key("handlers", "primary")!, { value: input.key("value") }, {
            kind: "handler",
            contextSchema: {
                type: "object",
                properties: {
                    value: {
                        type: "number"
                    }
                },
                required: ["value"]
            },
            eventSchema: {
                type: "object",
                properties: {
                    result: {
                        type: "number"
                    }
                },
                required: ["result"]
            },
            frameworkProvidedPaths: []
        }),
        compatibleChoice: __cfHelpers.invokeFactory(input.key("choice"), { value: input.key("value") }, {
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
            },
            frameworkProvidedPaths: []
        }),
        schemaLightReference: __cfHelpers.invokeFactory(input.key("reference"), { value: input.key("value") }, {
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
            },
            frameworkProvidedPaths: []
        })
    };
}, {
    type: "object",
    properties: {
        pattern: {
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
        patterns: {
            type: "object",
            properties: {},
            additionalProperties: {
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
            }
        },
        module: {
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
        modules: {
            type: "object",
            properties: {},
            additionalProperties: {
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
            }
        },
        handler: {
            asFactory: {
                kind: "handler",
                contextSchema: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number"
                        }
                    },
                    required: ["value"]
                },
                eventSchema: {
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
        handlers: {
            type: "object",
            properties: {},
            additionalProperties: {
                asFactory: {
                    kind: "handler",
                    contextSchema: {
                        type: "object",
                        properties: {
                            value: {
                                type: "number"
                            }
                        },
                        required: ["value"]
                    },
                    eventSchema: {
                        type: "object",
                        properties: {
                            result: {
                                type: "number"
                            }
                        },
                        required: ["result"]
                    }
                }
            }
        },
        choice: {
            $ref: "#/$defs/CompatiblePatternChoice"
        },
        reference: {
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
    required: ["pattern", "patterns", "module", "modules", "handler", "handlers", "choice", "reference", "value"],
    $defs: {
        CompatiblePatternChoice: {
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
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        livePattern: {
            $ref: "#/$defs/Output"
        },
        liveModule: {
            $ref: "#/$defs/Output"
        },
        liveHandler: {
            $ref: "#/$defs/Output",
            asCell: ["stream"]
        },
        patternProperty: {
            $ref: "#/$defs/Output"
        },
        patternAlias: {
            $ref: "#/$defs/Output"
        },
        patternElement: {
            $ref: "#/$defs/Output"
        },
        moduleProperty: {
            $ref: "#/$defs/Output"
        },
        moduleAlias: {
            $ref: "#/$defs/Output"
        },
        moduleElement: {
            $ref: "#/$defs/Output"
        },
        handlerProperty: {
            $ref: "#/$defs/Output",
            asCell: ["stream"]
        },
        handlerAlias: {
            $ref: "#/$defs/Output",
            asCell: ["stream"]
        },
        handlerElement: {
            $ref: "#/$defs/Output",
            asCell: ["stream"]
        },
        compatibleChoice: {
            $ref: "#/$defs/Output"
        },
        schemaLightReference: {
            $ref: "#/$defs/Output"
        }
    },
    required: ["livePattern", "liveModule", "liveHandler", "patternProperty", "patternAlias", "patternElement", "moduleProperty", "moduleAlias", "moduleElement", "handlerProperty", "handlerAlias", "handlerElement", "compatibleChoice", "schemaLightReference"],
    $defs: {
        Output: {
            type: "object",
            properties: {
                result: {
                    type: "number"
                }
            },
            required: ["result"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    livePattern,
    __cfLift_1,
    liveModule,
    liveHandler
});
