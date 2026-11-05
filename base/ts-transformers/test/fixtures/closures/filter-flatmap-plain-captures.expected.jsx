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
    item: {
        label: string;
    };
    suffix: string;
}, boolean>(({ item, suffix }) => item.label.endsWith(suffix), {
    type: "object",
    properties: {
        item: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                }
            },
            required: ["label"]
        },
        suffix: {
            type: "string"
        }
    },
    required: ["item", "suffix"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { suffix }) => {
    const item = __cf_pattern_input.key("element");
    return __cfLift_1({
        item: {
            label: item.key("label")
        },
        suffix: suffix
    }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        suffix: {
            type: "string"
        }
    },
    required: ["suffix"]
} as const satisfies __cfHelpers.JSONSchema), {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                tags: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["label", "tags"]
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    item: {
        tags: string[];
    };
    prefix: string;
}, string[]>(({ item, prefix }) => [prefix + item.tags[0]], {
    type: "object",
    properties: {
        prefix: {
            type: "string"
        },
        item: {
            type: "object",
            properties: {
                tags: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["tags"]
        }
    },
    required: ["prefix", "item"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_2 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { prefix }) => {
    const item = __cf_pattern_input.key("element");
    return __cfHelpers.ifElse({
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: false
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema, item.key("tags", "length"), __cfLift_2({
        item: {
            tags: item.key("tags")
        },
        prefix: prefix
    }), []).for("__patternResult", true);
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
        element: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                tags: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["label", "tags"]
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: filter-flatmap-plain-captures
// Verifies: plain lexical captures in reactive filter/flatMap chains become
// params values, not reactive key(...) lookups
//   suffix/prefix literals -> __cf_pattern_input.params.{suffix,prefix}
//   items.filter(fn).flatMap(fn) -> filterWithPattern(...).flatMapWithPattern(...)
// Context: the captures are plain strings, so the lowered callbacks should not
// route them through key() ownership paths.
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    const suffix = "!";
    const prefix = "#";
    return {
        labels: items.filterWithPattern(__cfPattern_1.curry({
            suffix: suffix
        })).flatMapWithPattern(__cfPattern_2.curry({
            prefix: prefix
        })).for(["__patternResult", "labels"], true)
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    label: {
                        type: "string"
                    },
                    tags: {
                        type: "array",
                        items: {
                            type: "string"
                        }
                    }
                },
                required: ["label", "tags"]
            }
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        labels: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["labels"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfPattern_1,
    __cfLift_2,
    __cfPattern_2
});
