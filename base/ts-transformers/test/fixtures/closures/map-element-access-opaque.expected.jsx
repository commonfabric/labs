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
    sortedTags: string[];
    tagCounts: Record<string, number>;
}
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        tagCounts: Record<string, number>;
    };
    tag: string;
}, number | undefined>(({ state, tag }) => state.tagCounts[tag], {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                tagCounts: {
                    type: "object",
                    properties: {},
                    additionalProperties: {
                        type: "number"
                    }
                }
            },
            required: ["tagCounts"]
        },
        tag: {
            type: "string"
        }
    },
    required: ["state", "tag"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["number", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { state }) => {
    const tag = __cf_pattern_input.key("element");
    return (<span>
            {tag}: {__cfLift_1({
        state: {
            tagCounts: state.tagCounts
        },
        tag: tag
    })}
          </span>);
}, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                tagCounts: {
                    type: "object",
                    properties: {},
                    additionalProperties: {
                        type: "number"
                    }
                }
            },
            required: ["tagCounts"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema), {
    type: "object",
    properties: {
        element: {
            type: "string"
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
// FIXTURE: map-element-access-opaque
// Verifies: .map() on reactive array is transformed when callback uses bracket access on a captured opaque object
//   .map(fn) → .mapWithPattern(pattern(...).curry({state: {tagCounts: ...}}))
//   state.tagCounts[tag] → lift(...)(...) with opaque schema for dynamic key access
// Context: Captures state.tagCounts for bracket-notation element access inside map
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("sortedTags").mapWithPattern(__cfPattern_1.curry({
                state: {
                    tagCounts: state.key("tagCounts")
                }
            }))}
      </div>),
    };
}, {
    type: "object",
    properties: {
        sortedTags: {
            type: "array",
            items: {
                type: "string"
            }
        },
        tagCounts: {
            type: "object",
            properties: {},
            additionalProperties: {
                type: "number"
            }
        }
    },
    required: ["sortedTags", "tagCounts"]
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
