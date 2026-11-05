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
interface Point {
    x: number;
    y: number;
}
interface State {
    points: Point[];
    scale: number;
}
const __cfLift_1 = __cfHelpers.lift<{
    x: number;
    state: {
        scale: number;
    };
}, number>(({ x, state }) => x * state.scale, {
    type: "object",
    properties: {
        x: {
            type: "number"
        },
        state: {
            type: "object",
            properties: {
                scale: {
                    type: "number"
                }
            },
            required: ["scale"]
        }
    },
    required: ["x", "state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    y: number;
    state: {
        scale: number;
    };
}, number>(({ y, state }) => y * state.scale, {
    type: "object",
    properties: {
        y: {
            type: "number"
        },
        state: {
            type: "object",
            properties: {
                scale: {
                    type: "number"
                }
            },
            required: ["scale"]
        }
    },
    required: ["y", "state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cfHelpers.withPatternParamsSchema((__cf_pattern_input, { state }) => {
    const x = __cf_pattern_input.key("element", "x");
    const y = __cf_pattern_input.key("element", "y");
    return (<div>
            Point: ({__cfLift_1({
        x: x,
        state: {
            scale: state.scale
        }
    })}, {__cfLift_2({
        y: y,
        state: {
            scale: state.scale
        }
    })})
          </div>);
}, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                scale: {
                    type: "number"
                }
            },
            required: ["scale"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema), {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                x: {
                    type: "number"
                },
                y: {
                    type: "number"
                }
            },
            required: ["x", "y"]
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
// FIXTURE: map-destructured-param
// Verifies: object destructuring in .map() param is lowered to key() calls on each property
//   .map(({ x, y }) => ...) → key("element", "x"), key("element", "y")
//   x * state.scale, y * state.scale → lift(...)(...) calls with captured state
// Context: Captures state.scale from outer scope; destructured element properties used in expressions
export default pattern((state) => {
    return {
        [UI]: (<div>
        {/* Map with destructured parameter and capture */}
        {state.key("points").mapWithPattern(__cfPattern_1.curry({
                state: {
                    scale: state.key("scale")
                }
            }))}
      </div>),
    };
}, {
    type: "object",
    properties: {
        points: {
            type: "array",
            items: {
                $ref: "#/$defs/Point"
            }
        },
        scale: {
            type: "number"
        }
    },
    required: ["points", "scale"],
    $defs: {
        Point: {
            type: "object",
            properties: {
                x: {
                    type: "number"
                },
                y: {
                    type: "number"
                }
            },
            required: ["x", "y"]
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
    __cfLift_2,
    __cfPattern_1
});
