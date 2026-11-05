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
    items: string[];
    index: number;
    matrix: number[][];
    row: number;
    col: number;
}
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        items: string[];
        index: number;
    };
}, string | undefined>(({ state }) => state.items[state.index], {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                index: {
                    type: "number"
                }
            },
            required: ["items", "index"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    state: {
        items: string[];
    };
}, string | undefined>(({ state }) => state.items[state.items.length - 1], {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["items"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    state: {
        matrix: number[][];
        row: number;
        col: number;
    };
}, number | undefined>(({ state }) => state.matrix[state.row]![state.col], {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                matrix: {
                    type: "array",
                    items: {
                        type: "array",
                        items: {
                            type: "number"
                        }
                    }
                },
                row: {
                    type: "number"
                },
                col: {
                    type: "number"
                }
            },
            required: ["matrix", "row", "col"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["number", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: element-access-simple
// Verifies: dynamic element access on reactive arrays is wrapped in a lift-applied computation
//   state.items[state.index]            → lift(({state}) => state.items[state.index])({ items, index })
//   state.items[state.items.length - 1] → lift(...)({ items })
//   state.matrix[state.row]![state.col] → lift(...)({ matrix, row, col })
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Dynamic Element Access</h3>
        {/* Basic dynamic index */}
        <p>Item: {__cfLift_1({ state: {
                items: state.key("items"),
                index: state.key("index")
            } })}</p>

        {/* Computed index */}
        <p>Last: {__cfLift_2({ state: {
                items: state.key("items")
            } })}</p>

        {/* Double indexing */}
        <p>Matrix: {__cfLift_3({ state: {
                matrix: state.key("matrix"),
                row: state.key("row"),
                col: state.key("col")
            } })}</p>
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string"
            }
        },
        index: {
            type: "number"
        },
        matrix: {
            type: "array",
            items: {
                type: "array",
                items: {
                    type: "number"
                }
            }
        },
        row: {
            type: "number"
        },
        col: {
            type: "number"
        }
    },
    required: ["items", "index", "matrix", "row", "col"]
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
    __cfLift_3
});
