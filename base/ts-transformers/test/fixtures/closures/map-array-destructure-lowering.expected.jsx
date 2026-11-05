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
type Row = [
    left: string,
    right: string
];
interface State {
    rows: Row[];
}
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const left = __cf_pattern_input.key("element", "0");
    const right = __cf_pattern_input.key("element", "1");
    return (<span>
            {left}:{right}
          </span>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Row"
        }
    },
    required: ["element"],
    $defs: {
        Row: {
            type: "array",
            items: {
                type: "string"
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
// FIXTURE: map-array-destructure-lowering
// Verifies: array destructuring in .map() callback is lowered to index-based key access
//   .map(([left, right]) => ...) → .mapWithPattern(pattern(...))
//   [left, right] → key("element", "0"), key("element", "1")
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("rows").mapWithPattern(__cfPattern_1)}
      </div>),
    };
}, {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                $ref: "#/$defs/Row"
            }
        }
    },
    required: ["rows"],
    $defs: {
        Row: {
            type: "array",
            items: {
                type: "string"
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
    __cfPattern_1
});
