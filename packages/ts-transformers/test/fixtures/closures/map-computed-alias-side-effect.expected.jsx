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
let keyCounter = 0;
function nextKey() {
    return `value-${keyCounter++}`;
}
__cfHardenFn(nextKey);
interface State {
    items: Array<Record<string, number>>;
}
const __cfLift_h8cb8146c03b7 = __cfHelpers.lift<{
    element: any;
    __cf_amount_key: any;
}, number | undefined>(({ element, __cf_amount_key }) => element[__cf_amount_key], {
    type: "object",
    properties: {
        element: true,
        __cf_amount_key: true
    },
    required: ["element", "__cf_amount_key"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["number", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_he5b726ec597e = __cfHelpers.pattern(__cf_pattern_input => {
    const element = __cf_pattern_input.key("element");
    const __cf_amount_key = nextKey();
    const amount = __cfLift_h8cb8146c03b7({
        element: element,
        __cf_amount_key: __cf_amount_key
    }).for("amount", true);
    return (<span>{amount}</span>);
}, {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {},
            additionalProperties: {
                type: "number"
            }
        }
    },
    required: ["element"]
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
// FIXTURE: map-computed-alias-side-effect
// Verifies: computed property key with side effects is hoisted and used via a lift-applied computation
//   { [nextKey()]: amount } → __cf_amount_key = nextKey(); lift(...)(...element[__cf_amount_key])
//   .map(fn) → .mapWithPattern(pattern(...), {})
// Context: nextKey() has side effects (keyCounter++), so the key expression is evaluated once and cached
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__cfPattern_he5b726ec597e, {})}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {},
                additionalProperties: {
                    type: "number"
                }
            }
        }
    },
    required: ["items"]
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
    __cfLift_h8cb8146c03b7,
    __cfPattern_he5b726ec597e,
    __cfLift_1: __cfLift_h8cb8146c03b7,
    __cfPattern_1: __cfPattern_he5b726ec597e
});
