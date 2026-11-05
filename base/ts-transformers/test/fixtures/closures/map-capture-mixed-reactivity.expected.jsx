function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    items: Array<{
        value: number;
    }>;
    threshold: number;
}
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { label, derived, limit }) => {
    const item = __cf_pattern_input.key("element");
    return (<span>{label}: {item.key("value")} / {derived} / {limit}</span>);
}, {
    type: "object",
    properties: {
        label: {
            type: "string"
        },
        derived: {
            type: "number"
        },
        limit: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["label", "derived", "limit"]
} as const satisfies __cfHelpers.JSONSchema), {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
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
// FIXTURE: map-capture-mixed-reactivity
// Verifies: captures of different reactivity kinds are annotated distinctly in the schema
//   label (plain string) → params.label (type: "string", accessed via .params)
//   limit (cell, READ-only in this callback) → params.limit (asCell: ["readonly"])
//     — read-only usage yields the precise `readonly` capability, not the broader
//       `cell`. (The capture is created with cell(100) but never written here.)
//   derived (state.threshold) → params.derived (asOpaque: true)
// Context: Three capture kinds — plain value, cell, and state-derived — in one map callback
export default pattern((state) => {
    const label = "Result";
    const limit = cell(100, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("limit", true);
    const derived = state.key("threshold");
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__cfPattern_1.curry({
                label: label,
                derived: derived,
                limit: limit
            }))}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    value: {
                        type: "number"
                    }
                },
                required: ["value"]
            }
        },
        threshold: {
            type: "number"
        }
    },
    required: ["items", "threshold"]
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
