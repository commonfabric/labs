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
const __cfLift_h2d7ef0946ff7 = __cfHelpers.lift<{
    state: {
        items: number[];
        threshold: number;
    };
}, number>(({ state }) => state.items.filter((x) => x > state.threshold).length, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                },
                threshold: {
                    type: "number"
                }
            },
            required: ["items", "threshold"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h221c3b85ff3f = __cfHelpers.lift<{
    state: {
        items: number[];
        threshold: number;
    };
}, boolean>(({ state }) => state.items.filter((x) => x > state.threshold).length > 0, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                },
                threshold: {
                    type: "number"
                }
            },
            required: ["items", "threshold"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h221c3b85ff3f_2 = __cfHelpers.lift<{
    state: {
        items: number[];
        threshold: number;
    };
}, boolean>(({ state }) => state.items.filter((x) => x > state.threshold).length > 0, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "number"
                    }
                },
                threshold: {
                    type: "number"
                }
            },
            required: ["items", "threshold"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: jsx-filter-length-roots
// Verifies: structural filter-length wrappers use the shared post-closure path
//   instead of rewriting the filter callback itself to filterWithPattern().
//   items.filter(fn).length
//   items.filter(fn).length > 0
//   items.filter(fn).length > 0 ? "Yes" : "No"
// Context: all three shapes should lower without leaking callback locals.
export default pattern((state) => ({
    [UI]: (<div>
      <p>{__cfLift_h2d7ef0946ff7({ state: {
            items: state.key("items"),
            threshold: state.key("threshold")
        } })}</p>
      <p>{__cfLift_h221c3b85ff3f({ state: {
            items: state.key("items"),
            threshold: state.key("threshold")
        } })}</p>
      <p>
        {__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["Yes", "No"]
    } as const satisfies __cfHelpers.JSONSchema, __cfLift_h221c3b85ff3f_2({ state: {
            items: state.key("items"),
            threshold: state.key("threshold")
        } }), "Yes", "No")}
      </p>
    </div>),
}), {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "number"
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
    __cfLift_h2d7ef0946ff7,
    __cfLift_h221c3b85ff3f,
    __cfLift_h221c3b85ff3f_2,
    __cfLift_1: __cfLift_h2d7ef0946ff7,
    __cfLift_2: __cfLift_h221c3b85ff3f,
    __cfLift_3: __cfLift_h221c3b85ff3f_2
});
