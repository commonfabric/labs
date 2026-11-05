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
const dynamicKey = "value" as const;
interface Item {
    value: number;
    other: number;
}
interface State {
    items: Item[];
}
const __cfLift_1 = __cfHelpers.lift<{
    element: any;
    __cf_val_key: any;
}, number>(({ element, __cf_val_key }) => element[__cf_val_key], {
    type: "object",
    properties: {
        element: true,
        __cf_val_key: true
    },
    required: ["element", "__cf_val_key"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const element = __cf_pattern_input.key("element");
    const __cf_val_key = dynamicKey;
    const val = __cfLift_1({
        element: element,
        __cf_val_key: __cf_val_key
    }).for("val", true);
    return (<span>{val}</span>);
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
                value: {
                    type: "number"
                },
                other: {
                    type: "number"
                }
            },
            required: ["value", "other"]
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
// FIXTURE: map-destructured-computed-alias
// Verifies: computed property key with a const-asserted identifier is lowered to lift-applied
//   { [dynamicKey]: val } → __cf_val_key = dynamicKey; lift(...)(...element[__cf_val_key])
//   .map(fn) → .mapWithPattern(pattern(...))
// Context: dynamicKey is a const-asserted string, not a function call — still uses the lift-applied pattern
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__cfPattern_1)}
      </div>),
    };
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
                value: {
                    type: "number"
                },
                other: {
                    type: "number"
                }
            },
            required: ["value", "other"]
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
    __cfLift_1,
    __cfPattern_1
});
