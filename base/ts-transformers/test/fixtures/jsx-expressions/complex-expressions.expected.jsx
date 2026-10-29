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
interface Problem {
    price: number;
    discount: number;
    tax: number;
}
const __cfLift_1 = __cfHelpers.lift<{
    price: number;
    discount: number;
}, number>(({ price, discount }) => price - discount, {
    type: "object",
    properties: {
        price: {
            type: "number"
        },
        discount: {
            type: "number"
        }
    },
    required: ["price", "discount"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    price: number;
    discount: number;
    tax: number;
}, number>(({ price, discount, tax }) => (price - discount) * (1 + tax), {
    type: "object",
    properties: {
        price: {
            type: "number"
        },
        discount: {
            type: "number"
        },
        tax: {
            type: "number"
        }
    },
    required: ["price", "discount", "tax"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: complex-expressions
// Verifies: multi-variable arithmetic in JSX is wrapped in a lift-applied computation with captured refs
//   {price - discount}             → lift((...) => price - discount)({ price, discount })
//   {(price - discount) * (1+tax)} → lift((...) => ...)({ price, discount, tax })
export default pattern((__cf_pattern_input) => {
    const price = __cf_pattern_input.key("price");
    const discount = __cf_pattern_input.key("discount");
    const tax = __cf_pattern_input.key("tax");
    return {
        [UI]: (<div>
          <p>Price: {price}</p>
          <p>Discount: {__cfLift_1({
            price: price,
            discount: discount
        })}</p>
          <p>With tax: {__cfLift_2({
            price: price,
            discount: discount,
            tax: tax
        })}</p>
        </div>),
    };
}, {
    type: "object",
    properties: {
        price: {
            type: "number"
        },
        discount: {
            type: "number"
        },
        tax: {
            type: "number"
        }
    },
    required: ["price", "discount", "tax"]
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
    __cfLift_2
});
