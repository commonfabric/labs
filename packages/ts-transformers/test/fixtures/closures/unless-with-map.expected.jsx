function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
/**
 * Test case for unless() with a reactive array map as the fallback.
 *
 * unless(condition, fallback) returns condition if truthy, else fallback.
 * When fallback is items.map(...), the map gets transformed to mapWithPattern.
 * Schema injection needs to know the type of the mapWithPattern result.
 */
import { Cell, Default, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Item {
    label: string;
}
interface PatternInput {
    customContent: Cell<any>;
    items: Cell<Default<Item[], [
    ]>>;
}
const __cfPattern_hc3ba77b76767 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return <li>{item.key("label")}</li>;
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
                label: {
                    type: "string"
                }
            },
            required: ["label"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }, {
            $ref: "#/$defs/UIRenderable"
        }, {
            type: "object",
            properties: {}
        }],
    $defs: {
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
// FIXTURE: unless-with-map
// Verifies: || operator becomes unless() with reactive map as fallback
//   customContent || items.map(...) → unless(customContent, items.mapWithPattern(...))
//   items.map((item) => ...) → items.mapWithPattern(pattern(...))
// Context: unless(condition, fallback) returns condition if truthy, else fallback.
//   The fallback branch contains a reactive .map() that must be transformed to
//   mapWithPattern with proper schema injection.
export default pattern((__cf_pattern_input) => {
    const customContent = __cf_pattern_input.key("customContent");
    const items = __cf_pattern_input.key("items");
    return {
        [UI]: (<div>
        {/* unless(condition, fallback) where fallback is a reactive map */}
        {__cfHelpers.unless({
            asCell: ["cell"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "array",
            items: {}
        } as const satisfies __cfHelpers.JSONSchema, {
            asCell: ["cell"]
        } as const satisfies __cfHelpers.JSONSchema, customContent, items.mapWithPattern(__cfPattern_hc3ba77b76767, {}))}
      </div>),
    };
}, {
    type: "object",
    properties: {
        customContent: {
            asCell: ["cell"]
        },
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            "default": [],
            asCell: ["cell"]
        }
    },
    required: ["customContent", "items"],
    $defs: {
        Item: {
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
    __cfPattern_hc3ba77b76767,
    __cfPattern_1: __cfPattern_hc3ba77b76767
});
