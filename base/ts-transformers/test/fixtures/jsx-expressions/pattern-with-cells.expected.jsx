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
const __cfLift_1 = __cfHelpers.lift<{
    cell: {
        value: number;
    };
}, number>(({ cell }) => cell.value + 1, {
    type: "object",
    properties: {
        cell: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
        }
    },
    required: ["cell"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    cell: {
        value: number;
    };
}, number>(({ cell }) => cell.value * 2, {
    type: "object",
    properties: {
        cell: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
        }
    },
    required: ["cell"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: pattern-with-cells
// Verifies: pattern input property access is transformed to .key() and arithmetic to a lift-applied computation
//   cell.value       → cell.key("value")
//   cell.value + 1   → lift(({cell}) => cell.value + 1)({ value: asOpaque })
//   cell.value * 2   → lift(({cell}) => cell.value * 2)({ value: asOpaque })
export default pattern((cell) => {
    return {
        [UI]: (<div>
        <p>Current value: {cell.key("value")}</p>
        <p>Next value: {__cfLift_1({ cell: {
                value: cell.key("value")
            } })}</p>
        <p>Double: {__cfLift_2({ cell: {
                value: cell.key("value")
            } })}</p>
      </div>),
        value: cell.key("value"),
    };
}, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        value: {
            type: "number"
        }
    },
    required: ["$UI", "value"],
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
    __cfLift_2
});
