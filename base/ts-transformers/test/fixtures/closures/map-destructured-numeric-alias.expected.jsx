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
interface State {
    entries: Array<{
        0: number;
    }>;
}
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const first = __cf_pattern_input.key("element", "0");
    return (<span>{first}</span>);
}, {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                "0": {
                    type: "number"
                }
            },
            required: ["0"]
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
// FIXTURE: map-destructured-numeric-alias
// Verifies: numeric property key destructuring in .map() param is lowered to key() with string index
//   .map(({ 0: first }) => ...) → key("element", "0") assigned to first
//   .map(fn) → .mapWithPattern(pattern(...))
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("entries").mapWithPattern(__cfPattern_1)}
      </div>),
    };
}, {
    type: "object",
    properties: {
        entries: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    "0": {
                        type: "number"
                    }
                },
                required: ["0"]
            }
        }
    },
    required: ["entries"]
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
