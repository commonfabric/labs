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
interface TodoItem {
    title: string;
    done: boolean;
}
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return item.key("title");
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/TodoItem"
        }
    },
    required: ["element"],
    $defs: {
        TodoItem: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                done: {
                    type: "boolean"
                }
            },
            required: ["title", "done"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_2 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    const index = __cf_pattern_input.key("index");
    return ({
        title: item.key("title"),
        done: item.key("done"),
        position: index,
    });
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/TodoItem"
        },
        index: {
            type: "number"
        }
    },
    required: ["element"],
    $defs: {
        TodoItem: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                done: {
                    type: "boolean"
                }
            },
            required: ["title", "done"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        title: {
            type: "string"
        },
        done: {
            type: "boolean"
        },
        position: {
            type: "number"
        }
    },
    required: ["title", "done", "position"]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: reactive-map
// Verifies: .map() on typed arrays is transformed to .mapWithPattern() with generated schemas
//   items.map((item) => item.title) → items.mapWithPattern(pattern(...))
//   items.map((item, index) => ({...})) → items.mapWithPattern(pattern(...)) with index param
// Context: two .map() calls -- one returning a scalar, one returning an object with index
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    // Map on opaque ref arrays should be transformed to mapWithPattern
    const mapped = items.mapWithPattern(__cfPattern_1).for("mapped", true);
    // This should also be transformed
    const filtered = items.mapWithPattern(__cfPattern_2).for("filtered", true);
    return { mapped, filtered };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/TodoItem"
            }
        }
    },
    required: ["items"],
    $defs: {
        TodoItem: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                done: {
                    type: "boolean"
                }
            },
            required: ["title", "done"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        mapped: {
            type: "array",
            items: {
                type: "string"
            }
        },
        filtered: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    title: {
                        type: "string"
                    },
                    done: {
                        type: "boolean"
                    },
                    position: {
                        type: "number"
                    }
                },
                required: ["title", "done", "position"]
            }
        }
    },
    required: ["mapped", "filtered"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfPattern_1,
    __cfPattern_2
});
