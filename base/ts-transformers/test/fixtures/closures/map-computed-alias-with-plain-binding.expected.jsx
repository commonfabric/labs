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
function dynamicKey(): "value" {
    return "value";
}
__cfHardenFn(dynamicKey);
interface Item {
    foo: number;
    value: number;
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
const __cfLift_2 = __cfHelpers.lift<{
    foo: number;
    val: number;
}, number>(({ foo, val }) => foo + val, {
    type: "object",
    properties: {
        foo: {
            type: "number"
        },
        val: {
            type: "number"
        }
    },
    required: ["foo", "val"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const element = __cf_pattern_input.key("element");
    const __cf_val_key = dynamicKey();
    const foo = element.key("foo");
    const val = __cfLift_1({
        element: element,
        __cf_val_key: __cf_val_key
    }).for("val", true);
    return (<span>{__cfLift_2({
        foo: foo,
        val: val
    })}</span>);
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
                foo: {
                    type: "number"
                },
                value: {
                    type: "number"
                }
            },
            required: ["foo", "value"]
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
// FIXTURE: map-computed-alias-with-plain-binding
// Verifies: computed property key mixed with a static destructured binding in the same pattern
//   { foo, [dynamicKey()]: val } → key binding for foo, lift-applied computation for val
//   foo + val expression → lift(...)(...) combining both bindings
// Context: Mixes static destructuring ({foo}) with dynamic computed key ([dynamicKey()]: val)
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
                foo: {
                    type: "number"
                },
                value: {
                    type: "number"
                }
            },
            required: ["foo", "value"]
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
    __cfLift_2,
    __cfPattern_1
});
