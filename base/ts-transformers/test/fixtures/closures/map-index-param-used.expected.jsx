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
interface Item {
    id: number;
    name: string;
}
interface State {
    items: Item[];
    offset: number;
}
const __cfLift_1 = __cfHelpers.lift<{
    index: number;
    state: {
        offset: number;
    };
}, number>(({ index, state }) => index + state.offset, {
    type: "object",
    properties: {
        index: {
            type: "number"
        },
        state: {
            type: "object",
            properties: {
                offset: {
                    type: "number"
                }
            },
            required: ["offset"]
        }
    },
    required: ["index", "state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { state }) => {
    const item = __cf_pattern_input.key("element");
    const index = __cf_pattern_input.key("index");
    return (<div>
            Item #{__cfLift_1({
        index: index,
        state: {
            offset: state.offset
        }
    })}: {item.key("name")}
          </div>);
}, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                offset: {
                    type: "number"
                }
            },
            required: ["offset"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema), {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        },
        index: {
            type: "number"
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
// FIXTURE: map-index-param-used
// Verifies: .map() on reactive array is transformed when index param is used with a capture
//   .map(fn) → .mapWithPattern(pattern(...).curry({state: {offset: ...}}))
//   index + state.offset → lift(...)(...) combining index and captured state
// Context: Both index parameter and state.offset are used in an expression
export default pattern((state) => {
    return {
        [UI]: (<div>
        {/* Uses both index parameter and captures state.offset */}
        {state.key("items").mapWithPattern(__cfPattern_1.curry({
                state: {
                    offset: state.key("offset")
                }
            }))}
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
        },
        offset: {
            type: "number"
        }
    },
    required: ["items", "offset"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
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
