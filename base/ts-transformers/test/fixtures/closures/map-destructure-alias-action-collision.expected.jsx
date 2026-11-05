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
interface Spot {
    spotNumber: string;
}
interface State {
    spots: Spot[];
}
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const spot = __cf_pattern_input.key("element");
    const sn = spot.key("spotNumber");
    return <li>{sn}</li>;
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Spot"
        }
    },
    required: ["element"],
    $defs: {
        Spot: {
            type: "object",
            properties: {
                spotNumber: {
                    type: "string"
                }
            },
            required: ["spotNumber"]
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
// FIXTURE: map-destructure-alias-action-collision
// Verifies: destructured alias inside map callback body is lowered to explicit key() access
//   const { spotNumber: sn } = spot → const sn = spot.key("spotNumber")
//   .map(fn) → .mapWithPattern(pattern(...))
// Context: Body destructuring from opaque map elements becomes explicit key() bindings
export default pattern((state) => {
    return {
        [UI]: (<ul>
        {state.key("spots").mapWithPattern(__cfPattern_1)}
      </ul>),
    };
}, {
    type: "object",
    properties: {
        spots: {
            type: "array",
            items: {
                $ref: "#/$defs/Spot"
            }
        }
    },
    required: ["spots"],
    $defs: {
        Spot: {
            type: "object",
            properties: {
                spotNumber: {
                    type: "string"
                }
            },
            required: ["spotNumber"]
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
    __cfPattern_1
});
