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
    items: number[];
    threshold: number;
    factor: number;
}
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        items: number[];
        threshold: number;
    };
}, string>(({ state }) => state.items.filter((x) => x > state.threshold).join(", "), {
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
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    state: {
        items: number[];
        threshold: number;
        factor: number;
    };
}, string>(({ state }) => state.items.filter((x) => x > state.threshold).map((x) => x * state.factor).join(", "), {
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
                factor: {
                    type: "number"
                },
                threshold: {
                    type: "number"
                }
            },
            required: ["items", "factor", "threshold"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    state: {
        items: number[];
        threshold: number;
    };
}, string>(({ state }) => state.items.filter((x) => x > state.threshold).join(", ").toUpperCase(), {
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
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_4 = __cfHelpers.lift<{
    state: {
        items: number[];
        threshold: number;
    };
}, string>(({ state }) => state.items.filter((x) => x > state.threshold).join(", ").toUpperCase()
    .trim(), {
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
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: jsx-array-method-sink-calls
// Verifies: direct JSX sink receiver-methods over structural array-method chains can use the shared post-closure path
//   state.items.filter(fn).join(", ")                        → shared post-closure lift-applied computation over the sink call
//   state.items.filter(fn).map(fn).join(", ")                → shared post-closure lift-applied computation over the sink call
//   state.items.filter(fn).join(", ").toUpperCase()          → shared post-closure lift-applied computation over the chained call
//   state.items.filter(fn).join(", ").toUpperCase().trim()   → shared post-closure lift-applied computation over the recursive chained call
// Context: Verifies recursive receiver-method chaining above a shareable array-method sink base
export default pattern((state) => {
    return {
        [UI]: (<div>
        <p>
          Filter joined:{" "}
          {__cfLift_1({ state: {
                items: state.key("items"),
                threshold: state.key("threshold")
            } })}
        </p>
        <p>
          Filter map joined:{" "}
          {__cfLift_2({ state: {
                items: state.key("items"),
                threshold: state.key("threshold"),
                factor: state.key("factor")
            } })}
        </p>
        <p>
          Filter joined upper:{" "}
          {__cfLift_3({ state: {
                items: state.key("items"),
                threshold: state.key("threshold")
            } })}
        </p>
        <p>
          Filter joined upper trimmed:{" "}
          {__cfLift_4({ state: {
                items: state.key("items"),
                threshold: state.key("threshold")
            } })}
        </p>
      </div>),
    };
}, {
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
        },
        factor: {
            type: "number"
        }
    },
    required: ["items", "threshold", "factor"]
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
    __cfLift_2,
    __cfLift_3,
    __cfLift_4
});
