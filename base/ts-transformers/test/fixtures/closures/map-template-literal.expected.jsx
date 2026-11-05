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
    prefix: string;
    suffix: string;
}
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        prefix: string;
        suffix: string;
    };
    item: {
        name: string;
    };
}, string>(({ state, item }) => `${state.prefix} ${item.name} ${state.suffix}`, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                prefix: {
                    type: "string"
                },
                suffix: {
                    type: "string"
                }
            },
            required: ["prefix", "suffix"]
        },
        item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    },
    required: ["state", "item"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { state }) => {
    const item = __cf_pattern_input.key("element");
    return (<div>{__cfLift_1({
        state: {
            prefix: state.prefix,
            suffix: state.suffix
        },
        item: {
            name: item.key("name")
        }
    })}</div>);
}, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                prefix: {
                    type: "string"
                },
                suffix: {
                    type: "string"
                }
            },
            required: ["prefix", "suffix"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema), {
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
// FIXTURE: map-template-literal
// Verifies: .map() on reactive array is transformed when callback uses a template literal with captures
//   .map(fn) → .mapWithPattern(pattern(...).curry({state: {prefix, suffix}}))
//   `${state.prefix} ${item.name} ${state.suffix}` → lift-applied computation wrapping the template
// Context: Template literal interpolations reference both element and captured state properties
export default pattern((state) => {
    return {
        [UI]: (<div>
        {/* Template literal with captures */}
        {state.key("items").mapWithPattern(__cfPattern_1.curry({
                state: {
                    prefix: state.key("prefix"),
                    suffix: state.key("suffix")
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
        prefix: {
            type: "string"
        },
        suffix: {
            type: "string"
        }
    },
    required: ["items", "prefix", "suffix"],
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
