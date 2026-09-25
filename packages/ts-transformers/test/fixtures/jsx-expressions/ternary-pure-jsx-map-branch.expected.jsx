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
interface TagEvent {
    label: string;
}
const __cfLift_hd28349b3dbd1 = __cfHelpers.lift<{
    recentEvents: TagEvent[];
}, boolean>(({ recentEvents }) => recentEvents.length === 0, {
    type: "object",
    properties: {
        recentEvents: {
            type: "array",
            items: {
                type: "unknown"
            }
        }
    },
    required: ["recentEvents"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_h558563f72c28 = __cfHelpers.pattern(__cf_pattern_input => {
    const event = __cf_pattern_input.key("element");
    const idx = __cf_pattern_input.key("index");
    return (<cf-hstack key={idx} gap="2">
                <span>{event.key("label")}</span>
              </cf-hstack>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/TagEvent"
        },
        index: {
            type: "number"
        }
    },
    required: ["element"],
    $defs: {
        TagEvent: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                }
            },
            required: ["label"]
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
// FIXTURE: ternary-pure-jsx-map-branch
// Verifies: a plain reactive array map inside a ternary JSX branch stays
// pattern-lowered without wrapping the whole branch in extra lift-applied noise.
//   recentEvents.length === 0 ? <span>...</span> : <div>{recentEvents.map(...)}</div>
//     → ifElse(lift(...)(length===0), <span>...</span>, <div>{recentEvents.mapWithPattern(...)}</div>)
// Context: implicit JSX ternary branch selection with a pure pattern-owned map
//   in the false branch.
export default pattern((__cf_pattern_input) => {
    const recentEvents = __cf_pattern_input.key("recentEvents");
    return ({
        [UI]: (<div>
      {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_hd28349b3dbd1({ recentEvents: recentEvents }), <span>No events yet</span>, <div>
            {recentEvents.mapWithPattern(__cfPattern_h558563f72c28, {})}
          </div>)}
    </div>),
    });
}, {
    type: "object",
    properties: {
        recentEvents: {
            type: "array",
            items: {
                $ref: "#/$defs/TagEvent"
            }
        }
    },
    required: ["recentEvents"],
    $defs: {
        TagEvent: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                }
            },
            required: ["label"]
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
    __cfLift_hd28349b3dbd1,
    __cfPattern_h558563f72c28,
    __cfLift_1: __cfLift_hd28349b3dbd1,
    __cfPattern_1: __cfPattern_h558563f72c28
});
