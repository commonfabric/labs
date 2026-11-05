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
type ItemTuple = [
    item: string,
    count: number
];
interface State {
    items: ItemTuple[];
}
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element", "0");
    return (<div data-item={item}>{item}</div>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/ItemTuple"
        }
    },
    required: ["element"],
    $defs: {
        ItemTuple: {
            type: "array",
            items: {
                type: ["number", "string"]
            }
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
const __cfPattern_2 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element", "0");
    const count = __cf_pattern_input.key("element", "1");
    const index = __cf_pattern_input.key("index");
    return (<div key={index}>
            {item}: {count}
          </div>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/ItemTuple"
        },
        index: {
            type: "number"
        }
    },
    required: ["element"],
    $defs: {
        ItemTuple: {
            type: "array",
            items: {
                type: ["number", "string"]
            }
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
// FIXTURE: map-array-destructure-shorthand
// Verifies: array-destructured map params are not incorrectly captured as shorthand properties
//   .map(([item]) => ...) → .mapWithPattern(pattern(...)) with key("element", "0")
//   .map(([item, count], index) → key("element", "0"), key("element", "1"), key("index")
// Context: Shorthand JSX usage like {item} must not cause array-destructured bindings to be captured
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    return {
        [UI]: (<div>
        {/* Array destructured parameter - without fix, 'item' would be
                incorrectly captured in params due to shorthand usage in JSX */}
        {items.mapWithPattern(__cfPattern_1)}

        {/* Multiple array destructured params */}
        {items.mapWithPattern(__cfPattern_2)}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/ItemTuple"
            }
        }
    },
    required: ["items"],
    $defs: {
        ItemTuple: {
            type: "array",
            items: {
                type: ["number", "string"]
            }
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
    __cfPattern_1,
    __cfPattern_2
});
