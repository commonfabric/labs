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
interface Item {
    subItems: Array<{
        value: string;
    }>;
}
interface Input {
    items: Item[];
}
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const subItem = __cf_pattern_input.key("element");
    return subItem.key("value");
}, {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                value: {
                    type: "string"
                }
            },
            required: ["value"]
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_2 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return item.key("subItems").mapWithPattern(__cfPattern_1).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Item"
        }
    },
    required: ["element"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                subItems: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            value: {
                                type: "string"
                            }
                        },
                        required: ["value"]
                    }
                }
            },
            required: ["subItems"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: map-receiver-key-lowering
// Verifies: nested .map() calls are both transformed, with receiver lowered to .key()
//   items.map(fn) → items.mapWithPattern(pattern(...))
//   item.subItems.map(fn) → item.key("subItems").mapWithPattern(pattern(...))
// Context: No captures; receiver expression item.subItems is lowered to item.key("subItems")
const _p = pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    return items.mapWithPattern(__cfPattern_2);
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                subItems: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            value: {
                                type: "string"
                            }
                        },
                        required: ["value"]
                    }
                }
            },
            required: ["subItems"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "array",
        items: {
            type: "string"
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    _p,
    __cfPattern_1,
    __cfPattern_2
});
